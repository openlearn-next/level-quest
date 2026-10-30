# 课堂闯关（level-quest）

OpenLearnV2 第三方插件：**把「课堂闯关」作为课程环节的一种教学形态**。教师在课程编辑器中添加闯关环节、配置关卡与解锁条件；课堂上学生完成当前关卡后才能进入下一关，按学生各自推进。教师端保留实时看板与「解锁 / 代过 / 重置」干预。

- 插件 ID：`@openlearn-community/level-quest`
- 类型：full-stack（后端 HTTP 路由 + 隐藏沙箱前端桥接 + 沙箱视图页）
- 执行模式：`process`（第三方插件由平台强制）
- 目标宿主：`engines.openlearn >= 0.7.6`（`teacher.tab.view` / `editor.timeline_segment` 自 0.7.6 起支持）

## 功能

| 角色 | 能力 |
| --- | --- |
| 教师 | **课程编辑器**：在环节卡片的「教学形态」中选择「课堂闯关」，展开内嵌面板即可增删改关卡、排序并设置解锁条件；配置按课节生效 |
| 教师 | 解锁条件：**完成上一关后解锁**（默认）/ **教师放行后解锁**（学生到达时显示等待提示，看板出现「待放行」） |
| 教师 | 每节课一套关卡（1–50 关）；闯关进行中配置锁定 |
| 教师 | 「开始闯关」可沿用上一轮进度或清空后重来；「结束闯关」后学生不能再提交 |
| 教师 | 实时看板：每名学生的进度、当前关卡、本关尝试次数、最近活动；按关卡统计通过人数；待放行人数 |
| 教师 | 对单个学生「解锁」（放行教师门禁关卡）、「代过」（直接过当前关）或「重置」（回退一关 / 清空全部） |
| 教师 | 查看某学生某关的作答记录，下载作业附件 |
| 学生 | 严格顺序解锁：只有当前关卡可提交，答对/提交后自动进入下一关；答错不限次重试；被教师门禁拦住时自动提醒老师并轮询等待 |

关卡类型：

1. **答题**：单选 / 多选 / 判断 / 填空（自动判定；填空忽略空格换行、大小写不敏感）
2. **手动完成**：学生按要求完成任务后自行点击「我已完成本关」
3. **作业提交**：文字说明 + 可选/必选附件（≤1.5MB，分片上传）

学生入口是**有条件出现**的：闯关处于「进行中」时，学生随堂页面下方出现「课堂闯关」面板；未开始或已结束时该入口自动隐藏。

## 课程编辑器集成

1. 打开「备课 / 课程编辑」，选中一节课程。
2. 在时间线中新增一个环节，把「教学形态」设为 **课堂闯关**（插件注册的自定义环节类型）。
3. 选中该环节后，环节卡片底部出现「课堂闯关」面板：
   - 默认收起，显示关卡数、需教师放行的关卡数；
   - 展开后可添加关卡、编辑题目/答案、上下移动、删除；
   - 每关可设置「完成上一关后解锁」或「教师放行后解锁」；
   - 点「保存闯关配置」写回插件后端，学生端立即使用新配置。
4. 课堂上打开教师侧边栏「课堂闯关」页签 → 「开始闯关」，学生端出现入口。

> 平台限制：`editor.timeline_segment` 的沙箱视图只收到 `lessonId`，拿不到当前选中的 `segment`。因此面板**不是**“每个环节一份配置”，而是“本课节一份闯关配置”，出现在任何环节卡片里都指向同一份数据；面板顶部的提示会说明这一点。这样既保留了课程编辑器内的完整配置能力，也避免了依赖平台未开放的能力。


## 目录结构

```
level-quest/
├── manifest.json          # 插件清单（teacher.tab + editor.timeline_segment 视图 + 18 条 api 路由）
├── plugin.contract.json   # 设计契约（L0 校验 UI 通道/槽位/视图）
├── test-harness/          # L0 静态检查（零依赖，npm run test:contract）
├── src/
│   ├── index.ts           # 服务端：路由、SQL、解锁判定、上传分片、生命周期
│   └── frontend.tsx       # 隐藏沙箱前端：轮询 /state 决定学生入口显隐
├── storage/
│   ├── teacher.html       # 教师页签视图（完整关卡设计 + 实时看板）
│   ├── quest-editor.html  # 课程编辑器内嵌面板（关卡与解锁条件）
│   └── student.html       # 学生端随堂面板视图
└── scripts/
    ├── pack.mjs                   # 打包：把 storage/* 补进 ZIP（唯一交付物）
    ├── gen-manifest-export.mjs    # 从 manifest.json 生成产物里的 manifest 导出
    ├── check-runtime-bare-imports.mjs  # 产物不得残留 SDK 裸说明符
    └── check-package-contents.mjs      # 交付 ZIP 必须含 manifest 声明的视图
```

