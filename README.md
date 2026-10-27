# dsh-game-host

给 [DSH（DeepSeek Harness）](https://www.deepseek.com) 桌面端加一个**整页游戏空间**：左侧栏多一个「游戏」图标，点进去主区换成游戏页（侧栏保留）。

它不是"摸鱼小玩具"，而是解决一个具体问题：**模型卡在审批/提问上等你，而你正在别的页面**。DSH 的审批界面是输入框接管，只活在会话页里；切到游戏页后对话整棵树被卸载，默认看不到也点不到。所以游戏页顶部有一条提醒层，把「待审批 / 待回答 / 待审阅计划 / 本轮完成」打在页面上，并给一个「去处理」深链跳回会话。

## 组成

| 部分 | 说明 |
|---|---|
| `packages/dsh-game-host` | **宿主**：侧栏入口、游戏页骨架、`game.stage` 接入槽、页内提醒层 |
| `packages/dsh-game-*` | **游戏包**：各自独立的 `dsh.client` 插件，只依赖 `slots`，往 `game.stage` 注册 |

关键设计：游戏接入用**槽位注册**而不是服务注入。第三方游戏包只 `inject: ['slots']`，宿主没装或被停用时不会拖挂整个 Web 启动；插件卸载自动从目录摘除。

## 游戏清单

| 包 | 名称 | 玩法要点 | 真机验收 |
|---|---|---|---|
| `dsh-game-2048` | 2048 | 经典数字合并 | ✅ 已验收 |
| `dsh-game-minesweeper` | 扫雷 | 经典扫雷、首击保护 | ✅ 已验收 |
| `dsh-game-quoridor` | 墙棋 | Quoridor 规则 + AI | ✅ 已验收 |
| `dsh-game-complexweeper` | 复扫雷 | Zig 原版规则移植（GPL-3.0），带独立规则引擎 | ✅ 已验收 |
| `dsh-game-tetris` | 俄罗斯方块 | 10×20、SRS 旋转、消行计分 | ✅ 已验收 |
| `dsh-game-solitaire` | 接龙 | Klondike 单机接龙 | ✅ 已验收 |
| `dsh-game-sudoku` | 数独 | 多难度出题、笔记模式 | ✅ 已验收 |
| `dsh-game-battleship` | 海战棋 | 10×10、5 艘、AI 三档 | ✅ 已验收 |
| `dsh-game-klotski` | 华容道 | 4 关，BFS 复算最短解 | ✅ 已验收 |
| `dsh-game-gomoku` | 五子棋 | 15×15、AI 对弈 | ✅ 已验收 |

10 款游戏均已在本机 DSH 客户端里安装并实测通过（2026-10-27）：目录可见、进舞台可玩、切页后进度恢复、控制台无报错。每个包另有一组离线自测（逻辑单测 / 无头生命周期 / 真实 Chromium 交互 / 独立审计），跑法见各包 README 的「自测」一节。

## 安装

本地自包含包，用侧栏「插件」面板以 `link:` 方式安装（改代码约 1 秒热更新）：

1. 打开 DSH 左侧栏底部的「插件」页 →「添加插件」
2. 来源填包目录的**绝对路径**，例如
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-host`
3. 安装后点「立即启用」
4. 返回对话，左侧栏应出现「游戏」图标；首次若没出现，完全退出客户端（含托盘）再打开

游戏包按同样方式逐个安装，装完点进「游戏」页，左侧目录会自动多出一项。

> 改 `client.js` 热更新；改 `package.json` / `cordis.patch.yml` 需要完全重启客户端。

## 接一个游戏（8 行）

游戏包就是普通 `dsh.client` 插件，不要依赖宿主的服务，只往槽里注册：

```js
window.__ModuleLoader__.load({
  id: '@acme/dsh-game-snake',
  factory(require) {
    const React = require('react');
    function Snake({ matched }) { /* canvas + 帧循环 + 清理 */ }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('game.stage', () => ctx.slots.register({
        name: 'game.stage',
        id: 'snake',
        label: () => '贪吃蛇',
        select: ({ gameId }) => (gameId === 'snake' ? { /* 你的 props */ } : null),
      }, Snake));
    } };
  },
});
```

约定：

- `select` 必须提供；返回 `null` 表示「当前没选我」，返回对象会作为 `matched` prop 传入
- 组件根元素撑满 `width:100%; height:100%`，用 `ResizeObserver` 拿真实尺寸
- 面板切换会**卸载组件**，进度自己存 `localStorage['dsh.game.<id>.v1']`
- 键盘只挂自己的根元素；**不要**注册全局裸键（桌面端会被宿主快捷键吃掉）
- 不要 `require` 任何 `@deepseek-ai/*` 包；React 从宿主模块表拿
- **不要**在顶层 `inject` 自定义服务——宿主没启用时会让整个 Web 启动审计失败、页面起不来

## 仓库结构

```
packages/dsh-game-host/     宿主（client.js 单文件，纯 JS 无构建）
packages/dsh-game-*/        10 个游戏包
DECISION.md                 形态决策与调研结论（为什么整页 / 为什么槽位注册）
PLAN.md                     实施计划、里程碑与验收口径
```

## 已知限制

- 提醒只覆盖用户会话；插件加载前就已完成的轮次无法回溯提醒
- 侧栏图标没有 badge 位，未读数不显示在图标上
- 不支持页内直接批准（安全决策：误触代价高），只做跳转
- 仅在 DSH `0.2.1-rc.2` 上验证过

## 许可

各包独立授权，未统一。

- `packages/dsh-game-complexweeper`：规则引擎移植自 [Complexweeper](https://github.com/Yueqing-Chen/complexweeper-A-minesweeper-game)（作者 青月晓），衍生作品按 **GPL-3.0-only** 发布，详见该包内 `LICENSE`
- 其余包：暂未声明许可证

本仓库含 GPL-3.0 代码，整体再分发时请遵守相应条款。
