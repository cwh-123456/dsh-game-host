# 五子棋 Gomoku — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的**第十个**独立游戏包：往宿主的
`game.stage` chain slot 注册五子棋，装进 DSH 后出现在「游戏」页左侧目录里，点开即可玩。
宿主代码**一行没改**——新包只靠自己注册就出现在目录里，与 2048 / 扫雷 / 墙棋 / 复扫雷 /
俄罗斯方块 / 数独 / 接龙等已有游戏共存。

- 包名：`@local/dsh-game-gomoku`
- `gameId` / slot id：`gomoku`
- 目录显示名：**五子棋**
- 存档 key：`localStorage['dsh.game.gomoku.v1']`

## 玩法

- **15×15** 棋盘，棋子下在交叉点上；**黑先白后**，轮流落子。
- 横、竖、两条斜线任意方向**连成 5 子及以上即胜**（长连也算赢）。
- **无禁手**自由规则：黑棋不禁止长连、三三、四四。
- 棋盘下满仍未连成五子则为和棋（极少见，已处理）。
- v1 主打**人机对战**；另附**本地双人**（同屏轮流，便于试玩/验证规则）。

## AI

- **候选点**：只考虑已有棋子 **Chebyshev 距离 ≤2** 的空点，不做全盘评估；空盘第一手走天元。
- **评分**：对每个候选点分别算「我下这里」和「对手下这里」的棋型分——连五 / 活四 / 冲四 /
  活三 / 眠三 / 活二 / 眠二 / 单子，采用经典分值表（`FIVE 1e7 > 活四 1e6 > 冲四 1e5 >
  活三 1e4 > 眠三 1e3 > 活二 500 > 眠二 100 > 单子 10`）。棋型识别用 9 格窗口 + 固定串匹配
  （能识别跳四/跳三），再退回连续棋子兜底；综合分 = `我分 + 对手分 × 0.8`。
- **三档难度**：
  - **简单**：在综合分最靠前的 6 个候选里按权重随机（能陪你下，但会漏防）。
  - **普通**：贪心，直接取综合分最高点。
  - **困难**：取前 **12** 个候选做 **α-β 搜索（深度 4）**，迭代加深 2→4；浅层用邻居密度排序、
    第 3 层用完整棋型分排序；叶子评估用全盘 5 格窗口计数（能处理断点）。
- **不自杀 / 能赢先赢**：三档 AI 都先检查「自己下这里能否立刻成五」，能赢直接赢；否则若
  对手有唯一/多个「下一手成五」的点，必堵其中一个。普通/困难在此之上再做贪心/搜索。
- **节奏**：AI 落子前保留 **200~400ms** 的思考停顿（先让出一帧显示「AI 思考中」，算完补足）。
- **性能**：困难档搜索预算 **210ms** 并带节点上限；超时/超节点会**降级为贪心**（按规格）；
  实测单步思考远低于 300ms（见下）。
- AI 在**主线程同步计算**（与其它棋类游戏一致）；回合制，可接受短暂停顿。

## 交互

- 点击空交叉点落子；鼠标悬停显示**落点预览**（半透明棋子 + 蓝色圆环）。
- **最后一手**用红圈标记；胜利时用金色连线 + 金色圆环高亮连成五子的那一串。
- 工具栏：**人机对战 / 双人对战**、**简单 / 普通 / 困难**、**撤销**、**重开**、**📖 规则**。
- **撤销**：人机模式一次退 **2 步**（AI + 你）；双人模式退 1 步。AI 思考中撤销按钮禁用。
- 状态栏：轮到谁、步数、用时（`mm:ss`）、AI 上一步思考毫秒数；结束后显示结果与「再来一局」。
- 键盘（焦点在游戏内时）：`U` 撤销、`N` 重开；规则弹窗 `Esc` 关闭。
  **没有** window/document 级键盘监听，输入框打字不会触发游戏。
- 响应式：canvas 按舞台 `min(宽,高)` 等比缩放居中；`ResizeObserver` + `devicePixelRatio`
  重算背板；舞台小于 **320×240** 时显示「窗口太小」提示。
