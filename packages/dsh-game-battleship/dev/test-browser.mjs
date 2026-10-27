#!/usr/bin/env node
/**
 * Battleship dev-preview runner (dev-only, never shipped).
 *
 * Why this exists: the preview.html page is the primary harness, but this repo's
 * shared browser tooling can be busy with other games. This script launches an
 * ISOLATED headless Microsoft Edge (Chromium) with a temporary profile over the
 * DevTools protocol (no third-party deps; Node >= 22 provides global fetch +
 * WebSocket), opens dev/preview.html, runs the page's interaction self-test
 * (`?selftest=1` equivalent) against real Chromium and prints machine-readable
 * results. It never installs anything and never touches the plugin's client.js.
 *
 * Usage (from repo root):
 *   node packages/dsh-game-battleship/dev/test-browser.mjs
 *   node packages/dsh-game-battleship/dev/test-browser.mjs --url "file:///.../preview.html?selftest=1&theme=dark"
 *   node packages/dsh-game-battleship/dev/test-browser.mjs --scenario battleFast --shot %TEMP%/battleship.png
 *
 * Exit code: 0 = selftest all pass, 1 = failures / harness error.
 *
 * NOTE: this is a dev preview with a fake React renderer over real DOM — it is
 * NOT host acceptance. It does not install the plugin or run the DSH host GUI.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const PREVIEW = join(HERE, 'preview.html')
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = true
    }
  }
  return args
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function findBrowser() {
  for (const candidate of EDGE_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (event) => {
      let message = null
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message + ' (' + entry.method + ')'))
        else entry.resolve(message.result)
        return
      }
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch (error) {
          // ignore listener errors
        }
      }
    })
  }

  send(method, params, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const payload = { id, method, params: params || {} }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        this.pending.delete(id)
        rejectSend(error)
      }
    })
  }

  onEvent(listener) {
    this.listeners.push(listener)
  }

  waitForEvent(method, sessionId, timeoutMs) {
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        remove()
        rejectWait(new Error('timeout waiting for ' + method))
      }, timeoutMs || 15000)
      const listener = (message) => {
        if (message.method !== method) return
        if (sessionId && message.sessionId !== sessionId) return
        clearTimeout(timer)
        remove()
        resolveWait(message.params)
      }
      const remove = () => {
        const index = this.listeners.indexOf(listener)
        if (index >= 0) this.listeners.splice(index, 1)
      }
      this.onEvent(listener)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch (error) {
      // ignore
    }
  }
}

async function waitForJson(port, path, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < (timeoutMs || 20000)) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + path)
      if (response.ok) return await response.json()
    } catch (error) {
      // browser not ready yet
    }
    await delay(120)
  }
  throw new Error('Chromium DevTools endpoint did not come up on port ' + port)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const browserPath = findBrowser()
  if (!browserPath) throw new Error('No Chromium browser found (looked for Edge/Chrome)')

  const previewUrl = args.url
    ? String(args.url)
    : pathToFileURL(PREVIEW).href + '?theme=light&size=720x600'

  const profileDir = join(tmpdir(), 'dsh-battleship-preview-' + process.pid + '-' + Date.now())
  mkdirSync(profileDir, { recursive: true })
  const port = 9400 + Math.floor(Math.random() * 400)

  const browser = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  const consoleErrors = []
  const pageErrors = []
  let ws = null
  let cdp = null
  let sessionId = null

  try {
    const version = await waitForJson(port, '/json/version')
    ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', resolveOpen, { once: true })
      ws.addEventListener('error', () => rejectOpen(new Error('failed to connect to DevTools websocket')), { once: true })
    })
    cdp = new CDP(ws)
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => String(arg.value !== undefined ? arg.value : arg.description || '')).join(' '))
      }
      if (message.method === 'Runtime.exceptionThrown' && message.params && message.params.exceptionDetails) {
        const details = message.params.exceptionDetails
        pageErrors.push(details.exception && details.exception.description ? details.exception.description : (details.text || 'exception'))
      }
    })

    const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    sessionId = attached.sessionId

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: previewUrl }, sessionId)

    /* wait for page + preview harness */
    const start = Date.now()
    let ready = false
    while (Date.now() - start < 20000) {
      try {
        const result = await cdp.send('Runtime.evaluate', {
          expression: 'document.readyState + "|" + (window.__preview ? "preview" : "no-preview") + "|" + (window.__previewReady === true ? "ready" : "boot")',
          returnByValue: true,
          awaitPromise: false,
        }, sessionId)
        const value = result && result.result && result.result.value
        if (String(value).indexOf('preview|ready') >= 0) {
          ready = true
          break
        }
      } catch (error) {
        // navigation in progress
      }
      await delay(150)
    }
    if (!ready) throw new Error('preview page did not boot (client.js missing or boot error)')

    const scenario = args.scenario ? String(args.scenario) : null
    let scenarioResult = null
    if (scenario) {
      const expression = '(async () => { try { await window.__preview.runScenario(' + JSON.stringify(scenario) + '); return JSON.stringify({ ok: true }); } catch (error) { return JSON.stringify({ ok: false, error: String(error && error.stack || error) }); } })()'
      const evaluated = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      scenarioResult = JSON.parse(evaluated.result.value)
      if (!scenarioResult.ok) throw new Error('scenario failed: ' + scenarioResult.error)
      await delay(250)
    }

    let selftestResult = null
    if (!scenario || args.selftest === true) {
      const expression = '(async () => { try { const result = await window.__preview.runSelftest(); return JSON.stringify({ ok: true, result }); } catch (error) { return JSON.stringify({ ok: false, error: String(error && error.stack || error) }); } })()'
      const evaluated = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      const parsed = JSON.parse(evaluated.result.value)
      if (!parsed.ok) throw new Error('selftest crashed: ' + parsed.error)
      selftestResult = parsed.result
    }

    if (args.shot) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId)
      await delay(200)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      const outPath = resolve(String(args.shot))
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
      console.log('screenshot: ' + outPath)
    }

    /* pull the page's own error collections as well */
    const errorsEvaluated = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ errors: window.__errors || [], rejections: window.__rejections || [], consoleErrors: window.__consoleErrors || [], url: location.href })',
      returnByValue: true,
    }, sessionId)
    const pageState = JSON.parse(errorsEvaluated.result.value)

    const report = {
      url: previewUrl,
      browser: browserPath,
      selftest: selftestResult,
      scenario: scenarioResult,
      pageUrl: pageState.url,
      pageErrors: pageState.errors,
      pageRejections: pageState.rejections,
      pageConsoleErrors: pageState.consoleErrors,
      cdpConsoleErrors: consoleErrors,
      cdpExceptions: pageErrors,
    }
    console.log(JSON.stringify(report, null, 2))

    const failures = selftestResult && selftestResult.fail > 0
    const errorCount = pageState.errors.length + pageState.rejections.length + pageState.consoleErrors.length + consoleErrors.length + pageErrors.length
    if (failures || errorCount > 0) {
      console.error('RESULT: FAIL (selftest fails=' + (selftestResult ? selftestResult.fail : 'n/a') + ', errors=' + errorCount + ')')
      process.exitCode = 1
    } else {
      console.error('RESULT: PASS (selftest ' + (selftestResult ? selftestResult.pass + '/' + selftestResult.total : 'not-run') + ')')
    }
  } catch (error) {
    console.error('RESULT: HARNESS ERROR: ' + (error && error.stack ? error.stack : String(error)))
    process.exitCode = 1
  } finally {
    try {
      if (cdp && sessionId) await cdp.send('Browser.close', {})
    } catch (error) {
      // ignore
    }
    try {
      if (cdp) cdp.close()
    } catch (error) {
      // ignore
    }
    try {
      browser.kill()
    } catch (error) {
      // ignore
    }
    await delay(300)
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch (error) {
      // ignore (Windows may still hold a handle briefly)
    }
  }
}

main()
