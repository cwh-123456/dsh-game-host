/* =========================================================================
 * Quoridor 引擎验证套件（移植自原版四个测试脚本 + 原版 48 条断言）
 * -------------------------------------------------------------------------
 * 目的：独立证明交付包 packages/dsh-game-quoridor/engine.js 是原实现的
 *       「原样复用」——文件字节哈希一致，且原版测试全部通过。
 *
 * 加载方式：包内 package.json 是 "type":"module"，engine.js 不能用 require，
 * 因此这里用 fs 读源码 + node:vm 在独立 context 中执行，拿到 Q。
 *
 * 复跑：  node dev/engine-tests.mjs
 * 只读：  本脚本不写任何文件。
 * =========================================================================*/
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const ENGINE_PATH = path.join(PKG_DIR, 'engine.js');

const EXPECTED_SHA256 = '82F3E095BD81263A986915DAC24DFBD4A770B125C65E6515FAF791421F292B6E';
const EXPECTED_BYTES = 22103;

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
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg); }
}
/* 与 verify_rules_text.js 的 eq 同语义 */
function eq(claim, got, want) {
  const equal = JSON.stringify(got) === JSON.stringify(want);
  ok(equal, `「${claim}」引擎实际: ${JSON.stringify(got)}  期望: ${JSON.stringify(want)}`);
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
const SEED = 0xC0FFEE;
const rand = mulberry32(SEED);          // fuzz / search 局面构造用
const engineRand = mulberry32(0x5EED);  // 注入给引擎，让自对弈可复现

/* ---------------------------- 加载引擎 ---------------------------- */
const engineBytes = readFileSync(ENGINE_PATH);
const engineText = engineBytes.toString('utf8');
const engineSha = createHash('sha256').update(engineBytes).digest('hex').toUpperCase();

/* 确定性 sandbox：Math.random 换成固定种子；performance.now 固定为 0，
 * 让 chooseMove 不会因为机器快慢在中途超时（深度上限仍然生效），
 * 这样自对弈 / 搜索对拍可以完全复现。 */
function loadEngine() {
  const seededMath = Object.create(Math);
  seededMath.random = engineRand;
  const sandbox = {
    module: { exports: {} },
    console,
    Math: seededMath,
    performance: { now: () => 0 }
  };
  createContext(sandbox);
  runInContext(engineText, sandbox, { filename: ENGINE_PATH });
  const Q = sandbox.Q || (sandbox.module && sandbox.module.exports);
  if (!Q || typeof Q.chooseMove !== 'function' || typeof Q.newState !== 'function') {
    throw new Error('engine.js 在 vm sandbox 中未导出 Q');
  }
  return Q;
}

const Q = loadEngine();
const { H, V, RED, BLUE } = Q;
const mv = (r, c) => r * 9 + c;
const setPawn = (st, s, r, c) => { st.pawn[s] = mv(r, c); };

/* ===================================================================== */
group('engine.js 完整性（SHA-256 / 字节数）');
ok(engineSha === EXPECTED_SHA256, `sha256 与基线不一致: ${engineSha} != ${EXPECTED_SHA256}`);
ok(engineBytes.length === EXPECTED_BYTES, `字节数与基线不一致: ${engineBytes.length} != ${EXPECTED_BYTES}`);

/* ===================================================================== */
/* 移植 test_engine.js（原版 48 条断言）                                  */
/* ===================================================================== */

/* ---------- 1. 基本走子 ---------- */
group('基本走子');
{
  const st = Q.newState();
  let m = Q.legalMoves(st, RED).sort((a, b) => a - b);
  ok(m.length === 3, '开局红方应有 3 个落点，实际 ' + m.length);
  ok(m.includes(mv(7, 4)) && m.includes(mv(8, 3)) && m.includes(mv(8, 5)), '开局落点错误');
  m = Q.legalMoves(st, BLUE);
  ok(m.length === 3 && m.includes(mv(1, 4)), '开局蓝方落点错误');

  st.hw[7 * 8 + 4] = 1;
  m = Q.legalMoves(st, RED);
  ok(!m.includes(mv(7, 4)), '被墙挡住后不应能上走');
  ok(m.length === 2, '被挡后应只剩 2 个落点，实际 ' + m.length);
  st.hw[7 * 8 + 4] = 0;
}

/* ---------- 2. 跳子 ---------- */
group('跳子');
{
  const st = Q.newState();
  setPawn(st, RED, 4, 4);
  setPawn(st, BLUE, 4, 5);
  let m = Q.legalMoves(st, RED);
  ok(m.includes(mv(4, 6)), '应能直线跳过对方到 (4,6)');
  ok(!m.includes(mv(4, 5)), '不能走到对方格子上');

  st.vw[4 * 8 + 5] = 1;
  m = Q.legalMoves(st, RED);
  ok(!m.includes(mv(4, 6)), '身后有墙时不能直线跳');
  ok(m.includes(mv(3, 5)) && m.includes(mv(5, 5)), '应能斜跳到 (3,5)/(5,5)');
  ok(m.includes(mv(4, 3)), '向左走仍应合法');

  st.vw[4 * 8 + 4] = 1;
  m = Q.legalMoves(st, RED);
  ok(!m.includes(mv(4, 5)) && !m.includes(mv(3, 5)), '与对方之间有墙时不能跳');
}

/* ---------- 3. 墙的重叠 / 交叉 ---------- */
group('墙的几何约束');
{
  const st = Q.newState();
  ok(Q.wallFits(st, H, 4, 4), 'H(4,4) 空盘应可放');
  st.hw[4 * 8 + 3] = 1;
  ok(!Q.wallFits(st, H, 4, 4), 'H(4,3) 与 H(4,4) 重叠，应非法');
  st.hw[4 * 8 + 3] = 0;
  st.vw[4 * 8 + 4] = 1;
  ok(!Q.wallFits(st, H, 4, 4), 'V(4,4) 与 H(4,4) 十字交叉，应非法');
  ok(Q.wallFits(st, H, 3, 4), 'H(3,4) 与 V(4,4) 只是 T 形相接，应合法');
  ok(Q.wallFits(st, H, 4, 5), 'H(4,5) 与 V(4,4) 只是端点相接，应合法');
  st.vw[4 * 8 + 4] = 0;
  st.vw[3 * 8 + 4] = 1;
  ok(!Q.wallFits(st, V, 4, 4), 'V(3,4) 与 V(4,4) 重叠，应非法');
}

/* ---------- 4. 不能封死任何一方 ---------- */
group('封路检查');
{
  const st = Q.newState();
  setPawn(st, RED, 3, 3);
  setPawn(st, BLUE, 0, 0);
  st.hw[2 * 8 + 2] = 1;
  st.hw[3 * 8 + 3] = 1;
  st.vw[3 * 8 + 2] = 1;
  ok(Q.distanceToGoal(st, RED) === 4,
    '三面被围时红应还能往右绕 4 步，实际 ' + Q.distanceToGoal(st, RED));
  ok(Q.wallFits(st, V, 2, 3), 'V(2,3) 本身没有几何冲突');
  ok(!Q.tryPlaceWall(st, V, 2, 3, RED), '把红方彻底封死应非法');
  st.turn = BLUE;
  ok(!Q.tryPlaceWall(st, V, 2, 3, BLUE), '封死对方同样非法，与谁放墙无关');

  const st2 = Q.newState();
  setPawn(st2, RED, 3, 3);
  setPawn(st2, BLUE, 0, 0);
  st2.hw[2 * 8 + 2] = 1;
  st2.hw[3 * 8 + 3] = 1;
  ok(Q.tryPlaceWall(st2, V, 3, 2, RED), '只堵三面应合法');
}

/* ---------- 5. 走子 / 悔棋 一致 ---------- */
group('走子与悔棋');
{
  const g = new Q.Game();
  const snap = () => JSON.stringify([g.st.pawn, g.st.walls, Array.from(g.st.hw), Array.from(g.st.vw), g.st.turn, g.st.h1, g.st.h2]);
  const s0 = snap();
  ok(g.play(mv(7, 4)), '红方向上走一步');
  ok(g.st.turn === BLUE, '应轮到蓝方');
  ok(g.play(Q.encodeWall(H, 3, 4)), '蓝方放一道横墙');
  ok(g.st.walls[BLUE] === 9, '蓝方墙数应为 9');
  ok(g.play(mv(6, 4)), '红方再向上走一步');
  ok(g.st.pawn[RED] === mv(6, 4), '红方应在 (6,4)');
  ok(!g.play(Q.encodeWall(H, 3, 3)), '与已有墙重叠的墙应被拒绝');
  ok(g.undo() && g.undo() && g.undo(), '连悔三步');
  ok(snap() === s0, '悔棋后状态应完全还原');
  ok(g.play(-5) === false, '非法走法应被拒绝');
}

/* ---------- 6. 自对弈：不出错、能分出胜负 ---------- */
group('自对弈（12 局，固定种子）');
{
  let total = 0, plys = [], wallUse = [];
  const GAMES = 12;
  for (let t = 0; t < GAMES; t++) {
    const g = new Q.Game();
    let ply = 0;
    const diff = t % 2 === 0 ? 1 : 2;
    while (!g.over && ply < 300) {
      const res = Q.chooseMove(g.st, Q.DIFFICULTY[diff]);
      if (!res) { ok(false, 'AI 没有返回走法'); break; }
      if (!g.play(res.mv)) { ok(false, 'AI 返回了非法走法 ' + res.mv); break; }
      ply++;
    }
    ok(g.over, '第 ' + t + ' 局应在 300 手内结束（实际 ' + ply + '）');
    total += ply; plys.push(ply);
    wallUse.push(10 - g.st.walls[0] + 10 - g.st.walls[1]);
  }
  console.log('  平均手数: ' + (total / GAMES).toFixed(1) + '   最少/最多: '
    + Math.min(...plys) + '/' + Math.max(...plys));
  console.log('  平均用墙: ' + (wallUse.reduce((a, b) => a + b, 0) / GAMES).toFixed(1) + ' 面');
}

/* ---------- 7. AI 速度（信息输出，不是判据） ---------- */
group('AI 耗时（中局，信息输出）');
{
  const g = new Q.Game();
  for (let i = 0; i < 8; i++) {
    const r = Q.chooseMove(g.st, Q.DIFFICULTY[2]);
    g.play(r.mv);
  }
  for (const d of [1, 2, 3]) {
    const st = Q.cloneState(g.st); Q.rehash(st);
    const cfg = Object.assign({}, Q.DIFFICULTY[d], { blunder: 0 });
    const t0 = Date.now();
    const r = Q.chooseMove(st, cfg);
    const dt = Date.now() - t0;
    ok(!!r && r.mv >= 0, '难度 ' + d + ' chooseMove 应返回走法');
    console.log(`  难度${d}: ${dt}ms  深度=${r.depth}  节点=${r.nodes}  评分=${r.score}`);
  }
}

/* ---------- 8. 必胜局面 ---------- */
group('残局判断');
{
  const g = new Q.Game();
  setPawn(g.st, RED, 1, 4);
  setPawn(g.st, BLUE, 8, 0);
  const r = Q.chooseMove(g.st, Q.DIFFICULTY[2]);
  ok(r.mv === mv(0, 4), '红应直接走上终点(0,4)，实际走了 ' + JSON.stringify(Q.decodeMove(r.mv)));

  const g2 = new Q.Game();
  setPawn(g2.st, RED, 8, 8);
  setPawn(g2.st, BLUE, 7, 4);
  g2.st.turn = RED;
  ok(Q.distanceToGoal(g2.st, BLUE) === 1, '蓝方此时应只差一步');
  const r2 = Q.chooseMove(g2.st, Q.DIFFICULTY[3]);
  const d = Q.decodeMove(r2.mv);
  ok(d.t === 'wall', '红方必须放墙封堵，实际 ' + JSON.stringify(d));
  const st2 = Q.cloneState(g2.st);
  Q.applyMove(st2, r2.mv, RED);
  ok(Q.distanceToGoal(st2, BLUE) > 1, '封堵后蓝方到终点应大于 1 步，实际 ' + Q.distanceToGoal(st2, BLUE));
}

/* ===================================================================== */
/* 移植 verify_rules_text.js（26 条规则说明与引擎行为对拍）               */
/* ===================================================================== */
group('规则文案对拍（26 条）');
eq('棋盘 9×9', Q.N, 9);
eq('每人 10 面墙', Q.MAX_WALLS, 10);
eq('红方起点 (8,4)', [Q.rOf(Q.START[0]), Q.cOf(Q.START[0])], [8, 4]);
eq('红方目标第 0 行', Q.GOAL_ROW[Q.RED], 0);
eq('蓝方起点 (0,4)', [Q.rOf(Q.START[1]), Q.cOf(Q.START[1])], [0, 4]);
eq('蓝方目标第 8 行', Q.GOAL_ROW[Q.BLUE], 8);
eq('红方先手', Q.newState().turn, Q.RED);
{
  const st = Q.newState();
  st.pawn[Q.RED] = Q.idx(1, 3);
  const g = new Q.Game();
  g.st = st;
  const okPlay = g.play(Q.idx(0, 3));
  eq('踏上目标行任意一格即获胜', [okPlay, g.over, g.winner], [true, true, Q.RED]);
}
{
  const st = Q.newState();
  st.hw[3 * 8 + 3] = 1;
  eq('H(3,3) 挡住 (3,3)-(4,3)', Q.blockedBetween(st, Q.idx(3, 3), Q.idx(4, 3)), true);
  eq('H(3,3) 挡住 (3,4)-(4,4)', Q.blockedBetween(st, Q.idx(3, 4), Q.idx(4, 4)), true);
  eq('H(3,3) 没挡住 (3,5)-(4,5)', Q.blockedBetween(st, Q.idx(3, 5), Q.idx(4, 5)), false);
}
{
  const st = Q.newState(); st.hw[3 * 8 + 3] = 1;
  eq('同向相邻墙位 hw[3,4] 非法(重叠)', Q.wallFits(st, Q.H, 3, 4), false);
}
{
  const st = Q.newState(); st.hw[3 * 8 + 3] = 1;
  eq('同墙位的竖墙 vw[3,3] 非法(交叉)', Q.wallFits(st, Q.V, 3, 3), false);
}
{
  const st = Q.newState(); st.hw[3 * 8 + 3] = 1;
  eq('隔着两格的 hw[3,5] 合法(首尾相接)', Q.wallFits(st, Q.H, 3, 5), true);
}
{
  const st = Q.newState(); st.hw[3 * 8 + 3] = 1;
  eq('错开墙位的竖墙 vw[3,2] 合法(拐弯)', Q.wallFits(st, Q.V, 3, 2), true);
}
{
  const st = Q.newState();
  st.pawn[Q.RED] = Q.idx(3, 3);
  st.hw[2 * 8 + 2] = 1;
  st.hw[3 * 8 + 3] = 1;
  st.vw[3 * 8 + 2] = 1;
  eq('围死红方的最后一堵墙被拒绝', Q.tryPlaceWall(st, Q.V, 2, 3, Q.BLUE), false);
}
{
  const st = Q.newState();
  st.pawn[Q.RED] = Q.idx(4, 4); st.pawn[Q.BLUE] = Q.idx(3, 4);
  const m = Q.legalMoves(st, Q.RED);
  eq('对手身后没墙时，直跳到 (2,4)', m.indexOf(Q.idx(2, 4)) >= 0, true);
}
{
  const st = Q.newState();
  st.pawn[Q.RED] = Q.idx(4, 4); st.pawn[Q.BLUE] = Q.idx(3, 4);
  st.hw[2 * 8 + 3] = 1;
  const m = Q.legalMoves(st, Q.RED);
  eq('对手身后有墙时，不能直跳到 (2,4)', m.indexOf(Q.idx(2, 4)) >= 0, false);
  eq('此时可以斜跳到 (3,3)', m.indexOf(Q.idx(3, 3)) >= 0, true);
  eq('此时可以斜跳到 (3,5)', m.indexOf(Q.idx(3, 5)) >= 0, true);
}
{
  const st = Q.newState();
  st.pawn[Q.RED] = Q.idx(1, 4); st.pawn[Q.BLUE] = Q.idx(0, 4);
  const m = Q.legalMoves(st, Q.RED);
  eq('对手贴边时可斜跳到 (0,3)', m.indexOf(Q.idx(0, 3)) >= 0, true);
  eq('对手贴边时可斜跳到 (0,5)', m.indexOf(Q.idx(0, 5)) >= 0, true);
}
{
  const st = Q.newState();
  st.pawn[Q.RED] = Q.idx(1, 4); st.pawn[Q.BLUE] = Q.idx(0, 4);
  st.vw[0 * 8 + 3] = 1;
  const m = Q.legalMoves(st, Q.RED);
  eq('有墙时不能斜跳到 (0,3)', m.indexOf(Q.idx(0, 3)) >= 0, false);
  eq('另一侧 (0,5) 不受影响', m.indexOf(Q.idx(0, 5)) >= 0, true);
}
{
  const st = Q.newState();
  const m = Q.legalMoves(st, Q.RED);
  eq('空场时红方只有 3 个落点(上/左/右，下边出界)', m.length, 3);
  eq('落点里没有斜格', m.every(p => Q.adjacent(p, Q.idx(8, 4))), true);
}

/* ===================================================================== */
/* 移植 verify_wallseg.js（128 面墙「两格跨度」反推）                     */
/* ===================================================================== */
group('墙几何跨度（128 面）');
{
  /* 枚举所有相邻格子对，返回被墙挡住的那些边 */
  function blockedEdges(st) {
    const out = [];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      const p = Q.idx(r, c);
      if (r < 8 && Q.blockedBetween(st, p, Q.idx(r + 1, c)))
        out.push({ o: 'vert', line: r + 1, a: c, b: c + 1 });
      if (c < 8 && Q.blockedBetween(st, p, Q.idx(r, c + 1)))
        out.push({ o: 'horz', line: c + 1, a: r, b: r + 1 });
    }
    return out;
  }
  let good = 0, bad = 0;
  for (const o of [Q.H, Q.V]) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const st = Q.newState();
      const arr = o === Q.H ? st.hw : st.vw;
      arr[r * 8 + c] = 1;
      const edges = blockedEdges(st);
      if (edges.length === 0) {
        bad++; ok(false, `墙 ${o ? 'V' : 'H'}(${r},${c}) 没挡住任何边`); continue;
      }
      const key = o === Q.H ? 'vert' : 'horz';
      const same = edges.every(e => e.o === key && e.line === edges[0].line);
      const a = Math.min(...edges.map(e => e.a)), b = Math.max(...edges.map(e => e.b));
      const span = b - a;
      const want = (o === Q.H) ? [r + 1, c, c + 2] : [c + 1, r, r + 2];
      const isGood = same && edges.length === 2 && a === want[1] && b === want[2];
      if (isGood) { good++; ok(true, ''); }
      else {
        bad++;
        ok(false, `${o === Q.H ? 'H' : 'V'}(${r},${c}): 挡了 ${edges.length} 条边, 线=${edges[0].line}, 跨度=[${a},${b}] 期望=[${want[1]},${want[2]}]`);
      }
      if (o === Q.H && r === 3 && c === 3)
        console.log(`  样例 H(3,3): 挡住 ${edges.length} 条边 -> 线段 y=${edges[0].line}, x 从 ${a} 到 ${b}（跨度 ${span} 格）`);
      if (o === Q.V && r === 3 && c === 3)
        console.log(`  样例 V(3,3): 挡住 ${edges.length} 条边 -> 线段 x=${edges[0].line}, y 从 ${a} 到 ${b}（跨度 ${span} 格）`);
    }
  }
  ok(good === 128 && bad === 0, `两格跨度墙应为 128 面，实际 ${good} 面（${bad} 面异常）`);
}

