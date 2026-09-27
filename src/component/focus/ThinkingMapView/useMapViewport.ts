import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ReactFlowInstance, Viewport } from 'reactflow';
import { clampReadingViewport, overviewViewport, readingExtent, unionBounds, type ContentBounds, type ViewportSize } from './viewport';

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
  const pendingCenter = useRef<{ x: number; y: number; panelId: string } | null>(null);
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
      const panel = container.querySelector<HTMLElement>('.react-flow__node .nowheel');
      if (panel !== observedPanel) {
        if (observedPanel) observer.unobserve(observedPanel);
        if (panel) observer.observe(panel);
        observedPanel = panel;
      }
      if (panel && instance) {
        const rect = panel.getBoundingClientRect();
        const host = container.getBoundingClientRect();
        const view = instance.getViewport();
        boxes.push({ x: (rect.left - host.left - view.x) / view.zoom,
          y: (rect.top - host.top - view.y) / view.zoom,
          width: rect.width / view.zoom, height: rect.height / view.zoom });
      }
      const bounds = unionBounds(boxes);
      const next = { bounds, size };
      geometryRef.current = next;
      setGeometry(old => old.size.width === size.width && old.size.height === size.height
        && old.bounds.x === bounds.x && old.bounds.y === bounds.y
        && old.bounds.width === bounds.width && old.bounds.height === bounds.height ? old : next);
      const locked = camera.current.overview;
      // Expanding a node never reframes overview. Only a viewport resize adapts
      // the original overview bounds to the new available space.
      if (locked && (locked.size.width !== size.width || locked.size.height !== size.height)) {
        locked.viewport = overviewViewport(locked.bounds, size);
        locked.size = size;
      }
      const request = pendingCenter.current;
      if (request && !locked && panel?.closest('.react-flow__node')?.getAttribute('data-id') === request.panelId) {
        camera.current.reading = { x: size.width / 2 - request.x, y: size.height / 2 - request.y, zoom: 1 };
        pendingCenter.current = null;
      }
      const bounded = constrain(camera.current.reading);
      if (!locked) camera.current.reading = bounded;
      apply(bounded);
    };
    measure();
    observer.observe(container);
    // ReactFlow 11 applies controlled nodes in a passive effect. The card can
    // therefore mount after this parent layout effect, without resizing a node.
    const mutations = new MutationObserver(() => {
      if (container.querySelector('.react-flow__node .nowheel') !== observedPanel) measure();
    });
    mutations.observe(container, { childList: true, subtree: true });
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [containerRef, contentBounds, openPanelId, generation, instance, apply, constrain]);

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
    if (panelId && containerRef.current?.querySelector('.react-flow__node .nowheel')
      ?.closest('.react-flow__node')?.getAttribute('data-id') !== panelId) {
      pendingCenter.current = { x, y, panelId };
      return;
    }
    const { size } = geometryRef.current;
    const next = constrain({ x: size.width / 2 - x, y: size.height / 2 - y, zoom: 1 });
    camera.current.reading = next;
    apply(next);
  }, [constrain, apply, containerRef]);

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
