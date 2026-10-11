/** Hover only highlights itself. Persistent selection is independent. */
export interface HighlightEdge {id:string;from:string;to:string}
export function mapHighlights({edges,hoverNodeId,hoveredEdgeId,selectedEdgeIds=[]}:{edges:HighlightEdge[];hoverNodeId:string|null;hoveredEdgeId:string|null;selectedEdgeIds?:string[]}) {
  const ids=new Set(edges.map(e=>e.id));
  const edgeIds=new Set(selectedEdgeIds.filter(id=>ids.has(id)));
  const hovered=hoveredEdgeId!==null&&ids.has(hoveredEdgeId);
  if(hovered)edgeIds.add(hoveredEdgeId!);
  const nodeId=hovered?null:hoverNodeId;
  return {nodeId,edgeIds,hasFocus:nodeId!==null||edgeIds.size>0};
}
