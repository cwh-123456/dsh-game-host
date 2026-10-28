# 复扫雷 Complexweeper — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的第四个独立游戏包：往宿主的 `game.stage`
chain slot 注册「复扫雷」，装进 DSH 后出现在「游戏」页左侧目录里，点开即可玩。宿主代码
**一行没改**——新包只靠自己注册就出现在目录里。

规则引擎是 Zig 原版 [Complexweeper](https://github.com/Yueqing-Chen/complexweeper-A-minesweeper-game)
`正式版/src/game.zig` 的 1:1 移植（GPL-3.0，见「来源与许可」）；界面是面向 DSH 舞台重写的
canvas 自绘 UI，**没有复制**原版任何图像素材（原版图集不在 GPL 授权内）。

## 玩法

扫雷，但雷是**复数**。棋盘上有四种雷：

| 雷 | 值 | 界面颜色 |
|---|---|---|
| 正实雷 | +1 | 红 |
| 负实雷 | −1 | 蓝 |
| 正虚雷 | +i | 绿 |
| 负虚雷 | −i | 紫 |

- **线索** = 周围 8 格所有雷之和的模长（源码存平方值）：`a = #(+1) − #(−1)`、
  `b = #(+i) − #(−i)`，线索 = `a² + b²`（显示时开根号）。所以只可能出现 24 种值：
  `0..8`、`√2 √5 √10 √13 √17 √26 √29 √34 √37`、
  `2√2 3√2 4√2 5√2 2√5 2√10`。
- **空白 ≠ 0**：空白 = 周围一颗雷都没有，会连片扩散；`0` = 周围全是抵消对
  （`+1` 配 `−1` 或 `+i` 配 `−i`），**不扩散**。
- **插旗**：右键循环 `空 → +1 → −1 → +i → −i → 空`，旗不限量；只有未翻开的格子能插。
- **翻开**：左键。有旗的格子翻不开（先右键循环回空）；翻开雷判负；翻到空白格连片扩散。
- **展开（chord）**：双击已翻开的数字格，或**中键**。判据是：
  邻域旗数必须等于邻域真实雷数，且**实部旗数 : 虚部旗数**等于真值比例**或其倒数**
  （不要求 ± 符号正确）——用旗去试探「抵消对」正是核心玩法。判据不足会闪红并提示
  「判定不通过」；判据通过但邻域里真有雷没标出来，会踩雷判负。
- **首点必安全**：第一次翻开的那格及其周围 8 格不会布雷。
- **胜利 = 翻开所有非雷格**（不是插对全部旗）。胜负都会在棋盘上复盘：
  绿勾 = 标对的旗、红叉 = 标错的旗、暗雷 = 没标出的真雷。
- 计时从第一次翻开开始；最小化 / 切到后台标签页会暂停，回来继续；离开游戏页会落盘。
- 四类雷的总数在开局公开（顶部四个色块显示「已插 / 总数」）。

难度三档（同原版）：

| 级别 | 尺寸 | 雷数 |
|---|---|---|
| 初级 | 9×9 | 10 |
| 中级 | 16×16 | 40 |
| 高级 | 30×16 | 99 |

> v1 只做**圆复数模式**。闵可夫斯基模式（`mode=hyper`，`j²=+1`）的引擎分支已随原版一起
> 移植（`computeClues`、`matchComboTruth`、`judgeLoose`），但没有接进本版 UI。

## 游戏内规则

工具栏里的「📖 规则」按钮会弹出完整的规则与操作说明。弹窗分五节：复数雷、24 种线索值、插旗、展开（chord）、胜负与难度。

- 弹窗打开期间，键盘事件不会再传给棋盘（按 `Esc` 或点 `×` / 遮罩关闭），不会一边看规则一边误操作。
- 规则文本随代码一起发布，离线可用，不依赖网络。

## 存档

- key：`localStorage['dsh.game.complexweeper.v1']`（**不碰** `dsh.game.2048.v1`、
  `dsh.game.minesweeper.v1`、`dsh.game.quoridor.v1`）
- 内容：

  ```js
  {
    schemaVersion: 1,
    difficulty: 1,            // 1|2|3，仅用于工具栏选中态；必须与棋盘尺寸对应
    state: {                  // engine.snapshot()：棋盘、雷、线索、翻开、旗、类型总数、计时…
      w, h, mode, judgeLoose, seed, rngA, mines, typeCount,
      mine, clue, open, flag,
      started, over, win, boom, startCell, elapsedMs, moves,
      typeTotal, flagsOf, msg, msgArg
    }
  }
  ```

- 每次翻开 / 插旗 / 展开 / 新局 / 切难度 / `document.hidden` / 卸载都会落盘；刷新页面后继续。
- 解析失败、`schemaVersion` 不符、难度与尺寸不符、局面自相矛盾（数组长度/越界值/雷数不符/
  翻开雷与胜负态冲突/同格既翻开又插旗/首点格未翻开等）→ 丢弃存档开新局，**不抛错**。
  `Game.fromSnapshot()` 会重算 `typeTotal`/`flagsOf`，不信任存档里的派生计数。
- 用时以最近一次落盘为准，硬刷新可能少算几秒（局面不丢）。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-complexweeper`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「复扫雷」（与 2048 / 扫雷 / 墙棋共存）。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。
> 改 `client.js` 约 1 秒热更新；改 `package.json` / `cordis.patch.yml` 需完全重启。

## 自测

```powershell
cd packages\dsh-game-complexweeper
node --check client.js          # 语法

node dev/selftest.mjs           # 规则回归（selftest.zig 用例翻译）：278 项断言全过
node dev/diff-model.mjs         # 独立参照实现差分：52,398 个状态 / 52,171,361 项字段，0 差异
node dev/verify-inline.mjs      # 内联块与 engine.js 逐字节相等 + 探针/注册/规则：147 通过
node dev/test-headless.mjs      # 假 DOM 跑完整 createGame：24 通过
node dev/_smoke.mjs             # Lead 移植期快速冒烟：3,108 项断言
```

- `dev/preview.html`：浏览器直接打开可看 canvas 渲染/交互/明暗主题/三档尺寸的**开发预览**
  （Chromium 实测 15/15 boot checks，window error / unhandledrejection / console.error 为 0）。
  它只验证画面与运行时 API，**不是**宿主内验收；宿主内验收要等插件面板安装后真机联调。
- `dev/screenshots/`：10 张预览截图（亮/暗、初始/进行中/判据失败/踩雷复盘/复盘关闭/胜利/
  高级 30×16/窄屏/窗口太小）。
- `dev/audit/`：独立 verifier 的审计脚本（参照实现差分、边界、存档 fuzz、内联/契约检查）。
  均为 dev-only，不随包发布。

### 为什么规则引擎也内联在 client.js 里

`client.js` 是模块加载器唯一服务的浏览器入口；加载器的 `require` 只解析模块表里的包
（`react` 等），**不支持包内相对路径同步 require**，所以单独的 `engine.js` 在浏览器里拿不到。
纯逻辑因此内联在 `client.js` 前部；`engine.js` 作为可测试的原始拷贝留在包内，
`dev/verify-inline.mjs` 会从锚点抽出内联块与其做 `Buffer.compare`，**逐字节校验**。
内联时引擎临时把 API 挂到 `window.CS`，`client.js` 取走后立即还原（不污染全局）；
只有 `window.__DSH_GAME_COMPLEXSWEEPER_TEST__ === true` 时才会安装测试探针。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client`，`exports` 含 `./client` / `./locale/*.json` / `./icon`；`license: GPL-3.0-only`；无 dependencies |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-complexweeper`） |
| `index.js` | 宿主半侧，空实现（UI 全在 client） |
| `client.js` | 浏览器侧单文件：内联规则引擎 + canvas 渲染 + 输入 + 计时 + 存档 + React 包装 + `game.stage` 注册 |
| `engine.js` | 规则引擎源码（纯逻辑，1:1 移植自 `game.zig`）；被逐字节内联进 client.js，也是 node 测试的对象 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标（四色复数雷象限 + 正负/i 符号，内联 SVG） |
| `LICENSE` | GPL-3.0 声明、上游来源与完整许可证获取方式 |
| `README.md` | 本文件 |
| `dev/` | 自测脚本、开发预览、截图、审计脚本（不随包发布） |

## 实现要点（契约 v1）

- 只 `inject: ['slots']`，只注册 `game.stage`；`select({gameId})` 严格按
  `gameId === 'complexweeper'` 判断，其它游戏一律返回 `null`；`MATCHED` 是冻结对象且恒等。
- 纯鼠标玩法：**完全不注册任何键盘监听**（window/document/根元素都没有），输入框打字不会
  触发游戏；右键 `contextmenu` 与中键/双击默认行为只在 canvas 上阻止。
- `ResizeObserver` + `devicePixelRatio` 重算 canvas 背板；另监听 `window resize` 处理拖到
  不同缩放显示器时 dpr 单独变化；< 320×240 显示「窗口太小」并收起工具栏。
- 计时用 `requestAnimationFrame`，只在「已开局且未结束且页面可见」时保留一帧，每秒最多
  `onState` 一次；胜负、`document.hidden`、卸载立即取消。隐藏时先提交已用时间再落盘，
  回来从提交点继续，不「跳帧狂奔」。
- 判据失败有明确反馈：该数字格 + 邻域闪红 ~0.7s、状态栏红色「判定不通过」角标 ~1.8s
  后自动清除（`JUDGE_FAIL`/`EXPAND_OK` 是一次性提示，不落成永久状态）。
- 结局复盘面板可关闭（× 按钮）；关闭后 canvas 上的绿勾/红叉/暗雷无遮挡。
- 运行期错误只显示游戏内「重试」提示（React 错误边界兜底），不拖白宿主页面。
- canvas 自绘不透明经典配色（亮/暗主题都可读）；工具栏/状态栏/按钮用 `--dsw-alias-*` token。

## 来源与许可（重要）

- 规则来源：**复扫雷 Complexweeper**，作者 **青月晓（Yueqing Chen）**，
  仓库 <https://github.com/Yueqing-Chen/complexweeper-A-minesweeper-game>，
  参考文件 `正式版/src/game.zig`（规则引擎）与 `正式版/src/selftest.zig`（原版自检用例）。
- 原版代码以 **GPL-3.0** 授权；本移植（`engine.js` 及 `client.js` 内的规则逻辑）是其
  **衍生作品**，同样以 **GNU General Public License v3.0（SPDX: `GPL-3.0-only`）** 发布。
  完整许可证声明与全文地址见 [`LICENSE`](LICENSE)；GPL-3.0 全文也可在
  <https://www.gnu.org/licenses/gpl-3.0.txt> 与上游仓库的 `LICENSE` 中取得。
- **图像/音频素材一律未复制**：本包没有任何 png/图集/音效资源；棋盘、四类旗、雷、数字、
  爆炸、复盘标记全部由 `client.js` 在运行时用 canvas 画出。原版图集里的微软扫雷原版素材
  权利属于 Microsoft，作者新增素材权利属于青月晓，二者都不在本包的 GPL-3.0 授权范围内，
  本包也未包含。
- 本程序是独立复刻/移植作品，与 Microsoft 公司无隶属关系，也未获得其授权或背书。
  "Minesweeper"、"扫雷"及相关商标归各自权利人所有。

## 已知边界 / 未验证

- **未安装、未真机联调**（按约定不能自己装）：插件面板标题/描述/图标、宿主目录条目、
  真实 React 渲染与主题 token、切页再进恢复、切窗口计时、真实浏览器鼠标/触控板手势、
  HMR 与控制台无 error，均需用户安装后按契约 v1 §10 验收。
- `dev/preview.html` 的宿主是假页面，`dev/fake-react.js` 只覆盖本组件用到的 React 子集，
  **不是**宿主 React 运行时；预览通过 ≠ 宿主内通过。
- 触屏/无右键设备只能翻开、不能插旗（本包定位桌面鼠标）。
- v1 不含闵可夫斯基模式 UI；引擎里该分支已移植但未被 UI 使用（独立差分脚本覆盖了它）。
- 硬刷新可能少算几秒计时（局面不丢）；未加 `pagehide` 落盘。
