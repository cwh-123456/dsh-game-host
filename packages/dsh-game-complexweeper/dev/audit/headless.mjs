/* 客户端健壮性 headless 审计（独立假 DOM，不用团队的 dev/fake-react.js）
 * 运行：node packages/dsh-game-complexweeper/dev/audit/headless.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 *
 * 覆盖（任务清单第 6 项）：
 *   - 模块注册形状 / select 严格性 / MATCHED 冻结 / 版本指纹自洽
 *   - createGame：挂载、resize、dpr、<320×240、渲染期不抛错
 *   - 首次点击开局、插旗、chord 判据失败反馈、胜负、重开、切难度
 *   - 一次性提示自动清除（1.8s）+ 新局/卸载清理 timer + 胜负不清
 *   - 存档：每次操作落盘、恢复、坏档不白屏、卸载落盘、destroy 可重复
 *   - document.hidden 暂停/恢复计时（不跳时间）
 *   - 无全局键盘监听、无 document.body / title 副作用
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/* =============================== 假 DOM =============================== */
const listeners = { window: new Map(), document: new Map(), canvas: new Map() }
function addListener(store, type, fn) {
  if (!store.has(type)) store.set(type, new Set())
  store.get(type).add(fn)
}
function removeListener(store, type, fn) {
  const set = store.get(type)
  if (set) set.delete(fn)
}
function countAllListeners() {
  let n = 0
  for (const store of Object.values(listeners)) for (const set of store.values()) n += set.size
  return n
}
const allListenerTypes = new Set()
function noteType(type) {
  allListenerTypes.add(type)
}

const state = {
  now: 1000,
  hostRect: { width: 720, height: 600 },
  canvasCalls: [],
  ctxBroken: false,
}

function makeCtx() {
  const ctx = {
    canvas: null,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    calls: [],
  }
  const rec = (name, args) => {
    ctx.calls.push([name, args])
    state.canvasCalls.push([name, args])
  }
  const methods = ['setTransform', 'clearRect', 'fillRect', 'fillText', 'save', 'restore',
    'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'arc']
  for (const m of methods) {
    ctx[m] = function (...args) {
      rec(m, args)
      if (state.ctxBroken && m === 'fillRect') throw new Error('fake ctx failure')
    }
  }
  return ctx
}

function makeCanvas() {
  const ctx = makeCtx()
  const canvas = {
    tagName: 'CANVAS',
    width: 0,
    height: 0,
    tabIndex: -1,
    style: {},
    attributes: {},
    removed: false,
    parent: null,
    ctx,
    getContext(type) {
      return type === '2d' ? ctx : null
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    addEventListener(type, fn) {
      noteType(type)
      addListener(listeners.canvas, type, fn)
    },
    removeEventListener(type, fn) {
      removeListener(listeners.canvas, type, fn)
    },
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: state.hostRect.width,
        height: state.hostRect.height,
        right: state.hostRect.width,
        bottom: state.hostRect.height,
      }
    },
    focus() { this.focused = true },
    remove() {
      this.removed = true
      if (this.parent) {
        const i = this.parent.children.indexOf(this)
        if (i >= 0) this.parent.children.splice(i, 1)
        this.parent = null
      }
    },
  }
  Object.defineProperty(canvas.style, 'cssText', {
    set(v) { canvas._cssText = v },
    get() { return canvas._cssText || '' },
  })
  ctx.canvas = canvas
  return canvas
}

function makeHost() {
  return {
    tagName: 'DIV',
    children: [],
    style: {},
    appendChild(el) {
      this.children.push(el)
      el.parent = this
      return el
    },
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: state.hostRect.width,
        height: state.hostRect.height,
        right: state.hostRect.width,
        bottom: state.hostRect.height,
      }
    },
    addEventListener(type, fn) {
      noteType(type)
      addListener(listeners.canvas, type, fn)
    },
    removeEventListener(type, fn) {
      removeListener(listeners.canvas, type, fn)
    },
  }
}

const storage = {
  map: new Map(),
  throwGet: false,
  throwSet: false,
  getItem(k) {
    if (storage.throwGet) throw new Error('storage get blocked')
    return storage.map.has(k) ? storage.map.get(k) : null
  },
  setItem(k, v) {
    if (storage.throwSet) throw new Error('storage set blocked')
    storage.map.set(k, String(v))
  },
  removeItem(k) {
    storage.map.delete(k)
  },
  clear() {
    storage.map.clear()
  },
}

const rafQueue = []
let rafId = 0
const timers = []
let timerId = 0
const resizeObservers = []

const fakeDoc = {
  hidden: false,
  addEventListener(type, fn) {
    noteType(type)
    addListener(listeners.document, type, fn)
  },
  removeEventListener(type, fn) {
    removeListener(listeners.document, type, fn)
  },
  createElement(tag) {
    if (String(tag).toLowerCase() === 'canvas') return makeCanvas()
    return { tagName: String(tag).toUpperCase(), style: {}, children: [], appendChild() {} }
  },
  body: { children: [] },
}

