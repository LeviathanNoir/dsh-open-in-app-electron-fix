/**
 * 冒烟测试：在 deepseek-harness 源码仓库真实构建出的 WebServer 类上验证
 * 本插件的包装机制。仅开发期使用，不随包分发。
 *
 * 用法：node scripts/smoke.mjs [DSH_REPO 路径]
 * 默认仓库路径：C:/node-leviathan/deepseek-harness-dsh-v0.2.1-rc.3
 * （需要该仓库已 pnpm install 且 webserver 包已构建出 lib/）
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const repo = process.argv[2] ?? process.env.DSH_REPO ?? 'C:/node-leviathan/deepseek-harness-dsh-v0.2.1-rc.3'
const webserverEntry = join(repo, 'packages/host/webserver/lib/index.js')
const { WebServer: WebServerNamed } = await import(pathToFileURL(webserverEntry).href)
const mod = await import(pathToFileURL(webserverEntry).href)
const WebServer = WebServerNamed ?? mod.default
if (typeof WebServer !== 'function') throw new Error(`无法从 ${webserverEntry} 取得 WebServer 类`)

const plugin = await import('../index.js')

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (期望 ${String(expected)}，实得 ${String(actual)})`}`)
}

// 模拟打包版宿主：进程带着泄漏的变量运行
process.env.ELECTRON_RUN_AS_NODE = '1'

// 实例化 WebServer 但不走 Service 生命周期（只用 register/match 路由表语义）
function newServer() {
  const config = { host: '127.0.0.1', port: 0 }
  try {
    return new WebServer({}, config)
  } catch {
    const server = Object.create(WebServer.prototype)
    server.exact = new Map()
    server.prefixes = new Map()
    server.upgrades = new Map()
    return server
  }
}

function pluginCtx(server) {
  const disposers = []
  const ctx = {
    webServer: server,
    effect: (fn) => { const d = fn(); disposers.push(d); return d },
  }
  return { ctx, dispose: () => { for (const d of disposers.splice(0)) if (typeof d === 'function') d() } }
}

// 与 launchDetachedApp 相同的关键事实：handler 调用栈内同步读取 process.env 构造子进程环境
function openHandler(record) {
  return async (req, res) => {
    record.envAtLaunch = process.env.ELECTRON_RUN_AS_NODE ?? null
    record.returned = 200
    res.statusCode = 200
    return 200
  }
}

function dispatch(server, path, req, res) {
  const route = server.match(path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  return route.handler(req, res)
}

// ---- 契约 ----
check('导出 name', plugin.name, 'dsh-open-in-app-electron-fix')
check('导出 inject', JSON.stringify(plugin.inject), JSON.stringify(['webServer']))
check('导出 apply 为函数', typeof plugin.apply, 'function')

// ---- 用例 A：open-in-app 先注册，本插件后激活（扫描已注册路由） ----
{
  const server = newServer()
  const record = {}
  server.register({ kind: 'exact', path: '/open-in-app/open', handler: openHandler(record) })
  const { ctx, dispose } = pluginCtx(server)
  plugin.apply(ctx)
  const res = {}
  const returned = await dispatch(server, '/open-in-app/open', {}, res)
  check('A 启动时环境变量已隐藏', record.envAtLaunch, null)
  check('A 返回值透传', returned, 200)
  check('A 请求结束后变量已恢复', process.env.ELECTRON_RUN_AS_NODE, '1')
  dispose()
}

// ---- 用例 B：本插件先激活，open-in-app 后注册（prototype.register 拦截） ----
{
  const server = newServer()
  const { ctx, dispose } = pluginCtx(server)
  plugin.apply(ctx)
  const record = {}
  server.register({ kind: 'exact', path: '/open-in-app/open', handler: openHandler(record) })
  await dispatch(server, '/open-in-app/open', {}, {})
  check('B 启动时环境变量已隐藏', record.envAtLaunch, null)
  check('B 请求结束后变量已恢复', process.env.ELECTRON_RUN_AS_NODE, '1')

  // ---- 用例 D：非启动路由不受影响 ----
  const other = {}
  server.register({ kind: 'exact', path: '/open-in-app/apps', handler: async () => { other.envSeen = process.env.ELECTRON_RUN_AS_NODE ?? null } })
  await dispatch(server, '/open-in-app/apps', {}, {})
  check('D 非启动路由变量原样保留', other.envSeen, '1')

  // ---- 用例 C1：dispose 后，已注册路由被还原 ----
  dispose()
  const record2 = {}
  server.exact.get('/open-in-app/open').handler = openHandler(record2)
  await dispatch(server, '/open-in-app/open', {}, {})
  check('C1 dispose 后既有路由不再包装', record2.envAtLaunch, '1')
}

// ---- 用例 C2：dispose 后，prototype.register 不再包装新注册 ----
{
  const server = newServer()
  const record = {}
  server.register({ kind: 'exact', path: '/open-in-app/open', handler: openHandler(record) })
  await dispatch(server, '/open-in-app/open', {}, {})
  check('C2 插件还原后新注册路由不再包装', record.envAtLaunch, '1')
}

// ---- 用例 E：并发请求下嵌套删除/恢复正确 ----
{
  const server = newServer()
  const { ctx, dispose } = pluginCtx(server)
  plugin.apply(ctx)
  const seen = []
  const gate = []
  server.register({
    kind: 'exact', path: '/open-in-app/open',
    handler: async () => {
      seen.push(process.env.ELECTRON_RUN_AS_NODE ?? null)
      await new Promise((resolve) => gate.push(resolve))
      seen.push(process.env.ELECTRON_RUN_AS_NODE ?? null)
    },
  })
  const p1 = dispatch(server, '/open-in-app/open', {}, {})
  const p2 = dispatch(server, '/open-in-app/open', {}, {})
  gate.forEach((resolve) => resolve())
  await Promise.all([p1, p2])
  check('E 并发两次启动均看到干净环境', seen.filter((v) => v === null).length, 4)
  check('E 并发结束后变量恢复', process.env.ELECTRON_RUN_AS_NODE, '1')
  dispose()
}

// ---- 用例 F：adapter 显式 env 不受插件影响（github-desktop 场景） ----
// resolver.ts:584 的 github-desktop 用显式 env: { ELECTRON_RUN_AS_NODE: '1' }
// 把 GitHubDesktop.exe 切进 Node 模式跑 cli.js；该显式条目在 scrub 之后
// overlay，插件只清 process.env 继承层，不得触碰它。
{
  const { ctx, dispose } = pluginCtx(newServer())
  plugin.apply(ctx)

  // F1 对照（普通应用）：继承层即最终环境，必须已剔除
  const inherited = {}
  const server1 = newServer()
  server1.register({
    kind: 'exact', path: '/open-in-app/open',
    handler: async () => { Object.assign(inherited, process.env) },
  })
  await dispatch(server1, '/open-in-app/open', {}, {})
  check('F1 普通应用继承层已剔除', inherited.ELECTRON_RUN_AS_NODE, undefined)

  // F2 github-desktop 场景：显式条目在 scrub 之后 overlay，必须原样透传
  const childEnv = {}
  const server2 = newServer()
  server2.register({
    kind: 'exact', path: '/open-in-app/open',
    handler: async () => {
      const scrubbed = { ...process.env }   // 模拟 scrubbedParentEnv() 现场取值
      Object.assign(childEnv, scrubbed, { ELECTRON_RUN_AS_NODE: '1' })  // 模拟 { ...scrubbed, ...options.env }
    },
  })
  await dispatch(server2, '/open-in-app/open', {}, {})
  check('F2 adapter 显式条目原样透传', childEnv.ELECTRON_RUN_AS_NODE, '1')
  check('F 请求结束后宿主变量恢复', process.env.ELECTRON_RUN_AS_NODE, '1')
  dispose()
}

delete process.env.ELECTRON_RUN_AS_NODE
if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
