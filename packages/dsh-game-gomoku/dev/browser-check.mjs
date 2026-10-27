/**
 * @local/dsh-game-gomoku — 独立 Chromium（Edge headless / CDP）交互自测。
 *
 * 运行：node dev/browser-check.mjs
 *
 * 为什么不用 browser 工具：工作区里多个游戏并行开发时浏览器实例可能被别的会话
 * 导航走；本脚本自己拉起一个 headless Edge（独立 user-data-dir），用 CDP 驱动，
 * 跑完就退出。只读文件、只把结果打到 stdout（沙箱内 Node 不能写工作区文件）。
 *
 * 覆盖：真实 DOM 渲染、canvas 点击落子、AI 200~400ms 节奏、撤销 2 步、
 *       双人模式成五/胜利高亮/撤销、困难档、规则弹窗、主题/尺寸、卸载落盘、
 *       重挂恢复、悬停预览、键盘 U 撤销、控制台 0 error。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const previewUrl = pathToFileURL(path.join(here, 'preview.html')).href + '?reset=1&x=' + Date.now()
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const port = 9400 + Math.floor(Math.random() * 200)
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-gomoku-edge-'))
const edgeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
  '--remote-allow-origins=*',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  'about:blank',
]
const child = spawn(EDGE, edgeArgs, { stdio: 'ignore' })
let killed = false
function cleanup() {
  if (killed) return
  killed = true
  try {
    child.kill()
  } catch (error) {
    /* ignore */
  }
}
process.on('exit', cleanup)
process.on('SIGINT', function () {
  cleanup()
  process.exit(130)
})

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

async function waitForDevtools() {
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version')
      if (response.ok) return await response.json()
    } catch (error) {
      // not ready yet
    }
    await sleep(200)
  }
  throw new Error('devtools endpoint did not come up on port ' + port)
}

async function openTarget(url) {
  const response = await fetch(
    'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url),
    { method: 'PUT' },
  )
  if (!response.ok) throw new Error('cannot open tab: HTTP ' + response.status)
  return await response.json()
}

function connect(url) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(url)
    ws.addEventListener('open', function () {
      resolve(ws)
    })
    ws.addEventListener('error', function () {
      reject(new Error('websocket connection failed'))
    })
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.exceptions = []
    this.logErrors = []
    const self = this
    ws.addEventListener('message', function (event) {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        return
      }
      if (message.id) {
        const pending = self.pending.get(message.id)
        if (!pending) return
        self.pending.delete(message.id)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        self.consoleErrors.push(message.params.args.map(function (arg) {
          return arg.value !== undefined ? String(arg.value) : (arg.description || arg.type)
        }).join(' '))
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        self.exceptions.push(details.text + ' ' + (details.exception && details.exception.description ? details.exception.description : ''))
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        self.logErrors.push(message.params.entry.text)
      }
    })
  }

  send(method, params) {
    const id = (this.nextId += 1)
    const self = this
    return new Promise(function (resolve, reject) {
      self.pending.set(id, { resolve: resolve, reject: reject })
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      throw new Error('page evaluate failed: ' + details.text + ' ' +
        (details.exception && details.exception.description ? details.exception.description : ''))
    }
    return result.result.value
  }
}

/* ------------------------------------------------------------------------- *
 * 页面内自动测试脚本（在 Edge 里执行，返回 JSON 结果）
 * ------------------------------------------------------------------------- */
