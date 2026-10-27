# 数独 v2 · 假宿主 Chromium 验收结果（dev-only 证据）

- 日期：2026-10-18 18:28（Asia/Shanghai）
- 对象：`packages/dsh-game-sudoku/client.js`（100,320 B，sha256 `B0AB0735…6E89DA`，内联 190 题题库）
- 环境：本机 Chromium（DSH `browser_*` 工具，视口 1280×800），页面
  `dev/preview.html?acceptance=2`（真实 DOM + 包内 `dev/fake-react.js` 迷你 React，假宿主 token；
  **非** DSH 宿主内运行）
- 结果：**49 / 49 通过，failed = []，window error / unhandledrejection / console.error 均为 0**
- 用时：约 6.9–7.3s（含 1.4s 计时刷新、1.2s 胜利暂停计时、5 次新局抽题）
- 结果落点：`localStorage['dsh.sudoku.acceptance.v2']` + `window.__acceptanceResult`
- 复跑方式：浏览器打开 `dev/preview.html?acceptance=2`，等结果落盘；或从任意同源页面创建
  该 URL 的 iframe，轮询上述 localStorage key。

## 覆盖项（49 项）

1. 启动：client.js 载入、`game.stage` 注册、81 格渲染。
2. 测试 seam v2：`BANK` 5 档 × 190 题（每档 30–50）、`findPuzzle/pickPuzzle/createState/...` 存在，
   **无 `generatePuzzle/countSolutions/solve`**（运行时零生成/零求解）。
3. 难度 chip：简单/普通/困难/专家/地狱，顺序与 active 状态正确。
4. 每档各抽一题：grade 匹配、唯一解（页面内置 dev 求解器复核）、提示数合法。
5. 新局：默认普通档、计时 00:00。
6. 存档 v2 字段：schemaVersion=2、puzzleId/grade/entries/notes/elapsed/played；
   题面来自题库且与棋盘一致；entries 为玩家层（给定格不重复存）。
7. 选中/高亮：选中格 + 20 个同行/列/宫 peer。
8. 输入：键盘 1–9 填格并写入 entries；同数字重复输入不自动擦除；撤销可用。
9. 草稿：模式切换、3+7 小数字渲染、填值清草稿、退格清除、Ctrl+Z 逐步恢复“值 → 草稿”。
10. 冲突：行内重复恰好标红 2 格（背景 `rgb(254,226,226)`），擦除后清零。
11. 键盘隔离：游戏根之外 input/body 的 keydown 不改棋盘。
12. 计时：可见时前进。
13. 重挂（切走再回来）：**同一 puzzleId/grade**、entries/notes/elapsed 恢复、棋盘按同 givens 重建。
14. 难度切换：有进度先确认；取消保留；确认换专家题；无进度切地狱立即生效。
15. 新游戏优先未玩过：连续 5 局题号互不重复且都不在 played 里；played 历史落盘。
16. 重开：确认后同一题、清空 entries/notes/undo、计时归零。
17. 新游戏：确认后换题、计时归零。
18. 胜利：按题库题面求解填满 → 遮罩 + 难度 + 用时；计时暂停；撤销/数字键禁用；
    关闭遮罩后 winAcked 持久化、棋盘锁定；胜利后新游戏不再确认。
19. 旧 v1 存档注入 → 自动丢弃并开新 v2 题，无 error。
20. 未知 puzzleId 的 v2 存档 → 丢弃并开新题，无 error。
21. 清档：删除 key 后重挂 → 新题、只剩 givens、计时 00:00。
22. 响应式：360×520 / 720×600 / 1100×700 棋盘正方形、落在舞台内、无溢出；
    300×200 显示「窗口太小」且不渲染棋盘。
23. 控制台：三项 error 计数 0。

## 布局实测（v2，假宿主舞台）

| 舞台 | 棋盘边长 | 结论 |
|---|---|---|
| 360×520 | 240px | 工具栏换行、键盘两行，棋盘可玩 |
| 720×600 | 436px | 正常 |
| 1100×700 | 572px | 正常 |
| 300×200 | — | 「窗口太小」提示 |

> v2 比 v1 多了第 5 个难度 chip，窄舞台工具栏更高，因此 360×520 下棋盘从 274px 降到 240px；
> 仍满足“棋盘跟随缩放、不溢出、可玩”。

## 同批截图（`dev/screenshots/`）

| 文件 | 状态 |
|---|---|
| `light-720x600.png` | 亮色 720×600 新局（5 个难度 chip、启动/seam 校验全绿） |
| `dark-720x600.png` | 暗色主题（棋盘自配色保持可读） |
| `light-360x520.png` | 窄舞台布局 |
| `light-win.png` | 胜利遮罩（难度：普通 + 用时） |
| `light-300x200-too-small.png` | 窗口太小 |

> 截图是假宿主 dev 预览页，不是 DSH 宿主内截图；真实宿主 token/主题/React 运行时仍需用户安装后验收。

## 说明：共享浏览器技巧

DSH `browser_*` 工具与其它并发会话共用同一个浏览器页，会被切走；因此验收用
`iframe + file:// localStorage 结果落盘` 运行，避免中途被导航丢结果。验收套件与 demo 状态
在 `dev/ui-check/acceptance-v2.js`（旧 v1 套件已标记停用，仅保留历史）。
