# 独立审计报告 —— `@local/dsh-game-sudoku`

> 审计人：**sudoku-verifier**（独立验证，不信任实现者自测）
> 日期：2026-10-18（Asia/Shanghai）
> 目标：`packages/dsh-game-sudoku/`（client.js + 包清单）
> 审计脚本：`packages/dsh-game-sudoku/dev/audit/`（仅 node 内置模块，不在实现代码内运行）
> 环境：Windows 10.0.26200 / Node v24.16.0 / shell 运行（非浏览器；Chromium E2E 由 Lead 负责）

**最终结论：PASS**（无未修缺陷；保留 §6 的规格歧义说明与 §7 的审计局限）

- `audit-contract.mjs`：**PASS 35 / FAIL 0**（含 README 检查）
- `audit-generate.mjs`：**PASS 16 / FAIL 0**
- `audit-state.mjs`：**PASS 38 / FAIL 0**（含 `toggleNotesMode` 胜利门禁复验）
- `selftest-reference.mjs`（审计自身 oracle 自检）：**PASS 6 / FAIL 0**
- `run-all.mjs`：`AUDIT SUITE: all 4 scripts passed`

首轮曾发现 1 个 LOW 实现缺陷（D1，已修复复验）与 1 个 Lead 待办（README，已交付），详见 §5/§8。

---

## 1. 方法与独立性

- 全部检查由 verifier 重新实现：`harness.mjs`（window/document/localStorage/ModuleLoader 桩 + vm 隔离上下文 + ctx 桩）与 `reference.mjs`（**从零编写的参考求解器**）。
- 参考求解器与实现刻意不同源：候选集合用 `Set`（实现用 9 位整型位掩码）、MRV 平局从下标 80 向下扫描、候选数字**降序**尝试；不接受实现导出的任何求解/生成逻辑。
- `selftest-reference.mjs` 先自证 oracle：经典题唯一解、空盘 limit 语义、无解盘 0 解、冲突图与独立 O(n²) 暴力对拍 300 局、随机残局解合法性。
- 未运行/未引用 `dev/test-logic.mjs` 作为判据（仅作为补充信息单独记录，见 §7）。
- 所有证据均由脚本打印 `EVIDENCE` 行（可复现），本报告数字直接取自运行输出。

## 2. 复现命令

```powershell
cd D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-sudoku
node dev/audit/selftest-reference.mjs   # oracle 自检
node dev/audit/audit-contract.mjs       # 契约/清单/注册/seam/静态 UI/仓库完整性
node dev/audit/audit-generate.mjs       # 生成/求解/计时/确定性/唯一性
node dev/audit/audit-state.mjs          # 语义/计时/胜利/存档 fuzz
node dev/audit/run-all.mjs              # 以上全部
```

依赖文件：`harness.mjs`、`reference.mjs`、`_baseline-outside-sudoku.json`（开工时对 sudoku 包以外 77 个文件的 sha256 基线）。

## 3. 结论汇总

| 审计域 | 检查数 | 结果 | 关键证据 |
|---|---|---|---|
| 包清单 / cordis / locale / icon / index.js / README | 7 | PASS | README.md 已交付（5473 bytes，含 数独/dsh-game-sudoku） |
| 注册形状（window+ctx 桩） | 5 | PASS | id `sudoku`、label 数独、只 `inject:['slots']`、单次 game.stage 注册、MATCHED 冻结且引用稳定、错误被 try/catch 且带 `[dsh-game-sudoku]` 前缀 |
| 测试 seam（仅 flag 时存在） | 4 | PASS | 全新 vm 上下文：无 flag / flag=1 均无全局；`=== true` 才安装；defineProperty 方式 |
| 静态 UI / bundle 卫生 | 14 | PASS | 无 window/document keydown；根 100%×100%+token 色+tabIndex0；12 类 data-*；数值键/遮罩/too-small；清理与落盘 wiring；createSession 先恢复后生成；无 canvas；仅 require('react')；7 处 console.error 全带前缀 |
| 独立求解器对拍 | 5 | PASS | 经典题/空盘/无解盘/非法输入 TypeError；180 个随机残局解数一致（60 唯一 / 120 多解或 0 解） |
| 生成正确性（3×120 seeds） | 4 | PASS | 360/360 唯一解（引擎+独立 oracle 双向确认）、解==oracle、givens 无冲突、元数据自洽 |
| 生成计时（<200ms 硬约束） | 1 | PASS | 见 §4.2；max=1ms |
| 确定性与新题 | 3 | PASS | 同 seed 同题；25/25 与 21/21 连续新题互不相同 |
| 纯逻辑语义（§4） | 21 | PASS | applyDigit/notes/erase/undo/restart/newPuzzle/计时/胜利门禁/snapshot/formatTime 全部符合 |
| 存档健壮性 | 8 | PASS | 2000 fuzz 0 throw、300 load fuzz 0 throw、38 拒绝矩阵全中、手工经典题存档原样恢复（不重生成）、自动落盘保住计时 |
| 仓库完整性 | 1 | PASS | sudoku 包外 77 个文件 sha256 均未变 |

