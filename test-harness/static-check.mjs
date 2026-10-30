#!/usr/bin/env node
/**
 * OpenLearnV2 插件契约静态检查（L0）
 *
 * 零依赖，直接 `node test-harness/static-check.mjs [pluginDir]`。
 * 目标：在 `npm install` / 上传之前，用秒级检查抓住「编译能过、装上也过、一用就崩」的契约违规。
 *
 * 覆盖：manifest 必填项 · engines · 命令/Handler/Action 三件套配对 · 权限串真伪 ·
 *      隔离模式空能力门禁（Barrier 2）· 进程模式禁用 API · 前端沙箱边界 · 裸模块说明符 ·
 *      DB 表名与分号 · type-only 导入 · 密钥泄露
 *
 * 退出码：0 = 通过（可能有 warn）；1 = 有 error。
 * 说明：本脚本是启发式（正则/AST-lite），语义问题靠 test-harness 里的 vitest 用例。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) ?? process.cwd();
const JSON_OUT = process.argv.includes('--json');

// ── 平台真源：20 条 RBAC 权限 + 3 条仅可声明项 ────────────────────────────
const REAL_CAPS = new Set([
  'management:write', 'lesson:write', 'whiteboard:write', 'management:read',
  'plugin:write', 'lesson:read', 'vfs:write', 'process:write',
  'assignment:manage', 'whiteboard:read', 'vfs:read', 'process:read',
  'assignment:read', 'lesson:delete', 'plugin:read', 'student:write',
  'assignment:write', 'assignment:submit', 'assignment:review',
  // 仅出现在 capabilitiesProposed、从未作为 capabilityRequired（声明无害）
  'class:read', 'class:write', 'student:read',
]);

// 3.7.2 起仅 type-only 导出的宿主内部类
const TYPE_ONLY = [
  'PluginRuntimeComposition', 'PluginCapabilityGateway', 'PluginContextAdapter',
  'PluginDistributionManager', 'PluginLifecycleManager', 'PluginRuntimeAdapter',
  'UnifiedExtensionRegistry',
];

const results = [];
const add = (level, code, message, file) => results.push({ level, code, message, file });

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-harness', 'tests', 'test', '__tests__', 'coverage', '.cache']);
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// ── 平台真源：扩展槽位注册表（由 assets/test-harness/slot-registry.json 提供）──
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REGISTRY = (() => {
  const raw = read(join(HERE, 'slot-registry.json'));
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
})();
const REAL_SLOTS = new Set(REGISTRY.slots ?? []);

/** 从 idx 处的引号开始读取一个字符串/模板字面量 */
function readStringAt(text, idx) {
  while (idx < text.length && /\s/.test(text[idx])) idx++;
  const q = text[idx];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let value = '', i = idx + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { value += text[i + 1] ?? ''; i += 2; continue; }
    if (c === q) return { value, end: i + 1 };
    value += c; i++;
  }
  return null;
}

/** 解析 fn( 后的前若干个字符串字面量实参（跳过括号层级） */
function readStringArgs(text, openIdx) {
  const out = [];
  let i = openIdx + 1, depth = 0;
  while (i < text.length && out.length < 2) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' && depth === 0) break;
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (depth === 0 && (c === "'" || c === '"' || c === '`')) {
      const s = readStringAt(text, i);
      if (!s) break;
      out.push({ value: s.value, end: s.end });
      i = s.end; continue;
    }
    i++;
  }
  return out;
}

/** 把注释替换成空格（保留字符串字面量与换行），避免注释里的示例代码造成误报 */
function maskComments(text) {
  let out = '', i = 0, state = 'code';
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" ) { state = 'sq'; out += c; i++; continue; }
      if (c === '"' ) { state = 'dq'; out += c; i++; continue; }
      if (c === '`' ) { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } else out += ' '; i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += blank(c); i++; continue;
    }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'; out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

function walk(dir, out = [], skip = SKIP_DIRS) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!skip.has(name)) walk(p, out, skip); }
    else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. manifest ─────────────────────────────────────────────────────────
const distManifestPath = join(ROOT, 'dist', 'manifest.json');
const rootManifestPath = join(ROOT, 'manifest.json');
const manifestPath = existsSync(distManifestPath) ? distManifestPath : rootManifestPath;
let manifest = null;
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(read(manifestPath)); add('ok', 'MANIFEST_FOUND', `manifest: ${relative(ROOT, manifestPath)}`, manifestPath); }
  catch (e) { add('error', 'MANIFEST_INVALID_JSON', `manifest.json 不是合法 JSON：${e.message}`, manifestPath); }
}

