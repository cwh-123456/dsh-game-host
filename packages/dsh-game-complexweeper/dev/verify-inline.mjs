/* =========================================================================
 * client.js 内联引擎完整性验证 + 测试探针 / 规则关键断言
 * -------------------------------------------------------------------------
 * 1) 用锚点从 ../client.js 抽取内联引擎块，必须与 ../engine.js 逐字节相等：
 *      /* >>> DSH INLINE ENGINE BEGIN ... >>> *\/
 *      /* <<< DSH INLINE ENGINE END <<< *\/
 *    两个锚点必须各恰好出现一次、BEGIN 在 END 之前。
 * 2) 在假 window 环境（测试探针开关 + __ModuleLoader__.load 捕获 +
 *    localStorage/document/ResizeObserver/performance stub）下用 node:vm
 *    执行整份 client.js，断言：
 *      - __ModuleLoader__.load 被调用且 id / factory 正确；
 *      - 测试探针 window.__DSH_GAME_COMPLEXSWEEPER__ 暴露完整 API；
 *      - 内联引擎执行后 window.CS 被还原（原本没有 → 删除；原本有 → 恢复原值）；
 *      - factory(require) 返回 inject:['slots'] + apply()，注册进 game.stage；
 *      - MATCHED 冻结且 select 恒等返回同一个对象。
 * 3) 用探针暴露的引擎跑规则断言（线索 0 vs 空白、24 种显示、首点安全、
 *    展开判据三例、胜负、存档往返）。
 *
 * 复跑：  node dev/verify-inline.mjs
 * 只读：  本脚本不写任何文件。
 * =========================================================================*/
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(PKG_DIR, 'client.js')
const ENGINE_PATH = path.join(PKG_DIR, 'engine.js')

const BEGIN_ANCHOR = '/* >>> DSH INLINE ENGINE BEGIN'
const END_ANCHOR = '/* <<< DSH INLINE ENGINE END'

/* Lead 冻结的 engine.js 权威指纹（2026-10-18，LOCK）：任何变化都必须重新内联并更新这里 */
const EXPECTED_ENGINE_BYTES = 25002
const EXPECTED_ENGINE_SHA256 = 'A3CAE327CD7B4FDC63C48E8BD5C8672656B2B0DD7EB96B91EB0DC29B43972069'

/* ---------------------------- 测试框架 ---------------------------- */
let pass = 0
let fail = 0
let curGroup = null
function group(name) {
  finishGroup()
  curGroup = { name, p0: pass, f0: fail }
  console.log('\n== ' + name + ' ==')
}
function finishGroup() {
  if (!curGroup) return
  console.log(`-- ${curGroup.name}: ${pass - curGroup.p0} 通过, ${fail - curGroup.f0} 失败`)
  curGroup = null
}
function ok(cond, msg) {
  if (cond) pass += 1
  else {
    fail += 1
    console.log('  ✗ ' + msg)
  }
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}
function countOccurrences(text, needle) {
  let n = 0
  let i = -1
  while ((i = text.indexOf(needle, i + 1)) !== -1) n += 1
  return n
}

/* ===================================================================== */
group('锚点抽取 + 内联块逐字节比对')
const engineBuf = readFileSync(ENGINE_PATH)
const engineSha = createHash('sha256').update(engineBuf).digest('hex').toUpperCase()
const clientBuf = readFileSync(CLIENT_PATH)
const clientText = clientBuf.toString('utf8')

const beginCount = countOccurrences(clientText, BEGIN_ANCHOR)
const endCount = countOccurrences(clientText, END_ANCHOR)
ok(beginCount === 1, `BEGIN 锚点应恰好出现 1 次，实际 ${beginCount} 次`)
ok(endCount === 1, `END 锚点应恰好出现 1 次，实际 ${endCount} 次`)

const beginIdx = clientText.indexOf(BEGIN_ANCHOR)
const endIdx = clientText.indexOf(END_ANCHOR)
ok(beginIdx >= 0 && endIdx > beginIdx, `锚点顺序错误: BEGIN=${beginIdx} END=${endIdx}`)

