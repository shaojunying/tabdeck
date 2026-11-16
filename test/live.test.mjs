// 真机测试：需要 Chrome 开着且已加载 TabDeck 扩展。会在当前窗口开两个标签页，测完自己关掉。
// 只打印数量和本 session 的标签页，不打印用户其他标签页的标题和网址。
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
// 调工具；成功返回解析后的结果，失败抛错。
async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result.content[0].text;
  if (r.result.isError) throw new Error(text);
  return JSON.parse(text);
}

let failed = false;
let opened = [];
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '0' } });

  const before = await tool('tabs_list', { scope: 'all' });
  console.log(`ok  tabs_list all：${before.tabs.length} 个标签页，${before.groups.length} 个组`);

  const s = await tool('session_start', { name: 'TabDeck 自测', color: 'cyan' });
  assert.equal(s.name, 'TabDeck 自测');
  assert.equal(s.group, null);
  console.log('ok  session_start（还没有标签页，组尚未出现）');

  const t1 = await tool('tab_open', { url: 'https://example.com/' });
  const t2 = await tool('tab_open', {});
  opened = [t1.id, t2.id];
  assert.ok(t1.groupId != null && t1.groupId === t2.groupId);
  assert.equal(t1.active, false);
  console.log(`ok  tab_open ×2，同一个组 ${t1.groupId}，后台打开`);

  let mine = await tool('tabs_list');
  assert.equal(mine.group.title, 'TabDeck 自测');
  assert.equal(mine.group.color, 'cyan');
  assert.deepEqual(mine.tabs.map((t) => t.id).sort(), [...opened].sort());
  console.log('ok  tabs_list：组名、颜色、成员正确');

  const g = await tool('group_set', { title: 'TabDeck 改名', collapsed: true });
  assert.equal(g.title, 'TabDeck 改名');
  assert.equal(g.collapsed, true);
  await tool('group_set', { collapsed: false });
  console.log('ok  group_set：改名、折叠、展开');

  await tool('tabs_ungroup', { tabIds: [t2.id] });
  mine = await tool('tabs_list');
  assert.deepEqual(mine.tabs.map((t) => t.id), [t1.id]);
  console.log('ok  tabs_ungroup：移出组后不再属于 session');

  await assert.rejects(tool('tabs_close', { tabIds: [t2.id] }), /do not belong/);
  console.log('ok  tabs_close 拒绝关不属于 session 的标签页');

  await tool('tabs_adopt', { tabIds: [t2.id] });
  mine = await tool('tabs_list');
  assert.equal(mine.tabs.length, 2);
  console.log('ok  tabs_adopt：收回组里');

  const other = await tool('tabs_group', { tabIds: [t2.id], title: 'TabDeck 临时组', color: 'orange' });
  assert.notEqual(other.id, t1.groupId);
  assert.equal(other.title, 'TabDeck 临时组');
  await tool('tabs_adopt', { tabIds: [t2.id] });
  console.log('ok  tabs_group：建普通组，再收回 session');

  const mid = await tool('tabs_list', { scope: 'all' });
  assert.equal(mid.tabs.length, before.tabs.length + 2);
  assert.equal(mid.tabs.filter((t) => t.inSession).length, 2);
  assert.equal(mid.groups.filter((x) => x.session === 'this').length, 1);
  // 之前就有的组（包括 Playwright 的）一个都不能少，名字也不能变。
  for (const old of before.groups) {
    const now = mid.groups.find((x) => x.id === old.id);
    assert.ok(now, `原有的组 ${old.id} 不见了`);
    assert.equal(now.title, old.title);
  }
  console.log(`ok  原有的 ${before.groups.length} 个组都还在，没被改名`);

  const end = await tool('session_end', { mode: 'close' });
  assert.equal(end.tabs.length, 2);
  await sleep(500);
  const after = await tool('tabs_list', { scope: 'all' });
  assert.equal(after.tabs.length, before.tabs.length);
  assert.ok(!after.tabs.some((t) => opened.includes(t.id)));
  assert.equal(after.groups.length, before.groups.length);
  opened = [];
  console.log('ok  session_end：标签页和组都清掉，数量回到测试前');
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
  // 尽量把自己开的标签页收拾掉
  if (opened.length) await tool('tabs_close', { tabIds: opened, force: true }).catch(() => {});
} finally {
  mcp.stdin.end();
  await sleep(300);
  mcp.kill();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
