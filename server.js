require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { unlink } = require('fs/promises');
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
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2, parts: 4 },
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

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { code: { broadcaster: ws, viewers: Map(id -> ws) } }
const rooms = new Map();
const MAX_CONCURRENT_CLIPS = 1;
let activeClipProcesses = 0;

// Manda o link do clipe pro canal do Discord configurado (se houver webhook definido)
async function notifyDiscord(clipUrl, code) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🎬 Novo clipe salvo — sala **${code}**\n${clipUrl}`,
      }),
    });
  } catch (err) {
    console.error('Erro ao notificar o Discord:', err);
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

function receiveClip(req, res, next) {
  upload.single('video')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      console.warn(`Upload de clipe rejeitado pelo Multer (${error.code}).`);
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'O clipe ultrapassou o limite de 100 MB.'
        : 'Upload de clipe inválido.';
      return res.status(status).json({ error: message });
    }

    res.status(error.statusCode || 400).json({ error: error.message || 'Upload de clipe inválido.' });
  });
}

async function removeTemporaryFiles(paths) {
  await Promise.allSettled(paths.filter(Boolean).map((filePath) => unlink(filePath)));
}

// Recebe o vídeo do clipe (enviado pelo navegador de quem assiste) e sobe pro Cloudinary
app.post('/api/clips', receiveClip, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum vídeo enviado.' });
  }
  const temporaryFiles = [req.file.path];
  let acquiredClipSlot = false;

  try {
    const code = (req.body.code || '').toString().trim().toUpperCase();
    const duration = parseClipDuration(req.body.duration);

    if (!/^[A-Z0-9]{4}$/.test(code)) {
      return res.status(400).json({ error: 'Código de sala inválido.' });
    }
    if (!duration) {
      return res.status(400).json({ error: 'Duração de clipe inválida. Use 30 ou 60 segundos.' });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary não configurado no servidor (variáveis de ambiente ausentes).' });
    }
    if (activeClipProcesses >= MAX_CONCURRENT_CLIPS) {
      res.set('Retry-After', '10');
      return res.status(503).json({ error: 'O servidor já está processando outro clipe. Tente novamente em alguns segundos.' });
    }

    activeClipProcesses += 1;
    acquiredClipSlot = true;

    const normalizedClipPath = await normalizeClip(req.file.path, duration);
    temporaryFiles.push(normalizedClipPath);
    const result = await cloudinary.uploader.upload(normalizedClipPath, {
      resource_type: 'video',
      folder: 'clips',
      tags: ['clipe', code],
      format: 'mp4',
    });

    res.json({ url: result.secure_url, id: result.public_id, createdAt: result.created_at, code });

    notifyDiscord(result.secure_url, code);
  } catch (err) {
    console.error('Erro ao enviar clipe para o Cloudinary:', err);
    res.status(500).json({ error: 'Falha ao salvar o clipe.' });
  } finally {
    if (acquiredClipSlot) activeClipProcesses -= 1;
    await removeTemporaryFiles(temporaryFiles);
  }
});

// Lista os clipes salvos, mais recentes primeiro
app.get('/api/clips', async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.json({ clips: [] });
  }
  try {
    const result = await cloudinary.api.resources_by_tag('clipe', {
      resource_type: 'video',
      max_results: 50,
      context: true,
    });

    const clips = (result.resources || [])
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((r) => ({
        url: r.secure_url,
        code: (r.tags || []).find((t) => t !== 'clipe') || '',
        createdAt: r.created_at,
      }));

    res.json({ clips });
  } catch (err) {
    console.error('Erro ao listar clipes:', err);
    res.status(500).json({ error: 'Falha ao carregar clipes.' });
  }
});

// ---- Sinalização WebRTC ----

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 10);

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
    } else if (ws.role === 'viewer' && ws.code) {
      const room = rooms.get(ws.code);
      if (room) {
        room.viewers.delete(ws.id);
        send(room.broadcaster, { type: 'viewer-left', viewerId: ws.id });
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
