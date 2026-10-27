# 数独包实现规格 v1（Lead 冻结；dev / verifier 都按此实现与审计）

> 目标：`packages/dsh-game-sudoku/`，`gameId: 'sudoku'`，label「数独」。
> 契约见 `handoff/contract/game-plugin-api.v1.md`；任务书见 `handoff/to-sub/008-add-sudoku.md`。
> 本规格是二者的落地细化。**只写自己负责的文件**（见 §11），不要改宿主、不要改别的游戏包。

## 1. 运行时结构

- 单文件 `client.js`：`(function(){ 'use strict' ... })()` 包裹。
  - 前部：纯逻辑引擎（无 DOM / 无 React），可被 node 测试。
  - 后部：`window.__ModuleLoader__.load({ id: '@local/dsh-game-sudoku', factory(require) { ... } })`。
  - `factory` 里 `require('react')`，只使用 `React.createElement`、`Fragment`、`useState`、`useEffect`、`useRef`、`useCallback`、`useMemo`、`Component`。
  - 注册：`inject: ['slots']`；`apply(ctx)` 内 `ctx.slots.inject('game.stage', () => ctx.slots.register({ name:'game.stage', id:'sudoku', label:()=>'数独', select:(p)=> p && p.gameId==='sudoku' ? MATCHED : null }, GameEntry))`。`MATCHED = Object.freeze({})` 只创建一次。try/catch 包住注册，出错只 `console.error('[dsh-game-sudoku] ...')` 不抛出。
- 测试 seam（与 2048 同款）：
  - 仅当 `window.__DSH_GAME_SUDOKU_TEST__ === true` 时，在 `client.js` 顶层把引擎挂到 `window.__DSH_GAME_SUDOKU__`（用 `Object.defineProperty`，失败静默）。
  - 正常运行**不得**暴露全局。
- 存档 key：`dsh.game.sudoku.v1`（`STORE_KEY`），`schemaVersion: 1`。
- 所有运行期错误：`console.error('[dsh-game-sudoku] ...')`；渲染期不抛错。

## 2. 常量（seam 与内部共用）

```js
GAME_ID = 'sudoku'
STORE_KEY = 'dsh.game.sudoku.v1'
SCHEMA_VERSION = 1
GRID = 9
CELLS = 81
DIFFICULTIES = {
  easy:   { key:'easy',   label:'简单', givens:40 },
  normal: { key:'normal', label:'普通', givens:34 },
  hard:   { key:'hard',   label:'困难', givens:28 },
}
DEFAULT_DIFFICULTY = 'normal'
UNDO_LIMIT = 300
```

## 3. 生成器 / 求解器（必须满足）

**求解器**（位掩码，`rows/cols/boxes` 各 9 个 bitmask）：

- `countSolutions(givens, limit = 2)`：返回解数，最多数到 `limit`（`=== limit` 即可）提前返回。
  - 递归 + MRV（每次选候选最少的空格）；候选 = `~(rows[r]|cols[c]|boxes[b]) & 0x1FF`。
  - 输入非法（不是 81 个 0–9、给定值同行/列/宫冲突）→ 抛 `TypeError`（这是程序错误；存档清洗不调用它）。
- `solve(givens)`：返回第一个解 `number[81]` 或 `null`。
- 必须能快速处理：经典题、空盘（`countSolutions(empty,2) === 2`）、无解盘（0）。

**生成器** `generatePuzzle(difficultyKey, rng)`：

- 步骤严格按任务书：① 回溯 + 随机候选顺序生成完整合法盘；② 打乱 81 个位置逐个挖空，每挖一格用 `countSolutions(...,2)` 验证仍唯一，不唯一恢复；③ 提示数达到目标（40/34/28）或挖不动（整轮 81 格都试过）即停。
- 返回：
  ```js
  { difficulty, targetGivens, givens /*number[81], 0=空*/, solution /*number[81]*/,
    givensCount, digAttempts, digRemoved, digPasses /*=1*/, genMs }
  ```
- 约束：
  - `countSolutions(givens, 2) === 1`；`givens` 与 `solution` 一致；`solution` 是合法完整盘。
  - `givensCount >= targetGivens` 且 `givensCount <= 81`（目标达到时通常恰等于目标；hard 可能因挖不动高于 28）。
  - `genMs < 200` **硬约束**（本机）。实现里用 `Date.now()` 计时；挖空循环内做时间预算保护：累计 > 180ms 立即停止挖空并返回当前结果（必失败的是 200ms 验收）。
  - 同一 `rng` 序列 → 同一题（确定性可测）。
