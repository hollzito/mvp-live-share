const ALLOWED_SIGNAL_TYPES = new Set([
  'create-room',
  'join-room',
  'offer',
  'answer',
  'ice-candidate',
  'clip-request',
  'clip-upload-failed',
]);

function parseSignalMessage(raw) {
  let message;

  try {
    message = JSON.parse(raw.toString());
  } catch {
    return { error: 'Mensagem de sinalização inválida.' };
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { error: 'Mensagem de sinalização inválida.' };
  }

  if (typeof message.type !== 'string' || !ALLOWED_SIGNAL_TYPES.has(message.type)) {
    return { error: 'Tipo de mensagem de sinalização inválido.' };
  }

  return { message };
}

module.exports = { parseSignalMessage };
