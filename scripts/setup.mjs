// 一次性安装：
//   1. 给扩展 manifest 写入固定的 key（这样未打包扩展的 ID 不随目录变化）；
//   2. 生成 native-host/ 下的启动脚本和 host 清单；
//   3. 把清单路径注册到 HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tabdeck.host。
// 卸载：node scripts/setup.mjs --uninstall（只删注册表项）。
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'com.tabdeck.host';
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`;

if (process.platform !== 'win32') {
  console.error('目前只支持 Windows。');
  process.exit(1);
}

// --via-wmi：让 WMI 服务代为执行 reg 命令。
// 从打包应用（比如 Claude 桌面版）里的 shell 直接写 HKCU 会被重定向到应用私有的注册表视图，
// Chrome 看不到，表现为扩展报 "Specified native messaging host not found"。经 WMI 起的进程不在容器里。
const viaWmi = process.argv.includes('--via-wmi');
function reg(args) {
  if (!viaWmi) {
    execFileSync('reg', args, { stdio: 'ignore' });
    return;
  }
  const cmdLine = 'reg ' + args.map((a) => (/[\s]/.test(a) ? `"${a}"` : a)).join(' ');
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' }; if ($r.ReturnValue -ne 0) { exit 1 }; Wait-Process -Id $r.ProcessId -Timeout 10 -ErrorAction SilentlyContinue`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

if (process.argv.includes('--uninstall')) {
  try {
    reg(['delete', REG_KEY, '/f']);
    console.log('已删除注册表项', REG_KEY);
  } catch {
    console.log('注册表项不存在，无需删除');
  }
  process.exit(0);
}

// 1. 扩展 key 和 ID
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.key) {
  // 只需要公钥来固定 ID；私钥用不上（不打包 crx），直接丢弃。
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  manifest.key = publicKey.toString('base64');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

// 2. host 启动脚本和清单
const hostDir = path.join(root, 'native-host');
fs.mkdirSync(hostDir, { recursive: true });
const batPath = path.join(hostDir, 'host.bat');
fs.writeFileSync(batPath, `@echo off\r\n"${process.execPath}" "${path.join(root, 'src', 'host.js')}"\r\n`);
const hostManifestPath = path.join(hostDir, `${HOST}.json`);
fs.writeFileSync(
  hostManifestPath,
  JSON.stringify(
    {
      name: HOST,
      description: 'TabDeck native messaging host',
      path: batPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2
  ) + '\n'
);

// 3. 注册
reg(['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', hostManifestPath, '/f']);

console.log('扩展 ID      :', extensionId);
console.log('扩展目录     :', path.join(root, 'extension'));
console.log('host 清单    :', hostManifestPath);
console.log('注册表项     :', REG_KEY);
console.log('MCP server   :', `node ${path.join(root, 'src', 'mcp-server.js')}`);