- `createRng(seed)`：mulberry32；返回 `() => [0,1)`。默认 `Math.random`。
- 优化提示：MRV 求唯一性、位掩码、挖空前先算候选；不要用字符串拼接盘面。

## 4. 纯逻辑 API（精确签名，seam 上全部导出）

> 全部用普通 `Array`/对象（便于 JSON 与测试）。所有函数不读 localStorage（除 `loadSavedState` / `saveState`）。

```js
createRng(seed) -> function
generatePuzzle(difficultyKey, rng) -> 见 §3（difficultyKey 非法时按 normal）
countSolutions(givens, limit=2) -> number
solve(givens) -> number[81] | null
computeConflicts(board) -> number[81]   // 1 = 该格与同行/列/宫其它格数字重复
countEmpty(board) -> number
isSolved(board) -> boolean              // 填满 + 无冲突
hasProgress(state) -> boolean           // 有任何玩家填入值或草稿 → 用于“换题会丢进度”确认
createState({ difficulty, rng, now }) -> state   // 生成新题；elapsedMs=0；runningSince=now
loadSavedState() -> state | null        // 合法存档恢复（不重新生成）；损坏返回 null
saveState(state) -> boolean             // try/catch localStorage；失败 false 不抛
serializeState(state) -> plain object
sanitizeSave(raw) -> state | null
formatTime(ms) -> 'mm:ss' 或 'h:mm:ss'
selectCell(state, index) -> boolean
moveSelection(state, dRow, dCol) -> boolean
toggleNotesMode(state) -> boolean
applyDigit(state, index, digit, now) -> boolean
eraseCell(state, index, now) -> boolean
undoMove(state, now) -> boolean
restartPuzzle(state, now) -> void
newPuzzle(state, difficulty, rng, now) -> void
timerResume(state, now) -> void
timerPause(state, now) -> void
timerElapsed(state, now) -> number
getSnapshot(state, now) -> snapshot
```

语义细节（必须逐条实现，verifier 会按此审计）：

- `applyDigit`：
  - 已胜利 / 给定格 / index 或 digit 越界 → `false` 无副作用。
  - 草稿模式：格内已有值 → `false`；否则 toggle 该数字的 note bit（`1<<(d-1)`），push undo，返回是否变化。
  - 普通模式：`board[index] === digit` → `false`（不自动擦除）；否则 push undo（`{index, prevValue, prevNotes}`），`board[index]=digit`、`notes[index]=0`；填满且 `isSolved` → `won=true, winAcked=false, timerPause`；返回 `true`。
  - **允许**填出冲突数字（用于红色冲突提示），不拒绝。
- `eraseCell`：胜利/给定/本来就空 → false；否则 push undo，清 `board[index]=0, notes[index]=0`（草稿也清）。
- `undoMove`：胜利 / 栈空 → false；弹栈，恢复 `prevValue/prevNotes`（index 是给定格的坏 entry 直接跳过并继续弹）；返回 true。撤销后不重新开始计时（计时在跑就一直跑）。
- `restartPuzzle`：`board = givens.slice()`、notes 全 0、undo 清空、`elapsedMs=0`、`won=false`、`winAcked=false`、`runningSince=now`（重新计时）。题目/难度不变，selected 保留（无效则 null）。
- `newPuzzle`：重新 `generatePuzzle(difficulty)` 并整体替换题目、清空填写/草稿/undo、计时归零重启、`won=false, winAcked=false, selected=null`。
- `timerPause`：若在跑，`elapsedMs += max(0, now - runningSince)`，`runningSince=null`；重复调用无副作用。
- `timerResume`：若暂停，`runningSince=now`；重复调用无副作用。
- `timerElapsed`：`elapsedMs + (runningSince!=null ? max(0, now-runningSince) : 0)`。
- `won` 是状态字段；`applyDigit` 后唯一置 true 的地方。`restartPuzzle/newPuzzle` 置 false。`undoMove` 在胜利时被禁用，所以不要出现“撤销把 winner 变回非赢”的路径。
- 计时在胜利时暂停；`won` 状态禁止一切填写/擦除/撤销/草稿。
- `selected`：`null` 或 0–80；点击给定格也允许选中（用于高亮）。`moveSelection` 从当前格移动并 clamp 到 0..8，未选中时从 0 开始。

## 5. state 结构

