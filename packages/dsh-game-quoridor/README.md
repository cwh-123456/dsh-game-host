# 墙棋 Quoridor — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的第三个独立游戏包：往宿主的
`game.stage` chain slot 注册墙棋（Quoridor / 步步为营），装进 DSH 后出现在「游戏」页
左侧目录里，点开即可玩。宿主代码**一行没改**——新包只靠自己注册就出现在目录里。

它不是从零写的：规则引擎、BFS 寻路、negamax AI 来自用户已有的网页版墙棋
（`D:\desktop_files\artificial_intelligence\games_ai\墙棋\`），引擎**原样复用**，
`index.html` 里的 canvas 绘制与指针交互就近移植，工具栏 / 状态栏 / 规则弹窗用 React 重写。

## 玩法

- 9×9 棋盘，红方从底边正中出发、目标最上面一行；蓝方从顶边正中出发、目标最下面一行；
  **踏上对面那一行的任意一格**即获胜，红方先手。
- 每回合二选一：**走子**一格（撞上对手可直跳；对手身后是墙/贴边时斜跳），或**放墙**
  （每人 10 面，一面墙横跨两格，不能重叠/交叉，也不能把任何一方彻底封死）。
- 模式：**双人对战** / **人机对战**（可选执红或执蓝）/ **AI 对 AI**。
- 难度沿用原引擎三档：简单 / 普通 / 困难（AI 搜索时间预算 220 / 700 / 1800ms）。
- 「AI 节奏」滑杆 200–1000ms（默认 400ms）：AI 落子前「思考中」至少可见这么久，避免瞬间跳变。
- AI 对 AI 模式可**暂停 / 继续**；非 AI 模式下「悔棋」会把 AI 那一步一起退回（回到你走之前）。
- 键盘（点击棋盘或工具栏后生效）：`R` 切换横/竖墙预览、`U` 悔棋、`N` 新开一局、
  `空格` 暂停（仅 AI 对 AI）；规则弹窗里 `Esc` 关闭。
- 点格子走子；点格子之间的缝隙放墙，预览绿色=可放、红色=非法。窗口缩放时棋盘等比跟随；
  高 DPI 屏幕用 `devicePixelRatio` 重算背板；舞台小于 320×240 时显示「窗口太小」。

## 存档

- key：`localStorage['dsh.game.quoridor.v1']`（**不碰** 2048 的 `dsh.game.2048.v1` 和扫雷的 key）
- 内容：`{ schemaVersion: 1, mode, mySide, level, speed, game: { st: { pawn, walls, hw, vw, turn },
  hist, over, winner } }`；`hw`/`vw` 是 `Uint8Array` 序列化后的普通数组，`hist` 是完整悔棋历史。
- 读取时用引擎**重放历史**并与存档棋盘逐项对照：解析失败 / 版本不符 / 非法走法 / 墙数与
  占用不符 / 历史被改 → 静默开新局，不抛错。
- 每次走子、放墙、悔棋、新局、切隐藏、组件卸载都会落盘；刷新页面/切页回来继续。
- 从存档恢复时若正轮到 AI，会自动继续思考。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-quoridor`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「墙棋」。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。
> 改 `client.js` 约 1 秒热更新；改 `package.json` / `cordis.patch.yml` 需完全重启。

## 自测

```powershell
cd packages\dsh-game-quoridor
node --check client.js

# 引擎：原版测试语义移植 + 源实现差分对拍 + 内联块逐字节校验
node dev/engine-tests.mjs
node dev/engine-diff.mjs
node dev/verify-inline.mjs

# 界面：规则/存档逻辑 + 假 DOM 生命周期
node dev/test-logic.mjs
node dev/test-headless.mjs
```

- `dev/preview.html`：浏览器直接打开可看 **开发预览**（canvas 渲染、点击走子/放墙、
  工具栏、亮/暗主题、规则弹窗）。它只验证画面与运行时 API，**不是**宿主内验收；
  宿主内验收要等插件面板安装后真机联调。
- `engine.js` 是原实现的**逐字节拷贝**，既是内联块的比对基准，也是 Node 侧回归测试的加载对象；
  `dev/verify-inline.mjs` 会断言 `client.js` 内联块与它完全一致（含注释与换行）。

### 交付时的自测结果

