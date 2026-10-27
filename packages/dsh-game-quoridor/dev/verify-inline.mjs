/* =========================================================================
 * client.js 内联引擎完整性验证
 * -------------------------------------------------------------------------
 * 1) 用锚点从 ../client.js 抽取内联引擎块，必须与 ../engine.js 逐字节相等：
 *      /* >>> DSH INLINE ENGINE BEGIN ... >>> *\/
 *      /* <<< DSH INLINE ENGINE END <<< *\/
 *    两个锚点必须各恰好出现一次、BEGIN 在 END 之前。
 * 2) 在假 window 环境（测试探针开关 + __ModuleLoader__.load 捕获 +
 *    localStorage/document/ResizeObserver/timer/devicePixelRatio stub）下，
 *    用 node:vm 执行整份 client.js，断言测试探针暴露的
 *    window.__DSH_GAME_QUORIDOR__.Q 是完整引擎 API，并用它跑规则断言：
 *      - newState 后红方 legalMoves = 3；
 *      - 三面围死时最后一堵墙 tryPlaceWall = false；
 *      - 水平撞子直跳、对方身后有墙时斜跳各一例。
 *
 * 复跑：  node dev/verify-inline.mjs
 * 只读：  本脚本不写任何文件。
 * =========================================================================*/
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const CLIENT_PATH = path.join(PKG_DIR, 'client.js');
const ENGINE_PATH = path.join(PKG_DIR, 'engine.js');

const BEGIN_ANCHOR = '/* >>> DSH INLINE ENGINE BEGIN';
const END_ANCHOR = '/* <<< DSH INLINE ENGINE END';

/* ---------------------------- 测试框架 ---------------------------- */
let pass = 0, fail = 0;
let curGroup = null;
function group(name) {
  finishGroup();
  curGroup = { name, p0: pass, f0: fail };
  console.log('\n== ' + name + ' ==');
}
function finishGroup() {
  if (!curGroup) return;
  console.log(`-- ${curGroup.name}: ${pass - curGroup.p0} 通过, ${fail - curGroup.f0} 失败`);
  curGroup = null;
}
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + msg); }
}
function countOccurrences(text, needle) {
  let n = 0, i = -1;
  while ((i = text.indexOf(needle, i + 1)) !== -1) n++;
  return n;
}

/* ===================================================================== */
group('锚点抽取 + 内联块逐字节比对');
const engineBuf = readFileSync(ENGINE_PATH);
const engineSha = createHash('sha256').update(engineBuf).digest('hex').toUpperCase();
const clientBuf = readFileSync(CLIENT_PATH);
const clientText = clientBuf.toString('utf8');

const beginCount = countOccurrences(clientText, BEGIN_ANCHOR);
const endCount = countOccurrences(clientText, END_ANCHOR);
ok(beginCount === 1, `BEGIN 锚点应恰好出现 1 次，实际 ${beginCount} 次`);
ok(endCount === 1, `END 锚点应恰好出现 1 次，实际 ${endCount} 次`);

const beginIdx = clientText.indexOf(BEGIN_ANCHOR);
const endIdx = clientText.indexOf(END_ANCHOR);
ok(beginIdx >= 0 && endIdx > beginIdx, `锚点顺序错误: BEGIN=${beginIdx} END=${endIdx}`);

const anchorLineEnd = clientText.indexOf('\n', beginIdx);
ok(anchorLineEnd > beginIdx, 'BEGIN 锚点行没有换行符');
const inlineText = anchorLineEnd > beginIdx ? clientText.slice(anchorLineEnd + 1, endIdx) : '';
const inlineBuf = Buffer.from(inlineText, 'utf8');
const inlineSha = createHash('sha256').update(inlineBuf).digest('hex').toUpperCase();

ok(inlineBuf.length === engineBuf.length,
  `内联块字节数 ${inlineBuf.length} != engine.js ${engineBuf.length}`);
ok(Buffer.compare(inlineBuf, engineBuf) === 0,
  `内联块与 engine.js 不是逐字节相等（内联 sha=${inlineSha} 引擎 sha=${engineSha}）`);
console.log(`  内联块: ${inlineBuf.length} bytes  sha256=${inlineSha}`);
console.log(`  engine.js: ${engineBuf.length} bytes  sha256=${engineSha}`);