## 构建与安装

```bash
npm install
npm run build           # SDK 构建 + 打包 → 完整可安装 ZIP（含 storage/）
npm run test:contract   # L0 契约静态检查（<1s，零依赖）
npm run release         # 以上两步一次跑完（发布请统一走这条）
```

> L0 在 `dist/index.js` 存在时会检查构建产物而不是 `src/`，所以顺序必须是
> **先 build 再 test:contract**；否则会拿旧产物误报/漏报。

**交付物只有一个**：根目录的 `level-quest.zip` 与 `openlearn-plugin-level-quest.zip`
内容完全相同，都是含 `storage/` 的完整包（`npm run build` 已内置打包）。

> ⚠️ 官方 SDK 的 `openlearn-plugin-sdk build` 产出的 ZIP **不含 `storage/`**。
> 宿主安装时会 stat manifest 里声明的每个 view 文件，缺 `storage/` 的症状是
> **整包安装失败**：
>
> ```
> ENOENT: no such file or directory, stat '.../plugins/<id>/storage/teacher.html'
> ```
>
> 因此仓库里两个 ZIP 文件名都被覆盖为完整包，`scripts/check-package-contents.mjs`
> 会在发布前逐个校验。

安装后在「插件中心」激活。推荐流程（课程编辑器）：

1. 课程编辑器 → 新增环节 → 教学形态选「课堂闯关」
2. 在环节卡片内的「课堂闯关」面板中 → 添加关卡 → 设置解锁条件 → 保存
3. 课堂上教师侧边栏「课堂闯关」→「开始闯关」（上一轮有进度时会询问沿用还是清空）
4. 学生进入课堂，完成当前关卡后自动解锁下一关；需教师放行的关卡会在看板出现「待放行」
5. 「实时看板」查看进度，必要时「解锁 / 代过 / 重置」
6. 课末「结束闯关」

也可以继续在教师页签的「关卡设计」中集中编辑（与编辑器面板操作同一份数据）。

## 质量校验（L0）

`test-harness/` 是 vendored 的零依赖静态检查，发布前必跑：

```bash
npm run test:contract
```

覆盖：manifest 必填项与权限串 · **隔离模式空能力门禁（`CAP_EMPTY_ISOLATED`）** ·
`api.routes ↔ ctx.http` 双向配对 · 槽位真伪 · `view` 文件存在与桥接引用 · 裸导入 ·
process 模式禁用 API · DB 表名/分号 · 密钥泄漏；另外由
`scripts/check-reserved-routes.mjs` 检查**平台保留路由**（`config / toggle /
contributions / check-update / network-grants / sandbox-command …`）、
由 `scripts/check-runtime-bare-imports.mjs` 检查**运行期裸说明符**、
由 `scripts/check-package-contents.mjs` 检查**交付包内容**。

- 平台保留动作不能拿来当插件自己的 API 路径：网关会放行，但核心路由先匹配。
  例如插件写 `GET /config` 会被平台的插件配置接口截走 —— 登录态失效时页面直接
  显示平台原文 `Session expired or invalid`，登录正常时也只会拿到平台的配置
  schema。本插件因此把该接口命名为 `/overview`。
- 设计契约在 `plugin.contract.json`（process + sandbox-view + 教师/学生槽位），
  改 UI 通道时同步更新，否则 L0 会报 `UI_MODE_MISMATCH` / `STUDENT_ENTRY_MISSING`。
- `MANIFEST_MODE_IGNORED` 是预期提示：`manifest.executionMode` 不参与运行判定，
  实际模式由服务端按白名单计算；保留该字段只为让安装记录不显示「被强制改写」。
- 平台升级后槽位有变化时，从插件开发 skill 重抄 `test-harness/slot-registry.json`
  （`platformVersion` 字段可核对）。

