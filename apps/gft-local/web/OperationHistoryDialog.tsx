import {useCallback,useEffect,useState,useSyncExternalStore} from 'react';
import {useT} from '../../../src/i18n';
import {LocalDialog,ReceiptDetails} from './ConnectionManager';
import type {createLocalRuntime,UpdateReceipt} from './localRuntime';
type Runtime=ReturnType<typeof createLocalRuntime>;
type History={topicId:string;currentRevision:number;operations:UpdateReceipt[]};
const names:Record<string,string>={update:'更新',tidy:'整理',redraw:'重画',edit:'编辑',doc:'编辑正文',graph:'编辑节点或连线',rename:'重命名'};
export function OperationHistoryDialog({runtime,topicId,onClose}:{runtime:Runtime;topicId:string;onClose():void}) {
  const tr=useT(),[history,setHistory]=useState<History|null>(null),[error,setError]=useState('');
  const status=useSyncExternalStore(runtime.receipts.subscribe,runtime.receipts.getSnapshot);
  const refresh=useCallback(async()=>{const result=await runtime.request<History>(`/api/topics/${encodeURIComponent(topicId)}/operations`);setHistory(result);},[runtime,topicId]);
  useEffect(()=>{let active=true;void runtime.request<History>(`/api/topics/${encodeURIComponent(topicId)}/operations`).then(result=>{if(active)setHistory(result);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[runtime,topicId]);
  const blocked=runtime.receipts.rollbackBlocked();
  return <LocalDialog title={tr('操作历史')} wide onClose={onClose}>
    <p className="gft-local-note">{tr('查看更新、整理和编辑的实际变化；按顺序撤回。原始材料和读取进度保留。')}</p>
    {error&&<p role="alert" className="gft-local-error">{tr(error)}</p>}
    {!history&&!error&&<p>{tr('正在读取…')}</p>}
    {history?.operations.length===0&&<p>{tr('后续的内容修改会记录在这里。')}</p>}
    <div className="gft-local-operation-list">{history?.operations.map(item=><details key={item.id} className="gft-local-operation-item"><summary>{tr(names[item.action]||'编辑')} · {new Date(item.createdAt).toLocaleString()}{item.rolledBackAt?` · ${tr('已撤回')}`:''}</summary>
      <ReceiptDetails receipt={item} runtime={runtime} onNavigate={onClose}/>
      {!item.rolledBackAt&&<button disabled={!!blocked||!item.canRollback||status.rollingBack} title={blocked||item.rollbackBlockedReason||''} onClick={()=>{setError('');void runtime.receipts.rollbackOperation(item.id,history.currentRevision).then(refresh).catch(async e=>{setError(e.message);try{await refresh();}catch{}});}}>{tr(status.rollingBack?'正在撤回…':'撤回此操作')}</button>}
      {!item.rolledBackAt&&(blocked||item.rollbackBlockedReason)&&<p className="gft-local-note">{tr(blocked||item.rollbackBlockedReason||'')}</p>}
    </details>)}</div>
    <p className="gft-local-note">{tr('保留最近 30 次可撤回的内容操作。')}</p>
  </LocalDialog>;
}
