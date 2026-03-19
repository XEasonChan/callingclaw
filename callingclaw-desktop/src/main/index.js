// ═══════════════════════════════════════════════════════════════
// CallingClaw Desktop — Electron Main Process
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { DaemonSupervisor } = require('./daemon-supervisor');
const { PermissionChecker } = require('./permission-checker');

// ── Constants ──────────────────────────────────────────────────

const DAEMON_URL = 'http://localhost:4000';
const IS_DEV = process.argv.includes('--dev');

// ── Read unified VERSION file ────────────────────────────────
const VERSION_PATH = path.resolve(__dirname, '..', '..', '..', 'VERSION');
try {
  const version = fs.readFileSync(VERSION_PATH, 'utf-8').trim();
  app.setVersion(version);
} catch {
  // Fallback to package.json version
}

// ── Bundled Skill Markdown ──────────────────────────────────────
const BUNDLED_SKILL_MARKDOWN = `# /callingclaw — AI Meeting Room

CallingClaw is your AI meeting room running on localhost:4000. Use these commands to control meetings, voice AI, and automation.

## Quick Start
\\\`\\\`\\\`
/callingclaw status              # Check if CallingClaw is running
/callingclaw join <meeting-url>  # Join a Google Meet / Zoom meeting
/callingclaw leave               # Leave meeting + generate summary & todos
/callingclaw say <text>          # Speak in the meeting via AI voice
\\\`\\\`\\\`

## All Commands

### Meeting Control
- \\\`/callingclaw join <url> [instructions]\\\` — Join meeting with optional custom instructions
- \\\`/callingclaw leave\\\` — Leave meeting, generate summary, create todos, send to Telegram
- \\\`/callingclaw say <text>\\\` — Send text as AI voice in the meeting

### Voice AI
- \\\`/callingclaw voice start [instructions]\\\` — Start voice session
- \\\`/callingclaw voice stop\\\` — Stop voice session

### Screen & Automation
- \\\`/callingclaw screen <instruction>\\\` — Execute a computer use task (4-layer automation)
- \\\`/callingclaw screenshot\\\` — Take a screenshot of the current screen

### Calendar
- \\\`/callingclaw calendar\\\` — List upcoming events from Google Calendar

### Tasks
- \\\`/callingclaw tasks\\\` — List pending tasks from meetings
- \\\`/callingclaw confirm <task-id>\\\` — Confirm a task for execution

### Context
- \\\`/callingclaw context <note>\\\` — Add a note to shared context
- \\\`/callingclaw pin <filepath> [summary]\\\` — Pin a file to shared context
- \\\`/callingclaw notes\\\` — List saved meeting notes
- \\\`/callingclaw transcript [count]\\\` — Get live transcript

### Health & Recovery
- \\\`/callingclaw health\\\` — Health check all subsystems
- \\\`/callingclaw recover browser|sidecar|voice|all\\\` — Reset subsystems

## Architecture
CallingClaw uses a dual-process AI architecture:
- **System 1 (Fast):** OpenAI Realtime voice — 300ms response, handles live conversation
- **System 2 (Deep):** You (Claude Code / OpenClaw) — deep reasoning, memory, file access

When you join a meeting via \\\`/callingclaw join\\\`, CallingClaw:
1. Opens the meeting URL in Chrome
2. Bridges audio via BlackHole virtual devices
3. Starts real-time voice conversation
4. Captures screenshots for visual context
5. Extracts action items during the meeting
6. On leave: generates summary, creates todos, sends to Telegram for confirmation

## API Reference
All endpoints are on \\\`http://localhost:4000\\\`:
- \\\`GET  /api/status\\\` — Engine health
- \\\`POST /api/meeting/join\\\` — \\\`{url, instructions?}\\\`
- \\\`POST /api/meeting/leave\\\`
- \\\`POST /api/voice/start\\\` — \\\`{instructions?, audio_mode?}\\\`
- \\\`POST /api/voice/stop\\\`
- \\\`POST /api/voice/text\\\` — \\\`{text}\\\`
- \\\`POST /api/computer/run\\\` — \\\`{instruction}\\\`
- \\\`GET  /api/calendar/events\\\`
- \\\`GET  /api/tasks\\\`
- \\\`PATCH /api/tasks/:id\\\` — \\\`{status}\\\`
- \\\`GET  /api/meeting/notes\\\`
- \\\`GET  /api/meeting/transcript?count=N\\\`
- \\\`GET  /api/recovery/health\\\`
- \\\`WS   /ws/events\\\` — Real-time EventBus stream
`;