/* ===================================================================== */
/* 移植 fuzz_rules.js（随机参考实现对拍，固定种子 160 局）                */
/* ===================================================================== */
group('fuzz_rules 参考实现对拍（160 局）');
{
  /* ---------- 参考实现：所有遮挡关系用「格子对 -> 集合」直白表示 ---------- */
  function RefBoard() {
    this.blocked = new Set();
    this.pawn = [null, null];
  }
  const key2 = (r1, c1, r2, c2) => {
    if (r1 > r2 || (r1 === r2 && c1 > c2)) { [r1, r2] = [r2, r1]; [c1, c2] = [c2, c1]; }
    return `${r1},${c1}|${r2},${c2}`;
  };
  RefBoard.prototype.place = function (o, r, c) {
    if (o === Q.H) {
      for (const cc of [c, c + 1]) if (r + 1 <= 8) this.blocked.add(key2(r, cc, r + 1, cc));
    } else {
      for (const rr of [r, r + 1]) if (c + 1 <= 8) this.blocked.add(key2(rr, c, rr, c + 1));
    }
  };
  RefBoard.prototype.edgeBlocked = function (r1, c1, r2, c2) {
    return this.blocked.has(key2(r1, c1, r2, c2));
  };
  RefBoard.prototype.dist = function (side, goalRow) {
    const [pr, pc] = this.pawn[side];
    const seen = new Map([[pr * 9 + pc, 0]]);
    let frontier = [[pr, pc]];
    let d = 0;
    if (pr === goalRow) return 0;
    while (frontier.length) {
      d++;
      const next = [];
      for (const [r, c] of frontier) {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
          if (this.edgeBlocked(r, c, nr, nc)) continue;
          const k = nr * 9 + nc;
          if (seen.has(k)) continue;
          if (nr === goalRow) return d;
          seen.set(k, d);
          next.push([nr, nc]);
        }
      }
      frontier = next;
    }
    return Infinity;
  };
  RefBoard.prototype.moves = function (side, other) {
    const [r, c] = this.pawn[side];
    const [orr, orc] = this.pawn[other];
    const out = [];
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (this.edgeBlocked(r, c, nr, nc)) continue;
      if (nr !== orr || nc !== orc) { out.push(nr * 9 + nc); continue; }
      const jr = nr + dr, jc = nc + dc;
      if (jr >= 0 && jr <= 8 && jc >= 0 && jc <= 8 && !this.edgeBlocked(nr, nc, jr, jc)) {
        out.push(jr * 9 + jc);
        continue;
      }
      for (const [qr, qc] of (dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]])) {
        const tr = nr + qr, tc = nc + qc;
        if (tr < 0 || tr > 8 || tc < 0 || tc > 8) continue;
        if (this.edgeBlocked(nr, nc, tr, tc)) continue;
        out.push(tr * 9 + tc);
      }
    }
    return out;
  };
  function refWallLegal(ref, o, r, c) {
    const saved = new Set(ref.blocked);
    ref.place(o, r, c);
    const isOk = ref.dist(0, 0) < Infinity && ref.dist(1, 8) < Infinity;
    ref.blocked = saved;
    return isOk;
  }
  /* ---------- 随机局面（固定种子） ---------- */
  const rndInt = (n) => Math.floor(rand() * n);
  function randomPosition(nWalls) {
    const st = Q.newState();
    const ref = new RefBoard();
    let placed = 0, guard = 0;
    while (placed < nWalls && guard++ < 400) {
      const o = rndInt(2), r = rndInt(8), c = rndInt(8);
      if (!Q.wallFits(st, o, r, c)) continue;
      const save = [st.hw.slice(), st.vw.slice()];
      (o === Q.H ? st.hw : st.vw)[r * 8 + c] = 1;
      const reachable = Q.distOf(st, 0, st.pawn[0]) < Q.INF && Q.distOf(st, 8, st.pawn[1]) < Q.INF;
      if (!reachable) { st.hw = save[0]; st.vw = save[1]; continue; }
      ref.place(o, r, c);
      placed++;
    }
    const cells = [];
    for (let i = 0; i < 81; i++) cells.push(i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = rndInt(i + 1);
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    st.pawn = [cells[0], cells[1]];
    ref.pawn = [[(cells[0] / 9) | 0, cells[0] % 9], [(cells[1] / 9) | 0, cells[1] % 9]];
    return { st, ref, n: placed };
  }

  let fuzzChecks = 0, fuzzFails = 0;
  function cmp(cond, msg) {
    fuzzChecks++;
    if (!cond) { fuzzFails++; ok(false, msg); }
    else ok(true, '');
  }
  const ITER = 160;
  for (let iter = 0; iter < ITER; iter++) {
    const { st, ref, n } = randomPosition(rndInt(14));
    const tag = `#${iter} (${n} 面墙, 红@${st.pawn[0]} 蓝@${st.pawn[1]})`;

    const sameDist = (a, b) => a === b || (a >= Q.INF && b === Infinity);
    for (const [side, goal] of [[0, 0], [1, 8]]) {
      const a = Q.distOf(st, goal, st.pawn[side]);
      const b = ref.dist(side, goal);
      cmp(sameDist(a, b), `${tag} 第${side}方最短路不一致: engine=${a} ref=${b}`);
    }
    for (const [side, other] of [[0, 1], [1, 0]]) {
      const a = Q.legalMoves(st, side).slice().sort((x, y) => x - y);
      const b = ref.moves(side, other).slice().sort((x, y) => x - y);
      cmp(a.length === b.length && a.every((v, i) => v === b[i]),
        `${tag} 第${side}方走子不一致: engine=${JSON.stringify(a)} ref=${JSON.stringify(b)}`);
    }
    for (let o = 0; o < 2; o++) for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const a = Q.tryPlaceWall(st, o, r, c, 0);
      const b = Q.wallFits(st, o, r, c) && refWallLegal(ref, o, r, c);
      cmp(a === b, `${tag} 墙(${o ? 'V' : 'H'},${r},${c}) 合法性不一致: engine=${a} ref=${b}`);
    }
  }
  console.log(`  fuzz 对拍：${ITER} 局，${fuzzChecks} 项检查，${fuzzFails} 项不一致`);
  ok(fuzzFails === 0, `fuzz 对拍有 ${fuzzFails} 项不一致`);
  ok(fuzzChecks >= 20000, `fuzz 检查项过少（${fuzzChecks}），应 >= 20000`);
}

