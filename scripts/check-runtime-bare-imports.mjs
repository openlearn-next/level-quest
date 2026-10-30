#!/usr/bin/env node
/**
 * 运行期裸说明符门禁（L0 补充）。
 *
 * 官方 SDK 构建把 `@openlearn/plugin-sdk` 标成 external：产物里会原样保留
 * `import ... from '@openlearn/plugin-sdk'`。第三方 process 插件跑在**子进程**中，
 * 这条裸说明符有两处硬伤：
 *
 *   1. 子进程用 Node 权限模型收敛文件访问（`--permission --allow-fs-read=...`），
 *      白名单只放行插件目录 / 插件 node_modules / SDK 目录本身；SDK 的
 *      `dist/index.js` 内部还有 `import { v7 as uuidv7 } from 'uuid'`，
 *      `uuid` 落在宿主 node_modules 下、不在白名单 → 子进程启动即
 *      `ERR_ACCESS_DENIED` → 插件激活失败，「启用」按钮返回 HTTP 500。
 *   2. 平台热重载（`PluginHost.reloadPlugin`）把产物交给 EsmLoader，用
 *      `data:text/javascript;base64,` 加载 —— data: URL 没有层级基址，
 *      裸说明符一律无法解析 → ERR_MODULE_NOT_FOUND，更新接口 500。
 *
 * 正解：运行期只 import type；需要 Token 常量时在插件内**同名同版本**本地重建
 * （见 src/sdk-tokens.ts，与官方插件 @openlearn-ext/whiteboard-sticky-notes 同法）。
 *
 * 这里在发布前静态拦截，避免再出现「装得上、启用就 500」。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] || '.';
const errors = [];
const warns = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** 去掉注释与字符串字面量，避免注释里的示例代码造成误报。 */
function mask(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

// ── 1. 源码：不得对 @openlearn/plugin-sdk 做值导入 ──────────────────────────
for (const f of walk(join(root, 'src'))) {
  const raw = readFileSync(f, 'utf8');
  const t = mask(raw);
  const re = /import\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s*['"]@openlearn\/plugin-sdk['"]/g;
  let m;
  while ((m = re.exec(t))) {
    errors.push(
      `${relative(root, f)} 对 '@openlearn/plugin-sdk' 做了值导入（${m[1].trim()}）：` +
        '运行期产物会残留裸说明符 → 子进程权限模型 ERR_ACCESS_DENIED / 热重载 data: URL 无法解析 → 启用即 500。' +
        '改用 `import type` + 本地重建 Token（见 src/sdk-tokens.ts）。',
    );
  }
}

// ── 2. 产物：dist/index.js 不得残留该裸说明符 ───────────────────────────────
const distEntry = join(root, 'dist', 'index.js');
if (existsSync(distEntry)) {
  const t = mask(readFileSync(distEntry, 'utf8'));
  if (/from\s*['"]@openlearn\/plugin-sdk['"]/.test(t)) {
    errors.push(
      `${relative(root, distEntry)} 残留 '@openlearn/plugin-sdk' 裸说明符：` +
        '子进程权限模型会拒绝 SDK 的传递依赖（uuid）→ 插件启用/更新返回 500。',
    );
  }
} else {
  warns.push('dist/index.js 不存在（未构建）：跳过产物层检查');
}

// ── 3. 产物：不得出现其它裸说明符 ───────────────────────────────────────────
if (existsSync(distEntry)) {
  const t = mask(readFileSync(distEntry, 'utf8'));
  const bare = new Set();
  const re = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g;
  let m;
  while ((m = re.exec(t))) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    if (spec.startsWith('@openlearn/')) continue; // 平台按条目放行，见 check-runtime-bare-imports 说明
    bare.add(spec);
  }
  if (bare.size > 0) {
    errors.push(
      `${relative(root, distEntry)} 含非白名单裸说明符：${[...bare].join(', ')}` +
        '（第三方插件只允许相对导入与 @openlearn/* Token 服务）。',
    );
  }
}

for (const w of warns) console.log(`  ⚠  ${w}`);
if (errors.length > 0) {
  console.error('\n【运行期裸说明符检查】失败：');
  for (const e of errors) console.error(`  ✖  ${e}`);
  process.exit(1);
}
console.log('\n【运行期裸说明符检查】通过：源码与产物均无 @openlearn/plugin-sdk 裸说明符');
