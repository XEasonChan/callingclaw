// ═══════════════════════════════════════════════════════════════
// Permission Checker — macOS TCC permission detection & guidance
// ═══════════════════════════════════════════════════════════════

const { systemPreferences, shell, app } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');

class PermissionChecker {
  // ── Check Required Permissions (onboarding) ────────────────
  // Microphone is required for BOTH modes:
  //   - meet_bridge: getUserMedia(BlackHole 16ch) triggers TCC
  //   - direct: getUserMedia(real mic) triggers TCC

  async checkAll() {
    return {
      screenRecording: this.checkScreenRecording(),
      accessibility: this.checkAccessibility(),
      microphone: await this.checkMicrophone(),
    };
  }

  // ── Check Optional Permissions (on-demand) ─────────────────
  // Called when user switches to direct mode (real mic, no BlackHole).

  async checkOptional() {
    return {
      microphone: await this.checkMicrophone(),
    };
  }

  // ── Individual Checks ────────────────────────────────────────

  async checkMicrophone() {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    // status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
    return {
      granted: status === 'granted',
      status,
      canRequest: status === 'not-determined',
    };
  }

  checkScreenRecording() {
    const status = systemPreferences.getMediaAccessStatus('screen');
    return {
      granted: status === 'granted',
      status,
      canRequest: false, // Screen recording can't be requested programmatically
    };
  }

  checkAccessibility() {
    // Check if accessibility is trusted
    let granted = false;
    try {
      // This uses the macOS AXIsProcessTrusted API
      const result = execSync(
        'osascript -e \'tell application "System Events" to return name of first process\'',
        { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      granted = true;
    } catch {
      granted = false;
    }

    return {
      granted,
      status: granted ? 'granted' : 'denied',
      canRequest: false,
    };
  }

  // ── Request Permission ───────────────────────────────────────

  async request(permission) {
    switch (permission) {
      case 'microphone': {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return { granted };
      }
      case 'screenRecording':
      case 'accessibility':
        // These can't be requested programmatically — open System Settings
        this.openSystemSettings(permission);
        return { granted: false, openedSettings: true };
      default:
        return { granted: false, error: `Unknown permission: ${permission}` };
    }
  }

  // ── Open System Settings ─────────────────────────────────────

  openSystemSettings(panel) {
    const urls = {
      microphone:
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      screenRecording:
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      accessibility:
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      camera:
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    };

    const url = urls[panel];
    if (url) {
      shell.openExternal(url);
    }
  }
}

  // ── Bundle ID Info (dev vs prod TCC mismatch) ───────────────

  getBundleInfo() {
    return {
      bundleId: app.isPackaged ? 'com.tanka.callingclaw' : 'com.github.electron',
      isPackaged: app.isPackaged,
      warning: !app.isPackaged
        ? 'Dev mode: TCC permissions are tied to com.github.electron, not com.tanka.callingclaw. Permissions granted here won\'t carry to the production DMG.'
        : null,
    };
  }

  // ── System Default Output Device ───────────────────────────

  getDefaultOutputDevice() {
    // Try SwitchAudioSource first (most reliable)
    const sasPaths = ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'];
    for (const p of sasPaths) {
      if (fs.existsSync(p)) {
        try {
          const name = execSync(`"${p}" -c -t output`, { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
          return { name, isBlackHole: name.includes('BlackHole') };
        } catch {}
      }
    }
    // Fallback: parse system_profiler
    try {
      const output = execSync('system_profiler SPAudioDataType 2>/dev/null', { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const lines = output.split('\n');
      let currentDevice = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Device names are indented lines ending with ':'
        const deviceMatch = line.match(/^\s{4,8}(\S.+?):\s*$/);
        if (deviceMatch) { currentDevice = deviceMatch[1]; continue; }
        if (line.includes('Default Output Device: Yes') && currentDevice) {
          return { name: currentDevice, isBlackHole: currentDevice.includes('BlackHole') };
        }
      }
    } catch {}
    return { name: null, isBlackHole: false };
  }
}

module.exports = { PermissionChecker };