/* ===================================================================== */
/* 移植 verify_search.js（朴素 negamax 对拍，深度 1/2，>=10 局）          */
/* ===================================================================== */
group('verify_search 朴素 negamax 对拍（深度 1/2）');
{
  function allMoves(st, me) {
    const out = Q.legalMoves(st, me).slice();
    for (let o = 0; o < 2; o++) for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
      if (Q.tryPlaceWall(st, o, r, c, me)) out.push(Q.encodeWall(o, r, c));
    return out;
  }
  function naiveEval(st, me) {
    const opp = Q.oth(me), T = Q.TUNE;
    const myD = Q.distanceToGoal(st, me);
    if (myD === 0) return Q.WIN - 10;
    if (myD === 1 && Q.canStepIn(st, me)) return Q.WIN - 200;
    const opD = Q.distanceToGoal(st, opp);
    if (opD <= 1 && Q.canStepIn(st, opp)) return -Q.WIN + 400;
    let s = (opD - myD) * T.STEP;
    s += (myD <= opD ? T.RACE : -T.RACE);
    s += (st.walls[me] - st.walls[opp]) * T.WALL;
    if (myD <= T.ENDGAME_AT && opD <= T.ENDGAME_AT) s += (opD - myD) * T.ENDGAME;
    return s;
  }
  function refNegamax(st, depth, me, ply) {
    if (depth <= 0) return naiveEval(st, me);
    let best = -Infinity;
    for (const m of allMoves(st, me)) {
      const s2 = Q.cloneState(st);
      Q.applyMove(s2, m, me);
      const v = (m < 81 && Q.rOf(m) === Q.GOAL_ROW[me])
        ? Q.WIN - ply
        : -refNegamax(s2, depth - 1, Q.oth(me), ply + 1);
      if (v > best) best = v;
    }
    return best === -Infinity ? naiveEval(st, me) : best;
  }
  const nm = (m) => m < 0 ? '?'
    : (m < 81 ? `走(${Q.rOf(m)},${Q.cOf(m)})`
      : `墙${Q.decodeMove(m).o === Q.H ? 'H' : 'V'}(${Q.decodeMove(m).r},${Q.decodeMove(m).c})`);

  let tooHigh = 0, mismatch1 = 0, checked = 0, validGames = 0;
  const TARGET_GAMES = 12;
  for (let attempt = 0; attempt < 30 && validGames < TARGET_GAMES; attempt++) {
    const g = new Q.Game();
    const k = (rand() * 14) | 0;
    for (let j = 0; j < k && !g.over; j++) {
      const ms = g.legalMoves();
      g.play(ms[(rand() * ms.length) | 0]);
    }
    if (g.over) continue;
    validGames++;

    for (const depth of [1, 2]) {
      const st0 = Q.cloneState(g.st); Q.rehash(st0);
      const me = st0.turn;
      const moves = allMoves(st0, me);
      if (!moves.length) continue;
      let refBest = -Infinity, refMv = -1;
      for (const m of moves) {
        const s2 = Q.cloneState(st0);
        Q.applyMove(s2, m, me);
        const v = (m < 81 && Q.rOf(m) === Q.GOAL_ROW[me])
          ? Q.WIN
          : (depth === 1 ? -naiveEval(s2, Q.oth(me)) : -refNegamax(s2, depth - 1, Q.oth(me), 1));
        if (v > refBest) { refBest = v; refMv = m; }
      }
      const st1 = Q.cloneState(g.st); Q.rehash(st1);
      const cc = Q.chooseMove(st1, { timeMs: 1e9, maxDepth: depth, wallLimit: 999, blunder: 0, noise: 0 });
      checked++;
      if (!cc) { ok(false, `第${validGames}局 深${depth}: chooseMove 返回 null`); continue; }
      if (cc.score > refBest + 0.5) {
        tooHigh++;
        ok(false, `第${validGames}局 深${depth}: 优化版 ${cc.score} > 朴素全宽 ${refBest}   优化选 ${nm(cc.mv)} / 朴素选 ${nm(refMv)}`);
      } else ok(true, '');
      if (depth === 1) {
        if (cc.score !== refBest) {
          mismatch1++;
          ok(false, `第${validGames}局 深1: 分数不等 优化版 ${cc.score} vs 朴素 ${refBest}`);
        } else ok(true, '');
      }
    }
  }
  console.log(`  抽查 ${validGames} 局，${checked} 次检查；分数过高 ${tooHigh} 次，深度1不等 ${mismatch1} 次`);
  ok(tooHigh === 0, `优化版分数高于朴素全宽 ${tooHigh} 次`);
  ok(mismatch1 === 0, `深度 1 分数不精确相等 ${mismatch1} 次`);
  ok(validGames >= 10 && checked >= 20, `有效局数/检查数不足: ${validGames} 局 / ${checked} 次`);
}

/* ===================================================================== */
/* 汇总                                                                   */
/* ===================================================================== */
finishGroup();
console.log(`\n引擎：${ENGINE_PATH}`);
console.log(`SHA-256：${engineSha}`);
console.log(`\n总结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('结论：失败 —— 引擎复用/行为验证未通过');
  process.exitCode = 1;
} else {
  console.log('结论：全部通过 —— 引擎原样复用，原版测试语义全部保留');
  process.exitCode = 0;
}