```js
{
  difficulty: 'easy'|'normal'|'hard',
  targetGivens: number,
  givens: number[81],      // 0 或 1..9，整个会话不变
  solution: number[81],    // 1..9，整个会话不变
  board: number[81],       // 0 或 1..9；给定格恒等于 givens
  notes: number[81],       // 0..511 bitmask；给定格/有值格恒 0
  selected: number|null,
  notesMode: boolean,
  elapsedMs: number,       // 整数 >= 0
  runningSince: number|null, // 仅内存；不序列化
  won: boolean,
  winAcked: boolean,
  undo: Array<{ index:number, prevValue:number, prevNotes:number }>, // 上限 300
  // 生成统计（可选保留）：genMs, givensCount, digAttempts
}
```

## 6. 存档

`localStorage[STORE_KEY] = JSON.stringify({ schemaVersion: 1, ... })`：

```js
{
  schemaVersion: 1,
  difficulty, targetGivens,
  givens, solution, board, notes,
  selected, notesMode, elapsedMs, won, winAcked,
  undo: [{ index, prevValue, prevNotes }]  // 最多 300 条
}
```

`sanitizeSave(raw)` 规则（任何一条不满足 → 返回 `null`，绝不抛）：

- 对象、`schemaVersion === 1`、`difficulty` 是合法 key。
- `givens`：81 个整数 0..9，至少 17 个非零，且给定值无冲突（`computeConflicts(givens)` 全 0）。
- `solution`：81 个整数 1..9，是合法完整盘，且与 `givens` 一致（给定格相等）。
- `board`：81 个整数 0..9；给定格必须 `=== givens[i]`；空格/玩家值任意 1..9。
- `notes`：81 个整数 0..511；给定格必须 0；有值格必须 0（否则归零，不算拒绝）。
- `elapsedMs`：有限整数，`0..604800000`，越界 clamp。
- `selected`：`null` 或整数 0..80，否则 null。
- `notesMode`、`won`、`winAcked`：布尔化（`=== true`）。
- `undo`：数组，过滤坏 entry（`index` 0..80 整数、`prevValue/prevNotes` 合法、index 不能是给定格），最多 300；坏条目丢弃而不是整档拒绝。
- 恢复后重新计算：`won = isSolved(board)`；`winAcked = 存档 winAcked === true`（若恢复出 won 但存档不是，遮罩会再弹一次，可接受）；`runningSince = null`（挂载后由组件 `timerResume`）。
- `loadSavedState`：`JSON.parse` 失败 / key 不存在 → null；不抛。

## 7. UI（React，DOM 渲染，不用 canvas）

根节点：`data-dsh-game="sudoku"`，`width:100%; height:100%; box-sizing:border-box`，flex column，`background: var(--dsw-alias-bg-base)`，`color: var(--dsw-alias-label-primary)`，`tabIndex=0`，`outline:none`，挂载后聚焦（失败静默）。

结构：

1. **工具栏**（高约 48–56px，允许窄屏换行；用 token）：
   - 标题「数独」+ 副标题提示（小字，如「数字键 1–9 输入 · N 草稿 · 退格清除」）。
   - 三档难度 chip：`data-difficulty="easy|normal|hard"`，`aria-pressed` 表示当前题难度，文字 简单/普通/困难。点非当前档 → 若 `hasProgress` 则弹确认遮罩，否则直接 `newPuzzle`。
   - 计时 `data-role="timer"`：`formatTime(timerElapsed)`；`tabIndex=-1`。
   - 剩余 `data-role="remaining"`：`String(countEmpty(board))`。
   - 按钮：`data-action="notes"`（草稿，`aria-pressed={notesMode}`）、`data-action="undo"`（撤销，`disabled={!canUndo || won}`）、`data-action="restart"`（重开）、`data-action="new"`（新游戏）。按钮用 token 样式，窄屏可换行。
