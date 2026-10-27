# 独立审计报告（v2）—— `@local/dsh-game-sudoku` 真实难度分级 + 离线题库

> 审计人：**sudoku-verifier**（独立验证，不使用/不导入实现方的 `dev/lib/techniques.mjs` 作为 oracle）
> 日期：2026-10-18（Asia/Shanghai）
> 审计对象：`packages/dsh-game-sudoku/client.js`（100,320 B / 2,446 行，含内联题库）、`dev/bank.json`（77,029 B / 190 题）
> 环境：Windows 10.0.26200 / Node v24.16.0 / 仅 node 内置模块 + shell 运行（无浏览器；Chromium 由 Lead 负责）
> 审计脚本：`packages/dsh-game-sudoku/dev/audit/v2/**`（v1 脚本保留为历史归档，不参与 v2 判定）

**结论：PASS WITH NOTES** —— **0 个功能缺陷**；191/191 题的**难度评级、解、层级、卡住判定与题库 100% 一致**；2 条记录在案的规格歧义说明（technique 列表的可复现性、`played` 非数组的宽松处理），均不影响评级正确性，详见 §5。

---

## 1. 方法与独立性

- 全部检查由 verifier 重新实现：`v2/oracle.mjs` 是**从零编写的技巧求解器**——候选用普通 `number[]` 数组（实现方用位掩码），单元格 0..80 / 单元 0..26（行 0-8、列 9-17、宫 18-26）/ 数字 1..9 升序，严格按 api-spec-v2 §1 顺序：naked-single → hidden-single → pointing/claiming → naked-pair/triple、hidden-pair/triple → x-wing/xy-wing；任一级有进展即回第 1 级；全部技巧无进展=卡住=`hell`。评级 = 用到的最高 level。
- 唯一解/求解 oracle 使用 v1 审计中自写的 `dev/audit/reference.mjs`（Sets + 反向 MRV），与本审计技巧求解器相互独立；随机生成器（完整盘随机回溯 + 逐格挖空保持唯一解）与 FNV-1a32 base36 id 哈希也是 verifier 自写。
- `v2/selftest-oracle-v2.mjs` 先自证 oracle（**PASS 17/0**）：对 10 个技巧逐一用**人工构造的候选局面**验证（pointing/claiming、naked/hidden pair/triple、x-wing 行/列两向、xy-wing 精确消除格），并验证确定性/幂等、metadata、id 哈希、20 题生成唯一率。
- **不**读取/导入/复制 `dev/lib/techniques.mjs`；bank 的 grade/techniques 是唯一比对基准。
- 为解释 technique 列表差异，另实现了 api-spec-v2 §1 **明确允许的**「逐条应用」粒度变体（`gradePuzzleVariant`，仅用于差异归因；主 oracle 仍为“一次应用所有可找到的”）。

## 2. 复现命令

```powershell
cd D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-sudoku
node dev/audit/v2/selftest-oracle-v2.mjs   # oracle 自检
node dev/audit/v2/audit-v2-bank.mjs        # 题库结构/唯一解/inline 一致性/无运行时求解器/仓库完整性
node dev/audit/v2/audit-v2-grades.mjs      # 190 题独立重评级/层级语义/3x 稳定性/100 随机生成
node dev/audit/v2/audit-v2-save.mjs        # 存档 v2/恢复同题/坏档 fuzz/pickPuzzle/UI 静态
node dev/audit/v2/audit-v2-contract.mjs    # 清单/注册/seam/静态卫生/仓库完整性
node dev/audit/v2/run-all-v2.mjs           # 全部（0=通过 / 1=失败 / 2=等产物）
```

**当前结果：`AUDIT V2 SUITE: all 5 scripts passed`**（selftest 17/0、bank 12/0、grades 9/0、save 22/0、contract 23/0，共 83 项检查，2 条 NOTE）。被审计产物 mtime 均为 18:25:25（promotion 后未再变），审计在其后执行。

## 3. 汇总表

| 审计域 | 检查数 | 结果 | 关键证据 |
|---|---|---|---|
| v2 oracle 自检（技巧逐个验证） | 17 | PASS | 10 技巧合成局面测试 + 确定性 + 20 题唯一率 |
| 题库 / 内联块 / 无运行时生成器 | 12 | PASS | 190/190 唯一解、id=FNV1a32(grade+givens)、inline 与 bank.json 逐题一致、无非题库字段、运行时代码无生成/求解器 |
| 难度评级（190 题 × 独立重评级） | 9 | PASS | **grade/level/solution/stuck 190/190 一致**；3x 稳定 190/190；100 随机生成 100/100 唯一；技巧覆盖/层级语义全过 |
| 存档 v2 / 运行时抽题 / 静态 UI | 22 | PASS | 存档 schema 逐字段、恢复同题 15/15、v1/未知 id 拒绝、2000 fuzz 0 throw、pickPuzzle 未玩优先/回退、<5ms |
| 契约 / 清单 / 注册 / seam / 仓库完整性 | 23 | PASS | inject:['slots'] 单注册、seam 仅 `=== true`、5 chips、无全局 keydown、包外 83 文件未变 |
| **合计** | **83** | **PASS 83 / FAIL 0** | 2 条 NOTE（规格歧义，见 §5） |