- 切窗口/最小化（`document.hidden`）：暂停计时、取消挂起的 AI 定时器并落盘；
  回来后恢复计时与 AI，不会「跳时」或「AI 连走几步」。

## 存档

- key：`localStorage['dsh.game.gomoku.v1']`（不碰其它游戏的 key）
- 内容：`{ schemaVersion: 1, mode, level, board[225], turn, history[{p,side}], over, winner,
  winLine, elapsedMs }`
- 读取时用引擎**重放完整历史**：逐手校验轮次/空点/合法落子，重算 `board / turn / over /
  winner / winLine` 并与存档逐项对照；解析失败、版本不符、棋盘被改、历史非法、结果为假 →
  **静默开新局**，不抛错。`elapsedMs` 非法同样拒绝。
- 每次落子、撤销、重开、切难度、切隐藏、组件卸载都会落盘；刷新页面/切页回来继续。
- 从存档恢复时若正轮到 AI（例如存档点在人机模式 AI 回合），会自动继续思考。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-gomoku`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「五子棋」。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。
> 改 `client.js` 约 1 秒热更新；改 `package.json` / `cordis.patch.yml` 需完全重启。

## 自测

```powershell
cd packages\dsh-game-gomoku
node --check client.js
node --check index.js

# 规则 / AI / 超时 / 撤销 / 存档 / 契约（无浏览器，假 DOM + 假定时器）
node dev/test-ai.mjs

