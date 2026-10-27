# 扫雷 — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的第二个独立游戏包：往宿主的
`game.stage` chain slot 注册扫雷，装进 DSH 后出现在「游戏」页左侧目录里，点开即可玩。
宿主代码**一行没改**——新包只靠自己注册就出现在目录里。

## 玩法

- **左键**：翻开格子；空白格会自动展开相连区域。
- **右键**：插旗 / 取消旗子（未翻开的格子上）。
- **双击数字**（或**中键**）：数字周围的旗子数等于数字时，一次翻开其余邻格（快开 / chord）。
- **难度**：初级 9×9 / 10 雷、中级 16×16 / 40 雷、高级 30×16 / 99 雷（经典三档）。
- **首次点击必安全**：第一下点开的格子及其周围一圈不会埋雷。
- 踩雷后显示全部地雷与插错的旗；翻开所有安全格即胜利，会记录该难度的最佳用时。
- 计时从第一次翻开开始，最小化 / 切到后台标签页（引擎的 `document.hidden`）会暂停，回来继续；
  离开游戏页会落盘。

## 存档

- key：`localStorage['dsh.game.minesweeper.v1']`（**不碰** 2048 的 `dsh.game.2048.v1`）
- 内容：`{ schemaVersion: 1, difficulty, rows, cols, mines, mine, revealed, flagged,
  started, status, exploded, elapsedMs, best }`
- 解析失败 / 版本不符 / 局面自相矛盾 / `localStorage` 不可用时自动开新局，不抛错。
- 每次翻开、插旗、快开、胜负、切隐藏、卸载都会落盘；刷新页面后继续
  （用时以最近一次落盘为准，硬刷新可能少算几秒）。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-minesweeper`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「扫雷」。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。
> 改 `client.js` 约 1 秒热更新；改 `package.json` / `cordis.patch.yml` 需完全重启。

## 自测

```powershell
cd packages\dsh-game-minesweeper
node --check client.js
node dev/test-logic.mjs      # 纯逻辑 + 注册形状 + 存档校验，29 项
node dev/test-headless.mjs   # 假 DOM 跑完整 createGame，33 项
```

- `dev/preview.html`：浏览器直接打开可看 canvas 渲染/点击/插旗/主题的**开发预览**。
  它只验证画面与运行时 API，**不是**宿主内验收；宿主内验收要等插件面板安装后真机联调。

### 为什么纯逻辑也在 client.js 里

`client.js` 是模块加载器唯一服务的浏览器入口；加载器的 `require` 只解析模块表里的包
（`react` 等），**不支持包内相对路径同步 require**，所以单独的 `game.js` 在浏览器里拿不到。
纯逻辑因此放在 `client.js` 前部；只有测试进程设置
`window.__DSH_GAME_MINESWEEPER_TEST__ = true` 时，才会把纯逻辑挂到
`window.__DSH_GAME_MINESWEEPER__` 供 `dev/` 自测，正常运行不暴露任何全局。

## 实现要点

- 只 `inject: ['slots']`，只注册 `game.stage`；不提供服务、不注册其它 slot。
- `select` 严格按 `gameId === 'minesweeper'` 判断，其它游戏一律返回 `null`；返回冻结的
  `MATCHED` 对象避免 chain 渲染时 matched 引用抖动。
- 纯鼠标玩法：**完全不注册任何键盘监听**（window/document/根元素都没有），所以输入框打字
  不会触发游戏；canvas 在指针按下时聚焦，`tabIndex=0` 满足可聚焦要求。
- 键盘无需 `preventDefault`；右键 `contextmenu` 与中键滚动默认行为只在 canvas 上阻止。
- `ResizeObserver` + `devicePixelRatio` 重算 canvas 背板；另监听 `window resize` 处理拖到不同
  缩放显示器时 dpr 单独变化；< 320×240 显示「窗口太小」提示。
- 计时用 `requestAnimationFrame` 循环，只在 `status === 'playing'` 且页面可见时保留一帧，
  每秒最多 `onState` 一次；胜负、隐藏、卸载立即取消。没有动画，棋盘只在状态变化时重绘。
- `document.hidden` 时先提交已用时间、停帧、落盘；重新可见时从提交点继续，不「跳帧狂奔」。
- 运行期错误只显示游戏内「重试」提示（React 错误边界兜底），不拖白宿主页面。
- canvas 自绘不透明经典配色（亮/暗主题都可读）；工具栏/覆盖层用 `--dsw-alias-*` token。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client`，`exports` 含 `./client` / `./locale/*.json` / `./icon`；无 dependencies |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-minesweeper`） |
| `index.js` | 宿主半侧，空实现（UI 全在 client） |
| `client.js` | 浏览器侧：纯逻辑 + canvas + React 包装 + `game.stage` 注册 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标（地雷 + 小旗，内联 SVG） |
| `dev/` | 自测脚本与预览页（不在 `files` 里，不随包发布） |
