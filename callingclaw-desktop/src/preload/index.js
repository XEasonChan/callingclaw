// ═══════════════════════════════════════════════════════════════
// Preload — Expose safe APIs to renderer via contextBridge
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callingclaw', {
  // ── Daemon ─────────────────────────────────────────────────
  daemon: {
    start: () => ipcRenderer.invoke('daemon:start'),
    stop: () => ipcRenderer.invoke('daemon:stop'),
    restart: () => ipcRenderer.invoke('daemon:restart'),
    status: () => ipcRenderer.invoke('daemon:status'),
    onStatus: (cb) => {
      const handler = (_, status) => cb(status);
      ipcRenderer.on('daemon-status', handler);
      return () => ipcRenderer.removeListener('daemon-status', handler);
    },
    onError: (cb) => {
      const handler = (_, err) => cb(err);
      ipcRenderer.on('daemon-error', handler);
      return () => ipcRenderer.removeListener('daemon-error', handler);
    },
    onLog: (cb) => {
      const handler = (_, line) => cb(line);
      ipcRenderer.on('daemon-log', handler);
      return () => ipcRenderer.removeListener('daemon-log', handler);
    },
  },

  // ── Permissions ────────────────────────────────────────────
  permissions: {
    check: () => ipcRenderer.invoke('permissions:check'),
    request: (perm) => ipcRenderer.invoke('permissions:request', perm),
    openSettings: (panel) => ipcRenderer.invoke('permissions:openSettings', panel),
  },

  // ── Environment ────────────────────────────────────────────
  env: {
    check: () => ipcRenderer.invoke('env:check'),
  },

  // ── Overlay ────────────────────────────────────────────────
  overlay: {
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
  },

  // ── Skill ──────────────────────────────────────────────────
  skill: {
    check: () => ipcRenderer.invoke('skill:check'),
    install: () => ipcRenderer.invoke('skill:install'),
  },

  // ── Shell ──────────────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ── Automation (replaces Python PyAutoGUI) ─────────────────
  automation: {
    run: (action) => ipcRenderer.invoke('automation:run', action),
    click: (x, y) => ipcRenderer.invoke('automation:run', { type: 'click', x, y }),
    type: (text) => ipcRenderer.invoke('automation:run', { type: 'type', text }),
    key: (key) => ipcRenderer.invoke('automation:run', { type: 'key', key }),
    hotkey: (keys) => ipcRenderer.invoke('automation:run', { type: 'hotkey', keys }),
  },

  // ── Audio ─────────────────────────────────────────────────
  audio: {
    listDevices: () => ipcRenderer.invoke('audio:listDevices'),
  },

  // ── App Info ───────────────────────────────────────────────
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
});
