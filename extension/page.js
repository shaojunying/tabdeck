// 页面操作（第二阶段）：经 chrome.debugger（CDP）读页面结构、点击、输入、截图。
// 由 background.js 用 importScripts 载入，共用它的 sessionTabs / tabInfo。
// 只允许操作本 session 的标签页；别的标签页要先 tabs_adopt。

const attached = new Set(); // 已 attach 调试器的 tabId
// 没拿到 debugger 权限时别让整个 service worker 起不来，留到调用时再报错。
if (chrome.debugger) {
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId != null) attached.delete(src.tabId);
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cdp(tabId, method, params = {}, ms = 10000) {
  return withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), ms, method);
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
  // 让页面当自己在前台、有焦点：后台标签页和被挡住的窗口里，鼠标键盘事件才会照常送达。
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

// 松开调试器（顶部的"正在调试此浏览器"提示条随之消失）。
async function detachTabs(ids) {
  for (const tabId of ids) {
    if (!attached.has(tabId)) continue;
    attached.delete(tabId);
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

function refToNode(ref) {
  const m = /^e(\d+)$/.exec(String(ref || ''));
  if (!m) throw new Error(`Invalid ref "${ref}". Use a ref from page_snapshot, like "e42".`);
  return Number(m[1]);
}

// ---------- 快照：无障碍树转成紧凑文本 ----------
const INTERACTIVE = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
]);
const FLAGS = ['checked', 'disabled', 'expanded', 'selected', 'required', 'pressed'];
const MAX_SNAPSHOT = 60000;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function renderAxTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  let size = 0;
  let truncated = false;
  const walk = (node, depth, parentName) => {
    if (!node || truncated) return;
    const role = (node.role && node.role.value) || '';
    const name = String((node.name && node.name.value) || '').replace(/\s+/g, ' ').trim();
    if (role === 'InlineTextBox' || role === 'LineBreak') return;
    const kids = (d, pn) => (node.childIds || []).forEach((id) => walk(byId.get(id), d, pn));
    if (role === 'StaticText') {
      if (name && name !== parentName) push(depth, `- text: ${clip(name, 300)}`);
      return;
    }
    const props = new Map((node.properties || []).map((p) => [p.name, p.value && p.value.value]));
    const focusable = props.get('focusable') === true;
    const plain = !role || role === 'generic' || role === 'none';
    if (node.ignored || (plain && !name && !focusable)) return kids(depth, parentName);
    let line = `- ${role || 'generic'}`;
    if (name) line += ` "${clip(name, 200)}"`;
    if (role === 'heading' && props.get('level')) line += ` [level=${props.get('level')}]`;
    if ((INTERACTIVE.has(role) || focusable) && node.backendDOMNodeId && role !== 'RootWebArea') line += ` [ref=e${node.backendDOMNodeId}]`;
    for (const f of FLAGS) {
      const v = props.get(f);
      if (v === true || v === 'true') line += ` [${f}]`;
      else if (v === 'mixed') line += ` [${f}=mixed]`;
    }
    const value = node.value && node.value.value;
    if (value !== undefined && value !== '' && String(value) !== name) line += ` value="${clip(String(value), 200)}"`;
    push(depth, line);
    kids(depth + 1, name);
  };
  const push = (depth, text) => {
    const line = '  '.repeat(depth) + text;
    size += line.length + 1;
    if (size > MAX_SNAPSHOT) {
      truncated = true;
      lines.push('… (snapshot truncated)');
      return;
    }
    lines.push(line);
  };
  walk(nodes.find((n) => !n.parentId) || nodes[0], 0, '');
  return lines.join('\n');
}

// ---------- 点击 / 输入 ----------
async function centerOf(tabId, backendNodeId) {
  try {
    await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch (e) {
    throw new Error(`Element not found (${e.message}). The page may have changed; take a new page_snapshot.`);
  }
  const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId });
  if (!quads || !quads.length) throw new Error('Element is not visible, so it cannot be clicked.');
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

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

const pageHandlers = {
  async page_navigate(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!p.url) throw new Error('url is required');
    await chrome.tabs.update(tabId, { url: p.url });
    await settle(200);
    return tabInfo(await waitLoaded(tabId, 15000));
  },

  async page_snapshot(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree', {}, 15000);
    const t = await chrome.tabs.get(tabId);
    return { __text: `url: ${t.url}\ntitle: ${t.title}\n\n${renderAxTree(nodes)}` };
  },

  async page_click(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    await clickAt(tabId, await centerOf(tabId, refToNode(p.ref)), p.double ? 2 : 1);
    await settle(400);
    return tabInfo(await waitLoaded(tabId, 10000));
  },

  async page_type(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (typeof p.text !== 'string') throw new Error('text is required');
    await ensureAttached(tabId);
    const backendNodeId = refToNode(p.ref);
    await clickAt(tabId, await centerOf(tabId, backendNodeId));
    if (!p.append) {
      // 先全选，输入的内容就会替换掉原有内容。
      const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
      await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration:
          'function(){ this.focus && this.focus(); if (typeof this.select === "function") this.select(); else document.execCommand("selectAll"); }',
      });
    }
    if (p.text) await cdp(tabId, 'Input.insertText', { text: p.text });
    else if (!p.append) await pressKey(tabId, 'Delete');
    if (p.submit) {
      await pressKey(tabId, 'Enter');
      await settle(400);
    }
    return tabInfo(await waitLoaded(tabId, p.submit ? 10000 : 0));
  },

  async page_key(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    await pressKey(tabId, p.key);
    await settle(200);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async page_screenshot(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    let shot;
    try {
      shot = await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 }, 8000);
    } catch (e) {
      throw new Error(`${e.message}. Chrome does not paint background tabs; call tab_activate on tab ${tabId} and try again.`);
    }
    const t = await chrome.tabs.get(tabId);
    return { __image: { data: shot.data, mimeType: 'image/jpeg' }, __text: `url: ${t.url}\ntitle: ${t.title}` };
  },
};
