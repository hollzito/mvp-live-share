require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { unlink } = require('fs/promises');
const { performance } = require('perf_hooks');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const fetch = require('node-fetch');
const { normalizeClip, parseClipDuration } = require('./clip-processor');
const { parseSignalMessage } = require('./signaling');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const clipStorage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (req, file, callback) => callback(null, `${randomUUID()}.webm`),
});
const upload = multer({
  storage: clipStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 20, fields: 3, parts: 24 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype === 'video/webm') return callback(null, true);
    const error = new Error('Formato de vídeo inválido. Envie um arquivo WebM.');
    error.statusCode = 415;
    callback(error);
  },
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, 30_000);
heartbeatInterval.unref();
wss.on('close', () => clearInterval(heartbeatInterval));

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { code: { broadcaster: ws, viewers: Map(id -> ws) } }
const rooms = new Map();
const MAX_CONCURRENT_CLIPS = 1;
const MAX_CLIP_SEGMENTS = 20;
const MAX_CLIP_UPLOAD_BYTES = 100 * 1024 * 1024;
const CLIP_REQUEST_TIMEOUT_MS = 30_000;
const CLIPS_CACHE_TTL_MS = 30_000;
let activeClipProcesses = 0;
let clipsCache = null;
let clipsRefreshPromise = null;
const clipRequests = new Map();

// Manda o link do clipe pro canal do Discord configurado (se houver webhook definido)
async function notifyDiscord(clipUrl, code) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        content: `🎬 Novo clipe salvo — sala **${code}**\n${clipUrl}`,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!response.ok) console.warn(`Discord recusou a notificação (HTTP ${response.status}).`);
  } catch (err) {
    console.error('Erro ao notificar o Discord:', err);
  } finally {
    clearTimeout(timeout);
  }
}


function generateCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ---- Clipes ----

function admitClipUpload(req, res, next) {
  const requestId = req.get('X-Clip-Request');
  const clipRequest = requestId && clipRequests.get(requestId);

  if (!clipRequest || clipRequest.status !== 'pending') {
    return res.status(403).json({ error: 'Solicitação de clipe inválida ou expirada.' });
  }
  if (activeClipProcesses >= MAX_CONCURRENT_CLIPS) {
    res.set('Retry-After', '10');
    return res.status(503).json({ error: 'O servidor já está processando outro clipe.' });
  }

  clearTimeout(clipRequest.timeout);
  clipRequest.status = 'uploading';
  req.clipRequest = clipRequest;
  activeClipProcesses += 1;
  next();
}

function receiveClip(req, res, next) {
  upload.array('videos', MAX_CLIP_SEGMENTS)(req, res, async (error) => {
    if (!error) return next();

    // O Multer pode já ter gravado alguns segmentos antes de rejeitar uma
    // requisição. Eles também precisam ser removidos quando a rota não avança.
    await removeTemporaryFiles((req.files || []).map((file) => file.path));

    if (error instanceof multer.MulterError) {
      console.warn(`Upload de clipe rejeitado pelo Multer (${error.code}).`);
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Um segmento do clipe ultrapassou o limite de 20 MB.'
        : 'Upload de clipe inválido.';
      finishClipRequest(req, { type: 'clip-error', message });
      return res.status(status).json({ error: message });
    }

    const message = error.message || 'Upload de clipe inválido.';
    finishClipRequest(req, { type: 'clip-error', message });
    res.status(error.statusCode || 400).json({ error: message });
  });
}

function finishClipRequest(req, viewerMessage) {
  if (!req.clipRequest || req.clipSlotReleased) return;
  req.clipSlotReleased = true;
  activeClipProcesses = Math.max(0, activeClipProcesses - 1);

  const clipRequest = clipRequests.get(req.clipRequest.id);
  if (!clipRequest) return;
  clearTimeout(clipRequest.timeout);
  clipRequests.delete(clipRequest.id);
  if (viewerMessage) send(clipRequest.viewer, { ...viewerMessage, requestId: clipRequest.id });
}

function rejectPendingClipRequest(requestId, message) {
  const clipRequest = clipRequests.get(requestId);
  if (!clipRequest || clipRequest.status !== 'pending') return;
  clearTimeout(clipRequest.timeout);
  clipRequests.delete(requestId);
  send(clipRequest.viewer, { type: 'clip-error', requestId, message });
}

async function removeTemporaryFiles(paths) {
  await Promise.allSettled(paths.filter(Boolean).map((filePath) => unlink(filePath)));
}

