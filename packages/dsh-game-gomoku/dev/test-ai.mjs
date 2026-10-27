/**
 * @local/dsh-game-gomoku — AI / 规则 / 存档 / 生命周期自测。
 *
 * 运行：node dev/test-ai.mjs（需在包根目录）
 *
 * 覆盖（任务书要求的最小集 + 额外回归）：
 *   1. 成五检测：横 / 竖 / 两斜 / 边界 / 长连 / 断点 / 误报
 *   2. 冲四必堵：AI（简单 / 普通 / 困难）必须堵住对手下一手成五
 *   3. 活三必堵：普通 / 困难必须堵在活三的端点
 *   4. AI 不超时：6 个随机局面 × 3 档难度，单步 < 300ms，且棋型/候选/落点合法
 *   5. 撤销正确：人机模式撤 2 步、双人模式撤 1 步、AI 思考中禁止撤销、胜负后撤销
 *   6. 候选点限制：所有候选点都在已有棋子 Chebyshev 2 格内
 *   7. 存档 round-trip / 坏档拒绝 / 卸载落盘 / 重进恢复
 *   8. 契约形状：manifest、cordis patch、slot 注册、无全局键盘监听、只 require('react')
 *
 * 说明：这里用最小 fake DOM（真正跑 createGame 生命周期），不是宿主真机验收；
 * 真机验收需插件安装后在 DSH 内按契约 §10 进行。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* =========================================================================
 * 最小 fake DOM / fake 浏览器 env
 * ====================================================================== */

function createGradient() {
  return { addColorStop() {} }
}

function createContext() {
  return {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowColor: 'transparent',
    shadowBlur: 0,
    clearRect() {},
    setTransform() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    bezierCurveTo() {},
    fill() {},
    stroke() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    save() {},
    restore() {},
    createLinearGradient: createGradient,
    createRadialGradient: createGradient,
    measureText() {
      return { width: 0 }
    },
  }
}

function createElement(tag, width, height) {
  const node = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    listeners: {},
    attributes: {},
    width: 0,
    height: 0,
    tabIndex: 0,
    className: '',
    parentNode: null,
    getContext() {
      return createContext()
    },
    getBoundingClientRect() {
      return { width: width, height: height, left: 0, top: 0, right: width, bottom: height }
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    getAttribute(name) {
      return this.attributes[name]
    },
    focus() {},
    appendChild(child) {
      child.parentNode = this
      this.children.push(child)
      return child
    },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this)
    },
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type]
      if (!list) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
  }
  return node
}

function createMemoryStorage() {
  const map = new Map()
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
    clear() {
      map.clear()
    },
  }
}

/** 一套独立的 window/document/timers/localStorage（每个 createGame 测试用新 env）。 */
function createEnv(width, height) {
  const w = width || 720
  const h = height || 600
  const timers = []
  let nextTimerId = 1
  const storage = createMemoryStorage()
  const docListeners = {}
  const windowListeners = {}
  const doc = {
    hidden: false,
    createElement(tag) {
      return createElement(tag, w, h)
    },
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = []
      docListeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      const list = docListeners[type]
      if (!list) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
  }
  const win = {
    __DSH_GAME_GOMOKU_TEST__: true,
    __ModuleLoader__: {
      load(definition) {
        win.__definition = definition
      },
    },
    localStorage: storage,
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      if (!windowListeners[type]) windowListeners[type] = []
      windowListeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      const list = windowListeners[type]
      if (!list) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    setTimeout(fn, delay) {
      const id = nextTimerId
      nextTimerId += 1
      timers.push({ id: id, fn: fn, delay: delay || 0, canceled: false, done: false })
      return id
    },
    clearTimeout(id) {
      for (let i = 0; i < timers.length; i += 1) {
        if (timers[i].id === id) timers[i].canceled = true
      }
    },
    // 故意不提供 requestAnimationFrame：计时显示循环不启动，测试不依赖 rAF。
  }
  return {
    win: win,
    doc: doc,
    timers: timers,
    storage: storage,
    docListeners: docListeners,
    windowListeners: windowListeners,
  }
}

/** 把 env 装成全局（client.js 的 createGame / 存档函数在调用时读全局 window/document）。 */
function installEnv(env) {
  globalThis.window = env.win
  globalThis.document = env.doc
  return env
}

/** 执行所有挂起定时器（忽略延迟），直到不再产生新定时器。 */
function flushTimers(env, maxRounds) {
  const limit = maxRounds || 40
  for (let round = 0; round < limit; round += 1) {
    const pending = env.timers.filter(function (timer) {
      return !timer.canceled && !timer.done
    })
    if (pending.length === 0) return round
    for (let i = 0; i < pending.length; i += 1) {
      pending[i].done = true
      pending[i].fn()
    }
  }
  throw new Error('flushTimers: timers did not settle in ' + limit + ' rounds')
}

function dispatchDoc(env, type) {
  const list = env.docListeners[type] || []
  for (let i = 0; i < list.length; i += 1) list[i]()
}

