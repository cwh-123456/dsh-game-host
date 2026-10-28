# 俄罗斯方块 — DSH 游戏平台游戏包

这是 [`dsh-game-host`](../dsh-game-host/) 游戏平台的一个独立游戏包：往宿主的 `game.stage`
chain slot 注册「俄罗斯方块」，装进 DSH 后出现在「游戏」页左侧目录里，点开即可玩。

- `gameId`：`tetris`；包名：`@local/dsh-game-tetris`；目录显示名：**俄罗斯方块**
- 存档：`localStorage['dsh.game.tetris.v1']`

## 玩法与操作

- 棋盘 **10 列 × 20 行**，上方另有 2 行隐藏出生区（内部 22 行）。
- 7 种方块 I、O、T、S、Z、J、L，每种 4 个旋转态；**7-bag** 随机（7 种洗牌发完再洗下一袋）。
- 棋盘上显示**幽灵方块**（当前方块的落点预览）；右侧显示 **HOLD** 槽和 **NEXT** 队列（5 个）。

| 按键 | 作用 |
|---|---|
| `←` / `→` | 左右移动 |
| `↓` | 软降，每格 +1 分 |
| `↑` 或 `X` | 顺时针旋转 |
| `Z` | 逆时针旋转 |
| `空格` | 硬降，每格 +2 分并立即落定 |
| `C` 或 `Shift` | 暂存 / 换回暂存方块（每个方块只能暂存一次） |
| `P` | 暂停 / 继续 |
| `R` | 重开一局 |

- **墙踢**（简化版）：旋转时依次尝试原地、±1 列、±2 列、上移 1 行。
- **下落速度**：`dropMs = max(80, 800 - (level-1) * 60)`，由时间戳累加驱动，不按帧计数。
- **锁定延迟**：方块落地后 **400 ms** 落定；每次成功移动/旋转会重置计时，最多重置 15 次。
- **消行计分**：1 / 2 / 3 / 4 行 = 100 / 300 / 500 / 800 × 当前等级（升级前等级）。
- 每消 **10 行**升 1 级。
- 新方块无法出生（出生位置被占）→ 游戏结束，显示得分/消行/等级与「再来一局」。
- 暂停 / 游戏结束 / 出错都有遮罩与按钮。

## 游戏内规则

工具栏里的「📖 规则」按钮会弹出完整的规则与操作说明。弹窗分四节：目标、方块与随机、按键、计分与速度。

- 弹窗打开期间，键盘事件不会再传给棋盘（按 `Esc` 或点 `×` / 遮罩关闭），不会一边看规则一边误操作。
- 规则文本随代码一起发布，离线可用，不依赖网络。

## 存档

- key：`localStorage['dsh.game.tetris.v1']`
- 内容：`{ schemaVersion: 1, board, current, queue, bag, hold, canHold, score, lines, level, playMs, over, paused }`
  - `board`：22 × 10 的 0..7 数字（0 空，1..7 = I O T S Z J L）
  - `queue` / `bag`：7-bag 现状（恢复后出块序列连续）
  - `paused`：只记录**用户主动暂停**；切标签页/失焦的自动暂停不写入
- 离开游戏页、切回对话、刷新页面后进度仍在（棋盘、当前方块、队列、暂存、分数、行数、等级、用时）。
- 解析失败 / 版本不符 / 结构非法 / 方块与棋盘重叠 → 丢弃存档并开新局，不抛错。

## 安装（由用户在插件面板操作）

1. 打开 DSH 左侧栏底部「插件」页 → 添加插件；
2. 填本地绝对路径：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-tetris`
3. 安装后点「立即启用」，进「游戏」页，左侧目录应出现「俄罗斯方块」
   （应与 2048 / 扫雷 / 墙棋 / 复扫雷 共存）；
4. 首次可能不生效：完全退出客户端（托盘退出）再打开。

## 自测

```powershell
cd packages\dsh-game-tetris
node --check client.js
node dev/test-logic.mjs      # 纯逻辑 + 契约形状，34 项
node dev/test-headless.mjs   # 假 DOM 跑完整 createGame，41 项
node dev/fuzz.mjs            # 7-bag / 随机不变量 / 坏档 fuzz
```

- `dev/preview.html`：浏览器直接打开可看 canvas 渲染、键盘、暂停、亮/暗主题的**开发预览**。
  它只验证画面与运行时 API，**不是**宿主内验收；宿主内验收要等插件安装后真机联调。

## 实现要点

- 只 `inject: ['slots']`，只注册 `game.stage`；不提供服务、不注册其它 slot、不抢全局快捷键、
  不改宿主、不引第三方库。
- 键盘监听**只挂在 canvas 上**（`tabIndex=0`），挂载后主动 `focus()`；overlay 按钮点击后
  React 包装层会把焦点交还 canvas。方向键/空格 `preventDefault()` 防止页面滚动。
- `ResizeObserver` + `devicePixelRatio` 重算 canvas；`window resize` 补充处理 dpr 单独变化；
  `< 340 × 300` 显示「窗口太小」提示。
- **重力/锁定都用时间戳累加**：暂停、切页、失焦后重置时间基准，恢复时不跳帧（单帧 dt 上限 250 ms）。
- `document.hidden` / `window blur` 自动暂停，`visibilitychange` / `focus` 自动恢复；
  用户按 `P` 暂停则不自动恢复。
- 组件卸载 `destroy()` 停 rAF、摘监听、断开 ResizeObserver、落盘；每 4 秒也自动落盘一次。
- 所有事件处理（键盘/焦点/visibility/blur/resize）、帧循环、存档读写都 try/catch；运行期错误只显示
  游戏内「重试」提示。存档计数字段序列化时会钳制到合法上限，极端长局也不会因超限被判成坏档。
- 画布自绘不透明深色棋盘（亮/暗主题都可读）；HOLD/NEXT 面板与文字颜色从
  `--dsw-alias-*` token 取样，取不到时用内置兜底色；工具栏/遮罩/按钮全部用 token。

### 为什么纯逻辑也在 client.js 里

`client.js` 是模块加载器唯一服务的浏览器入口；加载器的 `require` 只解析模块表里的包
（`react` 等），**不支持包内相对路径同步 require**，所以单独的 `game.js` 在浏览器里拿不到。
纯逻辑因此放在 `client.js` 前部；只有测试进程设置
`window.__DSH_GAME_TETRIS_TEST__ = true` 时，才会把纯逻辑挂到 `window.__DSH_GAME_TETRIS__`
供 `dev/` 自测，正常运行不暴露任何全局。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web',immediately:true}`；`exports` 含 `.` / `./client` / `./locale/*.json` / `./icon`；无 dependencies |
| `cordis.patch.yml` | 插入宿主 Loader 行（`id: game-tetris`） |
| `index.js` | 宿主半侧空 `apply()`（UI 全在 client） |
| `client.js` | 浏览器侧单文件：7-bag/旋转/墙踢/消行计分/存档 + canvas 渲染 + React 包装 + `game.stage` 注册 |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 插件列表图标 |
| `dev/` | 自测脚本与预览页（不在 `files` 里，不随包发布） |

## 诚实边界

- 本包**没有**自己安装插件、没有改 profile、没有在宿主内真机运行；宿主内渲染、明暗主题观感、
  切页恢复、控制台无报错等仍需按契约 v1 §10 真机联调。
- `dev/preview.html` 是假宿主页面，不能替代宿主内验收。
- 简化墙踢（非完整 SRS）：极少数贴墙旋转的手感与标准 SRS 不同，但不会卡墙、不会传墙。