const fakeWindow = {
  __DSH_GAME_COMPLEXSWEEPER_TEST__: true,
  devicePixelRatio: 1,
  performance: {
    now: () => state.now,
  },
  localStorage: storage,
  addEventListener(type, fn) {
    noteType(type)
    addListener(listeners.window, type, fn)
  },
  removeEventListener(type, fn) {
    removeListener(listeners.window, type, fn)
  },
  requestAnimationFrame(cb) {
    rafId += 1
    rafQueue.push({ id: rafId, cb })
    return rafId
  },
  cancelAnimationFrame(id) {
    const i = rafQueue.findIndex((j) => j.id === id)
    if (i >= 0) rafQueue.splice(i, 1)
  },
  setTimeout(cb, ms) {
    timerId += 1
    timers.push({ id: timerId, cb, due: state.now + (Number(ms) || 0) })
    return timerId
  },
  clearTimeout(id) {
    const i = timers.findIndex((t) => t.id === id)
    if (i >= 0) timers.splice(i, 1)
  },
  ResizeObserver: class ResizeObserver {
    constructor(cb) {
      this.cb = cb
      this.targets = []
      resizeObservers.push(this)
    }
    observe(el) {
      this.targets.push(el)
    }
    disconnect() {
      this.targets.length = 0
      this.disconnected = true
    }
  },
}

let capturedModule = null
fakeWindow.__ModuleLoader__ = {
  load(mod) {
    capturedModule = mod
  },
}

/* 环境安装（必须在 import client.js 之前） */
globalThis.window = fakeWindow
globalThis.document = fakeDoc

/* =============================== 加载被测模块 =============================== */
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', '..')
const engineBytes = readFileSync(join(pkgDir, 'engine.js'))
const clientBytes = readFileSync(join(pkgDir, 'client.js'))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase()

const t0 = Date.now()
await import('../../client.js')
const PROBE = fakeWindow.__DSH_GAME_COMPLEXSWEEPER__

/* =============================== 断言工具 =============================== */
let checks = 0
const fails = []
function ok(cond, name, detail) {
  checks++
  if (!cond) fails.push(detail === undefined ? name : `${name} :: ${detail}`)
}
function eq(a, b, name) {
  checks++
  if (a !== b) fails.push(`${name} :: got=${JSON.stringify(a)} want=${JSON.stringify(b)}`)
}

function resetEnv() {
  storage.clear()
  state.now = 1000
  state.hostRect = { width: 720, height: 600 }
  state.canvasCalls.length = 0
  state.ctxBroken = false
  rafQueue.length = 0
  timers.length = 0
  resizeObservers.length = 0
  fakeWindow.devicePixelRatio = 1
  fakeDoc.hidden = false
  for (const set of listeners.window.values()) set.clear()
  for (const set of listeners.document.values()) set.clear()
  for (const set of listeners.canvas.values()) set.clear()
}
function fireWindow(type, ev) {
  const set = listeners.window.get(type)
  if (set) for (const fn of [...set]) fn(ev || {})
}
function fireDocument(type, ev) {
  const set = listeners.document.get(type)
  if (set) for (const fn of [...set]) fn(ev || {})
}
function fireCanvas(type, ev) {
  const set = listeners.canvas.get(type)
  if (set) for (const fn of [...set]) fn(ev || {})
}
const flushFrames = (n) => {
  for (let i = 0; i < n && rafQueue.length; i += 1) {
    const job = rafQueue.shift()
    state.now += 16
    job.cb(state.now)
  }
}
/** 推进假时钟并触发到期的 setTimeout 回调。 */
function runTimers(ms) {
  const target = state.now + ms
  let fired = 0
  for (;;) {
    const due = timers.filter((t) => t.due <= target)
    if (due.length === 0) break
    due.sort((a, b) => a.due - b.due)
    const t = due[0]
    const i = timers.indexOf(t)
    if (i >= 0) timers.splice(i, 1)
    state.now = t.due
    t.cb()
    fired += 1
    if (fired > 20) break
  }
  state.now = target
  return fired
}
const storageKeys = () => [...storage.map.keys()]
const readSave = () => {
  const raw = storage.map.get(PROBE.STORE_KEY)
  return raw ? JSON.parse(raw) : null
}
const bigHost = () => {
  state.hostRect = { width: 900, height: 640 }
  return makeHost()
}
const mkPointerEvent = (extra, bag) => Object.assign({
  button: 0,
  clientX: 0,
  clientY: 0,
  preventDefault() { bag.prevented += 1 },
}, extra)

/* 找一个"已翻开数字格 + 邻域旗数不对"的 chord 起点（判据必然失败） */
function findJudgeFailCell(g) {
  for (let i = 0; i < g.n; i += 1) {
    if (!g.open[i] || g.mine[i] !== 0) continue
    const uns = g.nbrs(i).filter((j) => g.open[j] === 0 && g.flag[j] === 0)
    if (uns.length > 0 && !g.matchComboTruth(i)) return i
  }
  return -1
}

