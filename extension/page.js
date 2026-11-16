// 页面操作（第二阶段）：经 chrome.debugger（CDP）读页面结构、点击、输入、截图。
// 由 background.js 用 importScripts 载入，共用它的 sessionTabs / tabInfo。
// 只允许操作本 session 的标签页；别的标签页要先 tabs_adopt。

const attached = new Set(); // 已 attach 调试器的 tabId
let windowOpens = []; // 最近的 Page.windowOpen 事件：{ tabId, url, at }
// 没拿到 debugger 权限时别让整个 service worker 起不来，留到调用时再报错。
// 每个已 attach 的标签页的调试状态：console、网络请求、打开着的弹窗、跨进程 iframe 的子会话。
// 只存在内存里；调试器挂着时 Chrome 不会回收 service worker。
const tabState = new Map();
const MAX_CONSOLE = 500;
const MAX_REQUESTS = 500;
function stateOf(tabId) {
  let st = tabState.get(tabId);
  if (!st) {
    st = { console: [], requests: new Map(), seq: 0, dialog: null, dialogWaiters: new Set(), frames: [], runtimeOn: false };
    tabState.set(tabId, st);
  }
  return st;
}
function argText(a) {
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  const pv = a.preview;
  if (pv && Array.isArray(pv.properties) && (a.subtype === 'array' || !a.subtype)) {
    const items = pv.properties.map((p) => (a.subtype === 'array' ? '' : p.name + ': ') + (p.type === 'string' ? JSON.stringify(p.value) : p.value));
    if (pv.overflow) items.push('…');
    return a.subtype === 'array' ? `[${items.join(', ')}]` : `{${items.join(', ')}}`;
  }
  return a.description || a.unserializableValue || a.type;
}
function logConsole(st, level, text) {
  const entry = { level, text: String(text), at: Date.now() };
  st.console.push(entry);
  if (st.console.length > MAX_CONSOLE) st.console.splice(0, st.console.length - MAX_CONSOLE);
  return entry;
}
// Chrome 补发旧的 console 记录时不带对象预览（只有 "Object"）：到页面里把对象序列化出来，再填回这条记录。
const STRINGIFY = 'function(){ try { const s = JSON.stringify(this); return s === undefined ? String(this) : s.slice(0, 500); } catch (e) { return String(this); } }';
async function fillObjects(tabId, sessionId, entry, args) {
  const parts = await Promise.all(
    args.map(async (a) => {
      if (a.type !== 'object' || a.value !== undefined || a.preview || !a.objectId || a.subtype === 'error') return argText(a);
      try {
        const { result } = await cdp(tabId, 'Runtime.callFunctionOn', { objectId: a.objectId, functionDeclaration: STRINGIFY, returnByValue: true }, 2000, sessionId);
        return typeof result.value === 'string' ? result.value : argText(a);
      } catch {
        return argText(a);
      }
    })
  );
  entry.text = parts.join(' ');
}

