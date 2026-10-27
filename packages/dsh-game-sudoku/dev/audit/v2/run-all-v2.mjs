/**
 * Run the whole v2 independent audit suite sequentially.
 *
 * Run: node dev/audit/v2/run-all-v2.mjs
 * Exit codes: 0 = all passed, 1 = a script failed, 2 = artifacts not ready yet.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scripts = [
  'selftest-oracle-v2.mjs',
  'audit-v2-bank.mjs',
  'audit-v2-grades.mjs',
  'audit-v2-save.mjs',
  'audit-v2-contract.mjs',
]

let failed = 0
let waiting = 0
for (const script of scripts) {
  const file = fileURLToPath(new URL(script, import.meta.url))
  console.log('\n===== ' + script + ' =====')
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (result.error) {
    failed += 1
    console.error('could not run ' + script + ': ' + result.error.message)
    continue
  }
  if (result.status === 2) {
    waiting += 1
    console.log('(waiting for artifacts)')
  } else if (result.status !== 0) {
    failed += 1
    console.error(script + ' exited with code ' + result.status)
  }
}

console.log('')
if (waiting > 0 && failed === 0) {
  console.log('AUDIT V2 SUITE: WAITING for v2 artifacts (' + waiting + ' script(s)); dev/bank.json and/or the final client.js are not promoted yet')
  process.exitCode = 2
} else if (failed > 0) {
  console.log('AUDIT V2 SUITE: ' + failed + ' script(s) failed' + (waiting > 0 ? ' (' + waiting + ' still waiting)' : ''))
  process.exitCode = 1
} else {
  console.log('AUDIT V2 SUITE: all ' + scripts.length + ' scripts passed')
}