/* =========================================================================
 * 测试基础设施
 * ====================================================================== */

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok - ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name: name, error: error })
    console.error('not ok - ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

function section(title) {
  console.log('\n# ' + title)
}

/* 先建一个初始 env 供 import 期使用；每个用例再按需 installEnv 新 env。 */
const bootEnv = installEnv(createEnv(720, 600))
await import(new URL('../client.js', import.meta.url).href)
const S = globalThis.window.__DSH_GAME_GOMOKU__
assert.ok(S, 'test seam window.__DSH_GAME_GOMOKU__ should be installed')

const BLACK = S.BLACK
const WHITE = S.WHITE
const EMPTY = S.EMPTY
const SIZE = S.SIZE
const idx = S.idx

function p2(r, c) {
  return idx(r, c)
}

function makeBoard(stones) {
  const board = S.createBoard()
  for (let i = 0; i < stones.length; i += 1) {
    const item = stones[i]
    assert.ok(Array.isArray(item) && item.length === 3, 'stone must be [r, c, side]')
    board[idx(item[0], item[1])] = item[2]
  }
  return board
}

function placeList(board, stones) {
  for (let i = 0; i < stones.length; i += 1) {
    board[idx(stones[i][0], stones[i][1])] = stones[i][2]
  }
  return board
}

function boardEquals(board, expected) {
  assert.equal(board.length, expected.length)
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] !== expected[i]) {
      assert.equal(board[i], expected[i], 'cell ' + i + ' (' + S.rowOf(i) + ',' + S.colOf(i) + ') mismatch')
    }
  }
}

function countStones(board) {
  let count = 0
  for (let i = 0; i < board.length; i += 1) if (board[i] !== EMPTY) count += 1
  return count
}

function hasStoneNear(board, p, radius) {
  const r = S.rowOf(p)
  const c = S.colOf(p)
  for (let dr = -radius; dr <= radius; dr += 1) {
    for (let dc = -radius; dc <= radius; dc += 1) {
      const rr = r + dr
      const cc = c + dc
      if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue
      if (board[idx(rr, cc)] !== EMPTY) return true
    }
  }
  return false
}

function assertLegalMove(board, point, label) {
  assert.ok(typeof point === 'number' && point >= 0 && point < S.CELLS, label + ': point in range')
  assert.equal(board[point], EMPTY, label + ': point must be empty')
  assert.equal(hasStoneNear(board, point, 2), true, label + ': point must be within 2 of an existing stone')
}

function choose(board, side, level, options) {
  const snapshot = board.slice()
  const started = performance.now()
  const result = S.chooseMove(board, side, level, options)
  const spent = performance.now() - started
  boardEquals(board, snapshot)
  return { result: result, spent: spent }
}

/* 可重复的伪随机（LCG） */
function makeRandom(seed) {
  let state = (seed >>> 0) || 1
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** 随机铺一个合法（无成五）局面，返回 { board, turn, stones }。 */
function randomPosition(stones, seed) {
  const rand = makeRandom(seed)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const board = S.createBoard()
    let side = BLACK
    let placed = 0
    let dead = false
    while (placed < stones) {
      const candidates = S.getCandidates(board)
      if (candidates.length === 0) {
        dead = true
        break
      }
      const point = candidates[Math.floor(rand() * candidates.length)]
      board[point] = side
      if (S.isWin(board, point, side)) {
        dead = true
        break
      }
      placed += 1
      side = S.otherSide(side)
    }
    if (!dead && placed === stones) return { board: board, turn: side, stones: placed }
  }
  throw new Error('randomPosition: could not build a quiet position with ' + stones + ' stones')
}

/* =========================================================================
 * 1) 契约 / manifest / slot 注册形状
 * ====================================================================== */

section('契约形状')

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const cordisPatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const localeZh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const localeEn = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

test('manifest follows the game.stage contract', function () {
  assert.equal(packageJson.name, '@local/dsh-game-gomoku')
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.type, 'module')
  assert.ok(packageJson.exports['.'], 'exports .')
  assert.equal(packageJson.exports['./client'], './client.js')
  assert.ok(packageJson.exports['./locale/*.json'], 'exports locale')
  assert.ok(packageJson.exports['./icon'], 'exports icon')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.equal(packageJson.dsh.client.immediately, true)
  assert.equal(packageJson.dsh.client.inject, undefined, 'must not declare dsh.client.inject')
  assert.equal(packageJson.dependencies, undefined, 'must not declare dependencies')
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
    assert.ok(packageJson.files.indexOf(file) >= 0, 'files should list ' + file)
  }
  assert.ok(packageJson.files.indexOf('locale/*.json') >= 0)
  assert.equal(cordisPatch.indexOf("id: game-gomoku") >= 0, true)
  assert.equal(cordisPatch.indexOf("name: '@local/dsh-game-gomoku'") >= 0, true)
  assert.equal(/export function apply\(\)\s*\{\s*\}/.test(indexSource), true, 'index.js should be an empty apply')
  assert.equal(localeZh.meta.title, '五子棋')
  assert.equal(localeEn.meta.title, 'Gomoku')
  assert.equal(typeof localeZh.meta.description, 'string')
  assert.equal(typeof localeEn.meta.description, 'string')
})

