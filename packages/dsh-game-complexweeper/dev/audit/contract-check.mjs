/* 契约合规静态审计（只读；独立判定，不看别人测试结论）
 * 运行：node packages/dsh-game-complexweeper/dev/audit/contract-check.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 *
 * 依据：handoff/contract/game-plugin-api.v1.md + handoff/to-sub/006-add-complexweeper.md
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..', '..')
const root = join(pkgDir, '..', '..')
const read = (p) => readFileSync(p, 'utf8')
const checks = []
const fails = []
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail })
  if (!cond) fails.push(detail === undefined ? name : `${name} :: ${detail}`)
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const pkg = JSON.parse(read(join(pkgDir, 'package.json')))
const client = read(join(pkgDir, 'client.js'))
const engine = read(join(pkgDir, 'engine.js'))
const indexJs = read(join(pkgDir, 'index.js'))
const patch = read(join(pkgDir, 'cordis.patch.yml'))

/* ------------------------------ 1. package.json ------------------------------ */
check('name = @local/dsh-game-complexweeper', pkg.name === '@local/dsh-game-complexweeper', pkg.name)
check('version 0.1.0', pkg.version === '0.1.0', pkg.version)
check('private: true', pkg.private === true)
check('type: module', pkg.type === 'module')
check('license = GPL-3.0-only', pkg.license === 'GPL-3.0-only', pkg.license)
check('无 dependencies', !pkg.dependencies)
check('无 devDependencies', !pkg.devDependencies)
check('无 peerDependencies', !pkg.peerDependencies)
check('无 optionalDependencies', !pkg.optionalDependencies)
check('exports["."] 存在', typeof pkg.exports === 'object' && pkg.exports['.'] === './index.js', JSON.stringify(pkg.exports))
check('exports["./client"] = ./client.js', pkg.exports && pkg.exports['./client'] === './client.js', pkg.exports && pkg.exports['./client'])
check('exports["./locale/*.json"]', pkg.exports && pkg.exports['./locale/*.json'] === './locale/*.json')
check('exports["./icon"] = ./icon.svg', pkg.exports && pkg.exports['./icon'] === './icon.svg')
check('dsh.bundle.patch = ./cordis.patch.yml', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh))
check('dsh.client 存在', pkg.dsh && pkg.dsh.client && typeof pkg.dsh.client === 'object')
check('dsh.client.platform = web', pkg.dsh.client.platform === 'web')
check('dsh.client.immediately = true', pkg.dsh.client.immediately === true)
check('禁止 dsh.client.inject（契约 §2）', !('inject' in (pkg.dsh.client || {})), JSON.stringify(pkg.dsh.client))
check('files 里列了 client.js', Array.isArray(pkg.files) && pkg.files.includes('client.js'))
check('files 里列了 engine.js', pkg.files.includes('engine.js'))
check('files 里列了 cordis.patch.yml', pkg.files.includes('cordis.patch.yml'))
check('files 里列了 locale/*.json', pkg.files.includes('locale/*.json'))
check('files 里列了 icon.svg', pkg.files.includes('icon.svg'))
check('files 里列了 README.md', pkg.files.includes('README.md'))
check('files 里列了 LICENSE', pkg.files.includes('LICENSE'))

/* files 里每个实际存在的文件都要在盘上（README 由 Lead 最后写，单独标注） */
const missingFiles = []
for (const f of pkg.files) {
  if (f.includes('*')) continue
  if (!existsSync(join(pkgDir, f))) missingFiles.push(f)
}
const pendingReadme = missingFiles.includes('README.md')
check('files 中除 README 外的文件都存在', missingFiles.filter((f) => f !== 'README.md').length === 0, missingFiles.join(','))
if (pendingReadme) check('README.md 由 Lead 后补（当前缺失，记待办）', true)

/* ------------------------------ 2. cordis.patch.yml ------------------------------ */
check('patch 是 "- insert:" 结构', /^-\s*insert:\s*$/m.test(patch), patch)
check('patch id = game-complexweeper', /^\s*-\s*id:\s*game-complexweeper\s*$/m.test(patch))
check('patch name 指向本包', /name:\s*'@local\/dsh-game-complexweeper'/.test(patch), patch.trim())