### 三道「装得上 / 启得了 / 更得了」的坑（都已在插件侧解决）

平台对第三方 **process** 插件有三条会直接变成 500 的硬约束。前两条已在插件侧
规避，第三条是平台缺陷、需人工一步恢复。

| 症状 | 根因 | 插件侧做法 |
| --- | --- | --- |
| 安装报 `ENOENT … storage/teacher.html` | SDK 的 `build` 产出的 ZIP **不含 `storage/`**，宿主安装时会 stat 每个 view 文件 | `npm run build` 内置打包，两个 ZIP 文件名都产出**含 storage 的完整包**；`check-package-contents.mjs` 发布前逐个校验 |
| 「启用」报 500（`ERR_ACCESS_DENIED` / `uuid/package.json`） | 产物里 `import '@openlearn/plugin-sdk'` 是裸说明符；子进程用 Node 权限模型，白名单只放行 SDK 目录**本身**，SDK 内部的 `uuid` 依赖落在宿主 node_modules 下 → 拒绝读取 | 运行期**不做 SDK 值导入**：Token 在 `src/sdk-tokens.ts` 本地同名同版本重建；`check-runtime-bare-imports.mjs` 拦截回归 |
| 「更新」报 500（`Plugin source code has no manifest export`） | 平台的更新链路（`PluginHost.reloadPlugin → extractManifest`）从**源码**里取清单，而 SDK 只把 manifest.json 单独打进 ZIP | `scripts/gen-manifest-export.mjs` 在构建时把 manifest.json 注入产物（`src/manifest.generated.ts`），更新即可 200 |

> **更新后的一步恢复（平台缺陷，非插件问题）**：平台热重载 process 插件后，
> HTTP 派发仍指向被终止的旧子进程 → 插件接口 504
> （`ERR_IPC_CHANNEL_CLOSED`）。表现为「更新成功但插件接口超时」。
> 恢复方式：**在插件中心把插件禁用再启用一次**（或重启平台）。
> 该问题对所有带 HTTP 路由的 process 插件一致，与本插件无关。


## 数据与安全

- 所有状态存在插件自建表中（`configs / levels / progress / attempts / files / unlocks`），表名前缀由平台按安装 UUID 隔离。
- 学生身份取自登录会话（`req.actor.userId`），不接受客户端自报；学生只能提交自己的当前关卡。
- 教师接口在 manifest 中声明 `roles: ["teacher"]`，管理员按平台规则放行。
- 附件按分片 base64 入库（单文件 ≤1.5MB），下载/预览由教师端按需拉取。
- 视图页运行在 `sandbox="allow-scripts allow-forms allow-downloads"` 的不透明源 iframe，所有 API 调用经宿主桥接发起（携带会话 Cookie），页面内不使用 `alert / confirm`。

## 已知限制

- **编辑器面板是课节级而非环节级**：`editor.timeline_segment` 的沙箱视图拿不到 `segment` / `segmentType`，只拿到 `lessonId`；因此面板在任意环节卡片中都指向本课节的同一份闯关配置。若平台后续向该槽位的 `view` 透传 `segment`，可再演进为“每环节一份配置”。
- **`VIEW_SLOT_UNSUPPORTED` 是预期提示**：`editor.timeline_segment` 未列入平台 schema 的 `viewSlots`，但 `contributes` 为 passthrough 且宿主会按条目 `view` 注册沙箱视图；L0 仅告警、不阻断。
- **教师门禁关卡需要学生端在线**：学生停留在等待页时每 3 秒轮询并自动提交一次放行申请；若学生直接关闭页面，看板不会出现该生，除非其已有进度或作答记录。
- **附件不落平台 VFS**：第三方 process 插件受 SQL 守卫限制，只能访问自身表前缀，无法写入平台 VFS。附件以 `{name, mime, size, data(base64)}` 存放在插件 `files` 表，教师端通过「记录」抽屉下载。
- **看板显示学生 ID 而非姓名**：学生会话中的 `userId` 即 `students.id`，插件侧拿不到姓名字段。
- 实时性为 **3 秒轮询**（隐藏前端无事件推送通道，沙箱视图 `connect-src` 受限）。
- 单个附件上限 1.5MB（网关请求体 1MB，故采用分片上传）。
- 关卡上限 50，单次作答记录每生每关保留最近 200 条。