// 没拿到 debugger 权限时别让整个 service worker 起不来，留到调用时再报错。
if (chrome.debugger) {
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId != null) {
      attached.delete(src.tabId);
      tabState.delete(src.tabId);
    }
  });
  chrome.debugger.onEvent.addListener((src, method, params = {}) => {
    const tabId = src.tabId;
    if (tabId == null) return;
    // 页面要开新窗口 / 新标签页时（window.open、target=_blank 的链接、表单提交）由发起的那个页面上报。
    if (method === 'Page.windowOpen') windowOpens.push({ tabId, url: params.url || '', at: Date.now() });
    const st = tabState.get(tabId);
    if (!st) return;
    switch (method) {
      case 'Runtime.consoleAPICalled':
      {
        const args = params.args || [];
        const entry = logConsole(st, params.type, args.map(argText).join(' '));
        if (args.some((a) => a.type === 'object' && a.value === undefined && !a.preview && a.objectId)) fillObjects(tabId, src.sessionId, entry, args);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        const where = d.url ? ` (${d.url}:${(d.lineNumber || 0) + 1})` : '';
        logConsole(st, 'error', ((d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught exception') + where);
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        logConsole(st, e.level === 'verbose' ? 'debug' : e.level, e.text + (e.url ? ` (${e.url})` : ''));
        break;
      }
      case 'Page.frameNavigated':
        if (!src.sessionId && params.frame && !params.frame.parentId) logConsole(st, 'nav', `navigated to ${params.frame.url}`);
        break;
      case 'Network.requestWillBeSent': {
        const q = params.request || {};
        let old = st.requests.get(params.requestId);
        if (old && params.redirectResponse) {
          // 重定向时 Chrome 用同一个 requestId 再报一次。把被重定向的那一跳单独留一条，否则 301 / 302 就看不到了。
          const s = params.redirectResponse;
          Object.assign(old, { status: s.status, statusText: s.statusText, mime: s.mimeType, resHeaders: s.headers || {}, done: true, redirectedTo: q.url });
          st.requests.delete(params.requestId);
          st.requests.set(`${params.requestId}#${old.id}`, old);
          old = { url: old.url };
        }
        st.requests.set(params.requestId, {
          id: old && old.id ? old.id : `r${++st.seq}`,
          requestId: params.requestId,
          sessionId: src.sessionId,
          method: q.method,
          url: q.url,
          type: params.type || '',
          reqHeaders: q.headers || {},
          postData: q.postData,
          redirectedFrom: old ? old.url : undefined,
        });
        if (st.requests.size > MAX_REQUESTS) st.requests.delete(st.requests.keys().next().value);
        break;
      }
      case 'Network.responseReceived': {
        const r = st.requests.get(params.requestId);
        if (!r) break;
        const s = params.response || {};
        Object.assign(r, { status: s.status, statusText: s.statusText, mime: s.mimeType, resHeaders: s.headers || {}, type: params.type || r.type });
        break;
      }
      case 'Network.loadingFinished': {
        const r = st.requests.get(params.requestId);
        if (r) Object.assign(r, { done: true, size: params.encodedDataLength });
        break;
      }
      case 'Network.loadingFailed': {
        const r = st.requests.get(params.requestId);
        if (r) Object.assign(r, { done: true, failed: params.canceled ? 'canceled' : params.errorText || 'failed' });
        break;
      }
      case 'Page.javascriptDialogOpening':
        st.dialog = { type: params.type, message: params.message || '', defaultPrompt: params.defaultPrompt, sessionId: src.sessionId };
        for (const reject of st.dialogWaiters) reject(new DialogOpen(dialogText(st.dialog)));
        st.dialogWaiters.clear();
        break;
      case 'Page.javascriptDialogClosed':
        st.dialog = null;
        break;
      case 'Target.attachedToTarget': {
        const info = params.targetInfo || {};
        if (info.type !== 'iframe') break;
        // 跨站 iframe 在另一个进程里，是单独的调试目标；记下来，快照和点击时按子会话访问。
        st.frames.push({ sessionId: params.sessionId, frameId: info.targetId, parent: src.sessionId });
        initSession(tabId, params.sessionId, st.runtimeOn);
        break;
      }
      case 'Target.detachedFromTarget': {
        const i = st.frames.findIndex((f) => f && f.sessionId === params.sessionId);
        if (i >= 0) st.frames[i] = null; // 留着空位，别的 iframe 的序号不变
        break;
      }
    }
  });
}

class DialogOpen extends Error {}
const dialogText = (d) =>
  `A JavaScript ${d.type} dialog is open on this tab: "${d.message.slice(0, 300)}". The page is blocked until you call page_dialog to accept or dismiss it.`;

// 给一个调试会话（标签页本身或它的某个跨站 iframe）打开需要的事件。
async function initSession(tabId, sessionId, withRuntime) {
  const on = (m, p) => cdp(tabId, m, p, 5000, sessionId).catch(() => {});
  await on('Page.enable');
  await on('Log.enable');
  await on('Network.enable');
  if (withRuntime) await on('Runtime.enable');
  // flatten：子目标作为同一条连接上的子会话出现（Chrome 125+）；老版本这一步失败，就只是读不到跨站 iframe。
  await on('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// sessionId 为空表示标签页本身；否则是某个跨站 iframe 的子会话。
// 页面弹出 alert / confirm 时，正在等的命令会一直卡住：这里让它立刻以 DialogOpen 失败，而不是等到超时。
function cdp(tabId, method, params = {}, ms = 10000, sessionId) {
  const st = tabState.get(tabId);
  const exempt = method === 'Page.handleJavaScriptDialog';
  if (st && st.dialog && !exempt) return Promise.reject(new DialogOpen(dialogText(st.dialog)));
  const send = chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params);
  send.catch(() => {});
  if (!st || exempt) return withTimeout(send, ms, method);
  let waiter;
  const dialog = new Promise((_, reject) => {
    waiter = reject;
    st.dialogWaiters.add(reject);
  });
  dialog.catch(() => {});
  return withTimeout(Promise.race([send, dialog]), ms, method).finally(() => st.dialogWaiters.delete(waiter));
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  if (!chrome.debugger) throw new Error('The extension has no "debugger" permission yet. Reload it once in chrome://extensions.');
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // service worker 重启后内存里的记录没了，但调试器可能还挂着：能发命令就当作已连上。
    const mine = /already attached/i.test(e.message) && (await cdp(tabId, 'Runtime.evaluate', { expression: '1' }, 3000).then(() => true, () => false));
    if (!mine) {
      if (/already attached/i.test(e.message)) throw new Error(`Tab ${tabId} is being debugged by something else (DevTools or another extension). Close that first.`);
      throw new Error(`Cannot control tab ${tabId}: ${e.message}`);
    }
  }
  attached.add(tabId);
  stateOf(tabId);
  // 让页面当自己在前台、有焦点：后台标签页和被挡住的窗口里，鼠标键盘事件才会照常送达。
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // Page：新标签页上报和弹窗；Log / Network：浏览器侧日志和请求；自动附加：跨站 iframe。
  // Runtime 域不在这里开（页面脚本能探测到它），等第一次 page_console 再开，开的时候 Chrome 会补发之前的 console 记录。
  await initSession(tabId, undefined, false);
}

// 松开调试器（顶部的"正在调试此浏览器"提示条随之消失）。
async function detachTabs(ids) {
  for (const tabId of ids) {
    if (!attached.has(tabId)) continue;
    attached.delete(tabId);
    tabState.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
  }
}

async function ownedTab(sess, p) {
  if (!Number.isInteger(p.tabId)) throw new Error('tabId is required');
  const mine = (await sessionTabs(sess)).some((t) => t.id === p.tabId);
  if (!mine) throw new Error(`Tab ${p.tabId} does not belong to this session. Open it with tab_open or take it over with tabs_adopt first.`);
  return p.tabId;
}

// ref 形如 e42（主页面和同进程 iframe 里的元素）或 f2e42（第 2 个跨站 iframe 里的元素）。
function refToNode(tabId, ref) {
  const m = /^(?:f(\d+))?e(\d+)$/.exec(String(ref || ''));
  if (!m) throw new Error(`Invalid ref "${ref}". Use a ref from page_snapshot, like "e42".`);
  const node = { backendNodeId: Number(m[2]), sessionId: undefined };
  if (m[1]) {
    const f = ((tabState.get(tabId) || {}).frames || [])[Number(m[1]) - 1];
    if (!f) throw new Error(`The iframe that ref "${ref}" pointed into is gone. Take a new page_snapshot.`);
    node.sessionId = f.sessionId;
  }
  return node;
}
const frameOf = (tabId, sessionId) => (sessionId ? ((tabState.get(tabId) || {}).frames || []).find((f) => f && f.sessionId === sessionId) : undefined);
const framePrefix = (tabId, sessionId) => (sessionId ? `f${tabState.get(tabId).frames.findIndex((f) => f && f.sessionId === sessionId) + 1}` : '');

// 跨站 iframe 里量出来的坐标是相对它自己的；逐层加上 iframe 在父页面里的位置，得到整个标签页里的坐标。
async function frameOffset(tabId, sessionId) {
  let x = 0;
  let y = 0;
  for (let f = frameOf(tabId, sessionId); f; f = frameOf(tabId, f.parent)) {
    const { backendNodeId } = await cdp(tabId, 'DOM.getFrameOwner', { frameId: f.frameId }, 10000, f.parent);
    await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }, 10000, f.parent).catch(() => {});
    const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId }, 10000, f.parent);
    if (!quads || !quads.length) throw new Error('The iframe that contains this element is not visible.');
    x += quads[0][0];
    y += quads[0][1];
  }
  return { x, y };
}