// manifest.json 不存在时，从 src 的 `manifest: { ... }` 推导（构建前也能跑）
function parseSourceManifest(text) {
  const at = text.search(/\bmanifest\s*:\s*\{/);
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const b = text.slice(open, end + 1);
  const str = (k) => b.match(new RegExp(`${k}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`))?.[1];
  const arr = (k) => {
    const m = b.match(new RegExp(`${k}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/['"\`]([^'"\`]+)['"\`]/g)].map((x) => x[1]) : [];
  };
  const enginesBlock = b.match(/engines\s*:\s*\{([\s\S]*?)\}/)?.[1];
  return {
    id: str('id'), name: str('name'), version: str('version'), main: str('main'),
    engines: enginesBlock ? { openlearn: enginesBlock.match(/openlearn\s*:\s*['"\`]([^'"\`]+)['"\`]/)?.[1] } : undefined,
    capabilitiesProposed: arr('capabilitiesProposed'),
    __declaredTypes: [...b.matchAll(/commandType\s*:\s*['"\`]([^'"\`]+)['"\`]/g)].map((m) => m[1]),
    __viewPaths: [...b.matchAll(/view\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]),
    // 源码推导时无法可靠解析 contributes 的键，退化为「在 manifest 块里出现的已知槽位名」
    __declaredSlots: [...REAL_SLOTS].filter((slot) => b.includes(`'${slot}'`) || b.includes(`"${slot}"`)),
  };
}

if (!manifest) {
  const idx = [join(ROOT, 'src', 'index.ts'), join(ROOT, 'src', 'index.js'), join(ROOT, 'index.ts')].find((p) => existsSync(p));
  const inferred = idx ? parseSourceManifest(read(idx) ?? '') : null;
  if (inferred) {
    manifest = inferred;
    add('warn', 'MANIFEST_SOURCE_ONLY', '未找到 manifest.json：按 src 源码推导 manifest（构建后再跑一次可获产物级校验）', idx);
  }
}

const srcDir = join(ROOT, 'src');
const srcFiles = walk(srcDir);
if (srcFiles.length === 0) add('warn', 'NO_SRC', '未找到 src/，按纯 JS 插件继续（源码级规则将跳过）');
const srcText = srcFiles.map((f) => `\n//# ${f}\n${maskComments(read(f) ?? '')}`).join('\n');

// 前端产物/源码（用于 UI 通道判定；注释已遮蔽，避免文档示例误报）
const fePath = [join(ROOT, 'dist', 'frontend.js'), join(ROOT, 'src', 'frontend.tsx'), join(ROOT, 'src', 'frontend.ts')].find((p) => existsSync(p));
const feCode = fePath ? maskComments(read(fePath) ?? '') : '';

if (manifest) {
  if (!manifest.main) add('error', 'MANIFEST_MAIN', 'manifest.main 缺失（manifestSchema 为 min(1)，插件会装不上）', manifestPath);
  if (!manifest.id) add('error', 'MANIFEST_ID', 'manifest.id 缺失', manifestPath);
  else if (String(manifest.id).includes(':')) add('error', 'MANIFEST_ID_COLON', `manifest.id 不得含 ':'：${manifest.id}`, manifestPath);
  if (!manifest.version) add('error', 'MANIFEST_VERSION', 'manifest.version 缺失', manifestPath);
  if (!manifest.engines?.openlearn) add('error', 'ENGINES_MISSING', 'manifest.engines.openlearn 缺失（需声明宿主版本范围，不是 SDK 版本）', manifestPath);
  else if (!/^[\^~><= ]*v?\d+\.\d+\.\d+/.test(String(manifest.engines.openlearn))) add('warn', 'ENGINES_FORMAT', `engines.openlearn 不像合法 semver range：${manifest.engines.openlearn}`, manifestPath);

  // capabilities
  const caps = Array.isArray(manifest.capabilitiesProposed) ? manifest.capabilitiesProposed : [];
  for (const cap of caps) if (!REAL_CAPS.has(cap)) add('error', 'CAP_UNKNOWN', `权限串不存在于平台真实集合：${cap}（声明了也不生效）`, manifestPath);

  // api.routes
  for (const [i, r] of (manifest.api?.routes ?? []).entries()) {
    if (!/^(GET|POST|PUT|DELETE|PATCH)$/.test(r.method ?? '')) add('error', 'ROUTE_METHOD', `api.routes[${i}].method 非法：${r.method}（不支持 ALL / 小写）`, manifestPath);
    if (!String(r.path ?? '').startsWith('/')) add('error', 'ROUTE_PATH', `api.routes[${i}].path 必须以 / 开头：${r.path}`, manifestPath);
    if (r.auth === false) add('warn', 'ROUTE_AUTH_FALSE', `api.routes[${i}] 声明 auth:false，仅"申请"公开，仍需管理员批准否则 401（不是 bug）`, manifestPath);
  }

  // zip / 产物三件套
  const distIndex = join(ROOT, 'dist', 'index.js');
  if (existsSync(join(ROOT, 'dist')) && !existsSync(distIndex)) add('error', 'DIST_ENTRY_MISSING', 'dist/index.js 不存在（构建未完成或产物被移动）', join(ROOT, 'dist'));
  if (manifest.main && existsSync(join(ROOT, 'dist')) && !existsSync(join(ROOT, 'dist', manifest.main))) add('error', 'DIST_MAIN_MISMATCH', `dist/ 下找不到 manifest.main 指向的 ${manifest.main}`, join(ROOT, 'dist'));
}

const contractPath = join(ROOT, 'plugin.contract.json');
let contract = null;
if (existsSync(contractPath)) {
  try { contract = JSON.parse(read(contractPath)); add('ok', 'CONTRACT_FOUND', `设计契约: ${relative(ROOT, contractPath)}`, contractPath); }
  catch (e) { add('error', 'CONTRACT_INVALID', `plugin.contract.json 不是合法 JSON：${e.message}`, contractPath); }
} else {
  add('warn', 'CONTRACT_MISSING', '缺少 plugin.contract.json：UI 通道/执行模式无法自动校验（模板见 references/ui-channel-decision.md §6）', ROOT);
}

const mode = contract?.executionMode;
const uiChannel = contract?.uiChannel;

// ── 2. 命令三件套配对 ───────────────────────────────────────────────────
const norm = (s) => String(s).replace(/^['"`]|['"`]$/g, '').trim();
const handlers = new Set();

const distRaw = read(join(ROOT, 'dist', 'index.js'));
const scanText = distRaw ? maskComments(distRaw) : srcText;

for (const m of scanText.matchAll(/registerHandler\(\s*['"`]([^'"`]+)['"`]/g)) handlers.add(norm(m[1]));

// ActionDescriptor：同一 commandType 可能在 frontend 的 slotProps 里被引用（无 capabilityRequired / inputSchema），
// 因此只在「窗口内出现 capabilityRequired 或 inputSchema」时才算描述符，并合并多次出现。
const actions = new Map();          // commandType -> { cap, hasDesc, hasSchema, schemaCaseOk }
const actionIds = new Map();        // id -> commandType（查重）
for (const m of scanText.matchAll(/commandType\s*:\s*['"`]([^'"`]+)['"`]/g)) {
  const type = norm(m[1]);
  const win = scanText.slice(m.index, m.index + 600);
  const cap = win.match(/capabilityRequired\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? null;
  const hasSchema = /inputSchema\s*:/.test(win);
  // 是否真的是「注册描述符」：向前回看 actionRegistry.register(...)，而不是 slotProps / manifest 里的引用
  const back = scanText.slice(Math.max(0, m.index - 260), m.index);
  const isDescriptor = /(?:actionRegistry|IActionRegistryService)\s*\.\s*register\s*\(/.test(back)
    || (!/registerExtensionPoint/.test(back) && (!!cap || hasSchema));
  if (!isDescriptor) continue;

  const prev = actions.get(type) ?? { cap: null, hasDesc: false, hasSchema: false, schemaCaseOk: false };
  const desc = /description\s*:\s*['"`]([^'"`]{4,})['"`]/.test(win);
  const upper = /type\s*:\s*['"`](OBJECT|STRING|NUMBER|INTEGER|BOOLEAN|ARRAY)['"`]/.test(win);
  actions.set(type, {
    cap: prev.cap ?? (cap ? norm(cap) : null),
    hasDesc: prev.hasDesc || desc,
    hasSchema: prev.hasSchema || hasSchema,
    schemaCaseOk: prev.schemaCaseOk || upper,
  });

  // ActionDescriptor.id：向前 240 字符回看（同一对象内）；重复 id 会在宿主注册表互相覆盖
  const idm = [...back.matchAll(/\bid\s*:\s*['"`]([^'"`]+)['"`]/g)].pop();
  if (!idm) add('warn', 'ACTION_ID_MISSING', `commandType '${type}' 的描述符前找不到 id 字段（ActionDescriptor.id 必填且需唯一）`, 'src/index.ts');
  else {
    const actionId = norm(idm[1]);
    if (actionIds.has(actionId)) add('error', 'ACTION_ID_DUP', `ActionDescriptor id '${actionId}' 重复（${actionIds.get(actionId)} 与 ${type}）→ 注册时互相覆盖`, 'src/index.ts');
    else actionIds.set(actionId, type);
  }
}

// manifest 里声明的 commandType（短名口径）
const declared = new Map(); // type -> where
const pid = manifest?.id;
const addDeclared = (t, where) => {
  if (!t) return;
  let v = norm(t);
  if (pid && v.startsWith(`${pid}.`)) v = v.slice(pid.length + 1); // 全限定 → 短名
  declared.set(v, where);
};
for (const t of manifest?.classroomTools ?? []) addDeclared(t.commandType, 'classroomTools');
for (const t of manifest?.__declaredTypes ?? []) addDeclared(t, 'manifest');
const walkContrib = (v, path) => {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) return v.forEach((x, i) => walkContrib(x, `${path}[${i}]`));
  for (const [k, val] of Object.entries(v)) {
    if (k === 'commandType' && typeof val === 'string') addDeclared(val, path);
    else walkContrib(val, `${path}.${k}`);
  }
};
walkContrib(manifest?.contributes, 'contributes');

for (const [type, where] of declared) {
  if (!handlers.has(type)) add('error', 'PAIR_HANDLER_MISSING', `manifest ${where} 用了 commandType '${type}'，但没有同名 registerHandler → 点击必失败`, 'src/index.ts');
  if (!actions.has(type)) add('error', 'PAIR_ACTION_MISSING', `commandType '${type}' 没有 ActionDescriptor → COMMAND_NOT_REGISTERED (HTTP 403)`, 'src/index.ts');
}
for (const type of handlers) {
  if (!actions.has(type)) add('error', 'PAIR_ACTION_MISSING', `registerHandler('${type}') 没有同名 ActionDescriptor → default-deny 拒绝`, 'src/index.ts');
}
for (const type of actions.keys()) {
  if (!handlers.has(type)) add('warn', 'PAIR_HANDLER_ORPHAN', `ActionDescriptor '${type}' 没有对应 handler（AI 能选中但执行无响应）`, 'src/index.ts');
}

// ActionDescriptor 必填 / 权限真伪
for (const [type, info] of actions) {
  if (!info.hasDesc) add('warn', 'ACTION_DESC_WEAK', `ActionDescriptor '${type}' 缺少有意义的 description（AI 选不准）`, 'src/index.ts');
  if (!info.hasSchema) add('warn', 'ACTION_SCHEMA_MISSING', `ActionDescriptor '${type}' 未声明 inputSchema`, 'src/index.ts');
  else if (!info.schemaCaseOk) add('warn', 'ACTION_SCHEMA_CASE', `inputSchema 的类型名应为大写 GenAI 枚举（OBJECT / STRING …）`, 'src/index.ts');
  if (!info.cap) add('error', 'ACTION_CAP_MISSING', `ActionDescriptor '${type}' 缺 capabilityRequired（宿主按它做授权）`, 'src/index.ts');
  else if (!REAL_CAPS.has(info.cap)) add('error', 'ACTION_CAP_UNKNOWN', `ActionDescriptor '${type}' 的 capabilityRequired '${info.cap}' 不存在于平台真实集合`, 'src/index.ts');
}

// 运行期扩展点必须全限定（只匹配真实调用：第一个参数是字符串字面量，排除类型声明）
for (const m of scanText.matchAll(/registerExtensionPoint\(\s*['"`](?:command_palette\.item|[\w.]+)['"`]\s*,\s*\{[\s\S]{0,600}?\}\s*\)/g)) {
  const call = m[0];
  const ct = call.match(/commandType\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
  if (!ct) continue;
  const v = norm(ct);
  if (pid && !v.startsWith(`${pid}.`)) add('error', 'EXT_POINT_PREFIX', `运行期 registerExtensionPoint 的 commandType 不会自动加前缀，必须写全限定 '${pid}.xxx'，当前为 '${v}'`, 'src/index.ts');
}

// ── 3. 执行模式 / 沙箱边界 ───────────────────────────────────────────────
const bannedApis = [
  [/from\s+['"]child_process['"]/, 'child_process', '子进程在 process / worker 模式被禁'],
  [/from\s+['"]worker_threads['"]/, 'worker_threads', '自建 worker 在 process 模式被禁'],
  [/\beval\s*\(/, 'eval()', 'process 沙箱禁用动态求值'],
  [/\bnew\s+Function\s*\(/, 'new Function()', 'process 沙箱禁用动态求值'],
  [/ctx\.provide\s*\(/, 'ctx.provide()', '非 inline 模式不可用（宿主不执行 DI provide）'],
  [/ctx\.config\./, 'ctx.config', '非 inline 模式不可用，改用 ctx.config.get 之外的宿主配置通道或 ensureTable 自存'],
];
for (const f of srcFiles) {
  const t = maskComments(read(f) ?? '');
  for (const [re, name, why] of bannedApis) {
    if (re.test(t)) add('error', 'PROCESS_FORBIDDEN_API', `${relative(ROOT, f)} 使用 ${name}：${why}（第三方插件被强制 process 模式）`, f);
  }
  for (const sym of TYPE_ONLY) {
    if (new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from`).test(t) && !/import\s+type\s*\{/.test(t)) {
      add('error', 'TYPE_ONLY_VALUE_IMPORT', `${relative(ROOT, f)} 以值导入 ${sym}（3.7.2 起仅 type-only，运行期为 undefined）`, f);
    }
  }
}

// ── 4. 前端产物边界 ─────────────────────────────────────────────────────
const fe = fePath;
if (fe) {
  const t = feCode;
  const rel = relative(ROOT, fe);
  if (/^\s*import\s+React\b|\bfrom\s+['"]react['"]|from\s+['"]react-dom/.test(t)) add('error', 'FRONTEND_REACT', `${rel} 引用了 React：① process/worker 下沙箱 iframe 无 HostSharedDeps，激活必失败；② inline 下 CLI 的裸说明符守卫也会让构建失败。正解是 globalThis.HostSharedDeps.React（见 references/ui-channel-decision.md §4）`, fe);
  if (/\bdocument\.|\bwindow\.|\bfetch\s*\(/.test(t)) add('error', 'FRONTEND_DOM', `${rel} 使用 document/window/fetch：沙箱 CSP connect-src 'none'，且 iframe 内无宿主 DOM`, fe);
  if (/\bcomponent\s*:/.test(t)) {
    if (mode === 'process') add('error', 'FRONTEND_COMPONENT', `${rel} 传 component，但契约 executionMode=process：函数无法跨 postMessage → DataCloneError / 组件永不渲染`, fe);
    else if (!mode) add('warn', 'FRONTEND_COMPONENT', `${rel} 传 component，但没有 plugin.contract.json 判定执行模式；process 下会静默失败`, fe);
  }
  for (const m of t.matchAll(/(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) {
      add('error', 'FRONTEND_BARE_SPECIFIER', `${rel} 含裸模块说明符 '${spec}'：沙箱用 Blob + 动态 import()，裸说明符无从解析（3.7.2+ 构建直接失败）`, fe);
    }
  }
  const TS_PRIMS = new Set(['string', 'number', 'boolean', 'void', 'null', 'undefined', 'unknown', 'any', 'never', 'object', 'bigint', 'symbol']);
  const tags = [...t.matchAll(/<\/?([A-Za-z][\w.]*)([^>]*)>/g)];
  const looksJsx = tags.some(([full, name, attrs]) =>
    !TS_PRIMS.has(String(name).toLowerCase()) && String(name).length > 1 &&
    (full.startsWith('</') || full.endsWith('/>') || /\w+\s*=/.test(attrs)));
  if (looksJsx) add('warn', 'FRONTEND_JSX', `${rel} 疑似含 JSX：远程前端不渲染 UI，可见入口请走 manifest.classroomTools / contributes`, fe);
}

// dist/index.js 裸导入
const distIndexText = distRaw ? maskComments(distRaw) : null;
if (distIndexText) {
  for (const m of distIndexText.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    // 平台允许相对路径与 @openlearn/*（Token 服务）：install-utils.ts external: ['@openlearn/*']，
    // token-enforcer 文案亦为 "relative paths or @openlearn/* Token services"。其余裸 specifier 会被拒。
    if (spec.startsWith('@openlearn/')) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) {
      add('error', 'DIST_BARE_IMPORT', `dist/index.js 含裸导入 '${spec}'：token-enforcer 只放行相对路径与 @openlearn/*（其它依赖须打进 bundle；能力走 ctx.services）`, join(ROOT, 'dist', 'index.js'));
    }
  }
}

// ── 5. 数据库契约 ───────────────────────────────────────────────────────
if (scanText) {
  for (const m of scanText.matchAll(/\.ensureTable\s*\(/g)) {
    const args = readStringArgs(scanText, m.index + m[0].length - 1);
    if (!args || args.length < 2) continue;
    const [name, schema] = args;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name.value)) add('error', 'DB_TABLE_NAME', `ensureTable('${name.value}') 不符合 /^[A-Za-z_][A-Za-z0-9_]{0,63}$/，生产宿主会拒绝`, 'src/index.ts');
    if (schema.value.includes(';')) add('error', 'DB_SCHEMA_SEMICOLON', `ensureTable('${name.value}') 的 schema 含分号：生产宿主禁分号（防多语句注入）`, 'src/index.ts');
    if (schema.value.length > 4000) add('error', 'DB_SCHEMA_LONG', `ensureTable('${name.value}') 的 schema 超过 4000 字符上限`, 'src/index.ts');
  }
  if (/ctx\.db\.prepare\s*\(/.test(scanText)) add('error', 'DB_NO_PREPARE', 'ctx.db 没有 prepare()：裸 SQL 请 ctx.resolve(IDatabaseToken)', 'src/index.ts');
}

// ── 6. 事件订阅是否保留引用 ──────────────────────────────────────────────
if (scanText) {
  const subs = [...scanText.matchAll(/\.subscribe\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => norm(m[1]));
  if (subs.length && !/\.unsubscribe\(/.test(scanText)) add('warn', 'EVENT_NO_UNSUB', `订阅了 ${subs.join(', ')} 但未调用 unsubscribe；宿主会兜底，自建资源仍需自行释放`, 'src/index.ts');
}

// ── 7. 密钥 / 敏感信息 ──────────────────────────────────────────────────
const SECRETS = [
  [/sk-[A-Za-z0-9]{16,}/, '疑似 OpenAI/Anthropic 风格 API Key'],
  [/AKIA[0-9A-Z]{16}/, '疑似 AWS Access Key'],
  [/ENCRYPTION_KEY\s*[=:]\s*\S+/, '疑似 ENCRYPTION_KEY 值'],
  [/edu_os_token\s*[=:]\s*\S+/, '疑似会话 Cookie 值'],
];
for (const f of [...srcFiles, ...walk(join(ROOT, 'dist'), [], new Set(['node_modules', '.git']))]) {
  const t = read(f) ?? '';
  for (const [re, why] of SECRETS) if (re.test(t)) add('error', 'SECRET_LEAK', `${relative(ROOT, f)} 命中${why}：不得进入源码或产物`, f);
}

// ── 7. UI 通道契约（executionMode / 槽位 / 白名单 / 白板挂件）──────────────
// 这一组专治「教师点了按钮，学生端什么也看不到」：
//   process 模式写 React / 编造槽位 / 只声明教师端 / 只 return 不写白板 / 以为 id 前缀能换信任
if (REAL_SLOTS.size === 0) add('warn', 'SLOT_REGISTRY_MISSING', 'test-harness/slot-registry.json 缺失，槽位真伪无法校验', HERE);

const declaredCaps = Array.isArray(manifest?.capabilitiesProposed) ? manifest.capabilitiesProposed : [];
const manifestSlots = new Set([
  ...Object.keys(manifest?.contributes ?? {}),
  ...(manifest?.__declaredSlots ?? []),
]);
const contractSlots = Array.isArray(contract?.slots) ? contract.slots : [];
const allSlots = new Set([...manifestSlots, ...contractSlots]);

for (const slot of allSlots) {
  if (slot.startsWith('anchor:')) continue; // anchor:{区域}:{锚点id} 为动态模式
  if (REAL_SLOTS.size && !REAL_SLOTS.has(slot)) {
    add('error', 'SLOT_UNKNOWN', `槽位 '${slot}' 不在平台真实注册表（v${REGISTRY.platformVersion} 共 ${REAL_SLOTS.size} 个）；写错不会报错，只会永远不渲染`, contractPath);
  }
}
if (contract && contractSlots.length) {
  if (uiChannel === 'declarative') {
    // 声明式槽位由宿主按 manifest 渲染 → 必须在 manifest 里声明
    for (const slot of contractSlots) {
      if (!slot.startsWith('anchor:') && !manifestSlots.has(slot)) add('error', 'SLOT_NOT_DECLARED', `契约声明了声明式槽位 '${slot}'，但 manifest.contributes 未声明 → 宿主不会渲染`, manifestPath);
    }
  } else if (uiChannel === 'inline-react' || uiChannel === 'polling') {
    // 运行期注册的槽位（React 组件或数据型）→ 在 frontend 里应能找到 registerExtensionPoint 调用
    for (const slot of contractSlots) {
      const registered = new RegExp(`registerExtensionPoint\\(\\s*['"\`]${slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(feCode);
      if (!registered) add('error', 'SLOT_NOT_REGISTERED', `契约声明了槽位 '${slot}'，但 frontend 没有 registerExtensionPoint('${slot}', …) → 该容器永远空着`, fePath);
    }
  }
  for (const slot of manifestSlots) {
    if (!contractSlots.includes(slot) && !slot.startsWith('anchor:')) add('warn', 'SLOT_UNDECLARED_IN_CONTRACT', `manifest 声明了槽位 '${slot}'，契约里没有 → 设计漂移，补进 contract.slots`, manifestPath);
  }
}

const usesComponent = /registerExtensionPoint\([\s\S]{0,400}?component\s*:/.test(feCode) || /\bcomponent\s*:/.test(feCode);
const usesReactImport = /^\s*import\s+React\b|\bfrom\s+['"]react(?:-dom)?['"]/.test(feCode);
const usesHostDeps = /HostSharedDeps/.test(feCode);
const pluginId = String(manifest?.id ?? '');
const whiteboardWidget = contract?.whiteboardWidget === true;
const studentVisible = contract?.studentVisible === true;

if (contract && !['process', 'inline'].includes(mode)) {
  add('error', 'CONTRACT_MODE_INVALID', `contract.executionMode 必须是 'process' 或 'inline'，当前：${mode ?? '(缺失)'}`, contractPath);
}
if (manifest && 'executionMode' in (manifest ?? {})) {
  add('warn', 'MANIFEST_MODE_IGNORED', 'manifest.executionMode 不参与判定：实际模式由服务端 resolvePluginExecutionMode() 写入 plugins.execution_mode', manifestPath);
}

if (mode === 'process') {
  if (usesComponent) add('error', 'UI_MODE_MISMATCH', '契约 executionMode=process，但 frontend 注册了 component：函数无法跨 postMessage，组件不会渲染（且 DataCloneError / 静默丢失）', fePath);
  if (uiChannel === 'inline-react') add('error', 'CONTRACT_MODE_CONFLICT', "contract.uiChannel='inline-react' 与 executionMode='process' 矛盾：自定义 React UI 必须 inline", contractPath);
}

if (mode === 'inline') {
  const entry = contract?.trustedInlineAllowlistEntry;
  if (!entry) add('error', 'INLINE_TRUST_MISSING', 'executionMode=inline 但缺少 trustedInlineAllowlistEntry：id 前缀不构成信任，必须由宿主 OPENLEARN_TRUSTED_INLINE_PLUGINS 或内置目录放行', contractPath);
  const allow = process.env.OPENLEARN_TRUSTED_INLINE_PLUGINS;
  if (entry && allow) {
    const matched = allow.split(',').map((x) => x.trim()).filter(Boolean).some((pat) => {
      if (pat === '*') return true;
      if (pat.endsWith('*')) return pluginId.startsWith(pat.slice(0, -1));
      return pat === pluginId;
    });
    if (!matched) add('error', 'INLINE_NOT_WHITELISTED', `宿主白名单（${allow}）未包含 '${entry}' 或 ${pluginId}：插件会被强制改写成 process，React 不挂载`, contractPath);
  } else if (entry && !allow) {
    add('warn', 'INLINE_TRUST_UNVERIFIED', '未读取到 OPENLEARN_TRUSTED_INLINE_PLUGINS：无法验证宿主是否放行（把宿主 .env 导入环境变量后可校验）', contractPath);
  }
  if (uiChannel === 'inline-react' && usesReactImport) {
    add('error', 'INLINE_REACT_IMPORT', 'inline 前端也不能写 import React：CLI 3.7.2+ 裸说明符守卫会构建失败；改用 globalThis.HostSharedDeps.React', fePath);
  }
  if (uiChannel === 'inline-react' && !usesHostDeps && usesComponent) {
    add('warn', 'INLINE_REACT_NO_HOSTDEPS', '注册了 component 但没看到 HostSharedDeps：确认 React 来自宿主注入，而不是自己 bundle（否则 Invalid hook call）', fePath);
  }
}

if (whiteboardWidget) {
  const hasViewWidget = allSlots.has('teacher.dashboard.widget') && allSlots.has('student.view') && uiChannel === 'sandbox-view';
  if (mode && mode !== 'inline' && !hasViewWidget) {
    add('error', 'WHITEBOARD_WIDGET_NEEDS_INLINE', "whiteboardWidget=true 在组件模式下需要 inline：若使用 process 模式，必须采用 sandbox-view 并在 teacher.dashboard.widget 与 student.view 配置 storage/*.html 视图", contractPath);
  }
  const dispatchesDraw = /whiteboard\.draw/.test(scanText) || /whiteboard\.draw/.test(JSON.stringify(manifest?.classroomTools ?? []));
  if (!dispatchesDraw) add('error', 'WHITEBOARD_DRAW_MISSING', "契约声明白板挂件，但源码与 manifest.classroomTools 均没有使用 whiteboard.draw：学生端画布上不会有元素", 'src/index.ts');
  const hasWidgetIds = (/teacherWidgetId/.test(scanText) && /studentWidgetId/.test(scanText)) ||
    (/teacherWidgetId/.test(JSON.stringify(manifest?.classroomTools ?? [])) && /studentWidgetId/.test(JSON.stringify(manifest?.classroomTools ?? [])));
  if (!hasWidgetIds) add('error', 'WHITEBOARD_WIDGET_ID_MISSING', "whiteboard.draw 的 data 需同时含 teacherWidgetId 与 studentWidgetId（JSON 字符串），否则一侧永远显示「正在加载」", 'src/index.ts');
  if (!declaredCaps.includes('whiteboard:write')) add('error', 'WHITEBOARD_CAP_MISSING', "派发 whiteboard.draw 需要 capabilitiesProposed 含 'whiteboard:write'，否则命令 403", manifestPath);
  if (mode === 'inline' && !/(teacher\.dashboard\.widget|student\.view)/.test(feCode)) add('error', 'WHITEBOARD_RENDERER_MISSING', "白板挂件需要注册 teacher.dashboard.widget（教师侧）与 student.view（学生侧）扩展点，id 与 widget id 一致", fePath);
}

if (studentVisible) {
  const studentSlots = [...allSlots].filter((x) => x.startsWith('student.'));
  if (studentSlots.length === 0) add('error', 'STUDENT_ENTRY_MISSING', "契约 studentVisible=true，但没有任何 student.* 槽位：学生端没有渲染容器（白板挂件用 student.view）", contractPath);
  if (whiteboardWidget && !allSlots.has('student.view')) add('error', 'STUDENT_WIDGET_SLOT_MISSING', "白板挂件要让学生看到，必须声明 student.view（教师侧配 teacher.dashboard.widget）", contractPath);
}

// 声明式 UI 契约却写了组件 → 设计漂移
if (mode === 'inline' && uiChannel === 'declarative' && usesComponent) {
  add('warn', 'UI_CHANNEL_DRIFT', "contract.uiChannel='declarative' 但前端注册了 component：要么改契约，要么去掉组件", contractPath);
}


// ── 7a. 中文字号下限（Guardrail 13）────────────────────────────────────
// 12px 及以下的中文在投影/白板上不可读，但 CSS 不报错、L1 也不会失败，
// 是「能跑但看不清」的静默问题，只能在静态检查里卡。
// 覆盖 view 页面（<style> / 行内 style / JS 里 style.fontSize）与 inline React
// （fontSize 数值或字符串、Tailwind text-xs / text-[12px]）。
// 纯图标 / 装饰可写同行注释 `font-size-ok` 豁免。
const MIN_TEXT_PX = 13;
const FONT_UNIT_PX = { px: 1, rem: 16, em: 16, pt: 4 / 3 };
const FONT_KEYWORD_PX = { 'xx-small': 9, 'x-small': 10, small: 13 };
const fontHits = new Set();

const lineIndexOf = (text, idx) => text.slice(0, idx).split('\n').length;
const lineTextAt = (text, idx) => {
  const start = text.lastIndexOf('\n', idx - 1) + 1;
  const end = text.indexOf('\n', idx);
  return text.slice(start, end === -1 ? text.length : end);
};
const isFontExempt = (text, idx) => /font-size-ok/.test(lineTextAt(text, idx));

function reportFont(file, text, idx, raw, px) {
  const line = lineIndexOf(text, idx);
  raw = raw.trim().replace(/["']+$/, '');
  const key = `${file}:${line}:${raw}`;
  if (fontHits.has(key)) return;
  fontHits.add(key);
  add(
    'error',
    'FONT_TOO_SMALL',
    `${file}:${line} 字号 ${raw} ≈ ${Math.round(px * 10) / 10}px < ${MIN_TEXT_PX}px：`
      + `中文在投影/白板上不可读，正文与标签至少 ${MIN_TEXT_PX}px；`
      + `纯图标 / 装饰可加同行注释 font-size-ok 豁免`,
    file,
  );
}

function sizeToPx(num, unit) {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return null; // 0 常用于藏字/图标，不判
  const factor = FONT_UNIT_PX[String(unit || '').toLowerCase()];
  return factor == null ? null : n * factor;
}

function checkFontDeclarations(file, text, from, to) {
  const region = text.slice(from, to);
  for (const m of region.matchAll(/(font-size|font)\s*:\s*([^;}]+)/gi)) {
    const idx = from + m.index;
    if (isFontExempt(text, idx)) continue;
    const value = m[2];
    if (/calc\(/i.test(value)) continue; // 静态求值不可靠，交给 L1 / 人工
    const sizes = [];
    if (m[1].toLowerCase() === 'font-size') {
      for (const n of value.matchAll(/(\d+(?:\.\d+)?)\s*(px|rem|em|pt)\b/gi)) {
        const px = sizeToPx(n[1], n[2]);
        if (px != null) sizes.push(px);
      }
      for (const [kw, px] of Object.entries(FONT_KEYWORD_PX)) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(value)) sizes.push(px);
      }
    } else {
      // font 简写：size 必须带单位，可跟 /line-height，如 13px/1.6
      const size = value.match(/(\d+(?:\.\d+)?)\s*(px|rem|em|pt)\b/i);
      if (size) {
        const px = sizeToPx(size[1], size[2]);
        if (px != null) sizes.push(px);
      } else {
        for (const [kw, px] of Object.entries(FONT_KEYWORD_PX)) {
          if (new RegExp(`(?:^|\\s)${kw}\\b`, 'i').test(value)) { sizes.push(px); break; }
        }
      }
    }
    if (!sizes.length) continue;
    const min = Math.min(...sizes);
    if (min < MIN_TEXT_PX) reportFont(file, text, idx, m[0].trim().slice(0, 60), min);
  }
}

function checkViewFonts(file, html) {
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    checkFontDeclarations(file, html, m.index, m.index + m[0].length);
  }
  for (const m of html.matchAll(/\bstyle\s*=\s*["']([^"']*)["']/gi)) {
    checkFontDeclarations(file, html, m.index, m.index + m[0].length);
  }
  for (const m of html.matchAll(/fontSize\s*[:=]\s*['"]?(\d+(?:\.\d+)?)(px|rem|em|pt)?['"]?/g)) {
    if (isFontExempt(html, m.index)) continue;
    const px = sizeToPx(m[1], m[2] || 'px');
    if (px != null && px < MIN_TEXT_PX) reportFont(file, html, m.index, m[0], px);
  }
}

const TAILWIND_TEXT_PX = { xs: 12 };

function checkReactFonts(file, text) {
  for (const m of text.matchAll(/fontSize\s*:\s*(?:(\d+(?:\.\d+)?)|['"](\d+(?:\.\d+)?)(px|rem|em|pt)?['"])/g)) {
    if (isFontExempt(text, m.index)) continue;
    const px = m[1] != null ? sizeToPx(m[1], 'px') : sizeToPx(m[2], m[3] || 'px');
    if (px != null && px < MIN_TEXT_PX) reportFont(file, text, m.index, m[0], px);
  }
  const classPatterns = [
    /(?:className|class)\s*[:=]\s*(?:\{\s*)?`([^`]*)`/g,
    /(?:className|class)\s*[:=]\s*(?:\{\s*)?["']([^"']*)["']/g,
  ];
  for (const pattern of classPatterns) {
    for (const m of text.matchAll(pattern)) {
      if (isFontExempt(text, m.index)) continue;
      for (const [name, px] of Object.entries(TAILWIND_TEXT_PX)) {
        if (new RegExp(`\\btext-${name}\\b`).test(m[1])) reportFont(file, text, m.index, `text-${name}`, px);
      }
      for (const t of m[1].matchAll(/\btext-\[(\d+(?:\.\d+)?)(px|rem|em|pt)\]/g)) {
        const px = sizeToPx(t[1], t[2]);
        if (px != null && px < MIN_TEXT_PX) reportFont(file, text, m.index, t[0], px);
      }
    }
  }
}

for (const f of srcFiles.filter((p) => /\.(tsx|jsx)$/.test(p))) {
  checkReactFonts(f, read(f) ?? '');
}

// ── 7b. 沙箱 HTML 视图（view，v0.7.6 双轨制 UI）─────────────────────────
// process 插件唯一的自定义 UI 通道：manifest 条目写 view: 'storage/x.html'，宿主用不透明源 iframe 渲染。
const viewPaths = new Set([
  ...(manifest?.__viewPaths ?? []),
  ...(Array.isArray(contract?.viewFiles) ? contract.viewFiles : []),
]);
const viewSlotsUsed = new Set();
for (const [slotName, entries] of Object.entries(manifest?.contributes ?? {})) {
  if (!Array.isArray(entries)) continue;
  for (const e of entries) {
    if (e && typeof e.view === 'string') { viewPaths.add(e.view); viewSlotsUsed.add(slotName); }
  }
}

const VIEW_SLOTS = new Set(REGISTRY.viewSlots ?? ['teacher.tab', 'teacher.panel', 'teacher.dashboard.widget', 'student.view', 'student.lesson.tool']);

if (contract?.uiChannel === 'sandbox-view' && viewPaths.size === 0) {
  add('error', 'VIEW_FILES_MISSING', "contract.uiChannel='sandbox-view' 但未声明任何 view 页面（contract.viewFiles / manifest 条目 view）", contractPath);
}

for (const v of viewPaths) {
  if (/^\/|\\|:\/\/|\.\.|^(javascript|data|blob):/i.test(v)) {
    add('error', 'VIEW_PATH_UNSAFE', `view 路径非法：'${v}'（宿主 sanitizeViewPath 会拒绝：禁绝对路径 / .. / 协议）`, contractPath);
    continue;
  }
  if (!v.startsWith('storage/')) {
    add('error', 'VIEW_NOT_IN_STORAGE', `view 路径必须以 storage/ 开头：'${v}'。安装器只解压 storage/**（install.ts），docs 里的 "views/index.html" 示例对 ZIP 插件是错的 → 装上去 404 / 空白面板`, contractPath);
  }
  const file = join(ROOT, v);
  if (!existsSync(file)) {
    add('error', 'VIEW_FILE_MISSING', `view 指向的文件不存在：${v}（安装后会 404 / 空白面板）`, file);
    continue;
  }
  const html = read(file) ?? '';
  if (!html.includes('/plugin-sandbox/view-bridge.js')) {
    add('error', 'VIEW_BRIDGE_MISSING', `${v} 未引入 /plugin-sandbox/view-bridge.js：页面拿不到 invokeCommand / api / toast`, file);
  }
  if (/<script[^>]+src=["']https?:/i.test(html)) {
    add('warn', 'VIEW_REMOTE_SCRIPT', `${v} 引用了远程脚本：校内离线/白名单环境可能加载失败，建议随包内置`, file);
  }
  // 不透明源 + CSP：view iframe 没有 allow-same-origin / allow-modals
  if (/(^|[^.\w])alert\s*\(|(^|[^.\w])confirm\s*\(|window\.(?:alert|confirm)\s*\(/.test(html)) {
    add('error', 'VIEW_ALERT_BLOCKED', `${v} 使用了 alert/confirm：view iframe 未授予 allow-modals，弹窗被忽略（部分浏览器直接抛错），改用页面内模态层`, file);
  }
  if (/(^|[^.\w])fetch\s*\(/.test(html)) {
    add('error', 'VIEW_DIRECT_FETCH', `${v} 直接调用了 fetch：view iframe 是不透明源，直连 /api 拿不到 cookie 且被 CSP 拦；改用 bridge.api.get/post`, file);
  }
  if (!/ui\.resize\s*\(/.test(html)) {
    add('warn', 'VIEW_RESIZE_MISSING', `${v} 没有调用 bridge.ui.resize(...)：内联槽位里容器高度可能塌陷或被裁切`, file);
  }
  if (/\bapi\.(?:get|post|del)\s*\([\s\S]{0,160}?\.result\b/.test(html)) {
    add('warn', 'VIEW_API_RESULT_UNWRAP', `${v} 对 api.* 的返回值取了 .result：bridge.api 返回的是网关裸响应体（不拆信封）；只有 invokeCommand 才返回已拆层的 result`, file);
  }
  checkViewFonts(file, html);
}
if (viewPaths.size > 0) {
  const pkg = (() => { try { return JSON.parse(read(join(ROOT, 'package.json')) ?? '{}'); } catch { return {}; } })();
  const hasPack = Object.keys(pkg.scripts ?? {}).some((k) => /pack|zip|postbuild/.test(k));
  if (!hasPack) add('warn', 'VIEW_PACK_HINT', '官方 CLI 只打 manifest.json/index.js/frontend.js：storage/** 需自写打包脚本补进 ZIP（见 references/ui-channel-decision.md §4.5.4）', join(ROOT, 'package.json'));
}
// 前端入口：宿主按 has_frontend 决定是否激活，registerManifestContributions 在 fetch 之后。
// 没有 frontend.js → 贡献（含 view）根本不注册。这是「页面永远空白」最隐蔽的根因之一。
const hasFrontendEntry = existsSync(join(ROOT, 'src', 'frontend.tsx'))
  || existsSync(join(ROOT, 'src', 'frontend.ts'))
  || existsSync(join(ROOT, 'dist', 'frontend.js'));
const needsFrontendEntry = viewPaths.size > 0
  || manifestSlots.size > 0
  || uiChannel === 'sandbox-view'
  || uiChannel === 'inline-react';
if (needsFrontendEntry && !hasFrontendEntry) {
  add(
    'warn',
    'FRONTEND_ENTRY_MISSING',
    '没有 src/frontend.tsx（也没有 dist/frontend.js）。v0.7.7 + #350 起这不是故障：'
      + '贡献注册已前移到 fetch 之前，纯声明式 / 纯 view 插件不发请求即置 ACTIVE，入口照常显示。'
      + '只有用到「插件自身命令 / 定时任务 / store 订阅」时才需要一个空导出的 frontend.tsx。',
    join(ROOT, 'src'),
  );
}

for (const slot of viewSlotsUsed) {
  if (!VIEW_SLOTS.has(slot)) {
    add('warn', 'VIEW_SLOT_UNSUPPORTED', `槽位 '${slot}' 未在 schema 中显式声明 view：可能透传但不保证长期可用，优先用 ${[...VIEW_SLOTS].join(' / ')}`, manifestPath);
  }
}

// ── 7c. api.routes ↔ ctx.http 双向配对 ──────────────────────────────────
// 网关只按 manifest 声明派发：声明了没注册 → 404；注册了没声明 → 永远调不到。
// 两侧字符串必须逐字一致（含前导斜杠），路径模式用 :param 单段匹配。
const declaredRoutes = new Map(); // 'GET /state' -> route 条目
for (const r of (manifest?.api?.routes ?? [])) {
  if (!r || typeof r.path !== 'string') continue;
  const method = String(r.method ?? '').toUpperCase();
  const path = '/' + String(r.path).replace(/^\/+/, '');
  declaredRoutes.set(`${method} ${path}`, r);
}
const registeredRoutes = new Set();
// 1) 直写：ctx.http.get('/x', h)
for (const m of scanText.matchAll(/ctx\.http\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
  registeredRoutes.add(`${m[1].toUpperCase()} ${'/' + m[2].replace(/^\/+/, '')}`);
}
// 2) 包装：const get = (p, h) => ctx.http.get(p, h) 之后 get('/x', h)
//    插件为了统一 handler 类型常这么写；只认直写会把它全判成「未注册」（假报 404）。
const httpAliases = new Map(); // 别名 -> HTTP 方法
const ALIAS_DEFS = [
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*ctx\.http\.(get|post|put|patch|delete)\b/g,
  /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^}]*ctx\.http\.(get|post|put|patch|delete)\s*\(/g,
];
for (const re of ALIAS_DEFS) {
  for (const m of scanText.matchAll(re)) httpAliases.set(m[1], m[2].toUpperCase());
}
for (const [alias, method] of httpAliases) {
  const re = new RegExp(`(?<![\\w$.])${alias}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  for (const m of scanText.matchAll(re)) {
    registeredRoutes.add(`${method} ${'/' + m[1].replace(/^\/+/, '')}`);
  }
}
if (declaredRoutes.size > 0) {
  if (registeredRoutes.size === 0) {
    add('error', 'ROUTE_NONE_REGISTERED', `manifest 声明了 ${declaredRoutes.size} 条 api.routes，但代码里没有找到任何 ctx.http.* 注册：全部路由都会 404`, manifestPath);
  }
  for (const [key, route] of declaredRoutes) {
    if (!registeredRoutes.has(key)) {
      add('error', 'ROUTE_UNREGISTERED', `manifest 声明了 ${key}，但没有同路径的 ctx.http.${key.split(' ')[0].toLowerCase()}('${key.split(' ')[1]}') 注册 → 404（路径必须逐字一致）`, manifestPath);
    }
    if (route.auth !== false && (!Array.isArray(route.roles) || route.roles.length === 0)) {
      add('warn', 'ROUTE_NO_ROLES', `${key} 未声明 roles：登录用户（含学生）都能调用；按业务补 roles 或显式 auth:false`, manifestPath);
    }
  }
  for (const key of registeredRoutes) {
    if (!declaredRoutes.has(key)) {
      add('warn', 'ROUTE_UNDECLARED', `代码注册了 ${key}，但 manifest.api.routes 没有声明：网关不会派发，这条路由永远调不到`, 'src/index.ts');
    }
  }
} else if (registeredRoutes.size > 0) {
  add('error', 'ROUTE_NOT_IN_MANIFEST', `代码注册了 ${[...registeredRoutes].join('、')}，但 manifest 没有 api.routes：ZIP 插件的 ctx.http 路由必须在 manifest 声明才会生效`, manifestPath);
}

// ── 7d. SQL 守卫预检（sql-guard.ts 是运行期硬拒绝，这里提前抓）────────────
// 只检查「字面量」表名：模板拼接 ${T().xxx} 静态无法解析，不在本规则覆盖范围内。
const SQL_LITERAL_RE = /`([^`]{20,})`|'((?:[^'\\\n]|\\.){20,})'|"((?:[^"\\\n]|\\.){20,})"/g;
const SQL_CORE_TABLES = new Set(['users', 'students', 'teachers', 'classes', 'lessons', 'whiteboard_elements', 'assignments', 'plugin_storage']);
const sqlProblems = new Set();
for (const m of scanText.matchAll(SQL_LITERAL_RE)) {
  const sql = m[1] ?? m[2] ?? m[3] ?? '';
  if (!/^\s*(SELECT|INSERT|REPLACE|UPDATE|DELETE|WITH|PRAGMA|ATTACH|DETACH|VACUUM|CREATE|ALTER|DROP)\b/i.test(sql)) continue;
  const looksSql = /\b(FROM|INTO|SET|WHERE|JOIN|VALUES|TABLE|DATABASE)\b/i.test(sql)
    || /^\s*(PRAGMA|ATTACH|DETACH|VACUUM)\b/i.test(sql)
    || /^\s*(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|VIEW|INDEX)\b/i.test(sql);
  if (!looksSql) continue;
  const brief = sql.replace(/\s+/g, ' ').slice(0, 70);
  if (/\b(?:ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(sql) || /\b(?:CREATE|DROP)\s+(?:TEMP(?:ORARY)?\s+)?(?:TRIGGER|VIEW)\b/i.test(sql)) {
    sqlProblems.add(`SQL_FORBIDDEN_OP§sql-guard 禁止 ATTACH/DETACH/PRAGMA/VACUUM/TRIGGER/VIEW：${brief}`);
  }
  if (/^\s*(?:CREATE|ALTER|DROP)\s+/i.test(sql)) {
    sqlProblems.add(`SQL_DDL_BYPASS§裸 DDL 会被拦截或绕过迁移版本：改用 ctx.db.ensureTable / ctx.db.migrate：${brief}`);
  }
  // 关键字不算表名：`ON CONFLICT ... DO UPDATE SET col = ?` 里的 SET 不是表。
  const NOT_A_TABLE = new Set([
    'set', 'values', 'select', 'where', 'from', 'join', 'into', 'update', 'or', 'and',
    'if', 'exists', 'not', 'table', 'index', 'trigger', 'view', 'database', 'conflict', 'do',
  ]);
  for (const t of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    const name = t[1];
    if (NOT_A_TABLE.has(name.toLowerCase())) continue;
    if (/^plugin_/i.test(name) || /^sqlite_/i.test(name) || name === 'plugin_migrations') continue;
    if (SQL_CORE_TABLES.has(name.toLowerCase())) {
      if (name.toLowerCase() === 'whiteboard_elements') {
        sqlProblems.add(`SQL_CORE_TABLE§SQL 直接引用了核心表 'whiteboard_elements'：sql-guard 严禁子进程直接读写白板表！向白板绘制/投射挂件请改用 whiteboard.draw 命令或 manifest.classroomTools：${brief}`);
      } else {
        sqlProblems.add(`SQL_CORE_TABLE§SQL 直接引用了核心表 '${name}'：sql-guard 黑名单会拒绝，插件侧拿不到该数据：${brief}`);
      }
    } else {
      sqlProblems.add(`SQL_TABLE_NOT_PREFIXED§SQL 引用了非插件前缀的表 '${name}'：只允许 plugin_<安装UUID>_*（自建表请用 ctx.db.table()/模板拼接）：${brief}`);
    }
  }
}
for (const entry of sqlProblems) {
  const [code, message] = entry.split('§');
  add('error', code, message, 'src/index.ts');
}

// ── 7e. 隔离模式能力门禁（ServiceHost Barrier 2）────────────────────────
// 第三方 ZIP 插件恒被改写为 process；ServiceHost.handleInvoke 在
// effectiveCapabilities 为空时只放行 get* 方法。`ctx.db.ensureTable` 在 Worker 侧
// 实际发出的是 prepareAndRun RPC —— 不以 get 开头，于是 activate() 直接被拒，
// 现象是 toggle 返回 500「no granted capability, only 'get' methods allowed」，
// 而不是某个按钮失效。唯一合法的空能力插件是「激活期零服务调用」的纯前端插件。
//
// 注意：eventBus.subscribe/unsubscribe 走独立消息通道，不受 Barrier 2 影响，故不计入。
// 声明了能力也只是「申请」—— 第三方插件还需管理员安装时勾选「确认授予」。
const inlineTrusted = mode === 'inline' && Boolean(contract?.trustedInlineAllowlistEntry);
const isolatedMode = !inlineTrusted;
if (isolatedMode && declaredCaps.length === 0) {
  // 解构 `const { commandBus, actionRegistry } = ctx.services` 后，调用点不再带 ctx 前缀
  const destructured = new Set();
  for (const m of scanText.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*ctx\.services\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) destructured.add(name);
    }
  }
  const receivers = [
    String.raw`ctx\.services\.\w+`,
    String.raw`ctx\.db`,
    String.raw`ctx\.storage`,
    ...[...destructured].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ];
  const nonGetRe = new RegExp(
    `(?:${receivers.join('|')})\\.(?:ensureTable|migrate|dropAllTables|registerHandler|unregisterHandler|createCommand|execute|register|unregister|spawn|kill|registerInterval|restore|generateText|chat|complete|publish|set|delete)\\s*\\(`,
    'g',
  );
  const hits = new Set();
  for (const m of scanText.matchAll(nonGetRe)) hits.add(m[0].replace(/[\s(]/g, ''));
  if (hits.size > 0) {
    add(
      'error',
      'CAP_EMPTY_ISOLATED',
      `未声明任何 capabilitiesProposed，但代码会调用非 get RPC（${[...hits].slice(0, 4).join('、')}）：`
        + `process/worker 下 ServiceHost Barrier 2 直接拒绝，表现为激活失败「no granted capability, only 'get' methods allowed」。`
        + `至少声明一条真实能力（如 lesson:read），并让管理员安装时勾选「确认授予」`,
      manifestPath,
    );
  } else if (/ctx\.resolve\(\s*(?:[\w.]*\.)?IDatabaseToken\s*\)/.test(scanText)) {
    // 裸 DB 的 `get/all` 仍属 get 方法（只读降级合法），但 `run/exec` 会被拒。
    // 无法可靠区分调用点 → 只提示，不阻断。
    add(
      'warn',
      'CAP_EMPTY_RAWDB',
      `未声明 capabilitiesProposed 且解析了 IDatabaseToken：只读（get/all）可放行，`
        + `但 prepare().run()/exec() 等写调用会被 ServiceHost Barrier 2 拒绝；确认只做只读查询，或声明真实能力`,
      manifestPath,
    );
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
const errors = results.filter((r) => r.level === 'error');
const warns = results.filter((r) => r.level === 'warn');

if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, errors, warns, ok: results.filter((r) => r.level === 'ok') }, null, 2));
} else {
  const icon = { ok: '✔', warn: '⚠', error: '✖' };
  const color = { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
  console.log(`\n【L0 契约静态检查】${ROOT}`);
  for (const r of results) console.log(`  ${color[r.level]}${icon[r.level]}${color.reset} [${r.code}] ${r.message}`);
  if (!results.length) console.log('  （无检查项：确认在插件项目根目录运行）');
  console.log(`\n结果：${errors.length} error，${warns.length} warn\n`);
}
process.exit(errors.length ? 1 : 0);
