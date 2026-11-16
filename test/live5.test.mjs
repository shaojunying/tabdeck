// 真机测试（五）：真实网站验收里发现的问题。重定向请求、后台标签页截图、不抢前台、
// 给图片和页面区域 ref、只读页面的一块。需要 Chrome 开着且已加载 TabDeck 扩展。
// 只用自己起的本地网页；设 TABDECK_REAL=1 时额外到维基百科上比一次后台截图（只打印，不判定）。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const HOME = `<!doctype html><meta charset="utf-8"><title>Home</title>
<nav><a href="#x">Nav link</a></nav>
<main><h1>Main part</h1><button>In main</button><p>main paragraph</p></main>
<img alt="Avatar" src="${GIF}" width="60" height="60" onmouseover="document.title='hovered'">
<form method="post" action="/login"><button>Login</button></form>
<button onclick="fetch('/login',{method:'POST',redirect:'manual'}).then(r=>document.title='manual:'+r.type)">Manual</button>
<a href="/new" target="_blank">Open new</a>
<button onclick="document.title='p:'+prompt('Name?')">Prompt</button>`;
const BIG = `<!doctype html><meta charset="utf-8"><title>Big</title><body style="margin:0">${Array.from(
  { length: 600 },
  (_, i) => `<div style="display:inline-block;width:90px;height:60px;background:hsl(${(i * 47) % 360} 80% ${30 + (i % 5) * 10}%);color:#fff;font:14px sans-serif">cell ${i}</div>`
).join('')}`;

const server = http.createServer((req, res) => {
  if (req.url === '/login') {
    res.statusCode = 302;
    res.setHeader('location', '/secure');
    return res.end();
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/secure') return res.end('<!doctype html><title>Secure</title><p>secure area</p>');
  if (req.url === '/new') return res.end('<!doctype html><title>New tab</title><p>new</p>');
  if (req.url === '/big') return res.end(BIG);
  res.end(HOME);
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
async function raw(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.result.isError) throw new Error(`${name}: ${r.result.content[0].text}`);
  return r.result.content;
}
const text = async (name, args) => (await raw(name, args)).find((c) => c.type === 'text').text;
const tool = async (name, args) => JSON.parse(await text(name, args));
const refOf = (snap, re) => {
  const m = re.exec(snap);
  assert.ok(m, `快照里没有 ${re}\n${snap}`);
  return m[1];
};
const shotSize = async (tabId) => (await raw('page_screenshot', { tabId })).find((c) => c.type === 'image').data.length;
const mine = async () => (await tool('tabs_list', {})).tabs;
const tabOf = async (id) => (await mine()).find((t) => t.id === id);

let failed = false;
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live5', version: '0' } });
  const before = await tool('tabs_list', { scope: 'all' });
  await tool('session_start', { name: 'TabDeck 测试 5' });
  await tool('tab_open', { url: base + '/' });
  await tool('tab_open', { url: base + '/secure' });
  await sleep(1200);
  const tabs = await mine();
  const A = tabs.find((t) => !t.url.endsWith('/secure')).id;
  const B = tabs.find((t) => t.url.endsWith('/secure')).id;

  // ---- 快照：图片和区域有 ref；只读一块；只列可操作的元素 ----
  const snap = await text('page_snapshot', { tabId: A });
  const avatar = refOf(snap, /image "Avatar" \[ref=(\w+)\]/);
  const mainRef = refOf(snap, /- main \[ref=(\w+)\]/);
  const part = await text('page_snapshot', { tabId: A, ref: mainRef });
  assert.ok(part.includes('In main') && part.includes('main paragraph'), part);
  assert.ok(!part.includes('Nav link') && !part.includes('Login'), part);
  const compact = await text('page_snapshot', { tabId: A, interactive: true });
  assert.ok(compact.includes('button "In main"') && compact.includes('heading "Main part"'), compact);
  assert.ok(!compact.includes('- text:'), compact);
  assert.ok(compact.length < snap.length);
  await assert.rejects(text('page_snapshot', { tabId: A, ref: 'e999999' }), /No element with ref/);
  console.log(`ok  page_snapshot：ref 只读一块（${part.length} 字符），interactive（${compact.length} 字符），完整（${snap.length} 字符）`);

  // ---- 悬停没有交互角色的图片 ----
  const hov = await tool('page_hover', { tabId: A, ref: avatar });
  assert.equal(hov.title, 'hovered');
  console.log('ok  page_hover：图片有 ref，悬停生效');

  // ---- 重定向请求 ----
  await tool('page_click', { tabId: A, ref: refOf(snap, /button "Manual" \[ref=(\w+)\]/) });
  await text('page_wait', { tabId: A, text: 'Main part' });
  await sleep(500);
  const manual = await text('page_network', { tabId: A, filter: '/login' });
  console.log('    fetch(redirect: manual) 之后的列表：' + manual.split('\n').slice(1).join(' | '));
  assert.match(manual, /POST/, manual);

  const after = await tool('page_click', { tabId: A, ref: refOf(snap, /button "Login" \[ref=(\w+)\]/) });
  assert.ok(after.url.endsWith('/secure'), after.url);
  const list = await text('page_network', { tabId: A, filter: '/login' });
  const hop = /^(r\d+)\s+POST 302\s.*\/login\s+-> .*\/secure/m.exec(list);
  assert.ok(hop, list);
  const detail = await text('page_network', { tabId: A, requestId: hop[1] });
  assert.match(detail, /status: 302/);
  assert.match(detail, /redirected to: .*\/secure/);
  assert.match(await text('page_network', { tabId: A, filter: '/secure' }), /GET 200/);
  console.log('ok  page_network：302 那一跳单独列出，带去向；后面的 200 也在');

  // ---- 不抢前台 ----
  await tool('page_navigate', { tabId: A, url: base + '/' });
  const snap2 = await text('page_snapshot', { tabId: A });
  await tool('tab_activate', { tabId: A });
  const opened = await tool('page_click', { tabId: A, ref: refOf(snap2, /link "Open new" \[ref=(\w+)\]/) });
  assert.equal(opened.opened.length, 1);
  assert.equal(opened.opened[0].active, false, '源标签页在前台时，新标签页不该抢前台');
  assert.equal((await tabOf(A)).active, true);
  console.log('ok  源标签页在前台时点出的新标签页留在后台');

  await tool('tab_activate', { tabId: B });
  const asked = await tool('page_click', { tabId: A, ref: refOf(snap2, /button "Prompt" \[ref=(\w+)\]/) });
  assert.equal(asked.dialog.type, 'prompt');
  await sleep(300);
  assert.equal((await tabOf(B)).active, true, 'prompt 弹出后，用户在看的标签页应保持在前台');
  await text('page_dialog', { tabId: A, promptText: 'x' });
  await sleep(300);
  assert.equal((await tabOf(A)).title, 'p:x');
  assert.equal((await tabOf(B)).active, true);
  console.log('ok  后台标签页弹 prompt 不抢前台，处理后仍在后台');

  // ---- 后台标签页刚导航完的截图 ----
  await tool('page_navigate', { tabId: A, url: base + '/big' });
  // 后台标签页的画面可能只画了一部分（缺的地方是白的，JPEG 就明显变小）。连截几张，再切到前台截一张作对照。
  const bg = [];
  for (let i = 0; i < 4; i++) bg.push(await shotSize(A));
  await tool('tab_activate', { tabId: A });
  await sleep(500);
  const fg = await shotSize(A);
  await tool('tab_activate', { tabId: B });
  console.log(`    本地大页面：后台 ${bg.join(' / ')}，前台对照 ${fg}`);
  for (const s of bg) assert.ok(Math.abs(s - fg) < fg * 0.1, `后台截图和前台对照差得多：${bg.join(' / ')} 对 ${fg}`);
  console.log('ok  page_screenshot：后台标签页刚导航完的截图和前台的一样完整');
  if (process.env.TABDECK_REAL) {
    await tool('page_navigate', { tabId: A, url: 'https://en.wikipedia.org/wiki/Tab_(interface)' });
    const w1 = await shotSize(A);
    const w2 = await shotSize(A);
    console.log(`    维基百科（仅供参考）：第一张 ${w1}，第二张 ${w2}，比值 ${(w1 / w2).toFixed(2)}`);
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
  server.close();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
