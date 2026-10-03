import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let chooseDetailPlacement, fitDetailPlacement, DETAIL_PANEL_WIDTH, DETAIL_PANEL_MAX_HEIGHT, DETAIL_PANEL_BELOW_GAP;
before(async () => {
  const entry = fileURLToPath(new URL('../../../src/component/focus/ThinkingMapView/detailPlacement.ts', import.meta.url));
  const bundled = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  ({ chooseDetailPlacement, fitDetailPlacement, DETAIL_PANEL_WIDTH, DETAIL_PANEL_MAX_HEIGHT, DETAIL_PANEL_BELOW_GAP } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`));
});

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
// Test the rendered outer box, including above's CSS translateY(-100%).
const cardBounds = ({ node, zoom }, placement, height = placement.maxHeight) => {
  const left = node.x + placement.left * zoom;
  const anchorTop = node.y + placement.top * zoom;
  const top = placement.side === 'above' ? anchorTop - height * zoom : anchorTop;
  return { left, top, right: left + placement.width * zoom, bottom: top + height * zoom };
};
const assertFits = (input, placement) => {
  const box = cardBounds(input, placement);
  assert.ok(box.left >= 24 - 1e-8);
  assert.ok(box.right <= input.size.width - 24 + 1e-8);
  assert.ok(box.top >= 24 - 1e-8);
  assert.ok(box.bottom <= input.size.height - 24 + 1e-8);
  const { node } = input;
  assert.ok(box.right <= node.x || box.left >= node.x + node.width
    || box.bottom <= node.y || box.top >= node.y + node.height, 'card must not cover its own node');
};

test('宽画布右侧有空间时保留原来的相邻正文卡尺寸', () => {
  const input = { node: { x: 80, y: 80, width: 208, height: 60 }, size: { width: 1100, height: 800 }, zoom: 1 };
  const placement = chooseDetailPlacement(input);
  assert.equal(placement.side, 'right');
  assert.equal(placement.width, DETAIL_PANEL_WIDTH);
  assert.equal(placement.maxHeight, DETAIL_PANEL_MAX_HEIGHT);
  close(cardBounds(input, placement).left - (input.node.x + input.node.width), 14);
  close(cardBounds(input, placement).top, input.node.y);
  assertFits(input, placement);
});

test('窄栏下挂，正文与当前节点一起可见且不用缩小字号', () => {
  for (const width of [320, 360, 430, 580]) {
    const input = { node: { x: 24, y: 80, width: 208, height: 60 }, size: { width, height: 800 }, zoom: 1 };
    const placement = chooseDetailPlacement(input);
    assert.equal(placement.side, 'below');
    assert.equal(placement.width, Math.min(374, width - 48));
    close(cardBounds(input, placement).top - (input.node.y + input.node.height), DETAIL_PANEL_BELOW_GAP);
    assertFits(input, placement);
  }
});

test('宽画布的最右边节点也下挂，判断不能只看容器总宽', () => {
  const input = { node: { x: 860, y: 80, width: 208, height: 60 }, size: { width: 1100, height: 800 }, zoom: 1 };
  const placement = chooseDetailPlacement(input);
  assert.equal(placement.side, 'below');
  close(cardBounds(input, placement).right, input.size.width - 24);
  assertFits(input, placement);
});

test('窄栏和宽栏的底部节点上挂，卡片不遮当前节点', () => {
  for (const width of [430, 1100]) {
    const input = { node: { x: 80, y: 680, width: 208, height: 60 }, size: { width, height: 800 }, zoom: 1 };
    const placement = chooseDetailPlacement(input);
    assert.equal(placement.side, 'above');
    close(input.node.y - cardBounds(input, placement).bottom, 14);
    assertFits(input, placement);
  }
});

test('上挂短正文仍贴住节点，不预留空的450px卡片', () => {
  const input = { node: { x: 80, y: 680, width: 208, height: 60 }, size: { width: 430, height: 800 }, zoom: 1 };
  const placement = chooseDetailPlacement(input);
  for (const naturalHeight of [80, 160, 450]) {
    close(input.node.y - cardBounds(input, placement, naturalHeight).bottom, 14);
  }
});

test('左右边缘只挪浮卡，仍保持节点与正文之间的垂直间距', () => {
  for (const x of [0, 220]) {
    const input = { node: { x, y: 80, width: 208, height: 60 }, size: { width: 430, height: 800 }, zoom: 1 };
    const placement = chooseDetailPlacement(input);
    assert.equal(placement.side, 'below');
    assertFits(input, placement);
    close(cardBounds(input, placement).top - (input.node.y + input.node.height), DETAIL_PANEL_BELOW_GAP);
  }
});

test('下挂正文为节点下的连线、整理、Doc和删除工具条留完整空间', () => {
  for (const zoom of [1, 0.5]) {
    const input = { node: { x: 24, y: 80, width: 208 * zoom, height: 60 * zoom }, size: { width: 360, height: 800 }, zoom };
    // Keep the narrow layout under zoom as well, rather than selecting right.
    const placement = fitDetailPlacement(input, 'below');
    const toolbarBottom = input.node.y + input.node.height + (8 + 36) * zoom;
    assert.ok(cardBounds(input, placement).top >= toolbarBottom + 8 * zoom,
      'the card must leave the complete action footprint plus a separate gap');
    assertFits(input, placement);
  }
});

test('容器垂直空间不足450px时限制正文高度供内部滚动', () => {
  const input = { node: { x: 24, y: 40, width: 208, height: 60 }, size: { width: 430, height: 360 }, zoom: 1 };
  const placement = chooseDetailPlacement(input);
  assert.equal(placement.side, 'below');
  assert.ok(placement.maxHeight >= 160 && placement.maxHeight < 450);
  close(cardBounds(input, placement).bottom, input.size.height - 24);
  assertFits(input, placement);
});

test('上下都偏短时使用较宽裕的一侧，不强行盖住节点', () => {
  const input = { node: { x: 24, y: 160, width: 208, height: 60 }, size: { width: 430, height: 300 }, zoom: 1 };
  const placement = chooseDetailPlacement(input);
  assert.equal(placement.side, 'above');
  assert.ok(placement.maxHeight > 0 && placement.maxHeight < 160);
  assertFits(input, placement);
});

test('总览保留已有缩放；留白按屏幕px，卡片与间隔仍继承画布缩放', () => {
  const input = { node: { x: 24, y: 60, width: 104, height: 30 }, size: { width: 430, height: 400 }, zoom: 0.5 };
  const placement = chooseDetailPlacement(input);
  assert.equal(placement.side, 'right');
  assert.equal(placement.width, 374);
  close(cardBounds(input, placement).right - cardBounds(input, placement).left, 187);
  close(cardBounds(input, placement).left - (input.node.x + input.node.width), 7);
  assertFits(input, placement);
});

test('阅读期间可更新同方向尺寸，不因内容或局部位置变化重新翻转', () => {
  const input = { node: { x: 24, y: 80, width: 208, height: 60 }, size: { width: 430, height: 800 }, zoom: 1 };
  const opened = chooseDetailPlacement(input);
  const shorter = { ...input, size: { width: 360, height: 360 } };
  const fitted = fitDetailPlacement(shorter, opened.side);
  assert.equal(fitted.side, opened.side);
  assert.ok(fitted.width <= opened.width && fitted.maxHeight < opened.maxHeight);
  assertFits(shorter, fitted);
  const nearBottom = { ...input, node: { ...input.node, y: 680 } };
  assert.equal(chooseDetailPlacement(nearBottom).side, 'above');
  assert.equal(fitDetailPlacement(nearBottom, opened.side).side, 'below');
});

test('几何读取不修改节点或容器输入，不含相机操作或正文内容依赖', () => {
  const node = Object.freeze({ x: 24, y: 80, width: 208, height: 60 });
  const size = Object.freeze({ width: 430, height: 800 });
  const input = Object.freeze({ node, size, zoom: 1 });
  const placement = chooseDetailPlacement(input);
  assert.deepEqual(fitDetailPlacement(input, placement.side), placement);
  assert.deepEqual(Object.keys(placement).sort(), ['left', 'maxHeight', 'side', 'top', 'width']);
});

test('隐藏视窗、无效尺寸或缩放不产生NaN、Infinity及负卡片尺寸', () => {
  for (const size of [{ width: 0, height: 0 }, { width: 20, height: 20 }, { width: NaN, height: Infinity }, { width: -30, height: -40 }]) {
    for (const zoom of [0, -1, NaN, Infinity, 1e-300]) {
      const input = { node: { x: NaN, y: -200, width: -1, height: Infinity }, size, zoom };
      for (const side of ['right', 'below', 'above']) {
        const placement = fitDetailPlacement(input, side);
        for (const key of ['left', 'top', 'width', 'maxHeight']) assert.ok(Number.isFinite(placement[key]), `${key} must be finite`);
        assert.ok(placement.width >= 0 && placement.maxHeight >= 0);
      }
      assert.ok(['right', 'below', 'above'].includes(chooseDetailPlacement(input).side));
    }
  }
});