// ── App State ──────────────────────────────────────────────────

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let daemon = null;
let permissionChecker = null;
let shutdownInProgress = false;

// ── Main Window ────────────────────────────────────────────────

function createMainWindow() {
  const appIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    icon: appIcon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#F5F5F7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Allow file:// → http://localhost:4000 API calls
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // macOS: clicking dock icon re-opens window
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Meeting Overlay Window ─────────────────────────────────────

function createOverlayWindow() {
  if (overlayWindow) return overlayWindow;

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();

  overlayWindow = new BrowserWindow({
    width: 340,
    height: 480,
    x: display.workArea.width - 360,
    y: 80,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

// ── Tray Icon ──────────────────────────────────────────────────

function createTray() {
  // Use a template image for macOS menu bar (16x16)
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    trayIcon.setTemplateImage(true);
  } catch {
    // Fallback: create a simple colored icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('CallingClaw');

  updateTrayMenu('idle');

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function updateTrayMenu(status) {
  const statusLabels = {
    idle: '● Idle',
    running: '● Engine Running',
    meeting: '● In Meeting',
    error: '● Error',
  };

  const menu = Menu.buildFromTemplate([
    { label: `CallingClaw — ${statusLabels[status] || status}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) mainWindow.show();
        else createMainWindow();
      },
    },
    {
      label: 'Meeting Overlay',
      click: () => createOverlayWindow(),
    },
    { type: 'separator' },
    {
      label: daemon?.isRunning() ? 'Stop Engine' : 'Start Engine',
      click: async () => {
        if (daemon?.isRunning()) {
          await daemon.stop();
          updateTrayMenu('idle');
        } else {
          await daemon.start();
          updateTrayMenu('running');
        }
        // Notify renderer
        mainWindow?.webContents.send('daemon-status', daemon?.isRunning());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit CallingClaw',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ── IPC Handlers ───────────────────────────────────────────────

function setupIPC() {
  // Daemon control
  ipcMain.handle('daemon:start', async () => {
    await daemon.start();
    updateTrayMenu('running');
    return true;
  });

  ipcMain.handle('daemon:stop', async () => {
    await daemon.stop();
    updateTrayMenu('idle');
    return true;
  });

  ipcMain.handle('daemon:status', () => ({
    running: daemon?.isRunning() ?? false,
    pid: daemon?.pid ?? null,
    url: DAEMON_URL,
  }));

  ipcMain.handle('daemon:restart', async () => {
    await daemon.stop();
    await daemon.start();
    updateTrayMenu('running');
    return true;
  });

  // Permission checks (required: screen recording + accessibility)
  ipcMain.handle('permissions:check', async () => {
    return await permissionChecker.checkAll();
  });

  // Optional permission checks (microphone — only for direct mode)
  ipcMain.handle('permissions:checkOptional', async () => {
    return await permissionChecker.checkOptional();
  });

  ipcMain.handle('permissions:request', async (_, permission) => {
    return await permissionChecker.request(permission);
  });

  ipcMain.handle('permissions:openSettings', (_, panel) => {
    permissionChecker.openSystemSettings(panel);
  });

  // Environment checks
  ipcMain.handle('env:check', async () => {
    return await checkEnvironment();
  });

  // Overlay control
  ipcMain.handle('overlay:show', () => {
    createOverlayWindow();
    return true;
  });

  ipcMain.handle('overlay:hide', () => {
    overlayWindow?.close();
    return true;
  });

  // Shell helpers
  ipcMain.handle('shell:openExternal', (_, url) => {
    shell.openExternal(url);
  });

  // ── Skill Installation ──────────────────────────────────────
  ipcMain.handle('skill:check', async () => {
    const { execSync } = require('child_process');
    const os = require('os');
    const http = require('http');
    // Check if claude CLI exists
    let claudePath = null;
    try {
      claudePath = execSync('which claude', { timeout: 3000 }).toString().trim();
    } catch {}
    // Check if skill file exists
    const skillPath = path.join(os.homedir(), '.claude', 'commands', 'callingclaw.md');
    const skillInstalled = fs.existsSync(skillPath);
    // Check if OpenClaw Gateway is running on :18789
    let openclawConnected = false;
    try {
      await new Promise((resolve, reject) => {
        const req = http.get('http://localhost:18789', { timeout: 2000 }, (res) => {
          openclawConnected = res.statusCode < 500;
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(); });
      });
    } catch {}
    return { claudeInstalled: !!claudePath, claudePath, skillInstalled, skillPath, openclawConnected };
  });

  ipcMain.handle('skill:install', async () => {
    const os = require('os');
    const skillDir = path.join(os.homedir(), '.claude', 'commands');
    const skillPath = path.join(skillDir, 'callingclaw.md');
    // Ensure directory exists
    fs.mkdirSync(skillDir, { recursive: true });
    // Fetch latest skill manifest from daemon if running, else use bundled
    let content;
    try {
      const res = await fetch('http://localhost:4000/api/skill/manifest');
      const data = await res.json();
      content = data.markdown;
    } catch {}
    if (!content) {
      content = BUNDLED_SKILL_MARKDOWN;
    }
    fs.writeFileSync(skillPath, content, 'utf-8');
    return { ok: true, path: skillPath };
  });

  // ── Automation (replaces Python PyAutoGUI) ────────────────────
  ipcMain.handle('automation:run', async (_, action) => {
    const { execFile } = require('child_process');
    const type = action.type;
    let script = '';

    if (type === 'click' && action.x != null && action.y != null) {
      script = `do shell script "cliclick c:${Math.round(action.x)},${Math.round(action.y)}"`;
    } else if (type === 'type' && action.text) {
      // Use AppleScript keystroke for typing
      const escaped = action.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      script = `tell application "System Events" to keystroke "${escaped}"`;
    } else if (type === 'key' && action.key) {
      // Map common keys to AppleScript key codes
      const keyMap = { enter: 36, tab: 48, escape: 53, space: 49, delete: 51, up: 126, down: 125, left: 123, right: 124 };
      const code = keyMap[action.key.toLowerCase()];
      if (code) {
        script = `tell application "System Events" to key code ${code}`;
      } else {
        script = `tell application "System Events" to keystroke "${action.key}"`;
      }
    } else if (type === 'hotkey' && action.keys) {
      // e.g. {keys: ['command', 'c']}
      const modifiers = [];
      let char = '';
      for (const k of action.keys) {
        if (['command', 'shift', 'option', 'control'].includes(k.toLowerCase())) {
          modifiers.push(k.toLowerCase() + ' down');
        } else {
          char = k;
        }
      }
      const modStr = modifiers.length > 0 ? ' using {' + modifiers.join(', ') + '}' : '';
      script = `tell application "System Events" to keystroke "${char}"${modStr}`;
    } else {
      return { ok: false, error: 'Unknown action type: ' + type };
    }

    if (!script) return { ok: false, error: 'Empty script' };

    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: err.message, stderr: stderr });
        } else {
          resolve({ ok: true, action: type, stdout: stdout.trim() });
        }
      });
    });
  });

  // ── Audio Device Enumeration (for renderer to discover BlackHole) ──
  ipcMain.handle('audio:listDevices', async () => {
    const { execSync } = require('child_process');
    try {
      const output = execSync('system_profiler SPAudioDataType 2>/dev/null', { timeout: 5000 }).toString();
      return {
        hasBlackHole2ch: output.includes('BlackHole 2ch'),
        hasBlackHole16ch: output.includes('BlackHole 16ch'),
        raw: output,
      };
    } catch {
      return { hasBlackHole2ch: false, hasBlackHole16ch: false, raw: '' };
    }
  });

  // App info
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    daemonUrl: DAEMON_URL,
    isDev: IS_DEV,
    platform: process.platform,
    arch: process.arch,
  }));
}

// ── Environment Check ──────────────────────────────────────────

async function checkEnvironment() {
  const { execSync } = require('child_process');
  const fs = require('fs');

  const checks = {};

  // Bun runtime
  try {
    const bunPath = daemon.getBunPath();
    const bunVersion = execSync(`"${bunPath}" --version`, { timeout: 5000 }).toString().trim();
    checks.bun = { ok: true, version: bunVersion, path: bunPath };
  } catch {
    checks.bun = { ok: false, error: 'Bun not found' };
  }

  // Python
  try {
    const pyVersion = execSync('python3 --version', { timeout: 5000 }).toString().trim();
    checks.python = { ok: true, version: pyVersion };
  } catch {
    checks.python = { ok: false, error: 'Python 3 not found' };
  }

  // BlackHole
  try {
    const audioDevices = execSync('system_profiler SPAudioDataType 2>/dev/null', { timeout: 5000 }).toString();
    checks.blackhole2ch = { ok: audioDevices.includes('BlackHole 2ch') };
    checks.blackhole16ch = { ok: audioDevices.includes('BlackHole 16ch') };
  } catch {
    checks.blackhole2ch = { ok: false };
    checks.blackhole16ch = { ok: false };
  }

  // SwitchAudioSource
  try {
    execSync('which SwitchAudioSource', { timeout: 3000 });
    checks.switchAudioSource = { ok: true };
  } catch {
    checks.switchAudioSource = { ok: false };
  }

  // OpenClaw
  try {
    const ocConfig = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
    checks.openclaw = { ok: fs.existsSync(ocConfig), configPath: ocConfig };
  } catch {
    checks.openclaw = { ok: false };
  }

  // CallingClaw daemon directory
  const daemonDir = daemon.getDaemonDir();
  checks.daemonDir = { ok: fs.existsSync(daemonDir), path: daemonDir };

  // .env file
  const envPath = path.join(daemonDir, '.env');
  checks.envFile = { ok: fs.existsSync(envPath), path: envPath };

  return checks;
}

// ── App Lifecycle ──────────────────────────────────────────────

app.whenReady().then(async () => {
  // Set macOS dock icon
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    app.dock.setIcon(dockIcon);
  }

  // Resolve the CallingClaw daemon directory (sibling to this Electron app)
  const daemonDir = path.resolve(__dirname, '..', '..', '..', 'callingclaw');

  // Initialize subsystems
  daemon = new DaemonSupervisor({ daemonDir, isDev: IS_DEV });
  permissionChecker = new PermissionChecker();

  setupIPC();
  createTray();
  createMainWindow();

  // Start health check immediately to detect externally-started daemon
  daemon._startHealthCheck();

  // Forward daemon events to renderer
  daemon.on('started', () => {
    console.log('[App] CallingClaw daemon started');
    mainWindow?.webContents.send('daemon-status', true);
    updateTrayMenu('running');
  });
  daemon.on('stopped', (info) => {
    console.log(`[App] CallingClaw daemon stopped (code=${info?.code ?? 'unknown'}, signal=${info?.signal ?? 'unknown'})`);
    mainWindow?.webContents.send('daemon-status', false);
    updateTrayMenu('idle');
  });
  daemon.on('error', (err) => {
    console.error('[App] CallingClaw daemon error:', err);
    mainWindow?.webContents.send('daemon-error', err.message);
    updateTrayMenu('error');
  });
  daemon.on('log', (line) => {
    mainWindow?.webContents.send('daemon-log', line);
  });
  daemon.on('health', () => {
    // When health check succeeds, notify renderer that daemon is alive
    // This handles the case where daemon was started externally
    if (daemon.isRunning()) {
      mainWindow?.webContents.send('daemon-status', true);
    }
  });

  try {
    console.log('[App] Auto-starting CallingClaw daemon...');
    await daemon.start();
  } catch (err) {
    console.error('[App] Failed to auto-start CallingClaw daemon:', err);
  }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createMainWindow();
});

app.on('before-quit', (e) => {
  if (shutdownInProgress) return;

  app.isQuitting = true;
  if (!daemon?.isRunning()) return;

  e.preventDefault();
  shutdownInProgress = true;
  console.log('[App] Quit requested, stopping CallingClaw daemon before exit...');

  daemon.stop()
    .catch((err) => {
      console.error('[App] Failed to stop daemon during quit:', err);
    })
    .finally(() => {
      console.log('[App] Daemon shutdown flow finished, quitting app');
      shutdownInProgress = false;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
