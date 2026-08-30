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

async function normalizeClip(inputPaths, duration, startOffsetSeconds = 0, segmentDurationsSeconds = []) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('Nenhum segmento de vídeo recebido.');
  }
  if (!Array.isArray(segmentDurationsSeconds)
    || segmentDurationsSeconds.length !== inputPaths.length
    || segmentDurationsSeconds.some((value) => !Number.isFinite(value) || value <= 0 || value > 120)) {
    throw new Error('Durações dos segmentos inválidas.');
  }
  if (!Number.isFinite(startOffsetSeconds)
    || startOffsetSeconds < 0
    || startOffsetSeconds >= segmentDurationsSeconds[0]) {
    throw new Error('Offset inicial do clipe inválido.');
  }

  const outputPath = `${inputPaths[0]}.clip.webm`;
  const trimmedPath = `${inputPaths[0]}.trimmed.webm`;
  const concatPath = `${inputPaths[0]}.concat.txt`;

  try {
    let concatInputs = inputPaths;
    let concatDurations = segmentDurationsSeconds;

    // O primeiro segmento pode conter alguns segundos anteriores à janela
    // solicitada. Somente esse pequeno trecho precisa ser recodificado; todos
    // os demais segmentos já são WebM/VP8 completos e podem ser copiados.
    if (startOffsetSeconds > 0) {
      await runFfmpeg([
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', String(startOffsetSeconds),
        '-i', inputPaths[0],
        '-t', String(Math.min(duration, segmentDurationsSeconds[0] - startOffsetSeconds)),
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', 'fps=30,setpts=PTS-STARTPTS',
        '-af', 'asetpts=PTS-STARTPTS',
        '-c:v', 'libvpx',
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-b:v', '6M',
        '-maxrate', '6M',
        '-bufsize', '12M',
        '-threads', '1',
        '-c:a', 'libopus',
        '-b:a', '128k',
        trimmedPath,
      ]);
      concatInputs = [trimmedPath, ...inputPaths.slice(1)];
      concatDurations = [
        segmentDurationsSeconds[0] - startOffsetSeconds,
        ...segmentDurationsSeconds.slice(1),
      ];
    }

    const concatContent = concatInputs
      .map((inputPath, index) => [
        `file '${inputPath.replace(/\\/g, '/')}'`,
        // WebMs do MediaRecorder podem não informar duração ou informar um
        // valor incorreto. Sem esta diretiva, os timestamps seguintes se
        // sobrepõem e seis segmentos de 5s podem virar um clipe de apenas 10s.
        `duration ${concatDurations[index].toFixed(6)}`,
      ].join('\n'))
      .join('\n');
    await writeFile(concatPath, concatContent, 'utf8');
    const availableDuration = concatDurations.reduce((total, value) => total + value, 0);
    const outputDuration = Math.min(duration, availableDuration);

    // A remontagem usa stream copy: não há uma segunda perda de qualidade nem
    // recodificação proporcional aos 30/60 segundos do clipe.
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-t', String(outputDuration),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outputPath,
    ]);

    return outputPath;
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  } finally {
    await unlink(concatPath).catch(() => {});
    await unlink(trimmedPath).catch(() => {});
  }
}

module.exports = { normalizeClip, parseClipDuration };
