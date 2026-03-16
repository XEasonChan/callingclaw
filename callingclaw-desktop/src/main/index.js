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

// ── App State ──────────────────────────────────────────────────

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let daemon = null;
let permissionChecker = null;

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
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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

  // Forward daemon events to renderer
  daemon.on('started', () => {
    mainWindow?.webContents.send('daemon-status', true);
    updateTrayMenu('running');
  });
  daemon.on('stopped', () => {
    mainWindow?.webContents.send('daemon-status', false);
    updateTrayMenu('idle');
  });
  daemon.on('error', (err) => {
    mainWindow?.webContents.send('daemon-error', err.message);
    updateTrayMenu('error');
  });
  daemon.on('log', (line) => {
    mainWindow?.webContents.send('daemon-log', line);
  });
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createMainWindow();
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  if (daemon?.isRunning()) {
    await daemon.stop();
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
