const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ffmpegPath = require('ffmpeg-static');
const { normalizeClip, parseClipDuration } = require('../clip-processor');

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code === 0) return resolve(stderr);
      reject(new Error(stderr));
    });
  });
}

async function mediaDuration(filePath) {
  const probe = await ffmpeg(['-hide_banner', '-i', filePath, '-f', 'null', '-']);
  const match = probe.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  assert.ok(match, 'FFmpeg deve informar a duração do arquivo de saída');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

test('aceita somente as durações expostas pela interface', () => {
  assert.equal(parseClipDuration('30'), 30);
  assert.equal(parseClipDuration(60), 60);
  assert.equal(parseClipDuration('31'), null);
  assert.equal(parseClipDuration(undefined), null);
});

test('recodifica e limita a duração do clipe', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-test-'));
  const sourcePath = path.join(directory, 'source.webm');
  const outputPath = path.join(directory, 'output.mp4');

  try {
    await ffmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '5', '-c:v', 'libvpx', '-c:a', 'libopus', sourcePath,
    ]);

    const normalized = await normalizeClip(await readFile(sourcePath), 2);
    await writeFile(outputPath, normalized);

    const duration = await mediaDuration(outputPath);
    assert.ok(duration >= 1.9 && duration <= 2.1, `duração obtida: ${duration}s`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserva um clipe menor quando ainda não há 30 segundos gravados', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-test-'));
  const sourcePath = path.join(directory, 'source.webm');
  const outputPath = path.join(directory, 'output.mp4');

  try {
    await ffmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-t', '3', '-c:v', 'libvpx', sourcePath,
    ]);

    const normalized = await normalizeClip(await readFile(sourcePath), 30);
    await writeFile(outputPath, normalized);
    const duration = await mediaDuration(outputPath);
    assert.ok(duration >= 2.9 && duration <= 3.1, `duração obtida: ${duration}s`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
