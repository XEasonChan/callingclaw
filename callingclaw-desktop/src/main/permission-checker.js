// ═══════════════════════════════════════════════════════════════
// Permission Checker — macOS TCC permission detection & guidance
// ═══════════════════════════════════════════════════════════════

const { systemPreferences, shell } = require('electron');
const { execSync } = require('child_process');

class PermissionChecker {
  // ── Check Required Permissions (onboarding) ────────────────
  // Microphone is NOT required for onboarding — BlackHole virtual
  // audio doesn't need TCC mic authorization. Mic is only needed
  // for "direct mode" (real microphone, no meeting).

  async checkAll() {
    return {
      screenRecording: this.checkScreenRecording(),
      accessibility: this.checkAccessibility(),
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

module.exports = { PermissionChecker };
