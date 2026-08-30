const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
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

function samplePixel(filePath, timestamp) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(timestamp), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    process.stdout.on('data', (chunk) => chunks.push(chunk));
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr));
      const pixel = Buffer.concat(chunks);
      resolve({ red: pixel[0], green: pixel[1], blue: pixel[2] });
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
  const outputPath = `${sourcePath}.clip.webm`;

  try {
    await ffmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '5', '-c:v', 'libvpx', '-c:a', 'libopus', sourcePath,
    ]);

    const normalizedPath = await normalizeClip([sourcePath], 2, 3);
    assert.equal(normalizedPath, outputPath);

    const duration = await mediaDuration(outputPath);
    assert.ok(duration >= 1.9 && duration <= 2.1, `duração obtida: ${duration}s`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserva um clipe menor quando ainda não há 30 segundos gravados', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-test-'));
  const sourcePath = path.join(directory, 'source.webm');
  const outputPath = `${sourcePath}.clip.webm`;

  try {
    await ffmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-t', '3', '-c:v', 'libvpx', sourcePath,
    ]);

    const normalizedPath = await normalizeClip([sourcePath], 30);
    assert.equal(normalizedPath, outputPath);
    const duration = await mediaDuration(outputPath);
    assert.ok(duration >= 2.9 && duration <= 3.1, `duração obtida: ${duration}s`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concatena segmentos completos e recorta exatamente a janela final', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-segments-test-'));
  const segmentPaths = [0, 1, 2].map((index) => path.join(directory, `segment-${index}.webm`));

  try {
    for (let index = 0; index < segmentPaths.length; index += 1) {
      await ffmpeg([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${['red', 'green', 'blue'][index]}:size=320x180:rate=30`,
        '-f', 'lavfi', '-i', `sine=frequency=${500 + (index * 250)}:sample_rate=48000`,
        '-t', '4', '-c:v', 'libvpx', '-c:a', 'libopus', segmentPaths[index],
      ]);
    }

    // Os dois segmentos selecionados totalizam 8s. O offset de 3s recodifica
    // somente o fim do primeiro e copia diretamente o segundo.
    const normalizedPath = await normalizeClip(segmentPaths.slice(1), 5, 3);
    const duration = await mediaDuration(normalizedPath);
    assert.ok(duration >= 4.9 && duration <= 5.1, `duração obtida: ${duration}s`);
    const mediaInfo = await ffmpeg(['-hide_banner', '-i', normalizedPath, '-f', 'null', '-']);
    assert.match(mediaInfo, /Video: vp8/, 'os segmentos devem permanecer em VP8 sem recodificação integral');

    const beginning = await samplePixel(normalizedPath, 0.2);
    const ending = await samplePixel(normalizedPath, 2);
    assert.ok(beginning.green > beginning.red && beginning.green > beginning.blue,
      `o clipe deveria começar no segmento verde: ${JSON.stringify(beginning)}`);
    assert.ok(ending.blue > ending.red && ending.blue > ending.green,
      `o clipe deveria terminar no segmento azul: ${JSON.stringify(ending)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
