import { useRef, useState } from 'react';
import { LocalDialog } from './ConnectionManager';
import { parseTopicBundle } from '../../../src/service/topicBundle';
import { t, useT } from '../../../src/i18n';

type Item = { id:number; name:string; payload:unknown; file?:File; state:'ready'|'done'|'error'; error?:string };
export function parseImport(text:string, filename?:string):unknown {
  const clean=text.replace(/^\uFEFF/,'');
  if (!clean.trim()) throw new Error('内容为空');
  if (filename?.toLowerCase().endsWith('.json') || /^\s*[[{]/.test(clean)) {
    let value;
    try { value=JSON.parse(clean); } catch { if(filename?.toLowerCase().endsWith('.json')) throw new Error('JSON 文件无法解析'); }
    if (value !== undefined) {
      return parseTopicBundle(value);
    }
  }
  if(clean.length>1000000) throw new Error('文稿最多 100 万字符');
  return {format:'gft-document',version:1,name:filename?.replace(/\.(md|txt)$/i,'') || t('导入的脉络'),text:clean};
}

export function ImportDialog({importTopic,importMaterial,onClose}:{importTopic:(bundle:unknown)=>Promise<string>;importMaterial?:(file:File)=>Promise<void>;onClose:()=>void}) {
  const tr = useT();
  const [tab,setTab]=useState<'files'|'text'>('files');
  const [items,setItems]=useState<Item[]>([]);
  const [text,setText]=useState('');
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [reading,setReading]=useState(false);
  const [dragging,setDragging]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [messageValues,setMessageValues]=useState<Record<string,string | number>>({});
  const ref=useRef<HTMLInputElement>(null);
  const nextId=useRef(0);
  const add=async(files:File[])=>{
    if(busy || reading) return;
    setReading(true);setError('');setMessage('');
    try {
      const incoming:Item[]=[];
      for(const file of files) {
        const id=++nextId.current;
        try {
          if(importMaterial&&/\.(md|txt|markdown|jsonl|ndjson|gftpack)$/i.test(file.name)) {
            incoming.push({id,name:file.name,payload:true,file,state:'ready'});continue;
          }
          if(importMaterial&&/\.json$/i.test(file.name)&&!file.name.toLowerCase().endsWith('.gft.json')&&!/"format"\s*:\s*"gft-theme"/.test(await file.slice(0,4096).text())) {
            incoming.push({id,name:file.name,payload:true,file,state:'ready'});continue;
          }
          if(!/\.(json|md|txt)$/i.test(file.name)) throw new Error('支持 .json、.md 和 .txt 文件');
          if(file.size>4*1024*1024) throw new Error('单个文件最多 4 MB');
          incoming.push({id,name:file.name,payload:parseImport(await file.text(),file.name),state:'ready'});
        } catch(e) {incoming.push({id,name:file.name,payload:null,state:'error',error:e instanceof Error?e.message:String(e)});}
      }
      setItems(current=>[...current,...incoming]);
    } finally {setReading(false);}
  };
  const run=async()=>{
    setBusy(true);setError('');setMessage('');
    try {
      if(tab==='text') {
        const payload=parseImport(text) as {format:string;name?:string};
        if(payload.format==='gft-document') payload.name=name.trim() || t('导入的脉络');
        await importTopic(payload);setText('');setName('');setMessage('已导入并打开新脉络。');
      } else {
        let done=0,failed=0;
        for(const item of items.filter(item=>item.payload && item.state!=='done')) {
          setMessage('正在导入 {name}…'); setMessageValues({name:item.name});
          try {
            if(item.file&&importMaterial)await importMaterial(item.file);else await importTopic(item.payload); done++;
            setItems(current=>current.map(row=>row.id===item.id?{...row,state:'done',error:undefined}:row));
          } catch(e) {
            failed++;
            setItems(current=>current.map(row=>row.id===item.id?{...row,state:'error',error:e instanceof Error?e.message:String(e)}:row));
          }
        }
        setMessage(failed ? '已导入 {done} 份，{failed} 份失败，可重试。' : '已导入 {done} 份。'); setMessageValues({done,failed});
      }
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {setBusy(false);}
  };
  return <LocalDialog title={tr('导入脉络')} onClose={onClose} closeDisabled={busy || reading}>
    <div className="gft-local-provider-tabs" role="group" aria-label={tr('导入方式')}>
      <button disabled={busy || reading} aria-pressed={tab==='files'} onClick={()=>{setTab('files');setError('');setMessage('');}}>{tr('文件')}</button>
      <button disabled={busy || reading} aria-pressed={tab==='text'} onClick={()=>{setTab('text');setError('');setMessage('');}}>{tr('粘贴内容')}</button>
    </div>
    <p className="gft-local-note">{tr(importMaterial?'GFT 文件恢复为新脉络；文本和聊天记录加入当前脉络，分批整理。':'每份文件会成为一条新脉络。GFT 脉络包保留图文与来源；文本进入文稿，可再点击「整理」。')}</p>
    {tab==='files'?<>
      <div className="gft-local-import-drop" data-dragging={dragging} onDragOver={e=>{e.preventDefault();if(!busy && !reading) setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);void add([...e.dataTransfer.files]);}}>
        <p>{tr('把文件拖到这里')}</p><button disabled={busy || reading} onClick={()=>ref.current?.click()}>{tr(reading?'正在读取…':'选择文件')}</button>
        <small>{tr('支持多选 · GFT .json / .md / .txt')}</small>
      </div>
      <input ref={ref} hidden style={{display:'none'}} type="file" multiple accept=".json,.md,.txt,.markdown,.jsonl,.ndjson,.gftpack" onChange={e=>{const files=[...(e.target.files || [])];e.target.value='';void add(files);}} />
      {!!items.length && <ul className="gft-local-import-list">{items.map(item=><li key={item.id}><div><span>{item.name}</span><small className={item.error?'gft-local-error':''}>{tr(item.error || (item.state==='done'?'已导入':'待导入'))}</small></div><button disabled={busy} aria-label={tr('移除 {name}', {name:item.name})} onClick={()=>setItems(current=>current.filter(row=>row.id!==item.id))}>×</button></li>)}</ul>}
    </>:<>
      <label>{tr('名称（可选）')}<input value={name} disabled={busy} onChange={e=>setName(e.target.value)} placeholder={tr('导入的脉络')} /></label>
      <label>{tr('内容')}<textarea rows={8} value={text} disabled={busy} onChange={e=>setText(e.target.value)} placeholder={tr('粘贴文稿、Markdown，或完整的 GFT 脉络包…')} /></label>
    </>}
    {error && <p role="alert" className="gft-local-error">{tr(error)}</p>}
    {message && <p role="status" className="gft-local-note">{tr(message,messageValues)}</p>}
    <div className="gft-local-dialog-actions"><button disabled={reading} onClick={onClose}>{tr('关闭')}</button><button className="gft-local-primary" disabled={busy || reading || (tab==='text'?!text.trim():!items.some(item=>item.payload && item.state!=='done'))} onClick={()=>void run()}>{tr(busy?'正在导入…':'导入')}</button></div>
  </LocalDialog>;
}
