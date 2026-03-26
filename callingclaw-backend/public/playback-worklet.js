/**
 * CallingClaw — Playback AudioWorklet (Ring Buffer)
 *
 * Gapless audio playback via 1-second ring buffer.
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
    this._buffer = new Float32Array(24000 * 1); // 1 second ring buffer @ 24kHz
    this._writePos = 0;
    this._readPos = 0;
    this._underruns = 0;
    this.port.onmessage = (e) => {
      if (e.data === "clear") {
        this._writePos = 0;
        this._readPos = 0;
        return;
      }
      if (e.data === "stats") {
        this.port.postMessage({
          type: "stats",
          buffered: this._writePos - this._readPos,
          underruns: this._underruns,
        });
        return;
      }
      var samples = e.data;
      var bufLen = this._buffer.length;
      for (var i = 0; i < samples.length; i++) {
        this._buffer[this._writePos % bufLen] = samples[i];
        this._writePos++;
      }
      // Prevent unbounded counter growth — reset when both pointers are past buffer length
      if (this._readPos > bufLen && this._writePos > bufLen) {
        this._writePos -= bufLen;
        this._readPos -= bufLen;
      }
    };
  }
  process(inputs, outputs) {
    var output = outputs[0][0];
    if (!output) return true;
    var bufLen = this._buffer.length;
    for (var i = 0; i < output.length; i++) {
      if (this._readPos < this._writePos) {
        output[i] = this._buffer[this._readPos % bufLen];
        this._readPos++;
      } else {
        output[i] = 0;
        this._underruns++;
      }
    }
    return true;
  }
}
registerProcessor('playback-processor', PlaybackProcessor);