// Recebe os segmentos autorizados do transmissor e envia o clipe ao Cloudinary.
app.post('/api/clips', admitClipUpload, receiveClip, async (req, res) => {
  const temporaryFiles = (req.files || []).map((file) => file.path);
  const startedAt = performance.now();
  let viewerMessage = { type: 'clip-error', message: 'Falha ao salvar o clipe.' };

  try {
    if (!req.files || req.files.length === 0) {
      viewerMessage.message = 'Nenhum segmento de vídeo enviado.';
      return res.status(400).json({ error: viewerMessage.message });
    }

    const { code, duration } = req.clipRequest;
    const startOffsetMs = Number(req.body.startOffsetMs);
    const totalUploadBytes = req.files.reduce((total, file) => total + file.size, 0);

    if (!Number.isFinite(startOffsetMs) || startOffsetMs < 0 || startOffsetMs > 10_000) {
      viewerMessage.message = 'Offset inicial do clipe inválido.';
      return res.status(400).json({ error: viewerMessage.message });
    }
    if (totalUploadBytes > MAX_CLIP_UPLOAD_BYTES) {
      viewerMessage.message = 'O conjunto de segmentos ultrapassou o limite de 100 MB.';
      return res.status(413).json({ error: viewerMessage.message });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      viewerMessage.message = 'Cloudinary não configurado no servidor.';
      return res.status(500).json({ error: viewerMessage.message });
    }

    const ffmpegStartedAt = performance.now();
    const normalizedClipPath = await normalizeClip(
      req.files.map((file) => file.path),
      duration,
      startOffsetMs / 1000
    );
    const ffmpegDurationMs = performance.now() - ffmpegStartedAt;
    temporaryFiles.push(normalizedClipPath);
    const cloudinaryStartedAt = performance.now();
    const result = await cloudinary.uploader.upload(normalizedClipPath, {
      resource_type: 'video',
      folder: 'clips',
      tags: ['clipe', code],
      format: 'mp4',
    });
    const cloudinaryDurationMs = performance.now() - cloudinaryStartedAt;

    res.json({ url: result.secure_url, id: result.public_id, createdAt: result.created_at, code });
    viewerMessage = { type: 'clip-result', url: result.secure_url, code };
    clipsCache = null;

    console.info(JSON.stringify({
      event: 'clip_processed',
      code,
      duration,
      segments: req.files.length,
      uploadBytes: totalUploadBytes,
      ffmpegDurationMs: Math.round(ffmpegDurationMs),
      cloudinaryDurationMs: Math.round(cloudinaryDurationMs),
      totalDurationMs: Math.round(performance.now() - startedAt),
    }));

    notifyDiscord(result.secure_url, code);
  } catch (err) {
    console.error('Erro ao enviar clipe para o Cloudinary:', err);
    res.status(500).json({ error: 'Falha ao salvar o clipe.' });
  } finally {
    finishClipRequest(req, viewerMessage);
    await removeTemporaryFiles(temporaryFiles);
  }
});

async function getCachedClips() {
  const now = Date.now();
  if (clipsCache && now - clipsCache.createdAt < CLIPS_CACHE_TTL_MS) return clipsCache.clips;

  if (!clipsRefreshPromise) {
    clipsRefreshPromise = (async () => {
      const result = await cloudinary.api.resources_by_tag('clipe', {
        resource_type: 'video',
        max_results: 50,
        context: true,
      });

      clipsCache = {
        createdAt: Date.now(),
        clips: (result.resources || [])
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((r) => ({
            url: r.secure_url,
            code: (r.tags || []).find((t) => t !== 'clipe') || '',
            createdAt: r.created_at,
          })),
      };
      return clipsCache.clips;
    })().finally(() => { clipsRefreshPromise = null; });
  }

  return clipsRefreshPromise;
}

