// Lead-only dev harness: drive a private headless Edge over CDP.
// Avoids the shared dsh-browser page (which concurrent sessions navigate).
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9350 + Math.floor(Math.random() * 300)
const PROFILE = mkdtempSync(join(tmpdir(), 'sudoku-cdp-'))

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch (error) {
      lastError = error
    }
    await sleep(120)
  }
  throw new Error('devtools endpoint did not come up: ' + (lastError ? lastError.message : 'timeout'))
}

async function openTarget(url) {
  const listResponse = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const targets = await listResponse.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('no page target')
  if (url) {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!response.ok) throw new Error('cannot open new target: ' + response.status)
    await sleep(50)
    const after = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const fresh = after.filter((target) => target.type === 'page').pop()
    if (fresh) return fresh
  }
  return page
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 0
    const pending = new Map()
    const events = []
    ws.onopen = () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = ++nextId
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params: params || {} }))
          })
        },
        events,
        close() {
          try { ws.close() } catch (error) { /* ignore */ }
        },
      })
    }
    ws.onerror = (event) => reject(new Error('websocket error: ' + (event && event.message ? event.message : 'unknown')))
    ws.onmessage = (event) => {
      let message
      try { message = JSON.parse(event.data) } catch (error) { return }
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) item.rej(new Error(JSON.stringify(message.error)))
        else item.res(message.result)
      } else if (message.method) {
        events.push(message)
      }
    }
  })
}

async function main() {
  let browser
  try {
    const version = await waitForDevtools(15000)
    console.log('devtools up:', JSON.stringify(version).slice(0, 160))
    const target = await openTarget('about:blank')
    browser = await connect(target.webSocketDebuggerUrl)
    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    const result = await browser.send('Runtime.evaluate', { expression: '1+1', returnByValue: true })
    console.log('eval result:', JSON.stringify(result))
    const info = await browser.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
    console.log('ua:', info.result && info.result.value)
    console.log('SMOKE PASS')
  } finally {
    if (browser) browser.close()
    try { child.kill() } catch (error) { /* ignore */ }
  }
}

main().catch((error) => {
  console.error('SMOKE FAIL:', error && error.stack ? error.stack : error)
  try { child.kill() } catch (killError) { /* ignore */ }
  process.exitCode = 1
})
