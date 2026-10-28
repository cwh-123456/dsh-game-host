# 2048 — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的一个独立游戏包：往宿主的 `game.stage`
chain slot 注册 2048，装进 DSH 后出现在「游戏」页左侧目录里，点开即可玩。

## 玩法

- **方向键 / WASD**：滑动方块，相同数字合并，凑出 2048。
- **在棋盘上拖动**：鼠标 / 触屏滑动，方向同上。
- **U** 或工具栏「撤销」：撤销上一步（只保留一步）。
- **「新游戏」**：重开一局，最高分保留。
- 达到 2048 会弹一次提示，可以继续挑战更高分；棋盘无路可走时提示「再来一局」。

## 游戏内规则

工具栏里的「📖 规则」按钮会弹出完整的规则与操作说明。弹窗分四节：目标、一步之内的细节、计分、操作，末尾附一条经典打法提示。

- 弹窗打开期间，键盘事件不会再传给棋盘（按 `Esc` 或点 `×` / 遮罩关闭），不会一边看规则一边误操作。
- 规则文本随代码一起发布，离线可用，不依赖网络。

## 存档

- key：`localStorage['dsh.game.2048.v1']`
- 内容：`{ schemaVersion: 1, board, score, best, won, winAcked, undo }`，含一步撤销快照。
- 解析失败 / 版本不符 / `localStorage` 不可用时自动开新局，不抛错。
- 离开游戏页、切回对话、刷新页面后进度仍在。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-2048`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「2048」。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。

## 自测

```powershell
cd packages\dsh-game-2048
node --check client.js
node dev/test-logic.mjs      # 纯逻辑 + 注册形状，24 项
node dev/test-headless.mjs   # 假 DOM 跑完整 createGame，24 项
```

- `dev/preview.html`：在浏览器里直接打开可看 canvas 渲染/键盘/滑动的**开发预览**。
  它只验证画面与运行时 API，**不是**宿主内验收；宿主内验收要等平台就绪后真机联调。

### 为什么纯逻辑也在 client.js 里

`client.js` 是模块加载器唯一服务的浏览器入口；加载器的 `require` 只解析模块表里的包
（`react` 等），**不支持包内相对路径同步 require**，所以单独的 `game.js` 在浏览器里拿不到。
纯逻辑因此放在 `client.js` 前部；只有测试进程设置
`window.__DSH_GAME_2048_TEST__ = true` 时，才会把纯逻辑挂到 `window.__DSH_GAME_2048__`
供 `dev/` 自测，正常运行不暴露任何全局。

## 实现要点

- 只 `inject: ['slots']`，只注册 `game.stage`；不提供服务、不注册其它 slot、不抢全局快捷键。
- 键盘监听只挂在自己的组件根节点（工具栏按钮 + 棋盘都在里面，点按钮后方向键仍可用），
  不使用 `window`/`document` 键盘监听。
- `ResizeObserver` + `devicePixelRatio` 重算 canvas 尺寸；`window resize` 补充处理拖到不同缩放显示器
  时 dpr 单独变化的情况；< 260×240 显示「窗口太小」。
- 动画只在移动/合并的约 220ms 内跑 `requestAnimationFrame`；`document.hidden` 时立即收尾并取消帧，
  回来后只重绘最终盘面，不会「跳帧狂奔」。组件卸载时 `destroy()` 停帧、摘监听、落盘。
- canvas 自绘经典 2048 暖色棋盘（不透明，亮/暗主题都可读）；工具栏/覆盖层用 `--dsw-alias-*` token。
- 纯逻辑、渲染、生命周期都有 try/catch：运行期错误只显示游戏内「重试」提示，不拖白宿主页面。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client`，`exports` 含 `./client` / `./locale/*.json` / `./icon` |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-2048`） |
| `index.js` | 宿主半侧，空实现（UI 全在 client） |
| `client.js` | 浏览器侧：纯逻辑 + canvas + React 包装 + `game.stage` 注册 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标 |
| `dev/` | 自测脚本与预览页（不在 `files` 里，不随包发布） |