/* 与其它游戏包的 cordis patch id / 包名不冲突，save key 也不冲突 */
const packagesDir = join(root, 'packages')
const otherPkgs = readdirSync(packagesDir).filter((d) => d.startsWith('dsh-game-') && d !== 'dsh-game-host' && d !== 'dsh-game-complexweeper')
const otherIds = []
const otherNames = []
const otherStoreKeys = {}
for (const d of otherPkgs) {
  const p = join(packagesDir, d)
  try {
    const cp = read(join(p, 'cordis.patch.yml'))
    for (const m of cp.matchAll(/-\s*id:\s*([A-Za-z0-9_-]+)/g)) otherIds.push(m[1])
    for (const m of cp.matchAll(/name:\s*'?([^'\s]+)'?/g)) otherNames.push(m[1])
  } catch (e) { /* 没有 patch 的包跳过 */ }
  try {
    const c = read(join(p, 'client.js'))
    for (const m of c.matchAll(/['"](dsh\.game\.[A-Za-z0-9._-]+)['"]/g)) otherStoreKeys[m[1]] = d
  } catch (e) { /* ignore */ }
}
check('cordis patch id 不与其它游戏冲突', !otherIds.includes('game-complexweeper'), otherIds.join(','))
check('包名不与其它游戏冲突', !otherNames.includes('@local/dsh-game-complexweeper'), otherNames.join(','))
const myStoreKey = 'dsh.game.complexweeper.v1'
check('存档 key 不与其它游戏冲突', !(myStoreKey in otherStoreKeys), Object.keys(otherStoreKeys).join(','))
check('client.js 只使用自己的存档 key', (client.match(/dsh\.game\.[A-Za-z0-9._-]+/g) || []).every((k) => k === myStoreKey), (client.match(/dsh\.game\.[A-Za-z0-9._-]+/g) || []).join(','))
check('save key 定义 = dsh.game.complexweeper.v1', client.includes("'dsh.game.' + GAME_ID + '.v1'"), '')
check('schemaVersion = 1', /SCHEMA_VERSION\s*=\s*1\b/.test(client))

/* ------------------------------ 3. index.js ------------------------------ */
const indexStripped = indexJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim()
check('index.js 只有 export function apply() {}', /^export function apply\(\) \{\}$/.test(indexStripped), JSON.stringify(indexStripped))

/* ------------------------------ 4. locale ------------------------------ */
let zh = null
let en = null
try { zh = JSON.parse(read(join(pkgDir, 'locale', 'zh.json'))) } catch (e) { fails.push('zh.json 不是合法 JSON') }
try { en = JSON.parse(read(join(pkgDir, 'locale', 'en.json'))) } catch (e) { fails.push('en.json 不是合法 JSON') }
check('zh.json 有 meta.title', zh && zh.meta && typeof zh.meta.title === 'string' && zh.meta.title.length > 0)
check('zh.json 标题 = 复扫雷', zh && zh.meta && zh.meta.title === '复扫雷', zh && zh.meta && zh.meta.title)
check('zh.json 有 meta.description', zh && zh.meta && typeof zh.meta.description === 'string' && zh.meta.description.length > 10)
check('en.json 有 meta.title', en && en.meta && typeof en.meta.title === 'string' && en.meta.title.length > 0)
check('en.json 有 meta.description', en && en.meta && typeof en.meta.description === 'string' && en.meta.description.length > 10)
check('en.json 标题 = Complexweeper', en && en.meta && en.meta.title === 'Complexweeper')
for (const [name, obj] of [['zh', zh], ['en', en]]) {
  if (!obj) continue
  const text = JSON.stringify(obj)
  check(`${name}.json 无乱码（U+FFFD）`, !text.includes('\uFFFD'), text.slice(0, 60))
}

/* ------------------------------ 5. icon ------------------------------ */
const iconPath = join(pkgDir, 'icon.svg')
check('icon.svg 存在', existsSync(iconPath))
if (existsSync(iconPath)) {
  const iconSize = statSync(iconPath).size
  check('icon ≤ 256 KiB', iconSize <= 256 * 1024, String(iconSize))
  const icon = read(iconPath)
  check('icon 是 <svg>', /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(icon))
  check('icon 不引用外部资源', !/(href|src)\s*=\s*["'](https?:)?\/\//.test(icon), '')
}

/* ------------------------------ 6. 许可 / 来源 ------------------------------ */
const licensePath = join(pkgDir, 'LICENSE')
check('LICENSE 存在', existsSync(licensePath))
if (existsSync(licensePath)) {
  const lic = read(licensePath)
  check('LICENSE 声明 GPL-3.0', /GPL-3\.0/.test(lic) && /GNU General Public License/.test(lic), '')
  check('LICENSE 含标准免责声明段', /WITHOUT ANY WARRANTY/.test(lic))
  check('LICENSE 注明来源（项目/作者/仓库）', /Yueqing-Chen\/complexweeper-A-minesweeper-game/.test(lic) && /青月晓|Yueqing Chen/.test(lic))
  check('LICENSE 说明不包含原版图像素材', /图像|素材/.test(lic))
  const fullText = /Everyone is permitted to copy and distribute verbatim copies/.test(lic) && lic.length > 20000
  if (!fullText) {
    console.log(`  NOTE LICENSE：未内嵌 GPL-3.0 完整正文（${lic.length} 字节声明 + 获取链接）；GPL 通常要求随附完整许可证文本，建议打包前补全（非阻塞）`)
  }
}
check('engine.js 声明 GPL-3.0', /GPL-3\.0/.test(engine))
check('engine.js 注明上游仓库', /github\.com\/Yueqing-Chen\/complexweeper-A-minesweeper-game/.test(engine))
check('engine.js 注明作者', /青月晓|Yueqing Chen/.test(engine))
check('engine.js 注明参考源文件', /game\.zig/.test(engine))
check('client.js 声明 GPL-3.0', /GPL-3\.0/.test(client))
check('client.js 注明上游仓库', /github\.com\/Yueqing-Chen\/complexweeper-A-minesweeper-game/.test(client))
check('README.md 状态（Lead 最后写）', existsSync(join(pkgDir, 'README.md')) ? true : 'PENDING')

/* ------------------------------ 7. 无复制原版素材 ------------------------------ */
const runtimeFiles = ['index.js', 'client.js', 'engine.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']
const badExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.bin', '.atlas', '.ttf', '.otf', '.woff', '.woff2', '.mp3', '.wav', '.ogg']
const pkgFilesRec = []
;(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'dev' || e.name === 'node_modules') continue
      walk(p)
    } else pkgFilesRec.push(p)
  }
})(pkgDir)
const assetFiles = pkgFilesRec.filter((p) => badExt.includes(extname(p).toLowerCase()))
check('发布范围内没有图片/音效/图集素材', assetFiles.length === 0, assetFiles.join(','))
check('client.js 没有内嵌 base64 图片', !/data:image\//.test(client))
check('client.js 没有 sprite/atlas 字样', !/sprite|atlas/i.test(client))

/* ------------------------------ 8. client.js 注册形状（契约 §1/§3） ------------------------------ */
check("inject 只有 ['slots']", /inject\s*:\s*\[\s*'slots'\s*\]/.test(client), '')
check('没有 ctx.provide(...)', !/ctx\.provide\s*\(/.test(client), '')
check("只 inject 'game.stage' 一个 slot", (client.match(/slots\.inject\s*\(/g) || []).length === 1 && /slots\.inject\(\s*'game\.stage'/.test(client), String((client.match(/slots\.inject\s*\(/g) || []).length))
check('slots.register 只出现一次', (client.match(/slots\.register\s*\(/g) || []).length === 1, String((client.match(/slots\.register\s*\(/g) || []).length))
check("register 的 name = 'game.stage'", /name:\s*'game\.stage'/.test(client))
check('register 的 id = GAME_ID', /id:\s*GAME_ID/.test(client))
check("GAME_ID = 'complexweeper'", /GAME_ID\s*=\s*'complexweeper'/.test(client))
check("label 返回 '复扫雷'", /return\s*'复扫雷'/.test(client))
check('select 严格比较 gameId === GAME_ID', /select:\s*function\s*\(ownerProps\)\s*\{\s*return\s+ownerProps\s*&&\s*ownerProps\.gameId\s*===\s*GAME_ID\s*\?\s*MATCHED\s*:\s*null/.test(client))
check('MATCHED 冻结（Object.freeze）', /const MATCHED = Object\.freeze\(\{\}\)/.test(client))
check('组件只依赖 props（没有用 sessionId 之类宿主内部字段）', !/sessionId|props\.session\b|__DSH_HOST/.test(client))
check('loader id 等于 package.json name', client.includes("id: '@local/dsh-game-complexweeper'"), '')

/* ------------------------------ 9. 安全/健壮性静态检查 ------------------------------ */
// 契约 §6 禁的是「全局」键盘监听（window/document 级），不是 React 的 onKeyDown 属性。
// 所以这里匹配真正的监听注册，而不是裸的 "keydown" 字样。
check(
  '无全局键盘监听（契约 §6）',
  !/addEventListener\(\s*['"](keydown|keyup|keypress)['"]/i.test(client) &&
    !/on(keydown|keyup|keypress)\s*=[^:=]/i.test(client),
)
check('没有 document.body 挂节点', !/document\.body/.test(client))
check('没有改 document.title', !/document\.title\s*=/.test(client))
check('没有联网 API', !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\(/.test(client))
const requires = [...client.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
check("只 require('react')，无第三方库", requires.length > 0 && requires.every((r) => r === 'react'), requires.join(','))
check('测试探针只在 __DSH_GAME_COMPLEXSWEEPER_TEST__ === true 时安装', /window\.__DSH_GAME_COMPLEXSWEEPER_TEST__ === true/.test(client) && /Object\.defineProperty\(\s*window,\s*'__DSH_GAME_COMPLEXSWEEPER__'/.test(client))
check('探针包含 createGame/MATCHED/STORE_KEY', /MATCHED,\s*createGame/.test(client) || (/STORE_KEY,/.test(client) && /createGame,/.test(client)))
check('内联引擎前保存并还原全局 CS', /previousCS/.test(client) && /delete globalRoot\.CS/.test(client))
check('使用 --dsw-alias-* 主题 token 做容器/文字', (client.match(/--dsw-alias-/g) || []).length >= 10, String((client.match(/--dsw-alias-/g) || []).length))
check('canvas 用 ResizeObserver', /ResizeObserver/.test(client))
check('canvas 用 devicePixelRatio', /devicePixelRatio/.test(client))
check('根容器 width/height 100%', /width:\s*'100%'/.test(client) && /height:\s*'100%'/.test(client))
check('<320×240 提示「窗口太小」', /MIN_WIDTH = 320/.test(client) && /MIN_HEIGHT = 240/.test(client) && /窗口太小/.test(client))
check('判定失败有明显反馈（flash + 角标）', /JUDGE_FAIL/.test(client) && /flash/.test(client) && /failBadge/.test(client))
check('渲染/帧循环全部 try/catch（fail 通道）', /function paint\(\)[\s\S]{0,200}try\s*\{[\s\S]{0,120}drawFrame/.test(client) && /catch\s*\(error\)\s*\{\s*fail\(error\)/.test(client))
check('卸载前落盘（teardown → persist）', /function teardown\(\)[\s\S]{0,400}persist\(\)/.test(client))
check('document.hidden 暂停计时', /doc\.hidden/.test(client) && /visibilitychange/.test(client))
check('坏档不白屏（parseSave 返回 null → 开新局）', /function parseSave[\s\S]{0,900}catch\s*\(error\)\s*\{\s*return null/.test(client))

/* ------------------------------ 10. 内联完整性（再次独立比对） ------------------------------ */
const BEGIN = '/* >>> DSH INLINE ENGINE BEGIN (verbatim copy of ./engine.js) >>> */'
const END = '/* <<< DSH INLINE ENGINE END <<< */'
const clientBuf = readFileSync(join(pkgDir, 'client.js'))
const engineBuf = readFileSync(join(pkgDir, 'engine.js'))
const bIdx = client.indexOf(BEGIN)
const eIdx = client.indexOf(END)
const afterB = client.indexOf('\n', bIdx)
const startByte = Buffer.byteLength(client.slice(0, afterB + 1), 'utf8')
const endByte = Buffer.byteLength(client.slice(0, eIdx), 'utf8')
const extracted = clientBuf.subarray(startByte, endByte)
check('BEGIN 锚点恰好一次', client.split(BEGIN).length === 2)
check('END 锚点恰好一次', client.split(END).length === 2)
check('内联块与 engine.js 逐字节相等', extracted.length === engineBuf.length && Buffer.compare(extracted, engineBuf) === 0, `extracted=${sha256(join(pkgDir, 'client.js'))} engine=${sha256(join(pkgDir, 'engine.js'))}`)

/* ---------------------------------- 汇总 ---------------------------------- */
const okCount = checks.filter((c) => c.ok === true).length
const pendingCount = checks.filter((c) => c.ok === 'PENDING').length
console.log('契约合规逐条：')
for (const c of checks) {
  if (c.ok === true) continue
  console.log(`  ${c.ok === 'PENDING' ? 'PENDING' : 'FAIL'} ${c.name}${c.detail ? ' :: ' + c.detail : ''}`)
}
console.log(`\n共 ${checks.length} 项：通过 ${okCount}，待办 ${pendingCount}，失败 ${fails.length}`)
console.log(`engine.js sha256 = ${sha256(join(pkgDir, 'engine.js'))}`)
console.log(`client.js sha256 = ${sha256(join(pkgDir, 'client.js'))}`)
if (fails.length) {
  console.error('CONTRACT FAILED:')
  for (const f of fails) console.error(' - ' + f)
  process.exit(1)
}
console.log('CONTRACT OK')
