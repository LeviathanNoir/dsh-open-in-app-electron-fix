# 开发日志：dsh-open-in-app-electron-fix

- 日期：2026-10-25
- 目标版本：DeepSeek Harness 0.2.1-rc.3（桌面版与全局 `dsh web` 同受影响）
- 参考规范：《DSH 独立插件工程规范与流程》（dsh-standalone-plugin-guide.md）、《DSH 打不开 VS Code：根因排查与修复插件开发指南》（dsh-vscode-fix-plugin-guide.md）

---

## 1. 任务

把"修复 DSH 打包版打不开 VS Code 等 Electron 应用"的 DSH 插件写成完全独立的工程，落在本目录，支持 `dsh plugin add` 的四种安装方式。

## 2. 根因分析（对照 harness 源码确认的证据链）

1. 打包版宿主带着 `ELECTRON_RUN_AS_NODE=1` 运行：
   - 全局命令：`apps/desktop/cli/dsh.cmd:3`（`set "ELECTRON_RUN_AS_NODE=1"`）；
   - 桌面版：`apps/desktop/src/node-environment.ts:15`（`desktopNodeEnvironment()` 显式设置）。
   - 本地源码版跑在普通 `node.exe` 上，无此变量，所以只有打包版复现。
2. open-in-app 启动应用时用 `scrubbedParentEnv()` 构造子进程环境（`packages/host/open-in-app/src/resolver.ts:74-80`），该函数只过滤 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 前缀（`packages/subprocess/subprocess/src/index.ts:47,66`），`ELECTRON_RUN_AS_NODE` 漏网，泄漏给被启动的 Code.exe。
3. Electron 可执行文件见到该变量进入 Node 模式：`ELECTRON_RUN_AS_NODE=1 Code.exe "C:\dir"` 秒退（`Error: Cannot find module`），宿主观察窗内非零退出 → open 路由返回 502 `launch-failed`。
4. 受影响应用即 catalog（`packages/host/open-in-app/src/catalog.ts`）中的 Electron GUI 应用：Code.exe、Code - Insiders.exe、Cursor.exe、Windsurf.exe；explorer.exe / JetBrains 不受影响。
5. 佐证：`apps/desktop/scripts/test-local-updater.mjs:14` 与 `test-signed-updates.mjs:20` 的 env 过滤正则已含 `^ELECTRON_RUN_AS_NODE$`，打包链路知道要剥这个变量，只是通用 scrub 漏了——上游一行修复即可根治。

## 3. 方案演进：指南原方案被实测证伪，更换实现

### 3.1 指南方案：包装 `child_process.spawn`

指南称"Node 对内置模块的 ESM 命名导入是 live 的，运行时 patch `cp.spawn` 对后续所有调用方生效"。本机 Node 24.20.0 实测证伪（实验脚本见会话记录）：

- `import * as cp from 'node:child_process'; cp.spawn = …` **直接抛 TypeError**（`Cannot assign to read only property 'spawn' of object '[object Module]'`）——namespace 对象冻结，指南代码在插件激活时就会崩；
- 改 `cp.default.spawn` 可以赋值（`cp.default === require('node:child_process')` 为 true），但 ESM 具名导出在 **namespace 创建时快照固化**：先 import 再 patch，`require` 消费方可见 patch，而 namespace getter 与另一模块的静态具名 import 均仍见原函数。

结论：DSH 宿主启动图必定在任何插件 apply 之前创建过 `node:child_process` 的 namespace，open-in-app 打包产物里的 `import { spawn }` 拿到的永远是原函数，**该方案确定无法生效**。

### 3.2 最终方案：包装 `/open-in-app/open` 路由 handler

依据源码确认的三个事实：

1. `launchDetachedApp()` 在**请求 handler 的调用栈内同步 spawn**（Promise executor 首语句），环境来自 `scrubbedParentEnv()` 现场读取的 `process.env`；
2. WebServer 分发时 `match()` 返回路由对象后按 `route.handler` **成员查找**调用（`packages/host/webserver/src/index.ts:543`）——对存储对象的 handler 做原位替换可以生效；
3. 插件激活顺序不可控（bundle 注释明确"行序无加载语义"）。

