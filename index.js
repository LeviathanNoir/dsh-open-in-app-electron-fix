/**
 * dsh-open-in-app-electron-fix
 *
 * 根因：打包版 dsh 宿主带着 ELECTRON_RUN_AS_NODE=1 运行（桌面版
 * desktopNodeEnvironment()，全局 dsh 命令的 dsh.cmd），而
 * @deepseek-ai/dsh-subprocess 的 scrubbedParentEnv() 只过滤
 * *KEY* / *PASSWORD* / *SECRET* / *TOKEN* 与 DSH_* 前缀，不过滤该变量。
 * open-in-app 的 launchDetachedApp() 用它构造子进程环境，导致 VS Code、
 * VS Code Insiders、Cursor、Windsurf 等 Electron 应用被以 Node 模式
 * 启动而秒退，前端收到 502 launch-failed。
 *
 * 修法：包装 WebServer 的 /open-in-app/open 启动路由 handler。请求处理
 * 期间临时从 process.env 摘掉 ELECTRON_RUN_AS_NODE——launchDetachedApp()
 * 在 handler 调用栈内同步 spawn，scrubbedParentEnv() 因此读到干净的
 * 环境；请求结束（finally）立即恢复，桌面版自身的 Electron-as-node 子进程
 * （pnpm 运行时、PTC 沙箱等）不受影响。非 Electron 应用不读该变量，同样
 * 无害。
 *
 * 为什么包装路由而不是包装 child_process.spawn：ESM 对内置模块的具名
 * 导入在 namespace 创建时固化（Node 24 实测：namespace 对象冻结不可写，
 * 且具名导出在首次 import 时快照）。插件激活时该 namespace 早已由宿主
 * 启动图创建，patch exports 对象无法影响 open-in-app 打包产物里的
 * spawn 调用，且该方法在 apply 时直接抛 TypeError。
 *
 * 顺序无关的两道拦截：
 *  1. 包装 WebServer.prototype.register——之后注册的启动路由经过包装；
 *  2. 扫描实例已注册的路由表（TS private，运行时是普通 Map 属性）——
 *     open-in-app 先激活的情形也被覆盖。
 */

export const name = 'dsh-open-in-app-electron-fix'
export const inject = ['webServer']

/** OPEN_IN_APP_OPEN_PATH（@deepseek-ai/dsh-host-open-in-app/shared.ts），与浏览器包共用的 wire 常量。 */
const OPEN_IN_APP_OPEN_PATH = '/open-in-app/open'

/** Electron 用它把任何 Electron 可执行文件切进 Node 模式。 */
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** 防重复包装标记（Symbol.for：同一宿主里多次激活也共享判断）。 */
const PATCHED = Symbol.for('dsh-open-in-app-electron-fix.patched')

/** 被包装 handler 对原 handler 的引用（还原时用）。 */
const ORIGINAL_HANDLER = Symbol.for('dsh-open-in-app-electron-fix.original-handler')

/** 本进程包装过的启动路由，dispose 时完整还原。 */
const wrappedRoutes = new Set()

/** 是否是 open-in-app 的启动路由注册项（path 相等已足够区分，icon/apps 路由路径不同）。 */
function isOpenRoute(route) {
  return route !== null && typeof route === 'object'
    && route.path === OPEN_IN_APP_OPEN_PATH
    && typeof route.handler === 'function'
}

/**
 * 就地把启动路由的 handler 换成"隐藏变量、处理完恢复"的包装。
 * register() 原样存储路由对象，原位改 handler 随存储生效；请求分发时
 * match() 返回该对象后按 route.handler 成员查找调用，同样命中包装。
 * 环境变量按键的大小写不敏感变体整体隐藏（Windows 环境变量大小写不敏感，
 * 桌面宿主的 scrub 也是以 toUpperCase 口径过滤 DSH_* 的）。
 */
function wrapRoute(route) {
  const handler = route.handler
  if (handler[PATCHED] === true) return
  const wrapped = async function (req, res) {
    const saved = Object.keys(process.env)
      .filter((key) => key.toUpperCase() === RUN_AS_NODE)
      .map((key) => [key, process.env[key]])
    for (const [key] of saved) delete process.env[key]
    try {
      return await handler.call(this, req, res)
    } finally {
      for (const [key, value] of saved) process.env[key] = value
    }
  }
  wrapped[PATCHED] = true
  wrapped[ORIGINAL_HANDLER] = handler
  route.handler = wrapped
  wrappedRoutes.add(route)
}

/** 还原一个被包装的启动路由（幂等）。 */
function unwrapRoute(route) {
  const handler = route.handler
  if (typeof handler === 'function' && handler[PATCHED] === true) {
    route.handler = handler[ORIGINAL_HANDLER]
  }
}

/**
 * 包装 WebServer 实例上已注册的启动路由（open-in-app 先于本插件激活的
 * 情形）。exact/prefixes 是 TS private，运行时为实例的普通 Map 属性，
 * 防御性读取；读不到就跳过——prototype.register 拦截已兜底。
 */
function wrapAlreadyRegistered(server) {
  for (const tableName of ['exact', 'prefixes']) {
    const table = server[tableName]
    if (!(table instanceof Map)) continue
    for (const route of table.values()) {
      if (isOpenRoute(route)) wrapRoute(route)
    }
  }
}

export function apply(ctx) {
  const server = ctx.webServer
  if (server === null || typeof server !== 'object') return
  const proto = Object.getPrototypeOf(server)
  if (proto === null || typeof proto.register !== 'function') return

  let restoreRegister = null
  if (proto[PATCHED] !== true) {
    const originalRegister = proto.register
    proto[PATCHED] = true
    proto.register = function (route) {
      if (isOpenRoute(route)) wrapRoute(route)
      return originalRegister.call(this, route)
    }
    restoreRegister = () => {
      if (proto.register !== originalRegister) proto.register = originalRegister
      delete proto[PATCHED]
    }
  }

  wrapAlreadyRegistered(server)

  const cleanup = () => {
    for (const route of wrappedRoutes) unwrapRoute(route)
    wrappedRoutes.clear()
    if (restoreRegister !== null) restoreRegister()
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup, 'dsh-open-in-app-electron-fix')
  } else if (typeof ctx.on === 'function') {
    // 老版本 cordis 无 effect 时的兜底（事件名按 cordis 惯例）
    try { ctx.on('dispose', cleanup) } catch { /* 无 dispose 事件时由页面卸载兜底 */ }
  }
}