2. **棋盘区**（flex:1，`position:relative`，`min-height:0`，内边距 8–12px）：
   - `ResizeObserver` 监听棋盘区，算 `boardPx = floor(min(可用宽, 可用高))`；`cell = boardPx / 9`。
   - 棋盘 `data-sudoku-board`，正方形 `boardPx × boardPx`，CSS grid 9×9，居中；外框 2.5px `#334155`；宫内线 2px、格线 1px（`#64748b`），用每格 border 实现（`row/col` 整除 3 处加粗）。
   - 81 个格子：`data-cell="0..80"`，`data-given="1|0"`，`data-value="0..9"`，`data-selected="1|0"`，`data-peer="1|0"`（同行/列/宫且非本格），`data-conflict="1|0"`，`aria-label` 中文描述。`onClick` 选中。
   - 视觉（棋盘自配色，亮暗主题都可读）：棋盘底 `#f8fafc`；格线 `#64748b`；宫线/外框 `#334155`；给定数字 `#0f172a` 700 字重；玩家数字 `#1d4ed8` 500；冲突数字/底 `#b91c1c` / `#fee2e2`；选中格底 `#bfdbfe`；同行/列/宫底 `#eff6ff`；同数字高亮底 `#dbeafe`（可与上面的优先级合并）。剩余空格显示草稿：3×3 小数字，`#64748b`，字号约 `cell*0.21`，当前格草稿高亮不必须。
   - 字号：数字约 `cell*0.56`，随缩放变化；字体 `"Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif`。
   - 数字键盘：1–9 按钮 + 擦除按钮，横向排列（窄屏可 5+5 两行或 `flex-wrap`），每个 `data-digit="1".."9"` / `data-action="erase"`；宽约 `boardPx`（min 100%）。点击等价于 `applyDigit`/`eraseCell`，不改变选中格。
   - 棋盘区高不足时给数字键盘固定约 46px 高，棋盘用剩余空间。
3. **遮罩**（绝对定位 inset 0，`background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.38))`；面板用 token `bg-layer-2`/`border-l1`/`elevation-panel`）：
   - 胜利：`data-overlay="win"`，标题「完成！」、难度、`用时 mm:ss`、按钮「再来一局」(`data-action="new"`) 与「关闭」(`data-action="dismiss-win"`)。
   - 确认：`data-overlay="confirm"`，title/body 按场景（换难度/新游戏/重开），按钮 `data-action="confirm"` / `data-action="cancel"`。确认后执行对应操作。
   - 运行时错误：`data-overlay="error"`，一句可读提示 +「重试」（重新挂载组件）。
4. **窗口太小**：根元素尺寸 `< 320 宽` 或 `< 240 高` 时整块显示 `data-role="too-small"`（「窗口太小 / 请放大游戏区域」），不渲染棋盘/键盘。用 ResizeObserver 监听根元素。

## 8. 交互语义

- 点击格子：选中；高亮同行/同列/同宫（`data-peer`）；同值格子也高亮（视觉即可，测试不强制 data 属性）。
- 键盘（监听**组件根节点** `onKeyDown`，禁止 `window/document.addEventListener('keydown')`）：
  - `1`–`9` → `applyDigit`（草稿模式则标草稿）。
  - `Backspace` / `Delete` → `eraseCell`。
  - 方向键 → `moveSelection`，必须 `preventDefault()`。
  - `n` / `N` → 切换草稿模式。
  - `Ctrl+Z` / `Meta+Z` → 撤销，`preventDefault()`。
  - `Escape` → 有遮罩则取消/关闭；否则取消选中。
  - 带 `ctrl/meta/alt` 的其他键忽略（Ctrl+Z 除外）。
  - 事件目标是 `INPUT/TEXTAREA/SELECT` 时直接返回。
- 点击棋盘后根节点保持/恢复焦点（棋盘容器 `onMouseDown` preventDefault 或 click 时 `root.focus()`），保证连续键盘输入。
- 计时：
  - 挂载后 `timerResume(now)`；`setInterval` 约 500ms 刷新显示。
  - `document.addEventListener('visibilitychange')`：隐藏 → `timerPause` + 落盘；可见 → `timerResume`（未胜利时）+ 刷新。
  - 每次状态变更落盘；另外每 5s 落盘一次以保住计时；`beforeunload` 不必加（契约只要求卸载落盘）。
  - 胜利时暂停计时。
- 卸载 cleanup：清 interval、摘 visibilitychange、清 ResizeObserver、`timerPause` 后 `saveState`。**恢复时是当前题，绝不重新生成**（只有 `loadSavedState()` 返回 null 或坏档才生成新题）。
- 换难度 / 新游戏 / 重开若有玩家进度（`hasProgress`）先弹确认；无进度直接执行。确认遮罩打开时数字键不生效；Escape 取消。
- 详情文案中文；按钮有 `type="button"`。

## 9. 尺寸与渲染

