/**
 * CallingClaw — Browser Audio Utilities
 *
 * Shared audio capture/playback for Electron renderer and voice-test page.
 * Uses browser-native APIs (getUserMedia, AudioContext, ScriptProcessorNode).
 *
 * Audio flow:
 *   Mic → getUserMedia → AudioContext(24kHz) → ScriptProcessor
 *       → Float32 → PCM16 → base64 → WebSocket → Bun → OpenAI Realtime
 *
 *   OpenAI → base64 PCM16 → WebSocket → Float32 → AudioContext → Speaker
 */

// ── Conversion helpers ──

/** Float32 audio samples → Int16 PCM buffer */
function float32ToPcm16(float32) {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16;
}

/** Int16 PCM buffer → Float32 audio samples */
function pcm16ToFloat32(pcm16) {
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

/** Uint8Array → base64 string */
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 string → Uint8Array */
function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── BrowserAudio class ──

/**
 * Manages browser mic capture + speaker playback over a WebSocket.
 *
 * Usage:
 *   const audio = new BrowserAudio();
 *   await audio.start(wsUrl, { onTranscript, onStatus, onError });
 *   // ... user speaks, AI responds ...
 *   audio.stop();
 */
class BrowserAudio {
  constructor() {
    this.ws = null;
    this.audioCtx = null;
    this.micStream = null;
    this.micSource = null;
    this.micProcessor = null;
    this.playbackNode = null;
    this.playbackQueue = [];
    this.active = false;
    this._starting = false;
  }

  /**
   * Start audio capture + playback + WebSocket connection.
   * @param {string} wsUrl - WebSocket URL (e.g. ws://localhost:4000/ws/voice-test)
   * @param {object} opts
   * @param {string} [opts.instructions] - System prompt for voice session
   * @param {function} [opts.onTranscript] - Called with {role, text, ts}
   * @param {function} [opts.onStatus] - Called with {voiceConnected: bool}
   * @param {function} [opts.onError] - Called with error message string
   * @param {function} [opts.onSpeaking] - Called with bool (AI speaking state)
   */
  async start(wsUrl, opts = {}) {
    if (this.active || this._starting) return;
    this._starting = true;

    try {
      // 1. Get mic permission
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
      });

      // 2. AudioContext at 24kHz (OpenAI Realtime native rate)
      this.audioCtx = new AudioContext({ sampleRate: 24000 });
      if (this.audioCtx.sampleRate !== 24000) {
        console.warn('[BrowserAudio] AudioContext sampleRate is ' + this.audioCtx.sampleRate + ', expected 24000');
      }

      // 3. Mic capture → PCM16 → base64 → WebSocket
      this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
      this.micProcessor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.micSource.connect(this.micProcessor);
      this.micProcessor.connect(this.audioCtx.destination); // required for processing

      this.micProcessor.onaudioprocess = (e) => {
        if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = float32ToPcm16(input);
        const b64 = uint8ToBase64(new Uint8Array(pcm16.buffer));
        this.ws.send(JSON.stringify({ type: 'audio', audio: b64 }));
      };

      // 4. Playback node — drains queue of Float32 chunks to speaker
      this.playbackQueue = [];
      this.playbackNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
      let isSpeaking = false;

      this.playbackNode.onaudioprocess = (e) => {
        const output = e.outputBuffer.getChannelData(0);
        if (this.playbackQueue.length > 0) {
          const chunk = this.playbackQueue.shift();
          const len = Math.min(chunk.length, output.length);
          for (let i = 0; i < len; i++) output[i] = chunk[i];
          for (let i = len; i < output.length; i++) output[i] = 0;
          if (!isSpeaking) { isSpeaking = true; opts.onSpeaking?.(true); }
        } else {
          for (let i = 0; i < output.length; i++) output[i] = 0;
          if (isSpeaking) { isSpeaking = false; opts.onSpeaking?.(false); }
        }
      };
      this.playbackNode.connect(this.audioCtx.destination);

      // 5. WebSocket connection
      await this._connectWS(wsUrl, opts);

      this.active = true;
    } catch (e) {
      this.stop();
      const msg = e.name === 'NotAllowedError' ? 'Microphone permission denied. Allow it in System Settings.' :
                  e.name === 'NotFoundError' ? 'No microphone device found.' :
                  'Audio startup failed: ' + e.message;
      opts.onError?.(msg);
      throw e;
    } finally {
      this._starting = false;
    }
  }

  /** Connect WebSocket and send start command */
  _connectWS(wsUrl, opts) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 8000);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        // Send start with instructions
        this.ws.send(JSON.stringify({
          type: 'start',
          instructions: opts.instructions || undefined,
        }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'audio' && msg.audio) {
            // Decode base64 PCM16 → Float32 → playback queue
            const bytes = base64ToUint8(msg.audio);
            const pcm16 = new Int16Array(bytes.buffer);
            const float32 = pcm16ToFloat32(pcm16);
            this.playbackQueue.push(float32);
            // Limit queue to ~2s of audio at 24kHz
            while (this.playbackQueue.length > 12) this.playbackQueue.shift();
          } else if (msg.type === 'transcript') {
            opts.onTranscript?.({ role: msg.role, text: msg.text, ts: msg.ts });
          } else if (msg.type === 'status') {
            opts.onStatus?.(msg);
            if (msg.voiceConnected) resolve();
          } else if (msg.type === 'error') {
            opts.onError?.(msg.message);
          }
        } catch {}
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        if (this.active) {
          this.active = false;
          opts.onStatus?.({ voiceConnected: false });
          this._cleanupAudio();
        }
      };
    });
  }

  /** Stop everything — mic, speaker, WebSocket */
  stop() {
    this.active = false;
    // Send stop command before closing
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'stop' })); } catch {}
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._cleanupAudio();
  }

  _cleanupAudio() {
    if (this.micProcessor) {
      this.micProcessor.onaudioprocess = null;
      try { this.micProcessor.disconnect(); } catch {}
      this.micProcessor = null;
    }
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch {}
      this.micSource = null;
    }
    if (this.playbackNode) {
      this.playbackNode.onaudioprocess = null;
      try { this.playbackNode.disconnect(); } catch {}
      this.playbackNode = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
    this.playbackQueue = [];
  }

  get isActive() { return this.active; }
  get isStarting() { return this._starting; }
}
