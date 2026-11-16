# TabDeck

让本地 AI agent 通过 MCP 管理 Chrome 的标签页和标签页组。每个 session（一个 MCP server 进程）有一个按任务命名的标签页组。

当前是第一阶段：只管标签页和组，还不能操作页面内容（点击、输入、截图在后面的阶段）。

## 结构

```
MCP 客户端 ──stdio──> src/mcp-server.js ──命名管道──> src/host.js ──native messaging──> extension/background.js
```

- `extension/`：MV3 扩展，权限 `tabs`、`tabGroups`、`nativeMessaging`、`storage`、`alarms`。
- `src/host.js`：native messaging host，由 Chrome 拉起，在 `\\.\pipe\tabdeck-<用户名>` 上接受多个 MCP server。
- `src/mcp-server.js`：MCP server，无 npm 依赖。
- `src/tools.js`：工具定义。

## 安装（Windows）

1. `node scripts/setup.mjs`：给扩展写入固定 key（ID 不随目录变化）、生成 `native-host/`、注册 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tabdeck.host`。
   - 如果是在打包应用里的 shell 跑（比如 Claude 桌面版的 session），要加 `--via-wmi`：这类 shell 写 `HKCU` 会被重定向到应用私有的注册表视图，Chrome 看不到，扩展会报 `Specified native messaging host not found`。
2. Chrome 打开 `chrome://extensions`，开“开发者模式”，“加载已解压的扩展程序”，选 `extension/` 目录。
3. 在 MCP 客户端里加一个 stdio server：`node <本目录>\src\mcp-server.js`。

卸载：`node scripts/setup.mjs --uninstall`（删注册表项），再到 `chrome://extensions` 移除扩展。

## 工具

| 工具 | 作用 |
|---|---|
| `session_start` | 给本 session 的组起名（按任务命名） |
| `tabs_list` | 列出本 session 的标签页；`scope=all` 列出全部标签页和组 |
| `tab_open` | 在本 session 的组里开新标签页 |
| `tabs_adopt` | 把已有标签页收进本 session 的组 |
| `tabs_close` | 关标签页，默认只能关本 session 的 |
| `tab_activate` | 切到某个标签页 |
| `tabs_group` / `tabs_ungroup` | 通用整理：进组、出组 |
| `group_set` | 改组名、颜色、折叠状态 |
| `session_end` | 结束：关掉全部 / 只解散组 / 原样保留 |

## 页面操作（第二阶段）

只能用在本 session 的标签页上（别的标签页先 `tabs_adopt`）。经 `chrome.debugger` 实现，用的时候 Chrome 顶部会出现"TabDeck 已开始调试此浏览器"的提示条，`session_end` 或 MCP server 退出后松开。

| 工具 | 作用 |
| --- | --- |
| `page_navigate` | 在 session 的标签页里打开网址，等加载完 |
| `page_snapshot` | 把页面读成紧凑的无障碍树文本；可操作的元素带 `[ref=e42]` |
| `page_click` | 按 ref 点击（`double` 双击），返回点击后的标签页状态 |
| `page_type` | 按 ref 输入文字，默认替换原内容（`append` 追加，`submit` 回车） |
| `page_key` | 按一个键（Enter、Tab、Escape、方向键等） |
| `page_screenshot` | 截当前可见区域（JPEG） |

- 后台标签页也能点击和输入，不用切到前台（attach 时开了焦点模拟；不开的话后台标签页和被挡住的窗口收不到鼠标事件）。
- 截图只能截前台标签页，超时就先 `tab_activate`。
- 还不支持：iframe 里的内容、文件上传、下拉框选择、悬停、执行脚本、console 和网络（第三阶段）。

## 行为约定

- session 的标签页 = 组里的标签页。用户把标签页拖进组就等于交给 session，拖出去就收回。
- session 的标签页打开的新标签页会自动收进同一个组；弹窗窗口里的标签页进不了组，只记在 session 名下。
- MCP server 进程退出时，只有当 session 的标签页全是空白页才自动关掉，其余原样保留。
- 关标签页如果会把窗口关空，会先补一个空白页。
- 组的外观以"简洁、一眼能区分"为准：标题就是任务名，不加任何前缀（没起名时叫 `Agent`），和别的组重名时自动加序号；没指定颜色时挑浏览器里用得最少的颜色，不用灰色。

## 测试

- `node test/plumbing.test.mjs`：不需要 Chrome，脚本扮演扩展，验证 MCP server 和 host 之间的通信链路。
- `node test/live.test.mjs`：需要 Chrome 开着且扩展已加载。会临时开两个标签页，把工具调一遍，测完自己关掉。
- `node test/live2.test.mjs`：同样需要 Chrome。测 `tab_activate`、`session_end` 的 ungroup / keep、两个 session 互不干扰、MCP server 退出后的清理（只有空白页才自动关）。
- `node test/live3.test.mjs`：页面操作。自己起一个本地网页当靶子，测快照、输入、按键、点击、表单提交、导航、截图、失效 ref 的报错，以及点链接开出的新标签页自动进组。
- 与 Playwright 扩展的组共存已实测（它的组在场时两个测试都通过，组没被动）。

## 开发

改了 `extension/` 下的代码要重载扩展才生效：`node scripts/reload.mjs`。它走 TabDeck 自己的通道（管道 → host → 扩展）让扩展重载自己，不碰调试端口，Chrome 不弹窗；脚本会等新一轮 service worker 连回来再退出。`--info` 只看当前 service worker 的 boot 标记。重载会清空 session 状态（`chrome.storage.session`），进行中的 session 会丢掉与标签页组的对应关系。`dev.reload` / `dev.info` 不是 MCP 工具，agent 调不到。

`node scripts/sw-eval.mjs "<代码>"` 经 Chrome 的远程调试端口进到扩展的 service worker 里执行代码，`--reload` 重新加载扩展。每次连接 Chrome 都会弹窗要点 Allow。

## 排查

- host 日志：`native-host/host.log`。
- 扩展日志：`chrome://extensions` 里点 TabDeck 的“Service Worker”。
- 工具报 `Cannot reach the TabDeck extension`：Chrome 没开、扩展没加载，或者没跑过 setup。扩展每 30 秒会重试连接 host。