- 根元素自己撑满；不要读 `window.innerWidth` 判断布局。
- `ResizeObserver` 观察根元素（窗口太小判断）与棋盘区（棋盘尺寸）；`window.addEventListener('resize')` 补充 dpr/缩放变化时重算（DOM 不需要 dpr 缩放，但保持监听以覆盖浏览器 zoom；回调里重算尺寸）。
- 不需要 canvas；`devicePixelRatio` 变化只需重算布局（可把 dpr 存进 size 状态但不要用于字号）。
- 尺寸极小时按 §7.4 显示提示。

## 10. Node 自测 `dev/test-logic.mjs`（dev 必须写并跑通）

- `globalThis.window` 桩（`__DSH_GAME_SUDOKU_TEST__: true`、`__ModuleLoader__.load` 捕获 definition、localStorage Map 桩、`performance`、`document` 可选）。
- `await import('../client.js')`；取 `window.__DSH_GAME_SUDOKU__`；断言 seam 完整。
- 覆盖：
  1. 常量 / store key / 难度目标。
  2. `createRng` 确定性；同 seed + 难度 → 相同 givens。
  3. 生成：三档 × ≥40 个 seed（e.g. 40 easy / 60 normal / 60 hard）：`givensCount` 范围、唯一解（`countSolutions===1`）、solution 合法且与 givens 一致、`genMs < 200`；打印每档 min/mean/p95/max；断言 easy 恰好 40（正常应达到），hard 记录实际最小/中位提示数。
  4. 连续 ≥20 局 givens 互不相同（每局新题）。
  5. 求解器：经典题唯一解、空盘数到 2、矛盾盘 0、非唯一盘 2。
  6. `computeConflicts`：行/列/宫/无冲突/多冲突。
  7. 输入/草稿/擦除/撤销：给定格不可改、同数字二次输入不变、草稿 toggle、填值清草稿、擦除清草稿、逐步撤销恢复 value+notes、撤销栈上限、胜利后输入 no-op。
  8. 重开：棋盘回 givens、草稿/undo 清空、计时归零；新游戏：题目变化且字段复位。
  9. 计时 pause/resume/elapsed（用假 `now`）。
  10. 胜利：按 solution 填满 → won、计时暂停、snapshot 字段；`winAcked` 关闭。
  11. 存档：serialize→sanitize 往返；坏档矩阵（null、版本错、长度错、数字越界、givens 冲突、solution 与 givens 不一致、给定格 board 不一致、notes 越界、elapsed 越界、selected 越界、undo 坏条目）；500 次随机篡改不抛；`loadSavedState` 在 JSON 坏/localStorage 抛错时返回 null。
  12. `formatTime` 边界。
- 失败非零退出；成功打印 `PASS n / FAIL 0`。脚本只用 node 内置模块，无第三方依赖。

## 11. 文件所有权（避免互相覆盖）

| 文件 | 负责人 |
|---|---|
| `packages/dsh-game-sudoku/client.js` | **sudoku-dev** |
| `packages/dsh-game-sudoku/dev/test-logic.mjs` | **sudoku-dev** |
| `packages/dsh-game-sudoku/dev/audit/**` | **sudoku-verifier** |
| `package.json` / `cordis.patch.yml` / `index.js` / `locale/*` / `icon.svg` / `README.md` / `dev/preview.html` / `dev/fake-react.js` / `dev/screenshots/**` / `handoff/from-sub/008-report-sudoku.md` | **Lead** |
| 宿主与其它游戏包 | 谁都不许改 |

写文件一律用 `write` / `edit` 工具（本机 shell 写盘被沙箱拒绝，node 只读运行没问题）。

## 12. 验收对照（报告里逐条给证据）

- 目录出现「数独」：manifest + registration。
- 每局新题、唯一解：§10.3/4 + verifier 独立求解器复核。
- 输入/擦除/草稿/撤销正常、冲突标红：Chromium 联调（Lead）+ 逻辑测试。
- 胜利判定：Chromium 填满 + 逻辑测试。
- 切走再回来保留当前题与进度（不重新生成）：Chromium remount + 存档断言。
- 缩放跟随、暗色可读、控制台无 `slot entry crashed`：Chromium 多尺寸/主题截图 + 0 error。
- 生成 <200ms：逻辑测试统计 + verifier 独立复测。

## 13. 非目标

- 不做逻辑难度分级（难度只影响提示数）。
- 不做自动检查/提示、候选自动清理、暂停按钮、最佳成绩、i18n、触屏手势。
- 不实现 `dev/test-headless.mjs`（UI 由 Lead 的 Chromium 预览验收）。
