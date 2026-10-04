export type ContentBounds = { x: number; y: number; width: number; height: number };
export type ViewportSize = { width: number; height: number };
export type MapViewport = { x: number; y: number; zoom: number };

export const VIEWPORT_PADDING = 24;

// The five hover actions are wider than short titles and sit below the node.
// Reserve their footprint before hover so revealing them never moves the map.
export const NODE_TOOLBAR_SPACE = { width: 320, height: 36, gap: 8 } as const;

export function nodeToolbarSpace(size?: ViewportSize) {
  const width = size && Number.isFinite(size.width) && size.width > 0
    ? Math.min(NODE_TOOLBAR_SPACE.width, Math.max(0, size.width - VIEWPORT_PADDING * 2))
    : NODE_TOOLBAR_SPACE.width;
  return { ...NODE_TOOLBAR_SPACE, width,
    height: width < NODE_TOOLBAR_SPACE.width ? NODE_TOOLBAR_SPACE.height * 2 : NODE_TOOLBAR_SPACE.height };
}

export function detailPanelBelowGap(size?: ViewportSize): number {
  const toolbar = nodeToolbarSpace(size);
  return toolbar.gap * 2 + toolbar.height;
}

/** Resize frozen overview geometry without observing later node/body changes. */
export function resizeToolbarBounds(bounds: ContentBounds,
  previous: ReturnType<typeof nodeToolbarSpace>, next: ReturnType<typeof nodeToolbarSpace>): ContentBounds {
  const extraWidth = Math.max(0, next.width - previous.width);
  return { ...bounds, x: bounds.x - extraWidth / 2, width: bounds.width + extraWidth,
    height: bounds.height + Math.max(0, next.height - previous.height) };
}

const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
const dimension = (value: number): number => Math.max(0, finite(value));

function normalizeBounds(bounds: ContentBounds): ContentBounds {
  return { x: finite(bounds.x), y: finite(bounds.y), width: dimension(bounds.width), height: dimension(bounds.height) };
}

export function nodeReadingBounds(bounds: ContentBounds, size?: ViewportSize): ContentBounds {
  const box = normalizeBounds(bounds);
  const toolbar = nodeToolbarSpace(size);
  const width = Math.max(box.width, toolbar.width);
  return {
    x: box.x - (width - box.width) / 2,
    y: box.y,
    width,
    height: box.height + toolbar.gap + toolbar.height,
  };
}

/** 小内容轴补足视窗大小，让 ReactFlow 的平移约束也保持左上留白。 */
export function readingExtent(bounds: ContentBounds, size: ViewportSize): [[number, number], [number, number]] {
  const box = normalizeBounds(bounds);
  const left = box.x - VIEWPORT_PADDING;
  const top = box.y - VIEWPORT_PADDING;
  return [
    [left, top],
    [
      left + Math.max(box.width + VIEWPORT_PADDING * 2, dimension(size.width)),
      top + Math.max(box.height + VIEWPORT_PADDING * 2, dimension(size.height)),
    ],
  ];
}

/** 阅读始终使用原始比例；每一轴独立约束，内容不足一屏时固定起点。 */
export function clampReadingViewport(viewport: MapViewport, bounds: ContentBounds, size: ViewportSize): MapViewport {
  const [[left, top], [right, bottom]] = readingExtent(bounds, size);
  return {
    x: Math.min(-left, Math.max(dimension(size.width) - right, finite(viewport.x, -left))),
    y: Math.min(-top, Math.max(dimension(size.height) - bottom, finite(viewport.y, -top))),
    zoom: 1,
  };
}

/** 留白按屏幕像素计算；超长图允许缩到任意必要比例。 */
export function overviewViewport(bounds: ContentBounds, size: ViewportSize): MapViewport {
  const box = normalizeBounds(bounds);
  const width = dimension(size.width);
  const height = dimension(size.height);
  if (width <= VIEWPORT_PADDING * 2 || height <= VIEWPORT_PADDING * 2) {
    return { x: VIEWPORT_PADDING - box.x, y: VIEWPORT_PADDING - box.y, zoom: 1 };
  }
  const zoom = Math.min(
    1,
    box.width > 0 ? (width - VIEWPORT_PADDING * 2) / box.width : 1,
    box.height > 0 ? (height - VIEWPORT_PADDING * 2) / box.height : 1,
  );
  return {
    x: (width - box.width * zoom) / 2 - box.x * zoom,
    y: (height - box.height * zoom) / 2 - box.y * zoom,
    zoom,
  };
}

export function unionBounds(boxes: ContentBounds[]): ContentBounds {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const bounds of boxes) {
    const box = normalizeBounds(bounds);
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