// ---------- 快照：无障碍树转成紧凑文本 ----------
const INTERACTIVE = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
]);
const FLAGS = ['checked', 'disabled', 'expanded', 'selected', 'required', 'pressed'];
// 页面区域：给它们 ref，是为了 page_snapshot 能只读其中一块。
const REGION = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'article', 'table', 'grid']);
const MAX_SNAPSHOT = 40000;
const SHOT_MAX_WIDTH = 1280;
const NEW_TAB_WAIT_MS = 500;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

// tree = { nodes, prefix, frames }：nodes 是一个 frame 的无障碍树，prefix 是它的 ref 前缀，
// frames 把 <iframe> 元素（backendDOMNodeId）映射到它里面那个 frame 的 tree，渲染时接在 iframe 那一行下面。
function renderAxTree(tree, opts = {}) {
  const lines = [];
  let size = 0;
  let truncated = false;
  const push = (depth, text) => {
    const line = '  '.repeat(depth) + text;
    size += line.length + 1;
    if (size > MAX_SNAPSHOT) {
      if (!truncated) lines.push(`… (snapshot cut at ${MAX_SNAPSHOT} characters: pass ref to read one part of the page, or interactive=true to list only the elements you can act on)`);
      truncated = true;
      return;
    }
    lines.push(line);
  };
  const walkTree = (tr, baseDepth, start) => {
    const byId = new Map(tr.nodes.map((n) => [n.nodeId, n]));
    const walk = (node, depth, parentName) => {
      if (!node || truncated) return;
      const role = (node.role && node.role.value) || '';
      const name = String((node.name && node.name.value) || '').replace(/\s+/g, ' ').trim();
      if (role === 'InlineTextBox' || role === 'LineBreak') return;
      const kids = (d, pn) => (node.childIds || []).forEach((id) => walk(byId.get(id), d, pn));
      if (role === 'StaticText') {
        if (name && name !== parentName && !opts.interactive) push(depth, `- text: ${clip(name, 300)}`);
        return;
      }
      const props = new Map((node.properties || []).map((p) => [p.name, p.value && p.value.value]));
      const focusable = props.get('focusable') === true;
      const plain = !role || role === 'generic' || role === 'none';
      const sub = tr.frames.get(node.backendDOMNodeId);
      if (!sub && (node.ignored || (plain && !name && !focusable))) return kids(depth, parentName);
      let line = `- ${sub ? 'iframe' : role || 'generic'}`;
      if (name) line += ` "${clip(name, 200)}"`;
      if (role === 'heading' && props.get('level')) line += ` [level=${props.get('level')}]`;
      if ((INTERACTIVE.has(role) || focusable || REGION.has(role) || (role === 'image' && name)) && node.backendDOMNodeId && role !== 'RootWebArea' && !sub) line += ` [ref=${tr.prefix}e${node.backendDOMNodeId}]`;
      for (const f of FLAGS) {
        const v = props.get(f);
        if (v === true || v === 'true') line += ` [${f}]`;
        else if (v === 'mixed') line += ` [${f}=mixed]`;
      }
      const value = node.value && node.value.value;
      if (value !== undefined && value !== '' && String(value) !== name) line += ` value="${clip(String(value), 200)}"`;
      if (!opts.interactive) push(depth, line);
      else if (line.includes('[ref=') || role === 'heading' || sub) push(0, line);
      if (sub) walkTree(sub, depth + 1);
      kids(depth + 1, name);
    };
    walk(start || tr.nodes.find((n) => !n.parentId) || tr.nodes[0], baseDepth, '');
  };
  if (opts.ref) {
    const m = /^(f\d+)?e(\d+)$/.exec(String(opts.ref));
    const find = (tr) => {
      const n = m && tr.prefix === (m[1] || '') && tr.nodes.find((x) => x.backendDOMNodeId === Number(m[2]));
      if (n) return { tr, n };
      for (const sub of tr.frames.values()) {
        const hit = find(sub);
        if (hit) return hit;
      }
      return null;
    };
    const hit = find(tree);
    if (!hit) throw new Error(`No element with ref "${opts.ref}" on the page now. Call page_snapshot without ref to get the current refs.`);
    walkTree(hit.tr, 0, hit.n);
  } else {
    walkTree(tree, 0);
  }
  return lines.join('\n');
}

