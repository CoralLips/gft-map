import {useEffect,useRef,useState} from 'react';
import {useT} from '../../../src/i18n';
import {LocalDialog} from './ConnectionManager';
import {localRequest} from './localRuntime';

export interface Material {id:string;topicId:string;name:string;size:number;received:number;processed:number;batches:number;state:string;error?:string;kind:string;pendingEdits?:number[];pauseAfterUpload?:boolean}
interface Page {id:string;start:number;end:number;text:string;size:number;etag:string}
const uploads=new Map<string,AbortController>();
const isUploading=(id:string)=>!!uploads.get(id)&&!uploads.get(id)!.signal.aborted;
const chunkSize=512*1024;
const percentage=(job:Material)=>{const value=100*(job.state==='uploading'?job.received:job.processed)/job.size;return value>0&&value<1?'<1':Math.floor(value);};
const labels:Record<string,string>={uploading:'正在保存原文件',queued:'等待整理',running:'正在整理',paused:'已暂停',failed:'需要继续',completed:'已完成',ready:'已保存'};
export async function addMaterial(file:File,topicId:string,existingId?:string) {
  const jobs=await localRequest<Material[]>(`/api/materials?topicId=${encodeURIComponent(topicId)}`);
  let job=existingId?jobs.find(j=>j.id===existingId):jobs.find(j=>j.state==='uploading'&&j.name===file.name&&j.size===file.size);
  if(existingId&&!job)throw new Error('材料不存在');
  if(job&&(job.name!==file.name||job.size!==file.size))throw new Error('请选择同一份原文件继续上传');
  job ||= await localRequest<Material>('/api/materials',{topicId:topicId||undefined,name:file.name,size:file.size,kind:file.name.toLowerCase().endsWith('.gftpack')?'archive':'text'});
  if(uploads.has(job.id))return job;
  const controller=new AbortController();uploads.set(job.id,controller);
  window.dispatchEvent(new Event('gft-materials'));
  try {
    if(job.pauseAfterUpload)await localRequest(`/api/materials/${job.id}/resume`,{},controller.signal);
    // Recheck already received blocks too: file name/size is not content identity.
    for(let offset=0;offset<file.size;offset+=chunkSize) {
      const response=await fetch(`/api/materials/${job.id}/upload?offset=${offset}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+chunkSize),signal:controller.signal});
      const data=await response.json();if(!response.ok)throw new Error(data.error);
    }
    const finished=await localRequest<Material>(`/api/materials/${job.id}/finish`,{},controller.signal);
    if(finished.kind==='archive') {
      const topic=await localRequest<{id:string}>(`/api/materials/${job.id}/restore`,{},controller.signal);
      return {...finished,topicId:topic.id};
    }
    return finished;
  }finally{uploads.delete(job.id);window.dispatchEvent(new Event('gft-materials'));}
}

export function Materials({topicId}:{topicId:string|null}) {
  const tr=useT();
  const [jobs,setJobs]=useState<Material[]>([]),[opened,setOpened]=useState(false),[error,setError]=useState('');
  const [page,setPage]=useState<Page|null>(null),[text,setText]=useState(''),[trail,setTrail]=useState<number[]>([]);
  const [busy,setBusy]=useState(false);
  const [executor,setExecutor]=useState(true);
  const files=useRef<HTMLInputElement>(null),resumeId=useRef<string>(),lastProject=useRef(topicId);
  const mutations=useRef(new Set<string>());
  const refresh=async()=>{
    if(!topicId)return;
    const data=await localRequest<Material[]>(`/api/materials?topicId=${encodeURIComponent(topicId)}`);
    if(lastProject.current===topicId)setJobs(old=>data.map(j=>mutations.current.has(j.id)?old.find(o=>o.id===j.id)||j:j));
  };
  useEffect(()=>{
    lastProject.current=topicId;setJobs([]);setPage(null);setError('');setOpened(false);
    let alive=true,polling=false;
    const poll=async()=>{if(!topicId||polling)return;polling=true;try{
      const data=await localRequest<Material[]>(`/api/materials?topicId=${encodeURIComponent(topicId)}`);
      if(alive)setJobs(old=>data.map(j=>mutations.current.has(j.id)?old.find(o=>o.id===j.id)||j:j));
    }catch{/* A disconnected server must not erase saved progress. */}finally{polling=false;}};
    void poll();const timer=setInterval(()=>void poll(),1500);window.addEventListener('gft-materials',poll);
    void localRequest<{mode:string}>('/api/runtime').then(value=>{if(alive)setExecutor(value.mode==='automatic');}).catch(()=>{});
    return()=>{alive=false;clearInterval(timer);window.removeEventListener('gft-materials',poll);};
  },[topicId]);
  const control=async(job:Material,action:'pause'|'resume')=>{
    if(job.state==='uploading'&&!isUploading(job.id)) {resumeId.current=job.id;files.current?.click();return;}
    if(job.state==='uploading'){uploads.get(job.id)?.abort();action='pause';}
    mutations.current.add(job.id);setJobs(current=>current.map(j=>j.id===job.id?{...j,state:job.state==='uploading'?'uploading':action==='pause'?'paused':'queued',error:undefined}:j));setError('');
    try{await localRequest(`/api/materials/${job.id}/${action}`,{});}catch(e){setError(String(e));}
    finally{mutations.current.delete(job.id);void refresh();}
  };
  const discard=async(job:Material)=>{
    uploads.get(job.id)?.abort();setError('');
    mutations.current.add(job.id);setJobs(current=>current.filter(j=>j.id!==job.id));
    try{await localRequest(`/api/materials/${job.id}/discard`,{});}catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{mutations.current.delete(job.id);void refresh();}
  };
  const add=async(selected:File[])=>{
    if(!topicId)return;setError('');
    try{for(const file of selected)await addMaterial(file,topicId,resumeId.current);}
    catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:String(e));}
    finally{resumeId.current=undefined;void refresh();}
  };
  const readPage=async(id:string,start:number)=>{setBusy(true);setError('');try{const next=await localRequest<Page>(`/api/materials/${id}/page?start=${start}`);setPage(next);setText(next.text);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const save=async()=>{
    if(!page||text===page.text)return true;
    setBusy(true);setError('');
    try{const next=await localRequest<Page>(`/api/materials/${page.id}/edit`,{start:page.start,end:page.end,etag:page.etag,text});setPage(next);setText(next.text);return true;}
    catch(e){setError(String(e));return false;}finally{setBusy(false);}
  };
  const active=jobs.find(j=>j.state==='running')||jobs.find(j=>['uploading','queued','paused','failed'].includes(j.state));
  const processing=jobs.some(j=>['running','queued'].includes(j.state)||(j.state==='uploading'&&isUploading(j.id)));
  const controlAll=async()=>{
    const affected=jobs.filter(j=>processing?['running','queued'].includes(j.state)||(j.state==='uploading'&&isUploading(j.id)):['paused','failed'].includes(j.state));
    if(!affected.length&&active){await control(active,'resume');return;}
    for(const job of affected)await control(job,processing?'pause':'resume');
  };
  const progress=active?percentage(active):null;
  const selected=jobs.find(j=>j.id===page?.id);
  return <>
    <span className="gft-material-control">
      <button disabled={!topicId} onClick={()=>setOpened(true)}>{tr('材料')}{active?` · ${progress}%`:jobs.length?` · ${jobs.length}`:' ＋'}</button>
      {active&&<button aria-label={tr(processing?'暂停':'继续')} onClick={()=>void controlAll()}>{tr(processing?'暂停':active.state==='uploading'?'续传':'继续')}</button>}
    </span>
    {opened&&<LocalDialog title={tr('主题材料')} wide onClose={()=>{void save().then(ok=>{if(ok){setOpened(false);setPage(null);}});}}>
      <p className="gft-local-note">{tr('原文件保存完成后，按主题分批整理，每批完成即存档。可随时暂停；关闭页面后，本地服务继续处理。')}</p>
      <p className="gft-local-note">{tr('文件原文与处理进度保存在本机，下载完整存档可带走；云端同步仍包含主题、Doc／Map 和 Log。')}</p>
      {!executor&&<p className="gft-local-note">{tr('材料会先保存。请让 Agent 启动带执行器的面板，再继续整理。')}</p>}
      {!page?<>
        <div className="gft-local-import-drop" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void add([...e.dataTransfer.files]);}}>
          <button onClick={()=>{resumeId.current=undefined;files.current?.click();}}>{tr('添加文件')}</button>
          <small>{tr('拖入 UTF-8 文本、Markdown 或聊天记录；原文保存到本机。')}</small>
        </div>
        <ul className="gft-material-list">{jobs.map(job=><li key={job.id}>
          <div><strong>{job.name}</strong><span>{tr(job.state==='uploading'&&!isUploading(job.id)?'等待续传':labels[job.state]||job.state)} · {percentage(job)}%</span></div>
          <progress max={job.size} value={job.state==='uploading'?job.received:job.processed}/>
          <small>{tr('已存档 {count} 批，右侧内容已保留。',{count:job.batches})}</small>
          {job.error&&<p role="alert" className="gft-local-error">{tr(job.error)}</p>}
          <div className="gft-material-buttons">
            {(job.state!=='completed'||!!job.pendingEdits?.length)&&<button onClick={()=>void control(job,['running','queued'].includes(job.state)?'pause':'resume')}>{tr(['running','queued'].includes(job.state)?'暂停':job.state==='uploading'?(isUploading(job.id)?'暂停':'选择原文件续传'):job.pendingEdits?.length?'应用修正并继续':'继续')}</button>}
            {job.state!=='uploading'&&<button onClick={()=>{setTrail([]);void readPage(job.id,0);}}>{tr('查看原文')}</button>}
            {job.state==='uploading'&&<button onClick={()=>void discard(job)}>{tr('取消导入')}</button>}
          </div>
        </li>)}</ul>
      </>:<>
        <div className="gft-material-buttons"><button disabled={busy} onClick={()=>void save().then(ok=>{if(ok)setPage(null);})}>{tr('返回材料')}</button><strong>{selected?.name}</strong><span>{page.start.toLocaleString()}–{page.end.toLocaleString()} / {page.size.toLocaleString()}</span></div>
        <p className="gft-local-note">{tr('暂停后可修改这一段。保存后点击「应用修正并继续」，图文才跟着调整。')}</p>
        <textarea className="gft-material-text" aria-label={tr('材料原文')} value={text} readOnly={!selected||!['paused','failed','completed'].includes(selected.state)} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void save();}}}/>
        <div className="gft-material-buttons"><button disabled={busy||!trail.length} onClick={()=>void save().then(ok=>{if(ok){const previous=trail.at(-1)!;setTrail(v=>v.slice(0,-1));void readPage(page.id,previous);}})}>{tr('上一段')}</button><button disabled={busy||page.end===page.size} onClick={()=>void save().then(ok=>{if(ok){setTrail(v=>[...v,page.start]);void readPage(page.id,page.end);}})}>{tr('下一段')}</button><button disabled={busy||text===page.text} onClick={()=>void save()}>{tr('保存')}</button></div>
      </>}
      {error&&<p className="gft-local-error" role="alert">{tr(error)}</p>}
    </LocalDialog>}
    <input ref={files} type="file" accept=".txt,.md,.markdown,.jsonl,.ndjson,.json" multiple hidden style={{display:'none'}} onChange={e=>{const selected=[...(e.target.files||[])];e.target.value='';void add(selected);}}/>
  </>;
}
