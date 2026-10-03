import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ReactFlowInstance, Viewport } from 'reactflow';
import { clampReadingViewport, overviewViewport, readingExtent, unionBounds, VIEWPORT_PADDING, type ContentBounds, type ViewportSize } from './viewport';
import { chooseDetailPlacement, fitDetailPlacement, DETAIL_PANEL_GAP, DETAIL_PANEL_BELOW_GAP, type DetailSide } from './detailPlacement';

const sameViewport = (a: Viewport, b: Viewport) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.zoom - b.zoom) < 1e-9;

/** Reading is always 1:1; overview is a frozen camera with a saved return position. */
export function useMapViewport(
  containerRef: RefObject<HTMLDivElement>,
  contentBounds: ContentBounds,
  openPanelId: string | null,
  generation: number,
) {
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const [overview, setOverview] = useState(false);
  const [geometry, setGeometry] = useState({ bounds: contentBounds, size: { width: 0, height: 0 } });
  const geometryRef = useRef(geometry);
  const camera = useRef<{
    reading: Viewport;
    overview: { viewport: Viewport; bounds: ContentBounds; size: ViewportSize } | null;
  }>({ reading: { x: 24 - contentBounds.x, y: 24 - contentBounds.y, zoom: 1 }, overview: null });
  const pendingCenter = useRef<{ panelId: string } | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const placedPanel = useRef<{ panel: HTMLElement; size: ViewportSize; zoom: number;
    side: DetailSide; nodeWidth: number; nodeHeight: number } | null>(null);
  const lastGeneration = useRef(generation);
  if (lastGeneration.current !== generation) {
    // A redraw remounts ReactFlow. Give that first frame the new bounds instead
    // of briefly rendering the previous graph's camera before onInit fires.
    lastGeneration.current = generation;
    const size = geometryRef.current.size;
    geometryRef.current = { bounds: contentBounds, size };
    camera.current.reading = clampReadingViewport(camera.current.reading, contentBounds, size);
    if (camera.current.overview) {
      camera.current.overview = { bounds: contentBounds, size,
        viewport: overviewViewport(contentBounds, size) };
    }
    pendingCenter.current = null;
  }

  const apply = useCallback((next: Viewport, target = instance) => {
    if (target && !sameViewport(target.getViewport(), next)) target.setViewport(next);
  }, [instance]);

  const constrain = useCallback((next: Viewport) => {
    const { bounds, size } = geometryRef.current;
    return camera.current.overview?.viewport ?? clampReadingViewport(next, bounds, size);
  }, []);

  // ReactFlow 11 has no controlled viewport. Native drags use translateExtent;
  // this guard also covers its keyboard/programmatic navigation paths.
  const onMove = useCallback((_event: unknown, next: Viewport) => {
    const bounded = constrain(next);
    if (!camera.current.overview) camera.current.reading = bounded;
    if (!sameViewport(next, bounded)) apply(bounded);
  }, [apply, constrain]);

  const onInit = useCallback((target: ReactFlowInstance) => {
    setInstance(target);
    apply(constrain(camera.current.reading), target);
  }, [apply, constrain]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The detail card is absolutely positioned, so ReactFlow's node dimensions
    // omit it. Measure its real box instead of reserving an empty 420px card.
    let observedPanel: HTMLElement | null = null;
    const observer = new ResizeObserver(() => measure());
    const measure = () => {
      const size = { width: container.clientWidth, height: container.clientHeight };
      if (!size.width || !size.height) return;
      const boxes = [contentBounds];
      const panel = container.querySelector<HTMLElement>('.react-flow__node [data-gft-detail]');
      if (panel !== observedPanel) {
        if (observedPanel) observer.unobserve(observedPanel);
        if (panel) observer.observe(panel);
        observedPanel = panel;
      }
      let pairBounds: ContentBounds | null = null;
      if (panel && instance) {
        const host = container.getBoundingClientRect();
        const view = instance.getViewport();
        const node = panel.closest<HTMLElement>('.react-flow__node')!;
        const nodeRect = node.getBoundingClientRect();
        const previous = placedPanel.current;
        // Body changes and dragging retain the chosen side. Only a new opening
        // or an explicit change to the available viewport selects it again.
        const reselect = previous?.panel !== panel || previous.size.width !== size.width
          || previous.size.height !== size.height || previous.zoom !== view.zoom;
        if (reselect || previous.nodeWidth !== nodeRect.width || previous.nodeHeight !== nodeRect.height) {
          const input = { size, zoom: view.zoom,
            node: { x: nodeRect.left - host.left, y: nodeRect.top - host.top,
              width: nodeRect.width, height: nodeRect.height } };
          const placement = reselect ? chooseDetailPlacement(input) : fitDetailPlacement(input, previous.side);
          panel.dataset.detailPlacement = placement.side;
          for (const [property, value] of Object.entries({
            left: placement.side === 'right' ? `calc(100% + ${DETAIL_PANEL_GAP}px)` : `${placement.left}px`,
            top: placement.side === 'below' ? `calc(100% + ${DETAIL_PANEL_BELOW_GAP}px)` : `${placement.top}px`,
            width: `${placement.width}px`, 'max-height': `${placement.maxHeight}px`,
          })) panel.style.setProperty(`--detail-${property}`, value);
          placedPanel.current = { panel, size, zoom: view.zoom, side: placement.side,
            nodeWidth: nodeRect.width, nodeHeight: nodeRect.height };
        }
        const rect = panel.getBoundingClientRect();
        const panelBounds = { x: (rect.left - host.left - view.x) / view.zoom,
          y: (rect.top - host.top - view.y) / view.zoom,
          width: rect.width / view.zoom, height: rect.height / view.zoom };
        boxes.push(panelBounds);
        pairBounds = unionBounds([panelBounds, {
          x: (nodeRect.left - host.left - view.x) / view.zoom,
          y: (nodeRect.top - host.top - view.y) / view.zoom,
          width: nodeRect.width / view.zoom, height: nodeRect.height / view.zoom,
        }]);
      } else {
        placedPanel.current = null;
      }
      const locked = camera.current.overview;
      const request = pendingCenter.current;
      if (request && !locked && pairBounds
        && panel?.closest('.react-flow__node')?.getAttribute('data-id') === request.panelId) {
        camera.current.reading = {
          x: size.width / 2 - (pairBounds.x + pairBounds.width / 2),
          y: size.height / 2 - (pairBounds.y + pairBounds.height / 2), zoom: 1,
        };
        pendingCenter.current = null;
      }
      if (pairBounds) {
        // Include the current (or explicitly requested) reading view so a new
        // card cannot force a small map to another origin. Replacing this guard
        // on each measurement avoids accumulating empty pan space.
        const reading = camera.current.reading;
        boxes.push({ x: VIEWPORT_PADDING - reading.x, y: VIEWPORT_PADDING - reading.y,
          width: Math.max(0, size.width - VIEWPORT_PADDING * 2),
          height: Math.max(0, size.height - VIEWPORT_PADDING * 2) });
      }
      const bounds = unionBounds(boxes);
      const next = { bounds, size };
      geometryRef.current = next;
      setGeometry(old => old.size.width === size.width && old.size.height === size.height
        && old.bounds.x === bounds.x && old.bounds.y === bounds.y
        && old.bounds.width === bounds.width && old.bounds.height === bounds.height ? old : next);
      // Expanding a node never reframes overview. Only a viewport resize adapts
      // the original overview bounds to the new available space.
      if (locked && (locked.size.width !== size.width || locked.size.height !== size.height)) {
        locked.viewport = overviewViewport(locked.bounds, size);
        locked.size = size;
      }
      const bounded = constrain(camera.current.reading);
      if (!locked) camera.current.reading = bounded;
      apply(bounded);
    };
    measureRef.current = measure;
    measure();
    observer.observe(container);
    // ReactFlow 11 applies controlled nodes in a passive effect. The card can
    // therefore mount after this parent layout effect, without resizing a node.
    const mutations = new MutationObserver(() => {
      if (container.querySelector('.react-flow__node [data-gft-detail]') !== observedPanel) measure();
    });
    mutations.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect(); mutations.disconnect();
      if (measureRef.current === measure) measureRef.current = null;
    };
  }, [containerRef, contentBounds, openPanelId, generation, instance, apply, constrain]);

  // ReactFlow transforms do not resize DOM boxes. Refit the open card once when
  // the user switches between overview and reading, after the camera applies.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => measureRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [overview]);

  const toggleOverview = useCallback(() => {
    if (!instance) return;
    const state = camera.current;
    pendingCenter.current = null;
    if (state.overview) {
      state.overview = null;
      state.reading = constrain(state.reading);
      apply(state.reading);
      setOverview(false);
    } else {
      const { bounds, size } = geometryRef.current;
      state.reading = clampReadingViewport(instance.getViewport(), bounds, size);
      state.overview = { bounds, size, viewport: overviewViewport(bounds, size) };
      apply(state.overview.viewport);
      setOverview(true);
    }
  }, [instance, constrain, apply]);

  const centerOn = useCallback((x: number, y: number, panelId?: string) => {
    if (camera.current.overview) return;
    if (panelId) {
      pendingCenter.current = { panelId };
      measureRef.current?.();
      return;
    }
    const { size } = geometryRef.current;
    const next = constrain({ x: size.width / 2 - x, y: size.height / 2 - y, zoom: 1 });
    camera.current.reading = next;
    apply(next);
  }, [constrain, apply]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !instance) return;
    const wheel = (event: WheelEvent) => {
      // Do not let ReactFlow swallow browser zoom, or the card's native scroll.
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest('.nowheel')) return;
      event.preventDefault();
      if (camera.current.overview) return;
      const { size } = geometryRef.current;
      const factor = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? size.height : 1;
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      const current = instance.getViewport();
      const next = constrain({ x: current.x - dx * factor, y: current.y - dy * factor, zoom: 1 });
      camera.current.reading = next;
      apply(next);
    };
    container.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => container.removeEventListener('wheel', wheel, { capture: true });
  }, [containerRef, instance, constrain, apply]);

  const translateExtent = useMemo<[[number, number], [number, number]]>(() => {
    const locked = camera.current.overview;
    if (!locked) return readingExtent(geometryRef.current.bounds, geometryRef.current.size);
    const { x, y, zoom } = locked.viewport;
    // Keep ReactFlow's own initialization constraint at the frozen camera too.
    return [[-x / zoom, -y / zoom],
      [(geometry.size.width - x) / zoom, (geometry.size.height - y) / zoom]];
  }, [geometry, overview, generation]);
  return { overview, toggleOverview, onInit, onMove, centerOn, translateExtent,
    ready: geometry.size.width > 0 && geometry.size.height > 0,
    defaultViewport: camera.current.overview?.viewport ?? camera.current.reading };
}
