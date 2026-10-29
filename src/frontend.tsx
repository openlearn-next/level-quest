/**
 * 课堂闯关 —— 前端入口（隐藏沙箱 iframe，无 React / DOM）。
 *
 * 职责单一：轮询后端 /state，闯关处于 active 时在学生端随堂工具箱挂载
 * storage/student.html；否则把同 (slot,id) 条目改写为空 slotProps 使其隐藏
 * （隐藏前端无 unregister 桥，重新注册同 id 即为覆盖）。
 */

interface SandboxFrontendContext {
  pluginId: string;
  services: {
    frontendApi: {
      get<T = unknown>(path: string): Promise<{ success: boolean; result?: T; error?: string }>;
    };
  };
  ui: {
    registerExtensionPoint(slot: string, config: Record<string, unknown>): Promise<boolean>;
    showToast(message: string): Promise<boolean>;
  };
  context: {
    get(): Promise<{ lessonId: string | null; classId: string | null }>;
  };
}

const SLOT = 'student.lesson.toolbox';
const ENTRY_ID = 'lvq-game';
const POLL_MS = 3000;

let ctx: SandboxFrontendContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let lastKey = '';
let lastVisible: boolean | null = null;

async function applyVisibility(visible: boolean): Promise<void> {
  if (!ctx) return;
  if (lastVisible === visible) return;
  lastVisible = visible;
  try {
    await ctx.ui.registerExtensionPoint(SLOT, {
      id: ENTRY_ID,
      label: '课堂闯关',
      icon: 'Swords',
      slotProps: visible ? { view: 'storage/student.html' } : {},
    });
  } catch (err) {
    lastVisible = null;
    console.warn('[level-quest] 注册随堂工具箱失败', err);
  }
}

async function tick(): Promise<void> {
  if (!ctx || ticking) return;
  ticking = true;
  try {
    const info = await ctx.context.get();
    const lessonId = info?.lessonId ?? '';

    if (!lessonId) {
      await applyVisibility(false);
      lastKey = '';
      return;
    }

    let visible = false;
    try {
      const res: any = await ctx.services.frontendApi.get(
        `/api/plugins/${encodeURIComponent(ctx.pluginId)}/state?lessonId=${encodeURIComponent(lessonId)}`,
      );
      if (!res || res.success === false || typeof res.status !== 'string') return; // 请求失败时保持现状
      visible = res.status === 'active';
    } catch {
      return;
    }

    const key = `${lessonId}:${visible}`;
    if (key === lastKey) {
      if (lastVisible !== visible) await applyVisibility(visible);
      return;
    }
    lastKey = key;
    await applyVisibility(visible);
  } finally {
    ticking = false;
  }
}

async function activate(hostCtx: SandboxFrontendContext): Promise<void> {
  ctx = hostCtx;
  lastKey = '';
  lastVisible = null;
  void tick();
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
}

async function deactivate(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  ctx = null;
  lastKey = '';
  lastVisible = null;
}

export default { activate, deactivate };