/* ===================================================================== */
group('假 window 环境下执行 client.js');
const memoryStorage = (() => {
  const map = new Map();
  return {
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    get length() { return map.size; }
  };
})();

const documentStub = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    return {
      style: {},
      setAttribute() {},
      getContext() { return null; },
      addEventListener() {},
      removeEventListener() {},
      remove() {},
      appendChild() {}
    };
  },
  body: { appendChild() {} }
};

const windowObj = {
  __DSH_GAME_QUORIDOR_TEST__: true,
  localStorage: memoryStorage,
  document: documentStub,
  devicePixelRatio: 1,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  addEventListener() {},
  removeEventListener() {},
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  performance: { now: () => Date.now() }
};
let capturedModule = null;
windowObj.__ModuleLoader__ = {
  load(def) { capturedModule = def; }
};
windowObj.window = windowObj;

const sandbox = {
  window: windowObj,
  document: documentStub,
  localStorage: memoryStorage,
  performance: windowObj.performance,
  console,
  setTimeout,
  clearTimeout,
  ResizeObserver: windowObj.ResizeObserver,
  devicePixelRatio: 1
};
createContext(sandbox);

let execError = null;
try {
  runInContext(clientText, sandbox, { filename: CLIENT_PATH });
} catch (e) {
  execError = e;
}
ok(execError === null, `执行 client.js 抛错: ${execError && (execError.stack || execError.message)}`);
if (execError) {
  finishGroup();
  console.log(`\n总结果：${pass} 通过，${fail} 失败`);
  console.log('结论：失败 —— client.js 无法在假 window 环境执行');
  process.exitCode = 1;
  process.exit();
}

const probe = windowObj.__DSH_GAME_QUORIDOR__;
ok(!!probe, 'window.__DSH_GAME_QUORIDOR__ 不存在（测试探针未安装）');
ok(!!probe && !!probe.Q, 'window.__DSH_GAME_QUORIDOR__.Q 不存在');
ok(capturedModule && capturedModule.id === '@local/dsh-game-quoridor',
  `__ModuleLoader__.load 未被调用或 id 不符: ${capturedModule && capturedModule.id}`);
ok(capturedModule && typeof capturedModule.factory === 'function',
  '__ModuleLoader__.load 传入的 factory 不是函数');
ok(windowObj.Q === undefined, '内联引擎执行后没有还原 window.Q（污染全局）');

const Q = probe && probe.Q;

/* ===================================================================== */
group('Q 完整引擎 API');
if (!Q) {
  ok(false, '没有 Q，无法检查 API');
} else {
  const FUNC_NAMES = [
    'newState', 'cloneState', 'legalMoves', 'pawnMoves', 'canStepIn',
    'wallFits', 'tryPlaceWall', 'fillDist', 'distOf', 'distanceToGoal',
    'blockedBetween', 'adjacent', 'applyMove', 'undoMove', 'rehash',
    'encodeWall', 'decodeMove', 'rOf', 'cOf', 'idx', 'oth', 'clamp',
    'chooseMove'
  ];
  const OTHER_NAMES = [
    'DIFFICULTY', 'Game', 'TUNE',
    'N', 'NW', 'H', 'V', 'RED', 'BLUE', 'GOAL_ROW', 'START', 'MAX_WALLS', 'INF', 'WIN'
  ];
  for (const name of FUNC_NAMES) {
    ok(typeof Q[name] === 'function', `Q.${name} 不是函数（typeof=${typeof Q[name]}）`);
  }
  for (const name of OTHER_NAMES) {
    ok(Q[name] !== undefined && Q[name] !== null, `Q.${name} 缺失`);
  }
  /* 关键常量/结构的形状 */
  if (Q) {
    ok(Q.N === 9 && Q.NW === 8 && Q.MAX_WALLS === 10, 'N/NW/MAX_WALLS 常量错误');
    ok(Q.H === 0 && Q.V === 1 && Q.RED === 0 && Q.BLUE === 1, 'H/V/RED/BLUE 常量错误');
    ok(Array.isArray(Q.GOAL_ROW) && Q.GOAL_ROW[0] === 0 && Q.GOAL_ROW[1] === 8, 'GOAL_ROW 错误');
    ok(Array.isArray(Q.START) && Q.START[0] === 76 && Q.START[1] === 4, 'START 错误');
    ok(Q.INF === 1e9 && Q.WIN === 1e6, 'INF/WIN 常量错误');
    ok(typeof Q.Game === 'function' && typeof Q.DIFFICULTY === 'object', 'Game/DIFFICULTY 类型错误');
    ok(new Q.Game() instanceof Q.Game, 'new Q.Game() 不是 Game 实例');
  }
}

