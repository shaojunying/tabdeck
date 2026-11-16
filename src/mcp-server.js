#!/usr/bin/env node
'use strict';
// MCP server（stdio，一行一个 JSON-RPC）。每个进程就是一个 session：
// 工具调用经命名管道转给 native host，再到扩展。不依赖任何 npm 包。

const net = require('net');
const crypto = require('crypto');
const readline = require('readline');
const { PIPE, VERSION } = require('./common');
const TOOLS = require('./tools');

const sessionId = crypto.randomUUID();
const TIMEOUT_MS = 20000;

let sock = null;
let connecting = null;
let seq = 0;
const pending = new Map();

function connect() {
  if (sock) return Promise.resolve(sock);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    s.once('connect', () => {
      sock = s;
      connecting = null;
      resolve(s);
    });
    s.on('error', (e) => {
      if (sock !== s) {
        connecting = null;
        reject(e);
      }
    });
    readline.createInterface({ input: s }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
      else p.resolve(msg.result);
    });
    s.on('close', () => {
      if (sock === s) sock = null;
      for (const p of pending.values()) p.reject(new Error('Connection to the browser was lost.'));
      pending.clear();
    });
  });
  return connecting;
}

async function callBrowser(method, params) {
  let s;
  try {
    s = await connect();
  } catch (e) {
    throw new Error(
      `Cannot reach the TabDeck extension (${e.code || e.message}). ` +
        'Check that Chrome is running, the TabDeck extension is loaded and enabled, and `node scripts/setup.mjs` has been run.'
    );
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The browser did not answer within ${TIMEOUT_MS / 1000}s.`));
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    s.write(JSON.stringify({ id, sessionId, method, params }) + '\n');
  });
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function onRpc(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知不需要回复
  let result;
  if (method === 'initialize') {
    result = {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tabdeck', version: VERSION },
    };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools: TOOLS };
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) {
      result = { content: [{ type: 'text', text: `Error: unknown tool "${name}"` }], isError: true };
    } else {
      try {
        const r = await callBrowser(name, (params && params.arguments) || {});
        // 扩展可以用 __text / __image 直接给出文本和图片，其余结果按 JSON 输出。
        if (r && (r.__text !== undefined || r.__image)) {
          const content = [];
          if (r.__image) content.push({ type: 'image', data: r.__image.data, mimeType: r.__image.mimeType });
          if (r.__text !== undefined) content.push({ type: 'text', text: String(r.__text) });
          result = { content };
        } else {
          result = { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
        }
      } catch (e) {
        result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    return;
  }
  send({ jsonrpc: '2.0', id, result });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  onRpc(msg).catch((e) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
});
// 客户端关掉 stdin 就退出；管道随之断开，host 会通知扩展这个 session 结束。
rl.on('close', () => process.exit(0));
