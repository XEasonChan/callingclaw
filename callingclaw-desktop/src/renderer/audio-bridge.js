// ═══════════════════════════════════════════════════════════════
// AudioBridge v2 — Electron audio capture/playback via Web Audio API
// ═══════════════════════════════════════════════════════════════
//
// Architecture (both modes share the same code):
//
//   Talk Locally (direct):
//     Real mic → AudioWorklet → PCM16 24kHz → base64 → WS → Grok/OpenAI
//     AI audio → base64 → PCM16 → BufferSource(scheduled) → Speaker
//
//   Meet Bridge:
//     BlackHole 2ch → AudioWorklet → PCM16 24kHz → base64 → WS → Grok/OpenAI
//     AI audio → base64 → PCM16 → BufferSource(scheduled) → BlackHole 16ch → Meet mic
//
// Key improvements over v1:
//   - AudioWorklet (audio thread) replaces ScriptProcessor (main thread, deprecated)
//   - Scheduled BufferSource playback eliminates chunk-boundary pops/clicks
//   - Interruption support: interruptPlayback() stops all queued sources
//   - Chunked base64 encoding avoids stack overflow on large buffers
//   - Capture failure doesn't kill playback
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
  var _running = false;
  var _starting = false;
  var _mode = null;            // 'direct' | 'meet_bridge'
  var _onAudioChunk = null;    // callback(base64Pcm)
  var _devices = { input: null, output: null };

  // Scheduled playback state
  var _nextPlayTime = 0;
  var _queuedSources = [];

  // ── AudioWorklet code (inlined as Blob URL to avoid file:// issues in Electron) ──
  var WORKLET_CODE = [
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

  function start(mode, onAudioChunk) {
    if (_starting) { console.warn('[AudioBridge] start() already in progress'); return Promise.resolve({ ok: false, reason: 'already_starting' }); }
    if (_running) { stop(); }
    _starting = true;
    _mode = mode || 'direct';
    _onAudioChunk = onAudioChunk;
    _nextPlayTime = 0;
    _queuedSources = [];

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
        ', playback: ' + (_audioCtx ? _audioCtx.sampleRate + 'Hz BufferSource' : 'N/A') + ')');
      return { ok: true, mode: _mode };
    }).catch(function(err) {
      _starting = false;
      throw err;
    });
  }

  // ── Setup Playback (BufferSource scheduled) — MUST be called first ──

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

    return sinkPromise.then(function() {
      console.log('[AudioBridge] Playback ready (BufferSource, ' + _audioCtx.state + ')');
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
    var blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    var workletUrl = URL.createObjectURL(blob);

    return _captureCtx.resume().then(function() {
      return _captureCtx.audioWorklet.addModule(workletUrl);
    }).then(function() {
      URL.revokeObjectURL(workletUrl);
      return navigator.mediaDevices.getUserMedia(constraints);
    }).then(function(stream) {
      _captureStream = stream;
      _captureSource = _captureCtx.createMediaStreamSource(stream);

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

      console.log('[AudioBridge] Capture ready (AudioWorklet, ' + captureRate + 'Hz → ' + SAMPLE_RATE + 'Hz)');
    });
  }

  // ── Receive AI Audio (BufferSource scheduled playback — no pops/clicks) ──

  function playAudio(base64Pcm) {
    if (!_running || !_audioCtx) return;
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

      // Schedule on AudioContext timeline for gapless playback
      var buffer = _audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      var source = _audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(_audioCtx.destination);

      var now = _audioCtx.currentTime;
      // Only reset if severely behind (>2s = new response). Small gaps between
      // sentences (200-500ms) should NOT reset — let audio schedule naturally
      // to avoid the "next sentence pushes previous" artifact.
      if (_nextPlayTime < now - 2.0) {
        _nextPlayTime = now + 0.15; // new response: 150ms initial buffer
      } else if (_nextPlayTime < now) {
        _nextPlayTime = now + 0.02; // small underrun: tiny gap, no overlap
      }

      source.start(_nextPlayTime);
      _nextPlayTime += float32.length / SAMPLE_RATE;

      _queuedSources.push(source);
      source.onended = function() {
        var idx = _queuedSources.indexOf(source);
        if (idx !== -1) _queuedSources.splice(idx, 1);
      };
    } catch (e) {
      console.warn('[AudioBridge] playAudio error:', e.message);
    }
  }

  // ── Interrupt: stop all queued audio + reset timeline ──

  function interruptPlayback() {
    for (var i = 0; i < _queuedSources.length; i++) {
      try { _queuedSources[i].stop(); } catch (e) {}
    }
    _queuedSources = [];
    _nextPlayTime = 0;
  }

  // ── Stop ──

  function stop() {
    if (!_running && !_starting) return;
    _running = false;
    _starting = false;
    _onAudioChunk = null;

    interruptPlayback();

    if (_workletNode) { _workletNode.disconnect(); _workletNode = null; }
    if (_captureSource) { _captureSource.disconnect(); _captureSource = null; }
    if (_captureStream) {
      _captureStream.getTracks().forEach(function(t) { t.stop(); });
      _captureStream = null;
    }
    if (_captureCtx) { _captureCtx.close().catch(function() {}); _captureCtx = null; }
    if (_audioCtx) { _audioCtx.close().catch(function() {}); _audioCtx = null; }
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
      queuedSources: _queuedSources.length,
      sampleRate: SAMPLE_RATE,
      audioContextState: _audioCtx ? _audioCtx.state : null,
      captureContextState: _captureCtx ? _captureCtx.state : null,
    };
  }

  // ── Public API ──
  return {
    start: start,
    stop: stop,
    playAudio: playAudio,
    interruptPlayback: interruptPlayback,
    getStatus: getStatus,
    enumerateAudioDevices: enumerateAudioDevices,
    findBlackHoleDevices: findBlackHoleDevices,
  };
})();
