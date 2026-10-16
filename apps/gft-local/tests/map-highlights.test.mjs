import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const result = await build({
  entryPoints: [fileURLToPath(new URL('../../../src/service/mapHighlights.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { mapHighlights } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
const edges = [
  { id: 'ab', from: 'a', to: 'b' },
  { id: 'bc', from: 'b', to: 'c' },
  { id: 'xy', from: 'x', to: 'y' },
];
const resolve = extra => mapHighlights({ edges, hoverNodeId: null, hoveredEdgeId: null, ...extra });
test('node hover highlights itself without incident lines', () => {
  const h = resolve({ hoverNodeId: 'b' });
  assert.equal(h.nodeId, 'b');
  assert.deepEqual([...h.edgeIds], []);
});
test('line hover highlights itself without either endpoint', () => {
  const h = resolve({ hoveredEdgeId: 'ab', hoverNodeId: 'x' });
  assert.equal(h.nodeId, null);
  assert.deepEqual([...h.edgeIds], ['ab']);
});
test('persistent line selection survives hovering a different node or line', () => {
  assert.deepEqual([...resolve({ hoverNodeId: 'b', selectedEdgeIds: ['xy'] }).edgeIds], ['xy']);
  const h = resolve({ hoveredEdgeId: 'bc', selectedEdgeIds: ['xy'] });
  assert.equal(h.nodeId, null);
  assert.deepEqual([...h.edgeIds], ['xy', 'bc']);
});
test('stale edge references do not affect the visible graph', () => {
  assert.equal(resolve({ hoveredEdgeId: 'missing', selectedEdgeIds: ['missing'] }).hasFocus, false);
});