test('client source has no global keyboard listeners / body writes / wrong require', function () {
  assert.equal(/window\.addEventListener\(\s*['"]keydown/.test(clientSource), false, 'no window keydown')
  assert.equal(/document\.addEventListener\(\s*['"]keydown/.test(clientSource), false, 'no document keydown')
  assert.equal(/document\.body/.test(clientSource), false, 'no document.body')
  assert.equal(/document\.title/.test(clientSource), false, 'no document.title')
  const requires = clientSource.match(/require\(([^)]*)\)/g) || []
  assert.ok(requires.length >= 1, 'factory should require react')
  for (const item of requires) {
    assert.equal(item.replace(/\s/g, ''), "require('react')", 'only react may be required: ' + item)
  }
  assert.equal((clientSource.match(/__ModuleLoader__\.load\(/g) || []).length, 1, 'one module registration')
  assert.equal(clientSource.indexOf("STORE_KEY = 'dsh.game.gomoku.v1'") >= 0, true)
  assert.equal(/dsh\.game\.(?!gomoku)/.test(clientSource), false, 'must not touch other game save keys')
})

test('slot registration shape is exactly the v1 contract', function () {
  const definition = globalThis.window.__definition
  assert.ok(definition, 'module definition should be registered at import time')
  assert.equal(definition.id, '@local/dsh-game-gomoku')

  function ReactStub() {}
  ReactStub.createElement = function () {
    return null
  }
  ReactStub.Component = function Component(props) {
    this.props = props
    this.state = null
  }
  ReactStub.Component.prototype.setState = function () {}

  const plugin = definition.factory(function (name) {
    assert.equal(name, 'react')
    return ReactStub
  })
  assert.deepEqual(plugin.inject, ['slots'])

  let registered = null
  const ctx = {
    slots: {
      inject(name, callback) {
        assert.equal(name, 'game.stage')
        callback()
      },
      register(slot, component) {
        registered = { slot: slot, component: component }
        return function () {}
      },
    },
  }
  plugin.apply(ctx)
  assert.ok(registered, 'must register exactly one game.stage entry')
  assert.equal(registered.slot.name, 'game.stage')
  assert.equal(registered.slot.id, 'gomoku')
  assert.equal(registered.slot.label(), '五子棋')
  assert.equal(typeof registered.slot.select, 'function')
  assert.equal(typeof registered.component, 'function')
  const matched = registered.slot.select({ gameId: 'gomoku' })
  assert.ok(matched && typeof matched === 'object')
  assert.equal(Object.isFrozen(matched), true, 'matched object should be frozen')
  assert.equal(registered.slot.select({ gameId: 'gomoku' }), matched, 'matched reference stable')
  assert.equal(registered.slot.select({ gameId: '2048' }), null)
  assert.equal(registered.slot.select({}), null)
  assert.equal(registered.slot.select(null), null)
})

/* =========================================================================
 * 2) 成五检测
 * ====================================================================== */

section('成五检测')

test('horizontal / vertical / both diagonals win and report the exact line', function () {
  const cases = [
    { name: 'horizontal', stones: [[7, 3], [7, 4], [7, 5], [7, 6]], point: [7, 7] },
    { name: 'vertical', stones: [[3, 9], [4, 9], [5, 9], [6, 9]], point: [7, 9] },
    { name: 'diag down-right', stones: [[4, 4], [5, 5], [6, 6], [7, 7]], point: [8, 8] },
    { name: 'diag down-left', stones: [[4, 8], [5, 7], [6, 6], [7, 5]], point: [8, 4] },
  ]
  for (const item of cases) {
    const board = makeBoard(item.stones.map(function (pair) {
      return [pair[0], pair[1], BLACK]
    }))
    const point = idx(item.point[0], item.point[1])
    assert.equal(S.isWin(board, point, BLACK), false, item.name + ': empty point is not a win before placing')
    board[point] = BLACK
    assert.equal(S.isWin(board, point, BLACK), true, item.name + ': should win')
    const line = S.winningLine(board, point, BLACK)
    assert.ok(line, item.name + ': line')
    assert.equal(line.length, 5, item.name + ': line length')
    const sorted = line.slice().sort(function (a, b) {
      return a - b
    })
    const expected = item.stones.map(function (pair) {
      return idx(pair[0], pair[1])
    }).concat([point]).sort(function (a, b) {
      return a - b
    })
    assert.deepEqual(sorted, expected, item.name + ': exact cells')
    board[point] = EMPTY
  }
})

test('win on all four board edges and corners', function () {
  const scenarios = [
    // 顶边横五
    { stones: [[0, 0], [0, 1], [0, 2], [0, 3]], point: [0, 4] },
    // 底边横五
    { stones: [[14, 10], [14, 11], [14, 12], [14, 13]], point: [14, 14] },
    // 左边竖五
    { stones: [[2, 0], [3, 0], [4, 0], [5, 0]], point: [6, 0] },
    // 右边竖五
    { stones: [[8, 14], [9, 14], [10, 14], [11, 14]], point: [12, 14] },
    // 左上角到右下的斜五
    { stones: [[0, 0], [1, 1], [2, 2], [3, 3]], point: [4, 4] },
    // 右上角到左下的斜五
    { stones: [[0, 14], [1, 13], [2, 12], [3, 11]], point: [4, 10] },
    // 左下角到右上的斜五
    { stones: [[14, 0], [13, 1], [12, 2], [11, 3]], point: [10, 4] },
  ]
  for (let i = 0; i < scenarios.length; i += 1) {
    const board = S.createBoard()
    const scenario = scenarios[i]
    for (const pair of scenario.stones) board[idx(pair[0], pair[1])] = BLACK
    const point = idx(scenario.point[0], scenario.point[1])
    board[point] = BLACK
    assert.equal(S.isWin(board, point, BLACK), true, 'edge scenario #' + i)
  }
})

test('long runs (6+) count as a win and the whole run is highlighted', function () {
  const stones = []
  for (let c = 3; c <= 7; c += 1) stones.push([7, c])
  const board = makeBoard(stones.map(function (pair) {
    return [pair[0], pair[1], BLACK]
  }))
  const point = idx(7, 8)
  assert.equal(S.isWin(board, point, BLACK), false, 'empty point is not a win before placing')
  board[point] = BLACK
  assert.equal(S.isWin(board, point, BLACK), true, 'six in a row wins')
  const line = S.winningLine(board, point, BLACK)
  assert.equal(line.length, 6, 'whole run highlighted')
  assert.equal(line[0], idx(7, 3))
  assert.equal(line[5], idx(7, 8))
  // 中间落子也应当连成六子
  const middle = S.createBoard()
  for (const c of [3, 4, 5, 7, 8]) middle[idx(7, c)] = BLACK
  middle[idx(7, 6)] = BLACK
  assert.equal(S.isWin(middle, idx(7, 6), BLACK), true)
  assert.equal(S.winningLine(middle, idx(7, 6), BLACK).length, 6)
})

test('no false positives: four in a row / gap / wrong color are not wins', function () {
  const four = makeBoard([[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]])
  assert.equal(S.isWin(four, idx(7, 6), BLACK), false, 'four is not five')
  assert.equal(S.winningLine(four, idx(7, 6), BLACK), null)

  const gap = makeBoard([[7, 3, BLACK], [7, 4, BLACK], [7, 6, BLACK], [7, 7, BLACK]])
  gap[idx(7, 5)] = BLACK
  assert.equal(S.isWin(gap, idx(7, 5), BLACK), true, 'filling the gap makes five')
  gap[idx(7, 5)] = EMPTY
  assert.equal(S.isWin(gap, idx(7, 5), WHITE), false, 'empty point with the other color is not a win')

  const wrongColor = makeBoard([[7, 3, WHITE], [7, 4, WHITE], [7, 5, WHITE], [7, 6, WHITE], [7, 7, WHITE]])
  assert.equal(S.isWin(wrongColor, idx(7, 7), BLACK), false, 'black is not white')
  assert.equal(S.isWin(wrongColor, idx(7, 7), WHITE), true, 'white five')
})

test('winningLine returns cells from one end to the other', function () {
  const board = makeBoard([[4, 4, WHITE], [5, 5, WHITE], [6, 6, WHITE], [7, 7, WHITE]])
  const point = idx(8, 8)
  board[point] = WHITE
  const line = S.winningLine(board, point, WHITE)
  assert.deepEqual(line, [idx(4, 4), idx(5, 5), idx(6, 6), idx(7, 7), idx(8, 8)])
  const reverse = makeBoard([[8, 8, WHITE], [7, 7, WHITE], [6, 6, WHITE], [5, 5, WHITE]])
  reverse[idx(4, 4)] = WHITE
  assert.deepEqual(S.winningLine(reverse, idx(4, 4), WHITE), line)
})

/* =========================================================================
 * 3) 冲四必堵 / 活三必堵 / 不自杀
 * ====================================================================== */

section('AI 防守')

function blockFourPosition(orientation) {
  // 黑棋四子，白棋堵住一端，另一端是唯一成五点；轮到白棋。
  const board = S.createBoard()
  if (orientation === 'horizontal') {
    for (let c = 4; c <= 7; c += 1) board[idx(7, c)] = BLACK
    board[idx(7, 8)] = WHITE
    return { board: board, expected: idx(7, 3) }
  }
  if (orientation === 'vertical') {
    for (let r = 4; r <= 7; r += 1) board[idx(r, 6)] = BLACK
    board[idx(8, 6)] = WHITE
    return { board: board, expected: idx(3, 6) }
  }
  if (orientation === 'diag-down') {
    for (let k = 0; k < 4; k += 1) board[idx(4 + k, 3 + k)] = BLACK
    board[idx(8, 7)] = WHITE
    return { board: board, expected: idx(3, 2) }
  }
  // diag-up
  for (let k = 0; k < 4; k += 1) board[idx(4 + k, 10 - k)] = BLACK
  board[idx(8, 6)] = WHITE
  return { board: board, expected: idx(3, 11) }
}

for (const level of [1, 2, 3]) {
  test('level ' + level + ' AI must block an open-ended four (冲四必堵, 4 orientations)', function () {
    for (const orientation of ['horizontal', 'vertical', 'diag-down', 'diag-up']) {
      const setup = blockFourPosition(orientation)
      const move = choose(setup.board, WHITE, level)
      assert.equal(move.result.p, setup.expected,
        'level ' + level + ' ' + orientation + ': must block the only five point (got ' + move.result.p +
        ', expected ' + setup.expected + ', reason=' + move.result.reason + ')')
    }
  })
}

function openThreePositions() {
  const list = []
  // 横向活三：黑 (7,5)(7,6)(7,7)，两端 (7,4)/(7,8) 空
  {
    const board = S.createBoard()
    board[idx(7, 5)] = BLACK
    board[idx(7, 6)] = BLACK
    board[idx(7, 7)] = BLACK
    board[idx(2, 2)] = WHITE
    board[idx(12, 12)] = WHITE
    list.push({ name: 'horizontal', board: board, expected: [idx(7, 4), idx(7, 8)] })
  }
  // 纵向活三
  {
    const board = S.createBoard()
    board[idx(5, 5)] = BLACK
    board[idx(6, 5)] = BLACK
    board[idx(7, 5)] = BLACK
    board[idx(2, 12)] = WHITE
    board[idx(12, 2)] = WHITE
    list.push({ name: 'vertical', board: board, expected: [idx(4, 5), idx(8, 5)] })
  }
  // 斜向活三
  {
    const board = S.createBoard()
    board[idx(5, 5)] = BLACK
    board[idx(6, 6)] = BLACK
    board[idx(7, 7)] = BLACK
    board[idx(2, 11)] = WHITE
    board[idx(12, 3)] = WHITE
    list.push({ name: 'diagonal', board: board, expected: [idx(4, 4), idx(8, 8)] })
  }
  return list
}

for (const level of [2, 3]) {
  test('level ' + level + ' AI must block an open three (活三必堵)', function () {
    const positions = openThreePositions()
    for (const position of positions) {
      const move = choose(position.board, WHITE, level)
      assert.ok(position.expected.indexOf(move.result.p) >= 0,
        'level ' + level + ' ' + position.name + ': must block at ' + position.expected.join('/') +
        ' (got ' + move.result.p + ', reason=' + move.result.reason + ')')
      assertLegalMove(position.board, move.result.p, 'block move')
    }
  })
}

test('AI prefers its own immediate win over blocking the opponent', function () {
  // 白棋有活四（两端都能成五），黑棋也有活四；轮到白棋，AI 必须直接赢。
  const board = S.createBoard()
  for (let c = 4; c <= 7; c += 1) board[idx(7, c)] = WHITE
  for (let c = 4; c <= 7; c += 1) board[idx(9, c)] = BLACK
  for (const level of [1, 2, 3]) {
    const move = choose(board, WHITE, level)
    const winsNow = S.isWin((function () {
      const copy = board.slice()
      copy[move.result.p] = WHITE
      return copy
    })(), move.result.p, WHITE)
    assert.equal(winsNow, true, 'level ' + level + ': AI should take the win (got ' + move.result.p + ')')
  }
})

test('AI never returns an occupied / out-of-range / far-away point', function () {
  const rand = makeRandom(97)
  for (let i = 0; i < 12; i += 1) {
    const position = randomPosition(2 + Math.floor(rand() * 30), 1000 + i)
    for (const level of [1, 2, 3]) {
      const move = choose(position.board, position.turn, level)
      assertLegalMove(position.board, move.result.p, 'random #' + i + ' level ' + level)
      assert.equal(move.result.p, move.result.p | 0)
    }
  }
})

/* =========================================================================
 * 4) 候选点限制 / 性能（单步 < 300ms）
 * ====================================================================== */

section('候选点与性能')

test('candidate generation only looks within 2 cells of existing stones', function () {
  assert.deepEqual(S.getCandidates(S.createBoard()), [S.CENTER], 'empty board -> center (天元)')

  const one = S.createBoard()
  one[idx(7, 7)] = BLACK
  const oneCandidates = S.getCandidates(one)
  assert.equal(oneCandidates.length, 24, 'one stone -> 5x5 minus center')
  for (const point of oneCandidates) {
    assert.equal(Math.max(Math.abs(S.rowOf(point) - 7), Math.abs(S.colOf(point) - 7)) <= 2, true)
  }

  const corners = S.createBoard()
  corners[idx(0, 0)] = BLACK
  corners[idx(14, 14)] = WHITE
  corners[idx(14, 0)] = BLACK
  const cornerCandidates = S.getCandidates(corners)
  for (const point of cornerCandidates) {
    assert.equal(hasStoneNear(corners, point, 2), true, 'candidate must be near a stone')
  }
  // 距离 3 的空点绝不能被选入
  for (const point of cornerCandidates) {
    let ok = false
    for (const stone of [idx(0, 0), idx(14, 14), idx(14, 0)]) {
      const distance = Math.max(
        Math.abs(S.rowOf(point) - S.rowOf(stone)),
        Math.abs(S.colOf(point) - S.colOf(stone)),
      )
      if (distance <= 2) ok = true
    }
    assert.equal(ok, true)
  }
})

test('AI thinking time stays under 300ms on quiet mid-game positions (all levels)', function () {
  const seeds = [11, 22, 33, 44, 55, 66]
  const targets = [6, 14, 22, 30, 40, 50]
  const positions = seeds.map(function (seed, i) {
    return randomPosition(targets[i], seed)
  })

  // 预热（避免把首次 JIT 计入）
  for (let i = 0; i < 3; i += 1) {
    choose(positions[0].board, positions[0].turn, 3)
  }

  const stats = { 1: [], 2: [], 3: [] }
  const details = []
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i]
    for (const level of [1, 2, 3]) {
      const move = choose(position.board, position.turn, level)
      const spent = move.spent
      stats[level].push(spent)
      assert.ok(spent < 300, 'level ' + level + ' stone#' + position.stones + ': ' + spent.toFixed(1) + 'ms >= 300ms')
      assert.ok(move.result.thinkMs < 300, 'level ' + level + ': self-reported thinkMs ' + move.result.thinkMs + ' >= 300')
      assertLegalMove(position.board, move.result.p, 'level ' + level + ' stone#' + position.stones)
      details.push({
        stones: position.stones,
        level: level,
        ms: Number(spent.toFixed(2)),
        thinkMs: Number(move.result.thinkMs.toFixed(2)),
        reason: move.result.reason,
        depth: move.result.depth,
        nodes: move.result.nodes,
        candidates: move.result.candidates,
      })
    }
  }
  for (const level of [1, 2, 3]) {
    const list = stats[level]
    const max = Math.max.apply(null, list)
    const avg = list.reduce(function (a, b) {
      return a + b
    }, 0) / list.length
    console.log('   level ' + level + ': max ' + max.toFixed(1) + 'ms, avg ' + avg.toFixed(1) + 'ms')
  }
  console.log('   hard search detail: ' + details.filter(function (item) {
    return item.level === 3
  }).map(function (item) {
    return item.stones + ' stones -> ' + item.ms + 'ms (' + item.reason + ', depth ' + item.depth + ', ' + item.nodes + ' nodes)'
  }).join('; '))

  // 困难难度：非必胜/必堵的候选必须真的做过 α-β 搜索（而不是降级为贪心）
  const hardDetails = details.filter(function (item) {
    return item.level === 3
  })
  const searched = hardDetails.filter(function (item) {
    return item.reason === 'search'
  })
  const shortcuts = hardDetails.filter(function (item) {
    return item.reason === 'win' || item.reason === 'block'
  })
  for (const item of searched) {
    assert.equal(item.depth, 4, 'hard search should reach depth 4 (stones #' + item.stones + ')')
    assert.ok(item.nodes > 0, 'hard search should report nodes')
  }
  assert.equal(searched.length + shortcuts.length, positions.length, 'every hard move is either a search or a forced win/block')
  assert.ok(searched.length >= 4, 'hard AI should complete a depth-4 search in most quiet positions, got ' + searched.length + '/' + positions.length)
})

test('hard AI honours a small time budget and never mutates the board', function () {
  const position = randomPosition(40, 202)
  const snapshot = Array.from(position.board)
  const move = S.chooseMove(position.board, position.turn, 3, { budgetMs: 30 })
  boardEquals(position.board, snapshot)
  assert.ok(move.thinkMs < 250, 'small budget should still return quickly: ' + move.thinkMs)
  assertLegalMove(position.board, move.p, 'small budget')
})

/* =========================================================================
 * 5) 撤销 / 生命周期 / 存档
 * ====================================================================== */

section('撤销 / 生命周期 / 存档')

function createGameEnv(width, height) {
  const env = installEnv(createEnv(width, height))
  const host = env.doc.createElement('div')
  const states = []
  const game = S.createGame(host, {
    onState: function (state) {
      states.push(state)
    },
    onError: function () {},
  })
  return { env: env, host: host, game: game, states: states }
}

function firstEmptyPoint(board) {
  for (let i = 0; i < board.length; i += 1) if (board[i] === EMPTY) return i
  return -1
}

test('pve undo removes exactly 2 steps (your move + AI reply)', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  assert.equal(game.getState().moves, 0)
  assert.equal(game.getState().turn, BLACK)
  assert.equal(game.getState().mode, 'pve')

  assert.equal(game.playCell(idx(7, 7)), true)
  assert.equal(game.getState().moves, 1)
  assert.equal(game.getState().busy, true, 'AI should be thinking')
  assert.equal(game.undo(), false, 'undo must be disabled while AI is thinking')
  flushTimers(ctx.env)

  assert.equal(game.getState().moves, 2, 'AI replied')
  assert.equal(game.getState().turn, BLACK)
  assert.equal(game.getState().busy, false)
  assert.equal(countStones(arrayFrom(game.getBoard())), 2)

  const afterFirstRound = game.getBoard()
  game.playCell(firstEmptyPoint(afterFirstRound))
  flushTimers(ctx.env)
  assert.equal(game.getState().moves, 4)

  assert.equal(game.undo(), true)
  assert.equal(game.getState().moves, 2, 'pve undo must remove 2 stones')
  assert.deepEqual(game.getBoard(), afterFirstRound, 'board restored to previous round')
  assert.equal(game.getState().turn, BLACK)
  assert.equal(game.getState().over, false)

  assert.equal(game.undo(), true)
  assert.equal(game.getState().moves, 0)
  assert.equal(countStones(arrayFrom(game.getBoard())), 0)
  assert.equal(game.getState().canUndo, false)

  game.destroy()
})

function arrayFrom(value) {
  return Array.prototype.slice.call(value)
}

test('pvp undo removes exactly 1 step', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  game.setMode('pvp')
  assert.equal(game.getState().mode, 'pvp')
  assert.equal(game.playCell(idx(7, 7)), true)
  assert.equal(game.playCell(idx(7, 8)), true)
  assert.equal(game.getState().moves, 2)
  assert.equal(game.undo(), true)
  assert.equal(game.getState().moves, 1)
  assert.equal(game.getBoard()[idx(7, 8)], EMPTY)
  assert.equal(game.getBoard()[idx(7, 7)], BLACK)
  assert.equal(game.getState().turn, WHITE)
  game.destroy()
})

test('win is detected inside a real game and undo clears the result', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  game.setMode('pvp')
  // 黑棋 (7,3)..(7,7) 连五，白棋在别处应付
  const blackMoves = [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]]
  const whiteMoves = [[0, 0], [0, 1], [0, 2], [0, 3]]
  for (let i = 0; i < blackMoves.length; i += 1) {
    assert.equal(game.playCell(idx(blackMoves[i][0], blackMoves[i][1])), true, 'black #' + i)
    if (i < whiteMoves.length) {
      assert.equal(game.playCell(idx(whiteMoves[i][0], whiteMoves[i][1])), true, 'white #' + i)
    }
  }
  const state = game.getState()
  assert.equal(state.over, true)
  assert.equal(state.winner, BLACK)
  assert.equal(state.moves, 9)
  assert.ok(Array.isArray(state.winLine))
  assert.equal(state.winLine.length, 5)
  assert.equal(state.turn, WHITE, 'turn still advances after the winning move')
  assert.equal(game.playCell(idx(10, 10)), false, 'no moves after game over')

  assert.equal(game.undo(), true)
  assert.equal(game.getState().over, false)
  assert.equal(game.getState().winner, 0)
  assert.equal(game.getState().winLine, null)
  assert.equal(game.getState().moves, 8)
  game.destroy()
})