因此做两道顺序无关的拦截：

- 包装 `WebServer.prototype.register`：本插件先激活时，之后注册的启动路由经过包装；
- 扫描实例已注册路由表（TS `private`，运行时是普通 `Map` 属性，防御性读取）原位换 handler：open-in-app 先激活时也被覆盖。

包装逻辑：请求处理期间把 `process.env` 中 `ELECTRON_RUN_AS_NODE`（含大小写变体）临时删除，`finally` 中按保存值恢复。启动 spawn 因此读到干净环境；桌面版自身的 Electron-as-node 子进程（pnpm 运行时、PTC 沙箱）不在这个请求窗口内启动，不受影响；非 Electron 应用不读该变量，同样无害。这比"按 exe 名单过滤"更通用——未来 catalog 新增任何 Electron 应用自动被覆盖。

## 4. 工程结构（对照独立插件规范）

```
dsh-open-in-app-electron-fix/
├── package.json         # main=免构建纯 JS；files 白名单；dsh.bundle.patch；compatibility
├── cordis.patch.yml     # 注入声明；不禁用官方 open-in-app，共存
├── index.js             # host 插件：name / inject / apply（无 Config，零配置）
├── scripts/smoke.mjs    # 开发期冒烟测试（不进包）
├── .gitignore
└── DEVLOG.md            # 本文件
```

与 whale 示例的差异说明：本插件纯 host、无 client 入口（无 `exports["./client"]`、无 `dsh.client`），`@deepseek-ai/*` 零依赖（连 peer 都不需要），无构建步骤。

## 5. 代码 Review 记录

交付前对 `index.js` 做了一轮 review，发现 3 个问题并已修复：

1. **环境变量大小写漏洞**：原实现用 `hasOwnProperty('ELECTRON_RUN_AS_NODE')` 判断是否存在，大小写敏感，与 Windows 环境变量语义不符。改为收集所有 `toUpperCase() === 'ELECTRON_RUN_AS_NODE'` 的键统一删除/恢复。
2. **`isOpenRoute` 过度约束**：原实现要求 `kind === 'exact'`，path 相等已足够区分（icon/apps 路由路径不同），上游若改注册方式会静默漏拦，已放宽。
3. **`ctx.effect` 无兜底**：vendored cordis 有 `effect`，仍补了 `ctx.on('dispose')` 回退，兼容老版本。

另清理 `scripts/smoke.mjs` 的两个未使用 import。

**已知限制（接受，不处理）**：同一进程内两个 cordis context 同时激活本插件时，一个 context 的 dispose 会解包另一个 context 包装过的路由（模块级 `wrappedRoutes` 与原型恢复未做引用计数）。DSH 实际形态是一进程一 profile，风险可忽略。

## 6. 验证

### 6.1 冒烟测试（scripts/smoke.mjs）

直接引用 harness 仓库**真实构建出的** `packages/host/webserver/lib/index.js` 的 `WebServer` 类，13 项断言全部通过：

- 契约：`name` / `inject` / `apply` 三件套导出正确；
- 用例 A（open-in-app 先注册，本插件后激活 → 扫表路径）：启动时变量已隐藏、返回值透传、结束后恢复；
- 用例 B（本插件先激活，后注册 → 原型拦截路径）：同上；
- 用例 D：非启动路由（`/open-in-app/apps`）变量原样保留；
- 用例 C1/C2：dispose 后既有路由解包、原型恢复后新注册不再包装；
- 用例 E：并发两个启动请求，嵌套删除/恢复正确，均看到干净环境。

运行方式：`node scripts/smoke.mjs [harness 仓库路径]`（默认 `C:/node-leviathan/deepseek-harness-dsh-v0.2.1-rc.3`，需已 `pnpm install` 且 webserver 包已构建）。

### 6.2 打包验证

```
node --check index.js        # 通过
npm pack                     # 产出 dsh-open-in-app-electron-fix-0.1.0.tgz
tar -tzf …tgz                # 仅 package/package.json、package/index.js、package/cordis.patch.yml
```

## 7. 安装与人工验证