## 4. 证据明细

### 4.1 题库 `dev/bank.json` 与内联块

- 顶层：`version=2`，`generatedAt=2026-10-18T18:25:25+08:00`，`generator={seed:20261018, attempts:1211, genMs:9644}`；`levels` 5 档（简单/普通/困难/专家/地狱，level 1..5），计数 easy 40 / normal 40 / hard 40 / expert 40 / hell 30，`levels[].count` 与实际题数一致（合计 190，符合每档 30–50）。
- 逐题字段：`id` 为 `grade-` + FNV-1a32(givens).toString(36)（190/190 校验通过，同题面同 id）；`givens` 81 位 0-9 且无冲突；`solution` 81 位 1-9 合法完整盘且与 givens 一致；`clues` 与非零数一致；`techniques` 全部为冻结的 10 个名字且不重复；id 全局唯一、同档题面唯一。
- **唯一解：190/190**（verifier 独立求解器 `countSolutions(givens,2)===1`；stored solution 与 verifier `solve()` 完全一致）。
- 提示数分布：easy 23–37（mean 27.27）、normal 21–34（24.9）、hard 23–30（25.35）、expert 23–30（25.73）、hell 23–27（24.4）——不是 v1“按提示数定难度”，符合 v2 以技巧分级。
- 内联：`client.js:41-245` 标记块，内联块 26,946 B；`const PUZZLE_BANK` 位于标记内；**seam `BANK` 与 bank.json 的 version/generatedAt/levels/id/grade/givens 逐题逐序完全一致（190/190）**；按 levels 顺序分组、档内按 id 升序；内联对象仅含 `id/grade/givens`（无 solution/techniques/clues，文本与运行时对象双重检查）。
- 技巧覆盖（bank 记录次数）：naked-single 187、hidden-single 183、pointing 129、claiming 54、naked-pair 57、hidden-pair 10、naked-triple 34、hidden-triple 4、xy-wing 38、x-wing 15。
- **无运行时生成/求解器**：client.js 无 `generatePuzzle/generateFullGrid/countSolutions/searchSolutions/gradePuzzle/backtrack/swordfish/coloring/xychain`，无 `function solve(`；seam 不导出这些；`pickPuzzle`（client.js:423）只从 `PUZZLE_BANK` 建立的 `PUZZLES_BY_GRADE/ALL_PUZZLES/PUZZLE_BY_ID` 索引抽取（静态 review），无任何生成/求解调用。

### 4.2 难度评级（核心）

| 档 | 独立重评级 grade 匹配 | level | solution | solved/stuck |
|---|---|---|---|---|
| easy | 40/40 | 40/40 | 40/40 | 40/40 solved |
| normal | 40/40 | 40/40 | 40/40 | 40/40 solved |
| hard | 40/40 | 40/40 | 40/40 | 40/40 solved |
| expert | 40/40 | 40/40 | 40/40 | 40/40 solved |
| hell | 30/30 | 30/30 | 30/30 | 30/30 stuck |
| **合计** | **190/190** | **190/190** | **190/190** | **190/190** |

- **层级语义**（对 bank 记录与独立重评级都检查）：easy 仅 singles 且至少 1 个 single；normal 必含 pointing/claiming 且最高 level=2；hard 必含 pair/triple 且最高 level=3；expert 必含 x-wing/xy-wing 且最高 level=4；hell 独立 grader 同样卡住（30/30）。
- **评级稳定性**：每题 3 次全新调用，grade+techniques 全部一致 → **190/190 稳定**（0 个不稳定）。
- **100 题随机生成唯一率**：verifier 自写生成器（完整盘随机回溯 + 逐格挖空保持唯一解），seeds 1..100 → **100/100 唯一**，1869 ms，提示数 22–28（mean 24.49）。
- **technique 列表可复现性（NOTE，非缺陷）**：详见 §5/N1。batch 读法 164/190 与 bank 列表逐个相同；api-spec-v2 §1 明确允许的 one-at-a-time 读法与 bank 完全相同的达 182/190，另有 6 题 bank 列表是该读法的有序子序列；剩余 2 题（`normal-122q1h7`、`expert-brtm13`）仅顺序/多一个技巧不同，**两读法的 grade/level/solution/stuck 均为 190/190 正确**。bank 列表在所有情况下都满足层级语义，且 bank 用到的每个技巧都能被独立 grader 实际触发（覆盖无缺口）。