test('save is written on unload and restored by the next mount', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  game.setMode('pvp')
  for (const pair of [[7, 7], [7, 8], [6, 6], [8, 8], [5, 5]]) {
    assert.equal(game.playCell(idx(pair[0], pair[1])), true)
  }
  const before = game.getBoard()
  const historyBefore = game.getHistory()
  game.destroy()

  const raw = ctx.env.storage.getItem('dsh.game.gomoku.v1')
  assert.ok(raw, 'save key must exist after destroy')
  assert.equal(raw.indexOf('"schemaVersion":1') >= 0, true)

  const env2 = installEnv(createEnv(720, 600))
  // 复用同一份 localStorage（模拟刷新）
  env2.win.localStorage = ctx.env.storage
  const host2 = env2.doc.createElement('div')
  const game2 = S.createGame(host2, {})
  assert.deepEqual(game2.getBoard(), before, 'board restored')
  assert.deepEqual(game2.getHistory(), historyBefore, 'history restored')
  assert.equal(game2.getState().mode, 'pvp')
  assert.equal(game2.getState().moves, 5)
  assert.equal(game2.getState().turn, WHITE, 'five moves: black, white, black, white, black -> white to move')
  game2.destroy()
})

test('finished game result survives save/restore', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  game.setMode('pvp')
  const moves = [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3], [7, 7]]
  for (const pair of moves) assert.equal(game.playCell(idx(pair[0], pair[1])), true)
  assert.equal(game.getState().over, true)
  assert.equal(game.getState().winner, BLACK)
  const winLine = game.getState().winLine
  game.destroy()

  const env2 = installEnv(createEnv(720, 600))
  env2.win.localStorage = ctx.env.storage
  const game2 = S.createGame(env2.doc.createElement('div'), {})
  assert.equal(game2.getState().over, true)
  assert.equal(game2.getState().winner, BLACK)
  assert.deepEqual(game2.getState().winLine, winLine)
  game2.destroy()
})

