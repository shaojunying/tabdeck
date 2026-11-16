// 通信链路自测：不需要 Chrome。本脚本扮演扩展（按 native messaging 帧收发），
// 拉起真的 host.js 和 mcp-server.js，验证 MCP 请求 -> 管道 -> host -> “扩展” -> 原路返回，
// 以及 MCP server 退出后扩展能收到 session.disconnected。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, TABDECK_PIPE: `\\\\.\\pipe\\tabdeck-test-${process.pid}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 假扩展 + 真 host ----
const host = spawn(process.execPath, [path.join(root, 'src', 'host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const fromHost = [];
let buf = Buffer.alloc(0);
host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const len = buf.readUInt32LE(0);
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    fromHost.push(msg);
    if (msg.method === 'session.disconnected') continue;
    const reply = msg.method === 'tabs_close' ? { id: msg.id, error: 'boom' } : { id: msg.id, result: { echo: msg.method, params: msg.params } };
    const body = Buffer.from(JSON.stringify(reply));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    host.stdin.write(Buffer.concat([head, body]));
  }
});
await sleep(500);

// ---- MCP 客户端 + 真 mcp-server ----
const mcp = spawn(process.execPath, [path.join(root, 'src', 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const waiters = new Map();
readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  waiters.get(msg.id)?.(msg);
});
let rpcId = 0;
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
    waiters.set(id, (m) => (clearTimeout(t), resolve(m)));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

let failed = false;
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'tabdeck');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  console.log('ok  initialize');

  const list = await rpc('tools/list', {});
  assert.ok(list.result.tools.length >= 10);
  assert.ok(list.result.tools.every((t) => t.name && t.description && t.inputSchema));
  console.log(`ok  tools/list (${list.result.tools.length} 个工具)`);

  const call = await rpc('tools/call', { name: 'tab_open', arguments: { url: 'https://example.com' } });
  assert.equal(call.result.isError, undefined);
  assert.deepEqual(JSON.parse(call.result.content[0].text), { echo: 'tab_open', params: { url: 'https://example.com' } });
  const forwarded = fromHost.find((m) => m.method === 'tab_open');
  assert.match(forwarded.sessionId, /^[0-9a-f-]{36}$/);
  console.log('ok  tools/call 往返，带 sessionId');

  const err = await rpc('tools/call', { name: 'tabs_close', arguments: { tabIds: [1] } });
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /boom/);
  console.log('ok  扩展报错能传回来');

  const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.isError, true);
  console.log('ok  未知工具被拒绝');

  mcp.stdin.end();
  await sleep(800);
  const gone = fromHost.find((m) => m.method === 'session.disconnected');
  assert.ok(gone, '没有收到 session.disconnected');
  assert.equal(gone.sessionId, forwarded.sessionId);
  console.log('ok  MCP server 退出后收到 session.disconnected');

  host.stdin.end();
  const code = await Promise.race([new Promise((r) => host.on('exit', r)), sleep(3000).then(() => 'still running')]);
  assert.equal(code, 0);
  console.log('ok  扩展断开后 host 自己退出');
} catch (e) {
  failed = true;
  console.error('FAIL', e.message);
} finally {
  mcp.kill();
  host.kill();
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
