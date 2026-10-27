# 独立审计（verifier）— packages/dsh-game-solitaire/dev/audit/

本目录是**独立验证者**（teammate `verifier`）的审计资产，不属于游戏运行期文件，不随包发布
（`package.json` 的 `files` 不含 `dev/`）。

审计对象：`packages/dsh-game-solitaire/`（任务 `handoff/to-sub/009-add-solitaire.md`，契约
`handoff/contract/game-plugin-api.v1.md`）。审计只读游戏文件；本目录是唯一写入范围。

**重要：本目录下所有脚本都是只读脚本**，只打印结果、不写文件。原因是本会话的
`pwsh`/`node` 子进程对工作区是只读沙箱（`EPERM`），只有文件工具（write/edit）可写；
脚本因此设计为“读文件 + stdout 报告”，方便任何人在普通 shell 里复跑。

## 文件

| 文件 | 作用 |
|---|---|
| `harness.mjs` | 无头环境：假 window/document/localStorage/rAF/ResizeObserver + 动态 import client.js 拿测试 seam + 卡牌 id/canonical 适配器（被下面三个 fuzz 脚本共用） |
| `reference-solitaire.mjs` | 独立 Klondike 参考模型（按任务规则从零实现，不 import/copy client.js） |
| `reference-selftest.mjs` | 参考模型自测：发牌、移动规则、回收顺序、自动翻牌、胜利、纯度、不变量 |
| `check-contract.mjs` | 静态契约审计：package.json / cordis.patch.yml / index.js / locale / icon / client.js 注册形状 / 存档 key / 安全 grep / 跨包冲突 |
| `check-host-untouched.mjs` | 用 `baseline-hashes.json` 证明宿主包 `packages/dsh-game-host/**` 与契约文件未被改动 |
| `baseline-hashes.json` | 审计开始前的宿主/契约基线哈希（2026-10-18T09:06:32Z） |
| `diff-fuzz.mjs` | 差分模糊测试：同一 seed 下把 client.js 测试 seam 与参考模型逐张牌对拍（合法+非法动作） |
| `save-fuzz.mjs` | 存档 round-trip + 损坏存档变异 fuzz（不得抛错；非法存档必须拒绝或安全归一化） |
| `lifecycle.mjs` | 无头生命周期：createGame 挂载/计时/可见性暂停/落盘/恢复/destroy 幂等/无全局键盘监听/无 document.body |
| `drag-audit.mjs` | v1.1 拖拽层审计：独立几何命中测试 vs `drag.target`、6px 阈值、点击/拖拽共存与点击抑制、非法落点纯度、指针 capture/清理、静态接线 |
| `VERIFIER.md` | 最终结论（PASS / PASS WITH NOTES / BLOCKERS）、命令、计数、诚实边界（含 v1.1 拖拽 addendum §10） |

## 复跑命令（在仓库根目录执行）

```powershell
node packages/dsh-game-solitaire/dev/audit/reference-selftest.mjs   # 参考模型自测
node packages/dsh-game-solitaire/dev/audit/check-contract.mjs       # 静态契约
node packages/dsh-game-solitaire/dev/audit/check-host-untouched.mjs # 宿主未被改动
node packages/dsh-game-solitaire/dev/audit/diff-fuzz.mjs            # 差分逻辑 fuzz
node packages/dsh-game-solitaire/dev/audit/save-fuzz.mjs            # 存档 fuzz
node packages/dsh-game-solitaire/dev/audit/lifecycle.mjs            # 生命周期/无头
node packages/dsh-game-solitaire/dev/audit/drag-audit.mjs           # v1.1 拖拽层
```

退出码：0 = 通过；1 = 有 FAIL/BLOCKER。每个脚本的 stdout 末尾会给出计数。

## 边界（诚实声明）

- 无头审计：不安装插件、不启动宿主 GUI、不联网；浏览器/宿主联调由 Lead 负责。
- `diff-fuzz` 用假的 `window` 注入 `window.__DSH_GAME_SOLITAIRE_TEST__ = true` 后动态
  import `client.js`，直接驱动测试 seam（纯函数）。真实 React 渲染、宿主 slot 装配
  不在无头范围。
- 参考模型是“按规则重写”的独立实现；发牌/洗牌算法是否与实现一致由 `diff-fuzz` 的
  deal 对拍结果说明（若洗牌不同，会明确报告为 deal 差异而不是掩盖）。
