const assert = require('node:assert/strict');
const test = require('node:test');

require('../public/clip-buffer');
const { RollingClipRecorder } = require('../public/clip-recorder');

test('mantém um único gravador contínuo e preserva segmentos entre clipes', async (context) => {
  const OriginalMediaRecorder = global.MediaRecorder;
  const instances = [];

  class FakeMediaRecorder {
    static isTypeSupported() { return true; }

    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      instances.push(this);
    }

    start() { this.state = 'recording'; }

    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['segmento'], { type: 'video/webm' }) });
      this.onstop();
    }
  }

  global.MediaRecorder = FakeMediaRecorder;
  context.after(() => { global.MediaRecorder = OriginalMediaRecorder; });

  const stream = {
    getVideoTracks: () => [{ readyState: 'live' }],
  };
  const recorder = new RollingClipRecorder(stream, { segmentMs: 60_000 });
  recorder.start();

  assert.equal(instances.length, 1);
  assert.equal(instances[0].options.videoBitsPerSecond, 6_000_000);

  const firstClip = await recorder.select(30);
  assert.equal(firstClip.segments.length, 1);
  assert.equal(instances.length, 2);

  const secondClip = await recorder.select(30);
  assert.equal(secondClip.segments.length, 2);
  assert.equal(instances.length, 3);

  recorder.stop();
});
