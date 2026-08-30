const { spawn } = require('node:child_process');
const { copyFile, mkdtemp, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const ffmpegPath = require('ffmpeg-static');
const { normalizeClip } = require('../clip-processor');

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr));
    });
  });
}

async function createSegment(filePath, duration) {
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-t', String(duration),
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '6M',
    '-c:a', 'libopus', '-b:a', '128k',
    filePath,
  ]);
}

async function runFullTranscodeReference(inputPaths, outputPath) {
  const concatPath = `${outputPath}.concat.txt`;
  await writeFile(
    concatPath,
    inputPaths.map((filePath) => `file '${filePath.replace(/\\/g, '/')}'`).join('\n'),
    'utf8'
  );
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-ss', '3', '-t', '60',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setpts=PTS-STARTPTS",
    '-af', 'asetpts=PTS-STARTPTS',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-maxrate', '8M', '-bufsize', '16M', '-threads', '1',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    outputPath,
  ]);
}

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-benchmark-'));
  const completeTemplate = path.join(directory, 'complete-template.webm');
  const partialSegment = path.join(directory, 'segment-12.webm');

  try {
    await Promise.all([
      createSegment(completeTemplate, 5),
      createSegment(partialSegment, 3),
    ]);

    const completeSegments = [];
    for (let index = 0; index < 12; index += 1) {
      const segmentPath = path.join(directory, `segment-${String(index).padStart(2, '0')}.webm`);
      await copyFile(completeTemplate, segmentPath);
      completeSegments.push(segmentPath);
    }

    const inputPaths = [...completeSegments, partialSegment];
    const inputBytes = (await Promise.all(inputPaths.map((filePath) => stat(filePath))))
      .reduce((total, file) => total + file.size, 0);
    const startedAt = performance.now();
    const outputPath = await normalizeClip(inputPaths, 60, 3);
    const processingDurationMs = performance.now() - startedAt;
    const outputBytes = (await stat(outputPath)).size;
    const referencePath = path.join(directory, 'full-transcode-reference.mp4');
    const referenceStartedAt = performance.now();
    await runFullTranscodeReference(inputPaths, referencePath);
    const referenceDurationMs = performance.now() - referenceStartedAt;

    console.log(JSON.stringify({
      resolution: '1280x720',
      requestedDurationSeconds: 60,
      segments: inputPaths.length,
      inputMiB: Number((inputBytes / 1024 / 1024).toFixed(2)),
      outputMiB: Number((outputBytes / 1024 / 1024).toFixed(2)),
      processingDurationMs: Math.round(processingDurationMs),
      realtimeRatio: Number((processingDurationMs / 60_000).toFixed(3)),
      fullTranscodeReferenceMs: Math.round(referenceDurationMs),
      speedup: Number((referenceDurationMs / processingDurationMs).toFixed(2)),
    }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
