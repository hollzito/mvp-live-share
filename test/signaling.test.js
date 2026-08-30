const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSignalMessage } = require('../signaling');

test('rejeita JSON inválido sem lançar exceção', () => {
  assert.deepEqual(parseSignalMessage(Buffer.from('{')), {
    error: 'Mensagem de sinalização inválida.',
  });
});

test('rejeita null e outros valores que não são objetos', () => {
  assert.deepEqual(parseSignalMessage(Buffer.from('null')), {
    error: 'Mensagem de sinalização inválida.',
  });
  assert.deepEqual(parseSignalMessage(Buffer.from('[]')), {
    error: 'Mensagem de sinalização inválida.',
  });
});

test('aceita apenas tipos de sinalização conhecidos', () => {
  assert.deepEqual(parseSignalMessage(Buffer.from('{"type":"desconhecido"}')), {
    error: 'Tipo de mensagem de sinalização inválido.',
  });
  assert.deepEqual(parseSignalMessage(Buffer.from('{"type":"join-room","code":"AB12"}')), {
    message: { type: 'join-room', code: 'AB12' },
  });
});