| 命令 | 结果 |
|---|---|
| `node dev/engine-tests.mjs` | 21369 通过 / 0 失败（原版 48 条 + 规则文案 26 + 128 面墙跨度 + fuzz 160 局/21120 项 + 朴素 negamax 12 局/24 次） |
| `node dev/engine-diff.mjs` | 60 个随机合法局面、47100 项逐项比较、0 差异（源 `engine.js` vs 包内拷贝） |
| `node dev/verify-inline.mjs` | 67 通过 / 0 失败（内联块 22103 bytes 与 `engine.js` 逐字节相等 + seam Q 44 项 + 引擎断言 11 条） |
| `node dev/test-logic.mjs` | 33 通过 / 0 失败（规则/几何/存档 round-trip） |
| `node dev/test-headless.mjs` | 39 通过 / 0 失败（假 DOM 跑完整 `createGame` 生命周期） |
| `dev/preview.html`（真实 Chromium） | 走子/放墙/非法墙拒绝/悔棋/新局/pve/eve 暂停/键盘/规则弹窗/亮暗主题/三档舞台尺寸/组件重挂/整页刷新恢复 —— 全部通过，`window.error` / `unhandledrejection` / `console.error` 均为 0 |

`dev/screenshots/` 里是开发预览截图（亮/暗 × 360×520 / 720×600 / 1100×700 + 对局中 + AI 对 AI + 暗色规则弹窗），
**不是**宿主内验收截图。

### 为什么引擎也内联在 client.js 里

`client.js` 是模块加载器唯一服务的浏览器入口；加载器的 `require` 只解析模块表里的包
（`react` 等），**不支持包内相对路径同步 require**，所以独立的 `engine.js` 在浏览器里拿不到。
引擎因此原样内联在 `client.js` 顶部（局部变量 `Q` 持有，并在启动后还原 `window.Q`，不污染全局）。
包内仍保留 `engine.js` 原文件：它是内联来源、也是 Node 侧测试对象；运行时不需要单独加载它。

## 实现要点

- 只 `inject: ['slots']`，只注册 `game.stage`；不提供服务、不注册其它 slot。
- `select` 严格按 `gameId === 'quoridor'` 判断，其它游戏返回 `null`；返回冻结的 `MATCHED`
  对象避免 chain 渲染时 matched 引用抖动。
- 画布逻辑坐标沿用原版 610×610（CELL=58、PAD=44、墙粗 10），按舞台等比缩放居中；
  `ResizeObserver` + `devicePixelRatio` 重算 canvas 背板，另监听 `window resize` 处理拖到
  不同缩放显示器时 dpr 单独变化；卸载时 `disconnect` 并摘掉所有监听。
- 键盘只挂在组件根节点（`tabIndex=0`），点击 canvas 时聚焦；**没有** window/document keydown，
  输入框打字不会触发游戏。
- AI 定时器全部经由 `window.setTimeout` 统一登记：暂停、悔棋、重开、切后台、卸载都会
  `clearTimeout` + token 作废，不会出现「回来后 AI 跳好几步」。
- `document.hidden` 时取消挂起的 AI 定时器并落盘；重新可见时重绘、必要时继续 AI 回合。
- 运行期错误只显示游戏内「重试」提示（React 错误边界兜底），不拖白宿主页面。
- canvas 自绘不透明浅色棋盘（亮/暗主题都可读）；工具栏/状态栏/弹窗用 `--dsw-alias-*` token。
- 与 2048 / 扫雷共存：独立包名 `@local/dsh-game-quoridor`、独立 Loader 行 `id: game-quoridor`、
  独立存档 key。
- 已知取舍：AI 搜索在主线程同步执行（与原版一致），「困难」单步最多约 1.8s；这是回合制
  棋类可接受的停顿，但极端情况下会让宿主页面短暂无响应。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client`，`exports` 含 `./client` / `./locale/*.json` / `./icon`；无 dependencies |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-quoridor`） |
| `index.js` | 宿主半侧，空实现（UI 全在 client） |
| `client.js` | 浏览器侧单文件：内联引擎 + canvas 绘制/输入 + React 工具栏 + `game.stage` 注册 |
| `engine.js` | 原实现逐字节拷贝（内联来源 + Node 测试对象） |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标（棋盘 + 墙 + 双色棋子，内联 SVG） |
| `dev/` | 自测脚本与预览页（不在 `files` 里，不随包发布） |
