#!/usr/bin/env node
/**
 * 交付包内容门禁（L0 补充）。
 *
 * ## 为什么需要
 *
 * 官方 SDK 的 `openlearn-plugin-sdk build` 只把 index.js / manifest.json /
 * frontend.js 打进 ZIP，**不含 storage/**。而宿主安装时会 stat manifest 里
 * 声明的每个 view 文件 —— 缺 storage 时整包安装直接失败：
 *
 *   ENOENT: no such file or directory,
 *   stat '.../plugins/<id>/storage/teacher.html'
 *
 * 也就是说：**装错产物不是「页面空白」，而是「装不上」**。
 *
 * 仓库里若同时存在两个 ZIP（CLI 命名的不含 storage、我们命名的含），
 * 装哪个全看手点哪个 —— 这类错不该靠文档提醒。因此这里在发布前逐个校验
 * 仓库里存在的 ZIP：必须包含 manifest 声明的全部 view 文件。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';

const root = process.argv[2] || '.';
const errors = [];

// manifest 声明的视图
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const views = [];
for (const entries of Object.values(manifest.contributes ?? {})) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (entry && typeof entry.view === 'string') views.push(entry.view);
    else if (entry && entry.view && typeof entry.view === 'object' && typeof entry.view.path === 'string') {
      views.push(entry.view.path);
    }
  }
}
if (views.length === 0) {
  console.log('  ℹ  manifest 未声明任何 view，跳过交付包检查');
  process.exit(0);
}

/** 收集根目录与 dist/ 下的 ZIP（gitignore 的 *.zip 不影响这里） */
function findZips(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findZips(p, out);
    else if (name.toLowerCase().endsWith('.zip')) out.push(p);
  }
  return out;
}

const zips = [
  ...findZips(root).filter((p) => !relative(root, p).startsWith('node_modules')),
];

if (zips.length === 0) {
  errors.push('仓库里没有任何 ZIP 交付物：请先运行 npm run build');
}

for (const zipPath of zips) {
  const rel = relative(root, zipPath);
  let zip;
  try {
    zip = await JSZip.loadAsync(readFileSync(zipPath));
  } catch (err) {
    errors.push(`${rel} 不是合法 ZIP：${err.message}`);
    continue;
  }
  const entries = Object.keys(zip.files);
  const missing = views.filter((v) => !entries.includes(v.replace(/^\/+/, '')));
  if (missing.length > 0) {
    errors.push(
      `${rel} 缺少 manifest 声明的视图文件：${missing.join(', ')}` +
        ' → 宿主安装时会 stat 失败，整包安装报 ENOENT。' +
        '请用 `npm run build`（已内置 pack）重新生成。',
    );
  } else {
    console.log(`  ✔ ${rel}（${entries.length} 个条目）包含全部视图：${views.join(', ')}`);
  }
}

if (errors.length > 0) {
  console.error('\n【交付包内容检查】失败：');
  for (const e of errors) console.error(`  ✖  ${e}`);
  process.exit(1);
}
console.log('\n【交付包内容检查】通过：所有 ZIP 均含 manifest 声明的视图文件');
