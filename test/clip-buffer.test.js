const assert = require('node:assert/strict');
const test = require('node:test');
const { selectClipSegments } = require('../public/clip-buffer');

function segments(...durations) {
  return durations.map((durationMs, index) => ({ id: index, durationMs }));
}

test('seleciona somente os seis segmentos finais para um clipe de 30s', () => {
  const buffer = segments(5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000);
  const selection = selectClipSegments(buffer, 30_000);

  assert.deepEqual(selection.segments.map((segment) => segment.id), [2, 3, 4, 5, 6, 7]);
  assert.equal(selection.selectedDurationMs, 30_000);
  assert.equal(selection.startOffsetMs, 0);
});

test('mantém o histórico depois de finalizar um segmento curto entre dois clipes', () => {
  const buffer = segments(5000, 5000, 5000, 5000, 5000, 5000, 3000);
  const selection = selectClipSegments(buffer, 30_000);

  assert.equal(selection.segments.length, 7);
  assert.equal(selection.selectedDurationMs, 33_000);
  assert.equal(selection.startOffsetMs, 3000);
});

test('usa todo o conteúdo disponível quando ainda não existem 30 segundos', () => {
  const buffer = segments(5000, 3000);
  const selection = selectClipSegments(buffer, 30_000);

  assert.equal(selection.segments.length, 2);
  assert.equal(selection.selectedDurationMs, 8000);
  assert.equal(selection.startOffsetMs, 0);
});
