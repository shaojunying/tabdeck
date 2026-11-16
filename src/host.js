#!/usr/bin/env node
'use strict';
// Native messaging host：由 Chrome 在扩展调用 connectNative 时拉起。
// stdin / stdout 与扩展通信（4 字节小端长度 + JSON），同时在命名管道上接受多个 MCP server 连接，
// 把它们的请求转给扩展、把结果送回去。stdout 只能写协议帧，日志一律写文件。

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { PIPE } = require('./common');

// 日志放在项目的 native-host/ 下（已 gitignore）。不放 %TEMP%：打包应用里的 shell 看到的 AppData 可能是重定向过的。
const LOG = path.join(__dirname, '..', 'native-host', 'host.log');
function log(...a) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${a.join(' ')}\n`);
  } catch {}
}

// ---- 与扩展之间：native messaging 帧 ----
function sendToExtension(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    try {
      onExtensionMessage(JSON.parse(raw));
    } catch (e) {
      log('bad message from extension:', e.message);
    }
  }
});
// 扩展断开（service worker 重启、扩展被重载、Chrome 退出）时 stdin 结束，host 跟着退出。
process.stdin.on('end', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

// ---- 与 MCP server 之间：命名管道，一行一个 JSON ----
let seq = 0;
const pending = new Map(); // 全局请求 id -> { sock, id }

function onExtensionMessage(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (p.sock.destroyed) return;
  const reply = { id: p.id };
  if (msg.error !== undefined) reply.error = msg.error;
  else reply.result = msg.result;
  p.sock.write(JSON.stringify(reply) + '\n');
}

const server = net.createServer((sock) => {
  sock.on('error', () => {});
  readline.createInterface({ input: sock }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.sessionId) sock.sessionId = msg.sessionId;
    const gid = ++seq;
    pending.set(gid, { sock, id: msg.id });
    sendToExtension({ id: gid, sessionId: msg.sessionId, method: msg.method, params: msg.params || {} });
  });
  sock.on('close', () => {
    for (const [gid, p] of pending) if (p.sock === sock) pending.delete(gid);
    // MCP server 走了：告诉扩展这个 session 结束，由扩展按清理策略处理它的标签页。
    if (sock.sessionId) sendToExtension({ id: ++seq, sessionId: sock.sessionId, method: 'session.disconnected', params: {} });
  });
});

// 上一个 host 可能还没退干净（service worker 重启时新旧交替），管道被占用就重试几次。
let attempts = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && attempts++ < 20) {
    setTimeout(() => server.listen(PIPE), 500);
    return;
  }
  log('pipe server error:', e.code || e.message);
  process.exit(1);
});
server.on('listening', () => log('listening on', PIPE));
server.listen(PIPE);