## 4. 证据明细

### 4.1 契约 / 清单 / 注册

- `package.json`：`name=@local/dsh-game-sudoku`、`v0.1.0`、`private`、`type=module`；`exports` = `["." ,"./client","./locale/*.json","./icon"]`；`dsh.bundle.patch=./cordis.patch.yml`；`dsh.client={platform:'web',immediately:true}`；**无 dependencies/devDependencies**、**无 dsh.client.inject**；`files[]` 列全运行期文件（含 README.md）。
- `cordis.patch.yml`：`- insert: - id: game-sudoku / name: '@local/dsh-game-sudoku'`（单条）。
- `index.js`：仅 `export function apply() {}`，无副作用/import。
- `locale/zh.json`：`meta.title=数独`、description 非空；`locale/en.json`：`meta.title=Sudoku`。
- `icon.svg`：有 `<svg>` 根、无脚本。
- 注册形状（Node 桩，`client.js` 经 `__ModuleLoader__.load` 捕获）：definition.id 与包名一致；`require` 仅 `react`；`plugin.inject=['slots']`；`apply(ctx)` 只对 `game.stage` inject 一次并 register 一次，`{name:'game.stage', id:'sudoku', label:()=>'数独'}`，component 为函数；`select({gameId:'sudoku'})` 返回冻结单例 MATCHED（两次调用同一引用），`{gameId:'2048'}`、`{}`、`null`、`undefined`、`'sudoku'` 均返回 null；inject 抛错/register 抛错被吞并 `console.error('[dsh-game-sudoku] ...')`；host 未 inject 时 `apply` 静默 no-op。
- seam：flag 缺席的**全新 vm 上下文**中 `window` 无 `__DSH_GAME_SUDOKU__` 属性；`__DSH_GAME_SUDOKU_TEST__ = 1`（truthy 但非 `=== true`）同样不安装；`true` 时安装且含 26 个文档函数；安装方式为 `Object.defineProperty`（client.js:854-856）。
- 静态 UI（client.js 2385 行）：无 `window/document.addEventListener('keydown')`；根 `data-dsh-game`（1290/1831/2310 行）+ `width/height:'100%'` + `boxSizing:'border-box'` + token 背景/前景 + `tabIndex:0` + focus；`data-sudoku-board`、`data-cell`、`data-given`、`data-value`、`data-selected`、`data-peer`、`data-conflict`、`data-digit`、`data-action`、`data-overlay`、`data-role`、`data-difficulty` 全部存在；actions notes/undo/restart/erase/dismiss-win/confirm/cancel、overlays win/confirm/error、roles timer/remaining/too-small、320/240 阈值均在；ResizeObserver 观察根与棋盘区并 `disconnect`；`setInterval(500)` 刷新、`setInterval(5000)` 自动落盘、`visibilitychange` 暂停/恢复、cleanup 里 `clearInterval`×2 + `removeEventListener`×2 + `observer.disconnect` + `timerPause` + `saveState`；无 `window.innerWidth/innerHeight`、无 canvas/getContext；`newSession` 先 `loadSavedState()`，仅当 `restored` 为空才 `createState()`（client.js:1221-1242）；无第三方 import/require。
- 仓库完整性：开工时对 `packages/dsh-game-host`、其它 5 个游戏包（排除各自 `dev/audit`、`dev/screenshots`）共 **77 个文件**做 sha256 基线，审计时全部未变。

