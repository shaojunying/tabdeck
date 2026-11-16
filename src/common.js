'use strict';
// 扩展、native host、MCP server 三方共用的常量。

const HOST_NAME = 'com.tabdeck.host';
const VERSION = '0.4.0';

// native host 监听、MCP server 连接的命名管道。测试时用 TABDECK_PIPE 换一个名字，避免撞上真的 host。
const PIPE =
  process.env.TABDECK_PIPE ||
  `\\\\.\\pipe\\tabdeck-${(process.env.USERNAME || 'user').replace(/[^\w.-]/g, '_')}`;

module.exports = { HOST_NAME, VERSION, PIPE };
