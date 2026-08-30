const { spawn } = require('child_process');
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

async function normalizeClip(inputPath, duration) {
  const outputPath = `${inputPath}.mp4`;

  // MediaRecorder mantém os timestamps da gravação original nos chunks.
  // O FFmpeg busca a partir do fim, decodifica desde um keyframe anterior e
  // recria timestamps iniciando em zero, produzindo um clipe reproduzível e
  // com duração limitada ao valor solicitado. Um único thread reduz os picos
  // de CPU e memória nas instâncias menores do Render.
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
    '-preset', 'ultrafast',
    '-crf', '26',
    '-maxrate', '4M',
    '-bufsize', '8M',
    '-threads', '1',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ]);

  return outputPath;
}

module.exports = { normalizeClip, parseClipDuration };
