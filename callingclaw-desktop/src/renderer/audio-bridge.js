// ═══════════════════════════════════════════════════════════════
// AudioBridge — Electron-native audio capture/playback via Web Audio API
// Replaces Python sidecar's PyAudio + BlackHole routing
// ═══════════════════════════════════════════════════════════════
//
// Architecture:
//
//   Google Meet
//     │ (system audio output → BlackHole 2ch)
//     ▼
//   getUserMedia({deviceId: BlackHole 2ch})
//     │
//     ▼
//   AudioContext (24kHz) → ScriptProcessor → PCM16 → base64
//     │
//     ▼
//   WebSocket → Bun :4000 → OpenAI Realtime
//     │
//     ▼ (AI response audio)
//   base64 → PCM16 → ScriptProcessor → AudioContext
//     │
//     │ (setSinkId: BlackHole 16ch)
//     ▼
//   Google Meet mic input ← BlackHole 16ch
//
// ⚠️  CRITICAL: setSinkId() MUST be called BEFORE getUserMedia()
//     to avoid Electron bug #40704 (silent output failure)
//

var ElectronAudioBridge = (function() {
  'use strict';

  var SAMPLE_RATE = 24000;
  var CHUNK_SIZE = 4096; // ~170ms at 24kHz
  var MAX_PLAYBACK_QUEUE = 100; // ~17 seconds buffer

  // ── State ──
  var _audioCtx = null;
  var _captureStream = null;
  var _captureSource = null;
  var _captureProcessor = null;
  var _playbackProcessor = null;
  var _playbackQueue = [];
  var _running = false;
  var _mode = null; // 'direct' | 'meet_bridge'
  var _onAudioChunk = null; // callback(base64Pcm)
  var _devices = { input: null, output: null }; // selected device IDs

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
      var bh2ch = devs.inputs.find(function(d) { return d.label.includes('BlackHole 2ch'); });
      var bh16ch = devs.outputs.find(function(d) { return d.label.includes('BlackHole 16ch'); });
      return {
        capture: bh2ch || null,
        playback: bh16ch || null,
        captureId: bh2ch ? bh2ch.deviceId : null,
        playbackId: bh16ch ? bh16ch.deviceId : null,
        available: !!(bh2ch && bh16ch),
      };
    });
  }

  // ── Start Bridge ──

  var _starting = false;

  function start(mode, onAudioChunk) {
    if (_starting) { console.warn('[AudioBridge] start() already in progress, ignoring'); return Promise.resolve({ ok: false, reason: 'already_starting' }); }
    if (_running) { stop(); }
    _starting = true;
    _mode = mode || 'direct';
    _onAudioChunk = onAudioChunk;
    _playbackQueue = [];

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
          console.log('[AudioBridge] meet_bridge mode: capture=' + bh.capture.label + ', playback=' + bh.playback.label);
        }
      }

      _devices.input = inputDeviceId;
      _devices.output = outputDeviceId;

      // ⚠️ CRITICAL ORDER: setSinkId BEFORE getUserMedia (Electron bug #40704)
      return _setupPlayback(outputDeviceId).then(function() {
        return _setupCapture(inputDeviceId);
      });
    }).then(function() {
      _running = true;
      _starting = false;
      console.log('[AudioBridge] Started in ' + _mode + ' mode');
      return { ok: true, mode: _mode };
    }).catch(function(err) {
      _starting = false;
      throw err;
    });
  }

  // ── Setup Playback (output) — MUST be called first ──

  function _setupPlayback(outputDeviceId) {
    _audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Set output device if specified
    var sinkPromise;
    if (outputDeviceId && _audioCtx.setSinkId) {
      sinkPromise = _audioCtx.setSinkId(outputDeviceId).then(function() {
        console.log('[AudioBridge] Output device set to: ' + outputDeviceId);
      }).catch(function(e) {
        console.warn('[AudioBridge] setSinkId failed, using default output:', e.message);
      });
    } else {
      sinkPromise = Promise.resolve();
    }

    return sinkPromise.then(function() {
      // Playback processor: drains queue → speaker
      _playbackProcessor = _audioCtx.createScriptProcessor(CHUNK_SIZE, 1, 1);
      _playbackProcessor.onaudioprocess = function(e) {
        var output = e.outputBuffer.getChannelData(0);
        if (_playbackQueue.length > 0) {
          var chunk = _playbackQueue.shift();
          var len = Math.min(chunk.length, output.length);
          for (var i = 0; i < len; i++) output[i] = chunk[i];
          for (var j = len; j < output.length; j++) output[j] = 0;
        } else {
          for (var k = 0; k < output.length; k++) output[k] = 0;
        }
      };
      _playbackProcessor.connect(_audioCtx.destination);
    });
  }

  // ── Setup Capture (input) — called after playback ──

  function _setupCapture(inputDeviceId) {
    var constraints = {
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: _mode === 'direct', // Only for direct mic, not BlackHole
        noiseSuppression: _mode === 'direct',
      }
    };
    if (inputDeviceId) {
      constraints.audio.deviceId = { exact: inputDeviceId };
    }

    return navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
      _captureStream = stream;
      _captureSource = _audioCtx.createMediaStreamSource(stream);

      // Capture processor: mic → PCM16 → base64 → callback
      _captureProcessor = _audioCtx.createScriptProcessor(CHUNK_SIZE, 1, 1);
      _captureSource.connect(_captureProcessor);
      _captureProcessor.connect(_audioCtx.destination);

      _captureProcessor.onaudioprocess = function(e) {
        if (!_running || !_onAudioChunk) return;
        var input = e.inputBuffer.getChannelData(0);
        // Convert float32 → PCM16
        var pcm16 = new Int16Array(input.length);
        for (var i = 0; i < input.length; i++) {
          var s = Math.max(-1, Math.min(1, input[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        // Encode to base64
        var bytes = new Uint8Array(pcm16.buffer);
        var binary = '';
        for (var j = 0; j < bytes.length; j++) {
          binary += String.fromCharCode(bytes[j]);
        }
        _onAudioChunk(btoa(binary));
      };
    });
  }

  // ── Receive AI Audio (base64 PCM16 → playback queue) ──

  function playAudio(base64Pcm) {
    if (!_running || !_playbackProcessor) return;
    try {
      var binary = atob(base64Pcm);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var pcm16 = new Int16Array(bytes.buffer);
      var float32 = new Float32Array(pcm16.length);
      for (var j = 0; j < pcm16.length; j++) {
        float32[j] = pcm16[j] / (pcm16[j] < 0 ? 0x8000 : 0x7FFF);
      }
      // Queue with overflow protection (drop oldest, keep latest — real-time audio)
      if (_playbackQueue.length >= MAX_PLAYBACK_QUEUE) {
        _playbackQueue.shift();
      }
      _playbackQueue.push(float32);
    } catch (e) {
      console.warn('[AudioBridge] playAudio decode error:', e.message);
    }
  }

  // ── Stop ──

  function stop() {
    if (!_running && !_starting) return; // Already stopped, don't double-stop
    _running = false;
    _starting = false;
    _onAudioChunk = null;
    _playbackQueue = [];

    if (_captureProcessor) { _captureProcessor.disconnect(); _captureProcessor = null; }
    if (_captureSource) { _captureSource.disconnect(); _captureSource = null; }
    if (_playbackProcessor) { _playbackProcessor.disconnect(); _playbackProcessor = null; }
    if (_captureStream) {
      _captureStream.getTracks().forEach(function(t) { t.stop(); });
      _captureStream = null;
    }
    if (_audioCtx) {
      _audioCtx.close().catch(function() {});
      _audioCtx = null;
    }
    _mode = null;
    _devices = { input: null, output: null };
    console.log('[AudioBridge] Stopped');
  }

  // ── Status ──

  function getStatus() {
    return {
      running: _running,
      mode: _mode,
      devices: _devices,
      playbackQueueSize: _playbackQueue.length,
      sampleRate: SAMPLE_RATE,
    };
  }

  // ── Public API ──
  return {
    start: start,
    stop: stop,
    playAudio: playAudio,
    getStatus: getStatus,
    enumerateAudioDevices: enumerateAudioDevices,
    findBlackHoleDevices: findBlackHoleDevices,
  };
})();
