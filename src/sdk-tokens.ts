/**
 * 运行期 Token 的最小本地实现。
 *
 * 为什么不能直接 `import { IDatabaseToken } from '@openlearn/plugin-sdk'`：
 *
 * 1. **官方 SDK 构建把 `@openlearn/plugin-sdk` 标成 external**，产物里会原样保留
 *    `import ... from '@openlearn/plugin-sdk'` 这条裸说明符。
 * 2. 第三方 process 插件跑在**子进程**里，宿主用 Node 权限模型收敛文件访问
 *    （`--permission --allow-fs-read=...`）。白名单只放行插件目录、插件
 *    node_modules 与 SDK 目录本身；而 SDK 的 `dist/index.js` 内部还有
 *    `import { v7 as uuidv7 } from 'uuid'`，`uuid` 落在宿主的 node_modules 下、
 *    **不在白名单里** → 子进程启动即 `ERR_ACCESS_DENIED` → 插件激活失败，
 *    插件中心的「启用」按钮返回 HTTP 500。
 * 3. 平台的热重载链路（`PluginHost.reloadPlugin`）把产物交给 EsmLoader，
 *    用 `data:text/javascript;base64,` 加载 —— data: URL 没有层级基址，
 *    裸说明符一律无法解析 → 同样 ERR_MODULE_NOT_FOUND。
 *
 * 宿主解析服务、校验 provides 时都只比对 `token.name`（`di/service-registry#resolve`、
 * `plugin-host/context-builder` 的 resolve/provide），所以这里按**同名同版本**重建
 * 即可，与 SDK 导出的常量语义一致；类型声明仍然来自 @openlearn/plugin-sdk。
 *
 * 与官方插件 `@openlearn-ext/whiteboard-sticky-notes` 的 `src/sdk-tokens.ts` 同源同法。
 */

/** 与 SDK 的 Token 保持相同的公开形状，保证 ctx.resolve / ctx.provide 的结构化赋值。 */
export class Token<T> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  readonly __serviceType?: T;

  public readonly name: string;
  public readonly version: string;

  constructor(name: string, version: string = '1.0.0') {
    this.name = name;
    this.version = version;
  }
}

/** 与 SDK 的 IDatabaseToken 同名同版本。 */
export const IDatabaseToken = new Token<any>('@openlearn/core:IDatabase', '1.0.0');
