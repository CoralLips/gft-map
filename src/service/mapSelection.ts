/** Apply canvas selection deltas without turning hover into selection. */
export type SelectionChange={type:string;id?:string;selected?:boolean};
export function changedSelection(current:Set<string>,changes:SelectionChange[]):string[] {
  const next=new Set(current);
  for(const change of changes) {
    if(!change.id)continue;
    if(change.type==='remove'||(change.type==='select'&&!change.selected))next.delete(change.id);
    else if(change.type==='select'&&change.selected)next.add(change.id);
  }
  return [...next];
}