/* ============================ 1. 模块 & 注册形状 ============================ */
{
  resetEnv()
  ok(PROBE && typeof PROBE === 'object', '测试探针已安装（__DSH_GAME_COMPLEXSWEEPER_TEST__ 门控）')
  ok(capturedModule !== null, '__ModuleLoader__.load 被调用')
  eq(capturedModule.id, '@local/dsh-game-complexweeper', 'loader id = package.json name')
  ok(typeof capturedModule.factory === 'function', 'factory 是函数')
  ok(fakeWindow.CS === undefined, '内联引擎运行后还原了 window.CS（不污染全局）')
  ok(fakeWindow.__DSH_GAME_COMPLEXSWEEPER__ === PROBE, '探针只挂在约定的 window.__DSH_GAME_COMPLEXSWEEPER__ 上')

  /* 版本指纹自洽：ENGINE_SHA256 必须等于包里 engine.js 的真实摘要 */
  ok(typeof PROBE.CLIENT_REV === 'string' && PROBE.CLIENT_REV.includes('complexweeper-client'), '探针暴露 CLIENT_REV', String(PROBE.CLIENT_REV))
  eq(PROBE.ENGINE_SHA256, sha256(engineBytes), 'ENGINE_SHA256 = engine.js 实际 sha256')
  ok(engineBytes.length === 25002, 'engine.js 大小 = 25002B（冻结指纹）', String(engineBytes.length))
  ok(sha256(engineBytes) === 'A3CAE327CD7B4FDC63C48E8BD5C8672656B2B0DD7EB96B91EB0DC29B43972069', 'engine.js sha256 = 冻结指纹 A3CAE327…')
  console.log(`  client.js = ${clientBytes.length}B / ${sha256(clientBytes)}`)
  console.log(`  engine.js = ${engineBytes.length}B / ${sha256(engineBytes)}`)

  const reactStub = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useRef: (v) => ({ current: v === undefined ? null : v }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    Component: class Component {
      constructor(props) { this.props = props }
      setState() {}
    },
  }
  const requireStub = (name) => {
    if (name !== 'react') throw new Error('unexpected require: ' + name)
    return reactStub
  }
  const mod = capturedModule.factory(requireStub)
  ok(mod && typeof mod === 'object', 'factory 返回模块对象')
  ok(Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'slots', "inject = ['slots']", JSON.stringify(mod.inject))
  ok(typeof mod.apply === 'function', 'apply 是函数')

  const registered = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, cb) { injected.push(name); cb() },
      register(cfg, comp) { registered.push({ cfg, comp }); return () => {} },
    },
  }
  mod.apply(ctx)
  eq(JSON.stringify(injected), JSON.stringify(['game.stage']), '只 inject game.stage')
  eq(registered.length, 1, '只注册一个 slot entry')
  const { cfg, comp } = registered[0]
  eq(cfg.name, 'game.stage', 'register.name = game.stage')
  eq(cfg.id, 'complexweeper', 'register.id = complexweeper')
  eq(cfg.label(), '复扫雷', 'register.label() = 复扫雷')
  ok(typeof cfg.select === 'function', 'register.select 存在（chain slot 必需）')
  ok(Object.isFrozen(cfg.select({ gameId: 'complexweeper' })), 'select 命中时返回冻结的 MATCHED')
  ok(cfg.select({ gameId: 'complexweeper' }) === cfg.select({ gameId: 'complexweeper' }), 'select 返回稳定同一引用（不每次新建对象）')
  eq(cfg.select({ gameId: '2048' }), null, 'select 严格比较：别的 gameId → null')
  eq(cfg.select({ gameId: 'minesweeper' }), null, 'select 严格比较：minesweeper → null')
  eq(cfg.select({ gameId: 'complexweeper ' }), null, 'select 不做前缀/宽松匹配')
  eq(cfg.select({}), null, 'select({}) → null')
  eq(cfg.select(null), null, 'select(null) → null')
  eq(cfg.select(undefined), null, 'select(undefined) → null')
  ok(typeof comp === 'function' || (comp && typeof comp === 'object'), '组件已随 register 传入')

  let threw = false
  try {
    mod.apply({ slots: { inject() { throw new Error('host injected slot failure') } } })
  } catch (e) {
    threw = true
  }
  ok(!threw, '宿主 slots.inject 抛错时 apply 不向外抛（被 try/catch 吃掉）')
}

