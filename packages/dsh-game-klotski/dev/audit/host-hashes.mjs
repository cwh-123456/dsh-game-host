/**
 * Suite 5 — host untouched baseline (sha256) + contract directory sanity.
 *
 *   node packages/dsh-game-klotski/dev/audit/host-hashes.mjs
 *
 * Baselines were supplied by the Team Lead in the audit brief. Any missing file
 * or hash mismatch is a blocking finding (the game package must not modify the
 * host).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const BASELINES = [
  ['packages/dsh-game-host/client.js', '6AD9F3CA9BA1926153F87E4E1CA64076E566051667CB341FD3528F53365533CD'],
  ['packages/dsh-game-host/cordis.patch.yml', '406C6E49EBFC92C3D4884582FC3B67FD1DE40ECFE06BF80895D5C94A9566D5EC'],
  ['packages/dsh-game-host/icon.svg', '5A2EED8C0C521353F2661DD8182E70C920993ABC5C6B9101ABCF5898573F153F'],
  ['packages/dsh-game-host/index.js', '9B12920C5FFFED9A27F2292E9434960F6E27927DE6678E4021AD590AA8F37D9D'],
  ['packages/dsh-game-host/package.json', '43E2AE6765636540290AB367EA7C13B77611AE49215C856E07CD3157134BB889'],
  ['packages/dsh-game-host/README.md', '9801C9E5877E98D09091C0E6F215E368D2DF522B75351650E752FD8838906579'],
  ['packages/dsh-game-host/locale/en.json', 'AEC0C9A4FC14A5ABE333C35A446582655A5AB4EA23DC28540605BAB81E18E012'],
  ['packages/dsh-game-host/locale/zh.json', 'AE8BE702E036402229E6F9FB4A977CE9AF4E5222C038574CD7E0E3C7A794119C'],
  ['handoff/contract/game-plugin-api.v1.md', '56CFB257C7C66EAE73470845480E6C6E097BFAD90472F96C4B61F9DA18D6A91C'],
]

const results = []
let failed = 0
console.log('=== Suite 5: host / contract baseline sha256 ===\n')
for (const [relative, expected] of BASELINES) {
  const absolute = join(WORKSPACE, relative)
  if (!existsSync(absolute)) {
    failed += 1
    results.push({ file: relative, status: 'MISSING', expected })
    console.error('MISSING ' + relative)
    continue
  }
  const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex').toUpperCase()
  const ok = actual === expected
  if (!ok) failed += 1
  results.push({ file: relative, status: ok ? 'MATCH' : 'MISMATCH', expected, actual })
  console.log((ok ? 'MATCH    ' : 'MISMATCH ') + relative + (ok ? '' : '\n  expected ' + expected + '\n  actual   ' + actual))
}

// The brief says handoff/contract holds only the frozen v1 document.
const contractDir = join(WORKSPACE, 'handoff', 'contract')
const entries = readdirSync(contractDir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
const topFiles = entries.filter((entry) => !entry.dir).map((entry) => entry.name)
const topDirs = entries.filter((entry) => entry.dir).map((entry) => entry.name)
console.log('\nhandoff/contract top-level files: ' + JSON.stringify(topFiles))
console.log('handoff/contract top-level dirs : ' + JSON.stringify(topDirs))
const contractNote = []
if (!(topFiles.length === 1 && topFiles[0] === 'game-plugin-api.v1.md')) {
  contractNote.push('top-level files differ from the single-file baseline')
}
if (topDirs.length > 0) {
  contractNote.push('extra directory/directories present: ' + JSON.stringify(topDirs) + ' (pre-existing, not part of the sha256 baseline)')
}

// Game package must not be installed into / mixed with the host package.
const gameInsideHost = existsSync(join(WORKSPACE, 'packages', 'dsh-game-host', 'packages', 'dsh-game-klotski'))
if (gameInsideHost) {
  failed += 1
  results.push({ file: 'packages/dsh-game-host/packages/dsh-game-klotski', status: 'UNEXPECTED' })
}

console.log('\n--- Result ---')
console.log(JSON.stringify({ files: results, failed, contractDir: { topFiles, topDirs, notes: contractNote } }, null, 2))

if (failed > 0) {
  console.error('\nSUITE 5 FAILED: ' + failed + ' baseline problem(s)')
  process.exitCode = 1
} else {
  console.log('\nSUITE 5 PASS — all ' + BASELINES.length + ' baseline files match; host untouched.')
}
