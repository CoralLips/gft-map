import {RELATION_REASON_LIMIT} from '../../../service/relationReason';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useT} from '../../../i18n';
import styles from './ExploreTreeNode.module.css';
export interface NodeRelation {id:string;reason:string;pending?:boolean;selected?:boolean}
export function RelationReason({relation,onChange,onEditing,onExplain,onCancel,onHover,onSelect}:{relation:NodeRelation;onHover?(id:string|null):void;onSelect?(id:string):void;onExplain?(id:string):void;onCancel?(id:string):void;onChange?(id:string,text:string):void;onEditing?(id:string|null):void}) {
 const tr=useT(),[draft,setDraft]=useState(relation.reason),[editing,setEditing]=useState(false),cancel=useRef(false),input=useRef<HTMLTextAreaElement>(null);
 useLayoutEffect(()=>{
   const textarea=input.current;if(!textarea)return;
   const resize=()=>{textarea.style.height="auto";textarea.style.height=(textarea.scrollHeight+2)+"px";};
   resize();
   const observer=new ResizeObserver(resize);observer.observe(textarea);
   return ()=>observer.disconnect();
 },[draft]);
 useLayoutEffect(()=>{
   if(!relation.selected||!input.current)return;
   const scroll=input.current.closest<HTMLElement>('[data-gft-detail-scroll]');
   if(!scroll)return;
   const row=input.current.getBoundingClientRect(),box=scroll.getBoundingClientRect();
   if(row.top<box.top)scroll.scrollTop-=box.top-row.top+4;
   else if(row.bottom>box.bottom)scroll.scrollTop+=row.bottom-box.bottom+4;
 },[relation.selected]);
 useEffect(()=>{if(!editing)setDraft(relation.reason);},[relation.reason,editing]);
 useEffect(()=>()=>{if(editing)onEditing?.(null);},[editing,onEditing]);
 return <div className={`${styles.nodeRelation} ${(relation.pending || (!relation.reason && onExplain)) ? styles.nodeRelationWithControl : ''}`} data-gft-relation-id={relation.id} data-selected={!!relation.selected} aria-busy={!!relation.pending} onClick={()=>onSelect?.(relation.id)} onMouseEnter={()=>onHover?.(relation.id)} onMouseLeave={()=>onHover?.(null)}>
   {relation.pending ? <button className={styles.relationWait} aria-label={tr('取消承接分析')} title={tr('正在分析这条承接，点击取消')} onClick={()=>onCancel?.(relation.id)}><span className={styles.relationSpinner}/></button> : !relation.reason && onExplain ? <button className={styles.relationWait} aria-label={tr('AI 说明承接')} title={tr('AI 说明这两点怎样承接')} onClick={()=>onExplain(relation.id)}>✨</button> : <button className={styles.relationSymbolButton} aria-label={tr('选中这条连线')} title={tr('点击选中这条承接线')}><svg className={styles.relationSymbol} viewBox="0 0 16 14" width="14" height="14" aria-label={tr('关联线段')}><title>{tr('这条承接线')}</title><circle cx="3" cy="3" r="1.6"/><path d="M4.8 3H7.5Q9 3 9 4.5V9.5Q9 11 10.5 11H11.2"/><circle cx="13" cy="11" r="1.6"/></svg></button>}

   <textarea ref={input} aria-label={tr('承接说明')} maxLength={RELATION_REASON_LIMIT*2} rows={draft.length>60?3:1} placeholder={tr(relation.pending?'正在分析承接…':'说明这两点怎样承接…')} value={draft} readOnly={!onChange || relation.pending}
    onFocus={()=>{onSelect?.(relation.id);if(relation.pending)return;cancel.current=false;setEditing(true);onEditing?.(relation.id);}}
    onChange={e=>{if(Array.from(e.target.value).length<=RELATION_REASON_LIMIT || Array.from(e.target.value).length<Array.from(draft).length)setDraft(e.target.value);}}
    onBlur={()=>{if(relation.pending)return;if(!cancel.current)onChange?.(relation.id,draft);else setDraft(relation.reason);setEditing(false);onEditing?.(null);}}
    onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel.current=true;e.currentTarget.blur();}else if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();e.currentTarget.blur();}}}/>
 </div>;
}