/* ============================ 2. createGame 基础 ============================ */
{
  resetEnv()
  const host = bigHost()
  const game = PROBE.createGame(host, { random: () => 0.5 })
  ok(game && typeof game === 'object', 'createGame 返回实例')
  for (const m of ['reveal', 'flag', 'chord', 'expand', 'newGame', 'restart', 'setDifficulty', 'destroy', 'getState', 'getLayout', 'getCanvas', 'getGame', 'cellPoint', 'persistNow']) {
    ok(typeof game[m] === 'function', `实例方法 ${m} 存在`)
  }
  const canvas = game.getCanvas()
  ok(host.children.includes(canvas), 'canvas 已挂到宿主元素')
  ok(/width:100%/.test(canvas.style.cssText) && /height:100%/.test(canvas.style.cssText), 'canvas 自身撑满 100%')
  eq(canvas.width, 900, 'canvas 像素宽 = cssW * dpr（dpr=1）')
  eq(canvas.height, 640, 'canvas 像素高 = cssH * dpr（dpr=1）')
  ok(game.getLayout() !== null, '初始布局已算出')
  const st0 = game.getState()
  eq(st0.started, false, '初始未开局')
  eq(st0.difficulty, 1, '初始难度 1')
  eq(st0.mines, 10, '初始显示预设雷数 10')
  eq(st0.safe, 71, '初始安全格 71')
  eq(st0.flags, 0, '初始旗数 0')
  ok(st0.typeTotal[1] === 0, '未开局时类型总数还没公开（显示 ?）')
  const save0 = readSave()
  ok(save0 !== null, 'createGame 后立即写存档')
  eq(save0.schemaVersion, 1, '存档 schemaVersion = 1')
  eq(save0.difficulty, 1, '存档 difficulty = 1')
  eq(save0.state.started, false, '存档 state.started = false')
  ok(storageKeys().length === 1 && storageKeys()[0] === PROBE.STORE_KEY, '只使用约定的存档 key', storageKeys().join(','))
  ok(state.canvasCalls.length > 0, '初始化时确实画过帧')

  /* ---- dpr / resize ---- */
  fakeWindow.devicePixelRatio = 2
  state.hostRect = { width: 640, height: 480 }
  fireWindow('resize')
  eq(canvas.width, 1280, 'dpr=2 时 canvas 宽 = cssW*2')
  eq(canvas.height, 960, 'dpr=2 时 canvas 高 = cssH*2')
  const hasSetTransform = state.canvasCalls.some(([name, args]) => name === 'setTransform' && args[0] === 2 && args[1] === 0 && args[2] === 0 && args[3] === 2)
  ok(hasSetTransform, '按 dpr 设置 canvas 变换（setTransform(dpr,0,0,dpr,0,0)）')

  /* ---- ResizeObserver 驱动缩放 ---- */
  fakeWindow.devicePixelRatio = 1
  state.hostRect = { width: 1000, height: 700 }
  for (const ro of resizeObservers) if (ro.cb && !ro.disconnected) ro.cb([])
  eq(canvas.width, 1000, 'ResizeObserver 回调触发 resize')

  /* ---- <320×240 ---- */
  state.canvasCalls.length = 0
  state.hostRect = { width: 300, height: 200 }
  fireWindow('resize')
  eq(game.getLayout(), null, '尺寸 < 320×240 时不做棋盘布局')
  const texts = state.canvasCalls.filter(([name]) => name === 'fillText').map(([, args]) => args[0])
  ok(texts.includes('窗口太小'), '显示「窗口太小」提示', texts.join('|'))
  const bag = { prevented: 0 }
  let smallThrew = false
  try {
    fireCanvas('pointerdown', mkPointerEvent({ button: 0, clientX: 150, clientY: 100 }, bag))
    fireCanvas('pointerdown', mkPointerEvent({ button: 2, clientX: 150, clientY: 100 }, bag))
    fireCanvas('pointermove', mkPointerEvent({ clientX: 150, clientY: 100 }, bag))
  } catch (e) {
    smallThrew = true
  }
  ok(!smallThrew, '尺寸过小时指针事件不抛错')
  eq(game.getState().started, false, '尺寸过小时点不到棋盘 → 不会误开局')
  eq(game.getGame().flagsTotal(), 0, '尺寸过小时右键也不会误插旗')
  game.destroy()
}

