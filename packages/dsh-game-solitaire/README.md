# 接龙 — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的第七个独立游戏包：往宿主的
`game.stage` chain slot 注册经典 Klondike 纸牌接龙，装进 DSH 后出现在「游戏」页左侧目录里，
点开即可玩。宿主代码**一行没改**——新包只靠自己注册就出现在目录里。

## 玩法（经典 Klondike，一次翻 1 张）

- 52 张牌，四种花色 ♠♥♦♣，点数 A–K；7 列牌桌：第 1 列 1 张、第 7 列 7 张，只有每列最下面一张翻开。
- **牌堆 / 弃牌堆**：剩 24 张作牌堆，点一次翻 1 张到弃牌堆；牌堆空了再点一次，弃牌堆整体翻回去重翻（不限次数）。
- **牌桌**：只能按「降序、红黑交替」叠放；可以整段移动（被移动的段本身必须是合法序列）。
- **空列**：只接受 K（或以 K 开头的整段）。
- **基座**：同花色、从 A 开始升序收到 K；弃牌堆顶和牌桌面朝上的牌都能进基座。
  （基座顶牌也可以点选后移回牌桌，用于纠错——经典 Klondike 的便利操作，规范未禁止。）
- **自动翻牌**：牌桌上一段牌被移走后，新露出来的扣牌自动翻开。
- **胜利**：四个基座都到 K。
- **双击**一张顶牌（牌桌每列最下面那张，或弃牌堆顶）→ 尝试自动送进对应基座。
- **拖拽**：按住一张面朝上的牌（整段会一起拿起）拖到目标列/基座，松手放下；拖拽时目标高亮，
  非法位置自动弹回并提示原因。点击选中 → 再点放置的玩法同时保留。

### 操作（点击或拖拽）

| 操作 | 效果 |
|---|---|
| 拖拽面朝上的牌 / 整段 | 拖到合法目标列/基座松手；不合法的位置弹回并提示原因 |
| 点牌堆 | 翻 1 张到弃牌堆；牌堆空时点它 = 回收弃牌堆 |
| 点弃牌堆顶 / 牌桌面朝上的牌 | 选中（整段一起选中） |
| 选中后再点目标列 / 基座 | 放下；合法目标列会高亮，非法时提示原因 |
| 点基座顶牌 | 选中它，可移回牌桌（纠错用） |
| 点空列 | 若选中的是以 K 开头的段，放进去 |
| 双击顶牌 | 自动进基座 |
| 点空白处 / Esc | 取消选中 |
| 撤销 / 重开 / 新游戏 | 撤销一步（快照，至少 20 步）→ 重开同一副牌 → 换一副新牌 |

- 拖拽/点击二选一都行：移动超过 6 px 才算拖拽，原地点击仍是选中；拖拽结束后那一下点击会被吞掉，不会误选。
- 点「重开」＝ **同一副牌**重新发（种子相同）；点「新游戏」＝ 换随机种子重新洗牌。
- 计时从第一次操作开始，切到后台标签页（`document.hidden`）会暂停，回来继续不跳时；离开游戏页会落盘。
- 右键菜单在游戏区内被 `preventDefault` 禁用；游戏区没有全局键盘监听，只在根元素上处理 Esc / Ctrl+Z。

## 存档

- key：`localStorage['dsh.game.solitaire.v1']`（**不碰** 2048 / 扫雷 / 墙棋 / 复扫雷的 key）
- 内容：`{ schemaVersion: 1, seed, started, won, moves, elapsedMs, stock, waste,
  foundations, tableau, undo }`
  - `seed` 是整副牌的确定性种子（重开同一副牌靠它）
  - `tableau` 用紧凑编码：`< 52` 表示正面、`52..103` 表示背面（值 − 52 是牌 id）
  - `undo` 只存最近 40 个快照（内存里最多保留 200 步）
- 解析失败 / 版本不符 / 牌数不是 52 / 重复牌 / 基座顺序错 / 扣牌下面出现翻牌 / 序列不合法 /
  用时或步数越界 → **整档丢弃并开新局**，不抛错。
