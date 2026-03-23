// ═══════════════════════════════════════════════════════════════
// AudioBridge v3 — Electron audio capture/playback via Web Audio API
// ═══════════════════════════════════════════════════════════════
//
// Architecture (both modes share the same code):
//
//   Talk Locally (direct):
//     Real mic → AudioWorklet → PCM16 24kHz → base64 → WS → Grok/OpenAI
//     AI audio → base64 → PCM16 → PlaybackWorklet(ring buffer) → Speaker
//
//   Meet Bridge:
//     BlackHole 16ch (Meet speaker) → AudioWorklet → PCM16 24kHz → base64 → WS → Grok/OpenAI
//     AI audio → base64 → PCM16 → PlaybackWorklet(ring buffer) → BlackHole 2ch → Meet mic
//
// Key improvements over v2:
//   - AudioWorklet ring buffer for playback (gapless, no scheduling, no pops)
//   - AnalyserNode on capture for real-time mic level visualization
//   - Capture AudioWorklet + playback AudioWorklet (both via Blob URL)
//
// ⚠️  CRITICAL: setSinkId() MUST be called BEFORE getUserMedia()
//     to avoid Electron bug #40704 (silent output failure)

var ElectronAudioBridge = (function() {
  'use strict';

  var SAMPLE_RATE = 24000;

  // ── State ──
  var _audioCtx = null;       // Playback AudioContext (24kHz)
  var _captureCtx = null;     // Capture AudioContext (native rate for AudioWorklet)
  var _captureStream = null;
  var _captureSource = null;
  var _workletNode = null;
  var _analyserNode = null;   // AnalyserNode for mic level visualization
  var _playbackWorklet = null; // AudioWorkletNode for ring buffer playback
  var _running = false;
  var _starting = false;
  var _mode = null;            // 'direct' | 'meet_bridge'
  var _onAudioChunk = null;    // callback(base64Pcm)
  var _devices = { input: null, output: null };

  // ── Capture AudioWorklet code (inlined as Blob URL to avoid file:// issues in Electron) ──
  var CAPTURE_WORKLET_CODE = [
    'class PCMProcessor extends AudioWorkletProcessor {',
    '  process(inputs) {',
    '    var input = inputs[0] && inputs[0][0];',
    '    if (input) {',
    '      var int16 = new Int16Array(input.length);',
    '      for (var i = 0; i < input.length; i++) {',
    '        var s = Math.max(-1, Math.min(1, input[i]));',
    '        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;',
    '      }',
    '      this.port.postMessage(int16, [int16.buffer]);',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('pcm-processor', PCMProcessor);",
  ].join('\n');

  // ── Playback AudioWorklet code (ring buffer — gapless, no scheduling complexity) ──
  var PLAYBACK_WORKLET_CODE = [
    'class PlaybackProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this._buffer = new Float32Array(24000 * 10);', // 10 second ring buffer
    '    this._writePos = 0;',
    '    this._readPos = 0;',
    '    this.port.onmessage = (e) => {',
    '      if (e.data === "clear") {',
    '        this._writePos = 0;',
    '        this._readPos = 0;',
    '        return;',
    '      }',
    '      var samples = e.data;',
    '      for (var i = 0; i < samples.length; i++) {',
    '        this._buffer[this._writePos % this._buffer.length] = samples[i];',
    '        this._writePos++;',
    '      }',
    '    };',
    '  }',
    '  process(inputs, outputs) {',
    '    var output = outputs[0][0];',
    '    if (!output) return true;',
    '    for (var i = 0; i < output.length; i++) {',
    '      if (this._readPos < this._writePos) {',
    '        output[i] = this._buffer[this._readPos % this._buffer.length];',
    '        this._readPos++;',
    '      } else {',
    '        output[i] = 0;',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('playback-processor', PlaybackProcessor);",
  ].join('\n');

  // ── Chunked base64 encoder (avoids stack overflow on large buffers) ──
  function audioToBase64(int16Array) {
    var bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
    var CHUNK = 0x2000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  // ── Device Discovery ──

  function enumerateAudioDevices() {
    return navigator.mediaDevices.enumerateDevices().then(function(devices) {
      var inputs = devices.filter(function(d) { return d.kind === 'audioinput'; });
      var outputs = devices.filter(function(d) { return d.kind === 'audiooutput'; });
      return { inputs: inputs, outputs: outputs };
    });
  }

  function findBlackHoleDevices() {
    return enumerateAudioDevices().then(function(devs) {
      // Meet mic = BlackHole 2ch (Meet only reads first 2 channels)
      // Meet speaker = BlackHole 16ch (captures meeting audio for AI)
      // So: AI playback → BlackHole 2ch (output), AI capture → BlackHole 16ch (input)
      var bh16chIn = devs.inputs.find(function(d) { return d.label.includes('BlackHole 16ch'); });
      var bh2chOut = devs.outputs.find(function(d) { return d.label.includes('BlackHole 2ch'); });
      return {
        capture: bh16chIn || null,    // Capture Meet audio FROM BlackHole 16ch
        playback: bh2chOut || null,   // Play AI voice TO BlackHole 2ch → Meet mic
        captureId: bh16chIn ? bh16chIn.deviceId : null,
        playbackId: bh2chOut ? bh2chOut.deviceId : null,
        available: !!(bh16chIn && bh2chOut),
      };
    });
  }

  // ── Start Bridge ──

  function start(mode, onAudioChunk) {
    if (_starting) { console.warn('[AudioBridge] start() already in progress'); return Promise.resolve({ ok: false, reason: 'already_starting' }); }
    if (_running) { stop(); }
    _starting = true;
    _mode = mode || 'direct';
    _onAudioChunk = onAudioChunk;

    return findBlackHoleDevices().then(function(bh) {
      var inputDeviceId = null;
      var outputDeviceId = null;

      if (_mode === 'meet_bridge') {
        if (!bh.available) {
          console.warn('[AudioBridge] BlackHole not found, falling back to direct mode');
          _mode = 'direct';
        } else {
          inputDeviceId = bh.captureId;
          outputDeviceId = bh.playbackId;
          console.log('[AudioBridge] meet_bridge: capture=' + bh.capture.label + ', playback=' + bh.playback.label);
        }
      }

      _devices.input = inputDeviceId;
      _devices.output = outputDeviceId;

      // ⚠️ CRITICAL ORDER: setSinkId BEFORE getUserMedia (Electron bug #40704)
      return _setupPlayback(outputDeviceId).then(function() {
        _running = true;
        return _setupCapture(inputDeviceId).catch(function(err) {
          console.warn('[AudioBridge] Capture failed (playback still active):', err.message);
        });
      });
    }).then(function() {
      _starting = false;
      console.log('[AudioBridge] Started in ' + _mode + ' mode (capture: ' +
        (_captureCtx ? _captureCtx.sampleRate + 'Hz AudioWorklet' : 'N/A') +
        ', playback: ' + (_audioCtx ? _audioCtx.sampleRate + 'Hz WorkletRingBuffer' : 'N/A') + ')');
      return { ok: true, mode: _mode };
    }).catch(function(err) {
      _starting = false;
      throw err;
    });
  }

  // ── Setup Playback (AudioWorklet ring buffer) — MUST be called first ──

  function _setupPlayback(outputDeviceId) {
    _audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Resume if suspended (Electron autoplay policy)
    var resumePromise = _audioCtx.state !== 'running'
      ? _audioCtx.resume().catch(function() {})
      : Promise.resolve();

    // Set output device (BlackHole 16ch for meet_bridge)
    var sinkPromise;
    if (outputDeviceId && _audioCtx.setSinkId) {
      sinkPromise = resumePromise.then(function() {
        return _audioCtx.setSinkId(outputDeviceId);
      }).then(function() {
        console.log('[AudioBridge] Output device: ' + outputDeviceId);
      }).catch(function(e) {
        console.warn('[AudioBridge] setSinkId failed:', e.message);
      });
    } else {
      sinkPromise = resumePromise;
    }

    // Load playback worklet via Blob URL and create node
    return sinkPromise.then(function() {
      var blob = new Blob([PLAYBACK_WORKLET_CODE], { type: 'application/javascript' });
      var workletUrl = URL.createObjectURL(blob);
      return _audioCtx.audioWorklet.addModule(workletUrl).then(function() {
        URL.revokeObjectURL(workletUrl);
        _playbackWorklet = new AudioWorkletNode(_audioCtx, 'playback-processor');
        _playbackWorklet.connect(_audioCtx.destination);
        console.log('[AudioBridge] Playback ready (WorkletRingBuffer, ' + _audioCtx.state + ')');
      });
    });
  }

  // ── Setup Capture (AudioWorklet via Blob URL) ──

  function _setupCapture(inputDeviceId) {
    // Use native sample rate for capture (avoids silence in some browsers)
    _captureCtx = new AudioContext();
    var captureRate = _captureCtx.sampleRate;

    var constraints = {
      audio: {
        channelCount: 1,
        echoCancellation: _mode === 'direct',
        noiseSuppression: _mode === 'direct',
        autoGainControl: _mode === 'direct',
      }
    };
    if (inputDeviceId) {
      constraints.audio.deviceId = { exact: inputDeviceId };
    }

    // Load AudioWorklet from Blob URL (works with file:// in Electron)
    var blob = new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' });
    var workletUrl = URL.createObjectURL(blob);

    return _captureCtx.resume().then(function() {
      return _captureCtx.audioWorklet.addModule(workletUrl);
    }).then(function() {
      URL.revokeObjectURL(workletUrl);
      return navigator.mediaDevices.getUserMedia(constraints);
    }).then(function(stream) {
      _captureStream = stream;
      _captureSource = _captureCtx.createMediaStreamSource(stream);

      // Create AnalyserNode for mic level visualization
      _analyserNode = _captureCtx.createAnalyser();
      _analyserNode.fftSize = 256;
      _analyserNode.smoothingTimeConstant = 0.3;
      _captureSource.connect(_analyserNode);

      _workletNode = new AudioWorkletNode(_captureCtx, 'pcm-processor');
      _captureSource.connect(_workletNode);

      _workletNode.port.onmessage = function(e) {
        if (!_running || !_onAudioChunk) return;
        var int16Data = e.data; // Int16Array at captureRate

        // Downsample from native rate to 24kHz if needed
        if (captureRate !== SAMPLE_RATE && captureRate > SAMPLE_RATE) {
          var ratio = captureRate / SAMPLE_RATE;
          var newLen = Math.round(int16Data.length / ratio);
          var resampled = new Int16Array(newLen);
          for (var i = 0; i < newLen; i++) {
            resampled[i] = int16Data[Math.round(i * ratio)] || 0;
          }
          int16Data = resampled;
        }

        _onAudioChunk(audioToBase64(int16Data));
      };

      console.log('[AudioBridge] Capture ready (AudioWorklet, ' + captureRate + 'Hz -> ' + SAMPLE_RATE + 'Hz, AnalyserNode attached)');
    });
  }

  // ── Receive AI Audio (AudioWorklet ring buffer — gapless, pop-free) ──

  function playAudio(base64Pcm) {
    if (!_running || !_audioCtx || !_playbackWorklet) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(function() {});

    try {
      // Decode base64 → PCM16 → Float32
      var raw = atob(base64Pcm);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      var pcm16 = new Int16Array(bytes.buffer);
      var float32 = new Float32Array(pcm16.length);
      for (var j = 0; j < pcm16.length; j++) {
        float32[j] = pcm16[j] / 32768;
      }

      // Apply micro fade-in/out (24 samples = 1ms) to prevent DC offset clicks
      var FADE = 24;
      if (float32.length > FADE * 2) {
        for (var f = 0; f < FADE; f++) {
          var gain = f / FADE;
          float32[f] *= gain;
          float32[float32.length - 1 - f] *= gain;
        }
      }

      // Post to ring buffer worklet — no scheduling needed
      _playbackWorklet.port.postMessage(float32, [float32.buffer]);
    } catch (e) {
      console.warn('[AudioBridge] playAudio error:', e.message);
    }
  }

  // ── Interrupt: clear ring buffer ──

  function interruptPlayback() {
    if (_playbackWorklet) {
      _playbackWorklet.port.postMessage('clear');
    }
  }

  // ── Stop ──

  function stop() {
    if (!_running && !_starting) return;
    _running = false;
    _starting = false;
    _onAudioChunk = null;

    interruptPlayback();

    if (_workletNode) { _workletNode.disconnect(); _workletNode = null; }
    if (_analyserNode) { _analyserNode.disconnect(); _analyserNode = null; }
    if (_captureSource) { _captureSource.disconnect(); _captureSource = null; }
    if (_captureStream) {
      _captureStream.getTracks().forEach(function(t) { t.stop(); });
      _captureStream = null;
    }
    if (_playbackWorklet) { _playbackWorklet.disconnect(); _playbackWorklet = null; }
    if (_captureCtx) { _captureCtx.close().catch(function() {}); _captureCtx = null; }
    if (_audioCtx) { _audioCtx.close().catch(function() {}); _audioCtx = null; }
    _mode = null;
    _devices = { input: null, output: null };
    console.log('[AudioBridge] Stopped');
  }

  // ── AnalyserNode accessor (for mic level visualization) ──

  function getAnalyserNode() {
    return _analyserNode;
  }

  // ── Status ──

  function getStatus() {
    return {
      running: _running,
      mode: _mode,
      devices: _devices,
      sampleRate: SAMPLE_RATE,
      audioContextState: _audioCtx ? _audioCtx.state : null,
      captureContextState: _captureCtx ? _captureCtx.state : null,
      playbackWorkletActive: !!_playbackWorklet,
    };
  }

  // ── Public API ──
  return {
    start: start,
    stop: stop,
    playAudio: playAudio,
    interruptPlayback: interruptPlayback,
    getStatus: getStatus,
    getAnalyserNode: getAnalyserNode,
    enumerateAudioDevices: enumerateAudioDevices,
    findBlackHoleDevices: findBlackHoleDevices,
  };
})();
