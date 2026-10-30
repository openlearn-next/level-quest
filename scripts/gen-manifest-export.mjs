#!/usr/bin/env node
/**
 * 生成 `src/manifest.generated.ts` —— 把 manifest.json 原样注入到插件产物里。
 *
 * ## 为什么需要
 *
 * 平台的**安装**路径从 ZIP 里的 manifest.json 取清单（`validateAndBundleZip`），
 * 所以插件装得上；但平台的**更新 / 热重载**路径走的是另一套取清单的方式：
 *
 *   PluginHost.reloadPlugin()
 *     → extractManifest(newSourceCode)          // packages/core/plugin-host/core.ts
 *       → esmLoader.load(sourceCode)            // data:text/javascript;base64,…
 *       → plugin.manifest ?? mod.manifest        // ← 要求**源码导出 manifest**
 *
 * 产物里没有 manifest 导出 → 抛 `Plugin source code has no manifest export`
 * → 更新接口 500 → 平台把旧版本回滚，用户看到「装得上、更新就炸」。
 *
 * 官方 SDK 的构建（`openlearn-plugin-sdk build`）只把 manifest.json 单独打进 ZIP，
 * **不会**把它注入 index.js —— 所以这道坑要插件自己填。
 *
 * ## 怎么填
 *
 * 直接手抄一份 manifest 进源码必然漂移（改 manifest.json 忘了改源码）。
 * 这里改成**构建时从 manifest.json 生成**：
 *   - `npm run build` 前自动跑（package.json 的 prebuild）
 *   - 生成文件提交进仓库，clone 后不装依赖也能直接看
 *   - `scripts/check-runtime-bare-imports.mjs` 校验生成内容与 manifest.json 一致
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || '.';
const manifestPath = join(root, 'manifest.json');
const outPath = join(root, 'src', 'manifest.generated.ts');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// 排序，保证同样的 manifest.json 生成同样的文件（diff 干净）
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

const sorted = sortKeys(manifest);

const body = `/**
 * 由 \`scripts/gen-manifest-export.mjs\` 从 manifest.json 自动生成 —— 请勿手改。
 *
 * 平台的更新/热重载链路（PluginHost.reloadPlugin → extractManifest）要求插件
 * **源码导出 manifest**；官方 SDK 构建只把 manifest.json 单独打进 ZIP，不会注入
 * index.js。这份导出让「安装后更新」不再 500。
 *
 * 重新生成：npm run build（prebuild 自动执行）
 * 一致性校验：npm run test:contract
 */

/** 与 manifest.json 完全一致的插件清单。 */
export const manifest = ${JSON.stringify(sorted, null, 2)} as const;
`;

const existing = (() => {
  try {
    return readFileSync(outPath, 'utf8');
  } catch {
    return null;
  }
})();

if (existing !== body) {
  writeFileSync(outPath, body, 'utf8');
  console.log(`[gen-manifest] 已生成 ${outPath}（manifest.json v${manifest.version}）`);
} else {
  console.log('[gen-manifest] manifest.generated.ts 已是最新');
}