// Lista os clipes salvos, mais recentes primeiro
app.get('/api/clips', async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.json({ clips: [] });
  }

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 50
    ? requestedLimit
    : 50;
  res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');

  try {
    const clips = await getCachedClips();
    res.json({ clips: clips.slice(0, limit) });
  } catch (err) {
    console.error('Erro ao listar clipes:', err);
    res.status(500).json({ error: 'Falha ao carregar clipes.' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    activeClipProcesses,
    pendingClipRequests: [...clipRequests.values()].filter((request) => request.status === 'pending').length,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ---- Sinalização WebRTC ----

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 10);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const { message: msg, error } = parseSignalMessage(raw);
    if (error) {
      send(ws, { type: 'error', message: error });
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        if (ws.role) {
          send(ws, { type: 'error', message: 'Esta conexão já pertence a uma sala.' });
          return;
        }
        const code = generateCode();
        ws.role = 'broadcaster';
        ws.code = code;
        rooms.set(code, { broadcaster: ws, viewers: new Map() });
        send(ws, { type: 'room-created', code });
        break;
      }

      case 'join-room': {
        if (ws.role) {
          send(ws, { type: 'error', message: 'Esta conexão já pertence a uma sala.' });
          return;
        }
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{4}$/.test(code)) {
          send(ws, { type: 'error', message: 'Código inválido.' });
          return;
        }
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: 'Código não encontrado.' });
          return;
        }
        ws.role = 'viewer';
        ws.code = code;
        room.viewers.set(ws.id, ws);
        send(ws, { type: 'joined', viewerId: ws.id });
        send(room.broadcaster, { type: 'viewer-joined', viewerId: ws.id });
        break;
      }

      case 'offer': {
        if (ws.role !== 'broadcaster' || typeof msg.target !== 'string' || !msg.sdp) return;
        const room = rooms.get(ws.code);
        if (!room) return;
        const viewer = room.viewers.get(msg.target);
        send(viewer, { type: 'offer', sdp: msg.sdp, from: ws.id });
        break;
      }

      case 'answer': {
        if (ws.role !== 'viewer' || !msg.sdp) return;
        const room = rooms.get(ws.code);
        if (!room) return;
        send(room.broadcaster, { type: 'answer', sdp: msg.sdp, from: ws.id });
        break;
      }

      case 'ice-candidate': {
        if (!ws.role || !msg.candidate) return;
        const room = rooms.get(ws.code);
        if (!room) return;
        if (ws.role === 'broadcaster') {
          const viewer = room.viewers.get(msg.target);
          send(viewer, { type: 'ice-candidate', candidate: msg.candidate, from: ws.id });
        } else {
          send(room.broadcaster, { type: 'ice-candidate', candidate: msg.candidate, from: ws.id });
        }
        break;
      }

      case 'clip-request': {
        if (ws.role !== 'viewer') return;
        const duration = parseClipDuration(msg.duration);
        const room = rooms.get(ws.code);
        if (!duration || !room || room.broadcaster.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'clip-error', message: 'Não foi possível solicitar este clipe.' });
          return;
        }
        if (clipRequests.size >= MAX_CONCURRENT_CLIPS) {
          send(ws, { type: 'clip-error', message: 'Outro clipe já está sendo processado. Tente novamente em alguns segundos.' });
          return;
        }

        const requestId = randomUUID();
        const clipRequest = {
          id: requestId,
          code: ws.code,
          duration,
          viewer: ws,
          broadcaster: room.broadcaster,
          status: 'pending',
        };
        clipRequest.timeout = setTimeout(() => {
          rejectPendingClipRequest(requestId, 'O transmissor não iniciou o clipe a tempo.');
        }, CLIP_REQUEST_TIMEOUT_MS);
        clipRequests.set(requestId, clipRequest);

        send(ws, { type: 'clip-accepted', requestId });
        send(room.broadcaster, { type: 'clip-request', requestId, duration });
        break;
      }

      case 'clip-upload-failed': {
        if (ws.role !== 'broadcaster' || typeof msg.requestId !== 'string') return;
        const clipRequest = clipRequests.get(msg.requestId);
        if (!clipRequest || clipRequest.broadcaster !== ws) return;

        if (clipRequest.status === 'pending') {
          rejectPendingClipRequest(msg.requestId, 'O transmissor não conseguiu preparar o clipe.');
        }
        break;
      }
    }
  });

  ws.on('error', (error) => {
    console.warn(`Erro no WebSocket ${ws.id}:`, error.message);
  });

  ws.on('close', () => {
    if (ws.role === 'broadcaster' && ws.code) {
      const room = rooms.get(ws.code);
      if (room) {
        room.viewers.forEach((v) => send(v, { type: 'broadcast-ended' }));
        rooms.delete(ws.code);
      }
      for (const [requestId, clipRequest] of clipRequests) {
        if (clipRequest.broadcaster === ws && clipRequest.status === 'pending') {
          rejectPendingClipRequest(requestId, 'A transmissão terminou antes da criação do clipe.');
        }
      }
    } else if (ws.role === 'viewer' && ws.code) {
      const room = rooms.get(ws.code);
      if (room) {
        room.viewers.delete(ws.id);
        send(room.broadcaster, { type: 'viewer-left', viewerId: ws.id });
      }
      for (const [requestId, clipRequest] of clipRequests) {
        if (clipRequest.viewer === ws && clipRequest.status === 'pending') {
          clearTimeout(clipRequest.timeout);
          clipRequests.delete(requestId);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
wss.on('error', (error) => {
  console.error('Erro no servidor WebSocket:', error);
});

function startServer(port = PORT, callback) {
  return server.listen(port, callback || (() => {
    console.log(`Servidor rodando em http://localhost:${port}`);
  }));
}

if (require.main === module) startServer();

module.exports = { app, server, startServer, wss };
