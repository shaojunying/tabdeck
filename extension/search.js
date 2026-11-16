// web_search：在用户自己的 Chrome 里开一个后台标签页搜索，把结果页解析成"标题 / 链接 / 摘要"，然后关掉标签页。
// 不需要任何 API key，结果和用户自己搜到的一样。默认先用 Google，被验证码 / 同意页拦住或解析不出结果时换 Bing。
// 由 background.js 在 page.js 之后 importScripts；用到那两个文件里的 handlers、cdp、ensureAttached、waitLoaded 等。

// 整个调用要在 MCP server 的 20 秒超时之内结束，所以每个引擎只给这么多时间。
const SEARCH_LOAD_MS = 7000;
const SEARCH_RETRY_MS = 1500;
const SEARCH_PAGE_SIZE = 10;

// 下面两段在结果页里执行，返回 { blocked, results: [{ title, url, snippet }] }。
// 选择器尽量只依赖结构（结果标题是链接里的 h3 / h2），少依赖会变的 class 名。
const EXTRACT_GOOGLE = `(() => {
  const txt = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
  if (/\\/sorry\\//.test(location.pathname) || document.querySelector('#captcha-form, form[action*="sorry"]')) return { blocked: 'captcha', results: [] };
  if (location.hostname.startsWith('consent.')) return { blocked: 'consent page', results: [] };
  const results = [];
  const seen = new Set();
  for (const h of document.querySelectorAll('#search a h3, #rso a h3')) {
    const a = h.closest('a');
    if (!a || !/^https?:/.test(a.href) || seen.has(a.href)) continue;
    let host = '';
    try { host = new URL(a.href).hostname; } catch (e) {}
    if (/(^|\\.)google\\.[a-z.]+$/.test(host)) continue;
    seen.add(a.href);
    // 从标题往上找到这条结果自己的容器（不能包含别的结果），摘要就在里面。
    let box = a;
    let sn = null;
    for (let i = 0; i < 8 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelectorAll('a h3').length > 1) break;
      sn = box.querySelector('.VwiC3b, [data-sncf], [style*="-webkit-line-clamp"]');
      if (sn) break;
    }
    results.push({ title: txt(h), url: a.href, snippet: txt(sn) });
  }
  return { blocked: null, results };
})()`;

const EXTRACT_BING = `(() => {
  const txt = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
  if (document.querySelector('#b_captcha, .captcha, iframe[src*="challenge"]') && !document.querySelector('#b_results > li.b_algo')) return { blocked: 'captcha', results: [] };
  const results = [];
  const seen = new Set();
  for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
    const a = li.querySelector('h2 a');
    if (!a) continue;
    let url = a.href;
    // Bing 的链接是 /ck/a?...&u=a1<base64url 的真实地址> 这种跳转链接，还原成真实地址。
    try {
      const u = new URL(url);
      if (u.pathname.startsWith('/ck/a')) {
        const raw = u.searchParams.get('u');
        if (raw && raw.startsWith('a1')) url = decodeURIComponent(escape(atob(raw.slice(2).replace(/-/g, '+').replace(/_/g, '/'))));
      }
    } catch (e) {}
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: txt(a), url, snippet: txt(li.querySelector('.b_caption p, p[class*="b_lineclamp"], .b_algoSlug')) });
  }
  return { blocked: null, results };
})()`;

const SEARCH_ENGINES = {
  google: {
    url: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}${page > 1 ? `&start=${(page - 1) * SEARCH_PAGE_SIZE}` : ''}`,
    extract: EXTRACT_GOOGLE,
  },
  bing: {
    url: (q, page) => `https://www.bing.com/search?q=${encodeURIComponent(q)}${page > 1 ? `&first=${(page - 1) * SEARCH_PAGE_SIZE + 1}` : ''}`,
    extract: EXTRACT_BING,
  },
};

// 在 tabId 里用一个引擎搜一次。返回 { results } 或 { failed: 原因 }，不抛错，好让调用方换下一个引擎。
async function searchOnce(tabId, engine, query, page) {
  const e = SEARCH_ENGINES[engine];
  try {
    await chrome.tabs.update(tabId, { url: e.url(query, page) });
    await settle(200);
    await waitLoaded(tabId, SEARCH_LOAD_MS);
    await ensureAttached(tabId);
    // 结果有时比 load 事件晚一点才渲染出来：没解析到就再试几次。
    const deadline = Date.now() + SEARCH_RETRY_MS;
    for (;;) {
      const r = await cdp(tabId, 'Runtime.evaluate', { expression: e.extract, returnByValue: true }, 5000);
      if (r.exceptionDetails) return { failed: 'the result page could not be parsed' };
      const v = r.result.value || { results: [] };
      if (v.blocked) return { failed: `blocked by a ${v.blocked}` };
      if (v.results.length) return { results: v.results };
      if (Date.now() > deadline) return { failed: 'no results found on the page' };
      await settle(300);
    }
  } catch (err) {
    return { failed: (err && err.message) || String(err) };
  }
}

const searchHandlers = {
  async web_search(sess, sid, p) {
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    if (!query) throw new Error('query is required');
    const engine = p.engine || 'auto';
    if (engine !== 'auto' && !SEARCH_ENGINES[engine]) throw new Error('engine must be one of: auto, google, bing');
    const count = clamp(p.count, SEARCH_PAGE_SIZE, 1, SEARCH_PAGE_SIZE);
    const page = clamp(p.page, 1, 1, 10);
    const order = engine === 'auto' ? ['google', 'bing'] : [engine];

    // 搜索用的标签页开在本 session 的组里（后台），搜完就关，不留痕迹。
    const tab = await handlers.tab_open(sess, sid, {});
    const notes = [];
    let used = null;
    let results = [];
    try {
      for (const name of order) {
        const r = await searchOnce(tab.id, name, query, page);
        if (r.results) {
          used = name;
          results = r.results.slice(0, count);
          break;
        }
        notes.push(`${name}: ${r.failed}`);
      }
    } finally {
      await detachTabs([tab.id]);
      await closeTabs([tab.id]).catch(() => {});
    }
    if (!used) throw new Error(`Search failed (${notes.join('; ')}). Open the search page with tab_open to see what is wrong, for example a captcha to solve.`);

    const lines = [`query: ${query}`, `engine: ${used}${page > 1 ? `, page ${page}` : ''} (${results.length} results)`];
    if (notes.length) lines.push(`note: fell back to ${used} (${notes.join('; ')})`);
    results.forEach((r, i) => {
      lines.push('', `${i + 1}. ${clip(r.title, 200)}`, `   ${r.url}`);
      if (r.snippet) lines.push(`   ${clip(r.snippet, 400)}`);
    });
    return { __text: lines.join('\n') };
  },
};