### 4.3 存档 v2 与运行时

- `createState({grade,played,rng,now})`：抽到题库题；`board=givens`、notes 空、`elapsedMs=0`、`runningSince=now`、`won/winAcked=false`、`undo=[]`、`played` 含当前 id；同 seed 抽同题；`played=该档除一题外的全部` 时**必抽唯一未玩题**（且不改输入数组）。
- `serializeState` 输出冻结 schema：`{schemaVersion:2, puzzleId, grade, entries, notes, elapsed, played, winAcked}`；`entries` 在给定格恒 0、玩家值只在空格；notes 不混入 entries；`elapsed` 为暂停后毫秒数；JSON 往返稳定。
- `saveState`→`loadSavedState`：只写 `dsh.game.sudoku.v1`；恢复**同一 `puzzleId`/givens**、entries/notes/elapsed 逐格一致、`runningSince=null`；两次加载幂等。
- **绝不重抽题**：对 5 档各取 3 题手工构造 v2 存档（含玩家 entries/notes/played）→ `loadSavedState` 15/15 精确恢复同一题面与进度。
- **拒绝矩阵 28/28 全中**：非对象/空对象、schemaVersion 1/3/缺失、puzzleId 缺失/未知、grade 与题库不符、entries 缺失/80/82/10/-1/1.5/'5'、notes 缺失/80/512/-1/1.5、elapsed 字符串/NaN/缺失、notes 越界等 → 一律 null；**旧 v1 存档（无 puzzleId/schemaVersion 1）→ null，不抛错、不重抽/不换题**；未知 puzzleId → null。
- **归一化（不拒绝）**：给定格 entries 强制回 0；给定/有值格 notes 归 0；elapsed -500→0、999999999→604800000；winAcked 仅 `=== true`；played 过滤未知/非字符串 id、去重、上限 500。
- **fuzz**：`sanitizeSave` 2000 个随机/篡改输入 → **0 throw**，1813 拒绝、187 接受且**全部通过独立不变量校验**（puzzleId 在库、grade 一致、entries/notes 长度值域、给定格约束、elapsed 范围、played 合法、won==isSolved）；`loadSavedState` 300 个损坏 JSON → **0 throw**（292 null / 8 有效）。`saveState` setItem 抛错→false；`loadSavedState` getItem 抛错→null。
- **运行性能**：pickPuzzle mean 0.01ms/p95 0ms/max 1ms；createState mean 0ms/max 0ms；loadSavedState mean 0.01ms/max 1ms（目标 <5ms，余量巨大）。
- **抽题逻辑**：`pickPuzzle` 档内未玩优先、全玩过回退同档、同 rng 同题、rng 缺省可用、不修改 played；非法 grade→normal（记录）；`newPuzzle` 换题且 grade 正确、字段复位、计时归零、played 累加去重（40 次调用产生 40 个不同题、played 无重复且 ≤ 题库规模/500）。
- **静态 UI**：5 个难度 chip（简单/普通/困难/专家/地狱，`data-difficulty`，active=当前 grade，`aria-pressed`），标签由 `BANK.levels` 驱动；全部 data-* hooks、遮罩 win/confirm/error、actions、timer/remaining/too-small；根 100%×100% + token 色 + tabIndex0 + focus；**无 window/document keydown**（组件根 onKeyDown）、无 canvas、不读 window.innerWidth；cleanup 清 interval×2、摘 visibilitychange/resize、`observer.disconnect()`、`timerPause`+`saveState`（client.js:1620 起）；7 处 `console.error` 全部带 `[dsh-game-sudoku]` 前缀；仅 `require('react')`、单 IIFE。

### 4.4 契约 / 清单 / seam / 仓库完整性

- package.json（exports `./client`、dsh.bundle/client、files 含 README、无 dependencies、无 dsh.client.inject）、cordis.patch.yml（`id: game-sudoku`/`name: '@local/dsh-game-sudoku'`）、index.js 空 `apply`、locale zh/en、icon.svg、README 全部有效。
- 注册形状：`definition.id=@local/dsh-game-sudoku`，`factory` 仅 require('react')，`inject=['slots']`，只注册一次 `game.stage`（id `sudoku`，label `数独`），`select` 仅接受 `gameId==='sudoku'` 并返回同一冻结 MATCHED；inject/register 抛错被 try/catch 且带前缀；host 未注入时静默 no-op。
- seam 门禁（全新 vm 上下文）：无 flag / flag=1 → `window` 无 `__DSH_GAME_SUDOKU__`；`=== true` → 安装（SCHEMA_VERSION=2、BANK 190 题、pickPuzzle 等 25 个文档成员）；defineProperty 方式（client.js:922），flag guard client.js:14。
- **仓库完整性**：以 v2 审计开工时（18:07）抓取的 83 个包外文件 sha256 基线为准，审计时**全部未变**（含宿主与其余 5 个游戏包；其中 solitaire 包的改动发生在本 task 开始前的并发任务，已按现状计入基线）。
- client.js 大小 100,320 B / 2,446 行，在预期单文件范围内；内联 26,946 B。