const PAGE_TEST = `
(async function () {
  var P = window.__preview
  var out = { steps: [], checks: [], errors: [] }
  function rec(name, data) { out.steps.push(Object.assign({ name: name }, data)) }
  function check(name, ok, detail) { out.checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }) }
  function save() { return P.save() }
  function text() { return document.body.innerText }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function stones() { return save().board.filter(function (v) { return v !== 0 }).length }

  /* 0) boot */
  check('boot checks all pass', P.bootChecks.every(function (b) { return b.ok }), P.bootChecks.filter(function (b) { return !b.ok }).map(function (b) { return b.name }).join(','))
  check('no boot errors', P.errors.length === 0, P.errors.join(' | '))
  check('canvas mounted', !!P.canvas())
  check('initial status', P.status() === '轮到你（黑子）', P.status())
  check('initial save empty', save().history.length === 0 && stones() === 0)
  rec('initial', { status: P.status(), buttons: P.buttons(), save: { mode: save().mode, level: save().level, moves: 0 } })

  /* 1) hover preview -> pointer cursor */
  P.moveMouse(7, 7)
  await sleep(60)
  check('hover on empty point shows pointer cursor', P.canvas().style.cursor === 'pointer', P.canvas().style.cursor)

  /* 2) human move + AI reply, measure delay */
  var started = performance.now()
  P.clickCell(7, 7)
  check('human move recorded', save().history.length === 1 && save().history[0].p === 112 && save().history[0].side === 1, JSON.stringify(save().history))
  check('AI turn after human move', P.status() === 'AI（白子）回合', P.status())
  var aiDeadline = Date.now() + 2000
  while (save().history.length < 2 && Date.now() < aiDeadline) await sleep(20)
  var aiDelay = performance.now() - started
  var aiSave = save()
  check('AI replied', aiSave.history.length === 2, JSON.stringify(aiSave.history))
  check('AI move is white', aiSave.history[1].side === 2)
  check('AI move is near a stone', (function () {
    var p = aiSave.history[1].p
    var r = Math.floor(p / 15), c = p % 15
    for (var dr = -2; dr <= 2; dr += 1) for (var dc = -2; dc <= 2; dc += 1) {
      var rr = r + dr, cc = c + dc
      if (rr >= 0 && rr < 15 && cc >= 0 && cc < 15 && aiSave.board[rr * 15 + cc] !== 0) return true
    }
    return false
  })())
  check('AI delay in 200-400ms window (+ thinking)', aiDelay >= 180 && aiDelay <= 800, Math.round(aiDelay) + 'ms')
  check('status back to human after AI', P.status() === '轮到你（黑子）', P.status())
  check('AI think time shown in status', /AI 上步 \\d+ ms/.test(text()), (text().match(/AI 上步 \\d+ ms/) || [])[0] || '')
  rec('after-ai', { moves: aiSave.history.length, delayMs: Math.round(aiDelay), history: aiSave.history, status: P.status() })

  /* 3) undo removes 2 stones */
  P.clickButton('撤销')
  var undoSave = save()
  check('undo removes 2 stones', undoSave.history.length === 0 && stones() === 0, JSON.stringify({ moves: undoSave.history.length, stones: stones() }))
  check('undo restores black turn', undoSave.turn === 1 && P.status() === '轮到你（黑子）', P.status())
  rec('undo', { moves: undoSave.history.length, status: P.status() })

  /* 4) pvp win + highlight + undo */
  P.clickButton('双人对战')
  check('pvp mode selected', save().mode === 'pvp', save().mode)
  var seq = [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3], [7, 7]]
  for (var i = 0; i < seq.length; i += 1) { P.clickCell(seq[i][0], seq[i][1]); await sleep(30) }
  var winSave = save()
  check('five in a row wins', winSave.over === true && winSave.winner === 1, JSON.stringify({ over: winSave.over, winner: winSave.winner }))
  check('win line has 5 cells', Array.isArray(winSave.winLine) && winSave.winLine.length === 5, JSON.stringify(winSave.winLine))
  check('win banner shown', text().indexOf('黑方获胜！') >= 0, P.status())
  check('further moves rejected', (function () { P.clickCell(10, 10); return save().history.length === 9 })())
  rec('win', { over: winSave.over, winner: winSave.winner, winLine: winSave.winLine, status: P.status() })

  P.clickButton('撤销')
  var undoWin = save()
  check('undo after win clears result', undoWin.over === false && undoWin.winner === 0 && undoWin.winLine === null && undoWin.history.length === 8, JSON.stringify({ over: undoWin.over, moves: undoWin.history.length }))
  rec('undo-win', { over: undoWin.over, moves: undoWin.history.length, status: P.status() })

  /* 5) restart + hard difficulty AI */
  P.clickButton('重开')
  check('restart clears board', save().history.length === 0 && stones() === 0, save().history.length)
  P.clickButton('人机对战')
  P.clickButton('困难')
  check('hard difficulty selected', save().mode === 'pve' && save().level === 3, JSON.stringify({ mode: save().mode, level: save().level }))
  P.clickCell(7, 7)
  await sleep(900)
  check('hard AI replied', save().history.length === 2 && save().history[1].side === 2, JSON.stringify(save().history))
  rec('hard', { history: save().history, status: P.status(), level: save().level })

  /* 6) rules modal */
  P.openRules()
  await sleep(30)
  check('rules modal opens', P.rulesOpen() && !!document.querySelector('[role="dialog"]'), P.rulesOpen())
  P.closeRules()
  await sleep(30)
  check('rules modal closes', !P.rulesOpen(), P.rulesOpen())

  /* 7) keyboard U undo (focus game root via canvas click) */
  var beforeKey = save().history.length
  P.canvas().dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }))
  await sleep(50)
  check('keyboard U triggers undo', save().history.length < beforeKey, String(beforeKey) + ' -> ' + String(save().history.length))
  rec('keyboard', { before: beforeKey, after: save().history.length })

  /* 8) theme + sizes + too small */
  P.setTheme('dark')
  P.setSize(360, 520)
  await sleep(150)
  var rect = P.canvas().getBoundingClientRect()
  check('dark theme applied', document.body.getAttribute('data-theme') === 'dark')
  check('canvas fits 360x520 stage', rect.width >= 300 && rect.width <= 345 && Math.abs(rect.width - rect.height) < 1, Math.round(rect.width) + 'x' + Math.round(rect.height))
  P.setSize(300, 220)
  await sleep(150)
  check('too small shows hint', text().indexOf('窗口太小') >= 0, text().indexOf('窗口太小') >= 0)
  rec('sizes', { smallCanvas: Math.round(rect.width), tooSmall: text().indexOf('窗口太小') >= 0 })
  P.setSize(720, 600)
  P.setTheme('light')
  await sleep(150)
  var normal = P.canvas().getBoundingClientRect()
  check('canvas restored on 720x600', Math.abs(normal.width - normal.height) < 1 && normal.width > 500, Math.round(normal.width) + 'x' + Math.round(normal.height))

  /* 9) unmount writes save, remount restores */
  var before = save()
  var root = document.getElementById('game-root')
  window.FakeReact.unmountComponentAtNode(root)
  await sleep(80)
  var stored = JSON.parse(localStorage.getItem(P.S.STORE_KEY))
  check('unmount removes canvas', !root.querySelector('canvas'))
  check('unmount persisted state', stored && stored.history.length === before.history.length && stored.board.join(',') === before.board.join(','), stored ? String(stored.history.length) : 'no save')
  window.FakeReact.render(window.FakeReact.createElement(P.component, { matched: {} }), root)
  await sleep(350)
  var after = save()
  check('remount restores board/history/turn', after.history.length === before.history.length && after.board.join(',') === before.board.join(',') && after.turn === before.turn, JSON.stringify({ before: before.history.length, after: after.history.length }))
  check('remount canvas works', !!P.canvas())
  rec('remount', { beforeMoves: before.history.length, afterMoves: after.history.length, status: P.status() })

  /* 10) final errors */
  await sleep(200)
  check('preview captured zero runtime errors', P.errors.length === 0, P.errors.join(' | '))
  out.errors = P.errors.slice()
  out.bootOk = P.bootChecks.filter(function (b) { return b.ok }).length
  out.bootTotal = P.bootChecks.length
  return JSON.stringify(out)
})()
`