test('a full board with no five in a row replays as a draw', function () {
  /* (r + 2c) mod 4 < 2 的 2-染色在 15×15 四方向都没有 5 连；黑 113 / 白 112。
   * 先填满整盘（每步交替）→ 历史合法、全程无成五 → 只剩「和棋」分支。 */
  const color = function (r, c) {
    return ((r + 2 * c) % 4) < 2 ? BLACK : WHITE
  }
  const blackCells = []
  const whiteCells = []
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (color(r, c) === BLACK) blackCells.push(idx(r, c))
      else whiteCells.push(idx(r, c))
    }
  }
  assert.equal(blackCells.length, 113)
  assert.equal(whiteCells.length, 112)

  const board = S.createBoard()
  const history = []
  let blackCursor = 0
  let whiteCursor = 0
  for (let i = 0; i < S.CELLS; i += 1) {
    const side = i % 2 === 0 ? BLACK : WHITE
    const point = side === BLACK ? blackCells[blackCursor++] : whiteCells[whiteCursor++]
    board[point] = side
    assert.equal(S.isWin(board, point, side), false, 'no five at move ' + i)
    history.push({ p: point, side: side })
  }
  assert.equal(history.length, S.CELLS)

  const save = {
    schemaVersion: 1,
    mode: 'pvp',
    level: 2,
    board: Array.from(board),
    turn: WHITE,
    history: history,
    over: true,
    winner: S.DRAW,
    winLine: null,
    elapsedMs: 1000,
  }
  const sanitized = S.sanitizeSave(JSON.parse(JSON.stringify(save)))
  assert.ok(sanitized, 'full-board draw save should be accepted')
  assert.equal(sanitized.over, true)
  assert.equal(sanitized.winner, S.DRAW)
  assert.equal(sanitized.history.length, S.CELLS)
  assert.equal(sanitized.turn, WHITE)

  const tampered = JSON.parse(JSON.stringify(save))
  tampered.winner = BLACK
  assert.equal(S.sanitizeSave(tampered), null, 'fake winner on a draw is rejected')

  const env = installEnv(createEnv(720, 600))
  env.storage.setItem(S.STORE_KEY, JSON.stringify(save))
  const game = S.createGame(env.doc.createElement('div'), {})
  const state = game.getState()
  assert.equal(state.over, true)
  assert.equal(state.winner, S.DRAW)
  assert.equal(state.moves, S.CELLS)
  assert.equal(game.playCell(idx(0, 0)), false, 'no moves on a full board')
  assert.equal(game.undo(), true, 'undo from a draw clears the result')
  assert.equal(game.getState().over, false)
  assert.equal(game.getState().winner, S.DRAW)
  assert.equal(game.getState().moves, S.CELLS - 1)
  game.destroy()
})