const anchorLineEnd = clientText.indexOf('\n', beginIdx)
ok(anchorLineEnd > beginIdx, 'BEGIN 锚点行没有换行符')
const inlineText = anchorLineEnd > beginIdx ? clientText.slice(anchorLineEnd + 1, endIdx) : ''
const inlineBuf = Buffer.from(inlineText, 'utf8')
const inlineSha = createHash('sha256').update(inlineBuf).digest('hex').toUpperCase()

ok(inlineBuf.length === engineBuf.length, `内联块字节数 ${inlineBuf.length} != engine.js ${engineBuf.length}`)
ok(
  Buffer.compare(inlineBuf, engineBuf) === 0,
  `内联块与 engine.js 不是逐字节相等（内联 sha=${inlineSha} 引擎 sha=${engineSha}）`,
)
ok(engineBuf.length === EXPECTED_ENGINE_BYTES,
  `engine.js 字节数 ${engineBuf.length} != 冻结值 ${EXPECTED_ENGINE_BYTES}（engine.js 变了？）`)
ok(engineSha === EXPECTED_ENGINE_SHA256,
  `engine.js sha256 ${engineSha} != 冻结值 ${EXPECTED_ENGINE_SHA256}（engine.js 变了？）`)
ok(inlineBuf.length === EXPECTED_ENGINE_BYTES, `内联块字节数 ${inlineBuf.length} != 冻结值 ${EXPECTED_ENGINE_BYTES}`)
ok(inlineSha === EXPECTED_ENGINE_SHA256, `内联块 sha256 ${inlineSha} != 冻结值 ${EXPECTED_ENGINE_SHA256}`)
console.log(`  内联块: ${inlineBuf.length} bytes  sha256=${inlineSha}`)
console.log(`  engine.js: ${engineBuf.length} bytes  sha256=${engineSha}`)