# AI 自对弈 sanity + 完整对局单步耗时
node dev/selfplay.mjs
```

- `dev/preview.html`：浏览器直接打开可看**开发预览**（真实 Chromium 渲染 canvas、点击落子、
  AI 节奏、撤销/重开/规则弹窗、亮/暗主题、多种舞台尺寸）。它用 `dev/fake-react.js`
  这个 dev-only 迷你 React 渲染真实组件；**不是宿主内验收**。
- `dev/browser-check.mjs`：可选的自包含 headless Edge/CDP 交互脚本（独立浏览器实例，
  避免并行开发时共享浏览器被别的会话导航走）；跑完只打印结果。受限沙箱里 Edge 可能起不来
  （devtools 端口超时），此时用共享浏览器工具按同样步骤手动验证即可。
- `dev/debug-strength.mjs`：临时诊断脚本（困难 AI 战术失误检查），保留作调试参考。
- `dev/screenshots/`：开发预览截图（亮/暗、中局、获胜、规则弹窗），**不是**宿主内验收截图。

### 交付时自测结果

| 命令 | 结果 |
|---|---|
| `node dev/test-ai.mjs` | **30/30 通过**：成五检测（横/竖/两斜/四边/角/长连/断点/误报）、冲四必堵（3 档 × 4 方向）、活三必堵（普通/困难 × 3 方向）、能赢先赢、候选 2 格限制、6 局面 × 3 档超时（困难 max ≈23ms）、困难深度 4、小预算降级、撤销 2 步/1 步、胜负后撤销、**满盘无五子和棋（225 手存档重放 + 撤销）**、卸载落盘/重进恢复、坏档拒绝、隐藏暂停/恢复、模式/难度/重开、太小提示、几何、契约形状 |
| `node dev/selfplay.mjs` | **6/6 完整对局**全部正常结束、每步合法；单步最大思考 **≈31ms**（<300ms）；困难档执黑/执白均战胜普通与简单 |
| `dev/preview.html`（真实 Chromium） | 11/11 启动检查通过；点击落子 + AI **312ms** 回复、撤销 2 步、双人模式连五获胜 + 金色高亮 + 撤销、难度切到「困难」、规则弹窗、亮/暗主题、360×520/300×220/720×600 缩放；`window.error` / `unhandledrejection` / `console.error` 均为 0 |
| 独立审计（`.scratch/gomoku-audit/`，dev-only，不随包发布） | **PASS WITH NOTES，0 缺陷**：rules 249、candidates 4/4（90 局面 360 步）、tactics 600/600（200 必堵局面 × 3 档）、lifecycle/save 112 断言（340 坏档 0 抛错）、save-fuzz 44/44（500 坏档 0 抛错），全部 0 失败 |

> 具体数字以每次实际运行输出为准（机器不同会有小幅波动）。

## 实现要点

- 单文件 `client.js`：规则 + AI 引擎内联在顶部（纯函数、无 DOM，Node 自测通过测试 seam
  `window.__DSH_GAME_GOMOKU__` 直接调用），React 界面在底部并向 `game.stage` 注册。
- 只 `inject: ['slots']`，只注册 `game.stage`；`select` 严格按 `gameId === 'gomoku'`，
  其它游戏返回 `null`；返回冻结的 `MATCHED` 对象避免 chain 渲染时 matched 引用抖动。
- `id: 'gomoku'`、`label: () => '五子棋'`；包清单按契约 v1 写全 `exports` / `dsh` / `files`，
  无 dependencies、无 `dsh.client.inject`。
- canvas 逻辑坐标 628×628（CELL=40、PAD=34），按舞台等比缩放；`ResizeObserver` 回调
  延后一帧再量尺寸，避免 Chromium 的 “ResizeObserver loop …” 警告；另监听 `window resize`
  处理拖到不同 DPI 显示器的情况。
- 键盘只挂在组件根节点（`tabIndex=0`），点击 canvas 时聚焦；**没有** window/document keydown。
- AI 定时器全部经 `window.setTimeout` 统一登记：撤销、重开、切模式、切后台、卸载都会
  `clearTimeout` + token 作废，不会出现「回来 AI 跳步」。
- 运行期错误只显示游戏内「重试」提示（React 错误边界兜底），不拖白宿主页面。
- canvas 自绘不透明木纹棋盘，亮/暗主题都可读；工具栏/状态栏/弹窗用 `--dsw-alias-*` token。
- 测试 seam 只在 `window.__DSH_GAME_GOMOKU_TEST__ === true` 时安装，生产不触发。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web', immediately:true}`；`exports` 含 `.` / `./client` / `./locale/*.json` / `./icon`；无 dependencies |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-gomoku`） |
| `index.js` | 宿主半侧，空 `apply()`（UI 全在 client） |
| `client.js` | 浏览器侧单文件：规则 + AI 引擎 + canvas 绘制/输入 + 存档 + React 工具栏 + `game.stage` 注册 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标（木色棋盘 + 黑白子，内联 SVG） |
| `README.md` | 本文件 |
| `dev/` | 自测脚本、dev-only 迷你 React、预览页、截图（不在 `files` 里，不随包发布） |

## 已知边界（诚实说明）

- **没有安装插件、没有真机跑宿主**（按约定不能自己装）：插件面板标题/图标、「游戏」页目录
  出现「五子棋」并与其它游戏共存、真实 React 18 运行时、宿主内切页卸载→重进、宿主 CSP 对
  组件内 `<style>` 的行为等，需用户安装后按契约 §10 验收。
- `dev/preview.html` 是假宿主页面，`dev/fake-react.js` 只覆盖本组件用到的 React 子集；
  **开发预览通过 ≠ 宿主内验收**。
- AI 是「规则 + 棋型 + 浅层搜索」的经典实现，不是训练模型；困难档深度 4、单步 <300ms，
  棋力足够休闲对局，但不是强引擎。搜索在主线程同步执行。
- 困难档在极端长考局面（节点上限/预算耗尽）会降级为已完成深度或贪心，报告为「超时降级」。
- 和棋分支：用 `(r + 2c) mod 4 < 2` 的 2-染色构造出「15×15 满盘、四方向都没有五连」的
  合法历史（黑 113 / 白 112），已在 `dev/test-ai.mjs` 里覆盖存档重放、重挂载与撤销。
- 计时以最后一次落盘为基准：硬刷新可能少算几秒（局面不丢）。
- 随机对局 fuzz 覆盖中未自然出现「棋盘下满和棋」，和棋分支由代码审查 + 存档校验覆盖。
