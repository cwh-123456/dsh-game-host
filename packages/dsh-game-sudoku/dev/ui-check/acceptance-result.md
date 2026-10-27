# 数独包 · 假宿主 Chromium 验收结果（dev-only 证据）

- 日期：2026-10-18 17:18（Asia/Shanghai）
- 对象：`packages/dsh-game-sudoku/client.js`（77,556 B，sha256 `36A5334C…A16301`）
- 环境：本机 Chromium（DSH `browser_*` 工具，视口 1280×800），页面
  `dev/preview.html?acceptance=1`（真实 DOM + 包内 `dev/fake-react.js` 迷你 React，
  假宿主 token；**非** DSH 宿主内运行）
- 结果：**46 / 46 通过，failed = []，window error / unhandledrejection / console.error 均为 0**
- 用时：约 5.2s（含 1.4s 计时刷新与 1.2s 胜利暂停计时等待）
- 结果落点：`localStorage['dsh.sudoku.acceptance.v1']` + `window.__acceptanceResult`
- 复跑方式：浏览器打开 `dev/preview.html?acceptance=1`，等页面状态栏/结果落盘；
  或从任意同源页面创建该 URL 的 iframe，轮询上述 localStorage key。

## 覆盖项（46 项）

1. 启动：client.js 载入、模块 id、`game.stage` 注册（id `sudoku` / label 数独 / select 仅匹配 sudoku）、seam、81 格渲染。
2. 新局：普通难度 34 提示 / 47 空；计时 00:00；存档 schemaVersion=1、含 solution。
3. 选中与高亮：点击选中；同行/列/宫 20 个 peer。
4. 输入：键盘 1–9 填入；同数字重复输入不自动擦除；撤销可用。
5. 草稿：草稿模式切换；同格 3+7 小数字渲染；填值后草稿清除；退格清除；
   Ctrl+Z 逐步恢复“值 → 草稿”。
6. 冲突：行内重复数字恰好标红 2 格（背景 `rgb(254,226,226)`）；擦除后清零。
7. 键盘隔离：在游戏根之外的 input/body 上派发 keydown 不改棋盘。
8. 计时：可见时显示前进。
9. 重挂（切走再回来）：当前题 givens 不变（不重新生成）、填写/草稿/选中格/难度/计时全部恢复，DOM 与存档一致。
10. 难度：有进度时先确认；取消保留原题；确认后换题（困难 28 提示/53 空，简单 40/41）；无进度时立即换题。
11. 重开：有进度先确认；确认后同题、清空填写/草稿/撤销、计时归零。
12. 新游戏：有进度先确认；确认后换题、计时归零。
13. 胜利：按 solution 填满 → 遮罩 + 用时；计时暂停；撤销/数字键禁用；
    save won=true/winAcked=false；关闭遮罩后 winAcked=true 且棋盘锁定；
    胜利后点「新游戏」立即开新题（不再确认）。
14. 清档：删除 `dsh.game.sudoku.v1` 后重挂 → 新题、棋盘只剩 givens、计时 00:00。
15. 响应式：360×520 / 720×600 / 1100×700 棋盘均正方形、落在舞台内、根节点无溢出；
    300×200 显示「窗口太小」且不渲染棋盘。
16. 控制台：三项 error 计数 0。

## 同批截图（`dev/screenshots/`）

| 文件 | 状态 |
|---|---|
| `light-720x600.png` | 亮色 720×600 新局（工具栏/棋盘/键盘/启动校验面板） |
| `dark-720x600.png` | 暗色主题（棋盘自配色保持可读，工具栏跟随 token） |
| `light-360x520.png` | 窄舞台：棋盘 274px、键盘两行、工具栏换行 |
| `light-win.png` | 胜利遮罩（完成！难度/用时/按钮） |
| `light-300x200-too-small.png` | 300×200「窗口太小」提示 |

> 截图是假宿主 dev 预览页，不是 DSH 宿主内截图；真实宿主的 token 值/主题/React 运行时仍需用户安装后验收。

## 说明：共享浏览器技巧

DSH `browser_*` 工具与其它并发会话共用同一个浏览器页，会被切走；因此验收用
`iframe + file:// localStorage 结果落盘` 运行，避免中途被导航丢结果。这解释了为什么
验收结果写进 localStorage，而不是依赖调用方一直停在游戏页。
