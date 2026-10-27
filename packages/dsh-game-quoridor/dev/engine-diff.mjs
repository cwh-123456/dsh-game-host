/* =========================================================================
 * 源实现 vs 交付包内 engine.js 的逐项行为对拍
 * -------------------------------------------------------------------------
 * 两个独立 vm context 分别加载：
 *   A = 源实现   D:\desktop_files\artificial_intelligence\games_ai\墙棋\engine.js
 *   B = 交付包   packages/dsh-game-quoridor/engine.js
 * 独立 context 保证模块级可变状态（PM/DMAP/SEEN/Q 暂存区、Zobrist、TT、
 * GEN 计数）完全隔离，不会因为共享缓存而掩盖差异。
 *
 * 对每个随机合法局面（0-14 面墙、双方棋子可达各自终点）逐项深比较：
 *   legalMoves / tryPlaceWall 全 128 墙位 / distOf 全 81 格 × 2 终点 /
 *   distanceToGoal / encodeWall / decodeMove / applyMove 后的完整状态 /
 *   undoMove 后是否完全还原 / 确定性配置下 chooseMove 的 mv、score 等。
 *
 * 复跑：  node dev/engine-diff.mjs
 * 只读：  本脚本不写任何文件。
 * =========================================================================*/
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ENGINE = path.resolve(HERE, '..', 'engine.js');
const SRC_ENGINE = 'D:/desktop_files/artificial_intelligence/games_ai/墙棋/engine.js';

const POSITIONS = 60;
const CHOOSE_POSITIONS = 20;          // chooseMove 对比至少 20 个局面
const CHOOSE_CFG = { timeMs: 1e9, maxDepth: 2, wallLimit: 999, blunder: 0, noise: 0 };

/* ---------------------------- 读取两个引擎 ---------------------------- */
function readEngine(p, label) {
  try {
    const buf = readFileSync(p);
    return {
      path: p,
      text: buf.toString('utf8'),
      bytes: buf.length,
      sha: createHash('sha256').update(buf).digest('hex').toUpperCase(),
      label
    };
  } catch (e) {
    console.error(`✗ 读取${label}失败: ${p}\n  ${e.message}`);
    process.exit(1);
  }
}
const src = readEngine(SRC_ENGINE, '源实现');
const pkg = readEngine(PKG_ENGINE, '交付包');

console.log(`源实现：${src.path}`);
console.log(`          sha256=${src.sha} bytes=${src.bytes}`);
console.log(`交付包：${pkg.path}`);
console.log(`          sha256=${pkg.sha} bytes=${pkg.bytes}`);

/* ---------------------------- 独立 context 加载 ---------------------------- */
function loadEngine(engineInfo, label) {
  /* performance.now 固定为 0：chooseMove 的 timeMs=1e9 本来也不会超时，
   * 冻结时钟只是去掉机器快慢带来的非确定性，让对拍可复现。 */
  const sandbox = {
    module: { exports: {} },
    console,
    performance: { now: () => 0 }
  };
  createContext(sandbox);
  runInContext(engineInfo.text, sandbox, { filename: engineInfo.path });
  const Q = sandbox.Q || (sandbox.module && sandbox.module.exports);
  if (!Q || typeof Q.newState !== 'function' || typeof Q.chooseMove !== 'function') {
    console.error(`✗ ${label} engine.js 未导出 Q`);
    process.exit(1);
  }
  return Q;
}
const QA = loadEngine(src, '源实现');
const QB = loadEngine(pkg, '交付包');

