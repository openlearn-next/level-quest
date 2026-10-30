/**
 * 打包脚本：在 SDK 官方 CLI 产出的 ZIP 基础上补进 storage/。
 *
 * 官方 `openlearn-plugin-sdk build` 只打 index.js / manifest.json / frontend.js，
 * storage/ 不会进包；而宿主安装时会解压并托管 storage/*（教师页与学生页都靠它）。
 * 因此交付包必须由本脚本生成。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import JSZip from 'jszip';

const root = process.cwd();
const distDir = join(root, 'dist');
const manifestPath = join(root, 'manifest.json');
const indexJs = join(distDir, 'index.js');
const frontendJs = join(distDir, 'frontend.js');
const storageDir = join(root, 'storage');

function fail(message) {
  console.error(`[pack] ${message}`);
  process.exit(1);
}

if (!existsSync(indexJs)) fail('缺少 dist/index.js，请先运行 npm run build');
if (!existsSync(manifestPath)) fail('缺少 manifest.json');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest.json 不是合法 JSON：${err.message}`);
}
if (!manifest.id || !manifest.version) fail('manifest.json 缺少 id 或 version');
if (!manifest.main) fail('manifest.json 缺少 main 字段（平台必填，缺失会装不上）');

// 校验 manifest 里引用的 storage 视图确实存在
const views = [];
for (const entries of Object.values(manifest.contributes || {})) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (entry && typeof entry.view === 'string') views.push(entry.view);
    if (entry && entry.view && typeof entry.view === 'object' && typeof entry.view.path === 'string') {
      views.push(entry.view.path);
    }
  }
}
for (const view of views) {
  if (!existsSync(join(root, view))) fail(`manifest 引用的视图不存在：${view}`);
}

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (stat.isFile()) files.push(full);
  }
}
if (!existsSync(storageDir)) fail('缺少 storage/ 目录');
walk(storageDir);
if (files.length === 0) fail('storage/ 是空的');
for (const view of views) {
  const rel = relative(root, join(root, view));
  if (!files.some((f) => relative(root, f) === rel)) fail(`视图文件未被收纳：${view}`);
}

const zipName = `${basename(String(manifest.id).replace(/^@/, '').split('/').pop() || 'plugin')}.zip`;

const zip = new JSZip();
zip.file('index.js', readFileSync(indexJs));
zip.file('manifest.json', readFileSync(manifestPath));
if (existsSync(frontendJs)) zip.file('frontend.js', readFileSync(frontendJs));
for (const file of files) {
  zip.file(relative(root, file).split('\\').join('/'), readFileSync(file));
}

const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });

// ── 交付物：只有「完整包」一种 ─────────────────────────────────────────────
//
// 官方 CLI 的 build 只打 index.js / manifest.json / frontend.js，**不含 storage/**。
// 宿主安装时会 stat manifest 里声明的每个 view 文件 —— 缺 storage 就是：
//   ENOENT: no such file or directory, stat '.../plugins/<id>/storage/teacher.html'
// 且**整包安装失败**（不是「装了但页面空白」）。
//
// 以前仓库里同时躺着两个 ZIP（CLI 的 openlearn-plugin-level-quest.zip 不含 storage、
// 我们的 level-quest.zip 含），装错哪个取决于手点哪个 —— 这类错不该靠文档提醒。
// 现在：**覆盖 CLI 同名产物**，让「仓库里/构建产物里的任何一个 ZIP」都是完整包。
const cliName = 'openlearn-plugin-level-quest.zip';
writeFileSync(join(distDir, cliName), buffer);
writeFileSync(join(distDir, zipName), buffer);
writeFileSync(join(root, zipName), buffer);
writeFileSync(join(root, cliName), buffer);

const kb = (buffer.length / 1024).toFixed(1);
console.log(`[pack] ${zipName} / ${cliName}（${kb} KB）`);
console.log(`[pack] 包含：index.js, manifest.json${existsSync(frontendJs) ? ', frontend.js' : ''}, storage/*（${files.length} 个文件）`);
console.log(`[pack] 输出：${join(root, zipName)}`);
console.log('[pack] 两个文件名内容相同，均为完整可安装包（含 storage/）');
