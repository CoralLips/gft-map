import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as store from '../store.mjs';
import {readSourceLog} from '../dist/core.mjs';

test('文本导入成为新文稿，原文进 Log；完整备份恢复为副本，无效来源不半途建档',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'gft-import-test-')),before=process.env.GFT_LOCAL_HOME;
  process.env.GFT_LOCAL_HOME=dir;
  try {
    const text='## 主题\n只讨论产品\n\n## 主线\n这是手工写的想法，先保留再整理。\n\n### ◇ 本地优先\n网络不可用也能打开。';
    const a=await store.importTopic({format:'gft-document',version:1,name:'试验文稿',text});
    assert.match(a.doc,/这是手工写的想法/);assert.equal(a.scope,'只讨论产品');
    assert.equal(a.graph.nodes.length,1);
    assert.equal(readSourceLog((await store.history(a.id)).raw)[0].content,text);
    const bundle=await store.exportTopic(a.id),b=await store.importTopic(bundle);
    assert.notEqual(a.id,b.id); assert.equal(b.doc,a.doc);assert.deepEqual(b.graph,a.graph);
    await assert.rejects(store.importTopic({...bundle,sources:[{layer:'bad'}]}));
    assert.equal((await store.listTopics()).length,2);
    assert.equal((await store.listTasks()).length,0);
    await assert.rejects(store.importTopic({format:'gft-document',version:1,name:'空',text:' '}));
  } finally {
    if(before===undefined) delete process.env.GFT_LOCAL_HOME; else process.env.GFT_LOCAL_HOME=before;
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});
  }
});
