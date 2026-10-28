# 华容道 · Klotski（`@local/dsh-game-klotski`）

DSH 游戏包：4 列 × 5 行滑块解谜「华容道」。挪开众将，把 **曹操（2×2）** 送到棋盘最下方中间的出口。
纯鼠标操作、回合制、随时可切走；自动存档，回来接着玩。

- `gameId`：`klotski`
- 显示名：华容道
- 存档：`localStorage['dsh.game.klotski.v1']`（schemaVersion 1）
- 接入：`game.stage` chain slot，`select` 只在 `gameId === 'klotski'` 时命中
- 依赖：无（React 从宿主模块表 `require('react')` 拿）
- 宿主：不改 `packages/dsh-game-host/**`

## 玩法与规则

- 棋盘 **4 列 × 5 行**（20 格），初始 10 个棋子 + 2 个空格。
- 棋子固定形状、**不能旋转**：
  - 曹操 2×2；关羽 2×1（横）；张飞 / 赵云 / 马超 / 黄忠各 1×2（竖）；兵 ×4 各 1×1。
- 一步 = 选中一个棋子后沿空位平移 **1 格或 2 格**：
  - 2 格滑动要求路径经过的格子全部为空（不能“穿过”别的棋子）；
  - 不能重叠、不能出界。
- **胜利**：曹操左上角到达 `(列 1, 行 3)`，即占据最下面两行的中间 2×2 —— 也就是出口。
- 记录步数、用时、每关最佳（步数优先、步数相同比用时）。

### 4 个关卡

| # | 名称 | 说明 | 最少步数（BFS） |
|---|---|---|---|
| 1 | 横刀立马 | 任务书经典开局 | 90 |
| 2 | 指挥若定 | 经典变体（底部两兵在中间） | 90 |
| 3 | 齐头并进 | 关羽横在第三行、两兵在第二行 | 76 |
| 4 | 层层设防 | 四角各一兵、门将层层挡路 | 77 |

「最少步数」是在本包规则（一步 1 或 2 格、路径全空）下用 BFS 求出的最短解，
由 `dev/solve.mjs` 独立复算并回放验证（见下）。

## 操作

- **点击棋子选中** → 高亮它所有合法的落点（金色圆点）→ **点击圆点/目标空格移动**。
  - 再点一次已选中的棋子 = 取消选中；点其它棋子 = 换选；点空白非落点 = 取消选中。
- 支持键盘（根元素聚焦后）：
  - `↑↓←→` 移动选中棋子 1 格，`Shift+方向` 尝试 2 格；
  - `Esc` 取消选中；`Ctrl/Cmd+Z` 撤销。
  - 键盘监听只挂在自己的根元素上，没有 window/document 全局快捷键。
- 顶部：关卡选择、撤销、重开；状态栏：步数、用时、本关最少步数、最佳记录。
- 胜利：出口变绿、棋盘发光、弹出胜利卡片（步数 / 用时 / 新纪录），可「下一关 / 重玩本关 / 关掉」。
- 计时从第一步开始；切窗口/最小化（`document.hidden`）暂停，回来继续，不跳时。

## 游戏内规则

工具栏里的「📖 规则」按钮会弹出完整的规则与操作说明。弹窗分四节：目标、棋子、怎么走、关卡与记录。

- 弹窗打开期间，键盘事件不会再传给棋盘（按 `Esc` 或点 `×` / 遮罩关闭），不会一边看规则一边误操作。
- 规则文本随代码一起发布，离线可用，不依赖网络。

## 存档与恢复

- 每次操作、切隐藏、切关、重开、胜利、卸载（`destroy`）都会落盘；计时中每 4 秒也落盘一次。
- 恢复内容：当前关卡、棋子位置、步数、用时、是否已开始/已通关、撤销栈、各关最佳记录。
- 存档校验：版本、关卡、棋子种类/坐标/重叠、步数/用时边界、`won` 与局面一致性、撤销栈；
  坏档（坏 JSON / 版本不符 / 坐标非法 / 重叠 / 曹操位置与 `won` 矛盾…）**丢弃并开新局**，不抛错。
- 只使用 `dsh.game.klotski.v1` 一个 key，不碰其它游戏/宿主数据。
- 硬刷新可能少算最后未落盘的几秒计时（局面不丢）；这是已知边界。

## 安装（用户操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件 → 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-klotski`
2. 安装后点「立即启用」。
3. 进「游戏」页 → 左侧目录出现「华容道」→ 点开。
4. 首次不生效可完全退出客户端（托盘退出）再打开。
5. 之后改 `client.js` 约 1 秒热更新，无需刷新。

## 自测（可复跑，无第三方依赖）