/* ============================ 3. 开局 / 插旗 / chord / 胜负 ============================ */
{
  resetEnv()
  const host = bigHost()
  const game = PROBE.createGame(host, { random: () => 0.25 })
  const g = game.getGame()

  const center = Math.floor(g.h / 2) * g.w + Math.floor(g.w / 2)
  eq(game.reveal(center), true, '左键首次点击返回 true（已开局）')
  const st1 = game.getState()
  eq(st1.started, true, '首点后 started=true')
  ok(g.open[center] === 1, '首点格已翻开')
  ok(g.isBlank(center), '首点格是空白格（安全）')
  ok(st1.opened >= 9, '首点必连片（>=9 格）', String(st1.opened))
  ok(st1.typeTotal[1] + st1.typeTotal[2] + st1.typeTotal[3] + st1.typeTotal[4] === g.mines, '开局公开四类雷总数且合计=雷数')
  ok(st1.status.length > 0, '状态文案有内容', st1.status)
  const save1 = readSave()
  eq(save1.state.started, true, '开局后立即落盘')
  ok(save1.state.mine.length === g.n, '存档含完整棋盘')

  // 已翻开格不能插旗；未翻开格循环 0→1→2→3→4→0
  eq(game.flag(center), false, '已翻开格不能插旗')
  let closed = -1
  for (let i = 0; i < g.n; i += 1) if (!g.open[i]) { closed = i; break }
  ok(closed >= 0, '找得到未翻开格')
  const seq = []
  for (let k = 0; k < 6; k += 1) {
    eq(game.flag(closed), true, `第 ${k + 1} 次右键循环生效`)
    seq.push(g.flag[closed])
  }
  eq(seq.join(','), '1,2,3,4,0,1', '右键循环序列 1,2,3,4,0,1', seq.join(','))
  eq(game.getState().flags, 1, '循环结束时 flag=1 → 统计 1')
  eq(readSave().state.flag[closed], 1, '插旗立即落盘 flag=1')
  game.flag(closed) // 2
  eq(readSave().state.flag[closed], 2, '再插一次（循环到 −1）落盘 flag=2')
  eq(game.getState().flags, 1, '同一格仍只有一面旗（统计不重复）')
  eq(game.reveal(closed), false, '插旗格左键无效')
  eq(g.open[closed], 0, '插旗格没有被翻开')

  for (let i = 0; i < g.n; i += 1) {
    if (g.open[i] && g.mine[i] === 0) ok(g.clue[i] >= 0, '已翻开非雷格 clue >= 0')
  }

  /* ---- chord：判据失败必须给明显反馈且棋盘不变 ---- */
  const chordCell = findJudgeFailCell(g)
  ok(chordCell >= 0, '找得到判据不通过的 chord 起点')
  const openBeforeFail = Array.from(g.open.subarray(0, g.n)).join(',')
  const flagBeforeFail = Array.from(g.flag.subarray(0, g.n)).join(',')
  const movesBeforeFail = g.moves
  state.canvasCalls.length = 0
  game.chord(chordCell)
  const stFail = game.getState()
  eq(stFail.msg, PROBE.MSG.JUDGE_FAIL, 'chord 判据失败 → msg=judge_fail')
  ok(stFail.status.includes('判定不通过'), '判据失败必须在状态栏有明显文案', stFail.status)
  ok(state.canvasCalls.length > 0, '判据失败触发了重绘（高亮闪一下）')
  eq(Array.from(g.open.subarray(0, g.n)).join(','), openBeforeFail, '判据失败不改变 open[]')
  eq(Array.from(g.flag.subarray(0, g.n)).join(','), flagBeforeFail, '判据失败不改变 flag[]')
  eq(g.moves, movesBeforeFail, '判据失败不增加 moves')

  /* ---- 一次性提示自动清除（1.8s） ---- */
  ok(timers.length === 1, '判据失败后挂了 1 个自动清除 timer', String(timers.length))
  state.canvasCalls.length = 0
  const fired = runTimers(1800)
  ok(fired >= 1, '1.8s 后自动清除回调被触发', String(fired))
  eq(game.getState().msg, PROBE.MSG.NONE, '1.8s 后 msg 自动清为 none（NOTE 3 已修复）')
  eq(readSave().state.msg, PROBE.MSG.NONE, '自动清除后落盘的 msg 也是 none')
  ok(state.canvasCalls.length > 0, '自动清除后重绘（角标消失）')
  eq(game.getState().started, true, '自动清除不影响进行中的局面')
  eq(timers.length, 0, '自动清除 timer 已出队')

  // 清除前又有新动作：timer 重新计时，不会被丢掉
  {
    game.chord(chordCell)
    eq(game.getState().msg, PROBE.MSG.JUDGE_FAIL, '再次判据失败')
    const safeClosed = (() => {
      for (let i = 0; i < g.n; i += 1) if (g.open[i] === 0 && g.flag[i] === 0 && g.mine[i] === 0) return i
      return -1
    })()
    ok(safeClosed >= 0, '找得到安全未翻开格')
    game.reveal(safeClosed)
    runTimers(1800)
    eq(game.getState().msg, PROBE.MSG.NONE, '清除前有新动作 → 之后仍会按时清除')
  }

  /* ---- chord：判据通过 → 翻开邻格（且不踩雷） ---- */
  let passCell = -1
  for (let i = 0; i < g.n; i += 1) {
    if (!g.open[i] || g.mine[i] !== 0) continue
    const uns = g.nbrs(i).filter((j) => g.open[j] === 0 && g.flag[j] === 0)
    const hasMine = uns.some((j) => g.mine[j] !== 0)
    const hasSafe = uns.some((j) => g.mine[j] === 0)
    if (hasMine && hasSafe) { passCell = i; break }
  }
  ok(passCell >= 0, '找得到既有雷又有安全邻格的 chord 起点（用于验证判据通过路径）')
  if (passCell >= 0) {
    const nb = g.nbrs(passCell)
    for (const j of nb) if (g.mine[j] !== 0) g.setFlag(j, g.mine[j])
    g.recountFlags()
    ok(g.matchComboTruth(passCell) === true, '邻域雷都插正确类型旗后判据通过')
    const hasTarget = g.nbrs(passCell).some((j) => g.open[j] === 0 && g.flag[j] === 0)
    ok(hasTarget, '展开前仍有未插旗未翻开的邻格（UI 门禁允许 chord）')
    const beforeOpened = g.openedCount()
    game.chord(passCell)
    const stOk = game.getState()
    ok(stOk.msg === PROBE.MSG.EXPAND_OK || stOk.win === true, '判据通过 → expand_ok（或直接判胜）', String(stOk.msg))
    ok(g.openedCount() > beforeOpened || stOk.win === true || g.msg === PROBE.MSG.EXPAND_OK, '判据通过后确实执行了展开')
    ok(g.boom === -1, '邻域雷都插了正确旗 → 不踩雷')
    eq(g.msgArg, 0, 'msgArg 恒为 0（忠实 Zig 的 setMsg 清零）')
    if (stOk.msg === PROBE.MSG.EXPAND_OK) {
      runTimers(1800)
      eq(game.getState().msg, PROBE.MSG.NONE, 'expand_ok 也在 1.8s 后自动清除')
    }
  }

  /* ---- 新局/卸载时清理 timer（不会在旧局上补一次 setMsg） ---- */
  {
    game.restart()
    const gg = game.getGame()
    game.reveal(Math.floor(gg.h / 2) * gg.w + Math.floor(gg.w / 2))
    const failCell = findJudgeFailCell(gg)
    if (failCell >= 0) {
      game.chord(failCell)
      eq(timers.length, 1, '判据失败 timer 挂起')
      game.restart()
      eq(timers.length, 0, 'newGame 会清掉挂起的自动清除 timer')
      runTimers(3000)
      eq(game.getState().msg, PROBE.MSG.NONE, '新局 msg 保持 none（旧 timer 不会补写）')
    }
  }

  /* ---- 踩雷：判负 + 复盘数据；胜负提示不自动清除 ---- */
  game.restart()
  const g2 = game.getGame()
  game.reveal(Math.floor(g2.h / 2) * g2.w + Math.floor(g2.w / 2))
  let mineCell = -1
  for (let i = 0; i < g2.n; i += 1) if (g2.mine[i] !== 0 && !g2.open[i]) { mineCell = i; break }
  ok(mineCell >= 0, '找得到未翻开的雷')
  eq(game.reveal(mineCell), true, '点雷返回 true（确实发生了操作）')
  const stLose = game.getState()
  eq(stLose.over, true, '点雷后 over=true')
  eq(stLose.win, false, '点雷后 win=false')
  eq(stLose.boom, mineCell, 'boom 记录踩中的雷格')
  ok(stLose.status.includes('踩到雷'), '失败状态栏有文案', stLose.status)
  runTimers(3000)
  eq(game.getState().msg, PROBE.MSG.LOSE, '结束状态 msg=lose 不会被自动清除（保留结局文案）')
  eq(game.reveal(mineCell), false, '结束后的点击无效')
  eq(game.flag(closed), false, '结束后不能插旗')
  eq(game.chord(chordCell), false, '结束后不能 chord')
  eq(readSave().state.over, true, '结束后落盘 over')

  /* ---- 重开 / 切难度 ---- */
  eq(game.restart(), true, '重开返回 true')
  const stRestart = game.getState()
  eq(stRestart.started, false, '重开后未开局')
  eq(stRestart.over, false, '重开后 over=false')
  eq(stRestart.flags, 0, '重开后旗数 0')
  eq(game.getGame().n, 81, '重开保持同一难度（9×9）')

  eq(game.setDifficulty(3), true, '切到高级')
  const stHard = game.getState()
  eq(stHard.difficulty, 3, '难度 = 3')
  eq(game.getGame().w, 30, '高级宽 30')
  eq(game.getGame().h, 16, '高级高 16')
  eq(stHard.mines, 99, '高级预设雷数 99')
  ok(stHard.safe === 30 * 16 - 99, '高级安全格数正确')
  eq(readSave().difficulty, 3, '切难度落盘')
  eq(game.setDifficulty(9), false, '非法难度被拒绝')
  const layout = game.getLayout()
  eq(layout.cols, 30, '布局 cols 跟随棋盘')
  eq(layout.rows, 16, '布局 rows 跟随棋盘')
  game.destroy()
  eq(timers.length, 0, 'destroy 清理一切挂起的 timer')
}

