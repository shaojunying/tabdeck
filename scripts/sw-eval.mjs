// 开发用：经 CDP（Chrome 的远程调试端口，DevToolsActivePort）进到 TabDeck 的 service worker 里执行一段代码。
// 用法：node scripts/sw-eval.mjs "<async 函数体>"      例：node scripts/sw-eval.mjs "return port !== null"
//       node scripts/sw-eval.mjs --reload              重新加载扩展（改了 extension/ 下的代码之后用）
// 需要 Chrome 已打开远程调试（chrome://inspect/#remote-debugging），首次连接 Chrome 可能弹窗要点 Allow。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).key;
const extId = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

const reload = process.argv[2] === '--reload';
const code = reload ? 'setTimeout(() => chrome.runtime.reload(), 100); return "reloading"' : process.argv[2];
if (!code) {
  console.error('缺少要执行的代码');
  process.exit(2);
}

const [port, wsPath] = readFileSync(process.env.LOCALAPPDATA + '\\Google\\Chrome\\User Data\\DevToolsActivePort', 'utf8')
  .trim()
  .split(/\r?\n/);
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
let seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
};
ws.onerror = (e) => {
  console.error('连不上 Chrome 的调试端口：', e.message || e);
  process.exit(1);
};
setTimeout(() => {
  console.error('超时（60 秒）。Chrome 是否弹了 Allow 窗口没点？');
  process.exit(1);
}, 60000);

ws.onopen = async () => {
  try {
    // service worker 空闲会休眠，这时没有 target；扩展的 alarm 每 30 秒会把它叫醒一次，等它出现。
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      const { targetInfos } = await send('Target.getTargets');
      target = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
      if (!target) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!target) throw new Error('40 秒内没等到 TabDeck 的 service worker');
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const r = await send(
      'Runtime.evaluate',
      { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (r.exceptionDetails) console.error('EXCEPTION', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    else console.log(JSON.stringify(r.result.value, null, 1));
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
  ws.close();
  process.exit(0);
};
