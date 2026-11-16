'use strict';
// MCP 工具定义。工具名同时是发给扩展的方法名，实现在 extension/background.js 的 handlers 里。

const tabIds = {
  type: 'array',
  items: { type: 'integer' },
  minItems: 1,
  description: 'Chrome tab ids, as returned by tabs_list / tab_open.',
};
const color = {
  type: 'string',
  enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
};

const tabId = { type: 'integer', description: "A tab that belongs to this session (see tabs_list)." };
const ref = { type: 'string', description: 'Element ref from page_snapshot, e.g. "e42".' };

module.exports = [
  {
    name: 'session_start',
    description:
      "Name this session's tab group after the task you are doing (e.g. \"查发票\"). Call it once at the start of a browser task; calling it again renames the group. The group itself appears when the first tab is opened or adopted.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'The tab group title. Keep it short and specific so the user can tell groups apart at a glance: 2-6 Chinese characters or 1-3 words naming the task ("查发票", "PR 45029", "顺义成交"). No prefix, no tool or model name, no generic words like "任务" or "browser". If another group already has this title a number is appended.',
        },
        color: { ...color, description: 'Usually omit: an unused color is picked automatically so groups do not look alike.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tabs_list',
    description:
      "List tabs and tab groups. scope=\"session\" (default) returns only this session's tabs; scope=\"all\" returns every tab and group in the browser, each marked with whether it belongs to this session.",
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['session', 'all'] } } },
  },
  {
    name: 'tab_open',
    description:
      "Open a new tab inside this session's tab group (the group is created on first use). The tab opens in the background unless active=true.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open. Omit for a blank tab.' }, active: { type: 'boolean' } },
    },
  },
  {
    name: 'tabs_adopt',
    description:
      "Move existing tabs (for example tabs the user already has open, or a tab that escaped the group) into this session's tab group, so the session owns them.",
    inputSchema: { type: 'object', properties: { tabIds }, required: ['tabIds'] },
  },
  {
    name: 'tabs_close',
    description:
      "Close tabs. Only this session's tabs can be closed unless force=true. If the tabs are the last ones in a window, a blank tab is left behind so the window stays open.",
    inputSchema: {
      type: 'object',
      properties: { tabIds, force: { type: 'boolean', description: 'Also allow closing tabs that do not belong to this session.' } },
      required: ['tabIds'],
    },
  },
  {
    name: 'tab_activate',
    description: 'Switch to a tab within its window. Set focusWindow=true to also bring that window to the front.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'integer' }, focusWindow: { type: 'boolean' } },
      required: ['tabId'],
    },
  },
  {
    name: 'tabs_group',
    description:
      'Organise tabs: put tabs into an existing group (groupId) or into a new group (title / color). This does not make them part of the session; use tabs_adopt for that.',
    inputSchema: {
      type: 'object',
      properties: { tabIds, groupId: { type: 'integer' }, title: { type: 'string' }, color },
      required: ['tabIds'],
    },
  },
  {
    name: 'tabs_ungroup',
    description: 'Remove tabs from whatever group they are in. Tabs that belonged to this session are released from it.',
    inputSchema: { type: 'object', properties: { tabIds }, required: ['tabIds'] },
  },
  {
    name: 'group_set',
    description:
      "Rename, recolor, collapse or expand a tab group. Without groupId it applies to this session's group.",
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'integer' }, title: { type: 'string' }, color, collapsed: { type: 'boolean' } },
    },
  },
  {
    name: 'session_end',
    description:
      'Finish the browser task. mode="close" (default) closes every tab of this session; "ungroup" keeps the tabs but dissolves the group; "keep" leaves the group as it is.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['close', 'ungroup', 'keep'] } } },
  },

  // ---- 页面操作：只能用在本 session 的标签页上 ----
  {
    name: 'page_navigate',
    description: "Load a URL in one of this session's tabs and wait for it to finish loading.",
    inputSchema: { type: 'object', properties: { tabId, url: { type: 'string' } }, required: ['tabId', 'url'] },
  },
  {
    name: 'page_snapshot',
    description:
      "Read a page as a compact accessibility tree: one line per element with its role and name. Elements you can act on carry a ref like [ref=e42]; pass that ref to page_click / page_type. Refs stay valid until the page navigates or re-renders the element; take a new snapshot after the page changes. Only the main frame is covered (no iframes). Works on this session's tabs only.",
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'page_click',
    description: 'Click an element by its ref from page_snapshot. Returns the tab afterwards, so you can see whether the click navigated.',
    inputSchema: {
      type: 'object',
      properties: { tabId, ref, double: { type: 'boolean', description: 'Double-click instead.' } },
      required: ['tabId', 'ref'],
    },
  },
  {
    name: 'page_type',
    description:
      'Type text into an input, textarea or editable element by its ref. Replaces the existing content unless append=true. Set submit=true to press Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: { tabId, ref, text: { type: 'string' }, append: { type: 'boolean' }, submit: { type: 'boolean' } },
      required: ['tabId', 'ref', 'text'],
    },
  },
  {
    name: 'page_key',
    description:
      'Press a single key in the tab (goes to whatever element has focus): Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown.',
    inputSchema: { type: 'object', properties: { tabId, key: { type: 'string' } }, required: ['tabId', 'key'] },
  },
  {
    name: 'page_screenshot',
    description:
      'Take a screenshot of the visible part of the page. Prefer page_snapshot for reading and acting; use this when layout or visuals matter. Chrome only paints the foreground tab of a window, so call tab_activate first if it times out.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
];
