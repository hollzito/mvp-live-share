const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { code: { broadcaster: ws, viewers: Map(id -> ws) } }
const rooms = new Map();

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
        // do transmissor para um espectador específico
        const room = rooms.get(ws.code);
        if (!room) return;
        const viewer = room.viewers.get(msg.target);
        send(viewer, { type: 'offer', sdp: msg.sdp, from: ws.id });
        break;
      }

      case 'answer': {
        // do espectador de volta ao transmissor
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