```bash
cd packages/dsh-game-klotski
node --check client.js
node dev/solve.mjs          # BFS 验证 4 关可解 + 最短步数 = par + 回放整条解到游戏引擎
node dev/test-logic.mjs     # 纯逻辑 / 存档 / 坏档 fuzz / 注册形状（35 项）
node dev/test-headless.mjs  # fake DOM 跑 createGame 生命周期（19 项）
```

`dev/preview.html` 是假宿主预览页（真实 DOM + 迷你 fake-react，仅 dev 用），
`dev/preview-sizes.html` 用 iframe 展示 720×600 / 360×520 / 300×220 / 320×240 的响应式效果。
截图在 `dev/screenshots/`。

- 独立 verifier 的审计（从零实现 BFS oracle + 差分 fuzz + 契约静态检查 + 宿主未改基线）报告：
  `dev/audit/VERIFIER.md`。

> `dev/` 不在 `package.json` 的 `files` 里，不随包发布。

## 实现要点

- **单文件 `client.js`**（IIFE / 经典脚本）：
  1. 常量 + 4 关关卡数据（棋子 + 网格坐标，不含像素）；
  2. 纯引擎：`buildGrid / canSlide / listMoves / destinations / applySlide / undoState / restartState / isWon`，
     以及存档序列化/校验（`serializeState / sanitizeSave`）；
  3. Node 测试 seam：`window.__DSH_GAME_KLOTSKI_TEST__ === true` 时挂 `window.__DSH_GAME_KLOTSKI__`（只在 dev/测试生效）；
  4. DOM 控制器 `createGame(host)`：棋盘/棋子用百分比定位（`left/top/width/height`），
     缩放只设置棋盘像素尺寸，棋子随百分比自适应；`ResizeObserver` 监听宿主与舞台；
     移动用 CSS transition，选中/落点高亮、暗色/亮色都能读；
  5. React `Game` 组件（只负责挂载/卸载 `createGame`）+ 错误边界 + `game.stage` 注册。
- 根元素 `width/height:100%`；样式用 `<style>` 注入自己的根元素内（`dshklt-` 前缀），不挂 `document.body`。
- 尺寸 < 320×240 显示「窗口太小，放大一点再玩」；320×240 仍可玩（最小支持尺寸）。
- 全部事件/定时器/存档读写 try/catch；控制器出错时显示游戏内提示，不白屏。
- 无 canvas（DOM 渲染），因此不涉及 canvas DPR 缩放；仍跟踪 `devicePixelRatio` 变化触发重排。

## 文件表

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`dsh.bundle.patch` + `dsh.client{platform:'web',immediately:true}`，`exports`，无 dependencies |
| `cordis.patch.yml` | `insert: id: game-klotski, name: '@local/dsh-game-klotski'` |
| `index.js` | 宿主半侧空 `apply()`（UI/逻辑全在 client） |
| `client.js` | 单文件实现：引擎 + 存档 + DOM UI + React 组件 + slot 注册 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述（华容道 / Klotski） |
| `icon.svg` | 内联 SVG 图标（木纹棋盘 + 曹操 + 出口） |
| `README.md` | 本文件 |
| `dev/solve.mjs` | 独立 BFS 求解器 / 关卡回归 |
| `dev/test-logic.mjs` | 纯逻辑、存档、坏档 fuzz、注册形状自测 |
| `dev/test-headless.mjs` | 自建 fake DOM 的控制器生命周期自测 |
| `dev/fake-dom.mjs`、`dev/fake-react.js` | dev 测试/预览用最小替身 |
| `dev/preview.html`、`dev/preview-sizes.html` | 真实 Chromium 预览与尺寸矩阵 |
| `dev/screenshots/` | 亮/暗、选中/落点、胜利、尺寸矩阵截图 |
| `dev/audit/` | 独立 verifier 审计脚本与报告（dev-only） |

## 已知边界 / 未验证

- 本包未在真实宿主中安装验证（按约定子对话不能自己装插件）。真机需确认：
  插件面板标题/描述/图标、「游戏」页目录共存、真实 React 18 渲染、切页卸载→重进恢复、
  宿主窗口缩放/高 DPI 观感、最小化/切屏计时、控制台无本插件 error。
- `dev/preview.html` 用自写迷你 fake-react（非 React 18），只覆盖本组件用到的子集；
  预览通过 ≠ 宿主内验收。
- 拖拽移动未实现（v1 按任务书不强制；点击选中→点击目标最稳）。
- 鼠标交互用 Chromium 合成 MouseEvent 验证；未用物理鼠标/触屏真机。
- 计时以最后一次落盘为基准，硬刷新可能少算几秒（局面不丢）；未加 `pagehide` 落盘。
