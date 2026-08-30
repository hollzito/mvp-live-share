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
const originalCloudinaryResourcesByTag = cloudinary.api.resources_by_tag;
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

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace(/^http/, 'ws'));
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timeout aguardando mensagem WebSocket.'));
    }, 2_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw);
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function createClipSession() {
  const broadcaster = await openSocket();
  const roomCreated = nextMessage(broadcaster, (message) => message.type === 'room-created');
  broadcaster.send(JSON.stringify({ type: 'create-room' }));
  const { code } = await roomCreated;

  const viewer = await openSocket();
  const joined = nextMessage(viewer, (message) => message.type === 'joined');
  viewer.send(JSON.stringify({ type: 'join-room', code }));
  await joined;

  const clipRequest = nextMessage(broadcaster, (message) => message.type === 'clip-request');
  const clipAccepted = nextMessage(viewer, (message) => message.type === 'clip-accepted');
  viewer.send(JSON.stringify({ type: 'clip-request', duration: 30 }));

  return {
    broadcaster,
    viewer,
    request: await clipRequest,
    accepted: await clipAccepted,
  };
}

before(async () => {
  await new Promise((resolve) => startServer(0, resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  cloudinary.uploader.upload = originalCloudinaryUpload;
  cloudinary.api.resources_by_tag = originalCloudinaryResourcesByTag;
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

test('serve os recursos otimizados e expõe a saúde do processo', async () => {
  const [healthResponse, recorderResponse, watchResponse] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/clip-recorder.js`),
    fetch(`${baseUrl}/watch.html`),
  ]);

  assert.equal(healthResponse.status, 200);
  assert.equal(recorderResponse.status, 200);
  assert.equal(watchResponse.status, 200);
  assert.equal((await healthResponse.json()).status, 'ok');
  assert.match(await recorderResponse.text(), /class RollingClipRecorder/);
});

test('processa o upload em disco e remove os arquivos temporários', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvp-live-share-route-test-'));
  const sourcePath = path.join(directory, 'source.webm');
  let uploadedPath;
  let broadcaster;
  let viewer;
  let clipRequest;

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

    ({ broadcaster, viewer, request: clipRequest } = await createClipSession());
    const clipResult = nextMessage(viewer, (message) => message.type === 'clip-result');

    const formData = new FormData();
    formData.append('videos', new Blob([await readFile(sourcePath)], { type: 'video/webm' }), 'clip.webm');
    formData.append('videos', new Blob([await readFile(sourcePath)], { type: 'video/webm' }), 'clip-2.webm');
    formData.append('startOffsetMs', '1000');

    const response = await fetch(`${baseUrl}/api/clips`, {
      method: 'POST',
      headers: { 'X-Clip-Request': clipRequest.requestId },
      body: formData,
    });
    const data = await response.json();
    const viewerResult = await clipResult;

    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.url, 'https://example.test/clip.mp4');
    assert.equal(viewerResult.url, data.url);
    assert.equal(viewerResult.requestId, clipRequest.requestId);
    assert.ok(uploadedPath.endsWith('.webm.mp4'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(access(uploadedPath));
    await assert.rejects(access(uploadedPath.slice(0, -4)));
  } finally {
    broadcaster?.close();
    viewer?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejeita upload sem solicitação antes de executar o processamento', async () => {
  const formData = new FormData();
  formData.append('videos', new Blob(['invalido'], { type: 'video/webm' }), 'clip.webm');
  formData.append('startOffsetMs', '0');

  const response = await fetch(`${baseUrl}/api/clips`, { method: 'POST', body: formData });
  assert.equal(response.status, 403);
});

test('rejeita uma segunda solicitação antes de iniciar outro upload', async () => {
  const session = await createClipSession();
  try {
    const busyResponse = nextMessage(session.viewer, (message) => message.type === 'clip-error');
    session.viewer.send(JSON.stringify({ type: 'clip-request', duration: 30 }));
    const message = await busyResponse;
    assert.match(message.message, /Outro clipe/);

    session.broadcaster.send(JSON.stringify({
      type: 'clip-upload-failed',
      requestId: session.request.requestId,
    }));
  } finally {
    session.broadcaster.close();
    session.viewer.close();
  }
});

test('reutiliza o cache da listagem de clipes', async () => {
  let calls = 0;
  cloudinary.api.resources_by_tag = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      resources: [{
        secure_url: 'https://example.test/cached.mp4',
        tags: ['clipe', 'AB12'],
        created_at: '2026-08-30T00:00:00Z',
      }],
    };
  };

  const [first, second] = await Promise.all([
    fetch(`${baseUrl}/api/clips?limit=1`),
    fetch(`${baseUrl}/api/clips?limit=1`),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls, 1);
});