/* ============================ 4. 指针事件（右键/左键/中键/双击） ============================ */
{
  resetEnv()
  const host = bigHost()
  const game = PROBE.createGame(host, { random: () => 0.5 })
  const g = game.getGame()
  const layout = game.getLayout()
  const pt = (row, col) => ({ x: layout.x + col * layout.cell + layout.cell / 2, y: layout.y + row * layout.cell + layout.cell / 2 })
  const bag = { prevented: 0 }
  const mk = (extra) => mkPointerEvent(extra, bag)

  const centerRow = Math.floor(g.h / 2)
  const centerCol = Math.floor(g.w / 2)
  const centerIdx = centerRow * g.w + centerCol
  const p = pt(centerRow, centerCol)
  fireCanvas('pointerdown', mk({ button: 2, clientX: p.x, clientY: p.y }))
  eq(g.flag[centerIdx], 1, '右键在格子上插了一面 +1 旗')
  ok(bag.prevented > 0, '右键阻止了默认行为')
  fireCanvas('pointerdown', mk({ button: 2, clientX: p.x, clientY: p.y }))
  eq(g.flag[centerIdx], 2, '右键循环到 −1')
  fireCanvas('pointerdown', mk({ button: 0, clientX: p.x, clientY: p.y }))
  eq(g.flag[centerIdx], 2, '左键点插旗格不改变旗')
  eq(g.started, false, '左键点插旗格不会开局')
  fireCanvas('pointerdown', mk({ button: 2, clientX: p.x, clientY: p.y }))
  fireCanvas('pointerdown', mk({ button: 2, clientX: p.x, clientY: p.y }))
  fireCanvas('pointerdown', mk({ button: 2, clientX: p.x, clientY: p.y }))
  eq(g.flag[centerIdx], 0, '右键循环回空')
  state.canvasCalls.length = 0
  fireCanvas('pointerdown', mk({ button: 0, clientX: p.x, clientY: p.y }))
  eq(g.started, true, '左键点空白格开局')
  ok(state.canvasCalls.length > 0, '开局后重绘')
  let threw = false
  try {
    const p00 = pt(0, 0)
    fireCanvas('pointerdown', mk({ button: 1, clientX: p00.x, clientY: p00.y }))
    fireCanvas('dblclick', mk({ clientX: p00.x, clientY: p00.y }))
  } catch (e) {
    threw = true
  }
  ok(!threw, '中键/双击事件不抛错')
  bag.prevented = 0
  fireCanvas('contextmenu', mk({}))
  eq(bag.prevented, 1, 'contextmenu 事件被 preventDefault')
  fireCanvas('pointermove', mk({ clientX: 5, clientY: 5 }))
  fireCanvas('pointerleave', mk({}))
  ok(true, 'pointermove/pointerleave 不抛错')
  const beforeOpen = Array.from(g.open.subarray(0, g.n)).join(',')
  fireCanvas('pointerdown', mk({ button: 0, clientX: -50, clientY: -50 }))
  eq(Array.from(g.open.subarray(0, g.n)).join(','), beforeOpen, '棋盘外的点击无效')
  game.destroy()
}

