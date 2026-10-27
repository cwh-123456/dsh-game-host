# 实施计划 —— dsh-game-host（游戏平台插件）

> 配套决策见 `DECISION.md`。本文件只讲"怎么做、怎么验收"。
> 状态：**决策已定稿，等你一声「开工」后从 M0 开始。尚未写任何插件代码。**

---

## 1. 交付形态

一个本地自包含插件包，放工作区，用侧边栏「插件」面板安装（`link:` 方式，改代码即时生效）：

```text
D:\desktop_files\artificial_intelligence\dsh-game-host\
├── DECISION.md
├── PLAN.md
├── packages\
│   └── dsh-game-host\          ← 插件包（唯一交付物）
│       ├── package.json         # dsh.bundle.patch + dsh.client，exports ./client、./locale/*、./icon
│       ├── cordis.patch.yml     # insert 一行：id/name = dsh-game-host
│       ├── index.js             # 宿主半侧：export function apply() {}（空，逻辑全在客户端）
│       ├── client.js            # 浏览器侧：页面 + 目录 + 舞台 + 提醒层 + 接入面（纯 JS，无构建）
│       ├── locale\zh.json       # meta.title/description（插件面板显示）+ UI 文案
│       ├── locale\en.json
│       ├── icon.svg             # 侧栏图标 + 插件列表图标
│       └── README.md            # 安装步骤 + 「怎么接入一个游戏」8 行示例 + 架构说明
└── .scratch\                    # 调研与解包证据（不进交付物）
```

---

## 2. 页面结构

```text
┌─────────────────────────────────────────────────────────┐
│ 游戏平台                                      返回对话 │  ← 顶部栏（可拖动，data-window-drag）
├─────────────────────────────────────────────────────────┤
│ ⚠ 需要你处理：批准运行 pwsh 命令          [去处理]  ×   │  ← 提醒条（有待处理项才出现，常驻不自动消失）
│ ✓ 本轮完成 · 用时 1m23s                            ×   │  ← 完成提醒（自动 10s 消失）
├───────────────┬─────────────────────────────────────────┤
│ 游戏目录       │                                         │
│ · 示例游戏     │            游戏舞台（chain slot）        │
│ · （空状态）   │        game.stage ← 游戏包注册在这        │
│               │                                         │
└───────────────┴─────────────────────────────────────────┘
```

- 侧栏：`sidebar.panellist` 注册「游戏」图标（`order: 20`，与插件页/定时任务页并排）
- 进入：点侧栏图标 → `ctx.layout.selectPanel('games')`（由宿主侧栏自动调用）
- 退出：页内「返回对话」→ `selectPanel(null)`；也可直接点会话
- 提醒常驻在页面顶部；**离开页面则不显示任何浮层**（符合"只在游戏页面内提醒"）

---

## 3. 核心实现要点

| 模块 | 做法 | 依据 |
|---|---|---|
| 页面挂载 | `main` keyed/root slot（`key:'games'`）+ `sidebar.panellist` list（`id:'games'`,`order:20`） | 照抄 `ui-plugin-manager` |
| 游戏目录 | 投影 `ctx.slots.entries('game.stage')`，用 `ctx.slots.subscribe` 自动刷新 | 游戏上下架即目录刷新 |
| 游戏舞台 | 注册时声明 `children: { 'game.stage': { kind:'chain', scope:'root' } }`，用 `renderSlotChain('game.stage', { gameId })` 渲染 | chain 选一个 |
| 选中态/进度 | **外置**：插件级闭包 + `localStorage('dsh.gameHost.v1')`；组件卸载不丢 | 切面板会卸载组件 |
| 提醒检测 | 插件级 `ctx.effect` 里订阅 `ctx.uiSession.sessionStatus`（页面关着也在跑） | 页内只负责呈现 |
| 提醒呈现 | 页面组件顶部横幅；身份去重 `sessionId:kind:callId`，不自动消失（完成类 10s） | 每个会话只有一个 pendingInteraction（提问>计划>审批） |
| 完成判据 | `running` true→false + `pendingInteraction` 为空 + **1000ms 去抖** + 二次确认 | `completionUnread` 对主会话恒 false |
| 跳回对话 | `ctx.uiWorkspace.openSession(sid)` → rAF×2 → 审批卡 `[data-approval-key]` 滚动定位 / 提问 `ctx.get('userQuestionPanels').reveal(sid, callId)` | 官方深链 |
| 失败隔离 | `apply` 与页面组件全程 try/catch + 舞台 error boundary；只 `inject:['slots','locale','layout']` | 写坏会导致整个应用启动失败 |
| 主题/i18n | 只用 `--dsw-alias-*` token；文案走 `ctx.locale.register/bind` | 插件规范 |