// 取一个 frame 的无障碍树，并顺着里面的 <iframe> 往下取：同进程的 iframe 用 frameId 在同一个会话里取，
// 跨站 iframe 到它自己的子会话里取。budget 限制总共取多少个 iframe，免得广告多的页面拖慢快照。
const MAX_IFRAMES = 25;
async function collectTree(tabId, sessionId, frameId, budget, depth = 0) {
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree', frameId ? { frameId } : {}, 15000, sessionId);
  const tree = { nodes, prefix: framePrefix(tabId, sessionId), frames: new Map() };
  if (depth >= 4) return tree;
  for (const n of nodes) {
    const role = n.role && n.role.value;
    if ((role !== 'Iframe' && role !== 'IframePresentational') || !n.backendDOMNodeId || budget.left <= 0) continue;
    try {
      const { node } = await cdp(tabId, 'DOM.describeNode', { backendNodeId: n.backendDOMNodeId }, 5000, sessionId);
      if (!node.frameId) continue;
      budget.left--;
      const child = ((tabState.get(tabId) || {}).frames || []).find((f) => f && f.frameId === node.frameId);
      const sub = child
        ? await collectTree(tabId, child.sessionId, undefined, budget, depth + 1)
        : await collectTree(tabId, sessionId, node.frameId, budget, depth + 1);
      tree.frames.set(n.backendDOMNodeId, sub);
    } catch (e) {
      if (e instanceof DialogOpen) throw e;
      // 这个 iframe 读不到（刚被移除、还没加载完等）就跳过，不影响其余内容。
    }
  }
  return tree;
}
// ---------- 点击 / 输入 ----------
async function centerOf(tabId, node) {
  const { backendNodeId, sessionId } = node;
  const on = (method, params) => cdp(tabId, method, params, 10000, sessionId);
  try {
    await on('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch (e) {
    if (e instanceof DialogOpen) throw e;
    throw new Error(`Element not found (${e.message}). The page may have changed; take a new page_snapshot.`);
  }
  const { object } = await on('DOM.resolveNode', { backendNodeId });
  // 找一个真的会落在目标元素上的点：逐个试它的每块区域；都被挡住就把它滚到视口中间再试一轮。
  let blocker = '';
  for (let round = 0; round < 2; round++) {
    const off = await frameOffset(tabId, sessionId);
    const { quads } = await on('DOM.getContentQuads', { backendNodeId });
    if (!quads || !quads.length) throw new Error('Element is not visible, so it cannot be clicked.');
    for (const q of quads.slice(0, 8)) {
      const pt = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
      const { result } = await on('Runtime.callFunctionOn', {
        objectId: object.objectId,
        arguments: [{ value: pt.x }, { value: pt.y }],
        returnByValue: true,
        functionDeclaration: HIT_TEST,
      });
      if (result.value === 'ok') return { x: pt.x + off.x, y: pt.y + off.y };
      blocker = result.value;
    }
    if (round === 0) {
      await on('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }',
      });
      await settle(150);
    }
  }
  throw new Error(`Element is covered by ${blocker}, so a click would land on that instead. Dismiss or scroll past it, then take a new page_snapshot.`);
}

// 在页面里执行：(x, y) 处最上层的元素是不是目标自己（或它的子孙 / 包着它的 label 之类）。
const HIT_TEST = `function(x, y) {
  if (window !== window.top) { const r = this.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
  let top = document.elementFromPoint(x, y);
  while (top && top.shadowRoot && top.shadowRoot.elementFromPoint(x, y) && top.shadowRoot.elementFromPoint(x, y) !== top) top = top.shadowRoot.elementFromPoint(x, y);
  if (!top) return 'nothing (the point is outside the viewport)';
  const inside = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false; };
  if (inside(this, top) || inside(top, this)) return 'ok';
  const cls = typeof top.className === 'string' && top.className.trim() ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
  const text = (top.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  return '<' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + cls + '>' + (text ? ' "' + text + '"' : '');
}`;

async function clickAt(tabId, { x, y }, clickCount = 1) {
  const base = { x, y, button: 'left', clickCount };
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
};

