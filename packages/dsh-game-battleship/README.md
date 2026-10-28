# 海战棋 Battleship（`@local/dsh-game-battleship`）

DSH 游戏页（`dsh-game-host` 的 `game.stage` chain slot）的第八个游戏：**经典海战棋**。
双方各一块 **10×10** 海域、**5 艘舰船**，互相看不见对方舰队，靠开火推理，先击沉对方全部 5 艘者胜。

- 游戏 id：`battleship`
- 插件包名：`@local/dsh-game-battleship`
- 目录名：**海战棋**
- 安装路径（插件页填这个）：
  `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-battleship`
- 存档 key：`localStorage['dsh.game.battleship.v1']`（`schemaVersion: 1`，不读写其它游戏的 key）

## 规则

| 舰船 | 长度 |
|---|---|
| 航空母舰 | 5 |
| 战列舰 | 4 |
| 巡洋舰 | 3 |
| 潜艇 | 3 |
| 驱逐舰 | 2 |

- 每方 17 个舰船格；**横或竖**放置，不可重叠、不可出界。
- **默认不允许相邻（正交和斜向都不行）**；布阵阶段可点「允许相邻」放开（经典规则，默认关闭）。
- 玩家先开火；双方轮流射击对方海域一格，反馈 **命中 / 未命中**。
- 一艘船的所有格都被击中 → **击沉**，状态栏/提示会显示船名（如「击沉『战列舰』！」）。
- 先击沉对方全部 5 艘 → 胜利；提示与结算面板同时给出双方开火/命中统计。
- 「重开」：保留双方舰队、清空射击，重新开打；「新游戏」：重新布阵（新种子）。

## 模式

| 模式 | 说明 |
|---|---|
| 单人 | 你对战 AI（默认）。难度可选简单 / 普通 / 困难 |
| 双人 | **同一台设备轮流**：玩家 A 与玩家 B 各自布阵、轮流开火，没有 AI |

双人的隐私流程（这是同机对战的关键，别跳过）：

1. 玩家 A 布阵 → 点「完成布阵」→ 出现遮罩「请把设备交给 玩家 B」
2. B 点「我是 玩家 B，继续」→ B 布阵 → 点「完成布阵」→ 再次遮罩 → A 确认
3. 开战后，A 先手。每打一发，界面**停在 A 的视角**，状态栏出现「交给 玩家 B →」
4. A 点交棒 → 遮罩盖住棋盘 → B 确认后才显示 B 的海域
5. B 打一发后同样交回给 A

遮罩是不透明的全覆盖层；未确认前棋盘一行都不渲染。切换模式（单人 / 双人）会立即开始一局新游戏。

## 操作

### 布阵阶段

- 双人模式下先由玩家 A 布阵（只有一块棋盘），点「完成布阵」后交给 B；B 在**同一块盘面**上布自己的舰队，双方舰队互相不可见。
- 点击**你的海域**放置当前舰船：落点 = 点击格，横向向右生长 / 纵向向下生长。
- 「旋转 (R)」按钮或键盘 **R** 切换横竖；鼠标悬停显示绿色（可放）/红色（不可放）预览。
- 「随机布阵」一键随机（随机结果本身也保证不重叠、不出界、默认不相邻）。
- 「撤销」撤回上一艘；放完 5 艘后「开始」可点。
- 「允许相邻」可在开始前切换；若已放下的舰队有相邻舰船，则不允许关闭（会提示原因）。
- 非法落点（越界 / 重叠 / 相邻）会拒绝并说明原因，不会写入存档。

### 对战阶段

- 点击**敌方海域**空格开火；已打过的格子不能重复打。
- 敌方海域只显示你的射击结果：未命中点、命中 ✕、击沉红格；你的海域显示自己的舰船 + 被命中/击沉的格子。
- 两块 10×10 网格并排（宽屏）或上下叠放（窄屏）；每块下面有 5 艘舰船的剩余列表，被击沉置灰划线。
- 状态栏显示回合提示（你的回合 / 敌方思考中）与命中/未命中/击沉短提示（约 2.6 秒后自动消失）。
- 顶部可随时切换难度（简单 / 普通 / 困难，影响 AI 之后的选择）；「投降」在本局结束前可用（玩家回合）。
- 「重开」「新游戏」；结束后面板可「再来一局」。
- 双人模式下没有「难度」按钮；状态栏显示双方发数/命中，「我方海域 / 对方海域」始终以当前操作者的视角呈现。

