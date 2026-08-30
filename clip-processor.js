const { spawn } = require('child_process');
const { unlink, writeFile } = require('fs/promises');
const ffmpegPath = require('ffmpeg-static');

const ALLOWED_CLIP_DURATIONS = new Set([30, 60]);

function parseClipDuration(value) {
  const duration = Number(value);
  return ALLOWED_CLIP_DURATIONS.has(duration) ? duration : null;
}

function runFfmpeg(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill('SIGKILL');
    }, timeoutMs);

    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    process.on('error', (error) => finish(error));
    process.on('close', (code) => {
      if (timedOut) return finish(new Error(`FFmpeg excedeu o limite de ${timeoutMs / 1000} segundos.`));
      if (code === 0) return finish();
      finish(new Error(`FFmpeg encerrou com código ${code}: ${stderr.trim()}`));
    });
  });
}

async function normalizeClip(inputPaths, duration, startOffsetSeconds = 0) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('Nenhum segmento de vídeo recebido.');
  }

  const outputPath = `${inputPaths[0]}.mp4`;
  const concatPath = `${inputPaths[0]}.concat.txt`;
  const concatContent = inputPaths
    .map((inputPath) => `file '${inputPath.replace(/\\/g, '/')}'`)
    .join('\n');

  try {
    await writeFile(concatPath, concatContent, 'utf8');

    // Cada entrada é um WebM completo iniciado pelo próprio MediaRecorder.
    // O demuxer concat cria uma linha do tempo contínua; o offset calculado no
    // navegador remove apenas a sobra do primeiro segmento selecionado.
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-ss', String(startOffsetSeconds),
      '-t', String(duration),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setpts=PTS-STARTPTS",
      '-af', 'asetpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-maxrate', '8M',
      '-bufsize', '16M',
      '-threads', '1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ]);

    return outputPath;
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  } finally {
    await unlink(concatPath).catch(() => {});
  }
}

module.exports = { normalizeClip, parseClipDuration };