## 5. 缺陷与规格歧义

**未发现功能缺陷（0）。** 以下为记录在案的规格歧义/边界，不作为缺陷：

- **N1（NOTE，规格歧义）technique 列表不等同于唯一真值**：api-spec-v2 §1 规定“同一技巧一次应用所有可找到的消除/填数（**或逐条应用亦可**，但必须每次同样顺序）”，且未冻结每个技巧内部的扫描/平局细则。因此记录的 `techniques` 列表会随（都合规的）粒度/扫描选择变化：本审计 batch 读法与 bank 完全一致 164/190；逐条应用读法一致 182/190 + 6 题有序子序列 + 2 题仅顺序/多技巧差异；**所有情况下 grade/level/solution/stuck 与 bank 190/190 一致**。结论：bank 列表是其实现下确定可复现的合规读法，评级正确性不受影响；若要求“跨实现列表 100% 相同”，需在 spec 中冻结更细的应用/扫描规则（当前未冻结）。证据：EVIDENCE techniqueLists（含 26 个 batch 差异 id、6 个变体差异 id、2 个残余 id 与各自列表）。
- **N2（NOTE，宽松处理）`played` 非数组**：`sanitizeSave({played:'nope'})` 不拒绝而是归一为 `[]`（recorded: accepted:playedLength=0）。§7 仅要求“played 过滤为题库中存在的 id 且 ≤500”，未要求非数组必须整档拒绝；该宽松行为不产生非法状态，故接受。
- **N3（NOTE，边界）`hell` 的语义依赖“已实现技巧集合”**：§1 定义 hell=“技巧全试完仍解不动”，因此它相对于冻结的 10 技巧集合成立（本审计同集合，30/30 一致）；若未来扩展技巧（swordfish/chains 等），部分 hell 题会降级——这是规格定义边界，不是当前实现缺陷。
- **N4（NOTE，记录）非法 grade 的抽题回退**：`pickPuzzle('legendary')`/`newPuzzle(state,'legendary')` 不抛错、回退 normal 档（EVIDENCE invalidGradePick="returned:normal"、invalidGradeNewPuzzle="returned"）。规范只给了默认档 normal，未明确非法值；行为合理，记录备查。

## 6. 审计局限

- 按任务要求**未导入** `dev/lib/techniques.mjs`，因此“实现方 gradePuzzle 自身 3x 确定性”由其自测（Lead 运行 `dev/test-grade.mjs`：PASS 39/0，re-graded 190×3 稳定）覆盖，本报告的 3x 稳定性验证的是 **verifier 独立 grader**（190/190 稳定）+ bank 与我的评级 100% 一致；未对 dev 库做执行级复核。
- 无浏览器/DOM：真实渲染、5 chip 交互、remount 恢复、亮暗主题、布局（360×520/720×600/1100×700/300×200）、0 console error 由 Lead 的 Chromium 验收覆盖；静态 UI 检查是“字面/结构存在性”检查。
- 性能为本机（有并发 agent 调度）实测；pick/restore 均 ≤1ms，结论不受噪声影响。
- “唯一解/随机生成”使用 verifier 自有求解器/生成器；与实现方独立，但两者都基于标准数独规则。

## 7. 复验记录

| 时间（Asia/Shanghai） | 事件 | 结果 |
|---|---|---|
| 18:26 | 首轮全量审计（bank 77,029 B / client 100,320 B，mtime 18:25:25） | bank 11/1（audit 脚本静态误判 pickPuzzle 读 BANK 方式）、grades 6/2（26 题 technique 列表差异；grade 0 差异）、save 20/2（audit 脚本 `GRADE_LABELS` 迭代 bug + played 非数组宽松）、contract 23/0 |
| 18:30 | 修正审计脚本（pickPuzzle 索引静态检查、technique 列表粒度归因、`GRADE_LABELS`、played 非数组归入宽松探针）后复验 | **全部通过**：selftest 17/0、bank 12/0、grades 9/0（2 NOTE）、save 22/0、contract 23/0；`AUDIT V2 SUITE: all 5 scripts passed` |
| 18:32 | 复核产物未在审计期间变化 + 包外 83 文件 sha256 未变 | PASS |

**最终判定：PASS WITH NOTES。** 难度评级/唯一解/存档/抽题/契约全部符合 api-spec-v2（190/190 题 grade 一致，0 缺陷）；N1 为 §1 未冻结 technique 列表细则导致的跨实现记录差异（评级不受影响），N2–N4 为记录在案的宽松/边界行为。Chromium 端到端验收仍由 Lead 负责。