### 4.2 生成（3 档 × 120 seeds = 360 局）

每局均验证：`countSolutions(givens,2)===1`（引擎）**且** 独立 oracle 亦为 1；`solve(givens)` 与存储 solution 一致且等于 oracle 唯一解；solution 为合法完整盘；givens 与 solution 一致；givens 冲突图（引擎 + oracle）全 0；`givensCount`、`targetGivens`、`digRemoved=81-givensCount`、`digAttempts>=digRemoved`、`digPasses=1` 自洽。

| 难度 | 局数 | 实际 givens | wall 计时 ms（min/mean/p95/max） | 自报 genMs（min/mean/p95/max） |
|---|---|---|---|---|
| easy | 120 | 40/40/40/40（全 40） | 0 / **0.142** / 1 / **1** | 0 / 0.142 / 1 / 1 |
| normal | 120 | 34/34/34/34（全 34） | 0 / **0.092** / 1 / **1** | 0 / 0.092 / 1 / 1 |
| hard | 120 | 28/28/28/28（全 28） | 0 / **0.208** / 1 / **1** | 0 / 0.208 / 1 / 1 |

（首轮数字 easy/normal/hard mean = 0.092/0.117/0.233；两次运行 max 均为 1ms，结论一致。计时受并发 agent 调度轻微影响，但离 200ms 上限有 >100× 余量。）

- 200ms 硬约束：360 次调用 **无一次 ≥ 100ms**，更无 >200ms；`EVIDENCE slowCalls []`。余量 >100×。
- 确定性：同难度同 seed 两次生成 givens/solution 完全一致（seeds 0/7/424242 × 3 档）。
- 新题：25 个连续 seed 生成 25 局互不相同；`createState` 后连续 20 次 `newPuzzle` 共 21 局互不相同。
- `createRng`：同 seed 流一致、输出 ∈ [0,1)、不同 seed 流不同。
- 非法难度回退 normal（`'expert'`、`undefined`、`null`、`'HARD'`、42），且回退题仍通过全套唯一性校验。
- 求解器边界：经典题（30 givens）唯一；空盘 limit=2/3/5 分别返回 2/3/5；**无冲突但无解**的构造盘返回 0（不抛）；非法输入（null/长 80/长 82/数字 10/-1/1.5/字符串/同行重复）→ 抛 `TypeError`。
- `computeConflicts`：200 个随机盘 + 260 次（含完整解与 givens）与独立实现逐格一致，值域仅 0/1；`countEmpty`/`isSolved` 100 随机盘对拍一致。

### 4.3 存档与 fuzz

- `serializeState`：`schemaVersion:1` + §6 全字段，无 `runningSince` 泄漏；JSON 可往返。
- `sanitizeSave` **fuzz 2000 例**（800 随机 junk + 1200 对合法存档随机篡改）：**0 抛异常**；1538 拒绝、462 接受；**接受的所有输出均通过独立不变量校验**（81 长度/值域/≥17 givens/无冲突/solution 合法完整且与 givens 一致/board 给定格一致/notes 合法且给定与有值格为 0/elapsed 整数且 ≤604800000/selected null 或 0..80/undo ≤300 且条目合法且不指向给定格/won==isSolved(board)）。
- `loadSavedState` **fuzz 300 例**（坏 JSON + 随机字符编辑）：**0 抛异常**；292 拒绝、8 恢复且均通过不变量校验。
- 拒绝矩阵 **38/38** 全部拒绝：非对象/schemaVersion≠1/difficulty 非法/givens 缺失或长度或越界或 <17 或冲突/solution 缺失或长度或越界或非完整盘或与 givens 不一致（用 1↔2 全局置换的合法完整盘构造不一致）/board 缺失或长度或越界或给定格被改/notes 长度错误。
- 归一化（不拒绝）：selected 越界→null；elapsedMs -100→0、999999999→604800000；notesMode/winAcked 仅 `=== true`；给定/有值格 notes→0；坏 undo 条目被过滤、>300 截断；`won` 由 board 重新推导（存档伪造 `won:true` 但盘未满→false）。
- 恢复不重生成：手工构造 CLASSIC 题（30 givens）存档（含玩家填写/草稿/undo/selected/elapsed=12345）→ `loadSavedState` 逐字段原样恢复，两次加载同一题；证明恢复路径不调用生成器。
- 计时持久化：运行中 `saveState(state, now=6000)` 落盘 `elapsedMs=5000`，load 后 5000，`timerResume` 后继续累加（5000+2000=7000）——自动落盘不会丢时间。
- `saveState` setItem 抛错→false 不抛；`loadSavedState` getItem 抛错→null 不抛；缺失 key/坏 JSON/版本不符→null。