test('corrupted / tampered saves are rejected and a fresh game starts', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  game.setMode('pvp')
  game.playCell(idx(7, 7))
  game.playCell(idx(7, 8))
  game.destroy()
  const good = ctx.env.storage.getItem('dsh.game.gomoku.v1')

  const mutations = [
    function (data) {
      data.schemaVersion = 2
    },
    function (data) {
      data.mode = 'coop'
    },
    function (data) {
      data.level = 9
    },
    function (data) {
      data.board[0] = 3
    },
    function (data) {
      data.board[idx(7, 7)] = WHITE
    },
    function (data) {
      data.turn = WHITE
    },
    function (data) {
      data.history[0].side = WHITE
    },
    function (data) {
      data.history[1].p = idx(7, 7)
    },
    function (data) {
      data.over = true
    },
    function (data) {
      data.elapsedMs = -5
    },
    function (data) {
      data.elapsedMs = 'nope'
    },
    function (data) {
      data.history = 'nope'
    },
  ]

  for (let i = 0; i < mutations.length; i += 1) {
    const data = JSON.parse(good)
    mutations[i](data)
    assert.equal(S.sanitizeSave(data), null, 'mutation #' + i + ' must be rejected')
  }

  // 坏档 + 重新挂载 → 开新局，不抛错
  for (let i = 0; i < mutations.length; i += 1) {
    const data = JSON.parse(good)
    mutations[i](data)
    const env = installEnv(createEnv(720, 600))
    ctx.env.storage.setItem('dsh.game.gomoku.v1', JSON.stringify(data))
    env.win.localStorage = ctx.env.storage
    const fresh = S.createGame(env.doc.createElement('div'), {})
    assert.equal(fresh.getState().moves, 0, 'mutation #' + i + ': fresh game expected')
    assert.equal(fresh.getState().turn, BLACK)
    fresh.destroy()
  }

  // 解析失败 / 纯垃圾也不抛错
  const env3 = installEnv(createEnv(720, 600))
  ctx.env.storage.setItem('dsh.game.gomoku.v1', '{not json')
  env3.win.localStorage = ctx.env.storage
  const fresh3 = S.createGame(env3.doc.createElement('div'), {})
  assert.equal(fresh3.getState().moves, 0)
  fresh3.destroy()
})

