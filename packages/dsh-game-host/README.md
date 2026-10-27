# dsh-game-host —— DSH 游戏平台页

给 DSH 加一个**整页游戏空间**：左侧栏多一个「游戏」图标，点进去主区换成游戏页（侧栏保留）。游戏本身不在这个包里，任何 `dsh.client` 包都可以把自己挂到 `game.stage` 上。

## 安装（本地开发）

1. 打开 DSH 左侧栏底部的「插件」页 →「添加插件」
2. 来源填**本地绝对路径**：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-host`
3. 安装完成后点「立即启用」
4. 返回对话，左侧栏应出现「游戏」图标；首次若没出现，完全退出客户端（含托盘）再打开

装好之后，改 `client.js` 约 1 秒热更新，不需要刷新或重装。

## 当前能力（v0.3）

- 侧栏「游戏」入口 + 独立页面（顶部栏 / 左侧目录 / 主区舞台）
- 目录自动读取所有向 `game.stage` 注册的游戏（上下架自动刷新，`ctx.slots.subscribe`）
- 选中的游戏存在 `localStorage['dsh.gameHost.v1']`，切走再回来还在
- 没有游戏时显示空状态；单个游戏崩溃只影响舞台（error boundary），不会白屏
- **页内提醒条**（v0.2 起）：
  - 四类：待审批 / 待回答 / 待审阅计划 / 本轮完成
  - 多会话聚合（v0.3）：每条带「工作区 · 对话名」，可同时列出多条，各自独立跳转
  - 子代理会话静音（只认 `session-*` 的用户对话）
  - 「去处理」= `openSession` + 审批卡定位 / `userQuestionPanels.reveal`
  - 待处理类常驻不自动消失，可手动忽略；完成类 12s 后自动消失
- 完成判据自己算：`running` true→false + `pendingInteraction` 为空 + 1s 去抖（官方 `completionUnread` 对主会话恒 false）

**不做**：页内直接批准（误触代价高）、音效、系统通知、快捷键、离开页面的兜底 Toast。

## 接一个游戏（给游戏包作者）

游戏包是一个普通 `dsh.client` 插件，**不要**依赖本包的服务，只往 slot 里注册：

```js
window.__ModuleLoader__.load({
  id: 'acme-dsh-game-snake',
  factory(require) {
    const React = require('react')
    function Snake({ matched }) { /* 画布 + 循环 + 清理 */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('game.stage', () => ctx.slots.register({
          name: 'game.stage',
          id: 'snake',                 // 全局唯一，目录 key
          label: () => '贪吃蛇',        // 目录显示名
          select: ({ gameId }) => (gameId === 'snake' ? {} : null),
        }, Snake))
      },
    }
  },
})
```

约定：

- `select` 必须提供；返回 `null` 表示"当前没选我"，返回值会作为组件的 `matched` prop
- 组件根元素撑满：`width:100%; height:100%`
- 面板切换会**卸载组件**，进度自己存 `localStorage`（建议 key `dsh.game.<id>.v1`）
- 键盘只挂自己的根元素，不注册全局快捷键
- 不要 `require` 别的 `@deepseek-ai` 包；React 从模块表拿
- 完整契约见 `packages/../handoff/contract/game-plugin-api.v1.md`

## 结构

```
package.json       dsh.bundle.patch + dsh.client
cordis.patch.yml   插入一行 game-host
index.js           宿主半侧：空 apply
client.js          页面、目录、舞台（纯 JS，无构建）
locale/{zh,en}.json 插件面板显示的 meta
icon.svg           插件/侧栏图标
```
