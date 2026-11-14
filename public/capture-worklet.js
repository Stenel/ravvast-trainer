/* global AudioWorkletProcessor, registerProcessor, currentFrame */
// Передаёт сэмплы с микрофона в основной поток пачками по 512 с номером первого сэмпла.
const CHUNK = 512;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
    this.start = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.start = currentFrame + i;
      this.buf[this.n++] = ch[i];
      if (this.n === CHUNK) {
        this.port.postMessage({ samples: this.buf, frame: this.start }, [this.buf.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