### 4.4 §4 语义（逐条）

- `applyDigit`：胜利/给定/越界→false 无副作用；普通模式同数字二次→false 不自动擦除；改值 push `{index,prevValue,prevNotes}`；填值清 notes；冲突值允许（`computeConflicts` 标 1）；草稿模式 toggle `1<<(d-1)`、有值格→false、清除/设置均 push undo。
- `eraseCell`：胜利/给定/空（board 与 notes 均 0）→false；否则清 board+notes 并 push undo；草稿格删除返回 true 并清草稿（符合 §10.7「擦除清草稿」，见 §6 歧义说明）。
- `undoMove`：LIFO、栈空/胜利→false、恢复 value+notes、跳过并消费指向给定格的坏条目、栈上限 300、撤销不重启计时。
- `restartPuzzle`：board=givens、notes/undo 清空、elapsed=0、won/winAcked=false、runningSince=now、题/难度不变、有效 selected 保留/无效设 null。
- `newPuzzle`：按给定 rng 确定性换题、字段全复位、selected=null、计时归零重启、非法难度回退 normal。
- 计时：elapsed 计算、负增量 clamp 0、pause 幂等、resume 幂等且不重置起点、pause 在起点之前不增时。
- 胜利：最后一格落子后 `won=true, winAcked=false`、计时在胜利时刻冻结（elapsed=410ms@seed4321）、之后 applyDigit/erase/undo 均 false 无副作用；restart/newPuzzle 清除 won/winAcked。
- `getSnapshot`：不改变 state；暴露 board/notes/won/notesMode/difficulty/selected/givens/solution/winAcked/elapsedMs/remaining/running/timerText/conflicts/canUndo，抽查与状态一致。
- `formatTime`：0/1/999→`00:00`，1000→`00:01`，60000→`01:00`，600000→`10:00`，3599999→`59:59`，3600000→`1:00:00`，3661000→`1:01:01`，36000000→`10:00:00`。
- `hasProgress`：独立 oracle 100 次随机操作序列对拍一致；填满→undo 回初始→false。

## 5. 缺陷 / 待办（均已关闭）

### D1（LOW，已修复并复验）`toggleNotesMode` 未受胜利状态保护

- 规格：api-spec §4「计时在胜利时暂停；**`won` 状态禁止一切填写/擦除/撤销/草稿**」。
- 首轮位置：`client.js:486-490`（当时无 `won` 判断，胜利后 `toggleNotesMode` 返回 true 并翻转 `notesMode`）。
- 首轮最小复现（seam）：
  ```js
  const s = createState({ difficulty:'easy', rng: createRng(4321), now: 5000 })
  for (const i of empties) applyDigit(s, i, s.solution[i], (now += 10))   // 胜利
  toggleNotesMode(s)   // 首轮实际: true 且 s.notesMode 翻转；期望: false 且不变
  ```
- **修复**：`client.js:486-489` 现为
  ```js
  function toggleNotesMode(state) {
    if (!state || state.won) return false
    state.notesMode = !state.notesMode
    return state.notesMode
  }
  ```
