# dsh-open-in-app-electron-fix

修复 DSH 打包版**打不开 VS Code 等 Electron 应用**的问题：点击会话页右上角"在应用中打开"的 VS Code 按钮无反应（前端收到 `502 launch-failed`）。

- 适用版本：DeepSeek Harness **0.2.1-rc.3**（桌面版与全局 `dsh` 命令同受影响；本地源码运行的 `dsh web` 无此问题）
- 插件形态：纯 host 插件，免构建、零运行时依赖、零 `@deepseek-ai/*` 依赖，无配置项
- 原理：打包版宿主带着 `ELECTRON_RUN_AS_NODE=1` 运行，open-in-app 启动外部应用时该变量经 `scrubbedParentEnv()` 泄漏给 VS Code 等 Electron 应用，使其进入 Node 模式秒退。本插件包装 `/open-in-app/open` 启动路由：请求处理期间临时从 `process.env` 摘掉该变量（启动 spawn 在请求内同步完成），结束即恢复。详见 [DEVLOG.md](DEVLOG.md)。

## 工程结构

```
dsh-open-in-app-electron-fix/
├── package.json         # 契约：main / files / dsh 元数据
├── cordis.patch.yml     # 注入声明（与官方 open-in-app 共存，不禁用）
├── index.js             # host 入口（免构建纯 JS）
├── scripts/smoke.mjs    # 开发期冒烟测试（不进包）
├── DEVLOG.md            # 开发日志（根因证据链、方案演进、review 记录）
└── README.md
```

## 打包

本插件免构建，打包一次产出一个 tarball，web 与 desktop 两个 profile 装的是**同一份产物**：

```sh
npm run pack        # 等价 npm pack；产出 dsh-open-in-app-electron-fix-0.1.0.tgz
tar -tzf dsh-open-in-app-electron-fix-0.1.0.tgz
# 期望仅三项：package/package.json、package/index.js、package/cordis.patch.yml
```

发布到 npm registry 前先确认包名未被占用，之后每改一次代码需 `npm version patch && npm publish`。

## 安装（web 与 desktop 要分别装，只装一处另一处仍旧打不开）

### 方式一：tarball（自分发，推荐）

```sh
# 全局 dsh web 命令（web profile）
dsh plugin --profile web add ./dsh-open-in-app-electron-fix-0.1.0.tgz

# DeepSeek Harness 桌面版（desktop profile）
dsh plugin --profile desktop add ./dsh-open-in-app-electron-fix-0.1.0.tgz
```

### 方式二：本地目录（开发调试，链接引入）

```sh
dsh plugin --profile web add ./dsh-open-in-app-electron-fix
dsh plugin --profile desktop add ./dsh-open-in-app-electron-fix
```

链接引入不替你构建（本插件无构建步骤），但改动后需重启 `dsh web` / 桌面版生效；删除目录插件即失效。

### 方式三：npm 包（公开发布后）

```sh
dsh plugin --profile web add dsh-open-in-app-electron-fix
dsh plugin --profile desktop add dsh-open-in-app-electron-fix
```

### 方式四：git 仓库（源码分发）

```sh
dsh plugin --profile web add github:<你的账号>/dsh-open-in-app-electron-fix
dsh plugin --profile desktop add github:<你的账号>/dsh-open-in-app-electron-fix
```

仓库无 `prepare` 脚本也不需要——入口就是免构建的 `index.js`，克隆即用。稳定版建议打 tag 锁定：`github:<账号>/dsh-open-in-app-electron-fix#v0.1.0`。

## 验证

```sh
# 1. 重启使插件生效
dsh web          # 或重启桌面版

# 2. 环境 sanity check：输出 Node 版本证明变量确实能改变 Code.exe 行为（机制前提成立）
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" --version

# 3. 打开 DSH 会话页，点右上角 VS Code 按钮 → VS Code 应正常打开工作区
```

每次 DSH 升级后建议重跑一次第 2 步：若输出仍是 Node 版本但按钮打不开，说明上游改了启动路径、插件未拦到，按 DEVLOG §9 处理。

## 移除

```sh
dsh plugin --profile web remove dsh-open-in-app-electron-fix
dsh plugin --profile desktop remove dsh-open-in-app-electron-fix
```

## 上游修复进展与退役

上游社区已提交同款最小修复提案（[discussions/8455](https://github.com/deepseek-ai/deepseek-harness/discussions/8455)，在 `launchDetachedApp` 内剔除该变量）。上游合并后本插件变为无害 no-op，可直接卸载退役。核验细节见 DEVLOG §8。

## 开发

```sh
npm run check
# = node --check index.js && node scripts/smoke.mjs
# 冒烟测试跑在 harness 仓库真实构建出的 WebServer 类上（默认路径
# C:/node-leviathan/deepseek-harness-dsh-v0.2.1-rc.3，可用
# `node scripts/smoke.mjs <harness 仓库路径>` 覆盖），16 项断言覆盖
# 两种插件激活顺序、dispose 还原、并发请求与 github-desktop 显式 env 透传。
```
