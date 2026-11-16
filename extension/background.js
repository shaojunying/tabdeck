// TabDeck service worker。
// 通过 native messaging 连本地 host，收到 { id, sessionId, method, params }，回 { id, result } 或 { id, error }。
// 一个 session（一个 MCP server 进程）对应一个标签页组；session 的标签页 = 组里的标签页 + 没法进组的弹窗标签页。

const HOST = 'com.tabdeck.host';
const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const BLANK = new Set(['', 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']);

// ---------- 与 native host 的连接 ----------
let port = null;

function connect() {
  if (port) return;
  const startedAt = Date.now();
  let p;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    console.warn('connectNative failed:', e);
    return;
  }
  port = p;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    console.warn('native host disconnected:', chrome.runtime.lastError && chrome.runtime.lastError.message);
    if (port === p) port = null;
    // 连上过一阵子才断的，马上重连；一连就断（比如 host 没注册）交给下面的 alarm 慢慢重试。
    if (Date.now() - startedAt > 2000) setTimeout(connect, 1000);
  });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('tabdeck-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
connect();

// 所有会读写 session 状态的操作排队执行，避免并发请求和事件互相覆盖。
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

function onHostMessage(msg) {
  locked(() => dispatch(msg)).then(
    (result) => port && port.postMessage({ id: msg.id, result: result === undefined ? null : result }),
    (e) => port && port.postMessage({ id: msg.id, error: (e && e.message) || String(e) })
  );
}

// ---------- session 状态 ----------
async function loadSessions() {
  return (await chrome.storage.session.get('sessions')).sessions || {};
}
function saveSessions(sessions) {
  return chrome.storage.session.set({ sessions });
}

function defaultColor(sid) {
  let h = 0;
  for (const c of sid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
const groupTitle = (sess) => sess.name || 'Agent';

async function liveGroup(sess) {
  if (sess.groupId == null) return null;
  try {
    return await chrome.tabGroups.get(sess.groupId);
  } catch {
    sess.groupId = null; // 组被用户解散或者标签页全关了
    return null;
  }
}

async function sessionTabs(sess) {
  const tabs = (await liveGroup(sess)) ? await chrome.tabs.query({ groupId: sess.groupId }) : [];
  const extra = [];
  for (const id of sess.extra) {
    try {
      const t = await chrome.tabs.get(id);
      if (t.groupId === sess.groupId && sess.groupId != null) continue; // 已经在组里了
      tabs.push(t);
      extra.push(id);
    } catch {}
  }
  sess.extra = extra;
  return tabs;
}

async function putInSessionGroup(sess, sid, tabIds) {
  if (!tabIds.length) return;
  if (await liveGroup(sess)) {
    await chrome.tabs.group({ groupId: sess.groupId, tabIds });
  } else {
    const first = await chrome.tabs.get(tabIds[0]);
    sess.groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: first.windowId } });
    await chrome.tabGroups.update(sess.groupId, { title: groupTitle(sess), color: sess.color || defaultColor(sid) });
  }
  sess.extra = sess.extra.filter((id) => !tabIds.includes(id));
}

// 关标签页；如果会把某个窗口关空，先补一个空白页，免得窗口（甚至整个 Chrome）跟着关掉。
async function closeTabs(ids) {
  if (!ids.length) return;
  const closing = new Set(ids);
  const byWindow = new Map();
  for (const t of await chrome.tabs.query({})) {
    const w = byWindow.get(t.windowId) || { total: 0, closing: 0 };
    w.total++;
    if (closing.has(t.id)) w.closing++;
    byWindow.set(t.windowId, w);
  }
  for (const [windowId, w] of byWindow) {
    if (w.closing > 0 && w.closing === w.total) {
      const win = await chrome.windows.get(windowId);
      if (win.type === 'normal') await chrome.tabs.create({ windowId, active: true });
    }
  }
  await chrome.tabs.remove(ids);
}

const tabInfo = (t) => ({
  id: t.id,
  windowId: t.windowId,
  groupId: t.groupId === -1 ? null : t.groupId,
  index: t.index,
  active: t.active,
  title: t.title,
  url: t.url || t.pendingUrl || '',
  status: t.status,
});
const groupInfo = (g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed });

async function sessionInfo(sess) {
  const g = await liveGroup(sess);
  return { name: sess.name, group: g ? groupInfo(g) : null, tabs: (await sessionTabs(sess)).map(tabInfo) };
}

function requireTabIds(p) {
  if (!Array.isArray(p.tabIds) || !p.tabIds.length || !p.tabIds.every(Number.isInteger)) {
    throw new Error('tabIds must be a non-empty array of integers');
  }
  return p.tabIds;
}