## AI

| 难度 | 策略 |
|---|---|
| 简单 | 纯随机：在未打过的格子里均匀随机 |
| 普通 | **hunt / target**：随机打；命中后优先打相邻四格，两个以上命中连成线时优先打线的两端；击沉后回到随机 |
| 困难 | hunt / target + **概率分布**：按剩余舰长枚举所有合法摆放，给每格累加覆盖次数；有未解决命中时只在邻格中选概率最高者，否则全盘选概率最高者（同分随机） |

所有难度都保证：**不重复打同一格、不卡死**（候选集为空时回到未打过的格子；真正无格可打时游戏已结束）。随机数状态随存档保存，`AI 走法在恢复后继续同一条随机序列`。

## 存档

```json
{
  "schemaVersion": 1,
  "seed": 123,
  "rng": 456,
  "mode": "ai | duo",
  "phase": "place | battle | over",
  "allowAdjacent": false,
  "difficulty": "easy | normal | hard",
  "orientation": "h | v",
  "placementIndex": 0,
  "placeTurn": "player | enemy",
  "handoff": "null | pass | curtain",
  "playerShips": [{ "key": "carrier", "cells": [0, 1, 2, 3, 4] }],
  "enemyShips": [{ "key": "carrier", "cells": [20, 21, 22, 23, 24] }],
  "playerShots": [0, 0, 1, 2, "..."],
  "enemyShots": [0, 1, 0, 2, "..."],
  "turn": "player | enemy",
  "winner": null,
  "endReason": null
}
```

- `mode`：`ai` = 单人（默认），`duo` = 同机双人。**旧存档没有这个字段时按 `ai` 读取**，不会误判重开。
- `placeTurn`：双人布阵时正在布阵的一方；`player` = A，`enemy` = B（B 的舰队沿用 `enemyShips` 这个槽）。
- `handoff`：`null` 正常可操作；`pass` = 刚开完火、等本回合玩家点「交给」；`curtain` = 遮罩已盖住、等下一位确认。

- `playerShots`：玩家射向敌方的 100 格结果（0 未知 / 1 未命中 / 2 命中）。
- `enemyShots`：AI 射向玩家海域的 100 格结果。
- `endReason`：`"sunk"`（正常击沉结束）或 `"surrender"`（投降）或 `null`。
- **校验**：版本不符、字段缺失/类型错误、舰船重叠/出界/相邻违规、命中落在水上、未命中落在船上、回合与开火数奇偶不符、胜负与舰队状态不符……一律丢弃并开新局（不会抛错）。
- 卸载/切页/隐藏时落盘；重新进入恢复布阵进度或对战局面（双方海域、射击、回合、AI 待走的一步都会继续）。
- `localStorage` 不可用或写入失败时不影响内存内游玩。

## 安装（由用户操作）

1. 左侧栏底部「插件」页 → 添加插件 → 填**本地绝对路径**：
   `D:\desktop_files\artificial_intelligence\dsh-game-host\packages\dsh-game-battleship`
2. 安装后点「立即启用」。
3. 进「游戏」页，左侧目录应出现「海战棋」（与 2048 / 扫雷 / 墙棋 / 复扫雷 / 俄罗斯方块 / 数独 / 接龙共存）。
4. 首次可能需完全退出客户端（托盘退出）再打开。
5. 之后改 `client.js` 约 1 秒热更新；改 `package.json` / `cordis.patch.yml` 需完全重启。

## 自测（dev-only，不随包发布，`package.json.files` 不含 `dev/`）

