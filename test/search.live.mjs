// 真机测试（搜索）：web_search 在真实的 Google / Bing 上能拿到结果，搜完不留标签页。
// 需要 Chrome 开着且已加载 TabDeck 扩展，并且能访问这两个搜索引擎。会真的发出 4 次搜索请求。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mcp = spawn(process.execPath, [path.join(root, 'src', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiters = new Map();
readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  waiters.get(msg.id)?.(msg);
});
let rpcId = 0;
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 25000);
    waiters.set(id, (m) => (clearTimeout(t), resolve(m)));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(name, args) {
  const started = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.result.content[0].text, isError: !!r.result.isError, ms: Date.now() - started };
}
// 结果文本形如 "1. 标题\n   https://...\n   摘要"。
function parse(text) {
  const items = [];
  for (const m of text.matchAll(/^\d+\. (.+)\n {3}(https?:\/\/\S+)(?:\n {3}(.+))?/gm)) items.push({ title: m[1], url: m[2], snippet: m[3] || '' });
  return items;
}

let failed = false;
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  await tool('session_start', { name: '搜索测试' });

  const g = await tool('web_search', { query: 'model context protocol specification', engine: 'google' });
  assert.equal(g.isError, false, g.text);
  assert.match(g.text, /^engine: google/m);
  const gi = parse(g.text);
  assert.ok(gi.length >= 5, `google 只解析出 ${gi.length} 条`);
  assert.ok(gi.every((r) => r.title && !/(^|\.)google\.[a-z.]+$/.test(new URL(r.url).hostname)), 'google 结果里混进了 google 自己的链接');
  assert.ok(gi.filter((r) => r.snippet).length >= gi.length / 2, 'google 多数结果没有摘要');
  console.log(`ok  google：${gi.length} 条，${g.ms}ms，第一条 ${gi[0].url}`);
  await sleep(1500);

  const b = await tool('web_search', { query: 'model context protocol specification', engine: 'bing', count: 3 });
  assert.equal(b.isError, false, b.text);
  assert.match(b.text, /^engine: bing/m);
  const bi = parse(b.text);
  assert.equal(bi.length, 3);
  assert.ok(bi.every((r) => !/bing\.com\/ck\//.test(r.url)), 'bing 的跳转链接没有还原');
  console.log(`ok  bing：count=3 生效，跳转链接已还原，${b.ms}ms，第一条 ${bi[0].url}`);
  await sleep(1500);

  const zh = await tool('web_search', { query: '顺义 前进花园 二手房' });
  assert.equal(zh.isError, false, zh.text);
  const zi = parse(zh.text);
  assert.ok(zi.length >= 3, `中文查询只解析出 ${zi.length} 条`);
  assert.ok(zi.some((r) => /[一-鿿]/.test(r.title)), '中文查询的标题里没有中文');
  console.log(`ok  auto + 中文：${zh.text.split('\n')[1]}，${zh.ms}ms`);
  await sleep(1500);

  const p2 = await tool('web_search', { query: 'model context protocol specification', engine: 'google', page: 2 });
  assert.equal(p2.isError, false, p2.text);
  const first = new Set(gi.map((r) => r.url));
  const fresh = parse(p2.text).filter((r) => !first.has(r.url));
  assert.ok(fresh.length >= 3, `第 2 页只有 ${fresh.length} 条和第 1 页不同`);
  console.log(`ok  page=2：${fresh.length} 条新结果`);

  const bad = await tool('web_search', { query: '   ' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /query is required/);
  console.log('ok  空查询被拒绝');

  const left = JSON.parse((await tool('tabs_list', {})).text);
  assert.equal(left.tabs.length, 0, `搜完还留着 ${left.tabs.length} 个标签页`);
  console.log('ok  搜完不留标签页');
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
} finally {
  await tool('session_end', { mode: 'close' }).catch(() => {});
  mcp.stdin.end();
  await sleep(300);
  mcp.kill();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
