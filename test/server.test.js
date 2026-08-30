const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { access, mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const cloudinary = require('cloudinary').v2;
const ffmpegPath = require('ffmpeg-static');
const WebSocket = require('ws');

process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';
delete process.env.DISCORD_WEBHOOK_URL;

const originalCloudinaryUpload = cloudinary.uploader.upload;
const { server, startServer, wss } = require('../server');
let baseUrl;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr));
    });
  });
}

before(async () => {
  await new Promise((resolve) => startServer(0, resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  cloudinary.uploader.upload = originalCloudinaryUpload;
  await new Promise((resolve) => wss.close(() => server.close(resolve)));
});

test('mantém o servidor ativo depois de receber a mensagem WebSocket null', async () => {
  const socket = new WebSocket(baseUrl.replace(/^http/, 'ws'));
  const messages = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout aguardando respostas WebSocket.')), 2_000);
    socket.on('error', reject);
    socket.on('open', () => socket.send('null'));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      messages.push(message);
      if (messages.length === 1) socket.send(JSON.stringify({ type: 'create-room' }));
      if (messages.length === 2) socket.send(JSON.stringify({ type: 'create-room' }));
      if (messages.length === 3) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  socket.close();
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[1].type, 'room-created');
  assert.equal(messages[2].type, 'error');
  assert.match(messages[2].message, /já pertence a uma sala/);
});

test('processa o upload em disco e remove os arquivos temporários', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-route-test-'));
  const sourcePath = path.join(directory, 'source.webm');
  let uploadedPath;

  try {
    await ffmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-t', '3', '-c:v', 'libvpx', sourcePath,
    ]);

    cloudinary.uploader.upload = async (filePath) => {
      uploadedPath = filePath;
      await access(filePath);
      return {
        secure_url: 'https://example.test/clip.mp4',
        public_id: 'clips/test',
        created_at: '2026-08-30T00:00:00Z',
      };
    };

    const formData = new FormData();
    formData.append('video', new Blob([await readFile(sourcePath)], { type: 'video/webm' }), 'clip.webm');
    formData.append('code', 'AB12');
    formData.append('duration', '30');

    const response = await fetch(`${baseUrl}/api/clips`, { method: 'POST', body: formData });
    const data = await response.json();

    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.url, 'https://example.test/clip.mp4');
    assert.ok(uploadedPath.endsWith('.webm.mp4'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(access(uploadedPath));
    await assert.rejects(access(uploadedPath.slice(0, -4)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