```powershell
node packages/dsh-game-battleship/dev/test-logic.mjs     # 纯逻辑：规则/AI/存档/布局/确定性
node packages/dsh-game-battleship/dev/test-duo.mjs       # 双人：布阵路由/交棒/视角/胜负/存档
node packages/dsh-game-battleship/dev/test-headless.mjs  # 假 DOM 生命周期：挂载/落盘/恢复/计时器/监听器
# 真实 Chromium 开发预览（非宿主验收）：打开 dev/preview.html
node packages/dsh-game-battleship/dev/audit/reference-selftest.mjs  # 独立 verifier 参考模型自测
node packages/dsh-game-battleship/dev/audit/check-contract.mjs      # 静态契约/manifest/跨包冲突
node packages/dsh-game-battleship/dev/audit/check-host-untouched.mjs# 宿主与契约文件未被改动
node packages/dsh-game-battleship/dev/audit/diff-fuzz.mjs           # 与独立参考模型差分 fuzz
node packages/dsh-game-battleship/dev/audit/save-fuzz.mjs           # 存档往返 + 坏档 fuzz
node packages/dsh-game-battleship/dev/audit/lifecycle.mjs           # 无头生命周期
```

`dev/preview.html` 是假宿主页面：`?selftest=1` 自动跑交互自检，`?theme=dark` / `?size=360x520` 等参数切换主题和舞台尺寸；截图在 `dev/screenshots/`。

## 实现要点

- 单文件 `client.js`：纯逻辑 + 控制器 + React UI；React 从模块表 `require('react')` 拿，**无第三方依赖**。
- 双人没有 AI 分支：`fireAtSide(state, side, cell)` 是唯一开火入口，射击记录永远记在**被打一方**的棋盘上（`playerShots`/`enemyShots`）；`viewSideOf(state)` 决定棋盘以谁的视角渲染，所以 A 和 B 只是同一套逻辑的两个 side。
- 双人布阵只画一块棋盘，`computeLayout(w, h, 1)` 会按单盘给尺寸；进出布阵阶段会自动重新测量。
- 只 `inject: ['slots']`，只注册 `game.stage`；`select` 严格判断 `gameId === 'battleship'`，宿主未装/停用时不报错。
- DOM 渲染（非 canvas）：根元素 `width:100%; height:100%`，`ResizeObserver` 监听自身根元素 + `[data-dsh-body]`，按**实测**可用区域算两块棋盘尺寸（不读 `window.innerWidth`）；`devicePixelRatio` 变化也重算；`< 320×240` 或棋盘小于 90px 时显示「窗口太小」。
- 棋盘/命中/未命中/击沉/预览自配色（暗色亮色都可读），工具栏/文字用 `--dsw-alias-*` token。
- 键盘只挂在自己的根元素上（`tabIndex=0`）：R 旋转；**没有** `window/document` 的 keydown 监听；输入框打字不会触发。
- 生命周期：挂载读存档、`ResizeObserver`、AI 延时器；`destroy()` 清计时器/监听器/观察器并落盘，可重入（幂等）；`document.hidden` 时暂停 AI 计时，可见时继续。
- 错误处理：动作、渲染回调、存档读写全部 `try/catch`；React 错误边界 + 游戏内「重试」，不白屏宿主。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web', immediately:true}`；exports 含 `.` / `./client` / `./locale/*.json` / `./icon`；无 dependencies、无 `dsh.client.inject` |
| `cordis.patch.yml` | `insert: id: game-battleship, name: '@local/dsh-game-battleship'` |
| `index.js` | 宿主半侧空 `apply()` |
| `client.js` | 游戏全部逻辑 + UI + `game.stage` 注册（单文件） |
| `locale/zh.json`、`locale/en.json` | 插件面板标题/描述 |
| `icon.svg` | 海面 + 舰船 + 瞄准环 |
| `dev/` | 自测、预览、截图、独立审计（dev-only） |

## 已知边界

- 本机未安装插件，**宿主真机验收由用户按契约 §10 与任务书完成**；开发预览用最小 fake-react + 假宿主，不等于宿主运行时。
- 小尺寸下为保证两块 10×10 都完整可见，舰船列表会退化为「长度数字 + 颜色点」紧凑药丸（悬停/标题仍给全名）；`< 320×240` 显示太小提示。
- 「重开」按约定保留双方舰队；测试/实现不依赖计时，因此没有用时统计。
