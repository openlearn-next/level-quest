/**
 * 平台保留路由检查（L0 补充）。
 *
 * 平台在 `/api/plugins/:id/*` 命名空间下预留了一批管理动作：
 *   - `plugin-api-gateway.ts` 的 RESERVED_ACTIONS 会让这些子路径直接 next()；
 *   - 对应核心路由（如 `GET /api/plugins/:id/config`）先于网关注册，
 *     且普遍带 `requireAuth(...)`。
 *
 * 插件若声明同名路由，请求会被平台核心路由截走，插件永远收不到：
 *   - 登录态失效时，插件页会直接显示平台原文 “Session expired or invalid”；
 *   - 登录正常时，拿到的也是平台的配置 schema，而不是插件自己的数据。
 *
 * 这里在发布前静态拦截，避免再出现同类问题。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || '.';
const manifestPath = join(root, 'manifest.json');

/** 与平台 plugin-api-gateway.ts / server/routes/plugins.ts 保持同步 */
const RESERVED = new Map([
  ['config', 'GET/POST /api/plugins/:id/config（插件配置读写，requireAuth）'],
  ['toggle', 'POST /api/plugins/:id/toggle（启用/停用）'],
  ['contributions', 'GET /api/plugins/:id/contributions（贡献点）'],
  ['check-update', 'POST /api/plugins/:id/check-update（检查更新）'],
  ['one-click-update', 'POST /api/plugins/:id/one-click-update（一键更新）'],
  ['public-routes', 'POST /api/plugins/:id/public-routes（公开路由审批）'],
  ['network-grants', 'GET/POST/DELETE /api/plugins/:id/network-grants（网络授权）'],
  ['sandbox-command', 'POST /api/plugins/:id/sandbox-command（沙箱命令）'],
  ['update-zip-raw', 'POST /api/plugins/:id/update-zip-raw（ZIP 更新）'],
]);

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(C.red(`✖ 无法读取 manifest.json：${e.message}`));
  process.exit(1);
}

const routes = Array.isArray(manifest?.api?.routes) ? manifest.api.routes : [];
const hits = [];

for (const route of routes) {
  const method = String(route?.method || 'GET').toUpperCase();
  const path = String(route?.path || '');
  const first = path.replace(/^\/+/, '').split('/')[0];
  if (RESERVED.has(first)) {
    hits.push({ method, path, owner: RESERVED.get(first) });
  }
}

console.log(`\n【平台保留路由检查】${manifestPath}`);

if (hits.length === 0) {
  console.log(`  ${C.green('✔')} [ROUTE_RESERVED] ${routes.length} 条路由均未占用平台保留动作`);
  console.log(`\n结果：0 error\n`);
  process.exit(0);
}

for (const hit of hits) {
  console.log(
    `  ${C.red('✖')} [ROUTE_RESERVED] ${hit.method} ${hit.path} 与平台核心路由冲突：${hit.owner}`,
  );
  console.log(
    `    ${C.dim('插件网关会放行该子路径，核心路由先匹配；请求不会进入插件。请改用其他路径名（如 /overview）。')}`,
  );
}

console.log(`\n结果：${C.red(`${hits.length} error`)}\n`);
process.exit(1);
