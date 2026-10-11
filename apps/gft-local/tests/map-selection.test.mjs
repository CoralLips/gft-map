import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const b=await build({entryPoints:[fileURLToPath(new URL('../../../src/service/mapSelection.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {changedSelection:next}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
test('multiple selected edges coexist without replacing the first selection',()=>{
  assert.deepEqual(next(new Set(['a-b']),[{type:'select',id:'c-d',selected:true}]),['a-b','c-d']);
});
test('deselecting one edge preserves the other selected objects',()=>{
  assert.deepEqual(next(new Set(['a-b','c-d']),[{type:'select',id:'a-b',selected:false}]),['c-d']);
});
test('removing the selected edge removes its operation target',()=>{
  assert.deepEqual(next(new Set(['a-b']),[{type:'remove',id:'a-b'}]),[]);
});
test('hover and unrelated geometry changes never alter selection',()=>{
  assert.deepEqual(next(new Set(['a-b']),[{type:'position',id:'c-d'}]),['a-b']);
});