async function pressKey(tabId, name) {
  const k = KEYS[name];
  if (!k) throw new Error(`Unsupported key "${name}". Supported: ${Object.keys(KEYS).join(', ')}.`);
  const base = { key: k.key || name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', ...(k.text ? { text: k.text } : {}) });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// 等标签页加载完；超时不算错，照样返回当前状态。
async function waitLoaded(tabId, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete' || Date.now() > deadline) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// 执行一个可能开出新标签页的动作（点击、回车）。动作期间由这个标签页开出的新标签页：
// 直接收进 session（不等 onCreated 那条排队的自动收编）、在返回值的 opened 里报出来，
// 并且不让它抢走用户正在看的标签页。
async function actAndCollect(sess, sid, tabId, action, loadMs) {
  const self = await chrome.tabs.get(tabId);
  const [front] = await chrome.tabs.query({ windowId: self.windowId, active: true });
  const created = [];
  const onCreated = (t) => created.push({ id: t.id, opener: t.openerTabId });
  chrome.tabs.onCreated.addListener(onCreated);
  const startedAt = Date.now();
  try {
    try {
      await action();
    } catch (e) {
      if (!(e instanceof DialogOpen)) throw e; // 动作弹出了 alert / confirm：不算失败，在返回值里报出来
    }
    // 新标签页一般立刻出现；稍等一下，一出现就不再多等。
    const deadline = Date.now() + NEW_TAB_WAIT_MS;
    while (Date.now() < deadline && !created.length) await settle(50);
    await settle(created.length ? 200 : 0);
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
  // 这次动作期间，本标签页上报了几次"要开新窗口"。
  let claims = windowOpens.filter((w) => w.tabId === tabId && w.at >= startedAt).length;
  windowOpens = windowOpens.filter((w) => Date.now() - w.at < 30000);
  const opened = [];
  for (const { id, opener } of created) {
    let t;
    try {
      t = await chrome.tabs.get(id);
    } catch {
      continue; // 开了又马上关了
    }
    const win = await chrome.windows.get(t.windowId);
    // 怎么认出"是这次动作开的"：openerTabId 和所在的组都靠不住——后台标签页开出的新标签页，
    // Chrome 把这两样都记到窗口里当时的前台标签页上。可靠的是本标签页上报的 Page.windowOpen：
    // 上报了几次，就认领几个动作期间出现的新标签页。
    let mine = opener === tabId;
    if (!mine && claims > 0) mine = true;
    if (!mine) continue; // 比如用户自己刚好开了一个
    claims--;
    if (win.type === 'normal') await putInSessionGroup(sess, sid, [id]);
    else if (!sess.extra.includes(id)) sess.extra.push(id);
    opened.push(id);
  }
  // 新标签页默认开在前台；用户原来在看别的标签页的话，切回去。
  // 弹窗（prompt 等）也会把所在的标签页顶到前台。两种情况都切回用户原来在看的那个。
  if (front) {
    const [now] = await chrome.tabs.query({ windowId: self.windowId, active: true });
    if (now && now.id !== front.id && (opened.includes(now.id) || now.id === tabId)) await chrome.tabs.update(front.id, { active: true }).catch(() => {});
  }
  const result = withDialog(tabId, tabInfo(await waitLoaded(tabId, loadMs)));
  if (opened.length) {
    result.opened = [];
    for (const id of opened) result.opened.push(tabInfo(await chrome.tabs.get(id)));
  }
  return result;
}

// 标签页上开着弹窗时，在返回值里带上它，agent 才知道下一步要先处理弹窗。
function withDialog(tabId, result) {
  const d = (tabState.get(tabId) || {}).dialog;
  if (d) result.dialog = { type: d.type, message: d.message, note: 'The page is blocked until you call page_dialog.' };
  return result;
}

async function resolveRef(tabId, ref) {
  const node = refToNode(tabId, ref);
  try {
    const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }, 10000, node.sessionId);
    return { objectId: object.objectId, sessionId: node.sessionId };
  } catch (e) {
    if (e instanceof DialogOpen) throw e;
    throw new Error(`Element not found (${e.message}). The page may have changed; take a new page_snapshot.`);
  }
}

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token)$/i;
const headerLines = (h) => Object.entries(h || {}).map(([k, v]) => `  ${k}: ${SECRET_HEADER.test(k) ? `[redacted, ${String(v).length} chars]` : clip(String(v), 500)}`);
const statusOf = (r) => (r.failed ? `FAILED(${r.failed})` : r.status ? String(r.status) : 'pending');
const clamp = (v, dflt, lo, hi) => Math.min(Math.max(Number(v) || dflt, lo), hi);

const pageHandlers = {
  async page_navigate(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!p.url) throw new Error('url is required');
    // 先挂上调试器，这次加载的请求才记得到；挂不上（比如当前是 chrome:// 页面）不影响导航。
    await ensureAttached(tabId).catch(() => {});
    await chrome.tabs.update(tabId, { url: p.url });
    await settle(200);
    return withDialog(tabId, tabInfo(await waitLoaded(tabId, 15000)));
  },

  async page_snapshot(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const tree = await collectTree(tabId, undefined, undefined, { left: MAX_IFRAMES });
    const t = await chrome.tabs.get(tabId);
    return { __text: `url: ${t.url}\ntitle: ${t.title}\n\n${renderAxTree(tree, { ref: p.ref, interactive: p.interactive === true })}` };
  },

  async page_click(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const pt = await centerOf(tabId, refToNode(tabId, p.ref));
    return actAndCollect(sess, sid, tabId, () => clickAt(tabId, pt, p.double ? 2 : 1), 10000);
  },

  async page_type(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (typeof p.text !== 'string') throw new Error('text is required');
    await ensureAttached(tabId);
    const node = refToNode(tabId, p.ref);
    await clickAt(tabId, await centerOf(tabId, node));
    if (!p.append) {
      // 先全选，输入的内容就会替换掉原有内容。
      const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }, 10000, node.sessionId);
      await cdp(
        tabId,
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration:
            'function(){ this.focus && this.focus(); if (typeof this.select === "function") this.select(); else document.execCommand("selectAll"); }',
        },
        10000,
        node.sessionId
      );
    }
    // 文字插入发给元素所在的会话：跨站 iframe 有自己的输入目标。
    if (p.text) await cdp(tabId, 'Input.insertText', { text: p.text }, 10000, node.sessionId);
    else if (!p.append) await pressKey(tabId, 'Delete');
    if (p.submit) return actAndCollect(sess, sid, tabId, () => pressKey(tabId, 'Enter'), 10000);
    return withDialog(tabId, tabInfo(await chrome.tabs.get(tabId)));
  },

  async page_key(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    return actAndCollect(sess, sid, tabId, () => pressKey(tabId, p.key), p.key === 'Enter' ? 10000 : 0);
  },

  async page_screenshot(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    // 高分屏上原始截图能到 5000 像素宽，模型看不了也没必要：缩到最宽 1280。
    const { cssVisualViewport: vv } = await cdp(tabId, 'Page.getLayoutMetrics');
    const dpr = (await cdp(tabId, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true })).result.value || 1;
    const scale = Math.min(1, SHOT_MAX_WIDTH / (vv.clientWidth * dpr));
    const params = { format: 'jpeg', quality: 70, clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale } };
    // Chrome 只给窗口里的前台标签页出完整的画面。后台标签页直接截，有时超时，有时拿到低清或只画了一部分的旧画面
    // （实测同一个页面时好时坏），所以一律在它的窗口里短暂切过去，截完马上切回用户原来看的那个，不动窗口焦点。
    // 刚切过去的头一两张仍可能是低清的一帧，这种画面压成 JPEG 明显更小：连截三张，留最大的。
    const self = await chrome.tabs.get(tabId);
    const [front] = self.active ? [self] : await chrome.tabs.query({ windowId: self.windowId, active: true });
    let shot;
    let note = '';
    if (!self.active) await chrome.tabs.update(tabId, { active: true });
    try {
      shot = await cdp(tabId, 'Page.captureScreenshot', params, 8000);
      for (let i = 0; i < 2 && !self.active; i++) {
        await settle(300);
        const next = await cdp(tabId, 'Page.captureScreenshot', params, 2500).catch((e) => {
          if (e instanceof DialogOpen) throw e;
          return shot;
        });
        if (next.data.length > shot.data.length) shot = next;
      }
    } catch (e) {
      if (e instanceof DialogOpen) throw e;
      throw new Error(
        `${e.message}. Chrome did not paint the tab; its window is probably minimized or fully covered. Call tab_activate with tabId=${tabId} and focusWindow=true, then try again (this brings Chrome to the front).`
      );
    } finally {
      if (!self.active && front && front.id !== tabId) await chrome.tabs.update(front.id, { active: true }).catch(() => {});
    }
    if (!self.active) note = '\nnote: the tab was in the background, so it was switched to for a moment and then switched back.';
    const t = await chrome.tabs.get(tabId);
    return { __image: { data: shot.data, mimeType: 'image/jpeg' }, __text: `url: ${t.url}\ntitle: ${t.title}${note}` };
  },

  async page_hover(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const { x, y } = await centerOf(tabId, refToNode(tabId, p.ref));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await settle(300);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async page_select(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!Array.isArray(p.values) || !p.values.length) throw new Error('values must be a non-empty array of option labels or values');
    await ensureAttached(tabId);
    const el = await resolveRef(tabId, p.ref);
    const { result } = await cdp(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        arguments: [{ value: p.values.map(String) }],
        returnByValue: true,
        functionDeclaration: `function(wanted) {
        if (this.tagName !== 'SELECT') return { error: 'Element is a <' + this.tagName.toLowerCase() + '>, not a <select>. For custom dropdowns, click it and then click the option.' };
        const opts = Array.from(this.options);
        const norm = (s) => String(s).replace(/\\s+/g, ' ').trim();
        const picked = [];
        for (const w of wanted) {
          const o = opts.find((o) => o.value === w) || opts.find((o) => norm(o.label) === norm(w)) || opts.find((o) => norm(o.text) === norm(w));
          if (!o) return { error: 'No option "' + w + '". Available: ' + opts.map((o) => norm(o.text)).slice(0, 30).join(' | ') };
          picked.push(o);
        }
        if (!this.multiple && picked.length > 1) return { error: 'This select takes a single value.' };
        for (const o of opts) o.selected = picked.includes(o);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: picked.map((o) => norm(o.text)) };
      }`,
      },
      10000,
      el.sessionId
    );
    if (result.value && result.value.error) throw new Error(result.value.error);
    return result.value;
  },

  // 一次填多个表单字段：下拉框按选项选，复选框 / 单选框按 true / false 勾选，其余当文本框输入。
  async page_fill(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!Array.isArray(p.fields) || !p.fields.length) throw new Error('fields must be a non-empty array of { ref, value }');
    await ensureAttached(tabId);
    let n = 0;
    for (const f of p.fields) {
      try {
        const el = await resolveRef(tabId, f.ref);
        const { result } = await cdp(
          tabId,
          'Runtime.callFunctionOn',
          {
            objectId: el.objectId,
            returnByValue: true,
            functionDeclaration: `function() {
            const type = (this.type || '').toLowerCase();
            const role = this.getAttribute && this.getAttribute('role');
            if (this.tagName === 'SELECT') return 'select';
            if (this.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) return this.checked ? 'on' : 'off';
            if (role === 'checkbox' || role === 'switch' || role === 'radio') return this.getAttribute('aria-checked') === 'true' ? 'on' : 'off';
            return 'text';
          }`,
          },
          10000,
          el.sessionId
        );
        const kind = result.value;
        if (kind === 'select') await pageHandlers.page_select(sess, sid, { tabId, ref: f.ref, values: Array.isArray(f.value) ? f.value : [String(f.value)] });
        else if (kind === 'text') await pageHandlers.page_type(sess, sid, { tabId, ref: f.ref, text: String(f.value == null ? '' : f.value) });
        else {
          const want = f.value === true || f.value === 'true' || f.value === 'on' ? 'on' : 'off';
          if (want !== kind) await pageHandlers.page_click(sess, sid, { tabId, ref: f.ref });
        }
        n++;
      } catch (e) {
        throw new Error(`Field ${n + 1} (ref ${f.ref}): ${e.message} ${n} field(s) before it were filled.`);
      }
    }
    return withDialog(tabId, { filled: n });
  },

  async page_scroll(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    if (p.ref) {
      const el = await resolveRef(tabId, p.ref);
      await cdp(
        tabId,
        'Runtime.callFunctionOn',
        { objectId: el.objectId, functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }' },
        10000,
        el.sessionId
      );
    } else {
      const dir = p.direction || 'down';
      const expr = {
        down: 'window.scrollBy(0, innerHeight * 0.85)',
        up: 'window.scrollBy(0, -innerHeight * 0.85)',
        top: 'window.scrollTo(0, 0)',
        bottom: 'window.scrollTo(0, document.documentElement.scrollHeight)',
      }[dir];
      if (!expr) throw new Error('direction must be one of: down, up, top, bottom');
      await cdp(tabId, 'Runtime.evaluate', { expression: expr });
    }
    await settle(300);
    const { result } = await cdp(tabId, 'Runtime.evaluate', {
      expression: '({ scrollY: Math.round(scrollY), viewportHeight: innerHeight, pageHeight: document.documentElement.scrollHeight })',
      returnByValue: true,
    });
    return result.value;
  },

  async page_history(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (p.direction === 'forward') await chrome.tabs.goForward(tabId);
    else if (p.direction === 'back' || !p.direction) await chrome.tabs.goBack(tabId);
    else if (p.direction === 'reload') await chrome.tabs.reload(tabId);
    else throw new Error('direction must be one of: back, forward, reload');
    await settle(300);
    return withDialog(tabId, tabInfo(await waitLoaded(tabId, 15000)));
  },

  async page_wait(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!p.text && !p.textGone) throw new Error('Pass text (wait until it appears) or textGone (wait until it disappears).');
    await ensureAttached(tabId);
    const ms = clamp(p.timeoutMs, 10000, 500, 15000);
    const deadline = Date.now() + ms;
    for (;;) {
      const { result } = await cdp(tabId, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
      const body = String(result.value || '');
      const ok = p.text ? body.includes(p.text) : !body.includes(p.textGone);
      if (ok) return { found: true, waitedMs: ms - Math.max(deadline - Date.now(), 0) };
      if (Date.now() > deadline) throw new Error(`Timed out after ${ms / 1000}s waiting for ${p.text ? `"${p.text}" to appear` : `"${p.textGone}" to disappear`}.`);
      await settle(250);
    }
  },

  async page_eval(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (typeof p.expression !== 'string' || !p.expression.trim()) throw new Error('expression is required');
    await ensureAttached(tabId);
    const r = await cdp(tabId, 'Runtime.evaluate', { expression: p.expression, awaitPromise: true, returnByValue: true, userGesture: true }, 15000);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error(`Page script threw: ${(ex && (ex.description || ex.value)) || r.exceptionDetails.text}`);
    }
    const text = r.result.value === undefined ? String(r.result.description || 'undefined') : JSON.stringify(r.result.value, null, 2);
    return { __text: text.length > 60000 ? text.slice(0, 60000) + '\n… (truncated)' : text };
  },

  // ---------- 调试：console、网络、弹窗、上传 ----------
  async page_console(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const st = stateOf(tabId);
    if (!st.runtimeOn) {
      // 第一次用才打开 Runtime 域；打开时 Chrome 会把页面之前的 console 记录和未捕获异常补发过来。
      st.runtimeOn = true;
      await cdp(tabId, 'Runtime.enable').catch(() => {});
      for (const f of st.frames) if (f) await cdp(tabId, 'Runtime.enable', {}, 5000, f.sessionId).catch(() => {});
      await settle(500);
    }
    const min = p.level === 'error' ? 3 : p.level === 'warning' ? 2 : 0;
    const rank = (l) => (l === 'error' ? 3 : l === 'warning' ? 2 : 1);
    const all = st.console.filter((m) => m.level === 'nav' || rank(m.level) >= min);
    const shown = all.slice(-clamp(p.limit, 100, 1, MAX_CONSOLE));
    if (p.clear) st.console = [];
    if (!all.some((m) => m.level !== 'nav')) return { __text: 'No console messages.' };
    const body = shown.map((m) => (m.level === 'nav' ? `--- ${m.text} ---` : `[${m.level}] ${clip(m.text, 2000)}`)).join('\n');
    return { __text: (all.length > shown.length ? `(showing the last ${shown.length} of ${all.length})\n` : '') + body };
  },

  async page_network(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const st = stateOf(tabId);
    const all = [...st.requests.values()];
    if (p.requestId) {
      const r = all.find((x) => x.id === p.requestId);
      if (!r) throw new Error(`No request "${p.requestId}". Call page_network without requestId to list the captured requests.`);
      const lines = [`${r.method} ${r.url}`, `type: ${r.type || '?'}`, `status: ${statusOf(r)}${r.statusText ? ' ' + r.statusText : ''}`];
      if (r.redirectedFrom) lines.push(`redirected from: ${r.redirectedFrom}`);
      if (r.redirectedTo) lines.push(`redirected to: ${r.redirectedTo}`);
      lines.push('', 'request headers:', ...headerLines(r.reqHeaders));
      if (r.postData) lines.push('', 'request body:', clip(r.postData, 5000));
      if (r.resHeaders) lines.push('', 'response headers:', ...headerLines(r.resHeaders));
      if (r.done && !r.failed && !r.redirectedTo) {
        try {
          const b = await cdp(tabId, 'Network.getResponseBody', { requestId: r.requestId }, 10000, r.sessionId);
          lines.push('', 'response body:', b.base64Encoded ? `(binary, about ${Math.round(b.body.length * 0.75)} bytes)` : clip(b.body, 20000));
        } catch (e) {
          if (e instanceof DialogOpen) throw e;
          lines.push('', `response body: not available (${e.message})`);
        }
      }
      return { __text: lines.join('\n') };
    }
    let items = all;
    if (p.filter) items = items.filter((r) => r.url.toLowerCase().includes(String(p.filter).toLowerCase()));
    if (p.failed) items = items.filter((r) => r.failed || r.status >= 400);
    const shown = items.slice(-clamp(p.limit, 50, 1, 200));
    if (p.clear) st.requests.clear();
    if (!items.length) {
      return {
        __text: all.length
          ? `None of the ${all.length} captured requests match.`
          : 'No requests captured. Only requests made after TabDeck first acted on this tab are recorded; use page_history with direction "reload" to capture a full page load.',
      };
    }
    const head = `${items.length} request(s)${items.length > shown.length ? `, showing the last ${shown.length}` : ''}. Pass requestId for headers and body.`;
    return { __text: [head, ...shown.map((r) => `${r.id}  ${r.method} ${statusOf(r)}  ${r.type || '?'}  ${clip(r.url, 300)}${r.redirectedTo ? '  -> ' + clip(r.redirectedTo, 200) : ''}`)].join('\n') };
  },

  async page_dialog(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    const st = tabState.get(tabId);
    if (!st || !st.dialog) throw new Error('No JavaScript dialog is open on this tab.');
    const d = st.dialog;
    const accept = p.accept !== false;
    const params = { accept };
    if (typeof p.promptText === 'string') params.promptText = p.promptText;
    await cdp(tabId, 'Page.handleJavaScriptDialog', params, 10000, d.sessionId);
    st.dialog = null;
    await settle(100);
    return withDialog(tabId, { type: d.type, message: d.message, accepted: accept });
  },

  async page_upload(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!Array.isArray(p.paths) || !p.paths.length || p.paths.some((x) => typeof x !== 'string' || !x)) throw new Error('paths must be a non-empty array of absolute file paths');
    await ensureAttached(tabId);
    let el;
    if (p.ref) el = await resolveRef(tabId, p.ref);
    else {
      // 文件输入框经常是隐藏的，快照里没有：页面里只有一个时直接用它。
      const { result } = await cdp(tabId, 'Runtime.evaluate', {
        expression: '(() => { const a = document.querySelectorAll("input[type=file]"); return a.length === 1 ? a[0] : a.length; })()',
      });
      if (!result.objectId) {
        throw new Error(result.value ? `This page has ${result.value} file inputs; pass the ref of the one to use.` : 'No file input found in the main page. If it is inside an iframe, pass its ref from page_snapshot.');
      }
      el = { objectId: result.objectId, sessionId: undefined };
    }
    const call = (functionDeclaration) => cdp(tabId, 'Runtime.callFunctionOn', { objectId: el.objectId, returnByValue: true, functionDeclaration }, 10000, el.sessionId);
    const kind = (await call('function(){ return this.tagName === "INPUT" && this.type === "file" ? (this.multiple ? "multi" : "single") : "<" + this.tagName.toLowerCase() + ">"; }')).result.value;
    if (kind !== 'multi' && kind !== 'single') throw new Error(`Element is a ${kind}, not a file input. If the page uses a button that opens a file picker, call page_upload without ref to use the page's hidden file input.`);
    if (kind === 'single' && p.paths.length > 1) throw new Error('This file input takes a single file.');
    try {
      await cdp(tabId, 'DOM.setFileInputFiles', { files: p.paths, objectId: el.objectId }, 10000, el.sessionId);
    } catch (e) {
      if (/not allowed/i.test(e.message)) {
        throw new Error('Chrome refused to set the file: extensions may only do this when they are allowed to read local files. Open chrome://extensions, click Details on TabDeck, turn on "Allow access to file URLs", then try again.');
      }
      throw e;
    }
    const files = (await call('function(){ return Array.from(this.files).map((f) => ({ name: f.name, size: f.size })); }')).result.value;
    return withDialog(tabId, { files });
  },
};