/* ============================ 5. 存档：恢复 / 坏档 / 卸载落盘 ============================ */
{
  resetEnv()
  const host = bigHost()
  const game = PROBE.createGame(host, { random: () => 0.5 })
  const g = game.getGame()
  const center = Math.floor(g.h / 2) * g.w + Math.floor(g.w / 2)
  game.reveal(center)
  state.now += 5000
  const before = readSave()
  ok(before.state.started, '存档已有进行中局面')
  const mineLayout = Array.from(g.mine.subarray(0, g.n))
  ok(game.getState().elapsedMs >= 0, '进行中计时有效')
  game.destroy()
  const afterDestroy = readSave()
  ok(afterDestroy !== null && afterDestroy.state.started === true, 'destroy 时落盘')
  ok(Array.isArray(afterDestroy.state.mine) && afterDestroy.state.mine.length === g.n, 'destroy 落盘的棋盘完整')

  const host2 = bigHost()
  const game2 = PROBE.createGame(host2, { random: () => 0.9 })
  const st = game2.getState()
  eq(st.started, true, '重新挂载后恢复进行中局面')
  eq(st.difficulty, 1, '恢复难度')
  eq(Array.from(game2.getGame().mine.subarray(0, g.n)).join(','), mineLayout.join(','), '恢复后雷布局逐格一致')
  eq(st.opened, afterDestroy.state.open.filter((v) => v !== 0).length, '恢复后翻开格数一致')
  ok(st.elapsedMs >= before.state.elapsedMs, '恢复后计时不倒退')

  /* ---- 从"带一次性提示的存档"恢复：init 会续上自动清除 ---- */
  game2.getGame().setMsg(PROBE.MSG.EXPAND_OK)
  game2.persistNow()
  eq(readSave().state.msg, PROBE.MSG.EXPAND_OK, '存档里带 expand_ok 提示')
  game2.destroy()
  const game3 = PROBE.createGame(bigHost(), { random: () => 0.3 })
  eq(game3.getState().msg, PROBE.MSG.EXPAND_OK, '恢复后先显示提示')
  ok(timers.length === 1, '恢复带一次性提示的存档时会挂自动清除 timer', String(timers.length))
  runTimers(1800)
  eq(game3.getState().msg, PROBE.MSG.NONE, '恢复后提示也会 1.8s 自动清除')
  game3.destroy()

  /* ---- 坏档：不能白屏、不能抛错，且开新局 ---- */
  const badSaves = [
    ['非 JSON', '{not json'],
    ['空串', ''],
    ['null 字面量', 'null'],
    ['数组', '[]'],
    ['schemaVersion=2', JSON.stringify({ schemaVersion: 2, difficulty: 1, state: {} })],
    ['缺 state', JSON.stringify({ schemaVersion: 1, difficulty: 1 })],
    ['难度非法', JSON.stringify({ schemaVersion: 1, difficulty: 9, state: {} })],
    ['难度与尺寸不符', JSON.stringify({ schemaVersion: 1, difficulty: 3, state: before.state })],
    ['state 被截断', JSON.stringify({ schemaVersion: 1, difficulty: 1, state: Object.assign({}, before.state, { mine: before.state.mine.slice(0, 10) }) })],
    ['state 是字符串', JSON.stringify({ schemaVersion: 1, difficulty: 1, state: 'x' })],
    ['state 是 null', JSON.stringify({ schemaVersion: 1, difficulty: 1, state: null })],
  ]
  for (const [name, raw] of badSaves) {
    resetEnv()
    storage.map.set(PROBE.STORE_KEY, raw)
    let threw = false
    let inst = null
    try {
      inst = PROBE.createGame(bigHost(), { random: () => 0.5 })
    } catch (e) {
      threw = true
    }
    ok(!threw, `坏档（${name}）不抛错`)
    if (inst) {
      const s = inst.getState()
      eq(s.started, false, `坏档（${name}）→ 开新局（未开局）`)
      eq(s.difficulty, 1, `坏档（${name}）→ 默认难度`)
      const fixed = readSave()
      ok(fixed !== null && fixed.schemaVersion === 1 && fixed.state.started === false, `坏档（${name}）被替换成合法新存档`)
      inst.destroy()
    }
  }

  /* ---- localStorage 本身不可用 ---- */
  resetEnv()
  storage.throwGet = true
  let threw = false
  let inst = null
  try {
    inst = PROBE.createGame(bigHost(), { random: () => 0.5 })
  } catch (e) {
    threw = true
  }
  ok(!threw, 'localStorage.getItem 抛错时 createGame 不抛错')
  if (inst) {
    storage.throwGet = false
    const gg = inst.getGame()
    eq(inst.reveal(Math.floor(gg.h / 2) * gg.w + Math.floor(gg.w / 2)), true, 'localStorage 不可用时仍可玩')
    inst.destroy()
  }
  storage.throwGet = false

  resetEnv()
  storage.throwSet = true
  threw = false
  inst = null
  try {
    inst = PROBE.createGame(bigHost(), { random: () => 0.5 })
  } catch (e) {
    threw = true
  }
  ok(!threw, 'localStorage.setItem 抛错时 createGame 不抛错')
  if (inst) {
    storage.throwSet = false
    const gg = inst.getGame()
    eq(inst.reveal(Math.floor(gg.h / 2) * gg.w + Math.floor(gg.w / 2)), true, '写存档失败不影响继续玩')
    inst.destroy()
  }
  storage.throwSet = false

  /* ---- destroy 可重复 ---- */
  resetEnv()
  const g3 = PROBE.createGame(bigHost(), { random: () => 0.5 })
  const baseline = countAllListeners()
  g3.destroy()
  let doubleThrew = false
  try {
    g3.destroy()
    g3.destroy()
  } catch (e) {
    doubleThrew = true
  }
  ok(!doubleThrew, 'destroy 可重复调用（幂等）')
  const after = countAllListeners()
  ok(after < baseline, 'destroy 后监听器已摘除', `baseline=${baseline} after=${after}`)
  eq(g3.getCanvas().removed, true, 'destroy 后 canvas 已从 DOM 移除')
}

