// 真机测试（四）：iframe、console、网络、弹窗、批量填表、上传。需要 Chrome 开着且已加载 TabDeck 扩展。
// 自己起两个本地网页（127.0.0.1 和 localhost，对 Chrome 来说是两个站点），不碰任何真实网站和用户的标签页。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INNER = `<!doctype html><meta charset="utf-8"><title>Inner</title><p>inner text</p>
<input aria-label="Inner name">
<button onclick="this.textContent='Inner clicked'">Inner button</button>`;
const page = (crossOrigin) => `<!doctype html><meta charset="utf-8"><title>Debug test</title>
<script>
console.log('hello from page', { a: 1 });
console.warn('careful');
console.error('boom');
setTimeout(() => undefinedFn(), 0);
</script>
<button onclick="fetch('/api/data?x=1',{method:'POST',body:JSON.stringify({k:2}),headers:{'content-type':'application/json','authorization':'Bearer secret123'}}).then(r=>r.json()).then(j=>document.title='got:'+j.v)">Fetch data</button>
<button onclick="fetch('/missing').then(()=>document.title='missing done')">Fetch missing</button>
<button onclick="document.title = confirm('Proceed?') ? 'yes' : 'no'">Ask</button>
<button onclick="document.title = 'p:' + prompt('Name?')">Prompt</button>
<form><input aria-label="First">
<select aria-label="Size"><option>Small</option><option>Large</option></select>
<label><input type="checkbox" id="agree"> Agree</label></form>
<input type="file" id="f" style="display:none" onchange="document.title='file:'+this.files[0].name+':'+this.files[0].size">
<iframe title="same frame" src="/inner" width="320" height="110"></iframe>
<iframe title="cross frame" src="${crossOrigin}/inner" width="320" height="110"></iframe>`;

function serve(host, html) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/data')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'sid=topsecret');
      return res.end(JSON.stringify({ v: 42 }));
    }
    if (req.url.startsWith('/missing')) {
      res.statusCode = 404;
      return res.end('nope');
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url.startsWith('/inner') ? INNER : html());
  });
  return new Promise((r) => server.listen(0, host, () => r(server)));
}
const other = await serve('localhost', () => INNER);
const cross = `http://localhost:${other.address().port}`;
const main = await serve('127.0.0.1', () => page(cross));
const base = `http://127.0.0.1:${main.address().port}`;

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
async function raw(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.result.isError) throw new Error(r.result.content[0].text);
  return r.result.content;
}
const text = async (name, args) => (await raw(name, args))[0].text;
const tool = async (name, args) => JSON.parse(await text(name, args));
const refsOf = (snap, label) => snap.split('\n').filter((l) => l.includes(`"${label}"`) && l.includes('[ref=')).map((l) => /\[ref=((?:f\d+)?e\d+)\]/.exec(l)[1]);
const refOf = (snap, label) => {
  const refs = refsOf(snap, label);
  assert.ok(refs.length, `快照里找不到带 ref 的 "${label}"：\n${snap}`);
  return refs[0];
};