/* ===================================================================== */
group('内联引擎规则断言（通过 client.js 暴露的 Q）');
if (!Q) {
  ok(false, '没有 Q，无法跑规则断言');
} else {
  /* 1) 开局红方 legalMoves = 3 */
  const st = Q.newState();
  const redMoves = Q.legalMoves(st, Q.RED).slice().sort((a, b) => a - b);
  const mv = (r, c) => r * 9 + c;
  ok(redMoves.length === 3, `开局红方应有 3 个落点，实际 ${redMoves.length}`);
  ok(redMoves.includes(mv(7, 4)) && redMoves.includes(mv(8, 3)) && redMoves.includes(mv(8, 5)),
    `开局红方落点错误: ${JSON.stringify(redMoves)}`);
  const blueMoves = Q.legalMoves(st, Q.BLUE);
  ok(blueMoves.length === 3 && blueMoves.includes(mv(1, 4)), '开局蓝方落点错误');

  /* 2) 三面围死：最后一堵墙必须被拒绝（且不是几何冲突） */
  const enc = Q.newState();
  enc.pawn[Q.RED] = Q.idx(3, 3);
  enc.pawn[Q.BLUE] = 0;                     // 蓝在 (0,0)，不影响红方包围
  enc.hw[2 * 8 + 2] = 1;                    // 上 H(2,2)
  enc.hw[3 * 8 + 3] = 1;                    // 下 H(3,3)
  enc.vw[3 * 8 + 2] = 1;                    // 左 V(3,2)
  ok(Q.distanceToGoal(enc, Q.RED) === 4,
    `三面被围时红方到终点应为 4 步，实际 ${Q.distanceToGoal(enc, Q.RED)}`);
  ok(Q.wallFits(enc, Q.V, 2, 3) === true, 'V(2,3) 几何上应可放（不是重叠/交叉问题）');
  ok(Q.tryPlaceWall(enc, Q.V, 2, 3, Q.RED) === false, '把红方彻底封死的最后一堵墙应被拒绝');
  enc.turn = Q.BLUE;
  ok(Q.tryPlaceWall(enc, Q.V, 2, 3, Q.BLUE) === false, '换成蓝方放同一堵墙也应被拒绝');

  /* 3) 水平撞子：直跳 */
  const jump = Q.newState();
  jump.pawn[Q.RED] = Q.idx(4, 4);
  jump.pawn[Q.BLUE] = Q.idx(4, 5);
  const jm = Q.legalMoves(jump, Q.RED);
  ok(jm.includes(Q.idx(4, 6)), `水平撞子应能直跳到 (4,6)，实际 ${JSON.stringify(jm.sort((a, b) => a - b))}`);
  ok(!jm.includes(Q.idx(4, 5)), '不能走到对方棋子的格子上');

  /* 4) 对方身后有墙：斜跳 */
  const diag = Q.newState();
  diag.pawn[Q.RED] = Q.idx(4, 4);
  diag.pawn[Q.BLUE] = Q.idx(4, 5);
  diag.vw[4 * 8 + 5] = 1;                   // V(4,5) 挡住蓝方身后的 (4,6)
  const dm = Q.legalMoves(diag, Q.RED);
  ok(!dm.includes(Q.idx(4, 6)), '对方身后有墙时不能直跳');
  ok(dm.includes(Q.idx(3, 5)) && dm.includes(Q.idx(5, 5)),
    `对方身后有墙时应能斜跳到 (3,5)/(5,5)，实际 ${JSON.stringify(dm.sort((a, b) => a - b))}`);
}

/* ===================================================================== */
finishGroup();
console.log(`\nclient.js：${CLIENT_PATH} (${clientBuf.length} bytes)`);
console.log(`engine.js：${ENGINE_PATH} (${engineBuf.length} bytes, sha256=${engineSha})`);
console.log(`\n总结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('结论：失败 —— client.js 内联引擎与 engine.js 不一致或行为异常');
  process.exitCode = 1;
} else {
  console.log('结论：全部通过 —— 内联块与 engine.js 逐字节相等，暴露的 Q 行为正常');
  process.exitCode = 0;
}
