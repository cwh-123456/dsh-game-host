# 数独 Sudoku — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的一个独立游戏包：往宿主的 `game.stage`
chain slot 注册 9×9 数独，装进 DSH 后出现在「游戏」页左侧目录里，点开即可玩。

## 玩法

- 标准 9×9 数独：每行、每列、每个 3×3 宫都含 1–9 各一次。
- **真实难度分级**：难度由「解开这道题所需技巧的最高级别」决定，不是提示数多少。
  题库离线生成，每局从题库抽题（优先未玩过的），**运行时不生成、不求解**。
- 五档：简单 / 普通 / 困难 / 专家 / 地狱（地狱 = 内置技巧全部用尽仍卡住）。
- 点格子选中；高亮同行/同列/同宫以及棋盘上的同数字。
- **草稿（铅笔）**：每格 9 个小数字，点「草稿」或按 `N` 切换；草稿模式下数字键切换候选。
- **冲突高亮**：同行/列/宫出现重复数字时标红（不禁止输入，方便自己纠错）。
- **撤销**：逐步撤销到开局（最多 300 步），`Ctrl+Z` / `Cmd+Z`。
- **重开**：清空填写与草稿重玩同一题；**新游戏**：换一道未玩过的题。二者会丢进度时先弹确认。
- 显示计时、难度、剩余空格；全盘填满且合法 → 胜利遮罩 + 用时。

## 难度与技巧（真实分级）

题库在离线生成时用「技巧求解器」逐题定级，技巧按顺序尝试（前一级无进展才试下一级）：

| 等级 | 标签 | 判定 |
|---|---|---|
| 1 | 简单 | 只用唯一候选 / 隐性唯一（naked-single / hidden-single） |
| 2 | 普通 | 需要锁定候选（pointing / claiming） |
| 3 | 困难 | 需要数对/数组（naked-pair/triple、hidden-pair/triple） |
| 4 | 专家 | 需要 X-Wing 或 XY-Wing |
| 5 | 地狱 | 上述技巧全部用尽仍解不动（卡住） |

题库配额：简单 40 / 普通 40 / 困难 40 / 专家 40 / 地狱 30，共 **190 题**，
每题都保证唯一解、评级与目标档一致、重评级稳定。技巧覆盖到 **X-Wing / XY-Wing**；
更高级技巧（Swordfish、链、着色等）未实现，因此「地狱」是相对这套技巧集而言。

## 操作

| 操作 | 方式 |
|---|---|
| 选中格子 | 鼠标点击 / 方向键移动 |
| 填入 1–9 | 屏幕数字键盘 / 键盘 `1`–`9` |
| 草稿标记 | 先点「草稿」或按 `N`，再按数字键 |
| 清除 | `Backspace` / `Delete` / 「清除」 |
| 撤销 | 工具栏「撤销」/ `Ctrl+Z`（`Cmd+Z`） |
| 重开本题 / 新游戏 | 工具栏「重开」/「新游戏」 |
| 切换难度 | 工具栏 简单 / 普通 / 困难 / 专家 / 地狱（有进度时先确认） |
| 关遮罩 | `Escape` / 遮罩按钮 |

## 题库与离线生成

- `dev/lib/techniques.mjs`：候选位掩码技巧求解器（单人/隐性唯一、锁定候选、数对/数组、
  X-Wing、XY-Wing）+ 唯一解求解器 + `gradePuzzle` 评级。
- `dev/gen-bank.mjs`：离线生成题库（固定 seed，可复现）。逐题挖空并保持唯一解；
  每挖一格后评级，命中目标档才收题；地狱档挖到不能再挖且技巧耗尽才收。
  校验唯一解 + 评级匹配 + 2 次重评级一致后写入：
  - `dev/bank.json`（含 solution/techniques/clues，权威产物）
  - `client.js` 中 `PUZZLE BANK` 标记块（内联 `id/grade/givens`，约 26.9KB）
- 本机生成 190 题总耗时约 **9.9 秒**（1211 次尝试；分档统计见 `dev/bank.json.generator`）。
- 运行时只做题库查找/抽题/存档，**不含任何生成器或求解器**（verifier 静态检查）。

## 游戏内规则

工具栏里的「📖 规则」按钮会弹出完整的规则与操作说明。弹窗分四节：目标、难度、操作、冲突提示；五档难度各自需要什么技巧也写在里面。

- 弹窗打开期间，键盘事件不会再传给棋盘（按 `Esc` 或点 `×` / 遮罩关闭），不会一边看规则一边误操作。
- 规则文本随代码一起发布，离线可用，不依赖网络。

