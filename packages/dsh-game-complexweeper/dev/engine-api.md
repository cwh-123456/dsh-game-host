# Complexweeper 引擎 API 与 UI 约定（dev 内部，不随包发布）

> 维护者：Lead。这是 Lead ↔ rules-test ↔ client-dev 的分工契约。
> **engine.js 由 Lead 冻结**：已按 `game.zig` 逐条移植并通过 3109 项冒烟断言。
> 除 Lead 主动通知，任何人不要改 engine.js；若 Lead 改了，client-dev 必须重新逐字节内联。

## 1. 加载 engine.js

`engine.js` 是 IIFE（不是 ESM），执行后把 API 挂到 `window`/`globalThis` 的 **`CS`** 上，
并兼容 `module.exports`（CJS 环境）。node（包是 `"type":"module"`）里这样取：

```js
await import('../engine.js')
const E = globalThis.CS          // { MAX_W, ..., Rng, Game, PRESETS, MSG, splitEvenly, ... }
```

浏览器里：`client.js` 在 IIFE 内逐字节内联 engine.js，取走 `CS` 后**必须还原**
（进入前有 `CS` → 恢复原值；没有 → `delete`），不得污染全局；只有测试探针开关打开时
才安装 `window.__DSH_GAME_COMPLEXSWEEPER__`（见 §6）。

## 2. 常量

| 名字 | 值 | 说明 |
|---|---|---|
| `MAX_W` / `MAX_H` / `MAX_CELLS` | 40 / 30 / 1200 | 同 game.zig |
| `MAX_MINES` | 999 | |
| `TYPES` | `[[1,0],[-1,0],[0,1],[0,-1]]` | mine[] 存 1..4，索引 = 值−1 |
| `MODE` | `MODE.COMPLEX=0`, `MODE.HYPER=1` | v1 只用 COMPLEX |
| `ACHIEVABLE` | 24 个平方值 | `0,1,2,4,5,8,9,10,13,16,17,18,20,25,26,29,32,34,36,37,40,49,50,64` |
| `PRESETS` | `[{id:1,w:9,h:9,mines:10,label:'初级 9×9 · 10 雷'}, {id:2,16,16,40}, {id:3,30,16,99}]` | 三档 |
| `MSG` | `{NONE:0,STARTED:1,JUDGE_FAIL:2,EXPAND_OK:3,WIN:4,LOSE:5}` | 操作反馈 |
| `ENGINE_INFO` | `{engine, port, reference, upstream, license, modes}` | 来源信息 |

## 3. `class Game`

构造：`new Game({ w?, h?, mines?, typeCount?, mode?, judgeLoose? })`
默认 `9×9 / 10 雷 / COMPLEX`。字段名（公开，可读）：

`w, h, n, mode, judgeLoose, mine, clue, open, flag, seed, rng, mines, typeTotal, flagsOf,
typeCount, started, over, win, boom, startCell, elapsedMs, t0, moves, msg, msgArg`

- `mine/clue/open/flag` 是 `Uint8Array/Int16Array`，长度 `MAX_CELLS`，**只有前 `n` 个有效**。
  `clue[]`：雷格 = −1；非雷格 = 模长平方（圆复数模式 0..64）。
- `typeTotal[1..4]` / `flagsOf[1..4]` 是 `Uint16Array(5)`，下标 0 不用。
- `game.mines` = 实际雷数（genBoard 可能因首点安全区不足而 clamp）。

方法（语义 1:1 同 game.zig，参数越界一律安全 no-op / false）：

| 方法 | 返回 | 说明 |
|---|---|---|
| `inb(r,c)` | bool | |
| `nbrs(cell)` | `number[]` | 8 邻域，行优先 dr/dc 顺序 |
| `nbrMineCount(cell)` / `nbrFlagCount(cell)` | number | |
| `isBlank(cell)` | bool | 邻域零雷；**只有它连片** |
| `flagsTotal()` / `unmarked(t)` | number | 未标记数可为负（旗不限量） |
| `newGame(seed)` | void | 清盘、复位、设种子；**棋盘等首点**；`mines`/`w`/`h` 保持 |
| `startAt(cell, nowMs)` | void | 首次翻开：setSeed → genBoard → 连片 → started，moves=1 |
| `genBoard(startCell)` | void | 布雷 + 线索 + 首点连片；首点格及其 8 邻域安全 |
| `computeClues()` / `countTypes()` | void | |
| `sumsOf(cell, useFlag)` | `[a,b]` | 邻域旗/雷的实部、虚部（任务书里写作 sumOf；引擎只导出 sumsOf） |
| `cascadeOpen(seeds)` | 新翻开数 | 只穿空白格，跳过已翻开/雷/旗 |
| `setFlag(cell,t)` / `cycleFlag(cell)` | bool | t=0..4；循环 0→1→2→3→4→0；已翻开不能插 |
| `reveal(cell, nowMs)` | void | 有旗翻不开；雷 → lose；空白 → 连片；之后 checkWin |
| `matchComboTruth(cell)` | bool | 圆复数判据：邻域旗数=雷数 且 (P,V) 与 (gp,gv) 相等或互换 |
| `tryExpand(cell)` | void | 已翻开的非雷格；判据失败 → `msg=JUDGE_FAIL` 且棋盘不变；通过 → 翻开未插旗邻格，踩雷则 lose；`msg=EXPAND_OK` |
| `checkWin()` | void | **翻开所有非雷格** → over + win + msg=WIN |
| `lose(cell)` | void | over, win=false, boom=cell, msg=LOSE |
| `openedCount()` / `safeCount()` / `correctFlags()` / `typeSum()` | number | 复盘/统计用 |
| `snapshot()` | 纯 JSON 对象 | 存档用（§4） |
| `Game.fromSnapshot(snap)`（静态） | `Game \| null` | 结构+一致性校验；坏档返回 null，不抛错 |

