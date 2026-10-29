/**
 * 课堂闯关 —— 服务端入口（第三方 ZIP 插件，process 执行模式）。
 *
 * 身份口径：student 会话的 req.actor.userId 是 students.id；
 * 教师/管理员是 users.id。学生身份一律取自会话，不接受客户端自报。
 *
 * 存储口径：SQL 守卫只允许插件自身表前缀（plugin_<安装UUID>_*），
 * 因此关卡、进度、作答、上传文件全部存放在插件自建表中。
 */

import type { PluginApiRequest, PluginContext } from '@openlearn/plugin-sdk';
import { IDatabaseToken } from '@openlearn/plugin-sdk';

const PLUGIN_ID = '@openlearn-community/level-quest';
const MAX_LEVELS = 50;
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const CHUNK_BYTES = 384 * 1024;
const MAX_CHUNK_B64 = 600 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const MAX_UPLOAD_SESSIONS = 200;
const MAX_ATTEMPTS_KEPT = 200;
const MAX_SUBMISSION_TEXT = 20000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type LevelType = 'quiz' | 'manual' | 'submission';
type QuestionType = 'single' | 'multiple' | 'judge' | 'text';

interface UploadSession {
  id: string;
  lessonId: string;
  levelId: string;
  studentId: string;
  name: string;
  mime: string;
  size: number;
  parts: string[];
  bytes: number;
  createdAt: number;
}

interface Runtime {
  ctx: PluginContext;
  db: any;
  tables: { configs: string; levels: string; progress: string; attempts: string; files: string };
  uploads: Map<string, UploadSession>;
}

let RT: Runtime | null = null;

function runtime(): Runtime {
  if (!RT) throw new HttpError(503, '插件尚未就绪，请稍后重试');
  return RT;
}

function T(): Runtime['tables'] {
  return runtime().tables;
}

// ── 数据库（inline 同步 / process 异步代理，统一 await） ──────────────────

async function all(sql: string, params: unknown[] = []): Promise<any[]> {
  const rows = await runtime().db.prepare(sql).all(...params);
  return Array.isArray(rows) ? rows : [];
}

async function one(sql: string, params: unknown[] = []): Promise<any | null> {
  const rows = await all(sql, params);
  return rows[0] ?? null;
}

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await runtime().db.prepare(sql).run(...params);
}

async function ensureSchema(ctx: PluginContext): Promise<void> {
  await ctx.db.ensureTable(
    'configs',
    "lesson_id TEXT PRIMARY KEY, class_id TEXT, status TEXT NOT NULL DEFAULT 'idle', started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL",
  );
  await ctx.db.ensureTable(
    'levels',
    "id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', answer TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL",
  );
  await ctx.db.ensureTable(
    'progress',
    'lesson_id TEXT NOT NULL, student_id TEXT NOT NULL, level_id TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0, completed_at INTEGER NOT NULL, PRIMARY KEY (lesson_id, student_id, level_id)',
  );
  await ctx.db.ensureTable(
    'attempts',
    "id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, student_id TEXT NOT NULL, level_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '', correct INTEGER, file_id TEXT, created_at INTEGER NOT NULL",
  );
  await ctx.db.ensureTable(
    'files',
    'id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, student_id TEXT NOT NULL, level_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL',
  );
}

// ── 通用工具 ─────────────────────────────────────────────────────────────

const uuid = (): string => (globalThis.crypto as Crypto).randomUUID();

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function body(req: PluginApiRequest): Record<string, any> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
}

