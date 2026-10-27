/* 内联完整性独立校验（不用 dev/verify-inline.mjs 的任何结论）
 * 运行：node packages/dsh-game-complexweeper/dev/audit/inline-check.mjs
 * 退出码：0 = 逐字节一致；1 = 不一致。
 *
 * 做法：自己按 dev/engine-api.md §5 定义的锚点，从 client.js 原始字节里切片，
 * 与 engine.js 原始字节做 sha256 + Buffer.compare。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, '..', '..')
const clientPath = join(pkg, 'client.js')
const enginePath = join(pkg, 'engine.js')

const BEGIN = '/* >>> DSH INLINE ENGINE BEGIN (verbatim copy of ./engine.js) >>> */'
const END = '/* <<< DSH INLINE ENGINE END <<< */'

const clientBuf = readFileSync(clientPath)
const engineBuf = readFileSync(enginePath)
const clientText = clientBuf.toString('utf8')

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

const problems = []
const counts = {}
for (const [label, anchor] of [['BEGIN', BEGIN], ['END', END]]) {
  let count = 0
  let at = -1
  for (;;) {
    const i = clientText.indexOf(anchor, at + 1)
    if (i < 0) break
    count++
    at = i
  }
  counts[label] = count
  if (count !== 1) problems.push(`锚点 ${label} 出现 ${count} 次（要求恰好 1 次）`)
}

let extracted = null
if (counts.BEGIN === 1 && counts.END === 1) {
  const b = clientText.indexOf(BEGIN)
  const e = clientText.indexOf(END)
  if (e < b) problems.push('END 锚点在 BEGIN 之前')
  else {
    // 切片从 BEGIN 行之后（含换行）到 END 锚点之前
    const afterBegin = clientText.indexOf('\n', b)
    if (afterBegin < 0) problems.push('BEGIN 锚点后没有换行')
    else {
      const startByte = Buffer.byteLength(clientText.slice(0, afterBegin + 1), 'utf8')
      const endByte = Buffer.byteLength(clientText.slice(0, e), 'utf8')
      extracted = clientBuf.subarray(startByte, endByte)
    }
  }
}

const result = {
  engine: { bytes: engineBuf.length, sha256: sha(engineBuf) },
  client: { bytes: clientBuf.length, sha256: sha(clientBuf) },
  anchors: counts,
  extracted: extracted ? { bytes: extracted.length, sha256: sha(extracted) } : null,
}

if (extracted) {
  if (extracted.length !== engineBuf.length) problems.push(`抽取块长度 ${extracted.length} ≠ engine.js ${engineBuf.length}`)
  if (Buffer.compare(extracted, engineBuf) !== 0) {
    problems.push('抽取块与 engine.js 逐字节不一致')
    // 找第一处差异
    const min = Math.min(extracted.length, engineBuf.length)
    for (let i = 0; i < min; i++) {
      if (extracted[i] !== engineBuf[i]) {
        problems.push(`首个差异在偏移 ${i}: extracted=0x${extracted[i].toString(16)} engine=0x${engineBuf[i].toString(16)}`)
        break
      }
    }
  }
  // 抽取块后面紧跟的换行形态（不影响逐字节比较，只报告）
  result.extractedStartsAt = clientText.slice(0, clientText.indexOf(BEGIN)).split('\n').length
}

// engine.js 自身不能包含锚点字符串（否则会自我嵌套）
for (const [label, anchor] of [['BEGIN', BEGIN], ['END', END]]) {
  if (engineBuf.toString('utf8').includes(anchor)) problems.push(`engine.js 里出现了锚点 ${label} 字符串（会自我嵌套）`)
}

// client.js 里 BEGIN/END 之间不能再出现锚点
if (extracted) {
  const ex = extracted.toString('utf8')
  if (ex.includes(BEGIN) || ex.includes(END)) problems.push('抽取块内部又出现锚点（疑似嵌套）')
}

console.log(JSON.stringify(result, null, 2))
if (problems.length) {
  console.error('INLINE CHECK FAILED:')
  for (const p of problems) console.error(' - ' + p)
  process.exit(1)
}
console.log('INLINE OK: 抽取块与 engine.js 逐字节相等（sha256 一致）')