/* ============================ 6. document.hidden 暂停计时 ============================ */
{
  resetEnv()
  const game = PROBE.createGame(bigHost(), { random: () => 0.5 })
  const g = game.getGame()
  game.reveal(Math.floor(g.h / 2) * g.w + Math.floor(g.w / 2))
  state.now += 2000
  flushFrames(2)
  const beforeHide = game.getState().elapsedMs
  ok(beforeHide >= 2000, '运行中计时前进', String(beforeHide))
  fakeDoc.hidden = true
  fireDocument('visibilitychange')
  const savedAtHide = readSave()
  ok(savedAtHide !== null && savedAtHide.state.elapsedMs > 0, 'document.hidden 时落盘')
  const hiddenElapsed = game.getState().elapsedMs
  ok(hiddenElapsed >= beforeHide, '隐藏时提交已用时长')
  state.now += 30000
  flushFrames(2)
  eq(game.getState().elapsedMs, hiddenElapsed, '隐藏期间计时不增长（无时间跳跃）')
  fakeDoc.hidden = false
  fireDocument('visibilitychange')
  state.now += 1000
  const afterVisible = game.getState().elapsedMs
  ok(afterVisible >= hiddenElapsed + 900 && afterVisible <= hiddenElapsed + 1500, '可见后从暂停点继续计时', `hidden=${hiddenElapsed} after=${afterVisible}`)
  game.destroy()
}

/* ============================ 7. 渲染期异常不白屏 ============================ */
{
  resetEnv()
  let errMsg = null
  state.ctxBroken = true
  let threw = false
  let inst = null
  try {
    inst = PROBE.createGame(bigHost(), { random: () => 0.5, onError: (m) => { errMsg = m } })
  } catch (e) {
    threw = true
  }
  ok(!threw, '渲染期抛错不会从 createGame 冒出去（白屏）')
  ok(errMsg !== null, '渲染期抛错通过 onError 交给 UI 显示')
  if (inst) {
    ok(errMsg.length > 0, '错误提示可读', String(errMsg))
    inst.destroy()
  }
  state.ctxBroken = false
}

/* ============================ 8. 无全局键盘监听 / 无 body/title 副作用 ============================ */
{
  const types = [...allListenerTypes]
  const keyboard = types.filter((t) => /key(down|up|press)/i.test(t))
  eq(keyboard.length, 0, '全程没有注册任何键盘监听', keyboard.join(','))
  ok(!types.includes('keydown'), '没有 keydown 监听')
  eq(fakeDoc.body.children.length, 0, '没有往 document.body 挂节点')
  ok(fakeDoc.title === undefined, '没有改 document.title')
  const winTypes = [...listeners.window.keys()]
  const docTypes = [...listeners.document.keys()]
  ok(winTypes.every((t) => t === 'resize'), 'window 上只挂 resize', winTypes.join(','))
  ok(docTypes.every((t) => t === 'visibilitychange'), 'document 上只挂 visibilitychange', docTypes.join(','))
}

/* ============================ 9. 帧循环 / rAF 清理 ============================ */
{
  resetEnv()
  const game = PROBE.createGame(bigHost(), { random: () => 0.5 })
  const g = game.getGame()
  game.reveal(Math.floor(g.h / 2) * g.w + Math.floor(g.w / 2))
  ok(rafQueue.length > 0, '进行中会排 rAF 帧')
  state.now += 2500
  flushFrames(3)
  let mineCell = -1
  for (let i = 0; i < g.n; i += 1) if (g.mine[i] !== 0 && !g.open[i]) { mineCell = i; break }
  game.reveal(mineCell)
  flushFrames(3)
  eq(rafQueue.length, 0, '结束后不再排帧（不空转）')
  game.destroy()
  eq(rafQueue.length, 0, 'destroy 后没有残留 rAF')
  eq(timers.length, 0, 'destroy 后没有残留 timer')
}

/* ---------------------------------- 汇总 ---------------------------------- */
console.log(`headless：${checks - fails.length} 项通过 / ${checks} 项；失败 ${fails.length}（耗时 ${Date.now() - t0}ms）`)
if (fails.length) {
  for (const f of fails.slice(0, 40)) console.error('FAIL: ' + f)
  process.exit(1)
}
console.log('HEADLESS OK')