**v1 不做**：快捷键、音效、系统通知、离开页面的兜底 Toast、页内直接批准、隐藏侧栏。

---

## 4. 游戏接入接口（这份是框架的核心价值）

后续任何游戏包（独立 npm 包，`dsh.client` 形状），只需 **8 行**：

```js
window.__ModuleLoader__.load({
  id: '@acme/dsh-game-snake',
  factory(require) {
    const React = require('react');
    function Snake({ matched }) { /* canvas + 帧循环 + 事件 */ }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('game.stage', () => ctx.slots.register({
        name: 'game.stage', id: 'snake', label: () => '贪吃蛇',
        select: ({ gameId }) => gameId === 'snake' ? { /* 你的 props */ } : null,
      }, Snake));
    } };
  },
});
```

约定（写进 README）：
- 只依赖 `slots`，**不要**在顶层 `inject` 一个自定义 host 服务（会导致整页启动失败）
- `select` 返回 `null` 表示"当前没选我"；返回对象会作为 `matched` prop 传进来
- 游戏自己管画布与输入焦点；**不要**注册全局裸键（桌面端会被快捷键吃掉）
- 需要存档就自己在 localStorage 里存，或等 v1.1 的 `gameHost` 服务（存档/分数/暂停）
- 卸载即销毁：`useEffect` 返回的清理函数里停掉 rAF/监听器

---

## 5. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 实机探针**（半天） | 装 30 行骨架：侧栏图标 + 空页面 + 返回按钮 | 图标出现、点得进、返回得去、控制台无 `slot entry crashed`、停用后恢复对话 |
| **M1 页面骨架** | 顶部栏 + 目录 + 空状态 + 主题/locale | 明暗主题正常；语言切换文案跟随；窗口缩放布局不破 |
| **M2 接入面 + 示例游戏** | `game.stage` chain + 示例游戏包 + README | 示例游戏在舞台渲染并可玩；卸载示例包后目录自动空 |
| **M3 提醒层** | 检测 + 横幅 + 深链跳转 + 去重 | 造一次审批 → 页内出横幅 → 点「去处理」回会话并定位到审批卡；提问同理；完成后出"本轮完成" |
| **M4 收尾** | 持久化、错误隔离、空/错状态、安装文档 | 切走再回来进度还在；示例游戏故意抛错不影响页面；按 README 从零装一遍成功 |

**M0 是一次性风险验证**：`main` keyed slot + `sidebar.panellist` 的注册形状、`renderSlotChain`、`ctx.layout.selectPanel` 三个 API 必须先在真机上跑通，再写后面的东西。失败就退回 `shell.overlay` 全屏覆盖方案（备选，风险见 DECISION.md R1）。

---

## 6. 安装步骤（你来做，M0 就需要一次）

1. 我产出包后，打开左侧边栏底部的「插件」页
2. 安装来源填本地目录绝对路径：`D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-host`
3. 返回对话，侧栏应出现「游戏」图标（首次若没出现，完全退出客户端重开一次）
4. 之后我改 `client.js` 你就能直接看到变化（约 1 秒热更新，无需刷新）

> 如果插件面板不接受本地目录路径，告诉我，我改用桌面自带 `dsh.cmd` 命令行安装（会写 profile，需你点头）。

---

## 7. 已确认（C1–C3）

- **C1** v1 带一个 20 行示例游戏 → **带**（验证容器用，标为示例、可删）
- **C2** 进游戏页自动收起侧栏 → **否**，保留侧栏
- **C3** 提醒横幅动作 → **只做「去处理」跳转**；页内直接批准留 v1.1 评估
