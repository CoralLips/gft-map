import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let clampReadingViewport, readingExtent, overviewViewport, unionBounds, VIEWPORT_PADDING;
before(async () => {
  const entry = fileURLToPath(new URL('../../../src/component/focus/ThinkingMapView/viewport.ts', import.meta.url));
  const bundled = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  ({ clampReadingViewport, readingExtent, overviewViewport, unionBounds, VIEWPORT_PADDING } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`));
});

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
const screenBounds = (bounds, viewport) => ({
  left: bounds.x * viewport.zoom + viewport.x,
  top: bounds.y * viewport.zoom + viewport.y,
  right: (bounds.x + bounds.width) * viewport.zoom + viewport.x,
  bottom: (bounds.y + bounds.height) * viewport.zoom + viewport.y,
});

test('大图阅读可达四边，越界拖动最多留下 24px 留白', () => {
  assert.equal(VIEWPORT_PADDING, 24);
  const bounds = { x: 120, y: 80, width: 1100, height: 900 };
  const size = { width: 640, height: 480 };
  const middle = { x: -250, y: -200, zoom: 1 };
  assert.deepEqual(clampReadingViewport(middle, bounds, size), middle);
  const left = clampReadingViewport({ ...middle, x: 10000 }, bounds, size);
  const right = clampReadingViewport({ ...middle, x: -10000 }, bounds, size);
  const top = clampReadingViewport({ ...middle, y: 10000 }, bounds, size);
  const bottom = clampReadingViewport({ ...middle, y: -10000 }, bounds, size);
  assert.equal(screenBounds(bounds, left).left, 24);
  assert.equal(screenBounds(bounds, right).right, size.width - 24);
  assert.equal(screenBounds(bounds, top).top, 24);
  assert.equal(screenBounds(bounds, bottom).bottom, size.height - 24);
  assert.equal(left.y, middle.y);
  assert.equal(bottom.x, middle.x);
  for (const viewport of [left, right, top, bottom]) assert.deepEqual(clampReadingViewport(viewport, bounds, size), viewport);
});

test('小图固定左上起点，窄长图只锁横轴，不居中也不禁止纵向阅读', () => {
  const size = { width: 640, height: 480 };
  const small = { x: -100, y: -40, width: 120, height: 60 };
  for (const offset of [-10000, 0, 10000]) {
    assert.deepEqual(clampReadingViewport({ x: offset, y: offset, zoom: 1 }, small, size), { x: 124, y: 64, zoom: 1 });
  }
  const tall = { ...small, height: 1800 };
  assert.deepEqual(clampReadingViewport({ x: -200, y: -500, zoom: 1 }, tall, size), { x: 124, y: -500, zoom: 1 });
  const exact = { x: 0, y: 0, width: size.width - 48, height: size.height - 48 };
  assert.deepEqual(clampReadingViewport({ x: -200, y: -500, zoom: 1 }, exact, size), { x: 24, y: 24, zoom: 1 });
});

test('负坐标内容仍以真实包围盒约束，不将原点误当内容边缘', () => {
  const bounds = { x: -400, y: -600, width: 1800, height: 2200 };
  const size = { width: 800, height: 600 };
  const start = clampReadingViewport({ x: 10000, y: 10000, zoom: 1 }, bounds, size);
  const end = clampReadingViewport({ x: -10000, y: -10000, zoom: 1 }, bounds, size);
  assert.deepEqual(start, { x: 424, y: 624, zoom: 1 });
  assert.equal(screenBounds(bounds, end).right, 776);
  assert.equal(screenBounds(bounds, end).bottom, 576);
});

test('视窗尺寸改变保留仍合法的位置，扩展后收回越界空白', () => {
  const bounds = { x: 0, y: 0, width: 1600, height: 1200 };
  const previous = clampReadingViewport({ x: -10000, y: -10000, zoom: 1 }, bounds, { width: 800, height: 600 });
  assert.deepEqual(clampReadingViewport(previous, bounds, { width: 400, height: 300 }), previous);
  const expanded = clampReadingViewport(previous, bounds, { width: 1000, height: 800 });
  assert.equal(screenBounds(bounds, expanded).right, 976);
  assert.equal(screenBounds(bounds, expanded).bottom, 776);
  assert.deepEqual(clampReadingViewport(previous, bounds, { width: 2000, height: 1600 }), { x: 24, y: 24, zoom: 1 });
});

test('阅读模式忽略外部缩放值，恢复原始比例且不修改输入', () => {
  const bounds = Object.freeze({ x: 0, y: 0, width: 1800, height: 2200 });
  const size = Object.freeze({ width: 800, height: 600 });
  for (const zoom of [0.02, 0, 2, NaN]) {
    const viewport = Object.freeze({ x: -200, y: -300, zoom });
    assert.deepEqual(clampReadingViewport(viewport, bounds, size), { x: -200, y: -300, zoom: 1 });
  }
});

test('ReactFlow 平移范围对大图保留四边留白，对小图补足视窗锁轴', () => {
  const bounds = { x: -100, y: -40, width: 120, height: 1800 };
  const size = { width: 640, height: 480 };
  const [[left, top], [right, bottom]] = readingExtent(bounds, size);
  assert.equal(left, bounds.x - 24);
  assert.equal(top, bounds.y - 24);
  assert.equal(right - left, size.width);
  assert.equal(bottom, bounds.y + bounds.height + 24);
  const start = clampReadingViewport({ x: 10000, y: 10000, zoom: 1 }, bounds, size);
  const end = clampReadingViewport({ x: -10000, y: -10000, zoom: 1 }, bounds, size);
  assert.equal(left + start.x, 0);
  assert.equal(top + start.y, 0);
  assert.equal(right + end.x, size.width);
  assert.equal(bottom + end.y, size.height);
});

test('总览完整拟合并居中，超长图可缩至 0.1 以下，小图不放大', () => {
  const size = { width: 800, height: 600 };
  const boxes = [
    { x: 120, y: -400, width: 200, height: 100000 },
    { x: -1200, y: -600, width: 90000, height: 200 },
    { x: -100, y: 50, width: 1200, height: 900 },
    { x: 300, y: 400, width: 100, height: 80 },
    { x: 10, y: -20, width: 0, height: 0 },
  ];
  for (const bounds of boxes) {
    const viewport = overviewViewport(bounds, size);
    const screen = screenBounds(bounds, viewport);
    assert.ok(viewport.zoom > 0 && viewport.zoom <= 1);
    assert.ok(screen.left >= 24 - 1e-8 && screen.top >= 24 - 1e-8);
    assert.ok(screen.right <= size.width - 24 + 1e-8 && screen.bottom <= size.height - 24 + 1e-8);
    close(screen.left, size.width - screen.right);
    close(screen.top, size.height - screen.bottom);
  }
  assert.ok(overviewViewport(boxes[0], size).zoom < 0.1);
  close(screenBounds(boxes[0], overviewViewport(boxes[0], size)).top, 24);
  assert.equal(overviewViewport(boxes[3], size).zoom, 1);
});

test('并集包含负坐标、分离区域和零尺寸点；空数组有稳定零矩形', () => {
  const boxes = [
    Object.freeze({ x: -120, y: 80, width: 180, height: 50 }),
    Object.freeze({ x: 400, y: -200, width: 100, height: 300 }),
    Object.freeze({ x: 200, y: 500, width: 0, height: 0 }),
  ];
  assert.deepEqual(unionBounds(boxes), { x: -120, y: -200, width: 620, height: 700 });
  assert.deepEqual(unionBounds([]), { x: 0, y: 0, width: 0, height: 0 });
});

test('尚未测得尺寸或收到无效视窗数据时，几何结果保持有限且总览不产生零缩放', () => {
  const bounds = { x: -100, y: 40, width: 1000, height: 2000 };
  for (const size of [
    { width: 0, height: 0 },
    { width: NaN, height: 600 },
    { width: 800, height: Infinity },
    { width: -1, height: 600 },
    { width: 48, height: 600 },
  ]) {
    const reading = clampReadingViewport({ x: NaN, y: NaN, zoom: NaN }, bounds, size);
    assert.deepEqual(reading, { x: 124, y: -16, zoom: 1 });
    assert.deepEqual(overviewViewport(bounds, size), { x: 124, y: -16, zoom: 1 });
    assert.ok(readingExtent(bounds, size).flat().every(Number.isFinite));
  }
  assert.deepEqual(clampReadingViewport({ x: NaN, y: -300, zoom: 1 }, bounds, { width: 800, height: 600 }), { x: 124, y: -300, zoom: 1 });
});