- **复验（2026-10-18 17:14）**：`audit-state.mjs` 检查 `won state also freezes pencil mode` 由 FAIL 转 **PASS**；全量 state 审计 **PASS 38 / FAIL 0**。
- 实现者自测覆盖：`dev/test-logic.mjs:1039` 与 `:1052-1062` 已新增「胜利后 toggleNotesMode 被拒绝」断言（修复前无此断言，修复时同步补上），与 verifier 检查一致。
- 影响评估：仅引擎契约层（UI 胜利遮罩挡住操作，玩家不可见），故 LOW。

### P1（已关闭，Lead 负责）`README.md` 已交付

- 首轮 `package.json` 的 `files[]` 列出 `README.md` 但文件缺失；现已写入（5473 bytes，UTF-8，含 `数独`/`dsh-game-sudoku`/安装路径），`audit-contract.mjs` README 检查转 PASS（contract **35/0**）。

## 6. 规格歧义 / 已接受行为（不作为缺陷）

- `eraseCell` 对「仅有草稿的格子」返回 true 并清草稿；§4 字面「本来就空→false」与 §10.7「擦除清草稿」两读，实现取后者，verifier 接受。
- `sanitizeSave` 宽松输入（实测记录，规格未细规定）：接受 JSON 字符串输入并解析；`elapsedMs` 浮点四舍五入接受；`undo` 非数组→按空数组；`targetGivens` 非数→按难度回退；`winAcked` 缺失→false；而 `notes` 缺失/越界 512、`elapsedMs` 字符串则拒绝。均不会产生非法状态，接受。
- `getSnapshot` 形状未被规格冻结：实际返回 16 个键（见 EVIDENCE snapshotKeys），verifier 按「存在即校验」处理。
- `toggleNotesMode` 返回值语义（返回新的 notesMode）规格未明说；除胜利场景外行为合理。
- `serializeState` 额外输出 `genMs/givensCount/digAttempts`（§5 允许可选生成统计）。
- `selectCell` 重复点击同一格返回 false（规格未规定返回值语义，只要求能选中）。
- `moveSelection` 在边界 clamp 时返回值未规定；只有选中位置被断言。

## 7. 审计局限

- 无浏览器/DOM：不验证真实渲染、ResizeObserver 实际尺寸、暗色主题、键盘焦点流转、遮罩交互、切页 remount 行为——这些由 Lead 的 Chromium E2E 覆盖。静态 UI 断言是「字面/结构存在性」检查，不能证明运行时视觉正确。
- 未做 React 组件级渲染测试（无 React 运行时；`dev/fake-react.js`/preview 由 Lead 维护）。
- 静态检查对动态拼接的属性值不敏感（如 `data-digit` 值是否 1..9 逐个渲染、81 格是否真的循环 0..80），但生成/快照/冲突等逻辑层已独立验证。
- 计时为当前机器（并发运行其它 agent）实测；由于 max=1ms，机器噪声不影响 <200ms 结论。
- 实现者自测 `dev/test-logic.mjs` 亦运行通过（最终 PASS 51 / FAIL 0，含胜利后 notes 门禁断言；首轮为 PASS 50），但**不作为本报告判据**，仅作补充。

## 8. 复验记录

| 时间（Asia/Shanghai） | 事件 | 结果 |
|---|---|---|
| 2026-10-18 17:13 | 首轮完整审计（client.js 77543 bytes / 2385 行） | contract 34/1（README 缺失）、generate 16/0、state 37/1（D1）、oracle 6/0 |
| 2026-10-18 17:14 | Lead 补 README（17:13:29）+ dev 修 D1（client.js 17:13:35，`if (!state || state.won) return false`）后全量复验 | **全部通过**：selftest 6/0、contract **35/0**、generate **16/0**、state **38/0**、`AUDIT SUITE: all 4 scripts passed`；`toggleNotesMode` 胜利门禁检查转 PASS；包外 77 文件基线未变；dev 自测 PASS 51/0 |

**最终判定：PASS。** 无未修缺陷；§6 的歧义项均为规格未规定、实现行为合理且不产生非法状态；§7 列出的浏览器/视觉类验收由 Lead 的 Chromium E2E 覆盖。