/* 源码级契约检查（不依赖运行期） */
group('源码级契约：无键盘监听 / 不碰 document.body / 不改 title')
ok(!/addEventListener\s*\(\s*['"`]key/i.test(clientText), 'client.js 不应注册任何 key* 事件监听')
ok(!/onKeyDown|onKeyUp|onKeyPress/.test(clientText), 'client.js 不应有 onKey* props')
ok(!/document\.body/.test(clientText), 'client.js 不应挂节点到 document.body')
ok(!/document\.title/.test(clientText), 'client.js 不应修改 document.title')
ok(!/window\.addEventListener\s*\(\s*['"`]key/i.test(clientText), 'client.js 不应在 window 上挂键盘监听')
ok(/inject:\s*\['slots'\]/.test(clientText), "client.js 的 inject 应为 ['slots']")
ok(!/ctx\.provide\s*\(/.test(clientText), 'client.js 不应提供额外服务')

/* ===================================================================== */
/* 假 window 环境 + vm 执行 client.js                                      */
/* ===================================================================== */
function makeStorage() {
  const map = new Map()
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null
    },
    setItem(key, value) {
      map.set(String(key), String(value))
    },
    removeItem(key) {
      map.delete(String(key))
    },
    clear() {
      map.clear()
    },
    key(index) {
      const keys = Array.from(map.keys())
      return index < keys.length ? keys[index] : null
    },
    get length() {
      return map.size
    },
  }
}

function makeCanvasStub() {
  return {
    width: 0,
    height: 0,
    style: { cssText: '' },
    tabIndex: 0,
    setAttribute() {},
    getContext() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 }
    },
  }
}

function runClient(preCS, enableTest) {
  const storage = makeStorage()
  const documentStub = {
    hidden: false,
    title: 'untouched-title',
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return makeCanvasStub()
    },
    body: { appendChild() {} },
  }
  const windowObj = {
    localStorage: storage,
    document: documentStub,
    devicePixelRatio: 2,
    performance: { now: () => 1000 },
    addEventListener() {},
    removeEventListener() {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  }
  if (enableTest !== false) windowObj.__DSH_GAME_COMPLEXSWEEPER_TEST__ = true
  if (preCS !== undefined) windowObj.CS = preCS
  let capturedModule = null
  windowObj.__ModuleLoader__ = {
    load(definition) {
      capturedModule = definition
    },
  }
  windowObj.window = windowObj
  const sandbox = {
    window: windowObj,
    document: documentStub,
    localStorage: storage,
    performance: windowObj.performance,
    console,
    setTimeout,
    clearTimeout,
    ResizeObserver: windowObj.ResizeObserver,
    devicePixelRatio: 2,
  }
  const context = createContext(sandbox)
  let execError = null
  try {
    runInContext(clientText, context, { filename: CLIENT_PATH })
  } catch (error) {
    execError = error
  }
  return { windowObj, capturedModule, execError, storage, context }
}

group('假 window 环境下执行 client.js')
const firstRun = runClient(undefined)
ok(firstRun.execError === null, `执行 client.js 抛错: ${firstRun.execError && (firstRun.execError.stack || firstRun.execError.message)}`)
const probe = firstRun.windowObj.__DSH_GAME_COMPLEXSWEEPER__
ok(!!probe, 'window.__DSH_GAME_COMPLEXSWEEPER__ 不存在（测试探针未安装）')
ok(firstRun.capturedModule && firstRun.capturedModule.id === '@local/dsh-game-complexweeper',
  `__ModuleLoader__.load 未被调用或 id 不符: ${firstRun.capturedModule && firstRun.capturedModule.id}`)
ok(firstRun.capturedModule && typeof firstRun.capturedModule.factory === 'function',
  '__ModuleLoader__.load 传入的 factory 不是函数')
ok(firstRun.windowObj.CS === undefined, '内联引擎执行后没有还原 window.CS（原本没有却残留）')
ok(firstRun.capturedModule && firstRun.capturedModule.id === '@local/dsh-game-complexweeper',
  'module id 应为 @local/dsh-game-complexweeper')

/* 原本有 window.CS → 必须恢复原值 */
const sentinel = { marker: 'previous-CS' }
const secondRun = runClient(sentinel)
ok(secondRun.execError === null, `带旧 window.CS 执行 client.js 抛错: ${secondRun.execError && secondRun.execError.message}`)
ok(secondRun.windowObj.CS === sentinel, '内联引擎执行后没有还原调用前的 window.CS 原值')
const probe2 = secondRun.windowObj.__DSH_GAME_COMPLEXSWEEPER__
ok(!!probe2 && !!probe2.E && typeof probe2.E.Game === 'function', '带旧 window.CS 时测试探针仍应暴露真实引擎')

/* 生产模式（未打开测试开关）→ 不安装探针，CS 同样不残留 */
const prodRun = runClient(undefined, false)
ok(prodRun.execError === null, `生产模式执行 client.js 抛错: ${prodRun.execError && prodRun.execError.message}`)
ok(prodRun.windowObj.__DSH_GAME_COMPLEXSWEEPER__ === undefined,
  '未打开 __DSH_GAME_COMPLEXSWEEPER_TEST__ 时不应安装测试探针')
ok(prodRun.windowObj.CS === undefined, '生产模式下内联引擎仍必须还原 window.CS')
ok(prodRun.capturedModule && prodRun.capturedModule.id === '@local/dsh-game-complexweeper',
  '生产模式仍应注册 module id')

const E = probe && probe.E
const CS = E

/* ===================================================================== */
group('测试探针 API 形状')
if (!probe) {
  ok(false, '没有测试探针，无法检查 API')
} else {
  const REQUIRED = ['E', 'Game', 'GAME_ID', 'STORE_KEY', 'MATCHED', 'createGame']
  for (const name of REQUIRED) ok(probe[name] !== undefined && probe[name] !== null, `探针缺少 ${name}`)
  eq(probe.GAME_ID, 'complexweeper', '探针 GAME_ID')
  eq(probe.STORE_KEY, 'dsh.game.complexweeper.v1', '探针 STORE_KEY')
  eq(probe.Game, E.Game, '探针 Game 应等于 E.Game')
  ok(Object.isFrozen(probe.MATCHED), 'MATCHED 应被 Object.freeze')
  eq(typeof probe.createGame, 'function', '探针 createGame 类型')
  eq(typeof probe.getLastGame, 'function', '探针 getLastGame 类型（dev 预览用）')
  eq(probe.getLastGame(), null, '尚未 createGame 时 getLastGame 应为 null')
  eq(typeof probe.clueText, 'function', '探针 clueText 类型')
  eq(typeof probe.parseSave, 'function', '探针 parseSave 类型')
  eq(typeof probe.buildSave, 'function', '探针 buildSave 类型')
  eq(probe.ENGINE_SHA256, EXPECTED_ENGINE_SHA256, '探针 ENGINE_SHA256 应与冻结指纹一致')
  ok(typeof probe.CLIENT_REV === 'string' && probe.CLIENT_REV.indexOf('complexweeper-client') === 0,
    `探针 CLIENT_REV 格式: ${probe.CLIENT_REV}`)
  /* 引擎 API 完整性（engine-api.md §2/§3） */
  const ENGINE_FUNCS = ['splitEvenly']
  for (const name of ENGINE_FUNCS) eq(typeof CS[name], 'function', `E.${name} 类型`)
  for (const name of ['Rng', 'Game']) eq(typeof CS[name], 'function', `E.${name} 类型`)
  for (const name of ['PRESETS', 'TYPES', 'ACHIEVABLE', 'MSG', 'MODE', 'ENGINE_INFO']) {
    ok(CS[name] !== undefined && CS[name] !== null, `E.${name} 缺失`)
  }
  eq(CS.PRESETS.length, 3, '三档难度数量')
  eq(CS.PRESETS[0].w, 9, '初级宽')
  eq(CS.PRESETS[2].w, 30, '高级宽')
  eq(CS.PRESETS[2].h, 16, '高级高')
  eq(CS.PRESETS[2].mines, 99, '高级雷数')
}

group('factory(require) → inject / apply / register / select')
if (!firstRun.capturedModule) {
  ok(false, '没有捕获到 module definition')
} else {
  class FakeComponent {
    constructor(props) {
      this.props = props
      this.state = null
    }
    setState() {}
  }
  const fakeReact = {
    createElement() {
      return null
    },
    Component: FakeComponent,
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [value, function () {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }
  const module = firstRun.capturedModule.factory(function requireShim(name) {
    if (name === 'react') return fakeReact
    throw new Error('unexpected module: ' + name)
  })
  ok(!!module && typeof module === 'object', 'factory 应返回 module 对象')
  eq(Array.isArray(module.inject), true, 'module.inject 应是数组')
  eq(module.inject && module.inject.length, 1, "inject 只能有 1 项")
  eq(module.inject && module.inject[0], 'slots', "inject 只能是 'slots'")
  eq(typeof module.apply, 'function', 'module.apply 应是函数')

  let injectedName = null
  let registered = null
  const ctx = {
    slots: {
      inject(name, callback) {
        injectedName = name
        callback()
      },
      register(entry, Component) {
        registered = { entry, Component }
        return function unregister() {}
      },
    },
  }
  module.apply(ctx)
  eq(injectedName, 'game.stage', 'ctx.slots.inject 的 slot 名')
  ok(!!registered, 'apply() 应调用 slots.register')
  if (registered) {
    eq(registered.entry.name, 'game.stage', 'entry.name')
    eq(registered.entry.id, 'complexweeper', 'entry.id')
    eq(typeof registered.entry.label, 'function', 'entry.label 类型')
    eq(registered.entry.label(), '复扫雷', 'entry.label()')
    eq(typeof registered.entry.select, 'function', 'entry.select 类型')
    eq(registered.entry.select({ gameId: 'complexweeper' }), probe.MATCHED, 'select 命中应返回 MATCHED')
    eq(registered.entry.select({ gameId: 'complexweeper' }), probe.MATCHED, 'select 两次返回同一引用')
    eq(registered.entry.select({ gameId: 'minesweeper' }), null, 'select 未命中应为 null')
    eq(registered.entry.select(null), null, 'select(null) 应为 null')
    eq(registered.entry.select({}), null, 'select({}) 应为 null')
  }
}

/* ===================================================================== */
group('引擎规则断言（通过 client.js 探针暴露的 E）')
if (!E) {
  ok(false, '没有 E，无法跑规则断言')
} else {
  const { Game, MSG } = E

  /* 24 种可达值 + 显示文案 */
  const EXPECTED_ACHIEVABLE = [0, 1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20, 25, 26, 29, 32, 34, 36, 37, 40, 49, 50, 64]
  eq(CS.ACHIEVABLE.slice().sort((a, b) => a - b).join(','), EXPECTED_ACHIEVABLE.join(','), 'ACHIEVABLE 24 种值')
  const EXPECTED_TEXT = {
    0: '0', 1: '1', 2: '√2', 4: '2', 5: '√5', 8: '2√2', 9: '3',
    10: '√10', 13: '√13', 16: '4', 17: '√17', 18: '3√2', 20: '2√5',
    25: '5', 26: '√26', 29: '√29', 32: '4√2', 34: '√34', 36: '6',
    37: '√37', 40: '2√10', 49: '7', 50: '5√2', 64: '8',
  }
  for (const value of EXPECTED_ACHIEVABLE) {
    eq(probe.clueText(value), EXPECTED_TEXT[value], `clueText(${value})`)
  }
  eq(probe.clueText(3), '3', '未列出的平方值退化为整数显示')
  ok(probe.clueColor(0) !== probe.clueColor(2), '整数与根式线索颜色应可区分')
  ok(probe.clueColor(2) === probe.clueColor(8), '同族根式（√2 / 2√2）颜色一致')

  /* 线索计算：手算对照 + 空白 vs 0 */
  {
    const g = new Game({ w: 5, h: 5, mines: 8 })
    g.newGame(1)
    g.mine[6] = 1
    g.mine[7] = 1
    g.mine[8] = 2
    g.computeClues()
    eq(g.clue[12], 1, '两正实一负实 => a=1 => clue 1')
    g.mine.fill(0)
    g.clue.fill(-1)
    g.mine[6] = 1
    g.mine[7] = 3
    g.computeClues()
    eq(g.clue[12], 2, '+1 +i => a=1,b=1 => clue 2')
    g.mine.fill(0)
    g.clue.fill(-1)
    g.mine[6] = 1
    g.mine[7] = 2
    g.computeClues()
    eq(g.clue[12], 0, '抵消对 => clue 0')
    ok(g.isBlank(12) === false, '有抵消对的 0 格不是空白格（不连片）')
    g.mine.fill(0)
    g.clue.fill(-1)
    g.computeClues()
    eq(g.clue[12], 0, '全空 => clue 0')
    ok(g.isBlank(12) === true, '全空格是空白格（会连片）')
    g.mine[0] = 4
    g.computeClues()
    eq(g.clue[0], -1, '雷格 clue = -1')
  }

  /* 首点安全 + 首点连片 */
  {
    const g = new Game({ w: 9, h: 9, mines: 10 })
    g.newGame(12345)
    g.startAt(40, 0)
    eq(g.mine[40], 0, '首点格必安全')
    ok(g.nbrs(40).every((j) => g.mine[j] === 0), '首点八邻域必安全')
    eq(g.open[40], 1, '首点格必翻开')
    ok(g.openedCount() >= 9, '首点连片至少 9 格')
    eq(g.started, true, '首点后 started')
    eq(g.typeSum(), g.mines, '四类雷总数 = 实际雷数')
  }

  /* 展开判据三例（同 game.zig / _smoke.mjs） */
  {
    const g = new Game({ w: 5, h: 5, mines: 8 })
    g.newGame(2)
    const clear = () => {
      g.mine.fill(0)
      g.flag.fill(0)
      g.open.fill(0)
      g.clue.fill(-1)
      g.typeTotal.fill(0)
      g.flagsOf.fill(0)
    }
    clear()
    g.mine[6] = 1
    g.mine[7] = 3
    g.computeClues()
    g.countTypes()
    g.flag[6] = 1
    g.flag[7] = 3
    g.recountFlags()
    eq(g.matchComboTruth(12), true, '实虚比例一致 => 通过')
    g.flag[6] = 3
    g.flag[7] = 1
    g.recountFlags()
    eq(g.matchComboTruth(12), true, '实虚比例倒置 => 通过（符号/交换不要求）')
    g.flag[6] = 1
    g.flag[7] = 2
    g.recountFlags()
    eq(g.matchComboTruth(12), false, '总旗数对但比例错 => 拒绝')
    g.flag[7] = 0
    g.recountFlags()
    eq(g.matchComboTruth(12), false, '总旗数不对 => 拒绝')
    clear()
    g.mine[6] = 1
    g.mine[7] = 1
    g.computeClues()
    g.countTypes()
    g.flag[6] = 3
    g.flag[7] = 3
    g.recountFlags()
    eq(g.matchComboTruth(12), true, '纯实真值 / 纯虚旗（总数相同）=> 通过')
  }

  /* 胜负 */
  {
    const g = new Game({ w: 9, h: 9, mines: 10 })
    g.newGame(701)
    g.startAt(40, 0)
    for (let i = 0; i < g.n; i += 1) {
      if (g.mine[i] === 0 && g.open[i] === 0) g.reveal(i, 0)
    }
    eq(g.win, true, '翻开所有非雷格 => 胜利')
    eq(g.over, true, '胜利时 over')
    eq(g.msg, MSG.WIN, '胜利 msg = WIN')
    eq(g.openedCount(), g.safeCount(), '胜利时所有安全格已翻开')

    const lost = new Game({ w: 9, h: 9, mines: 10 })
    lost.newGame(701)
    lost.startAt(40, 0)
    let mineCell = -1
    for (let i = 0; i < lost.n; i += 1) {
      if (lost.mine[i] !== 0 && lost.open[i] === 0) {
        mineCell = i
        break
      }
    }
    ok(mineCell >= 0, '找得到未翻开的雷格')
    if (mineCell >= 0) {
      lost.reveal(mineCell, 0)
      eq(lost.win, false, '踩雷 => 未胜利')
      eq(lost.over, true, '踩雷 => over')
      eq(lost.boom, mineCell, 'boom 记录踩雷格')
      eq(lost.msg, MSG.LOSE, '踩雷 msg = LOSE')
    }
  }

  /* 存档往返 + 坏档 */
  {
    const g = new Game({ w: 9, h: 9, mines: 10 })
    g.newGame(4242)
    g.startAt(40, 0)
    g.reveal(0, 0)
    g.cycleFlag(1)
    const snap = g.snapshot()
    const rebuilt = Game.fromSnapshot(snap)
    ok(rebuilt !== null, '合法快照 fromSnapshot 应成功')
    if (rebuilt) {
      eq(JSON.stringify(rebuilt.snapshot()), JSON.stringify(g.snapshot()), '快照往返应逐字段一致')
    }
    eq(Game.fromSnapshot(null), null, 'fromSnapshot(null) => null')
    eq(Game.fromSnapshot({ w: 9 }), null, '残缺快照 => null')
    const broken = JSON.parse(JSON.stringify(snap))
    broken.open[0] = 3
    eq(Game.fromSnapshot(broken), null, '非法 open 值 => null')
    const broken2 = JSON.parse(JSON.stringify(snap))
    broken2.mine.fill(0)
    eq(Game.fromSnapshot(broken2), null, '已开局但 mine 与 mines 不符 => null')
  }

  /* 存档包装（client 侧） */
  {
    const g = new Game({ w: 9, h: 9, mines: 10 })
    g.newGame(7)
    g.startAt(40, 0)
    const save = probe.buildSave(g, 1, 12345)
    eq(save.schemaVersion, 1, 'buildSave schemaVersion')
    eq(save.difficulty, 1, 'buildSave difficulty')
    eq(save.state.elapsedMs, 12345, 'buildSave elapsedMs 覆盖')
    const parsed = probe.parseSave(JSON.stringify(save))
    ok(parsed && parsed.game && parsed.difficulty === 1, 'parseSave 合法存档应成功')
    eq(probe.parseSave('{'), null, 'parseSave 非法 JSON => null')
    eq(probe.parseSave(JSON.stringify({ schemaVersion: 2, difficulty: 1, state: save.state })), null,
      'parseSave 版本不符 => null')
    eq(probe.parseSave(JSON.stringify({ schemaVersion: 1, difficulty: 3, state: save.state })), null,
      'parseSave 难度与棋盘尺寸不符 => null')
  }
}

/* ===================================================================== */
finishGroup()
console.log(`\nclient.js：${CLIENT_PATH} (${clientBuf.length} bytes)`)
console.log(`engine.js：${ENGINE_PATH} (${engineBuf.length} bytes, sha256=${engineSha})`)
console.log(`\n总结果：${pass} 通过，${fail} 失败`)
if (fail) {
  console.log('结论：失败 —— client.js 内联引擎与 engine.js 不一致或行为异常')
  process.exitCode = 1
} else {
  console.log('结论：全部通过 —— 内联块与 engine.js 逐字节相等，探针 / 注册 / 规则断言正常')
  process.exitCode = 0
}
