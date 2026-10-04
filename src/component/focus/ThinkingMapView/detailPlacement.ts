import { detailPanelBelowGap, VIEWPORT_PADDING, type ContentBounds, type ViewportSize } from './viewport';

// Preserve the existing card's outer dimensions while making its CSS border-box.
export const DETAIL_PANEL_WIDTH = 374;
export const DETAIL_PANEL_MAX_HEIGHT = 450;
export const DETAIL_PANEL_GAP = 14;
export const DETAIL_PANEL_MIN_READING_HEIGHT = 160;

export type DetailSide = 'right' | 'below' | 'above';
export type DetailPlacementInput = {
  /** Measured screen pixels, relative to the canvas container. */
  node: ContentBounds;
  size: ViewportSize;
  zoom: number;
};
export type DetailPlacement = {
  side: DetailSide;
  /** Canvas CSS pixels, relative to the node. Above uses translateY(-100%). */
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

const finite = (value: number): number => Number.isFinite(value) ? value : 0;
const dimension = (value: number): number => Math.max(0, finite(value));

function measure(input: DetailPlacementInput) {
  const node = { x: finite(input.node.x), y: finite(input.node.y),
    width: dimension(input.node.width), height: dimension(input.node.height) };
  const size = { width: dimension(input.size.width), height: dimension(input.size.height) };
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
  const gap = Math.min(Number.MAX_VALUE, DETAIL_PANEL_GAP * zoom);
  const belowGap = Math.min(Number.MAX_VALUE, detailPanelBelowGap(size) * zoom);
  const available = (space: number) => Math.max(0, finite(space));
  return {
    node, size, zoom,
    right: available(size.width - VIEWPORT_PADDING - node.x - node.width - gap),
    rightHeight: available(size.height - VIEWPORT_PADDING - Math.max(node.y, VIEWPORT_PADDING)),
    below: available(size.height - VIEWPORT_PADDING - node.y - node.height - belowGap),
    above: available(node.y - VIEWPORT_PADDING - gap),
  };
}

/** Choose once when opening a node or resizing the canvas, never during reading. */
export function chooseDetailPlacement(input: DetailPlacementInput): DetailPlacement {
  const space = measure(input);
  const minimumHeight = DETAIL_PANEL_MIN_READING_HEIGHT * space.zoom;
  const side: DetailSide = space.right >= DETAIL_PANEL_WIDTH * space.zoom
    && space.rightHeight >= minimumHeight ? 'right'
    : space.below < minimumHeight && space.above > space.below ? 'above' : 'below';
  return fitDetailPlacement(input, side);
}

/** Keep a chosen side when dimensions change; no camera movement or node reflow. */
export function fitDetailPlacement(input: DetailPlacementInput, side: DetailSide): DetailPlacement {
  const space = measure(input);
  const { node, size, zoom } = space;
  // A hidden/tiny canvas can yield zero available space, rather than invalid CSS.
  const width = Math.min(DETAIL_PANEL_WIDTH, Math.max(0, size.width - VIEWPORT_PADDING * 2) / zoom,
    side === 'right' ? space.right / zoom : DETAIL_PANEL_WIDTH);
  const toCanvas = (pixels: number): number => {
    const value = pixels / zoom;
    return Number.isFinite(value) ? value : Math.sign(value || 1) * Number.MAX_VALUE;
  };
  const height = side === 'right' ? space.rightHeight : space[side];
  if (side === 'right') {
    return { side, left: toCanvas(node.width) + DETAIL_PANEL_GAP,
      top: toCanvas(Math.max(VIEWPORT_PADDING, node.y) - node.y), width,
      maxHeight: Math.min(DETAIL_PANEL_MAX_HEIGHT, height / zoom) };
  }
  // Align with the node where possible; shift only the card at the left/right edge.
  const screenWidth = width * zoom;
  const leftLimit = Math.min(VIEWPORT_PADDING, size.width / 2);
  const rightLimit = Math.max(leftLimit, size.width - VIEWPORT_PADDING - screenWidth);
  const screenLeft = Math.max(leftLimit, Math.min(node.x, rightLimit));
  return { side, left: toCanvas(screenLeft - node.x),
    top: side === 'above' ? -DETAIL_PANEL_GAP : toCanvas(node.height) + detailPanelBelowGap(size),
    width, maxHeight: Math.min(DETAIL_PANEL_MAX_HEIGHT, height / zoom) };
}
