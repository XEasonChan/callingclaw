/**
 * CallingClaw — Playback AudioWorklet (Ring Buffer)
 *
 * Gapless audio playback via 10-second ring buffer.
 * Used in both Electron AudioBridge and Meet page audio injection.
 *
 * Protocol:
 *   port.postMessage(Float32Array) → write samples to ring buffer
 *   port.postMessage("clear")     → reset buffer (interrupt)
 *
 * Output: continuous audio from ring buffer; silence when drained.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(24000 * 10); // 10 second ring buffer @ 24kHz
    this._writePos = 0;
    this._readPos = 0;
    this.port.onmessage = (e) => {
      if (e.data === "clear") {
        this._writePos = 0;
        this._readPos = 0;
        return;
      }
      var samples = e.data;
      for (var i = 0; i < samples.length; i++) {
        this._buffer[this._writePos % this._buffer.length] = samples[i];
        this._writePos++;
      }
    };
  }
  process(inputs, outputs) {
    var output = outputs[0][0];
    if (!output) return true;
    for (var i = 0; i < output.length; i++) {
      if (this._readPos < this._writePos) {
        output[i] = this._buffer[this._readPos % this._buffer.length];
        this._readPos++;
      } else {
        output[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor('playback-processor', PlaybackProcessor);
