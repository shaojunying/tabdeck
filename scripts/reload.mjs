#!/usr/bin/env node
// 仅开发用：让扩展重载自己，使 extension/ 下的改动生效。
// 走 TabDeck 自己的通道（命名管道 -> native host -> 扩展），不碰调试端口，所以 Chrome 不会弹 Allow。
// 用法：node scripts/reload.mjs          重载并等新一轮 service worker 连回来
//       node scripts/reload.mjs --info   只看当前 service worker 的 boot 标记
// session 记录存在 chrome.storage.local，重载后进行中的 session 照样认得自己的标签页组。

import net from 'node:net';
import readline from 'node:readline';
import common from '../src/common.js';

const { PIPE } = common;

function call(method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`no answer to ${method} within ${timeoutMs}ms`));
    }, timeoutMs);
    const done = (fn, v) => {
      clearTimeout(timer);
      s.destroy();
      fn(v);
    };
    s.on('error', (e) => done(reject, e));
    s.once('connect', () => s.write(JSON.stringify({ id: 1, method, params: {} }) + '\n'));
    const rl = readline.createInterface({ input: s });
    rl.on('error', () => {}); // socket 的错误上面已经处理；readline 会再抛一次，不接住就让进程崩掉
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.error !== undefined) done(reject, new Error(String(msg.error)));
      else done(resolve, msg.result);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (process.argv.includes('--info')) {
    console.log(JSON.stringify(await call('dev.info')));
    process.exit(0);
  }
  const before = await call('dev.reload');
  console.log(`reload requested (old boot ${before.boot})`);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const now = await call('dev.info', 3000);
      if (now.boot !== before.boot) {
        console.log(`reloaded (new boot ${now.boot}, version ${now.version})`);
        process.exit(0);
      }
    } catch {
      // 旧 host 正在退出、新 host 还没起来
    }
  }
  console.error('extension did not come back within 45s');
  process.exit(1);
} catch (e) {
  console.error(`reload failed: ${e.message}`);
  if (/Unknown method/.test(e.message)) {
    console.error('The loaded extension predates dev.reload. Reload it once by hand in chrome://extensions.');
  }
  process.exit(1);
}
