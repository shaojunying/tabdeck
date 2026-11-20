// 真机测试（六）：从使用记录里找出的问题。page_wait 认占位符 / aria-label / iframe / 选择器 / 纯等待，
// 页面自己抢的焦点会被移出输入框，page_text 读纯文本，按名字点击和输入、ref 失效后自动重找，
// MCP 进程换了以后接回上一个进程留下的标签页组。需要 Chrome 开着且已加载 TabDeck 扩展。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WAIT = `<!doctype html><meta charset="utf-8"><title>Wait</title>
<input placeholder="Type a message"><button aria-label="Activity">🔔</button>
<iframe srcdoc="<p>Inner frame words</p>"></iframe>
<script>setTimeout(() => { const d = document.createElement('div'); d.className = 'late'; d.textContent = 'Late text'; document.body.append(d); }, 800);</script>`;
const FOCUS = `<!doctype html><meta charset="utf-8"><title>Focus</title>
<input id="a" autofocus placeholder="Search box">
<button onclick="setTimeout(() => document.getElementById('c').focus(), 100)">Open composer</button>
<textarea id="c" aria-label="Composer"></textarea>
<label>Full name <input id="d"></label>`;
const TEXT = `<!doctype html><meta charset="utf-8"><title>Text</title><main>${Array.from(
  { length: 300 },
  (_, i) => `<p class="msg">Message ${i}: ${'lorem ipsum '.repeat(5)}</p>`
).join('')}</main>`;
const ACT = `<!doctype html><meta charset="utf-8"><title>Act</title>
<button id="save" onclick="document.title='saved'">Save</button>
<button onclick="document.title='del1'">Delete item 1</button><button onclick="document.title='del2'">Delete item 2</button>
<input aria-label="Note" id="note">`;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end({ '/wait': WAIT, '/focus': FOCUS, '/text': TEXT, '/act': ACT }[req.url] || '<!doctype html><title>Home</title>home');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 一个 MCP server 进程 = 一个 TabDeck session。
function startMcp(label) {
  const mcp = spawn(process.execPath, [path.join(root, 'src', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = new Map();
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.(msg);
  });
  let rpcId = 0;
  const rpc = (method, params) => {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
      waiters.set(id, (m) => (clearTimeout(t), resolve(m)));
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const raw = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    if (r.result.isError) throw new Error(`${name}: ${r.result.content[0].text}`);
    return r.result.content;
  };
  const text = async (name, args) => (await raw(name, args)).find((c) => c.type === 'text').text;
  const tool = async (name, args) => JSON.parse(await text(name, args));
  const init = rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: label, version: '0' } });
  const stop = async () => {
    mcp.stdin.end();
    await sleep(300);
    mcp.kill();
    await sleep(800); // 等 host 把 session.disconnected 送到扩展
  };
  return { init, raw, text, tool, stop };
}
const refOf = (snap, re) => {
  const m = re.exec(snap);
  assert.ok(m, `快照里没有 ${re}\n${snap}`);
  return m[1];
};

const M = startMcp('live6');
const { text, tool } = M;
let failed = false;
let before;
try {
  await M.init;
  before = await tool('tabs_list', { scope: 'all' });
  await tool('session_start', { name: 'TabDeck 测试 6' });
  const W = (await tool('tab_open', { url: base + '/wait' })).id;
  const F = (await tool('tab_open', { url: base + '/focus' })).id;
  const T = (await tool('tab_open', { url: base + '/text' })).id;
  const A = (await tool('tab_open', { url: base + '/act' })).id;
  await sleep(1200);
  const ev = async (tabId, expression) => JSON.parse(await text('page_eval', { tabId, expression }));

  // ---- page_wait：占位符、aria-label、iframe、选择器、纯等待 ----
  for (const t of ['Type a message', 'type A   MESSAGE', 'Activity', 'Inner frame words', 'Late text']) {
    const r = await tool('page_wait', { tabId: W, text: t, timeoutMs: 3000 });
    assert.ok(r.found, t);
  }
  assert.ok((await tool('page_wait', { tabId: W, selector: 'div.late', timeoutMs: 3000 })).found);
  assert.ok((await tool('page_wait', { tabId: W, selectorGone: 'div.never', timeoutMs: 1000 })).found);
  await assert.rejects(tool('page_wait', { tabId: W, text: 'nowhere at all', timeoutMs: 600 }), /Timed out/);
  await assert.rejects(tool('page_wait', { tabId: W, selector: 'div[', timeoutMs: 600 }), /Invalid CSS selector/);
  await assert.rejects(tool('page_wait', { tabId: W, text: 'a', selector: 'b' }), /only one/);
  const t0 = Date.now();
  assert.equal((await tool('page_wait', { tabId: W, ms: 400 })).waitedMs, 400);
  assert.ok(Date.now() - t0 >= 380);
  console.log('ok  page_wait：占位符、aria-label、iframe、忽略大小写和空白、selector / selectorGone、ms 纯等待、报错');

  // ---- 焦点：页面自己聚焦的输入框被移出；点它、page_type、page_eval 里 focus() 不受影响 ----
  assert.equal(await ev(F, 'document.activeElement.tagName'), 'BODY', 'autofocus 应被移出');
  await tool('page_click', { tabId: F, name: 'Open composer' });
  await sleep(400);
  assert.equal(await ev(F, 'document.activeElement.tagName'), 'BODY', '点按钮后页面聚焦的 textarea 应被移出');
  await tool('page_type', { tabId: F, name: 'Composer', text: 'hi' });
  assert.equal(await ev(F, "document.activeElement.id + ':' + document.getElementById('c').value"), 'c:hi');
  await tool('page_click', { tabId: F, name: 'Search box' });
  await sleep(200);
  assert.equal(await ev(F, 'document.activeElement.id'), 'a', '点输入框本身应保留焦点');
  await tool('page_click', { tabId: F, name: 'Full name', role: 'textbox' });
  await sleep(200);
  assert.equal(await ev(F, 'document.activeElement.id'), 'd');
  await ev(F, "document.getElementById('c').focus(), 1");
  await sleep(700);
  assert.equal(await ev(F, 'document.activeElement.id'), 'c', 'page_eval 里 focus() 应保留');
  console.log('ok  焦点：autofocus 和点按钮引起的聚焦被移出；点输入框、page_type、page_eval 的 focus() 保留');

  // ---- page_text ----
  const all = await text('page_text', { tabId: T, maxChars: 1000 });
  assert.match(all, /showing chars 0-1000/);
  assert.match(all, /more: pass offset=1000/);
  assert.ok(all.includes('Message 0:'));
  const tail = await text('page_text', { tabId: T, offset: -300 });
  assert.ok(tail.includes('Message 299') && !tail.includes('Message 0:'), tail);
  const found = await text('page_text', { tabId: T, find: 'message 150:' });
  assert.match(found, /1 match/);
  assert.ok(found.includes('Message 150:'), found);
  const at = Number(/@(\d+)/.exec(found)[1]);
  assert.ok((await text('page_text', { tabId: T, offset: at, maxChars: 20 })).includes('Message 150'));
  const sel = await text('page_text', { tabId: T, selector: 'p.msg', offset: -200 });
  assert.match(sel, /300 element\(s\) match/);
  assert.ok(sel.includes('-----'));
  await assert.rejects(text('page_text', { tabId: T, selector: 'p.none' }), /No element matches/);
  const mainRef = refOf(await text('page_snapshot', { tabId: T, interactive: true }), /- main \[ref=(\w+)\]/);
  assert.ok((await text('page_text', { tabId: T, ref: mainRef, maxChars: 50 })).includes('Message 0'));
  console.log('ok  page_text：分段、负 offset 读末尾、find 定位、selector 逐个元素、ref 读一块');

  // ---- 按名字点击 / 输入；ref 失效后按角色和名字重找 ----
  assert.equal((await tool('page_click', { tabId: A, name: 'save' })).title, 'saved');
  await assert.rejects(tool('page_click', { tabId: A, name: 'Delete' }), /2 elements match "Delete".*Delete item 1.*ref=/);
  assert.equal((await tool('page_click', { tabId: A, name: 'Delete', nth: 2 })).title, 'del2');
  await assert.rejects(tool('page_click', { tabId: A, name: 'Nothing like this' }), /No element matches/);
  const snap = await text('page_snapshot', { tabId: A });
  const saveRef = refOf(snap, /button "Save" \[ref=(\w+)\]/);
  await ev(A, "document.title = 'Act'; const b = document.getElementById('save'); b.replaceWith(b.cloneNode(true)); 1");
  const r = await tool('page_click', { tabId: A, ref: saveRef });
  assert.equal(r.title, 'saved');
  assert.match(r.target, /had gone stale/);
  const noteRef = refOf(snap, /textbox "Note" \[ref=(\w+)\]/);
  await ev(A, "const n = document.getElementById('note'); n.replaceWith(n.cloneNode(true)); 1");
  await tool('page_type', { tabId: A, ref: noteRef, text: 'abc' });
  assert.equal(await ev(A, "document.getElementById('note').value"), 'abc');
  console.log('ok  按名字定位（忽略大小写、重名列出候选、nth）；ref 失效后 page_click / page_type 自动重找');
  await tool('session_end', { mode: 'close' });

  // ---- 失主的组：进程 1 退出，进程 2 用同名 session_start 接回；进程 3 直接按 tabId 操作也能收编 ----
  await M.stop();
  const P1 = startMcp('live6-p1');
  await P1.init;
  await P1.tool('session_start', { name: 'TabDeck 测试 6 接力' });
  const X = (await P1.tool('tab_open', { url: base + '/text' })).id;
  await sleep(800);
  await P1.stop();
  const P2 = startMcp('live6-p2');
  await P2.init;
  const s2 = await P2.tool('session_start', { name: 'TabDeck 测试 6 接力' });
  assert.ok(s2.resumed, JSON.stringify(s2));
  assert.deepEqual(s2.tabs.map((t) => t.id), [X]);
  assert.equal(s2.group.title, 'TabDeck 测试 6 接力');
  assert.ok((await P2.text('page_text', { tabId: X, maxChars: 30 })).includes('Message 0'));
  await P2.stop();
  const P3 = startMcp('live6-p3');
  await P3.init;
  await P3.tool('session_start', { name: 'TabDeck 测试 6 另起' });
  assert.ok((await P3.text('page_text', { tabId: X, maxChars: 30 })).includes('Message 0'));
  const s3 = await P3.tool('tabs_list', {});
  assert.deepEqual(s3.tabs.map((t) => t.id), [X]);
  assert.equal(s3.group.title, 'TabDeck 测试 6 另起');
  await assert.rejects(P3.text('page_text', { tabId: before.tabs[0].id }), /does not belong to this session/);
  console.log('ok  失主的组：同名 session_start 接回，按 tabId 操作自动收编，用户自己的标签页仍然拒绝');
  await P3.tool('session_end', { mode: 'close' });
  await sleep(500);
  const end = await P3.tool('tabs_list', { scope: 'all' });
  assert.equal(end.tabs.length, before.tabs.length);
  assert.equal(end.groups.length, before.groups.length);
  console.log(`ok  收尾：回到 ${end.tabs.length} 个标签页、${end.groups.length} 个组`);
  await P3.stop();
} catch (e) {
  failed = true;
  console.error('FAIL', e.stack || e.message);
  await tool('session_end', { mode: 'close' }).catch(() => {});
} finally {
  await M.stop().catch(() => {});
  server.close();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
