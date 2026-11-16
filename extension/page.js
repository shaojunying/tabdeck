// 页面操作（第二阶段）：经 chrome.debugger（CDP）读页面结构、点击、输入、截图。
// 由 background.js 用 importScripts 载入，共用它的 sessionTabs / tabInfo。
// 只允许操作本 session 的标签页；别的标签页要先 tabs_adopt。

const attached = new Set(); // 已 attach 调试器的 tabId
let windowOpens = []; // 最近的 Page.windowOpen 事件：{ tabId, url, at }
// 没拿到 debugger 权限时别让整个 service worker 起不来，留到调用时再报错。
if (chrome.debugger) {
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId != null) attached.delete(src.tabId);
  });
  // 页面要开新窗口 / 新标签页时（window.open、target=_blank 的链接、表单提交）由发起的那个页面上报。
  chrome.debugger.onEvent.addListener((src, method, params) => {
    if (method === 'Page.windowOpen' && src.tabId != null) windowOpens.push({ tabId: src.tabId, url: (params && params.url) || '', at: Date.now() });
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
  // 打开 Page 域才收得到 Page.windowOpen，用来认出"这个标签页开出了新标签页"。
  await cdp(tabId, 'Page.enable').catch(() => {});
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
const SHOT_MAX_WIDTH = 1280;
const NEW_TAB_WAIT_MS = 500;
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
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
  // 找一个真的会落在目标元素上的点：逐个试它的每块区域；都被挡住就把它滚到视口中间再试一轮。
  let blocker = '';
  for (let round = 0; round < 2; round++) {
    const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId });
    if (!quads || !quads.length) throw new Error('Element is not visible, so it cannot be clicked.');
    for (const q of quads.slice(0, 8)) {
      const pt = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
      const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        arguments: [{ value: pt.x }, { value: pt.y }],
        returnByValue: true,
        functionDeclaration: HIT_TEST,
      });
      if (result.value === 'ok') return pt;
      blocker = result.value;
    }
    if (round === 0) {
      await cdp(tabId, 'Runtime.callFunctionOn', {
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
    await action();
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
  if (front && front.id !== tabId && opened.length) {
    const [now] = await chrome.tabs.query({ windowId: self.windowId, active: true });
    if (now && opened.includes(now.id)) await chrome.tabs.update(front.id, { active: true }).catch(() => {});
  }
  const result = tabInfo(await waitLoaded(tabId, loadMs));
  if (opened.length) {
    result.opened = [];
    for (const id of opened) result.opened.push(tabInfo(await chrome.tabs.get(id)));
  }
  return result;
}

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
    const pt = await centerOf(tabId, refToNode(p.ref));
    return actAndCollect(sess, sid, tabId, () => clickAt(tabId, pt, p.double ? 2 : 1), 10000);
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
    if (p.submit) return actAndCollect(sess, sid, tabId, () => pressKey(tabId, 'Enter'), 10000);
    return tabInfo(await chrome.tabs.get(tabId));
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
    let shot;
    let note = '';
    try {
      // 后台标签页只有刚好在出新画面时才截得到（比如刚加载完）；闲着的后台标签页会一直等不到。
      shot = await cdp(tabId, 'Page.captureScreenshot', params, 2500);
    } catch {
      // 退一步：在它的窗口里短暂切到这个标签页，截完马上切回用户原来看的那个。不动窗口焦点。
      const self = await chrome.tabs.get(tabId);
      const [front] = await chrome.tabs.query({ windowId: self.windowId, active: true });
      await chrome.tabs.update(tabId, { active: true });
      try {
        shot = await cdp(tabId, 'Page.captureScreenshot', params, 8000);
      } catch (e) {
        throw new Error(
          `${e.message}. The tab was switched to but Chrome still did not paint it; its window is probably minimized or fully covered. Call tab_activate with tabId=${tabId} and focusWindow=true, then try again (this brings Chrome to the front).`
        );
      } finally {
        if (front && front.id !== tabId) await chrome.tabs.update(front.id, { active: true }).catch(() => {});
      }
      if (front && front.id !== tabId) note = '\nnote: the tab was in the background, so it was switched to for a moment and then switched back.';
    }
    const t = await chrome.tabs.get(tabId);
    return { __image: { data: shot.data, mimeType: 'image/jpeg' }, __text: `url: ${t.url}\ntitle: ${t.title}${note}` };
  },
};

// ---------- 更多页面操作：下拉框、悬停、滚动、前进后退、等待、执行脚本 ----------
async function resolveRef(tabId, ref) {
  try {
    return (await cdp(tabId, 'DOM.resolveNode', { backendNodeId: refToNode(ref) })).object.objectId;
  } catch (e) {
    if (/Invalid ref/.test(e.message)) throw e;
    throw new Error(`Element not found (${e.message}). The page may have changed; take a new page_snapshot.`);
  }
}

Object.assign(pageHandlers, {
  async page_hover(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    const { x, y } = await centerOf(tabId, refToNode(p.ref));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await settle(300);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async page_select(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!Array.isArray(p.values) || !p.values.length) throw new Error('values must be a non-empty array of option labels or values');
    await ensureAttached(tabId);
    const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: await resolveRef(tabId, p.ref),
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
    });
    if (result.value && result.value.error) throw new Error(result.value.error);
    return result.value;
  },

  async page_scroll(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    await ensureAttached(tabId);
    if (p.ref) {
      await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: await resolveRef(tabId, p.ref),
        functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }',
      });
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
    return tabInfo(await waitLoaded(tabId, 15000));
  },

  async page_wait(sess, sid, p) {
    const tabId = await ownedTab(sess, p);
    if (!p.text && !p.textGone) throw new Error('Pass text (wait until it appears) or textGone (wait until it disappears).');
    await ensureAttached(tabId);
    const ms = Math.min(Math.max(Number(p.timeoutMs) || 10000, 500), 15000);
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
});