let failed = false;
const skipped = [];
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test-4', version: '0' } });
  const before = await tool('tabs_list', { scope: 'all' });
  await tool('session_start', { name: '调试自测' });
  const tabId = (await tool('tab_open', { url: base + '/' })).id;
  await sleep(1500);
  const title = async () => (await tool('tabs_list')).tabs.find((x) => x.id === tabId).title;

  // ---- iframe ----
  let snap = await text('page_snapshot', { tabId });
  assert.equal(snap.split('inner text').length - 1, 2, `两个 iframe 的内容应当都在快照里：\n${snap}`);
  let buttons = refsOf(snap, 'Inner button');
  assert.equal(buttons.length, 2);
  const sameRef = buttons.find((r) => /^e\d+$/.test(r));
  const crossRef = buttons.find((r) => /^f\d+e\d+$/.test(r));
  assert.ok(sameRef && crossRef, `应当有一个同进程 iframe 的 ref 和一个跨站 iframe 的 ref，实际：${buttons.join(', ')}`);
  console.log(`ok  page_snapshot：同源 iframe（${sameRef}）和跨站 iframe（${crossRef}）的内容都读到了`);

  await tool('page_click', { tabId, ref: sameRef });
  await tool('page_click', { tabId, ref: crossRef });
  snap = await text('page_snapshot', { tabId });
  assert.equal(refsOf(snap, 'Inner clicked').length, 2, `两个 iframe 里的按钮都应当被点到：\n${snap}`);
  console.log('ok  page_click：同源和跨站 iframe 里的按钮都点到了');

  const names = refsOf(snap, 'Inner name');
  await tool('page_type', { tabId, ref: names.find((r) => r.startsWith('f')), text: 'in cross' });
  await tool('page_type', { tabId, ref: names.find((r) => r.startsWith('e')), text: 'in same' });
  snap = await text('page_snapshot', { tabId });
  assert.match(snap, /textbox "Inner name" \[ref=f\d+e\d+\].*value="in cross"/);
  assert.match(snap, /textbox "Inner name" \[ref=e\d+\].*value="in same"/);
  console.log('ok  page_type：同源和跨站 iframe 里的输入框都输入成功');

  // ---- console ----
  let con = await text('page_console', { tabId });
  assert.match(con, /\[log\] hello from page \{"?a"?: ?1\}/);
  assert.match(con, /\[warning\] careful/);
  assert.match(con, /\[error\] boom/);
  assert.match(con, /\[error\].*undefinedFn is not defined/);
  con = await text('page_console', { tabId, level: 'error' });
  assert.doesNotMatch(con, /careful|hello from page/);
  assert.match(con, /boom/);
  console.log('ok  page_console：打开前的 log / warning / error 和未捕获异常都补到了；level 过滤有效');

  // ---- 网络 ----
  snap = await text('page_snapshot', { tabId });
  await tool('page_click', { tabId, ref: refOf(snap, 'Fetch data') });
  for (let i = 0; i < 20 && (await title()) !== 'got:42'; i++) await sleep(100);
  assert.equal(await title(), 'got:42');
  let net = await text('page_network', { tabId, filter: '/api/data' });
  const line = net.split('\n').find((l) => /^r\d+\s+POST 200/.test(l));
  assert.ok(line, `列表里应当有 POST 200 的 /api/data：\n${net}`);
  const detail = await text('page_network', { tabId, requestId: line.split(/\s+/)[0] });
  assert.match(detail, /authorization: \[redacted, \d+ chars\]/i);
  assert.doesNotMatch(detail, /secret123|topsecret/);
  assert.match(detail, /request body:\n\{"k":2\}/);
  assert.match(detail, /response body:\n\{"v":42\}/);
  await tool('page_click', { tabId, ref: refOf(snap, 'Fetch missing') });
  for (let i = 0; i < 20 && (await title()) !== 'missing done'; i++) await sleep(100);
  net = await text('page_network', { tabId, failed: true });
  assert.match(net, /GET 404 .*\/missing/);
  assert.doesNotMatch(net, /api\/data/);
  console.log('ok  page_network：列表、按 URL 过滤、只看失败、请求和响应正文都对；authorization 已打码，响应里的 cookie 没有出现');

  // ---- 弹窗 ----
  let r = await tool('page_click', { tabId, ref: refOf(snap, 'Ask') });
  assert.ok(r.dialog && r.dialog.type === 'confirm' && r.dialog.message === 'Proceed?', `page_click 的返回值里应当报出弹窗：${JSON.stringify(r)}`);
  await assert.rejects(raw('page_snapshot', { tabId }), /confirm dialog is open/);
  r = await tool('page_dialog', { tabId, accept: false });
  assert.equal(r.accepted, false);
  for (let i = 0; i < 20 && (await title()) !== 'no'; i++) await sleep(100);
  assert.equal(await title(), 'no');
  await tool('page_click', { tabId, ref: refOf(snap, 'Prompt') });
  await tool('page_dialog', { tabId, promptText: 'Zed' });
  for (let i = 0; i < 20 && (await title()) !== 'p:Zed'; i++) await sleep(100);
  assert.equal(await title(), 'p:Zed');
  await assert.rejects(raw('page_dialog', { tabId }), /No JavaScript dialog/);
  console.log('ok  page_dialog：点击返回值里报出弹窗，弹窗期间别的操作立刻报错，取消 / 填 prompt 都生效');

  // ---- 批量填表 ----
  snap = await text('page_snapshot', { tabId });
  r = await tool('page_fill', {
    tabId,
    fields: [
      { ref: refOf(snap, 'First'), value: 'Ann' },
      { ref: refOf(snap, 'Size'), value: 'Large' },
      { ref: refOf(snap, 'Agree'), value: true },
    ],
  });
  assert.equal(r.filled, 3);
  const state = await text('page_eval', { tabId, expression: '[document.querySelector("[aria-label=First]").value, document.querySelector("select").value, document.getElementById("agree").checked].join("|")' });
  assert.equal(state, '"Ann|Large|true"');
  console.log('ok  page_fill：文本框、下拉框、复选框一次填好');

  // ---- 上传 ----
  const file = path.join(root, 'native-host', 'upload-test.txt');
  fs.writeFileSync(file, 'hello');
  await assert.rejects(raw('page_upload', { tabId, paths: [path.join(root, 'native-host', 'no-such-file.txt')] }), /File not found/);
  await assert.rejects(raw('page_upload', { tabId, paths: [path.join(root, '.env')] }), /credential or key file/);
  try {
    r = await tool('page_upload', { tabId, paths: [file] });
    assert.deepEqual(r.files, [{ name: 'upload-test.txt', size: 5 }]);
    for (let i = 0; i < 20 && (await title()) !== 'file:upload-test.txt:5'; i++) await sleep(100);
    assert.equal(await title(), 'file:upload-test.txt:5');
    console.log('ok  page_upload：隐藏的文件输入框选中了本地文件，页面收到 change；不存在的文件和凭据文件被拒绝');
  } catch (e) {
    if (!/Allow access to file URLs/.test(e.message)) throw e;
    skipped.push('page_upload：Chrome 拒绝了（扩展没有开"允许访问文件网址"），报错提示正确；路径检查已通过');
    console.log('skip page_upload：' + e.message);
  } finally {
    fs.rmSync(file, { force: true });
  }

  await tool('session_end', { mode: 'close' });
  await sleep(500);
  const end = await tool('tabs_list', { scope: 'all' });
  assert.equal(end.tabs.length, before.tabs.length);
  assert.equal(end.groups.length, before.groups.length);
  console.log(`ok  收尾：回到 ${end.tabs.length} 个标签页、${end.groups.length} 个组`);
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
  await raw('page_dialog', { tabId: -1 }).catch(() => {});
  await tool('session_end', { mode: 'close' }).catch(() => {});
} finally {
  mcp.stdin.end();
  await sleep(300);
  mcp.kill();
  main.close();
  other.close();
}
console.log(failed ? 'RESULT: FAILED' : skipped.length ? `RESULT: PASSED WITH ${skipped.length} SKIPPED` : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
