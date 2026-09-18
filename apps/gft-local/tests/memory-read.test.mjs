import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {appendSourceLog} from '../dist/core.mjs';
import {sourcePage} from '../memory.mjs';
import * as store from '../store.mjs';
import {createConnections} from '../connections.mjs';

test('索引→单主题正文→节点和来源回查；跨会话隔离且详情不误记整份已读',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'gft-memory-read-'));
  const before=process.env.GFT_LOCAL_HOME; process.env.GFT_LOCAL_HOME=dir;
  try {
    const source={provider:'codex',id:'test-original',title:'测试'};
    const api=createConnections({readers:{getChatSession:async()=>source,getChatHead:async()=>null}});
    const a=await store.createTopic('甲','只讨论产品'),b=await store.createTopic('乙','另一份');
    const changed=await store.saveDoc(a.id,a.revision,'## 主题\n只讨论产品\n\n## 主线\n正文只出现一次。\n\n### ◇ 保留本地运行\n离线也能用。');
    await api.connectSource({source,topicIds:[a.id,b.id],history:'all',writeProjectId:b.id});
    const identity={provider:'codex',sessionId:source.id};
    await assert.rejects(api.readConnectedContext(identity),{status:400});
    const index=await api.listConnections(identity);
    assert.ok(index.every(item=>item.loadedRevision===null));
    assert.equal(index.find(item=>item.topicId===a.id).topic.summary,'正文只出现一次。');
    assert.ok(index.every(item=>item.topic.document===undefined && item.topic.raw===undefined));
    assert.deepEqual(await api.listConnections({...identity,sessionId:'unrelated'}),[]);
    const nodes=await api.readConnectedContext({...identity,topicId:a.id,nodeIds:[changed.graph.nodes[0].id]});
    assert.equal(nodes.nodes[0].content,changed.graph.nodes[0].content);
    const sources=await api.readConnectedSources({...identity,topicId:a.id});
    assert.match(sources.text,/正文只出现一次/);
    assert.ok((await api.listConnections(identity)).every(item=>item.loadedRevision===null));
    await assert.rejects(api.readConnectedSources({...identity,sessionId:'other',topicId:a.id}),{status:404});
    const read=await api.readConnectedContext({...identity,topicId:a.id});
    assert.equal(read.projects.length,1);
    assert.equal(read.projects[0].document,changed.doc);
    assert.ok(read.projects[0].graph.nodes.every(node=>node.body===undefined && node.content===undefined));
    assert.equal((await api.listConnections(identity)).find(item=>item.topicId===b.id).loadedRevision,null);
    const next=await store.saveDoc(a.id,changed.revision,changed.doc.replace('正文只出现一次','用户新修正'));
    assert.equal((await api.listConnections(identity)).find(item=>item.topicId===a.id).topic.summary,'用户新修正。');
    const reread=await api.readConnectedContext({...identity,topicId:a.id});
    assert.equal(reread.projects[0].revision,next.revision);
    assert.match(reread.projects[0].document,/用户新修正/);
    await store.archiveTopic(b.id,b.revision);
    assert.deepEqual((await api.listConnections(identity)).map(item=>item.topicId),[a.id]);
    assert.equal((await api.readConnectedContext({...identity,topicId:a.id})).writeProjectId,null,'归档的旧写入目标不能继续推荐给 Agent');
  } finally {
    if(before===undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME=before;
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(dir,{recursive:true,force:true});
  }
});

test('长来源分页无缺字、主题隔离、旧版标记，追加后可继续，改写后拒绝旧游标',()=>{
  const record={v:1,provider:'codex',sessionId:'s',id:'m1',role:'user',content:'长材料🙂'.repeat(7000)};
  const raw=appendSourceLog('旧记录\n## 不能丢的旧标题\n旧正文',[record]);
  let page=sourcePage('topic',raw),all=page.text;
  const first=page;
  assert.ok(page.hasMore); assert.ok(page.text.length<=12000);
  while(page.nextCursor) {page=sourcePage('topic',raw,page.nextCursor); all+=page.text;}
  assert.match(all,/不能丢的旧标题/); assert.match(all,/不是完整原文/);
  assert.ok(all.includes(record.content)); assert.doesNotMatch(all,/�/);
  assert.throws(()=>sourcePage('other',raw,first.nextCursor));
  assert.throws(()=>sourcePage('topic',raw.replace('长材料','已修正'),first.nextCursor));
  assert.doesNotThrow(()=>sourcePage('topic',appendSourceLog(raw,[{...record,id:'m2',content:'追加'}]),first.nextCursor));
});
