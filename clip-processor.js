const { spawn } = require('child_process');
const { mkdtemp, readFile, rm, writeFile } = require('fs/promises');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const ALLOWED_CLIP_DURATIONS = new Set([30, 60]);

function parseClipDuration(value) {
  const duration = Number(value);
  return ALLOWED_CLIP_DURATIONS.has(duration) ? duration : null;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';

    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg encerrou com código ${code}: ${stderr.trim()}`));
    });
  });
}

async function normalizeClip(inputBuffer, duration) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-clip-'));
  const inputPath = path.join(tempDirectory, 'input.webm');
  const outputPath = path.join(tempDirectory, 'output.mp4');

  try {
    await writeFile(inputPath, inputBuffer);

    // MediaRecorder mantém os timestamps da gravação original nos chunks.
    // O FFmpeg busca a partir do fim, decodifica desde um keyframe anterior e
    // recria timestamps iniciando em zero, produzindo um clipe reproduzível e
    // com duração limitada ao valor solicitado.
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-sseof', `-${duration}`,
      '-i', inputPath,
      '-t', String(duration),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setpts=PTS-STARTPTS',
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

module.exports = { normalizeClip, parseClipDuration };
