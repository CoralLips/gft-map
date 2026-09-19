import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccount } from '../account.mjs';
import {writeFile} from 'node:fs/promises';

async function fixture(run, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-account-'));
  const calls = [];
  const account = createAccount({ home, fetchImpl: async (url, init) => {
    calls.push({ url, body: init?.body });
    if (url.endsWith('/api/agent-config')) return Response.json({ url: 'https://test.supabase.co', anonKey: 'public-key' });
    return Response.json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600, user: { id: 'user-a', email: 'test@example.test' } });
  }, ...options });
  try { await run({ home, account, calls }); }
  finally { account.close(); assert.ok(home.startsWith(tmpdir())); await rm(home, { recursive: true, force: true }); }
}
function callback(url, state, origin = 'https://gitforthought.com') {
  const parsed = new URL(url);
  return fetch(`http://127.0.0.1:${parsed.searchParams.get('port')}/callback`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: state ?? parsed.searchParams.get('state'), token_hash: 'one-time-hash' }) });
}

test('网页登录只保存独立凭证，状态不暴露令牌；注销仅清除本地账号', async () => fixture(async ({ home, account, calls }) => {
  assert.equal((await account.status()).connected, false);
  const login = await account.begin();
  assert.equal((await callback(login.url, 'wrong')).status, 403);
  assert.equal((await callback(login.url, undefined, 'https://untrusted.test')).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await callback(login.url)).status, 200);
  const state = await account.status(); assert.equal(state.connected, true); assert.equal(state.account.email, 'test@example.test');
  assert.doesNotMatch(JSON.stringify(state), /private-refresh|private-access|one-time-hash|public-key/);
  assert.match(await readFile(path.join(home, 'account.json'), 'utf8'), /private-refresh-token/);
  assert.equal(calls.length, 2); assert.equal(calls[1].url, 'https://test.supabase.co/auth/v1/verify');
  await account.logout(); assert.equal((await account.status()).connected, false);
  assert.equal(calls.length, 2); // No upload, topic read, or global sign-out.
}));

test('取消、过期回调不会建立登录；暂停授权时本地功能不依赖网络', async () => fixture(async ({ account, calls }) => {
  const first = await account.begin(); await account.cancel();
  await assert.rejects(callback(first.url));
  assert.equal((await account.status()).connected, false); assert.equal(calls.length, 0);
}));

test('错误配置和凭证交换失败显示错误，不创建账号', async () => fixture(async ({ account }) => {
  const login = await account.begin();
  assert.equal((await callback(login.url)).status, 400);
  const status = await account.status(); assert.equal(status.connected, false); assert.ok(status.error); assert.equal(status.pending, false);
}, { fetchImpl: async () => Response.json({ url: 'https://untrusted.test', anonKey: 'x' }) }));

test('注销中途到达的授权结果不能重新登录', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  await fixture(async ({ account }) => {
    const login = await account.begin(); const result = callback(login.url); await started;
    await account.logout(); release();
    assert.equal((await result).status, 400); assert.equal((await account.status()).connected, false);
  }, { fetchImpl: async url => {
    if (url.endsWith('/api/agent-config')) return Response.json({ url: 'https://test.supabase.co', anonKey: 'public' });
    entered(); await wait; return Response.json({ refresh_token: 'secret', user: { id: 'id', email: 'test@test.test' } });
  } });
});

test('同步使用已登录会话，临近过期只刷新一次；注销取消在途 RPC', async () => {
  let refreshes=0,entered,signal;
  const started=new Promise(resolve=>entered=resolve);
  await fixture(async({home,account})=>{
    await writeFile(path.join(home,'account.json'),JSON.stringify({webUrl:'https://gitforthought.com',config:{url:'https://test.supabase.co',anonKey:'public'},refreshToken:'refresh',account:{id:'a',email:'a@test.test'},expiresAt:0}));
    const [a,b]=await Promise.all([account.session(),account.session()]);assert.equal(refreshes,1);assert.equal(a.key,b.key);
    await assert.rejects(a.rpc('unrelated_api',{}),/未知同步/);
    const rejected=assert.rejects(a.rpc('gft_sync_index',{}));await started;await account.logout();
    assert.equal(signal.aborted,true);await rejected;assert.equal(a.alive(),false);
    assert.equal(await account.session(),null);
  },{fetchImpl:async(url,init)=>{
    if(url.includes('/auth/v1/token')){refreshes++;return Response.json({access_token:'access',refresh_token:'refresh2',expires_in:3600,user:{id:'a',email:'a@test.test'}});}
    assert.equal(init.headers.Authorization,'Bearer access');assert.equal(init.redirect,'error');signal=init.signal;entered();
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }});
});

test('旧本地凭证首次同步会补齐 access token，网页登录声明自动同步',async()=>fixture(async({account,home,calls})=>{
  const login=await account.begin();assert.equal(new URL(login.url).searchParams.get('sync'),'1');await callback(login.url);
  const saved=JSON.parse(await readFile(path.join(home,'account.json'),'utf8'));delete saved.accessToken;await writeFile(path.join(home,'account.json'),JSON.stringify(saved));
  const session=await account.session();assert.ok(session.alive());assert.equal(calls.length,3);
  assert.match(calls.at(-1).url,/grant_type=refresh_token/);
  assert.doesNotMatch(JSON.stringify(await account.status()),/private-access|private-refresh/);
}));
