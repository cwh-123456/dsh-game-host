/* =========================================================================
 * 墙棋 / Quoridor —— 规则引擎 + AI
 * -------------------------------------------------------------------------
 * 坐标约定
 *   格子 (r,c)，r=0 在最上方，c=0 在最左方，索引 p = r*9 + c
 *   红方(RED) 从底边 (8,4) 出发，目标是第 0 行
 *   蓝方(BLUE) 从顶边 (0,4) 出发，目标是第 8 行
 *
 * 墙位 (r,c)，r,c ∈ [0,7]，共 8x8 个交点，每个交点可放横墙或竖墙
 *   横墙 H(r,c)：挡住 (r,c)-(r+1,c) 与 (r,c+1)-(r+1,c+1) 两条竖边
 *   竖墙 V(r,c)：挡住 (r,c)-(r,c+1) 与 (r+1,c)-(r+1,c+1) 两条横边
 *   因此：横墙 H(r,c) 与 H(r,c±1) 重叠，与 V(r,c) 交叉，均非法
 * =======================================================================*/
(function (root) {
  'use strict';

  var N = 9, NW = 8;
  var H = 0, V = 1;
  var RED = 0, BLUE = 1;
  var GOAL_ROW = [0, 8];
  var START = [8 * 9 + 4, 0 * 9 + 4];
  var MAX_WALLS = 10;

  var INF = 1e9;
  var WIN = 1e6;

  /* ---------------------------- 小工具 ---------------------------- */
  function rOf(p) { return (p / 9) | 0; }
  function cOf(p) { return p % 9; }
  function idx(r, c) { return r * 9 + c; }
  function oth(s) { return s ^ 1; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------------------- 状态 ---------------------------- */
  function newState() {
    return {
      pawn: [START[0], START[1]],
      walls: [MAX_WALLS, MAX_WALLS],
      hw: new Uint8Array(NW * NW),   // 横墙占用
      vw: new Uint8Array(NW * NW),   // 竖墙占用
      turn: RED,
      h1: 0, h2: 0                  // Zobrist 双 32 位哈希
    };
  }

  function cloneState(s) {
    return {
      pawn: [s.pawn[0], s.pawn[1]],
      walls: [s.walls[0], s.walls[1]],
      hw: s.hw.slice(),
      vw: s.vw.slice(),
      turn: s.turn,
      h1: s.h1, h2: s.h2
    };
  }

  /* ------------------------ 墙 / 边的阻挡关系 ------------------------ */
  /* 竖边 (r,c)-(r+1,c)，r:0..7, c:0..8 */
  function vBlocked(st, r, c) {
    return (c > 0 && st.hw[r * 8 + c - 1] === 1) || (c < 8 && st.hw[r * 8 + c] === 1);
  }
  /* 横边 (r,c)-(r,c+1)，r:0..8, c:0..7 */
  function hBlocked(st, r, c) {
    return (r > 0 && st.vw[(r - 1) * 8 + c] === 1) || (r < 8 && st.vw[r * 8 + c] === 1);
  }
  /* 两个相邻格子之间是否被墙挡住 */
  function blockedBetween(st, p1, p2) {
    var r1 = rOf(p1), c1 = cOf(p1), r2 = rOf(p2), c2 = cOf(p2);
    if (r1 === r2) return hBlocked(st, r1, Math.min(c1, c2));
    return vBlocked(st, Math.min(r1, r2), c1);
  }
  function adjacent(p1, p2) {
    var d = Math.abs(rOf(p1) - rOf(p2)) + Math.abs(cOf(p1) - cOf(p2));
    return d === 1;
  }

  /* ---------------------------- 走子生成 ---------------------------- */
  var DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  /* PERP[k] = 与 DIRS[k] 垂直的两个方向，用于撞子后的斜跳 */
  var PERP = [
    [[0, -1], [0, 1]],
    [[0, -1], [0, 1]],
    [[-1, 0], [1, 0]],
    [[-1, 0], [1, 0]]
  ];
  var PM = new Int32Array(8);   // 走子暂存区（每次调用会被覆盖）

  /* 生成 me 方棋子的合法落点，写入 out，返回个数 */
  function pawnMoves(st, me, out) {
    var p = st.pawn[me], opp = st.pawn[oth(me)];
    var r = rOf(p), c = cOf(p);
    var n = 0;
    for (var k = 0; k < 4; k++) {
      var dr = DIRS[k][0], dc = DIRS[k][1];
      var nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
      if (blockedBetween(st, p, idx(nr, nc))) continue;
      var np = idx(nr, nc);
      if (np !== opp) { out[n++] = np; continue; }

      /* 正面撞上对方棋子 —— 尝试跳过去 */
      var jr = nr + dr, jc = nc + dc;
      var canStraight = (jr >= 0 && jr <= 8 && jc >= 0 && jc <= 8) &&
        !blockedBetween(st, np, idx(jr, jc));
      if (canStraight) { out[n++] = idx(jr, jc); continue; }

      /* 对方身后有墙或出界 —— 斜跳到对方两侧 */
      var pp = PERP[k];
      for (var t = 0; t < 2; t++) {
        var tr = nr + pp[t][0], tc = nc + pp[t][1];
        if (tr < 0 || tr > 8 || tc < 0 || tc > 8) continue;
        if (blockedBetween(st, np, idx(tr, tc))) continue;  // 对方与斜目标之间不能有墙
        out[n++] = idx(tr, tc);
      }
    }
    return n;
  }

  /* 返回 me 方所有合法落点数组（给界面用） */
  function legalMoves(st, me) {
    var n = pawnMoves(st, me, PM);
    var a = [];
    for (var i = 0; i < n; i++) a.push(PM[i]);
    return a;
  }

  /* 一步之内能否踏上终点行（含跳跃/斜跳） */
  function canStepIn(st, me) {
    var n = pawnMoves(st, me, PM);
    for (var i = 0; i < n; i++) if (rOf(PM[i]) === GOAL_ROW[me]) return true;
    return false;
  }

  /* ---------------------------- 墙的合法性 ---------------------------- */
  /* 只检查几何冲突（重叠/交叉），不检查是否封死 */
  function wallFits(st, o, r, c) {
    if (r < 0 || r > 7 || c < 0 || c > 7) return false;
    var i = r * 8 + c;
    if (o === H) {
      if (st.hw[i]) return false;                        // 完全重叠
      if (c > 0 && st.hw[i - 1]) return false;           // 与左一格重叠
      if (c < 7 && st.hw[i + 1]) return false;           // 与右一格重叠
      if (st.vw[i]) return false;                        // 十字交叉
    } else {
      if (st.vw[i]) return false;
      if (r > 0 && st.vw[i - 8]) return false;
      if (r < 7 && st.vw[i + 8]) return false;
      if (st.hw[i]) return false;
    }
    return true;
  }

  /* ---------------------------- 最短路 BFS ---------------------------- */
  var DMAP = new Int32Array(81);
  var SEEN = new Int32Array(81);
  var Q = new Int32Array(81);
  var GEN = 0;

  /* 从整条终点行出发做多源 BFS，DMAP[p] = p 到终点行的最少步数 */
  function fillDist(st, goalRow) {
    var gen = ++GEN;
    var head = 0, tail = 0, base = goalRow * 9, c, p, np, r, d;
    for (c = 0; c < 9; c++) { p = base + c; DMAP[p] = 0; SEEN[p] = gen; Q[tail++] = p; }
    while (head < tail) {
      p = Q[head++];
      r = (p / 9) | 0; c = p % 9; d = DMAP[p] + 1;
      if (r > 0 && !vBlocked(st, r - 1, c)) { np = p - 9; if (SEEN[np] !== gen) { SEEN[np] = gen; DMAP[np] = d; Q[tail++] = np; } }
      if (r < 8 && !vBlocked(st, r, c)) { np = p + 9; if (SEEN[np] !== gen) { SEEN[np] = gen; DMAP[np] = d; Q[tail++] = np; } }
      if (c > 0 && !hBlocked(st, r, c - 1)) { np = p - 1; if (SEEN[np] !== gen) { SEEN[np] = gen; DMAP[np] = d; Q[tail++] = np; } }
      if (c < 8 && !hBlocked(st, r, c)) { np = p + 1; if (SEEN[np] !== gen) { SEEN[np] = gen; DMAP[np] = d; Q[tail++] = np; } }
    }
    return gen;
  }

  /* 单个格子到终点行的距离，不可达返回 INF */
  function distOf(st, goalRow, cell) {
    var g = fillDist(st, goalRow);
    return SEEN[cell] === g ? DMAP[cell] : INF;
  }

  /* me 方到自家终点的最短路长度 */
  function distanceToGoal(st, me) {
    return distOf(st, GOAL_ROW[me], st.pawn[me]);
  }

  /* 放墙是否合法：几何合法 + 不能把任何一方彻底封死 */
  function tryPlaceWall(st, o, r, c, me) {
    if (me === undefined) me = st.turn;
    if (st.walls[me] <= 0) return false;
    if (!wallFits(st, o, r, c)) return false;
    var arr = o === H ? st.hw : st.vw;
    var i = r * 8 + c;
    arr[i] = 1;
    var d0 = distOf(st, GOAL_ROW[0], st.pawn[0]);
    var d1 = distOf(st, GOAL_ROW[1], st.pawn[1]);
    arr[i] = 0;
    return d0 < INF && d1 < INF;
  }

  /* ---------------------------- 走法编码 ---------------------------- */
  /* 0..80        走子到该格
   * 81..208      放墙：81 + o*64 + slot */
  function encodeWall(o, r, c) { return 81 + o * 64 + r * 8 + c; }
  function decodeMove(mv) {
    if (mv < 81) return { t: 'move', to: mv, r: rOf(mv), c: cOf(mv) };
    var x = mv - 81, slot = x & 63;
    return { t: 'wall', o: x >> 6, r: slot >> 3, c: slot & 7 };
  }

  /* ---------------------------- Zobrist 哈希 ---------------------------- */
  var ZP1 = new Int32Array(162), ZP2 = new Int32Array(162);
  var ZH1 = new Int32Array(64), ZH2 = new Int32Array(64);
  var ZV1 = new Int32Array(64), ZV2 = new Int32Array(64);
  var ZT1 = 0, ZT2 = 0;
  (function initZobrist() {
    var s = 2463534242;
    function rnd() { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; }
    for (var i = 0; i < 162; i++) { ZP1[i] = rnd(); ZP2[i] = rnd(); }
    for (i = 0; i < 64; i++) { ZH1[i] = rnd(); ZH2[i] = rnd(); ZV1[i] = rnd(); ZV2[i] = rnd(); }
    ZT1 = rnd(); ZT2 = rnd();
  })();

  function rehash(st) {
    var a = 0, b = 0, i, k;
    for (var s = 0; s < 2; s++) { k = s * 81 + st.pawn[s]; a ^= ZP1[k]; b ^= ZP2[k]; }
    for (i = 0; i < 64; i++) {
      if (st.hw[i]) { a ^= ZH1[i]; b ^= ZH2[i]; }
      if (st.vw[i]) { a ^= ZV1[i]; b ^= ZV2[i]; }
    }
    st.h1 = a ^ ZT1; st.h2 = b ^ ZT2;
  }

  /* ---------------------------- 落子 / 撤销 ---------------------------- */
  /* 返回还原用的 token（走子时是被移动棋子的原位置） */
  function applyMove(st, mv, me) {
    var tok = -1, a, b;
    if (mv < 81) {
      tok = st.pawn[me];
      a = me * 81 + tok; b = me * 81 + mv;
      st.h1 ^= ZP1[a] ^ ZP1[b];
      st.h2 ^= ZP2[a] ^ ZP2[b];
      st.pawn[me] = mv;
    } else {
      var x = mv - 81, o = x >> 6, slot = x & 63;
      if (o === H) { st.hw[slot] = 1; st.h1 ^= ZH1[slot]; st.h2 ^= ZH2[slot]; }
      else { st.vw[slot] = 1; st.h1 ^= ZV1[slot]; st.h2 ^= ZV2[slot]; }
      st.walls[me]--;
    }
    st.h1 ^= ZT1; st.h2 ^= ZT2;
    st.turn = me ^ 1;
    return tok;
  }

  function undoMove(st, mv, me, tok) {
    st.turn = me;
    st.h1 ^= ZT1; st.h2 ^= ZT2;
    if (mv < 81) {
      var a = me * 81 + tok, b = me * 81 + mv;
      st.h1 ^= ZP1[a] ^ ZP1[b];
      st.h2 ^= ZP2[a] ^ ZP2[b];
      st.pawn[me] = tok;
    } else {
      var x = mv - 81, o = x >> 6, slot = x & 63;
      if (o === H) { st.hw[slot] = 0; st.h1 ^= ZH1[slot]; st.h2 ^= ZH2[slot]; }
      else { st.vw[slot] = 0; st.h1 ^= ZV1[slot]; st.h2 ^= ZV2[slot]; }
      st.walls[me]++;
    }
  }

  /* ============================ AI ============================ */

  var TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  var TT_LOCK = new Int32Array(TT_SIZE);
  var TT_DEPTH = new Int8Array(TT_SIZE);
  var TT_FLAG = new Int8Array(TT_SIZE);   // 0=精确 1=下界 2=上界
  var TT_VAL = new Int32Array(TT_SIZE);
  var TT_MOVE = new Int32Array(TT_SIZE);
  var TT_USED = new Uint8Array(TT_SIZE);

  var NODES = 0, DEADLINE = 0, ABORTED = false;
  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  /* 评估函数权重（可调，见 tune.js 的参数实验） */
  var TUNE = {
    STEP: 100,      // 每领先一步的分值
    RACE: 0,        // 领先赛跑（myD <= opD）的额外奖励；0 = 不加悬崖
    WALL: 130,      // 每多一面墙的分值
    ENDGAME: 60,    // 双方都进入残局时，距离差的额外权重
    ENDGAME_AT: 4   // 距终点多少步算残局
  };

  /* 静态评估（站在 me 的角度） */
  function evalState(st, me) {
    var opp = oth(me);
    var myD = distOf(st, GOAL_ROW[me], st.pawn[me]);
    if (myD === 0) return WIN - 10;
    if (myD === 1 && canStepIn(st, me)) return WIN - 200;
    var opD = distOf(st, GOAL_ROW[opp], st.pawn[opp]);
    if (opD <= 1 && canStepIn(st, opp)) return -WIN + 400;

    var s = (opD - myD) * TUNE.STEP;
    s += (myD <= opD ? TUNE.RACE : -TUNE.RACE);
    s += (st.walls[me] - st.walls[opp]) * TUNE.WALL;
    if (myD <= TUNE.ENDGAME_AT && opD <= TUNE.ENDGAME_AT) s += (opD - myD) * TUNE.ENDGAME;
    return s;
  }

  /* 生成墙候选：只取能挡住对方最短路的那几个墙位，并按收益排序 */
  function genWalls(st, me, myD, limit, mvs, scs) {
    var opp = oth(me);
    var oppG = fillDist(st, GOAL_ROW[opp]);
    if (SEEN[st.pawn[opp]] !== oppG) return;
    var baseOpp = DMAP[st.pawn[opp]];

    /* 重建对方的一条最短路 */
    var path = [];
    var cur = st.pawn[opp], guard = 0;
    while (DMAP[cur] > 0 && guard++ < 100) {
      var r = rOf(cur), c = cOf(cur), nx = -1;
      for (var k = 0; k < 4; k++) {
        var nr = r + DIRS[k][0], nc = c + DIRS[k][1];
        if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
        var np = idx(nr, nc);
        if (SEEN[np] !== oppG || DMAP[np] !== DMAP[cur] - 1) continue;
        nx = np; break;
      }
      if (nx < 0) break;
      path.push(nx);
      cur = nx;
    }

    /* 能挡住这条路上任一条边的墙位 */
    var cand = [], mark = new Uint8Array(128);
    var prev = st.pawn[opp];
    for (var i = 0; i < path.length; i++) {
      var a = prev, b = path[i];
      var ra = rOf(a), ca = cOf(a), rb = rOf(b), cb = cOf(b);
      if (ra === rb) {                       // 横向一步 -> 被竖墙挡
        var cc = Math.min(ca, cb);
        for (var t = 0; t < 2; t++) {
          var rr = ra - t;
          if (rr < 0 || rr > 7) continue;
          var key = V * 64 + rr * 8 + cc;
          if (!mark[key]) { mark[key] = 1; cand.push(81 + key); }
        }
      } else {                               // 纵向一步 -> 被横墙挡
        var r2 = Math.min(ra, rb);
        for (var t2 = 0; t2 < 2; t2++) {
          var c2 = ca - t2;
          if (c2 < 0 || c2 > 7) continue;
          var key2 = H * 64 + r2 * 8 + c2;
          if (!mark[key2]) { mark[key2] = 1; cand.push(81 + key2); }
        }
      }
      prev = b;
    }

    var scored = [];
    for (var j = 0; j < cand.length; j++) {
      var mv = cand[j];
      var x = mv - 81, o = x >> 6, slot = x & 63, wr = slot >> 3, wc = slot & 7;
      if (!wallFits(st, o, wr, wc)) continue;
      var arr = o === H ? st.hw : st.vw;
      arr[slot] = 1;
      var no = distOf(st, GOAL_ROW[opp], st.pawn[opp]);
      var nm = distOf(st, GOAL_ROW[me], st.pawn[me]);
      arr[slot] = 0;
      if (no === INF || nm === INF) continue;   // 非法：把某一方封死了
      if (no <= baseOpp) continue;              // 无效：根本没挡到
      var loss = nm > myD ? nm - myD : 0;
      scored.push([mv, Math.min(990, (no - baseOpp) * 120 - loss * 80)]);
    }
    scored.sort(function (p, q) { return q[1] - p[1]; });
    var lim = Math.min(limit, scored.length);
    for (var m = 0; m < lim; m++) { mvs.push(scored[m][0]); scs.push(scored[m][1]); }
  }

  /* 生成并排序走法，返回当前方到终点的距离 */
  function genMoves(st, me, wallLimit, mvs, scs) {
    mvs.length = 0; scs.length = 0;
    var myG = fillDist(st, GOAL_ROW[me]);
    var myD = SEEN[st.pawn[me]] === myG ? DMAP[st.pawn[me]] : INF;
    var n = pawnMoves(st, me, PM);
    for (var i = 0; i < n; i++) {
      var to = PM[i];
      var d = SEEN[to] === myG ? DMAP[to] : INF;
      if (d === 0) {                       // 一步到终点
        mvs.length = 0; scs.length = 0;
        mvs.push(to); scs.push(1e9);
        return myD;
      }
      mvs.push(to);
      scs.push(1000 - d * 15);
    }
    if (st.walls[me] > 0 && wallLimit > 0) genWalls(st, me, myD, wallLimit, mvs, scs);
    return myD;
  }

  function negamax(st, depth, alpha, beta, me, ply) {
    if (ABORTED) return 0;
    if ((++NODES & 511) === 0 && now() > DEADLINE) { ABORTED = true; return 0; }

    var ti = (st.h1 >>> 0) & TT_MASK;
    var ttmv = -1;
    if (TT_USED[ti] && TT_LOCK[ti] === st.h2) {
      ttmv = TT_MOVE[ti];
      if (TT_DEPTH[ti] >= depth) {
        var v0 = TT_VAL[ti], f0 = TT_FLAG[ti];
        if (f0 === 0) return v0;
        if (f0 === 1 && v0 >= beta) return v0;
        if (f0 === 2 && v0 <= alpha) return v0;
      }
    }
    if (depth <= 0) return evalState(st, me);

    var mvs = [], scs = [];
    var wallLimit = depth >= 3 ? 14 : (depth === 2 ? 10 : 6);
    genMoves(st, me, wallLimit, mvs, scs);
    if (mvs.length === 0) return evalState(st, me);

    if (ttmv >= 0) {
      var pos = mvs.indexOf(ttmv);
      if (pos > 0) {
        mvs.splice(pos, 1); scs.splice(pos, 1);
        mvs.unshift(ttmv); scs.unshift(1e9);
      }
    }

    var alpha0 = alpha, best = -INF, bestMv = mvs[0];
    for (var i = 0; i < mvs.length; i++) {
      var mv = mvs[i];
      var tok = applyMove(st, mv, me);
      var v;
      if (mv < 81 && rOf(mv) === GOAL_ROW[me]) v = WIN - ply;
      else v = -negamax(st, depth - 1, -beta, -alpha, oth(me), ply + 1);
      undoMove(st, mv, me, tok);
      if (ABORTED) return 0;
      if (v > best) { best = v; bestMv = mv; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }

    if (!TT_USED[ti] || TT_LOCK[ti] !== st.h2 || TT_DEPTH[ti] <= depth) {
      TT_USED[ti] = 1; TT_LOCK[ti] = st.h2; TT_DEPTH[ti] = depth;
      TT_VAL[ti] = best; TT_MOVE[ti] = bestMv;
      TT_FLAG[ti] = best <= alpha0 ? 2 : (best >= beta ? 1 : 0);
    }
    return best;
  }

  /* 难度预设 */
  var DIFFICULTY = {
    1: { name: '简单', timeMs: 220, maxDepth: 2, wallLimit: 8, blunder: 0.30 },
    2: { name: '普通', timeMs: 700, maxDepth: 4, wallLimit: 20, blunder: 0.06 },
    3: { name: '困难', timeMs: 1800, maxDepth: 7, wallLimit: 28, blunder: 0.00 }
  };

  /* 选择一步棋，返回 { mv, score, depth, nodes } */
  function chooseMove(state, cfg) {
    cfg = cfg || {};
    var timeMs = cfg.timeMs || 700;
    var maxDepth = cfg.maxDepth || 4;
    var wallLimit = cfg.wallLimit || 20;
    var blunder = cfg.blunder || 0;
    var noise = cfg.noise || 0;

    var st = cloneState(state);
    rehash(st);
    var me = st.turn;

    NODES = 0; ABORTED = false;
    DEADLINE = now() + timeMs;
    TT_USED.fill(0);

    var mvs = [], scs = [];
    genMoves(st, me, wallLimit, mvs, scs);
    if (mvs.length === 0) return null;
    if (mvs.length === 1) return { mv: mvs[0], score: 0, depth: 0, nodes: 0 };

    /* 简单难度：偶尔退一步，让新手有得玩 */
    if (blunder > 0 && Math.random() < blunder) {
      var pool = mvs.filter(function (m) { return !(m < 81 && rOf(m) === GOAL_ROW[me]); });
      if (pool.length > 0) {
        var pick = pool[(Math.random() * pool.length) | 0];
        return { mv: pick, score: 0, depth: 0, nodes: 0, blunder: true };
      }
    }

    var best = mvs[0], bestScore = 0, reachedDepth = 0, bestTies = [mvs[0]];
    for (var d = 1; d <= maxDepth; d++) {
      var alpha = -INF, localBest = -1, localScore = -INF, ties = [];
      for (var i = 0; i < mvs.length; i++) {
        var mv = mvs[i];
        var tok = applyMove(st, mv, me);
        var v;
        if (mv < 81 && rOf(mv) === GOAL_ROW[me]) v = WIN;
        else v = -negamax(st, d - 1, -INF, -alpha, oth(me), 1);
        undoMove(st, mv, me, tok);
        if (ABORTED) break;
        if (v > localScore) { localScore = v; localBest = mv; ties = [mv]; }
        else if (v === localScore) ties.push(mv);
        if (v > alpha) alpha = v;
      }
      if (!ABORTED && localBest >= 0) {
        best = localBest; bestScore = localScore; reachedDepth = d; bestTies = ties;
        var pos = mvs.indexOf(best);
        if (pos > 0) { mvs.splice(pos, 1); scs.splice(pos, 1); mvs.unshift(best); scs.unshift(1e9); }
      }
      if (ABORTED) break;
      if (bestScore >= WIN - 1000) break;       // 已经算到必胜
      if (now() > DEADLINE) break;
    }
    /* noise > 0 时在同等最优的走法里随机挑一个（只为让对局有变化） */
    if (noise > 0 && bestTies.length > 1) {
      best = bestTies[(Math.random() * bestTies.length) | 0];
    }
    return { mv: best, score: bestScore, depth: reachedDepth, nodes: NODES };
  }

  /* ============================ 对局封装 ============================ */
  function Game() {
    this.st = newState();
    this.hist = [];
    this.over = false;
    this.winner = -1;
  }

  /* 合法落点 */
  Game.prototype.legalMoves = function () { return legalMoves(this.st, this.st.turn); };

  /* 放墙是否合法（含封路检查） */
  Game.prototype.canWall = function (o, r, c) {
    return tryPlaceWall(this.st, o, r, c, this.st.turn);
  };

  /* 执行一步；mv 为编码后的走法，返回是否成功 */
  Game.prototype.play = function (mv) {
    if (this.over) return false;
    var me = this.st.turn;
    if (mv < 81) {
      var n = pawnMoves(this.st, me, PM), ok = false;
      for (var i = 0; i < n; i++) if (PM[i] === mv) ok = true;
      if (!ok) return false;
    } else {
      var x = mv - 81, o = x >> 6, slot = x & 63;
      if (!tryPlaceWall(this.st, o, slot >> 3, slot & 7, me)) return false;
    }
    var tok = applyMove(this.st, mv, me);
    this.hist.push({ mv: mv, me: me, tok: tok, over: this.over, winner: this.winner });
    if (mv < 81 && rOf(mv) === GOAL_ROW[me]) { this.over = true; this.winner = me; }
    return true;
  };

  /* 悔一步 */
  Game.prototype.undo = function () {
    if (this.hist.length === 0) return false;
    var h = this.hist.pop();
    undoMove(this.st, h.mv, h.me, h.tok);
    this.over = h.over;
    this.winner = h.winner;
    return true;
  };

  /* 最近一步（用于界面高亮），无则返回 null */
  Game.prototype.last = function () {
    return this.hist.length ? this.hist[this.hist.length - 1].mv : -1;
  };

  /* ---------------------------- 导出 ---------------------------- */
  root.Q = {
    N: N, NW: NW, H: H, V: V, RED: RED, BLUE: BLUE,
    GOAL_ROW: GOAL_ROW, START: START, MAX_WALLS: MAX_WALLS,
    INF: INF, WIN: WIN,
    newState: newState, cloneState: cloneState,
    legalMoves: legalMoves, pawnMoves: pawnMoves, canStepIn: canStepIn,
    wallFits: wallFits, tryPlaceWall: tryPlaceWall,
    fillDist: fillDist, distOf: distOf, distanceToGoal: distanceToGoal,
    blockedBetween: blockedBetween, adjacent: adjacent,
    applyMove: applyMove, undoMove: undoMove, rehash: rehash,
    encodeWall: encodeWall, decodeMove: decodeMove,
    rOf: rOf, cOf: cOf, idx: idx, oth: oth, clamp: clamp,
    chooseMove: chooseMove, DIFFICULTY: DIFFICULTY, Game: Game, TUNE: TUNE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.Q;
})(typeof window !== 'undefined' ? window : globalThis);
