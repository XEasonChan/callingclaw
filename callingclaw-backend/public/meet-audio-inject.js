/**
 * CallingClaw — Meet Audio Injection Script
 *
 * Injected into Google Meet page via Playwright eval().
 * Replaces Meet's mic audio track with AI-generated audio from CallingClaw backend.
 *
 * Architecture:
 *   1. Wrap RTCPeerConnection constructor to capture references
 *   2. Set up AudioContext + ring buffer worklet + MediaStreamDestination
 *   3. Open WebSocket to CallingClaw backend for real-time AI audio
 *   4. After Meet joins, replaceTrack() on the audio sender
 *   5. Monitor loop re-injects if Meet renegotiates
 *
 * Data flow:
 *   Grok/OpenAI Realtime API → Backend WS → this script → ring buffer
 *     → MediaStreamDestination → replaceTrack → Meet PeerConnection
 *     → Other participants hear AI
 *
 * Loaded via: eval(fetch('http://localhost:4000/meet-audio-inject.js'))
 */

(function() {
  'use strict';

  // ── Config ──
  var BACKEND_WS_URL = 'ws://localhost:4000/ws/audio-bridge';
  var WORKLET_URL = 'http://localhost:4000/playback-worklet.js';
  var SAMPLE_RATE = 24000;
  var RECONNECT_DELAY_MS = 2000;
  var MONITOR_INTERVAL_MS = 3000;
  var FADE_SAMPLES = 24; // 1ms @ 24kHz

  // ── State ──
  var _peerConnections = [];
  var _audioCtx = null;
  var _playbackWorklet = null;
  var _destStream = null; // MediaStreamDestination
  var _aiTrack = null;    // The audio track we inject
  var _ws = null;
  var _wsReconnectTimer = null;
  var _monitorTimer = null;
  var _active = false;

  // ══════════════════════════════════════════════════════════════
  // Step 1: Wrap RTCPeerConnection to capture references
  // ══════════════════════════════════════════════════════════════

  var OrigPC = window.RTCPeerConnection;
  var OrigWebkitPC = window.webkitRTCPeerConnection;

  function WrappedPC() {
    var pc = new (Function.prototype.bind.apply(OrigPC, [null].concat(Array.prototype.slice.call(arguments))))();
    _peerConnections.push(pc);
    console.log('[CC-Inject] RTCPeerConnection created (' + _peerConnections.length + ' total)');

    // Listen for track additions so we know when to inject
    var origAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = function(track, stream) {
      var result = origAddTrack(track, stream);
      if (track.kind === 'audio') {
        console.log('[CC-Inject] Audio track added to PC — will replace after join');
      }
      return result;
    };

    return pc;
  }
  WrappedPC.prototype = OrigPC.prototype;
  Object.defineProperty(WrappedPC, 'name', { value: 'RTCPeerConnection' });

  window.RTCPeerConnection = WrappedPC;
  if (OrigWebkitPC) {
    window.webkitRTCPeerConnection = WrappedPC;
  }

  // ══════════════════════════════════════════════════════════════
  // Step 2: Set up AudioContext + Worklet + MediaStreamDestination
  // ══════════════════════════════════════════════════════════════

  async function setupAudio() {
    if (_audioCtx) return;

    _audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Resume if suspended (no user gesture in injected context)
    if (_audioCtx.state !== 'running') {
      await _audioCtx.resume().catch(function() {});
    }

    // Load ring buffer worklet from CallingClaw backend
    await _audioCtx.audioWorklet.addModule(WORKLET_URL);

    _playbackWorklet = new AudioWorkletNode(_audioCtx, 'playback-processor');

    // Create MediaStreamDestination — this produces a live MediaStream
    var dest = _audioCtx.createMediaStreamDestination();
    _playbackWorklet.connect(dest);
    _destStream = dest;
    _aiTrack = dest.stream.getAudioTracks()[0];

    console.log('[CC-Inject] Audio pipeline ready (24kHz, ring buffer, MediaStreamDestination)');
  }

  // ══════════════════════════════════════════════════════════════
  // Step 3: WebSocket client — receives AI audio from backend
  // ══════════════════════════════════════════════════════════════

  function connectWS() {
    if (_ws && _ws.readyState <= 1) return; // CONNECTING or OPEN

    try {
      _ws = new WebSocket(BACKEND_WS_URL);
    } catch (e) {
      console.warn('[CC-Inject] WS connect failed:', e.message);
      scheduleReconnect();
      return;
    }

    _ws.onopen = function() {
      console.log('[CC-Inject] WS connected to backend');
      if (_wsReconnectTimer) {
        clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
      }
    };

    _ws.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'audio_playback' && data.payload && data.payload.audio) {
          feedAudio(data.payload.audio);
        } else if (data.type === 'interrupt') {
          interruptPlayback();
        }
      } catch (err) {
        // Ignore parse errors
      }
    };

    _ws.onclose = function() {
      console.log('[CC-Inject] WS disconnected');
      scheduleReconnect();
    };

    _ws.onerror = function() {
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect() {
    if (!_active) return;
    if (_wsReconnectTimer) return;
    _wsReconnectTimer = setTimeout(function() {
      _wsReconnectTimer = null;
      if (_active) connectWS();
    }, RECONNECT_DELAY_MS);
  }

  // ── Audio decoding + feeding ──

  function feedAudio(base64Pcm) {
    if (!_playbackWorklet || !_audioCtx) return;
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

      // Micro fade-in/out to prevent DC offset clicks
      if (float32.length > FADE_SAMPLES * 2) {
        for (var f = 0; f < FADE_SAMPLES; f++) {
          var gain = f / FADE_SAMPLES;
          float32[f] *= gain;
          float32[float32.length - 1 - f] *= gain;
        }
      }

      // Feed to ring buffer worklet
      _playbackWorklet.port.postMessage(float32, [float32.buffer]);
    } catch (e) {
      console.warn('[CC-Inject] feedAudio error:', e.message);
    }
  }

  function interruptPlayback() {
    if (_playbackWorklet) {
      _playbackWorklet.port.postMessage('clear');
      console.log('[CC-Inject] Playback interrupted (buffer cleared)');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Step 4: replaceTrack — swap Meet's mic with our AI track
  // ══════════════════════════════════════════════════════════════

  function injectTrack() {
    if (!_aiTrack) {
      console.warn('[CC-Inject] No AI track available yet');
      return false;
    }

    var injected = false;
    for (var i = 0; i < _peerConnections.length; i++) {
      var pc = _peerConnections[i];
      if (pc.connectionState === 'closed') continue;

      var senders = pc.getSenders();
      for (var j = 0; j < senders.length; j++) {
        var sender = senders[j];
        if (sender.track && sender.track.kind === 'audio' && sender.track !== _aiTrack) {
          sender.replaceTrack(_aiTrack).then(function() {
            console.log('[CC-Inject] replaceTrack SUCCESS — AI audio now goes to Meet');
          }).catch(function(err) {
            console.warn('[CC-Inject] replaceTrack failed:', err.message);
          });
          injected = true;
        }
      }
    }

    if (!injected) {
      console.log('[CC-Inject] No audio sender found to replace (yet)');
    }
    return injected;
  }

  // ══════════════════════════════════════════════════════════════
  // Step 5: Monitor — re-inject if Meet renegotiates
  // ══════════════════════════════════════════════════════════════

  function startMonitor() {
    if (_monitorTimer) return;
    _monitorTimer = setInterval(function() {
      if (!_active || !_aiTrack) return;

      for (var i = 0; i < _peerConnections.length; i++) {
        var pc = _peerConnections[i];
        if (pc.connectionState === 'closed') continue;

        var senders = pc.getSenders();
        for (var j = 0; j < senders.length; j++) {
          var sender = senders[j];
          if (sender.track && sender.track.kind === 'audio' && sender.track !== _aiTrack) {
            console.log('[CC-Inject] Track replaced by Meet — re-injecting');
            sender.replaceTrack(_aiTrack).catch(function() {});
          }
        }
      }
    }, MONITOR_INTERVAL_MS);
  }

  // ══════════════════════════════════════════════════════════════
  // Public API — exposed on window.__ccAudioInject
  // ══════════════════════════════════════════════════════════════

  window.__ccAudioInject = {
    /** Initialize audio pipeline + WS connection. Call BEFORE clicking Join. */
    setup: async function() {
      _active = true;
      await setupAudio();
      connectWS();
      console.log('[CC-Inject] Setup complete — ready for replaceTrack after join');
    },

    /** Inject AI track into Meet. Call AFTER joining the meeting. */
    inject: function() {
      var ok = injectTrack();
      if (ok) startMonitor();
      return ok;
    },

    /** Get status for debugging */
    status: function() {
      return {
        active: _active,
        peerConnections: _peerConnections.length,
        audioCtxState: _audioCtx ? _audioCtx.state : 'none',
        wsState: _ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][_ws.readyState] : 'none',
        aiTrackState: _aiTrack ? _aiTrack.readyState : 'none',
        hasWorklet: !!_playbackWorklet,
      };
    },

    /** Cleanup everything */
    destroy: function() {
      _active = false;
      if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }
      if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
      if (_ws) { _ws.close(); _ws = null; }
      if (_playbackWorklet) { _playbackWorklet.disconnect(); _playbackWorklet = null; }
      if (_audioCtx) { _audioCtx.close().catch(function() {}); _audioCtx = null; }
      _destStream = null;
      _aiTrack = null;
      console.log('[CC-Inject] Destroyed');
    },
  };

  console.log('[CC-Inject] Script loaded — call __ccAudioInject.setup() then .inject()');
})();