async function main() {
  const version = await waitForDevtools()
  const target = await openTarget(previewUrl)
  const ws = await connect(target.webSocketDebuggerUrl)
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.send('Page.navigate', { url: previewUrl })

  const readyDeadline = Date.now() + 30000
  let ready = false
  while (Date.now() < readyDeadline) {
    try {
      const state = await cdp.evaluate(
        "document.readyState + '|' + (typeof window.__preview) + '|' + (window.__preview && window.__preview.bootChecks ? window.__preview.bootChecks.length : -1)",
      )
      if (state === 'complete|object|11') {
        ready = true
        break
      }
    } catch (error) {
      // page not ready yet
    }
    await sleep(150)
  }
  if (!ready) throw new Error('preview page did not boot in time')

  const result = await cdp.evaluate(PAGE_TEST)
  const report = JSON.parse(result)
  const failed = report.checks.filter(function (item) {
    return !item.ok
  })
  console.log('Edge headless: ' + version.Browser)
  console.log('boot checks: ' + report.bootOk + '/' + report.bootTotal)
  for (const step of report.steps) console.log('  step ' + step.name + ': ' + JSON.stringify(step).slice(0, 220))
  console.log('')
  for (const item of report.checks) {
    console.log((item.ok ? 'ok   ' : 'FAIL ') + item.name + (item.ok || !item.detail ? '' : ' — ' + item.detail))
  }
  console.log('')
  console.log('页面内 window error / console.error: ' + report.errors.length)
  if (report.errors.length) console.log(report.errors.join('\n'))
  console.log('CDP console.error events: ' + cdp.consoleErrors.length)
  if (cdp.consoleErrors.length) console.log(cdp.consoleErrors.slice(0, 10).join('\n'))
  console.log('CDP page exceptions: ' + cdp.exceptions.length)
  if (cdp.exceptions.length) console.log(cdp.exceptions.slice(0, 10).join('\n'))
  console.log('CDP log errors: ' + cdp.logErrors.length)
  if (cdp.logErrors.length) console.log(cdp.logErrors.slice(0, 10).join('\n'))
  console.log('')
  console.log('browser checks: ' + (report.checks.length - failed.length) + ' passed, ' + failed.length + ' failed')
  if (failed.length || report.errors.length || cdp.exceptions.length) {
    process.exitCode = 1
  }
  try {
    ws.close()
  } catch (error) {
    /* ignore */
  }
  cleanup()
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  cleanup()
  process.exitCode = 1
})