test('hiding the page pauses the AI and the clock; showing resumes it', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  assert.equal(game.playCell(idx(7, 7)), true)
  const ticksBefore = ctx.env.timers.length
  ctx.env.doc.hidden = true
  dispatchDoc(ctx.env, 'visibilitychange')
  // 挂起的 AI 定时器被撤销：flush 后 AI 不应落子
  flushTimers(ctx.env)
  assert.equal(game.getState().moves, 1, 'AI must not move while hidden')
  assert.equal(ctx.states[ctx.states.length - 1].hidden, true)
  assert.ok(ticksBefore > 0)

  ctx.env.doc.hidden = false
  dispatchDoc(ctx.env, 'visibilitychange')
  flushTimers(ctx.env)
  assert.equal(game.getState().moves, 2, 'AI resumes when visible')
  assert.equal(game.getState().turn, BLACK)
  game.destroy()
})

test('too-small stage falls back to the "窗口太小" rendering path', function () {
  const env = installEnv(createEnv(300, 200))
  const game = S.createGame(env.doc.createElement('div'), {})
  assert.equal(game.getState().tooSmall, true)
  assert.equal(game.getLayout(), null)
  game.destroy()
  const env2 = installEnv(createEnv(720, 600))
  const game2 = S.createGame(env2.doc.createElement('div'), {})
  assert.equal(game2.getState().tooSmall, false)
  const layout = game2.getLayout()
  assert.ok(layout && layout.cssSize === 600, 'square canvas fits the smaller stage edge')
  game2.destroy()
})