- 每次操作、切隐藏、卸载都会落盘；硬刷新时以最近一次落盘为准（可能少算几秒用时，局面不丢）。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-solitaire`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「接龙」。

> 首次可能不生效：完全退出客户端（托盘退出）再打开。
> 改 `client.js` 约 1 秒热更新；改 `package.json` / `cordis.patch.yml` 需完全重启。

## 自测

```powershell
cd packages\dsh-game-solitaire
node --check client.js
node dev/test-logic.mjs      # 纯逻辑 + 发牌 + 规则 + 存档 + 布局，35 项
node dev/test-headless.mjs   # 假 DOM 跑完整 createGame 生命周期（含 8 项拖拽），28 项
```

- `dev/preview.html`：浏览器直接打开可看 DOM 渲染、拖拽、选中/高亮、自动翻牌、回收、胜利、主题与
  尺寸切换的**开发预览**；页面内「运行交互自检」会用真实 DOM 点击/合成指针拖拽 + 存档断言跑 24 项检查。
  它只验证画面与运行时 API，**不是**宿主内验收；宿主内验收要等插件面板安装后真机联调。
- `dev/fake-react.js` 只是预览页用的最小 React 兼容渲染器（**不随包发布**）；宿主里游戏用真实 React。

### 为什么纯逻辑也在 client.js 里

`client.js` 是模块加载器唯一服务的浏览器入口；加载器的 `require` 只解析模块表里的包
（`react` 等），**不支持包内相对路径同步 require**，所以单独的 `game.js` 在浏览器里拿不到。
纯逻辑因此放在 `client.js` 前部；只有测试进程设置
`window.__DSH_GAME_SOLITAIRE_TEST__ = true` 时，才会把纯逻辑挂到
`window.__DSH_GAME_SOLITAIRE__` 供 `dev/` 自测与独立 verifier 差分测试，正常运行不暴露全局。

## 实现要点

- 只 `inject: ['slots']`，只注册 `game.stage`；不提供服务、不注册其它 slot。
- `select` 严格按 `gameId === 'solitaire'` 判断，其它游戏一律返回 `null`；返回冻结的
  `MATCHED` 对象避免 chain 渲染时 matched 引用抖动。
- 单文件 `client.js`，DOM 渲染 + 前缀化 `<style>`（`dshsol-` 前缀），**不挂 document.body、不污染宿主样式**；
  React 从模块表拿，不引第三方库。
- 根元素 `width/height: 100%`；`ResizeObserver` 监听自己的牌桌元素 + `window resize` 兜底；
  布局按容器宽高算牌宽/牌高/列距/列内偏移，极小列自动压缩偏移保证不溢出；dpr 变化也触发重排
  （DOM 渲染本身不需要 dpr 缩放，但会追踪 `devicePixelRatio` 以便缩放时重算布局）。
  `ResizeObserver` 回调延后一帧再改布局，避免 Chromium 的 "ResizeObserver loop" 警告。
- < 320 × 240 显示「窗口太小」提示而不是画烂。
- 计时用 `requestAnimationFrame`，只在「已开始且未胜利且页面可见」时保留一帧，每秒最多
  `onState` 一次；胜负、隐藏、卸载立即取消。
- 撤销用整局快照（牌堆/弃牌堆/基座/牌桌/步数/胜负），不重算历史；操作前压栈，非法操作回滚栈。
- 拖拽用 Pointer Events（鼠标/触屏/触控笔同一套）：6 px 阈值区分点击；超过阈值才 `setPointerCapture`，
  因此原地点击完全走原 click 逻辑；拖动期间只渲染一份浮层（原牌 `visibility:hidden`），落点用布局矩形
  做命中测试（列/基座区域外扩 6% 牌宽），失败落点不写存档也不压撤销栈；`pointercancel`/拖出牌桌都安全取消。
  牌桌设 `touch-action:none`，不会拖着拖着把页面滚走；拖拽相关的监听全部是 React 挂在自家牌桌上的，
  没有 window/document 全局指针监听。
- 运行期错误只显示游戏内「重试」提示（React 错误边界 + `onError` 兜底），不拖白宿主页面。
- 工具栏/按钮/弹窗用 `--dsw-alias-*` token（带亮色兜底值）；牌桌自配色（绿毡、奶白牌面、
  红黑花色），亮/暗主题下都可读。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web',immediately:true}`，`exports` 含 `./client` / `./locale/*.json` / `./icon`；无 dependencies、无 `dsh.client.inject` |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-solitaire`） |
| `index.js` | 宿主半侧，空实现（UI 全在 client） |
| `client.js` | 浏览器侧：确定性洗牌/发牌 + 规则 + 快照撤销 + 存档 + 布局 + DOM/React UI + 点击/拖拽交互 + `game.stage` 注册 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标（绿毡 + 两张牌 + 黑桃/红桃，内联 SVG） |
| `dev/` | 自测脚本、最小 fake-react、预览页与截图（不在 `files` 里，不随包发布） |