注意 `tryExpand` 紧随的 `msgArg` 恒为 0（Zig 里 `setMsg` 会清零，忠实移植，不要"修"）。
首次点击前允许插旗（与 Zig 一致），旗会带进新棋盘。

## 4. 存档格式（client.js 唯一负责 localStorage）

key：**`dsh.game.complexweeper.v1`**（不要碰 `dsh.game.2048.v1` / minesweeper / quoridor）

```js
JSON.stringify({
  schemaVersion: 1,
  difficulty: 1,            // 1|2|3：工具栏选中态；必须与 state 的尺寸对应，否则开新局
  state: game.snapshot(),   // 引擎快照（含 elapsedMs）
})
```

恢复：`JSON.parse` → `schemaVersion === 1` → `Game.fromSnapshot(obj.state)` 非 null
→ 成功（用快照里的 w/h/mines/typeCount，不要相信存档外的字段）；任何一步失败 →
清 key 并开新局，**不抛错**。落盘时机：每次操作后 + `document.hidden` 时 + 卸载（destroy）时。

## 5. 单文件与内联锚点（client-dev 必须照做）

`client.js` 是浏览器唯一入口，包内相对路径 `require` 不可用，所以 engine.js **必须逐字节内联**。
锚点（各恰好出现一次）：

```js
/* >>> DSH INLINE ENGINE BEGIN (verbatim copy of ./engine.js) >>> */
<engine.js 全文，逐字节>
/* <<< DSH INLINE ENGINE END <<< */
```

`dev/verify-inline.mjs` 会从 `client.js` 抽取 BEGIN 行换行之后到 END 锚点之前的字节，
与 `engine.js` 做 `Buffer.compare` 必须为 0。修改 engine.js 后必须重新内联并复跑。
（引擎自己的注释里**不要**出现这两个锚点字符串——已确保没有。）

## 6. 测试探针（供 dev 脚本；正常运行不暴露）

`client.js` 里当 `window.__DSH_GAME_COMPLEXSWEEPER_TEST__ === true` 时安装：

```js
window.__DSH_GAME_COMPLEXSWEEPER__ = { E, Game: E.Game, GAME_ID, STORE_KEY, MATCHED, createGame }
```

`dev/selftest.mjs` 可以直接 `import '../engine.js'`（不依赖 client.js）；
`dev/test-headless.mjs` / `dev/verify-inline.mjs` 走假 window + `__ModuleLoader__` + 探针。

## 7. 接入与 UI 要求（照任务书 + 契约 v1）

- `ctx.slots.inject('game.stage', () => ctx.slots.register({ name:'game.stage', id:'complexweeper',
  label:()=>'复扫雷', select:({gameId}) => gameId==='complexweeper' ? MATCHED : null }, Game))`；
  `MATCHED` 冻结且恒等；`inject` 只有 `['slots']`；不提供别的服务/slot。
- 左键翻开 / 首点开局；右键循环四类旗（阻止 contextmenu）；双击已翻开数字格**或中键**展开。
- 顶部：三档难度、重开、四个类型的总数（+1/−1/+i/−i，配色区分）、已插旗分类计数、
  计时、状态文案（判定失败要有明显反馈，不能静默）。
- 格子渲染：未翻开 / 已翻开（24 种值：整数直接显示；根式 `√2`、`2√2`、`3√2`、…）；
  四类旗；踩雷爆炸；结局复盘（标对/标错的旗都要能看出来）。
- canvas 自绘 + `ResizeObserver` + `devicePixelRatio`；根元素 `width:100%;height:100%`；
  `<320×240` 显示「窗口太小」；面板切换会卸载 → 卸载前落盘；`document.hidden` 暂停计时。
- 容器/文字用 `var(--dsw-alias-*)` token；棋盘配色自定但明暗主题都要可读。
- **不注册任何全局键盘监听**（窗口/document/根元素都别挂，纯鼠标）；不 `document.body` 挂节点、
  不改 `document.title`；不联网、不引第三方库（React 从 `require('react')` 拿）。
- 运行期错误 → 游戏内可读提示 + 重开/重试，不白屏；全部 try/catch。

## 8. 测试要求

- `node dev/selftest.mjs` 全绿（selftest.zig 的规则用例翻译 + 独立参照实现差分）。
- `node dev/verify-inline.mjs` 全绿（内联逐字节 + 探针 API + 关键规则断言）。
- `node dev/test-headless.mjs` 全绿（假 DOM 跑 createGame：点击/右键/双击/中键/存档/恢复/
  hidden 暂停/dpr/缩放/destroy/损坏存档）。
- 所有测试脚本只读或只写 `dev/` 下自己的文件；测试不能改 engine.js / client.js 以外的东西。