test('geometry maps clicks to the nearest intersection', function () {
  assert.equal(S.LOGICAL_SIZE, S.PAD * 2 + S.CELL * (SIZE - 1))
  assert.equal(S.computeLayout(800, 600).cssSize, 600)
  assert.equal(S.computeLayout(360, 520).cssSize, 360)
  assert.equal(S.computeLayout(0, 0).cssSize, 1)
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const point = S.cellCenter(idx(r, c))
      assert.equal(S.cellHit(point.x, point.y), idx(r, c))
      assert.equal(S.cellHit(point.x + S.CELL * 0.3, point.y - S.CELL * 0.3), idx(r, c))
    }
  }
  assert.equal(S.cellHit(-100, -100), -1)
  assert.equal(S.cellHit(S.LOGICAL_SIZE + 50, S.LOGICAL_SIZE + 50), -1)
})

test('AI delay setting stays inside the required 200-400ms window', function () {
  assert.equal(S.AI_DELAY_MIN >= 200, true)
  assert.equal(S.AI_DELAY_MAX <= 400, true)
  assert.equal(S.HARD_BUDGET_MS < 300, true)
  assert.equal(S.LEVELS[1].name, '简单')
  assert.equal(S.LEVELS[2].name, '普通')
  assert.equal(S.LEVELS[3].name, '困难')
  assert.equal(S.LEVELS[3].depth, 4)
  assert.ok(S.LEVELS[3].candidates <= 12)
})

/* =========================================================================
 * 汇总
 * ====================================================================== */

test('mode / difficulty / restart controls behave and persist', function () {
  const ctx = createGameEnv()
  const game = ctx.game
  assert.equal(game.playCell(idx(7, 7)), true)
  flushTimers(ctx.env)
  assert.equal(game.getState().moves, 2)

  game.setLevel(3)
  assert.equal(game.getState().level, 3)
  assert.equal(JSON.parse(ctx.env.storage.getItem('dsh.game.gomoku.v1')).level, 3, 'level persisted')
  game.setLevel(9)
  assert.equal(game.getState().level, 3, 'invalid level ignored')

  game.newGame()
  assert.equal(game.getState().moves, 0)
  assert.equal(game.getState().level, 3, 'restart keeps difficulty')

  game.setMode('pvp')
  assert.equal(game.getState().mode, 'pvp')
  assert.equal(game.getState().moves, 0, 'mode switch starts a new game')
  game.setMode('nope')
  assert.equal(game.getState().mode, 'pvp', 'invalid mode ignored')
  game.destroy()
})

console.log('')
console.log('ai tests: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('failures:')
  for (const item of failures) console.log(' - ' + item.name)
  process.exitCode = 1
}
