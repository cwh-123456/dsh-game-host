# 华容道独立 verifier 审计（dev/audit）

> 审计对象：`packages/dsh-game-klotski`（`gameId: klotski`）
> 审计方式：独立实现 + 静态检查 + 差分 fuzz + fake DOM 生命周期；不 import / 不复制 `client.js` 的规则或求解代码（只把 `LEVELS` 当被测数据读取）。
> 审计脚本：本目录 `bfs.mjs` / `fuzz.mjs` / `save-audit.mjs` / `contract-audit.mjs` / `host-hashes.mjs` / `fake-dom.mjs`，统一入口 `run-all.mjs`。
> 复跑：`node packages/dsh-game-klotski/dev/audit/run-all.mjs`（无第三方依赖，exit code 0 = PASS）。

## 审计记录说明（重要）

verifier 会话在收尾写报告前中断（其最后一条消息：所有套件在稳定快照上通过，正在采集最终指纹）。
因此本文件由 Lead 在 **最终 `client.js`** 上复跑全部 verifier 套件后整理：
`node dev/audit/run-all.mjs` → **6/6 suites PASS**。

期间 Lead 在 verifier 脚本完成后又改了两处 UI/校验（落点标记改为画在“新进入的空格”、`data-target` 改为该空格；
存档校验对 `1.5` 这类非整数更严格）。全部套件已对最终文件复跑，下列结果即最终结果。

最终被测文件指纹：

- `client.js` **63,551 B / sha256 `8f26cefc31a4aad4f958449ea298296b2760e7f2401a242a5c8db6a596a05414`**（1,743 行）
- `package.json` 640 B / `2cbfc567…`；`index.js` 313 B / `33513dfb…`；`cordis.patch.yml` 71 B / `d71ce7b9…`
- `locale/zh.json` 195 B / `535d8862…`；`locale/en.json` 212 B / `30d1e1a5…`；`icon.svg` 1,880 B / `0ab524ef…`

## 结论

**PASS WITH NOTES — 0 阻塞、2 条非阻塞 note。** 独立复算的最短步数、规则行为、存档/坏档、契约静态项、宿主未改、fake DOM 生命周期全部通过。

## 套件结果

| 套件 | 结果 | 规模 |
|---|---|---|
| 1 独立 BFS / par / L1 规格 | **PASS** | 4 关全部可解；独立 BFS 最短步数 = 声明 par：90 / 90 / 76 / 77；L1「横刀立马」逐格与任务书一致。quotient 状态 23,927 / 23,943 / 23,883 / 15,116，边 82,071 / 82,128 / 81,921 / 50,852，合计 ~0.28s |
| 2 规则差分 fuzz | **PASS** | 4 关各 350 个随机可达状态 + 合成胜利态；`canSlide` 112,320 次、`listMoves` 14,040 次、`apply` 5,406 次、`pieceAt` 28,080 次、拒绝探针 78 项；**0 差异** |
| 3 存档审计 | **PASS** | 52 项检查、12 个字段 roundtrip；6,000 个变异坏档 **0 抛错**（接受 921 / 拒绝 5,079，接受项全部独立复核合法）；只读写 `dsh.game.klotski.v1`；坏 JSON/版本/关卡/重叠/越界/曹操位置与 won 矛盾等均被拒 |
| 4 契约 / manifest 静态 | **PASS** | 29 项检查全过：包清单/exports/files/dsh 字段、无 dependencies、无 `dsh.client.inject`、cordis patch、index.js 空实现、locale 双语、loader id 等于包名、factory 只 require('react')、只 inject slots + 注册 game.stage、严格 select、存档 key/schema、无 `document.body`/`document.title`、无全局 keydown、根元素 100%、ResizeObserver/devicePixelRatio、<320×240 提示、错误边界、teardown、seam gating |
| 5 宿主未改 | **PASS** | `packages/dsh-game-host/**` 8 文件 + `handoff/contract/game-plugin-api.v1.md` 共 9 个 sha256 与基线全部 MATCH；contract 目录无新增顶层文件 |
| 6 fake-DOM 生命周期（加分） | **PASS** | 13 项：挂载/layout、点击选中与移动、非法移动拒绝、撤销、重开、换关、隐藏暂停/恢复、destroy 落盘与 DOM 清理、bad save 回退、too-small、win overlay + 阻止移动 |

## 非阻塞 note

1. **no-canvas（契约 §5 字面）**：棋盘用 DOM/CSS 渲染而非 `<canvas>`，因此不适用 canvas DPR 缩放；但 DOM 渲染天然分辨率无关，代码仍读取 `devicePixelRatio` 并在变化时重排。满足契约“高 DPI 不糊”的意图，不满足 §5 canvas 写法字面。非阻塞。
2. **markers-per-move（已核实为设计选择）**：一次滑动若进入多个空格（如 2×2 曹操向下 1 格进入底部两个空格），`renderMarkers()` 会在**每个新进入的空格**各画一个落点圆点（`markers=2`，同一 move）。`data-target` 已改为各自空格、不再重复；两个圆点都指向同一 valid move，点击任一格都能移动。属有意 UX（提示可点击的每个空位），不是重复/错位。非阻塞。

## 未验证边界（诚实声明）

- **未安装到真实宿主**（按约定子对话不能自己装插件）：插件面板标题/描述/图标、「游戏」页目录共存、真实 React 18 渲染、宿主内切页卸载→重进恢复、真实窗口缩放/高 DPI 观感、真实最小化计时、控制台无 `slot entry crashed` 等只能在用户安装后按契约 §10 验收。
- 本目录 fake DOM 与 `dev/fake-react.js` 均为最小替身；通过 ≠ 真实浏览器/宿主验收。Lead 另用真实 Chromium 打开 `dev/preview.html` 做了点击/撤销/换关/尺寸矩阵/胜利/卸载重挂的预览检查（0 console error），但仍是假宿主。
- 未用物理鼠标/触屏真机；未做真机性能/内存长跑。