/* ---------------------------- 计数与输出 ---------------------------- */
let checks = 0, diffs = 0;
const firstDiffs = [];
const MAX_PRINTED = 20;
function cmp(cond, tag, detail) {
  checks++;
  if (cond) return;
  diffs++;
  const line = `  ✗ [${tag}] ${detail}`;
  if (firstDiffs.length < MAX_PRINTED) { firstDiffs.push(line); console.log(line); }
}
function eqArray(a, b, tag) {
  cmp(a.length === b.length && a.every((v, i) => v === b[i]), tag,
    `长度/内容不同: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
}
function proj(st) {
  return [st.pawn[0], st.pawn[1], st.walls[0], st.walls[1],
    Array.from(st.hw), Array.from(st.vw), st.turn, st.h1, st.h2];
}
function projJSON(st) { return JSON.stringify(proj(st)); }
function cmpState(a, b, tag) {
  const fields = [
    ['pawn[0]', a.pawn[0], b.pawn[0]],
    ['pawn[1]', a.pawn[1], b.pawn[1]],
    ['walls[0]', a.walls[0], b.walls[0]],
    ['walls[1]', a.walls[1], b.walls[1]],
    ['hw', Array.from(a.hw), Array.from(b.hw)],
    ['vw', Array.from(a.vw), Array.from(b.vw)],
    ['turn', a.turn, b.turn],
    ['h1', a.h1, b.h1],
    ['h2', a.h2, b.h2]
  ];
  for (const [name, va, vb] of fields) {
    const equal = (va && va.length !== undefined)
      ? (va.length === vb.length && va.every((v, i) => v === vb[i]))
      : va === vb;
    cmp(equal, tag, `${name} 不同: A=${JSON.stringify(va)} B=${JSON.stringify(vb)}`);
  }
}

/* ---------------------------- 固定种子 PRNG ---------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------- 局面构造 ---------------------------- */
/* 用 A（源实现）的 wallFits + 双方可达性构造局面；结构体用宿主 realm 的
 * Uint8Array，之后每个引擎各自 cloneState 一份再操作。 */
function freshState() {
  return {
    pawn: [76, 4],                       // START: 红(8,4)=76, 蓝(0,4)=4
    walls: [10, 10],
    hw: new Uint8Array(64),
    vw: new Uint8Array(64),
    turn: 0,
    h1: 0, h2: 0
  };
}
function buildPosition(rnd) {
  const st = freshState();
  const targetWalls = Math.floor(rnd() * 15);        // 0..14 面墙
  let placed = 0, guard = 0;
  while (placed < targetWalls && guard++ < 600) {
    const o = rnd() < 0.5 ? 0 : 1;
    const r = Math.floor(rnd() * 8);
    const c = Math.floor(rnd() * 8);
    if (!QA.wallFits(st, o, r, c)) continue;
    const arr = o === 0 ? st.hw : st.vw;
    arr[r * 8 + c] = 1;
    const d0 = QA.distOf(st, 0, st.pawn[0]);
    const d1 = QA.distOf(st, 8, st.pawn[1]);
    if (d0 >= QA.INF || d1 >= QA.INF) { arr[r * 8 + c] = 0; continue; }  // 不能封死
    placed++;
  }
  /* 随机棋子：不同格、不在自己的终点行（避免已分胜负）、双方都能到终点 */
  let p0 = -1, p1 = -1, tries = 0, okPawns = false;
  while (!okPawns && tries++ < 500) {
    p0 = Math.floor(rnd() * 81);
    p1 = Math.floor(rnd() * 81);
    if (p0 === p1) continue;
    if (QA.rOf(p0) === 0 || QA.rOf(p1) === 8) continue;      // 不在自家终点行
    st.pawn[0] = p0; st.pawn[1] = p1;
    okPawns = QA.distOf(st, 0, p0) < QA.INF && QA.distOf(st, 8, p1) < QA.INF;
  }
  if (!okPawns) throw new Error('无法构造合法棋子位置');
  st.turn = rnd() < 0.5 ? 0 : 1;
  QA.rehash(st);
  return { st, nWalls: placed };
}
const rnd = mulberry32(0x9E3779B9);

/* ---------------------------- 对拍主循环 ---------------------------- */
console.log(`\n对拍 ${POSITIONS} 个随机合法局面 ...`);
const numcmp = (x, y) => x - y;

for (let i = 0; i < POSITIONS; i++) {
  const { st, nWalls } = buildPosition(rnd);
  const tag = `#${i}(${nWalls}墙 turn=${st.turn} 红@${st.pawn[0]} 蓝@${st.pawn[1]})`;

  const sA = QA.cloneState(st);
  const sB = QB.cloneState(st);
  cmpState(sA, sB, `${tag} cloneState`);

  /* 1) legalMoves（排序后） */
  for (const side of [0, 1]) {
    const a = QA.legalMoves(sA, side).slice().sort(numcmp);
    const b = QB.legalMoves(sB, side).slice().sort(numcmp);
    eqArray(a, b, `${tag} legalMoves(${side})`);
  }

  /* 2) distOf 全 81 格 × 两个终点 */
  for (const goal of [0, 8]) {
    for (let cell = 0; cell < 81; cell++) {
      const a = QA.distOf(sA, goal, cell);
      const b = QB.distOf(sB, goal, cell);
      cmp(a === b, `${tag} distOf(goal=${goal},cell=${cell})`, `A=${a} B=${b}`);
    }
  }
  /* 3) distanceToGoal 双方 */
  for (const side of [0, 1]) {
    const a = QA.distanceToGoal(sA, side);
    const b = QB.distanceToGoal(sB, side);
    cmp(a === b, `${tag} distanceToGoal(${side})`, `A=${a} B=${b}`);
  }

  /* 4) tryPlaceWall 全部 128 墙位（当前行动方） */
  for (let o = 0; o < 2; o++) for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const a = QA.tryPlaceWall(sA, o, r, c, sA.turn);
    const b = QB.tryPlaceWall(sB, o, r, c, sB.turn);
    cmp(a === b, `${tag} tryPlaceWall(${o},${r},${c})`, `A=${a} B=${b}`);
  }

  /* 5) encodeWall 全部 128 墙位 + decodeMove 全部 209 个走法编码 */
  for (let o = 0; o < 2; o++) for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const a = QA.encodeWall(o, r, c);
    const b = QB.encodeWall(o, r, c);
    cmp(a === b, `${tag} encodeWall(${o},${r},${c})`, `A=${a} B=${b}`);
  }
  for (let m = 0; m < 209; m++) {
    const a = JSON.stringify(QA.decodeMove(m));
    const b = JSON.stringify(QB.decodeMove(m));
    cmp(a === b, `${tag} decodeMove(${m})`, `A=${a} B=${b}`);
  }

  /* 6) applyMove 后完整状态 + undoMove 完全还原
   *    走法集合：当前方全部合法走子 + 前 4 个合法墙位（确定性） */
  const testMoves = [
    ...QA.legalMoves(sA, sA.turn).slice().sort(numcmp)
  ];
  let wallsPicked = 0;
  for (let o = 0; o < 2 && wallsPicked < 4; o++) {
    for (let r = 0; r < 8 && wallsPicked < 4; r++) {
      for (let c = 0; c < 8 && wallsPicked < 4; c++) {
        if (QA.tryPlaceWall(sA, o, r, c, sA.turn)) {
          testMoves.push(QA.encodeWall(o, r, c));
          wallsPicked++;
        }
      }
    }
  }
  for (const m of testMoves) {
    const a = QA.cloneState(st);
    const b = QB.cloneState(st);
    const before = projJSON(a);
    const tokA = QA.applyMove(a, m, sA.turn);
    const tokB = QB.applyMove(b, m, sB.turn);
    cmp(tokA === tokB, `${tag} applyMove(${m}) token`, `A=${tokA} B=${tokB}`);
    cmpState(a, b, `${tag} applyMove(${m}) 后状态`);
    QA.undoMove(a, m, sA.turn, tokA);
    QB.undoMove(b, m, sB.turn, tokB);
    cmpState(a, b, `${tag} undoMove(${m}) 后状态`);
    cmp(projJSON(a) === before, `${tag} undoMove(${m}) 还原`, 'undo 后与 apply 前不一致（A）');
  }

  /* 7) 确定性配置下 chooseMove 对拍（可选前 CHOOSE_POSITIONS 个局面） */
  if (i < CHOOSE_POSITIONS) {
    const ca = QA.cloneState(st);
    const cb = QB.cloneState(st);
    const ra = QA.chooseMove(ca, CHOOSE_CFG);
    const rb = QB.chooseMove(cb, CHOOSE_CFG);
    if (!ra || !rb) {
      cmp(!!ra === !!rb, `${tag} chooseMove 返回空`, `A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`);
    } else {
      cmp(ra.mv === rb.mv, `${tag} chooseMove mv`, `A=${ra.mv} B=${rb.mv}`);
      cmp(ra.score === rb.score, `${tag} chooseMove score`, `A=${ra.score} B=${rb.score}`);
      cmp(ra.depth === rb.depth, `${tag} chooseMove depth`, `A=${ra.depth} B=${rb.depth}`);
      cmp(ra.nodes === rb.nodes, `${tag} chooseMove nodes`, `A=${ra.nodes} B=${rb.nodes}`);
    }
  }
}

/* ---------------------------- 汇总 ---------------------------- */
console.log(`\n比较项：${checks}    差异：${diffs}`);
if (diffs > 0) {
  if (diffs > firstDiffs.length) console.log(`（仅列出前 ${firstDiffs.length} 条差异，共 ${diffs} 条）`);
  console.log('结论：失败 —— 源实现与包内 engine.js 行为不一致');
  process.exitCode = 1;
} else if (src.sha !== pkg.sha) {
  console.log('结论：失败 —— 行为一致但文件字节不一致（见上方 sha256）');
  process.exitCode = 1;
} else {
  console.log('结论：全部一致 —— 包内 engine.js 与源实现逐项行为相同、字节相同');
  process.exitCode = 0;
}
