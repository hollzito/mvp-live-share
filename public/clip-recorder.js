(function exposeRollingClipRecorder(globalScope) {
  const DEFAULT_SEGMENT_MS = 5000;
  const DEFAULT_BUFFER_MS = 75_000;
  const DEFAULT_VIDEO_BITS_PER_SECOND = 6_000_000;
  const DEFAULT_AUDIO_BITS_PER_SECOND = 128_000;

  class RollingClipRecorder {
    constructor(stream, options = {}) {
      this.stream = stream;
      this.segmentMs = options.segmentMs || DEFAULT_SEGMENT_MS;
      this.maxBufferMs = options.maxBufferMs || DEFAULT_BUFFER_MS;
      this.videoBitsPerSecond = options.videoBitsPerSecond || DEFAULT_VIDEO_BITS_PER_SECOND;
      this.audioBitsPerSecond = options.audioBitsPerSecond || DEFAULT_AUDIO_BITS_PER_SECOND;
      this.segments = [];
      this.recorder = null;
      this.currentSegmentDone = Promise.resolve();
      this.stopped = false;
    }

    hasLiveVideoTrack() {
      return this.stream.getVideoTracks().some((track) => track.readyState === 'live');
    }

    start() {
      if (!this.recorder && !this.stopped) this.startSegment();
    }

    stop() {
      this.stopped = true;
      if (this.recorder?.state === 'recording') this.recorder.stop();
    }

    pruneBuffer() {
      let bufferedDuration = this.segments.reduce((total, segment) => total + segment.durationMs, 0);
      while (this.segments.length > 1
        && bufferedDuration - this.segments[0].durationMs >= this.maxBufferMs) {
        bufferedDuration -= this.segments[0].durationMs;
        this.segments.shift();
      }
    }

    startSegment() {
      if (this.stopped || !this.hasLiveVideoTrack()) return;

      const chunks = [];
      const startedAt = performance.now();
      const supportedType = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp8',
        'video/webm',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      let segmentRecorder;

      const recorderOptions = {
        videoBitsPerSecond: this.videoBitsPerSecond,
        audioBitsPerSecond: this.audioBitsPerSecond,
      };
      if (supportedType) recorderOptions.mimeType = supportedType;

      try {
        segmentRecorder = new MediaRecorder(this.stream, recorderOptions);
      } catch (error) {
        console.warn('Gravação de clipes não suportada neste navegador:', error);
        this.recorder = null;
        return;
      }

      let resolveSegment;
      const segmentDone = new Promise((resolve) => { resolveSegment = resolve; });
      this.recorder = segmentRecorder;
      this.currentSegmentDone = segmentDone;

      segmentRecorder.ondataavailable = (event) => {
        if (event.data?.size > 0) chunks.push(event.data);
      };

      let segmentTimer;
      segmentRecorder.onstop = () => {
        clearTimeout(segmentTimer);
        const durationMs = Math.max(1, performance.now() - startedAt);
        if (chunks.length > 0) {
          this.segments.push({
            blob: new Blob(chunks, { type: segmentRecorder.mimeType || 'video/webm' }),
            durationMs,
          });
          this.pruneBuffer();
        }

        if (this.recorder === segmentRecorder) this.recorder = null;
        resolveSegment();
        if (!this.stopped && this.hasLiveVideoTrack()) this.startSegment();
      };

      segmentRecorder.onerror = (event) => {
        console.warn('Erro durante a gravação do segmento:', event.error || event);
      };

      segmentRecorder.start();
      segmentTimer = setTimeout(() => {
        if (segmentRecorder.state === 'recording') segmentRecorder.stop();
      }, this.segmentMs);
    }

    async finalizeCurrentSegment() {
      if (!this.recorder) return;
      const segmentRecorder = this.recorder;
      const segmentDone = this.currentSegmentDone;
      if (segmentRecorder.state === 'recording') segmentRecorder.stop();
      await segmentDone;
    }

    async select(seconds) {
      await this.finalizeCurrentSegment();
      return globalScope.selectClipSegments(this.segments, seconds * 1000);
    }
  }

  globalScope.RollingClipRecorder = RollingClipRecorder;
  if (typeof module !== 'undefined') module.exports = { RollingClipRecorder };
})(typeof window !== 'undefined' ? window : globalThis);