// ---------- 工具实现 ----------
const handlers = {
  async session_start(sess, sid, p) {
    if (!p.name) throw new Error('name is required');
    sess.name = String(p.name);
    if (p.color) sess.color = p.color;
    if (await liveGroup(sess)) {
      await chrome.tabGroups.update(sess.groupId, { title: groupTitle(sess), ...(p.color ? { color: p.color } : {}) });
    }
    return sessionInfo(sess);
  },

  async tabs_list(sess, sid, p, sessions) {
    if (p.scope !== 'all') return sessionInfo(sess);
    const mine = new Set((await sessionTabs(sess)).map((t) => t.id));
    const owner = new Map();
    for (const [id, s] of Object.entries(sessions)) if (s.groupId != null) owner.set(s.groupId, id === sid ? 'this' : 'other');
    return {
      groups: (await chrome.tabGroups.query({})).map((g) => ({ ...groupInfo(g), session: owner.get(g.id) || null })),
      tabs: (await chrome.tabs.query({})).map((t) => ({ ...tabInfo(t), inSession: mine.has(t.id) })),
    };
  },

  async tab_open(sess, sid, p) {
    const g = await liveGroup(sess);
    let windowId = g && g.windowId;
    if (windowId == null) {
      try {
        windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
      } catch {}
    }
    let tab;
    if (windowId == null) {
      const win = await chrome.windows.create(p.url ? { url: p.url } : {});
      tab = win.tabs[0];
    } else {
      tab = await chrome.tabs.create({ windowId, active: !!p.active, ...(p.url ? { url: p.url } : {}) });
    }
    await putInSessionGroup(sess, sid, [tab.id]);
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  async tabs_adopt(sess, sid, p) {
    await putInSessionGroup(sess, sid, requireTabIds(p));
    return sessionInfo(sess);
  },

  async tabs_close(sess, sid, p) {
    const ids = requireTabIds(p);
    if (!p.force) {
      const mine = new Set((await sessionTabs(sess)).map((t) => t.id));
      const foreign = ids.filter((id) => !mine.has(id));
      if (foreign.length) {
        throw new Error(`Tabs ${foreign.join(', ')} do not belong to this session. Adopt them first or pass force=true.`);
      }
    }
    await closeTabs(ids);
    return { closed: ids };
  },

  async tab_activate(sess, sid, p) {
    if (!Number.isInteger(p.tabId)) throw new Error('tabId is required');
    const t = await chrome.tabs.update(p.tabId, { active: true });
    if (p.focusWindow) await chrome.windows.update(t.windowId, { focused: true });
    return tabInfo(t);
  },

  async tabs_group(sess, sid, p) {
    const ids = requireTabIds(p);
    let groupId = p.groupId;
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds: ids });
    } else {
      const first = await chrome.tabs.get(ids[0]);
      groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: first.windowId } });
    }
    const update = {};
    if (p.title !== undefined) update.title = p.title;
    if (p.color) update.color = p.color;
    const g = Object.keys(update).length ? await chrome.tabGroups.update(groupId, update) : await chrome.tabGroups.get(groupId);
    return groupInfo(g);
  },

  async tabs_ungroup(sess, sid, p) {
    const ids = requireTabIds(p);
    await chrome.tabs.ungroup(ids);
    sess.extra = sess.extra.filter((id) => !ids.includes(id));
    return { ungrouped: ids };
  },

  async group_set(sess, sid, p) {
    const groupId = p.groupId != null ? p.groupId : (await liveGroup(sess)) && sess.groupId;
    if (groupId == null) throw new Error('This session has no tab group yet; pass groupId or open a tab first.');
    const update = {};
    if (p.title !== undefined) update.title = p.title;
    if (p.color) update.color = p.color;
    if (p.collapsed !== undefined) update.collapsed = !!p.collapsed;
    const g = await chrome.tabGroups.update(groupId, update);
    if (groupId === sess.groupId) {
      if (p.title !== undefined) sess.name = p.title;
      if (p.color) sess.color = p.color;
    }
    return groupInfo(g);
  },

  async session_end(sess, sid, p, sessions) {
    const mode = p.mode || 'close';
    const ids = (await sessionTabs(sess)).map((t) => t.id);
    if (mode === 'close') await closeTabs(ids);
    else if (mode === 'ungroup' && (await liveGroup(sess))) await chrome.tabs.ungroup((await chrome.tabs.query({ groupId: sess.groupId })).map((t) => t.id));
    delete sessions[sid];
    return { mode, tabs: ids };
  },
};

async function dispatch({ sessionId: sid, method, params }) {
  const sessions = await loadSessions();
  try {
    if (method === 'session.disconnected') {
      // MCP server 进程没了：只在 session 的标签页全是空白页时才替它关掉，其余原样留给用户。
      const sess = sessions[sid];
      if (sess) {
        const tabs = await sessionTabs(sess);
        if (tabs.length && tabs.every((t) => BLANK.has(t.url || t.pendingUrl || ''))) await closeTabs(tabs.map((t) => t.id));
        delete sessions[sid];
      }
      return null;
    }
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    if (!sid) throw new Error('sessionId is required');
    const sess = (sessions[sid] ||= { name: null, color: null, groupId: null, extra: [] });
    return await handler(sess, sid, params || {}, sessions);
  } finally {
    await saveSessions(sessions);
  }
}

// ---------- 收编跑出去的新标签页 ----------
// session 的标签页打开的新标签页（链接、window.open）自动归到同一个 session：
// 普通窗口里的直接进组；弹窗窗口里的没法进组，只记到 session 名下。
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  locked(async () => {
    const sessions = await loadSessions();
    let opener;
    try {
      opener = await chrome.tabs.get(tab.openerTabId);
    } catch {
      return;
    }
    for (const [sid, sess] of Object.entries(sessions)) {
      const owns = (sess.groupId != null && opener.groupId === sess.groupId) || sess.extra.includes(opener.id);
      if (!owns) continue;
      const current = await chrome.tabs.get(tab.id);
      if (sess.groupId != null && current.groupId === sess.groupId) return;
      const win = await chrome.windows.get(current.windowId);
      if (win.type === 'normal') await putInSessionGroup(sess, sid, [tab.id]);
      else if (!sess.extra.includes(tab.id)) sess.extra.push(tab.id);
      await saveSessions(sessions);
      return;
    }
  }).catch((e) => console.warn('auto-adopt failed:', e));
});
