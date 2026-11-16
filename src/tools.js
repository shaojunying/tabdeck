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
const ref = { type: 'string', description: 'Element ref from page_snapshot, e.g. "e42" (or "f1e42" for an element inside a cross-site iframe).' };

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

  // ---- 联网搜索：自己开后台标签页、搜完就关 ----
  {
    name: 'web_search',
    description:
      "Search the web in the user's own Chrome and get the results as a list of title, URL and snippet. Needs no API key: it opens a background tab on the search engine, reads the result page and closes the tab. Google is tried first and Bing is used if Google shows a captcha or returns nothing. One call returns one result page (up to 10 results); pass page=2 for the next one. To read a result, open its URL with tab_open and page_snapshot. Leave a second or two between searches: many in quick succession can trigger a captcha.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Search operators such as site:github.com or "exact phrase" work.' },
        count: { type: 'integer', description: 'How many results to return (1-10, default 10).' },
        page: { type: 'integer', description: 'Result page, starting at 1 (default 1).' },
        engine: { type: 'string', enum: ['auto', 'google', 'bing'], description: 'Default "auto": Google, then Bing if Google fails.' },
      },
      required: ['query'],
    },
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
      "Read a page as a compact accessibility tree: one line per element with its role and name. Elements you can act on carry a ref like [ref=e42]; pass that ref to page_click / page_type. Refs stay valid until the page navigates or re-renders the element; take a new snapshot after the page changes. Iframes are included; elements inside a cross-site iframe have refs like f1e6. Page regions (main, navigation, form, table, dialog) and named images have refs too. A large page is cut at about 40,000 characters: pass ref to read only that element and what is inside it, or interactive=true to list only the elements you can act on. Works on this session's tabs only.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        ref: { type: 'string', description: 'Read only this element and what is inside it, for example the ref of main, a form or a table.' },
        interactive: { type: 'boolean', description: 'List only elements that have a ref, plus headings. Much shorter on large pages.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'page_click',
    description:
      'Click an element by its ref from page_snapshot. Returns the tab afterwards (compare its url to see whether it navigated). If the click opened new tabs, they are listed under "opened"; they already belong to this session and the tab the user was looking at stays in front, so use their ids directly.',
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
      'Take a screenshot of the visible part of the page. Prefer page_snapshot for reading and acting; use this when layout or visuals matter. The image is scaled down to at most 1280px wide. No need to activate the tab first: a background tab is switched to for about a second and then switched back automatically (Chrome only paints the front tab of a window).',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'page_select',
    description:
      'Choose options in a native <select> dropdown by its ref. values are option labels or values. For custom (non-<select>) dropdowns, use page_click on the dropdown and then on the option.',
    inputSchema: {
      type: 'object',
      properties: { tabId, ref, values: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tabId', 'ref', 'values'],
    },
  },
  {
    name: 'page_hover',
    description: 'Move the mouse over an element by its ref (links, buttons, inputs and named images have one), to reveal hover menus or tooltips. Take a page_snapshot afterwards to see what appeared.',
    inputSchema: { type: 'object', properties: { tabId, ref }, required: ['tabId', 'ref'] },
  },
  {
    name: 'page_scroll',
    description:
      'Scroll the page: direction "down" / "up" (most of a screen), "top" or "bottom"; or pass ref to bring that element into view. Returns the scroll position and page height. page_snapshot already covers the whole page, so scroll mainly before a screenshot or to trigger lazy loading.',
    inputSchema: {
      type: 'object',
      properties: { tabId, direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] }, ref },
      required: ['tabId'],
    },
  },
  {
    name: 'page_history',
    description: 'Go back or forward in the tab history, or reload the page, and wait for it to load.',
    inputSchema: {
      type: 'object',
      properties: { tabId, direction: { type: 'string', enum: ['back', 'forward', 'reload'] } },
      required: ['tabId', 'direction'],
    },
  },
  {
    name: 'page_wait',
    description:
      'Wait until some text appears on the page (text) or disappears from it (textGone), for example after an action that loads content asynchronously. Fails after timeoutMs (default 10000, max 15000).',
    inputSchema: {
      type: 'object',
      properties: { tabId, text: { type: 'string' }, textGone: { type: 'string' }, timeoutMs: { type: 'integer' } },
      required: ['tabId'],
    },
  },
  {
    name: 'page_eval',
    description:
      'Run a JavaScript expression in the page and return its JSON-serializable value (promises are awaited). An escape hatch for things the other tools cannot do, such as reading a specific value or calling a page API; prefer page_snapshot / page_click / page_type for ordinary reading and acting.',
    inputSchema: { type: 'object', properties: { tabId, expression: { type: 'string' } }, required: ['tabId', 'expression'] },
  },
  {
    name: 'page_fill',
    description:
      'Fill several form fields in one call. Each field is { ref, value }: text for inputs and textareas, the option label or value for a native <select>, true / false for checkboxes and radio buttons. Stops at the first field that fails and says which one.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        fields: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', properties: { ref, value: { type: ['string', 'boolean', 'number'] } }, required: ['ref', 'value'] },
        },
      },
      required: ['tabId', 'fields'],
    },
  },
  {
    name: 'page_console',
    description:
      "Read the page's console output and uncaught errors, oldest first, including messages logged before this call. level \"error\" shows only errors, \"warning\" shows warnings and errors; default is everything. Use it when a page misbehaves and you need to see why.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        level: { type: 'string', enum: ['all', 'warning', 'error'] },
        limit: { type: 'integer', description: 'Show at most this many of the latest messages (default 100).' },
        clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'page_network',
    description:
      'List the network requests this tab has made (method, status, type, URL), or pass requestId (like "r12", from the list) for one request\'s headers, request body and response body. Only requests made after TabDeck first acted on the tab are recorded; reload with page_history to capture a full page load. A redirect is listed as its own request (status 301 / 302 and where it led) followed by the request it led to. Cookie and authorization headers are redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        requestId: { type: 'string' },
        filter: { type: 'string', description: 'Only requests whose URL contains this text.' },
        failed: { type: 'boolean', description: 'Only failed requests and HTTP status 400 or higher.' },
        limit: { type: 'integer', description: 'Show at most this many of the latest requests (default 50).' },
        clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'page_dialog',
    description:
      'Accept or dismiss the JavaScript dialog (alert, confirm, prompt, beforeunload) that is open on a tab. Other page tools report it in their result as "dialog" and fail until it is handled. accept defaults to true; promptText fills a prompt before accepting.',
    inputSchema: {
      type: 'object',
      properties: { tabId, accept: { type: 'boolean' }, promptText: { type: 'string' } },
      required: ['tabId'],
    },
  },
  {
    name: 'page_upload',
    description:
      'Choose local files in a file input, as if the user had picked them in the file dialog. paths are absolute paths on this machine. Pass the ref of the file input, or omit ref to use the only file input on the page (they are often hidden behind an "Upload" button and missing from the snapshot). Only upload files the user asked you to upload.',
    inputSchema: {
      type: 'object',
      properties: { tabId, ref, paths: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tabId', 'paths'],
    },
  },
];
