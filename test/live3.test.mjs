// 真机测试（三）：页面操作。需要 Chrome 开着且已加载 TabDeck 扩展。
// 自己起一个本地网页当靶子（127.0.0.1 随机端口），不碰任何真实网站和用户的标签页。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><title>TabDeck test</title>
<h1>Hello</h1>
<a href="/child" target="_blank">Open child</a>
<input aria-label="Name" id="q" value="old">
<button onclick="document.title='clicked:'+document.getElementById('q').value">Apply</button>
<form action="/submitted"><input name="s" aria-label="Search"></form>`;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/child')) res.end('<!doctype html><title>Child</title><p>child page</p>');
  else if (req.url.startsWith('/submitted')) res.end('<!doctype html><title>Submitted</title><p>done</p>');
  else res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    waiters.set(id, (m) => (clearTimeout(t), resolve(m)));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
// 返回原始 content；出错抛错。
async function raw(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.result.isError) throw new Error(r.result.content[0].text);
  return r.result.content;
}
const tool = async (name, args) => JSON.parse((await raw(name, args))[0].text);
const snapshot = async (tabId) => (await raw('page_snapshot', { tabId }))[0].text;
const refOf = (snap, label) => {
  const line = snap.split('\n').find((l) => l.includes(`"${label}"`) && l.includes('[ref='));
  assert.ok(line, `快照里找不到带 ref 的 "${label}"：\n${snap}`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

let failed = false;
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test-3', version: '0' } });
  const before = await tool('tabs_list', { scope: 'all' });
  await tool('session_start', { name: '页面自测' });
  const t = await tool('tab_open', { url: base + '/' });
  const tabId = t.id;
  await sleep(1000);

  const foreign = before.tabs[0];
  await assert.rejects(raw('page_snapshot', { tabId: foreign.id }), /does not belong/);
  console.log('ok  页面操作拒绝不属于本 session 的标签页');

  let snap = await snapshot(tabId);
  assert.match(snap, /title: TabDeck test/);
  assert.match(snap, /heading "Hello" \[level=1\]/);
  assert.match(snap, /link "Open child" \[ref=e\d+\]/);
  assert.match(snap, /textbox "Name" \[ref=e\d+\].* value="old"/);
  assert.match(snap, /button "Apply" \[ref=e\d+\]/);
  console.log(`ok  page_snapshot：标题、链接、输入框（含当前值）、按钮都在，共 ${snap.split('\n').length} 行`);

  await tool('page_type', { tabId, ref: refOf(snap, 'Name'), text: 'abcd' });
  await tool('page_key', { tabId, key: 'Backspace' });
  let after = await tool('page_click', { tabId, ref: refOf(snap, 'Apply') });
  assert.equal(after.title, 'clicked:abc');
  console.log('ok  page_type 替换原内容 + page_key 退格 + page_click 点按钮，页面按预期变化');

  after = await tool('page_type', { tabId, ref: refOf(snap, 'Search'), text: 'hi there', submit: true });
  assert.match(after.url, /\/submitted\?s=hi(\+|%20)there/);
  assert.equal(after.title, 'Submitted');
  console.log('ok  page_type submit：回车提交表单并等到新页面');

  after = await tool('page_navigate', { tabId, url: base + '/' });
  assert.equal(after.title, 'TabDeck test');
  assert.equal(after.status, 'complete');
  console.log('ok  page_navigate：加载完成后返回');

  snap = await snapshot(tabId);
  await tool('page_click', { tabId, ref: refOf(snap, 'Open child') });
  await sleep(1000);
  let mine = await tool('tabs_list');
  const child = mine.tabs.find((x) => x.url.includes('/child'));
  assert.ok(child, '点链接开出的新标签页没有被自动收进 session');
  assert.equal(child.groupId, mine.group.id);
  assert.match(await snapshot(child.id), /child page/);
  console.log('ok  自动收编：session 标签页点链接开出的新标签页自动进组，并且能直接操作');

  const wasActive = before.tabs.find((x) => x.windowId === t.windowId && x.active);
  await tool('tab_activate', { tabId });
  const shot = await raw('page_screenshot', { tabId });
  if (wasActive) await tool('tab_activate', { tabId: wasActive.id });
  const img = shot.find((c) => c.type === 'image');
  assert.ok(img && img.mimeType === 'image/jpeg' && img.data.length > 1000);
  assert.equal(Buffer.from(img.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  console.log(`ok  page_screenshot：拿到 JPEG（${Math.round((img.data.length * 3) / 4 / 1024)} KB）`);

  await assert.rejects(raw('page_click', { tabId, ref: 'e999999999' }), /not found|take a new page_snapshot/i);
  console.log('ok  失效的 ref 给出明确报错');

  await tool('session_end', { mode: 'close' });
  await sleep(500);
  const end = await tool('tabs_list', { scope: 'all' });
  assert.equal(end.tabs.length, before.tabs.length);
  assert.equal(end.groups.length, before.groups.length);
  console.log(`ok  收尾：回到 ${end.tabs.length} 个标签页、${end.groups.length} 个组`);
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
  await tool('session_end', { mode: 'close' }).catch(() => {});
} finally {
  mcp.stdin.end();
  await sleep(300);
  mcp.kill();
  server.close();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
