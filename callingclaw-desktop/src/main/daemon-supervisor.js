// ═══════════════════════════════════════════════════════════════
// Daemon Supervisor — Spawns and monitors the CallingClaw Bun daemon
// ═══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const http = require('http');

const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
const HEALTH_CHECK_URL = 'http://localhost:4000/api/status';
const STARTUP_TIMEOUT = 15000; // 15 seconds

class DaemonSupervisor extends EventEmitter {
  constructor({ daemonDir, isDev = false }) {
    super();
    this._daemonDir = daemonDir;
    this._isDev = isDev;
    this._process = null;
    this._externalDaemonAlive = false;
    this._healthTimer = null;
    this._restarting = false;
  }

  // ── Public API ───────────────────────────────────────────────

  getDaemonDir() {
    return this._daemonDir;
  }

  getBunPath() {
    // Priority: bundled Bun in app resources → system Bun
    const bundledBun = path.join(process.resourcesPath || '', 'bun', 'bun');
    if (fs.existsSync(bundledBun)) return bundledBun;

    // System Bun (dev mode or fallback)
    const homeBun = path.join(require('os').homedir(), '.bun', 'bin', 'bun');
    if (fs.existsSync(homeBun)) return homeBun;

    // Last resort: rely on PATH
    return 'bun';
  }

  get pid() {
    return this._process?.pid ?? null;
  }

  isRunning() {
    // Check our own spawned process first
    if (this._process !== null && !this._process.killed) return true;
    // Also detect externally-started daemon (e.g. manual `bun run start`)
    return this._externalDaemonAlive === true;
  }

  async start() {
    if (this.isRunning()) {
      this.emit('log', '[Supervisor] Daemon already running');
      return;
    }

    const bunPath = this.getBunPath();
    const entryScript = this._isDev ? 'run' : 'run';
    const args = [entryScript, this._isDev ? 'dev' : 'start'];

    this.emit('log', `[Supervisor] Starting daemon: ${bunPath} ${args.join(' ')}`);
    this.emit('log', `[Supervisor] Working dir: ${this._daemonDir}`);

    try {
      this._process = spawn(bunPath, args, {
        cwd: this._daemonDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AUDIO_SOURCE: 'electron',
          // Ensure Bun can find its own runtime
          PATH: `${path.dirname(bunPath)}:${process.env.PATH}`,
        },
      });

      // Stream stdout/stderr to renderer
      this._process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.emit('log', line);
        }
      });

      this._process.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.emit('log', `[stderr] ${line}`);
        }
      });

      this._process.on('exit', (code, signal) => {
        this.emit('log', `[Supervisor] Daemon exited: code=${code}, signal=${signal}`);
        this._process = null;
        this._stopHealthCheck();

        if (!this._restarting) {
          this.emit('stopped', { code, signal });
        }
      });

      this._process.on('error', (err) => {
        this.emit('error', err);
        this._process = null;
      });

      // Wait for daemon to be healthy
      await this._waitForHealth();
      this._startHealthCheck();
      this.emit('started');
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  async stop() {
    if (!this.isRunning()) return;

    this._stopHealthCheck();
    this.emit('log', '[Supervisor] Stopping daemon...');

    // Try graceful shutdown via API first
    try {
      await this._httpGet('http://localhost:4000/api/shutdown', 3000);
    } catch {
      // API not available, fall through to SIGTERM
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this._process && !this._process.killed) {
          this.emit('log', '[Supervisor] Force killing daemon');
          this._process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      if (this._process) {
        this._process.once('exit', () => {
          clearTimeout(timeout);
          this._process = null;
          this.emit('stopped', { code: 0, signal: 'SIGTERM' });
          resolve();
        });
        this._process.kill('SIGTERM');
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  async restart() {
    this._restarting = true;
    await this.stop();
    this._restarting = false;
    await this.start();
  }

  // ── Health Check ─────────────────────────────────────────────

  _startHealthCheck() {
    // Run once immediately to detect externally-started daemon
    this._doHealthCheck();
    this._healthTimer = setInterval(() => this._doHealthCheck(), HEALTH_CHECK_INTERVAL);
  }

  async _doHealthCheck() {
    try {
      const status = await this._httpGet(HEALTH_CHECK_URL, 3000);
      const data = JSON.parse(status);
      // Detect externally-started daemon (not spawned by us)
      if (!this._process && !this._externalDaemonAlive) {
        this._externalDaemonAlive = true;
        this.emit('log', '[Supervisor] Detected external daemon on :4000');
      }
      this._externalDaemonAlive = true;
      this.emit('health', data);
    } catch {
      this._externalDaemonAlive = false;
      if (this._process && !this._process.killed) {
        this.emit('log', '[Supervisor] Health check failed, daemon unresponsive');
      }
    }
  }

  _stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  async _waitForHealth() {
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT) {
      try {
        await this._httpGet(HEALTH_CHECK_URL, 2000);
        this.emit('log', '[Supervisor] Daemon is healthy');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    this.emit('log', '[Supervisor] Daemon started but health check timed out');
  }

  // ── Helpers ──────────────────────────────────────────────────

  _httpGet(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  }
}

module.exports = { DaemonSupervisor };
