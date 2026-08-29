require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const fetch = require('node-fetch');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { code: { broadcaster: ws, viewers: Map(id -> ws) } }
const rooms = new Map();

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

// Recebe o vídeo do clipe (enviado pelo navegador de quem assiste) e sobe pro Cloudinary
app.post('/api/clips', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum vídeo enviado.' });
  }
  const code = (req.body.code || 'sem-codigo').toString().trim().toUpperCase().slice(0, 20) || 'sem-codigo';

  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: 'Cloudinary não configurado no servidor (variáveis de ambiente ausentes).' });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'video', folder: 'clips', tags: ['clipe', code] },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({ url: result.secure_url, id: result.public_id, createdAt: result.created_at, code });

    notifyDiscord(result.secure_url, code);
  } catch (err) {
    console.error('Erro ao enviar clipe para o Cloudinary:', err);
    res.status(500).json({ error: 'Falha ao salvar o clipe.' });
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
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        const code = generateCode();
        ws.role = 'broadcaster';
        ws.code = code;
        rooms.set(code, { broadcaster: ws, viewers: new Map() });
        send(ws, { type: 'room-created', code });
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.code);
        if (!room) {
          send(ws, { type: 'error', message: 'Código não encontrado.' });
          return;
        }
        ws.role = 'viewer';
        ws.code = msg.code;
        room.viewers.set(ws.id, ws);
        send(ws, { type: 'joined', viewerId: ws.id });
        send(room.broadcaster, { type: 'viewer-joined', viewerId: ws.id });
        break;
      }

      case 'offer': {
        const room = rooms.get(ws.code);
        if (!room) return;
        const viewer = room.viewers.get(msg.target);
        send(viewer, { type: 'offer', sdp: msg.sdp, from: ws.id });
        break;
      }

      case 'answer': {
        const room = rooms.get(ws.code);
        if (!room) return;
        send(room.broadcaster, { type: 'answer', sdp: msg.sdp, from: ws.id });
        break;
      }

      case 'ice-candidate': {
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
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