## 存档

- key：`localStorage['dsh.game.sudoku.v1']`，`schemaVersion: 2`。
- 内容：`{ puzzleId, grade, entries, notes, elapsed, played, winAcked }`
  （`entries` 为玩家层 81 格；`notes` 为 81 个草稿位掩码；`played` 为已玩过的题号，
  用于优先抽未玩过的题；`winAcked` 记录胜利遮罩是否已关闭）。
- 打开游戏时**恢复的是当前这一局**（按 `puzzleId` 取回同一题，不换题）；
  只有存档缺失/损坏/题号不在题库/评分不符才开新题。旧 v1 存档自动丢弃，不报错。
- 计时在切走/切窗口时暂停，回来继续；卸载时落盘，每 5s 自动落盘一次。
- 解析失败 / 版本不符 / `localStorage` 不可用时自动开新局，不抛错。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-sudoku`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「数独」（与 2048 / 扫雷 / 墙棋 / 复扫雷共存）。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。之后改 `client.js` 约 1 秒热更新。

## 自测

```powershell
cd packages\dsh-game-sudoku
node --check client.js
node dev/test-logic.mjs     # 客户端题库/抽题/存档/语义，node 内置模块
node dev/test-grade.mjs     # 题库：唯一解/评级稳定/技巧覆盖/100 题唯一解率
node dev/audit/v2/run-all-v2.mjs   # 独立 verifier 审计（自有技巧求解器）
```

- 题库可离线重建（写入临时目录，因本机 node 对 workspace 写盘被沙箱拒绝）：
  `node dev/gen-bank.mjs`，产物 `bank.json` + `client.banked.js`；把两者搬回
  `dev/bank.json` / `client.js` 即可（流程见 `dev/api-spec-v2.md` §5）。
- 假宿主 Chromium 验收（交付前本机跑过 **49/49 通过、0 console error**）：
  浏览器打开 `dev/preview.html?acceptance=2`，结果在
  `localStorage['dsh.sudoku.acceptance.v2']` 与 `window.__acceptanceResult`。
  覆盖启动/注册/题库/5 档难度/抽题未玩优先/输入/草稿/冲突/撤销/计时/重挂恢复同一题/
  旧档丢弃/胜利/清档/多尺寸/窗口太小/控制台干净。说明见 `dev/ui-check/acceptance-result-v2.md`。
- `dev/preview.html`：假宿主页面（自带 fake-react），在浏览器里直接打开可做开发预览与
  手动联调：主题切换、三种舞台尺寸、重挂（验证存档恢复）、清档重开。
  它**不是宿主内验收**；真实宿主渲染仍需安装后真机验收。
- `dev/screenshots/`：开发预览截图（不随包发布）。

## 实现要点

- 只 `inject: ['slots']`，只注册 `game.stage`；不提供服务、不注册其它 slot、不抢全局快捷键。
- 单文件 `client.js`：内联题库 + 纯逻辑（抽题/存档/状态机/计时）+ React DOM UI + 注册。
  React 从模块表 `require('react')` 拿；无第三方依赖、无构建步骤。
- 键盘监听只挂在组件根节点；不使用 `window`/`document` 的 keydown。
- DOM 棋盘用 CSS grid 绘制，`ResizeObserver` 跟随舞台尺寸重算格子/字号，缩放清晰；
  < 320×240 显示「窗口太小」。
- 棋盘自配色（浅色盘面 + 深色数字），亮/暗主题下都可读；工具栏/遮罩用 `--dsw-alias-*` token。
- 所有存档/监听/计时/渲染都有 try/catch：运行期错误显示游戏内提示 +「重试」，不拖白宿主页面；
  另有错误边界兜底。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client`，`exports` 含 `./client` / `./locale/*.json` / `./icon` |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-sudoku`） |
| `index.js` | 宿主半侧，空实现（UI 全在 client） |
| `client.js` | 浏览器侧：内联题库 + 抽题/存档/React UI/`game.stage` 注册；无运行时生成器/求解器 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标 |
| `dev/lib/techniques.mjs`、`dev/gen-bank.mjs`、`dev/test-grade.mjs`、`dev/bank.json` | 离线题库：技巧评级、生成、校验、权威题库 |
| `dev/test-logic.mjs`、`dev/audit/v2/`、`dev/preview.html`、截图 | 自测、独立审计、假宿主预览（不在 `files` 里，不随包发布） |

## 来源与许可

游戏规则属公有领域。本包代码为原创实现，未复制任何第三方素材、字体或代码；不依赖外部包。