```sh
# 开发调试（链接引入，改代码后需重新 dsh web）
dsh plugin --profile web add ./dsh-open-in-app-electron-fix
dsh plugin --profile desktop add ./dsh-open-in-app-electron-fix

# 分发（tarball / npm / git 四选一，参考独立插件规范 §3）
dsh plugin --profile web add ./dsh-open-in-app-electron-fix-0.1.0.tgz
```

重启 `dsh web` 或桌面版后，会话页右上角 VS Code 按钮应能正常打开工作区。环境 sanity check：`ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" --version` 输出 Node 版本即证明变量机制未变、本插件逻辑前提成立。

## 8. 上游社区讨论核验（2026-10-26）

社区在 [deepseek-harness/discussions/8455](https://github.com/deepseek-ai/deepseek-harness/discussions/8455) 提交了同一根因的上游修复提案（分支 `fix/open-in-app-electron-run-as-node`，3 文件 +31/-9）。逐条对照本仓库 v0.2.1-rc.3 源码核验：

| 讨论的论点 | 核验结论 |
|---|---|
| 根因是 `ELECTRON_RUN_AS_NODE` 经 `scrubbedParentEnv()` 泄漏给被启动的 Electron 应用 | ✅ 正确，与本插件日志 §2 的证据链一致 |
| 最小修复：在 `launchDetachedApp` 内、显式 env overlay 之前 `delete parentEnv.ELECTRON_RUN_AS_NODE` | ✅ 正确且最小；与本插件预期的"退役条件"同款 |
| github-desktop 是唯一显式声明该标志的 catalog 应用（`resolver.ts:584`，用它跑 `GitHubDesktop.exe resources/app/cli.js open`） | ✅ 已核实，全 src 仅这一处显式声明 |
| PTC 运行时本就对子进程主动删除该标志（仅 bootstrap 启动瞬间保留） | ✅ 已核实（`ptc-runtime-node/lib/index.js:1152,1616`，且用大小写不敏感比较） |
| **"web 版宿主是原生 node、环境里没有这个变量，所以只有桌面版受影响"** | ❌ **以偏概全**：本地源码版 `dsh web` 才是原生 node；**全局安装的 `dsh` 命令**走 `apps/desktop/cli/dsh.cmd:3`，显式 `set "ELECTRON_RUN_AS_NODE=1"` 后启动 `DeepSeek Harness.exe`，同样携带该变量——这正是全局 `dsh web` 也打不开 VS Code 的原因，本插件的 web/desktop 双 profile 安装步骤即为此而设 |

补充一点：讨论者的修复用精确大小写 `delete parentEnv.ELECTRON_RUN_AS_NODE`，实践中够用（宿主自身设置的键就是大写，且 Windows 上 Node 会把 `process.env` 的键规范为大写）；本插件从第一天起就按键的大小写不敏感变体整体隐藏（§5 review 第 1 条），口径与 PTC 运行时的做法一致。

**对本插件的影响评估（是否需要迭代）：**

- **github-desktop 反向用例**：该应用故意以 Node 模式启动自身 CLI，依赖 adapter 显式 env（在 scrub 之后 overlay）。本插件只清理 `process.env` 继承层，不触碰 overlay 层，显式 `'1'` 原样透传——兼容。已在冒烟测试新增用例 F1/F2 锁定该行为（F1 普通应用继承层剔除；F2 显式条目透传）。
- **上游修复若按讨论落地**：`launchDetachedApp` 内剔除后，本插件的清理变为近似 no-op，finally 恢复同样无害——**前后兼容，无需卸载即无冲突**。
- **代码无需修改**；仅测试与文档迭代。

## 9. 失效自检与退役条件

- **静默失效场景**：上游不再在请求 handler 内同步 spawn（改了启动路径）。判断方法同指南 §4.4——§7 的 sanity check 仍输出 Node 版本但按钮打不开，即需升级插件或改方案。
- **退役条件**：上游在 `launchDetachedApp` 剔除 `ELECTRON_RUN_AS_NODE` 后（discussions/8455 已给出最小修复与分支，一行核心改动），本插件卸载即可。
