// 真机测试（二）：需要 Chrome 开着且已加载 TabDeck 扩展。
// 覆盖 live.test.mjs 没测的：tab_activate、session_end 的 ungroup / keep、MCP server 退出后的清理、
// 别的 session 的组不受影响。临时开的标签页测完都会关掉；只打印数量，不打印用户标签页的内容。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个 MCP server 进程 = 一个 session。
async function client() {
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
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 25000);
      waiters.set(id, (m) => (clearTimeout(t), resolve(m)));
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    if (r.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  // 模拟客户端退出：关 stdin，server 自己退出，管道断开。
  const exit = async () => {
    mcp.stdin.end();
    await sleep(1500);
    mcp.kill();
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test-2', version: '0' } });
  return { tool, exit };
}

let failed = false;
const leftovers = new Set(); // 测试开的、还没确认关掉的标签页
const main = await client();
const open = async (c, args) => {
  const t = await c.tool('tab_open', args);
  leftovers.add(t.id);
  return t;
};
const all = () => main.tool('tabs_list', { scope: 'all' });
const forceClose = async (ids) => {
  await main.tool('tabs_close', { tabIds: ids, force: true });
  ids.forEach((id) => leftovers.delete(id));
};

try {
  const before = await all();
  console.log(`ok  开始：${before.tabs.length} 个标签页，${before.groups.length} 个组`);

  // ---- tab_activate ----
  await main.tool('session_start', { name: 'TabDeck 自测 2' });
  const t1 = await open(main, { url: 'https://example.com/' });
  const wasActive = before.tabs.find((t) => t.windowId === t1.windowId && t.active);
  const act = await main.tool('tab_activate', { tabId: t1.id });
  assert.equal(act.active, true);
  if (wasActive) {
    const back = await main.tool('tab_activate', { tabId: wasActive.id });
    assert.equal(back.active, true);
  }
  console.log('ok  tab_activate：切到 session 标签页，再切回原来的');

  // ---- 别的 session 的组不受影响 ----
  const other = await client();
  await other.tool('session_start', { name: 'TabDeck 另一个', color: 'pink' });
  const o1 = await open(other, { url: 'https://example.com/?other' });
  assert.notEqual(o1.groupId, t1.groupId);
  let snap = await all();
  assert.equal(snap.groups.find((g) => g.id === o1.groupId).session, 'other');
  assert.equal(snap.groups.find((g) => g.id === t1.groupId).session, 'this');
  assert.equal(snap.tabs.find((t) => t.id === o1.id).inSession, false);
  await assert.rejects(main.tool('tabs_close', { tabIds: [o1.id] }), /do not belong/);
  console.log('ok  两个 session 各有各的组，互相不能关对方的标签页');

  // ---- session_end ungroup：标签页留下，组解散 ----
  const endU = await main.tool('session_end', { mode: 'ungroup' });
  assert.deepEqual(endU.tabs, [t1.id]);
  await sleep(300);
  snap = await all();
  assert.equal(snap.tabs.find((t) => t.id === t1.id).groupId, null);
  assert.ok(!snap.groups.some((g) => g.id === t1.groupId));
  const og = snap.groups.find((g) => g.id === o1.groupId);
  assert.ok(og && og.title === 'TabDeck 另一个', '另一个 session 的组被动了');
  console.log('ok  session_end ungroup：标签页还在、组解散，另一个 session 的组没动');
  await forceClose([t1.id]);

  // ---- session_end keep：标签页和组都留下 ----
  const endK = await other.tool('session_end', { mode: 'keep' });
  assert.deepEqual(endK.tabs, [o1.id]);
  await sleep(300);
  snap = await all();
  const kept = snap.groups.find((g) => g.id === o1.groupId);
  assert.ok(kept && kept.session === null, 'keep 之后组应当还在且不再属于任何 session');
  assert.equal(snap.tabs.find((t) => t.id === o1.id).groupId, o1.groupId);
  console.log('ok  session_end keep：标签页和组都留下，组不再归 session 管');
  await forceClose([o1.id]);
  await other.exit();

  // ---- MCP server 退出：只有空白页才自动关 ----
  const blank = await client();
  const b1 = await open(blank, {});
  await sleep(800); // 等新标签页的地址落定
  await blank.exit();
  snap = await all();
  assert.ok(!snap.tabs.some((t) => t.id === b1.id), '只有空白页的 session 退出后，空白页应当被自动关掉');
  leftovers.delete(b1.id);
  console.log('ok  退出清理：session 只有空白页时自动关掉');

  const real = await client();
  const r1 = await open(real, { url: 'https://example.com/?keep' });
  await sleep(1500); // 等页面加载出地址
  await real.exit();
  snap = await all();
  const survivor = snap.tabs.find((t) => t.id === r1.id);
  assert.ok(survivor, '有内容的标签页不应当被自动关掉');
  assert.equal(survivor.groupId, r1.groupId);
  assert.equal(snap.groups.find((g) => g.id === r1.groupId).session, null);
  console.log('ok  退出清理：有内容的标签页原样保留（组也在），不再归 session 管');
  await forceClose([r1.id]);

  await sleep(300);
  const after = await all();
  assert.equal(after.tabs.length, before.tabs.length);
  assert.equal(after.groups.length, before.groups.length);
  for (const old of before.groups) {
    const now = after.groups.find((g) => g.id === old.id);
    assert.ok(now && now.title === old.title, `原有的组 ${old.id} 变了`);
  }
  console.log(`ok  收尾：回到 ${after.tabs.length} 个标签页、${after.groups.length} 个组，原有的组都没变`);
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
} finally {
  if (leftovers.size) {
    const snap = await all().catch(() => null);
    const alive = snap ? [...leftovers].filter((id) => snap.tabs.some((t) => t.id === id)) : [];
    if (alive.length) await main.tool('tabs_close', { tabIds: alive, force: true }).catch(() => {});
  }
  await main.exit();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