function q(req: PluginApiRequest, key: string): string {
  const raw = (req.query as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(raw) ? str(raw[0]) : str(raw);
}

function safeParse(raw: unknown): any {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normText(s: string): string {
  return s.replace(/[\s\u3000]+/g, '').toLowerCase();
}

function base64DecodedLength(b64: string): number {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return 0;
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  return Math.floor((clean.length * 3) / 4) - pad;
}

function requireLesson(raw: unknown): string {
  const id = str(raw).trim();
  if (!id || id.length > 120 || /\s/.test(id)) throw new HttpError(400, '缺少有效的课堂（lessonId）');
  return id;
}

function requireStudentIdValue(raw: unknown): string {
  const id = str(raw).trim();
  if (!id || id.length > 120 || /\s/.test(id)) throw new HttpError(400, '缺少有效的学生标识');
  return id;
}

function requireStaff(req: PluginApiRequest): void {
  const role = req.actor.role;
  if (role !== 'teacher' && role !== 'administrator') throw new HttpError(403, '仅教师可执行该操作');
}

function requireStudentId(req: PluginApiRequest): string {
  if (req.actor.role !== 'student') throw new HttpError(403, '仅学生账号可提交');
  const sid = str(req.actor.userId).trim();
  if (!sid) throw new HttpError(401, '未获取到学生身份，请重新登录');
  return sid;
}

// ── 关卡规范化 ───────────────────────────────────────────────────────────

function normalizeQuiz(raw: any, index: number): { config: string; answer: string } {
  const qtRaw = str(raw?.questionType) || 'single';
  if (qtRaw !== 'single' && qtRaw !== 'multiple' && qtRaw !== 'judge' && qtRaw !== 'text') {
    throw new HttpError(400, `第 ${index + 1} 关的题型无效`);
  }
  const qt = qtRaw as QuestionType;

  if (qt === 'text') {
    const answer = str(raw?.answer).trim().slice(0, 500);
    if (!answer) throw new HttpError(400, `第 ${index + 1} 关缺少参考答案`);
    return { config: JSON.stringify({ questionType: 'text', options: [] }), answer: JSON.stringify(answer) };
  }

  let options: string[];
  if (qt === 'judge') {
    options = ['对', '错'];
  } else {
    options = Array.isArray(raw?.options)
      ? raw.options.map((o: unknown) => str(o).trim().slice(0, 200)).filter((o: string) => o.length > 0)
      : [];
    if (options.length < 2) throw new HttpError(400, `第 ${index + 1} 关至少需要两个选项`);
    if (options.length > 8) throw new HttpError(400, `第 ${index + 1} 关的选项不能超过 8 个`);
  }

  const validIndex = (n: unknown): n is number =>
    Number.isInteger(n) && (n as number) >= 0 && (n as number) < options.length;

  let answer: number[];
  if (qt === 'multiple') {
    const picked = Array.isArray(raw?.answer)
      ? Array.from(new Set(raw.answer.map((n: unknown) => Number(n)).filter(validIndex))).sort((a, b) => a - b)
      : [];
    if (picked.length === 0) throw new HttpError(400, `第 ${index + 1} 关缺少正确选项`);
    answer = picked as number[];
  } else {
    const choice = Number(raw?.answer);
    if (!validIndex(choice)) throw new HttpError(400, `第 ${index + 1} 关缺少正确答案`);
    answer = [choice];
  }

  return { config: JSON.stringify({ questionType: qt, options }), answer: JSON.stringify(answer) };
}

function normalizeLevelInput(raw: any, index: number) {
  const type = raw?.type;
  if (type !== 'quiz' && type !== 'manual' && type !== 'submission') {
    throw new HttpError(400, `第 ${index + 1} 关的类型无效`);
  }
  const title = str(raw?.title).trim().slice(0, 120);
  if (!title) throw new HttpError(400, `第 ${index + 1} 关缺少标题`);
  const prompt = str(raw?.prompt).trim().slice(0, 4000);
  const id = /^[A-Za-z0-9_-]{6,64}$/.test(str(raw?.id)) ? str(raw.id) : uuid();

  if (type === 'quiz') {
    const q = normalizeQuiz(raw, index);
    return { id, type: type as LevelType, title, prompt, config: q.config, answer: q.answer };
  }
  if (type === 'submission') {
    const needFile = raw?.needFile === true;
    return {
      id,
      type: type as LevelType,
      title,
      prompt,
      config: JSON.stringify({ needFile }),
      answer: '',
    };
  }
  return { id, type: type as LevelType, title, prompt, config: '{}', answer: '' };
}

function publicLevel(row: any) {
  const cfg = safeParse(row.config) ?? {};
  const isQuiz = row.type === 'quiz';
  const qt: QuestionType | null = isQuiz ? (cfg.questionType ?? 'single') : null;
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    title: row.title,
    prompt: row.prompt,
    questionType: qt,
    options: isQuiz && qt !== 'text' && Array.isArray(cfg.options) ? cfg.options : [],
    needFile: row.type === 'submission' ? cfg.needFile === true : false,
  };
}

function denormalizeLevel(row: any) {
  const cfg = safeParse(row.config) ?? {};
  const stored = safeParse(row.answer);
  let answer: unknown = null;
  if (row.type === 'quiz') {
    if (cfg.questionType === 'text') answer = typeof stored === 'string' ? stored : '';
    else if (cfg.questionType === 'multiple') answer = Array.isArray(stored) ? stored : [];
    else answer = Array.isArray(stored) && stored.length > 0 ? stored[0] : null;
  }
  return { ...publicLevel(row), answer };
}

// ── 领域查询 ─────────────────────────────────────────────────────────────

async function getConfig(lessonId: string): Promise<any | null> {
  return one(`SELECT * FROM ${T().configs} WHERE lesson_id = ?`, [lessonId]);
}

async function loadLevels(lessonId: string): Promise<any[]> {
  return all(`SELECT * FROM ${T().levels} WHERE lesson_id = ? ORDER BY seq ASC`, [lessonId]);
}

async function completedSet(lessonId: string, studentId: string): Promise<Set<string>> {
  const rows = await all(`SELECT level_id FROM ${T().progress} WHERE lesson_id = ? AND student_id = ?`, [
    lessonId,
    studentId,
  ]);
  return new Set(rows.map((r) => String(r.level_id)));
}

async function markCompleted(lessonId: string, studentId: string, levelId: string, released = 0): Promise<void> {
  await run(
    `INSERT OR REPLACE INTO ${T().progress} (lesson_id, student_id, level_id, released, completed_at) VALUES (?, ?, ?, ?, ?)`,
    [lessonId, studentId, levelId, released, Date.now()],
  );
}

async function pruneAttempts(lessonId: string, studentId: string, levelId: string): Promise<void> {
  const rows = await all(
    `SELECT id FROM ${T().attempts} WHERE lesson_id = ? AND student_id = ? AND level_id = ? ORDER BY created_at DESC`,
    [lessonId, studentId, levelId],
  );
  if (rows.length <= MAX_ATTEMPTS_KEPT) return;
  for (const row of rows.slice(MAX_ATTEMPTS_KEPT)) {
    await run(`DELETE FROM ${T().attempts} WHERE id = ?`, [row.id]);
  }
}

async function recordAttempt(
  lessonId: string,
  studentId: string,
  levelId: string,
  kind: string,
  payload: unknown,
  correct: number | null,
  fileId: string | null,
): Promise<void> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  await run(
    `INSERT INTO ${T().attempts} (id, lesson_id, student_id, level_id, kind, payload, correct, file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), lessonId, studentId, levelId, kind, text.slice(0, MAX_SUBMISSION_TEXT), correct, fileId, Date.now()],
  );
  await pruneAttempts(lessonId, studentId, levelId);
}

async function activeContext(lessonId: string, studentId: string) {
  const cfg = await getConfig(lessonId);
  if (!cfg || cfg.status !== 'active') throw new HttpError(409, '闯关尚未开始或已结束');
  const levels = await loadLevels(lessonId);
  if (levels.length === 0) throw new HttpError(409, '本课堂尚未配置关卡');
  const done = await completedSet(lessonId, studentId);
  const current = levels.find((l) => !done.has(l.id)) ?? null;
  if (!current) throw new HttpError(409, '你已完成全部关卡');
  return { levels, done, current };
}

function nextIncompleteId(levels: any[], done: Set<string>): string | null {
  return levels.find((l) => !done.has(l.id))?.id ?? null;
}

// ── 路由 ─────────────────────────────────────────────────────────────────

type Handler = (req: PluginApiRequest) => Promise<unknown>;

function api(fn: Handler) {
  return async (req: PluginApiRequest) => {
    try {
      const result = await fn(req);
      return { status: 200, body: result };
    } catch (err: any) {
      if (err instanceof HttpError) {
        return { status: err.status, body: { success: false, error: err.message } };
      }
      try {
        runtime().ctx.log.error('[level-quest] route error:', err);
      } catch {}
      return { status: 500, body: { success: false, error: '插件内部错误，请稍后重试' } };
    }
  };
}

function registerRoutes(ctx: PluginContext): void {
  // 教师：读取整套关卡与运行状态
  ctx.http.get(
    '/config',
    api(async (req) => {
      requireStaff(req);
      const lessonId = requireLesson(q(req, 'lessonId'));
      const cfg = await getConfig(lessonId);
      const levels = await loadLevels(lessonId);
      const counted = await one(
        `SELECT COUNT(DISTINCT student_id) AS c FROM ${T().progress} WHERE lesson_id = ?`,
        [lessonId],
      );
      return {
        success: true,
        lessonId,
        status: cfg?.status ?? 'idle',
        classId: cfg?.class_id ?? null,
        startedAt: cfg?.started_at ?? null,
        endedAt: cfg?.ended_at ?? null,
        participantCount: Number(counted?.c ?? 0),
        levels: levels.map(denormalizeLevel),
      };
    }),
  );

  // 教师：保存整套关卡（进行中禁止修改）
  ctx.http.post(
    '/levels',
    api(async (req) => {
      requireStaff(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const cfg = await getConfig(lessonId);
      if (cfg?.status === 'active') throw new HttpError(409, '闯关进行中，无法修改关卡。请先结束本次闯关。');

      if (!Array.isArray(b.levels)) throw new HttpError(400, '缺少关卡列表');
      if (b.levels.length === 0) throw new HttpError(400, '至少需要一个关卡');
      if (b.levels.length > MAX_LEVELS) throw new HttpError(400, `关卡数量不能超过 ${MAX_LEVELS}`);

      const normalized = b.levels.map((raw: any, i: number) => normalizeLevelInput(raw, i));
      const keep = new Set(normalized.map((l) => l.id));
      const existing = await loadLevels(lessonId);
      const now = Date.now();

      for (const row of existing) {
        if (!keep.has(String(row.id))) await run(`DELETE FROM ${T().levels} WHERE id = ?`, [row.id]);
      }
      for (let i = 0; i < normalized.length; i++) {
        const l = normalized[i];
        await run(
          `INSERT OR REPLACE INTO ${T().levels} (id, lesson_id, seq, type, title, prompt, config, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [l.id, lessonId, i + 1, l.type, l.title, l.prompt, l.config, l.answer, now, now],
        );
      }
      // 清理指向已删除关卡的进度，避免幽灵通关
      const progressRows = await all(`SELECT level_id FROM ${T().progress} WHERE lesson_id = ?`, [lessonId]);
      for (const row of progressRows) {
        if (!keep.has(String(row.level_id))) {
          await run(`DELETE FROM ${T().progress} WHERE lesson_id = ? AND level_id = ?`, [lessonId, row.level_id]);
        }
      }
      const saved = await loadLevels(lessonId);
      return { success: true, levels: saved.map(denormalizeLevel) };
    }),
  );

  // 教师：开始闯关（沿用 / 重来）
  ctx.http.post(
    '/start',
    api(async (req) => {
      requireStaff(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const mode: 'keep' | 'reset' = b.mode === 'reset' ? 'reset' : 'keep';
      const levels = await loadLevels(lessonId);
      if (levels.length === 0) throw new HttpError(409, '尚未配置关卡，请先添加至少一个关卡');
      const cfg = await getConfig(lessonId);
      if (cfg?.status === 'active') throw new HttpError(409, '闯关已在进行中');

      const classId = str(b.classId).trim().slice(0, 120) || (cfg?.class_id ?? null);
      const now = Date.now();
      if (mode === 'reset') {
        await run(`DELETE FROM ${T().progress} WHERE lesson_id = ?`, [lessonId]);
        await run(`DELETE FROM ${T().attempts} WHERE lesson_id = ?`, [lessonId]);
        await run(`DELETE FROM ${T().files} WHERE lesson_id = ?`, [lessonId]);
      }
      if (cfg) {
        await run(
          `UPDATE ${T().configs} SET status = 'active', started_at = ?, ended_at = NULL, class_id = ?, updated_at = ? WHERE lesson_id = ?`,
          [now, classId, now, lessonId],
        );
      } else {
        await run(
          `INSERT INTO ${T().configs} (lesson_id, class_id, status, started_at, ended_at, updated_at) VALUES (?, ?, 'active', ?, NULL, ?)`,
          [lessonId, classId, now, now],
        );
      }
      return { success: true, status: 'active', mode, classId, startedAt: now };
    }),
  );

  // 教师：结束闯关
  ctx.http.post(
    '/end',
    api(async (req) => {
      requireStaff(req);
      const lessonId = requireLesson(body(req).lessonId);
      const cfg = await getConfig(lessonId);
      if (!cfg || cfg.status !== 'active') throw new HttpError(409, '当前没有进行中的闯关');
      const now = Date.now();
      await run(`UPDATE ${T().configs} SET status = 'ended', ended_at = ?, updated_at = ? WHERE lesson_id = ?`, [
        now,
        now,
        lessonId,
      ]);
      return { success: true, status: 'ended', endedAt: now };
    }),
  );

  // 教师：实时看板
  ctx.http.get(
    '/dashboard',
    api(async (req) => {
      requireStaff(req);
      const lessonId = requireLesson(q(req, 'lessonId'));
      const cfg = await getConfig(lessonId);
      const levels = await loadLevels(lessonId);

      const progressRows = await all(
        `SELECT student_id, level_id, released, completed_at FROM ${T().progress} WHERE lesson_id = ?`,
        [lessonId],
      );
      const attemptRows = await all(
        `SELECT student_id, level_id, COUNT(*) AS c FROM ${T().attempts} WHERE lesson_id = ? AND kind IN ('quiz','manual','submission') GROUP BY student_id, level_id`,
        [lessonId],
      );
      const lastRows = await all(
        `SELECT student_id, MAX(created_at) AS t FROM ${T().attempts} WHERE lesson_id = ? GROUP BY student_id`,
        [lessonId],
      );
      const fileRows = await all(`SELECT DISTINCT student_id FROM ${T().files} WHERE lesson_id = ?`, [lessonId]);

      const students = new Set<string>();
      const completed = new Map<string, Set<string>>();
      const released = new Map<string, Set<string>>();
      const attemptCounts = new Map<string, Record<string, number>>();
      const lastAt = new Map<string, number>();

      for (const r of progressRows) {
        const sid = String(r.student_id);
        students.add(sid);
        if (!completed.has(sid)) completed.set(sid, new Set());
        completed.get(sid)!.add(String(r.level_id));
        if (Number(r.released) === 1) {
          if (!released.has(sid)) released.set(sid, new Set());
          released.get(sid)!.add(String(r.level_id));
        }
      }
      for (const r of attemptRows) {
        const sid = String(r.student_id);
        students.add(sid);
        if (!attemptCounts.has(sid)) attemptCounts.set(sid, {});
        attemptCounts.get(sid)![String(r.level_id)] = Number(r.c ?? 0);
      }
      for (const r of lastRows) lastAt.set(String(r.student_id), Number(r.t ?? 0));
      for (const r of fileRows) students.add(String(r.student_id));

      const levelCompletion = new Map<string, number>();
      for (const set of completed.values()) {
        for (const id of set) levelCompletion.set(id, (levelCompletion.get(id) ?? 0) + 1);
      }

      const list = Array.from(students).map((sid) => {
        const done = completed.get(sid) ?? new Set<string>();
        const current = levels.find((l) => !done.has(l.id)) ?? null;
        return {
          id: sid,
          completed: Array.from(done),
          released: Array.from(released.get(sid) ?? []),
          completedCount: done.size,
          currentLevelId: current?.id ?? null,
          currentLevelTitle: current?.title ?? null,
          currentLevelType: current?.type ?? null,
          attemptCounts: attemptCounts.get(sid) ?? {},
          lastActivityAt: lastAt.get(sid) ?? null,
        };
      });
      list.sort((a, b) => {
        if (b.completedCount !== a.completedCount) return b.completedCount - a.completedCount;
        return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
      });

      return {
        success: true,
        status: cfg?.status ?? 'idle',
        startedAt: cfg?.started_at ?? null,
        endedAt: cfg?.ended_at ?? null,
        participantCount: students.size,
        doneCount: levels.length > 0 ? list.filter((s) => s.completedCount >= levels.length).length : 0,
        levels: levels.map((l) => ({
          id: l.id,
          seq: l.seq,
          title: l.title,
          type: l.type,
          completedCount: levelCompletion.get(l.id) ?? 0,
        })),
        students: list,
      };
    }),
  );

  // 教师：某学生某关卡的尝试记录
  ctx.http.get(
    '/attempts',
    api(async (req) => {
      requireStaff(req);
      const lessonId = requireLesson(q(req, 'lessonId'));
      const studentId = requireStudentIdValue(q(req, 'studentId'));
      const levelId = str(q(req, 'levelId')).trim();
      if (!levelId) throw new HttpError(400, '缺少关卡标识');

      const rows = await all(
        `SELECT id, kind, payload, correct, file_id, created_at FROM ${T().attempts} WHERE lesson_id = ? AND student_id = ? AND level_id = ? ORDER BY created_at DESC LIMIT 30`,
        [lessonId, studentId, levelId],
      );
      const fileMeta = new Map<string, any>();
      for (const r of rows) {
        const fid = r.file_id ? String(r.file_id) : '';
        if (!fid || fileMeta.has(fid)) continue;
        const f = await one(`SELECT id, name, mime, size FROM ${T().files} WHERE id = ?`, [fid]);
        if (f) fileMeta.set(fid, { id: f.id, name: f.name, mime: f.mime, size: f.size });
      }
      return {
        success: true,
        attempts: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          payload: r.payload,
          correct: r.correct,
          fileId: r.file_id ?? null,
          file: r.file_id ? fileMeta.get(String(r.file_id)) ?? null : null,
          createdAt: r.created_at,
        })),
      };
    }),
  );

  // 教师：放行当前关卡
  ctx.http.post(
    '/release',
    api(async (req) => {
      requireStaff(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const studentId = requireStudentIdValue(b.studentId);
      const levels = await loadLevels(lessonId);
      const done = await completedSet(lessonId, studentId);
      const current = levels.find((l) => !done.has(l.id)) ?? null;
      if (!current) throw new HttpError(409, '该学生已完成全部关卡');
      await markCompleted(lessonId, studentId, current.id, 1);
      await recordAttempt(lessonId, studentId, current.id, 'release', '', null, null);
      return { success: true, levelId: current.id, completedCount: done.size + 1 };
    }),
  );

  // 教师：重置（回退一关 / 清空进度）
  ctx.http.post(
    '/reset',
    api(async (req) => {
      requireStaff(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const studentId = requireStudentIdValue(b.studentId);
      const scope: 'all' | 'current' = b.scope === 'all' ? 'all' : 'current';
      const levels = await loadLevels(lessonId);
      const done = await completedSet(lessonId, studentId);
      if (done.size === 0) throw new HttpError(409, '该学生还没有完成任何关卡');

      let targetId: string | null = null;
      if (scope === 'all') {
        await run(`DELETE FROM ${T().progress} WHERE lesson_id = ? AND student_id = ?`, [lessonId, studentId]);
      } else {
        for (const l of levels) if (done.has(l.id)) targetId = l.id;
        if (!targetId) throw new HttpError(409, '未找到可回退的关卡');
        await run(`DELETE FROM ${T().progress} WHERE lesson_id = ? AND student_id = ? AND level_id = ?`, [
          lessonId,
          studentId,
          targetId,
        ]);
      }
      await recordAttempt(lessonId, studentId, targetId ?? levels[0]?.id ?? '', 'reset', JSON.stringify({ scope }), null, null);
      return { success: true, scope, removedLevelId: targetId };
    }),
  );

  // 学生学习/教师预览：当前状态（不含答案）
  ctx.http.get(
    '/state',
    api(async (req) => {
      const lessonId = requireLesson(q(req, 'lessonId'));
      const cfg = await getConfig(lessonId);
      const levels = await loadLevels(lessonId);
      const status = cfg?.status ?? 'idle';
      const base = {
        success: true,
        status,
        levelsCount: levels.length,
        startedAt: cfg?.started_at ?? null,
        endedAt: cfg?.ended_at ?? null,
      };

      if (req.actor.role !== 'student') {
        return { ...base, levels: levels.map(publicLevel) };
      }

      const sid = requireStudentId(req);
      const doneRows = await all(
        `SELECT level_id, released FROM ${T().progress} WHERE lesson_id = ? AND student_id = ?`,
        [lessonId, sid],
      );
      const done = new Set(doneRows.map((r) => String(r.level_id)));
      const current = levels.find((l) => !done.has(l.id)) ?? null;
      const last = current
        ? await one(
            `SELECT kind, correct, created_at FROM ${T().attempts} WHERE lesson_id = ? AND student_id = ? AND level_id = ? ORDER BY created_at DESC LIMIT 1`,
            [lessonId, sid, current.id],
          )
        : null;

      return {
        ...base,
        levels: levels.map(publicLevel),
        completed: Array.from(done),
        released: doneRows.filter((r) => Number(r.released) === 1).map((r) => String(r.level_id)),
        completedCount: done.size,
        currentLevelId: current?.id ?? null,
        lastAttempt: last ? { kind: last.kind, correct: last.correct, createdAt: last.created_at } : null,
      };
    }),
  );

  // 学生：客观题作答
  ctx.http.post(
    '/answer',
    api(async (req) => {
      const sid = requireStudentId(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const levelId = str(b.levelId).trim();
      const c = await activeContext(lessonId, sid);
      if (!levelId || levelId !== c.current.id) throw new HttpError(409, '只能提交当前关卡');
      const level = c.current;
      if (level.type !== 'quiz') throw new HttpError(400, '当前关卡不是答题关卡');

      const cfg = safeParse(level.config) ?? {};
      const qt: QuestionType = cfg.questionType ?? 'single';
      const options: string[] = Array.isArray(cfg.options) ? cfg.options : [];
      const stored = safeParse(level.answer);

      let payload: Record<string, unknown> = {};
      let correct = false;

      if (qt === 'multiple') {
        const choices = Array.isArray(b.choices)
          ? Array.from(
              new Set(
                b.choices
                  .map((n: unknown) => Number(n))
                  .filter((n: number) => Number.isInteger(n) && n >= 0 && n < options.length),
              ),
            ).sort((a, b2) => a - b2)
          : [];
        if (choices.length === 0) throw new HttpError(400, '请至少选择一项');
        const expected = Array.isArray(stored) ? [...stored].sort((a, b2) => a - b2) : [];
        correct = choices.length === expected.length && choices.every((v, i) => v === expected[i]);
        payload = { choices };
      } else if (qt === 'text') {
        const text = str(b.text).trim().slice(0, 500);
        if (!text) throw new HttpError(400, '请填写答案');
        const expected = typeof stored === 'string' ? stored : '';
        correct = expected !== '' && normText(text) === normText(expected);
        payload = { text };
      } else {
        const choice = Number(b.choice);
        if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) {
          throw new HttpError(400, '请选择一个有效选项');
        }
        const expected = Array.isArray(stored) ? Number(stored[0]) : -1;
        correct = choice === expected;
        payload = { choice };
      }

      await recordAttempt(lessonId, sid, level.id, 'quiz', payload, correct ? 1 : 0, null);
      if (!correct) return { success: true, correct: false, completed: false, nextLevelId: null };

      await markCompleted(lessonId, sid, level.id);
      const done = new Set([...c.done, level.id]);
      return { success: true, correct: true, completed: true, nextLevelId: nextIncompleteId(c.levels, done) };
    }),
  );

  // 学生：手动完成
  ctx.http.post(
    '/self-report',
    api(async (req) => {
      const sid = requireStudentId(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const levelId = str(b.levelId).trim();
      const c = await activeContext(lessonId, sid);
      if (!levelId || levelId !== c.current.id) throw new HttpError(409, '只能提交当前关卡');
      if (c.current.type !== 'manual') throw new HttpError(400, '当前关卡不是手动完成关卡');

      await recordAttempt(lessonId, sid, c.current.id, 'manual', '', 1, null);
      await markCompleted(lessonId, sid, c.current.id);
      const done = new Set([...c.done, c.current.id]);
      return { success: true, completed: true, nextLevelId: nextIncompleteId(c.levels, done) };
    }),
  );

  // 学生：作业提交（文本 + 可选文件）
  ctx.http.post(
    '/submission',
    api(async (req) => {
      const sid = requireStudentId(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const levelId = str(b.levelId).trim();
      const c = await activeContext(lessonId, sid);
      if (!levelId || levelId !== c.current.id) throw new HttpError(409, '只能提交当前关卡');
      const level = c.current;
      if (level.type !== 'submission') throw new HttpError(400, '当前关卡不是作业提交关卡');

      const cfg = safeParse(level.config) ?? {};
      const text = str(b.text).trim().slice(0, MAX_SUBMISSION_TEXT);
      const fileId = str(b.fileId).trim();
      if (cfg.needFile === true && !fileId) throw new HttpError(400, '本关需要上传文件');
      if (!text && !fileId) throw new HttpError(400, '请填写内容或上传文件');

      let fileMeta: { name: string; size: number; mime: string } | null = null;
      if (fileId) {
        const file = await one(
          `SELECT id, name, mime, size FROM ${T().files} WHERE id = ? AND lesson_id = ? AND student_id = ? AND level_id = ?`,
          [fileId, lessonId, sid, level.id],
        );
        if (!file) throw new HttpError(400, '附件不存在或不属于当前关卡');
        fileMeta = { name: file.name, size: Number(file.size), mime: file.mime };
      }

      await recordAttempt(
        lessonId,
        sid,
        level.id,
        'submission',
        JSON.stringify({ text, fileName: fileMeta?.name ?? null, fileSize: fileMeta?.size ?? null }),
        1,
        fileId || null,
      );
      await markCompleted(lessonId, sid, level.id);
      const done = new Set([...c.done, level.id]);
      return { success: true, completed: true, nextLevelId: nextIncompleteId(c.levels, done) };
    }),
  );

  // 学生：分片上传（初始化）
  ctx.http.post(
    '/upload/init',
    api(async (req) => {
      const sid = requireStudentId(req);
      const b = body(req);
      const lessonId = requireLesson(b.lessonId);
      const levelId = str(b.levelId).trim();
      const c = await activeContext(lessonId, sid);
      if (!levelId || levelId !== c.current.id) throw new HttpError(409, '只能为当前关卡上传文件');
      if (c.current.type !== 'submission') throw new HttpError(400, '当前关卡不需要上传文件');

      const size = Number(b.size);
      if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, '文件大小无效');
      if (size > MAX_FILE_BYTES) throw new HttpError(413, '文件不能超过 1.5MB');
      const name = str(b.name).trim().slice(0, 200) || 'file.bin';
      const mime = str(b.mime).trim().slice(0, 120) || 'application/octet-stream';

      const uploads = runtime().uploads;
      const now = Date.now();
      for (const [key, session] of uploads) {
        if (now - session.createdAt > UPLOAD_TTL_MS) uploads.delete(key);
      }
      if (uploads.size >= MAX_UPLOAD_SESSIONS) {
        const oldest = Array.from(uploads.values()).sort((a, b2) => a.createdAt - b2.createdAt)[0];
        if (oldest) uploads.delete(oldest.id);
      }

      const id = uuid();
      uploads.set(id, {
        id,
        lessonId,
        levelId,
        studentId: sid,
        name,
        mime,
        size,
        parts: [],
        bytes: 0,
        createdAt: now,
      });
      return { success: true, uploadId: id, chunkBytes: CHUNK_BYTES };
    }),
  );

  // 学生：分片上传（数据块）
  ctx.http.post(
    '/upload/chunk',
    api(async (req) => {
      const sid = requireStudentId(req);
      const b = body(req);
      const session = runtime().uploads.get(str(b.uploadId));
      if (!session || session.studentId !== sid) throw new HttpError(404, '上传会话不存在或已过期');
      const data = str(b.data);
      if (!data) throw new HttpError(400, '数据块为空');
      if (data.length > MAX_CHUNK_B64) throw new HttpError(413, '数据块过大');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, '数据块不是有效的 base64');

      const add = base64DecodedLength(data);
      if (session.bytes + add > MAX_FILE_BYTES) throw new HttpError(413, '文件不能超过 1.5MB');
      session.parts.push(data);
      session.bytes += add;
      return { success: true, received: session.bytes, total: session.size };
    }),
  );

  // 学生：分片上传（收尾落库）
  ctx.http.post(
    '/upload/finish',
    api(async (req) => {
      const sid = requireStudentId(req);
      const uploadId = str(body(req).uploadId);
      const session = runtime().uploads.get(uploadId);
      if (!session || session.studentId !== sid) throw new HttpError(404, '上传会话不存在或已过期');
      if (session.bytes === 0) throw new HttpError(400, '尚未上传任何数据');

      const data = session.parts.join('');
      const fileId = uuid();
      runtime().uploads.delete(uploadId);
      await run(
        `INSERT OR REPLACE INTO ${T().files} (id, lesson_id, student_id, level_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fileId, session.lessonId, sid, session.levelId, session.name, session.mime, session.bytes, data, Date.now()],
      );
      return { success: true, fileId, name: session.name, size: session.bytes };
    }),
  );

  // 附件下载（教师看全部；学生只看自己的）
  ctx.http.get(
    '/file/:id',
    api(async (req) => {
      const id = str(req.params.id).trim();
      if (!id) throw new HttpError(400, '缺少附件标识');
      const row = await one(`SELECT * FROM ${T().files} WHERE id = ?`, [id]);
      if (!row) throw new HttpError(404, '附件不存在或已清理');
      const role = req.actor.role;
      if (role === 'student') {
        if (String(row.student_id) !== String(req.actor.userId)) throw new HttpError(403, '无权查看他人的附件');
      } else if (role !== 'teacher' && role !== 'administrator') {
        throw new HttpError(403, '无权查看附件');
      }
      return { success: true, id: row.id, name: row.name, mime: row.mime, size: row.size, data: row.data };
    }),
  );
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

async function activate(ctx: PluginContext): Promise<void> {
  await ensureSchema(ctx);
  const db = await ctx.resolve(IDatabaseToken);
  RT = {
    ctx,
    db,
    tables: {
      configs: ctx.db.table('configs'),
      levels: ctx.db.table('levels'),
      progress: ctx.db.table('progress'),
      attempts: ctx.db.table('attempts'),
      files: ctx.db.table('files'),
    },
    uploads: new Map(),
  };
  registerRoutes(ctx);
  ctx.log.info(`[${PLUGIN_ID}] 已激活（每节课一套关卡，按学生各自推进）`);
}

async function deactivate(): Promise<void> {
  if (RT) RT.uploads.clear();
  RT = null;
}

export default { activate, deactivate };
