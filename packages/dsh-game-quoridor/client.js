/**
 * @local/dsh-game-quoridor — DSH `game.stage` client entry.
 *
 * 移植自用户已有的网页版墙棋 `D:\desktop_files\artificial_intelligence\games_ai\墙棋`：
 *   - engine.js（规则 + BFS + negamax AI，无 DOM 依赖）在执行期原样内联在下方，
 *     只通过局部变量 `Q` 使用，并临时接管/还原 `window.Q`，避免污染全局；
 *   - index.html 里的 canvas 绘制 / 指针交互逻辑就近移植（几何常量、配色、墙预览、
 *     跳子高亮都保持原样），工具栏 / 状态栏 / 规则弹窗用 React 重写；
 *   - 画布按舞台等比缩放（原版固定 610×610），高 DPI 用 devicePixelRatio 重算背板；
 *   - 存档 `localStorage['dsh.game.quoridor.v1']`，含菜单设置、棋盘、墙、悔棋历史；
 *     解析失败 / 版本不符 / 历史非法 → 静默开新局，不抛错。
 *
 * 单文件原因：DSH 浏览器侧模块表只服务 client.js 一个入口，包内相对路径同步
 * `require` 不可用，所以规则引擎必须内联。`engine.js` 仍作为可测试的原始拷贝留在包内，
 * dev/verify-inline.mjs 会逐字节校验内联块与 engine.js 相同。
 */
;(function () {
  'use strict'

  const GAME_ID = 'quoridor'
  const STORE_KEY = 'dsh.game.' + GAME_ID + '.v1'
  const SCHEMA_VERSION = 1

  /* ---- 画布逻辑坐标：与原版完全一致的 610×610 几何 ---- */
  const CELL = 58
  const PAD = 44
  const LOGICAL_SIZE = PAD * 2 + 9 * CELL // 610
  const WALL_THICKNESS = Math.round(CELL * 0.17) // 10
  const MIN_STAGE_W = 320
  const MIN_STAGE_H = 240
  const MAX_HISTORY = 2000

  const MODES = ['pvp', 'pve', 'eve']
  const MODE_META = {
    pvp: { label: '双人对战' },
    pve: { label: '人机对战' },
    eve: { label: 'AI 对 AI' },
  }
  const LEVEL_IDS = [1, 2, 3]
  const SPEED_MIN = 200
  const SPEED_MAX = 1000
  const SPEED_DEFAULT = 400

  /* ======================================================================
   * 内联引擎：本节由 engine.js 原样复制（逐字节），锚点供 dev/verify-inline.mjs
   * 抽取比对。执行后通过 window.Q 取出，并还原调用前的 window.Q。
   * ==================================================================== */
  const Q = (function inlineEngine(globalRoot) {
    const previousQ = globalRoot ? globalRoot.Q : undefined;
/* >>> DSH INLINE ENGINE BEGIN (verbatim copy of ./engine.js) >>> */
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
/* <<< DSH INLINE ENGINE END <<< */
    const api = globalRoot ? globalRoot.Q : undefined;
    if (globalRoot) {
      try {
        if (previousQ === undefined) delete globalRoot.Q
        else globalRoot.Q = previousQ
      } catch (error) {
        // window.Q 被别的东西锁定（极少见）：保留引擎引用，不打断游戏启动。
      }
    }
    if (!api) throw new Error('quoridor: inline engine did not initialise')
    return api
  })(typeof window !== 'undefined' ? window : globalThis)

  const DIFFICULTY = Q.DIFFICULTY

  /* -------------------------------------------------------------------------
   * 小工具
   * ---------------------------------------------------------------------- */

  function nowMs() {
    const perf = typeof performance !== 'undefined' ? performance : null
    return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value
  }

  function isIntegerIn(value, min, max) {
    return typeof value === 'number' && isFinite(value) &&
      Math.floor(value) === value && value >= min && value <= max
  }

  function isIntegerArray(input, length, min, max) {
    if (!Array.isArray(input) || input.length !== length) return false
    for (let i = 0; i < length; i += 1) {
      if (!isIntegerIn(input[i], min, max)) return false
    }
    return true
  }

  function isBinaryArray(input, length) {
    if (!Array.isArray(input) || input.length !== length) return false
    for (let i = 0; i < length; i += 1) {
      if (input[i] !== 0 && input[i] !== 1) return false
    }
    return true
  }

  /* -------------------------------------------------------------------------
   * 画布几何（与原版 index.html 的公式一致；输入输出都是 610×610 逻辑坐标）
   * ---------------------------------------------------------------------- */

  function computeLayout(width, height) {
    const w = Math.max(0, Math.floor(width || 0))
    const h = Math.max(0, Math.floor(height || 0))
    const scale = Math.min(w / LOGICAL_SIZE, h / LOGICAL_SIZE)
    const cssWidth = Math.max(1, Math.round(LOGICAL_SIZE * scale))
    return { scale: cssWidth / LOGICAL_SIZE, cssWidth: cssWidth, cssHeight: cssWidth }
  }

  /* 一面墙横跨两格（见 engine.js 的墙语义与 verify_wallseg.js）：
   *   H(r,c) 画在水平第 r+1 条网格线上，从 x=c 到 x=c+2
   *   V(r,c) 画在竖直第 c+1 条网格线上，从 y=r 到 y=r+2 */
  function wallSeg(o, r, c) {
    if (o === Q.H) {
      return [PAD + c * CELL, PAD + (r + 1) * CELL, PAD + (c + 2) * CELL, PAD + (r + 1) * CELL]
    }
    return [PAD + (c + 1) * CELL, PAD + r * CELL, PAD + (c + 1) * CELL, PAD + (r + 2) * CELL]
  }

  function cellCenterLogical(index) {
    return { x: PAD + Q.cOf(index) * CELL + CELL / 2, y: PAD + Q.rOf(index) * CELL + CELL / 2 }
  }

  function cellAt(mx, my) {
    const c = Math.floor((mx - PAD) / CELL)
    const r = Math.floor((my - PAD) / CELL)
    if (r < 0 || r > 8 || c < 0 || c > 8) return -1
    return r * 9 + c
  }

  /* 鼠标位置 -> 墙候选。墙横跨两格，所以让墙的中心落在鼠标指着的那条网格线上：
   * 中心线 (gx,gy) -> 锚点 (gy-1, gx-1)，横竖共用；网格线 1..8 对应 8 个墙位。
   * （原版 wallAt 原样移植，只把输入单位由「格」改成逻辑像素再换算。） */
  function wallAt(mx, my, flipped) {
    const ux = (mx - PAD) / CELL
    const uy = (my - PAD) / CELL
    const gx = Math.round(ux)
    const gy = Math.round(uy)
    const dx = Math.abs(ux - gx)
    const dy = Math.abs(uy - gy)
    if (Math.min(dx, dy) >= 0.30) return null
    if (gx < 1 || gx > 8 || gy < 1 || gy > 8) return null
    let nearV = dx <= dy
    if (flipped) nearV = !nearV
    return { o: nearV ? Q.V : Q.H, r: gy - 1, c: gx - 1 }
  }

  /* -------------------------------------------------------------------------
   * 存档：localStorage['dsh.game.quoridor.v1']
   * 写入棋盘 + 菜单设置 + 完整悔棋历史；读取时用引擎重放历史并与存档棋盘逐项
   * 对照，任何不一致（损坏、旧版本、被改过）都静默丢弃、开新局。
   * ---------------------------------------------------------------------- */

  function serializeSave(game, ui) {
    return {
      schemaVersion: SCHEMA_VERSION,
      mode: ui.mode,
      mySide: ui.mySide,
      level: ui.level,
      speed: ui.speed,
      game: {
        st: {
          pawn: [game.st.pawn[0], game.st.pawn[1]],
          walls: [game.st.walls[0], game.st.walls[1]],
          hw: Array.from(game.st.hw),
          vw: Array.from(game.st.vw),
          turn: game.st.turn,
        },
        hist: game.hist.map(function (entry) {
          return {
            mv: entry.mv,
            me: entry.me,
            tok: entry.tok,
            over: !!entry.over,
            winner: entry.winner,
          }
        }),
        over: !!game.over,
        winner: game.winner,
      },
    }
  }

  function sameState(state, saved) {
    if (!saved || typeof saved !== 'object') return false
    if (state.pawn[0] !== saved.pawn[0] || state.pawn[1] !== saved.pawn[1]) return false
    if (state.walls[0] !== saved.walls[0] || state.walls[1] !== saved.walls[1]) return false
    if (state.turn !== saved.turn) return false
    for (let i = 0; i < 64; i += 1) {
      const hw = state.hw[i] ? 1 : 0
      const vw = state.vw[i] ? 1 : 0
      if (hw !== saved.hw[i] || vw !== saved.vw[i]) return false
    }
    return true
  }

  function sanitizeSave(input) {
    if (!input || typeof input !== 'object') return null
    if (input.schemaVersion !== SCHEMA_VERSION) return null
    if (MODES.indexOf(input.mode) < 0) return null
    if (input.mySide !== Q.RED && input.mySide !== Q.BLUE) return null
    if (!isIntegerIn(input.level, 1, 3)) return null
    let speed = SPEED_DEFAULT
    if (input.speed !== undefined) {
      if (typeof input.speed !== 'number' || !isFinite(input.speed)) return null
      speed = clamp(Math.round(input.speed), SPEED_MIN, SPEED_MAX)
    }
    const savedGame = input.game
    if (!savedGame || typeof savedGame !== 'object') return null
    const savedState = savedGame.st
    if (!savedState || typeof savedState !== 'object') return null
    if (!isIntegerArray(savedState.pawn, 2, 0, 80)) return null
    if (savedState.pawn[0] === savedState.pawn[1]) return null
    if (!isIntegerArray(savedState.walls, 2, 0, Q.MAX_WALLS)) return null
    if (!isBinaryArray(savedState.hw, 64) || !isBinaryArray(savedState.vw, 64)) return null
    if (savedState.turn !== Q.RED && savedState.turn !== Q.BLUE) return null
    if (!Array.isArray(savedGame.hist) || savedGame.hist.length > MAX_HISTORY) return null
    if (typeof savedGame.over !== 'boolean') return null
    if (!isIntegerIn(savedGame.winner, -1, 1)) return null

    /* 用引擎重放历史：既校验合法性，也拿到可信的当前局面。 */
    const replay = new Q.Game()
    for (let i = 0; i < savedGame.hist.length; i += 1) {
      const entry = savedGame.hist[i]
      if (!entry || typeof entry !== 'object') return null
      if (!isIntegerIn(entry.mv, 0, 208)) return null
      if (entry.me !== Q.RED && entry.me !== Q.BLUE) return null
      if (entry.me !== replay.st.turn) return null
      if (replay.over) return null
      if (!replay.play(entry.mv)) return null
    }
    if (!sameState(replay.st, savedState)) return null
    if (replay.over !== savedGame.over) return null
    if (replay.winner !== savedGame.winner) return null

    return { mode: input.mode, mySide: input.mySide, level: input.level, speed: speed, game: replay }
  }

  function readSavedState() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null
      const raw = window.localStorage.getItem(STORE_KEY)
      if (!raw) return null
      return sanitizeSave(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  function writeSavedState(payload) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      window.localStorage.setItem(STORE_KEY, JSON.stringify(payload))
    } catch (error) {
      // 配额满 / 隐私模式：存档失败不影响当前对局。
    }
  }

  /* -------------------------------------------------------------------------
   * 游戏实例：状态 + canvas + 输入 + AI 调度 + 持久化 + 清理
   * ---------------------------------------------------------------------- */

  function createGame(host, options) {
    if (!host) throw new Error('quoridor: missing mount element')
    const opts = options || {}
    const view = typeof window !== 'undefined' ? window : null
    const doc = typeof document !== 'undefined' ? document : (view && view.document) || null
    if (!view) throw new Error('quoridor: window is unavailable')
    if (!doc) throw new Error('quoridor: document is unavailable')

    const onState = typeof opts.onState === 'function' ? opts.onState : null
    const onError = typeof opts.onError === 'function' ? opts.onError : null

    const saved = readSavedState()
    let mode = saved ? saved.mode : 'pvp'
    let mySide = saved ? saved.mySide : Q.RED
    let level = saved ? saved.level : 2
    let speed = saved ? saved.speed : SPEED_DEFAULT
    let game = saved ? saved.game : new Q.Game()

    let paused = false
    let busy = false
    let runToken = 0
    let destroyed = false
    let failure = null
    let hover = -1
    let preview = null
    let flip = false
    let lastPoint = null
    let layout = null
    let size = { width: 0, height: 0, dpr: 1 }
    const timers = new Set()

    const canvas = doc.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('quoridor: 2d canvas context unavailable')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '墙棋棋盘：点格子走子，点格子之间的缝隙放墙')
    canvas.style.cssText =
      'display:block;outline:none;touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer'
    canvas.style.width = LOGICAL_SIZE + 'px'
    canvas.style.height = LOGICAL_SIZE + 'px'

    /* ---- 定时器（全部经由 window，便于测试替换 & destroy 统一清理） ---- */
    function schedule(fn, delay) {
      let id = 0
      try {
        id = view.setTimeout(function () {
          timers.delete(id)
          if (destroyed) return
          fn()
        }, Math.max(0, delay || 0))
      } catch (error) {
        return 0
      }
      timers.add(id)
      return id
    }

    function clearTimers() {
      timers.forEach(function (id) {
        try {
          view.clearTimeout(id)
        } catch (error) {
          // ignore
        }
      })
      timers.clear()
    }

    function cancelPending() {
      runToken += 1
      clearTimers()
      busy = false
    }

    function fail(error) {
      if (destroyed) return
      failure = '游戏遇到问题，点「重试」重新开始。'
      cancelPending()
      try {
        console.error('[dsh-game-quoridor] runtime error', error)
      } catch (logError) {
        // ignore
      }
      if (onError) {
        try {
          onError(failure)
        } catch (listenerError) {
          console.error('[dsh-game-quoridor] error listener failed', listenerError)
        }
      }
      emit()
    }

    /* ---- 状态快照 ---- */
    function snapshot() {
      return {
        mode: mode,
        mySide: mySide,
        level: level,
        speed: speed,
        paused: paused,
        busy: busy,
        over: !!game.over,
        winner: game.winner,
        turn: game.st.turn,
        walls: [game.st.walls[Q.RED], game.st.walls[Q.BLUE]],
        dist: [
          Q.distanceToGoal(game.st, Q.RED),
          Q.distanceToGoal(game.st, Q.BLUE),
        ],
        histLen: game.hist.length,
        canUndo: !busy && game.hist.length > 0,
        tooSmall: size.width < MIN_STAGE_W || size.height < MIN_STAGE_H,
        failure: failure,
      }
    }

    function emit() {
      if (!onState) return
      try {
        onState(snapshot())
      } catch (error) {
        console.error('[dsh-game-quoridor] state listener failed', error)
      }
    }

    function persist() {
      if (destroyed) return
      writeSavedState(serializeSave(game, { mode: mode, mySide: mySide, level: level, speed: speed }))
    }

    /* ---- 绘制 ---- */
    function roundRect(c, x, y, w, h, r) {
      c.beginPath()
      c.moveTo(x + r, y)
      c.arcTo(x + w, y, x + w, y + h, r)
      c.arcTo(x + w, y + h, x, y + h, r)
      c.arcTo(x, y + h, x, y, r)
      c.arcTo(x, y, x + w, y, r)
      c.closePath()
    }

    function strokeSeg(c, x1, y1, x2, y2, color, width) {
      c.strokeStyle = color
      c.lineWidth = width
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(x1, y1)
      c.lineTo(x2, y2)
      c.stroke()
    }

    function drawWall(c, r, col, o) {
      const p = wallSeg(o, r, col)
      const half = WALL_THICKNESS / 2
      if (o === Q.H) strokeSeg(c, p[0] + half, p[1], p[2] - half, p[3], '#8a7a63', WALL_THICKNESS)
      else strokeSeg(c, p[0], p[1] + half, p[2], p[3] - half, '#8a7a63', WALL_THICKNESS)
    }

    function drawBoard(c) {
      c.clearRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE)

      /* 棋盘底板 */
      c.fillStyle = '#e9e4da'
      roundRect(c, 0, 0, LOGICAL_SIZE, LOGICAL_SIZE, 14)
      c.fill()

      /* 网格 */
      c.strokeStyle = '#cfc7b8'
      c.lineWidth = 1
      for (let i = 0; i <= 9; i += 1) {
        const p = PAD + i * CELL
        c.beginPath()
        c.moveTo(PAD, p)
        c.lineTo(PAD + 9 * CELL, p)
        c.stroke()
        c.beginPath()
        c.moveTo(p, PAD)
        c.lineTo(p, PAD + 9 * CELL)
        c.stroke()
      }

      /* 终点行染色 */
      c.fillStyle = 'rgba(75,142,247,.12)'
      c.fillRect(PAD, PAD, 9 * CELL, CELL)
      c.fillStyle = 'rgba(228,87,76,.12)'
      c.fillRect(PAD, PAD + 8 * CELL, 9 * CELL, CELL)

      /* 已放的墙 */
      for (let r = 0; r < 8; r += 1) {
        for (let col = 0; col < 8; col += 1) {
          if (game.st.hw[r * 8 + col]) drawWall(c, r, col, Q.H)
          if (game.st.vw[r * 8 + col]) drawWall(c, r, col, Q.V)
        }
      }

      /* 上一步高亮 */
      const last = game.last()
      if (last >= 0) {
        if (last < 81) {
          const center = cellCenterLogical(last)
          c.strokeStyle = 'rgba(90,200,168,.85)'
          c.lineWidth = 2.5
          c.beginPath()
          c.arc(center.x, center.y, CELL * 0.4, 0, 6.2832)
          c.stroke()
        } else {
          const decoded = Q.decodeMove(last)
          const p = wallSeg(decoded.o, decoded.r, decoded.c)
          c.globalAlpha = 0.5
          strokeSeg(c, p[0], p[1], p[2], p[3], '#5ac8a8', WALL_THICKNESS)
          c.globalAlpha = 1
        }
      }

      /* 可走点（轮到我操作时） */
      if (humanCanAct()) {
        const moves = game.legalMoves()
        for (let i = 0; i < moves.length; i += 1) {
          const cell = moves[i]
          const center = cellCenterLogical(cell)
          c.fillStyle = cell === hover ? 'rgba(90,200,168,.9)' : 'rgba(40,52,66,.22)'
          c.beginPath()
          c.arc(center.x, center.y, cell === hover ? CELL * 0.2 : CELL * 0.12, 0, 6.2832)
          c.fill()
        }
      }

      /* 墙预览：绿色可放 / 红色非法 */
      if (preview) {
        const p = wallSeg(preview.o, preview.r, preview.c)
        c.globalAlpha = 0.78
        strokeSeg(c, p[0], p[1], p[2], p[3], preview.ok ? '#3fae8c' : '#d4453a', WALL_THICKNESS)
        c.globalAlpha = 1
      }

      /* 棋子 */
      for (let side = 0; side < 2; side += 1) {
        const pawn = game.st.pawn[side]
        const radius = CELL * 0.34
        const center = cellCenterLogical(pawn)
        c.save()
        c.shadowColor = 'rgba(0,0,0,.3)'
        c.shadowBlur = 9
        c.shadowOffsetY = 3
        c.fillStyle = side === Q.RED ? '#e4574c' : '#4b8ef7'
        c.beginPath()
        c.arc(center.x, center.y, radius, 0, 6.2832)
        c.fill()
        c.restore()
        c.fillStyle = 'rgba(255,255,255,.32)'
        c.beginPath()
        c.arc(center.x - radius * 0.28, center.y - radius * 0.3, radius * 0.3, 0, 6.2832)
        c.fill()
        if (!game.over && game.st.turn === side) {
          c.strokeStyle = 'rgba(255,255,255,.95)'
          c.lineWidth = 2.5
          c.beginPath()
          c.arc(center.x, center.y, radius + 4, 0, 6.2832)
          c.stroke()
        }
      }
    }

    function drawTooSmall(c) {
      const width = size.width
      const height = size.height
      const dpr = size.dpr
      const pixelWidth = Math.max(1, Math.round(width * dpr))
      const pixelHeight = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      canvas.style.width = Math.max(1, Math.round(width)) + 'px'
      canvas.style.height = Math.max(1, Math.round(height)) + 'px'
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.clearRect(0, 0, width, height)
      c.fillStyle = 'rgba(128,128,128,.9)'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.font = '600 14px "Segoe UI", system-ui, -apple-system, sans-serif'
      c.fillText('窗口太小', width / 2, height / 2 - 11)
      c.font = '12px "Segoe UI", system-ui, -apple-system, sans-serif'
      c.fillText('请放大游戏区域', width / 2, height / 2 + 12)
    }

    function draw() {
      if (size.width < MIN_STAGE_W || size.height < MIN_STAGE_H) {
        layout = null
        drawTooSmall(context)
        return
      }
      const next = computeLayout(size.width, size.height)
      layout = next
      const pixel = Math.max(1, Math.round(next.cssWidth * size.dpr))
      if (canvas.width !== pixel) canvas.width = pixel
      if (canvas.height !== pixel) canvas.height = pixel
      canvas.style.width = next.cssWidth + 'px'
      canvas.style.height = next.cssWidth + 'px'
      const k = (next.cssWidth * size.dpr) / LOGICAL_SIZE
      context.setTransform(k, 0, 0, k, 0, 0)
      drawBoard(context)
    }

    function paint() {
      if (destroyed) return
      try {
        draw()
      } catch (error) {
        fail(error)
      }
    }

    /* ---- 谁在操作 ---- */
    function isAI(side) {
      if (mode === 'eve') return true
      if (mode === 'pve') return side !== mySide
      return false
    }

    function humanCanAct() {
      return !destroyed && !failure && !busy && !game.over && !isAI(game.st.turn)
    }

    /* ---- AI 驱动：先让出一帧画出「思考中」，再算，再补足最小节奏 ---- */
    function pump() {
      if (destroyed || failure) return
      if (paused || game.over || !isAI(game.st.turn)) {
        busy = false
        emit()
        return
      }
      busy = true
      emit()
      const token = runToken
      schedule(function () {
        think(token)
      }, 30)
    }

    function think(token) {
      if (destroyed || token !== runToken) {
        if (token !== runToken) busy = false
        return
      }
      const started = nowMs()
      let result = null
      try {
        result = Q.chooseMove(game.st, DIFFICULTY[level])
      } catch (error) {
        fail(error)
        return
      }
      const spent = nowMs() - started
      if (destroyed || token !== runToken) {
        if (token !== runToken) busy = false
        return
      }
      /* 人机 / AI 对 AI 都保证「思考中」至少可见 speed 毫秒，避免 AI 瞬间跳变。 */
      const rest = Math.max(0, speed - spent)
      if (rest > 0) {
        schedule(function () {
          commit(token, result)
        }, rest)
      } else {
        commit(token, result)
      }
    }

    function commit(token, result) {
      if (destroyed || token !== runToken) {
        if (token !== runToken) busy = false
        return
      }
      busy = false
      try {
        if (result && game.play(result.mv)) {
          persist()
          paint()
          emit()
        }
      } catch (error) {
        fail(error)
        return
      }
      pump()
    }

    /* ---- 用户操作 ---- */
    function playMove(move) {
      if (destroyed || failure) return false
      let played = false
      try {
        played = game.play(move)
      } catch (error) {
        fail(error)
        return false
      }
      if (!played) return false
      hover = -1
      preview = null
      persist()
      paint()
      emit()
      pump()
      return true
    }

    function newGame() {
      if (destroyed) return
      cancelPending()
      game = new Q.Game()
      paused = false
      hover = -1
      preview = null
      flip = false
      lastPoint = null
      persist()
      paint()
      emit()
      pump()
    }

    function undo() {
      if (destroyed || busy || game.hist.length === 0) return false
      cancelPending()
      let count = 1
      if (mode === 'pve') {
        /* 人机模式退一整回合，否则 AI 会立刻把刚悔掉的那步再走一遍 */
        count = game.st.turn === mySide && game.hist.length >= 2 ? 2 : 1
      }
      for (let i = 0; i < count; i += 1) game.undo()
      hover = -1
      preview = null
      persist()
      paint()
      emit()
      pump()
      return true
    }

    function setMode(next) {
      if (MODES.indexOf(next) < 0 || next === mode) return
      mode = next
      if (mode !== 'eve') paused = false
      newGame()
    }

    function setSide(next) {
      if ((next !== Q.RED && next !== Q.BLUE) || next === mySide) return
      mySide = next
      newGame()
    }

    function setLevel(next) {
      if (LEVEL_IDS.indexOf(next) < 0 || next === level) return
      level = next
      persist()
      emit()
    }

    function setSpeed(next) {
      if (typeof next !== 'number' || !isFinite(next)) return
      const value = clamp(Math.round(next), SPEED_MIN, SPEED_MAX)
      if (value === speed) return
      speed = value
      persist()
      emit()
    }

    function toggleFlip() {
      flip = !flip
      if (lastPoint) {
        recomputeHover(lastPoint)
        paint()
      }
    }

    function togglePause() {
      if (destroyed || mode !== 'eve') return
      paused = !paused
      if (paused) cancelPending()
      emit()
      if (!paused) pump()
    }

    /* ---- 输入 ---- */
    function localPoint(event) {
      if (!layout) return null
      let rect = null
      try {
        rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null
      } catch (error) {
        rect = null
      }
      if (!rect || !rect.width) return null
      const clientX = event && typeof event.clientX === 'number' ? event.clientX : 0
      const clientY = event && typeof event.clientY === 'number' ? event.clientY : 0
      const left = typeof rect.left === 'number' ? rect.left : 0
      const top = typeof rect.top === 'number' ? rect.top : 0
      return {
        x: (clientX - left) * (LOGICAL_SIZE / rect.width),
        y: (clientY - top) * (LOGICAL_SIZE / rect.width),
      }
    }

    function recomputeHover(point) {
      hover = -1
      preview = null
      if (!point || !humanCanAct()) return
      const cell = cellAt(point.x, point.y)
      if (cell >= 0 && game.legalMoves().indexOf(cell) >= 0) hover = cell
      const wall = wallAt(point.x, point.y, flip)
      if (wall) {
        preview = { o: wall.o, r: wall.r, c: wall.c, ok: game.canWall(wall.o, wall.r, wall.c) }
        hover = -1
      }
    }

    function onPointerMove(event) {
      if (destroyed || failure) return
      const point = localPoint(event)
      lastPoint = point
      recomputeHover(point)
      paint()
    }

    function onPointerLeave() {
      if (destroyed) return
      lastPoint = null
      hover = -1
      preview = null
      paint()
    }

    function onPointerDown(event) {
      if (destroyed || failure) return
      try {
        canvas.focus({ preventScroll: true })
      } catch (error) {
        try {
          canvas.focus()
        } catch (focusError) {
          // ignore
        }
      }
      if (!humanCanAct()) return
      const point = localPoint(event)
      if (!point) return
      lastPoint = point
      recomputeHover(point)
      let move = -1
      if (preview && preview.ok) move = Q.encodeWall(preview.o, preview.r, preview.c)
      else if (hover >= 0) move = hover
      if (move < 0) {
        paint()
        return
      }
      playMove(move)
    }

    /* ---- 尺寸 / 可见性 ---- */
    function resize() {
      if (destroyed) return
      let rect = null
      try {
        rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
      } catch (error) {
        rect = null
      }
      const width = Math.max(0, Math.floor((rect && rect.width) || 0))
      const height = Math.max(0, Math.floor((rect && rect.height) || 0))
      const dpr = Math.max(1, view.devicePixelRatio || 1)
      size = { width: width, height: height, dpr: dpr }
      paint()
      emit()
    }

    function onVisibilityChange() {
      if (destroyed) return
      if (doc.hidden) {
        cancelPending()
        persist()
        paint()
        return
      }
      paint()
      emit()
      pump()
    }

    function onWindowResize() {
      if (destroyed) return
      try {
        resize()
      } catch (error) {
        fail(error)
      }
    }

    /* ---- 生命周期 ---- */
    function teardown() {
      if (destroyed) return
      persist()
      destroyed = true
      cancelPending()
      try {
        if (resizeObserver) resizeObserver.disconnect()
      } catch (error) {
        // ignore
      }
      try {
        doc.removeEventListener('visibilitychange', onVisibilityChange)
      } catch (error) {
        // ignore
      }
      try {
        view.removeEventListener('resize', onWindowResize)
      } catch (error) {
        // ignore
      }
      try {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerleave', onPointerLeave)
      } catch (error) {
        // ignore
      }
      try {
        canvas.remove()
      } catch (error) {
        // ignore
      }
    }

    let resizeObserver = null
    try {
      const ResizeObserverCtor = view.ResizeObserver
      if (typeof ResizeObserverCtor === 'function') {
        resizeObserver = new ResizeObserverCtor(function () {
          if (destroyed) return
          try {
            resize()
          } catch (error) {
            fail(error)
          }
        })
        resizeObserver.observe(host)
      }
    } catch (error) {
      // ResizeObserver 不可用也不影响游戏（只是缩放不跟随）。
    }

    try {
      doc.addEventListener('visibilitychange', onVisibilityChange)
      view.addEventListener('resize', onWindowResize)
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerleave', onPointerLeave)
      host.appendChild(canvas)
      resize()
      persist()
      emit()
      if (isAI(game.st.turn) && !game.over && !doc.hidden) pump()
    } catch (error) {
      try {
        teardown()
      } catch (teardownError) {
        // ignore
      }
      throw error
    }

    return {
      destroy: teardown,
      newGame: newGame,
      undo: undo,
      toggleFlip: toggleFlip,
      togglePause: togglePause,
      setMode: setMode,
      setSide: setSide,
      setLevel: setLevel,
      setSpeed: setSpeed,
      getState: snapshot,
      getLayout: function () {
        if (!layout) return null
        return { scale: layout.scale, cssWidth: layout.cssWidth, cssHeight: layout.cssHeight }
      },
      getEngineState: function () {
        return {
          pawn: [game.st.pawn[0], game.st.pawn[1]],
          walls: [game.st.walls[0], game.st.walls[1]],
          hw: Array.from(game.st.hw),
          vw: Array.from(game.st.vw),
          turn: game.st.turn,
          over: !!game.over,
          winner: game.winner,
          histLen: game.hist.length,
        }
      },
      getCanvas: function () {
        return canvas
      },
      cellPoint: function (row, col) {
        const scale = layout ? layout.scale : 1
        return { x: (PAD + col * CELL + CELL / 2) * scale, y: (PAD + row * CELL + CELL / 2) * scale }
      },
      wallPoint: function (o, r, c) {
        const scale = layout ? layout.scale : 1
        const p = wallSeg(o, r, c)
        return { x: ((p[0] + p[2]) / 2) * scale, y: ((p[1] + p[3]) / 2) * scale }
      },
    }
  }

  /* -------------------------------------------------------------------------
   * 测试探针：只有 dev 预览页 / 无头测试显式打开时才安装（生产不触发）。
   * ---------------------------------------------------------------------- */
  if (typeof window !== 'undefined' && window.__DSH_GAME_QUORIDOR_TEST__ === true) {
    try {
      Object.defineProperty(window, '__DSH_GAME_QUORIDOR__', {
        configurable: true,
        value: {
          Q: Q,
          GAME_ID: GAME_ID,
          STORE_KEY: STORE_KEY,
          SCHEMA_VERSION: SCHEMA_VERSION,
          LOGICAL_SIZE: LOGICAL_SIZE,
          CELL: CELL,
          PAD: PAD,
          WALL_THICKNESS: WALL_THICKNESS,
          MIN_STAGE_W: MIN_STAGE_W,
          MIN_STAGE_H: MIN_STAGE_H,
          MODES: MODES,
          MODE_META: MODE_META,
          LEVEL_IDS: LEVEL_IDS,
          LEVELS: DIFFICULTY,
          SPEED_MIN: SPEED_MIN,
          SPEED_MAX: SPEED_MAX,
          SPEED_DEFAULT: SPEED_DEFAULT,
          MAX_HISTORY: MAX_HISTORY,
          createGame: createGame,
          computeLayout: computeLayout,
          wallSeg: wallSeg,
          wallAt: wallAt,
          cellAt: cellAt,
          sanitizeSave: sanitizeSave,
          serializeSave: serializeSave,
          readSavedState: readSavedState,
        },
      })
    } catch (error) {
      // 测试探针失败不能影响游戏本身。
    }
  }

  /* ========================================================================
   * React 界面：工具栏 / 状态栏 / 规则弹窗（画布与输入在 createGame 里）
   * ====================================================================== */

  window.__ModuleLoader__.load({
    id: '@local/dsh-game-quoridor',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      const RED = Q.RED
      const BLUE = Q.BLUE
      const COLOR_RED = '#e4574c'
      const COLOR_BLUE = '#4b8ef7'

      const MODE_OPTIONS = MODES.map(function (id) {
        return { value: id, label: MODE_META[id].label }
      })
      const SIDE_OPTIONS = [
        { value: RED, label: '我执红' },
        { value: BLUE, label: '我执蓝' },
      ]
      const LEVEL_OPTIONS = LEVEL_IDS.map(function (id) {
        return { value: id, label: DIFFICULTY[id].name }
      })

      const UI = {
        root: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: '"Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif',
        },
        header: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px 6px',
        },
        titleBlock: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, marginRight: 4 },
        title: { fontSize: 19, fontWeight: 600, lineHeight: '1.15', letterSpacing: '0.02em' },
        subtitle: {
          fontSize: 11,
          lineHeight: '15px',
          color: 'var(--dsw-alias-label-tertiary)',
          whiteSpace: 'nowrap',
        },
        spacer: { flex: 1, minWidth: 8 },
        group: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
        groupLabel: {
          fontSize: 10,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--dsw-alias-label-tertiary)',
          marginRight: 1,
          whiteSpace: 'nowrap',
        },
        seg: {
          display: 'flex',
          gap: 2,
          padding: 2,
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        segButton: {
          border: 0,
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: '16px',
          padding: '4px 8px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        segButtonActive: {
          background: 'var(--dsw-alias-interactive-bg-active)',
          color: 'var(--dsw-alias-label-primary)',
          fontWeight: 600,
          boxShadow: 'inset 0 0 0 1px var(--dsw-alias-border-l1)',
        },
        button: {
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
          fontSize: 12.5,
          lineHeight: '17px',
          padding: '5px 10px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
        speedBox: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11.5,
          color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
        },
        speedValue: {
          fontVariantNumeric: 'tabular-nums',
          minWidth: 46,
          textAlign: 'right',
          color: 'var(--dsw-alias-label-tertiary)',
        },
        statusRow: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '4px 14px',
          padding: '0 12px 8px',
          minHeight: 26,
        },
        turn: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 },
        dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
        wallLine: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11.5,
          color: 'var(--dsw-alias-label-secondary)',
        },
        wallName: { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
        bars: { display: 'flex', gap: 2, alignItems: 'center' },
        bar: {
          display: 'inline-block',
          width: 6,
          height: 11,
          borderRadius: 2,
          background: 'var(--dsw-alias-border-l1)',
        },
        barRed: { background: COLOR_RED },
        barBlue: { background: COLOR_BLUE },
        distText: {
          color: 'var(--dsw-alias-label-tertiary)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        },
        thinking: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' },
        banner: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 10px',
          borderRadius: 8,
          fontWeight: 600,
          fontSize: 12.5,
          background: 'var(--dsw-alias-interactive-bg-active)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        stage: {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          margin: '0 8px 8px',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
        },
        host: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          outline: 'none',
        },
        overlay: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.38))',
        },
        panel: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          maxWidth: 320,
          padding: '18px 22px',
          textAlign: 'center',
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,0.18))',
        },
        panelTitle: { fontSize: 17, fontWeight: 600 },
        panelSub: { fontSize: 13, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
        mask: {
          position: 'absolute',
          inset: 0,
          zIndex: 20,
          padding: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))',
        },
        modal: {
          width: 'min(620px, 100%)',
          maxHeight: '86%',
          overflow: 'auto',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          boxShadow: 'var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,0.3))',
        },
        modalHead: {
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '13px 18px',
          background: 'var(--dsw-alias-bg-layer-2)',
          borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
        modalTitle: { flex: 1, fontSize: 15, fontWeight: 600 },
        modalClose: {
          border: 0,
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: 'pointer',
          fontSize: 22,
          lineHeight: 1,
          padding: '0 4px',
          borderRadius: 6,
          fontFamily: 'inherit',
        },
        modalBody: { padding: '2px 18px 20px' },
        h3: {
          fontSize: 12.5,
          letterSpacing: '0.04em',
          color: 'var(--dsw-alias-label-primary)',
          margin: '20px 0 8px',
          paddingBottom: 6,
          borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
        p: { fontSize: 13, lineHeight: '21px', color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' },
        ul: { margin: '8px 0', paddingLeft: 19 },
        li: { fontSize: 13, lineHeight: '21px', color: 'var(--dsw-alias-label-secondary)', margin: '6px 0' },
        tip: {
          fontSize: 12.5,
          lineHeight: '19px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-interactive-bg-hover)',
          borderLeft: '2px solid var(--dsw-alias-brand-primary, ' + COLOR_BLUE + ')',
          borderRadius: '0 7px 7px 0',
          padding: '9px 12px',
          margin: '10px 0',
        },
        warn: {
          fontSize: 12.5,
          lineHeight: '19px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-interactive-bg-hover)',
          borderLeft: '2px solid ' + COLOR_RED,
          borderRadius: '0 7px 7px 0',
          padding: '9px 12px',
          margin: '10px 0',
        },
        crash: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
          fontSize: 13,
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }

      const STYLE_TEXT = [
        '.dshquor-btn{transition:background-color .12s ease,opacity .12s ease}',
        '.dshquor-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}',
        '.dshquor-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dshquor-btn:disabled{opacity:.4;cursor:not-allowed}',
      ].join('\n')

      function Segmented(props) {
        return h(
          'div',
          { style: UI.seg, role: 'group', 'aria-label': props.label },
          props.options.map(function (option) {
            const active = option.value === props.value
            return h(
              'button',
              {
                key: String(option.value),
                type: 'button',
                className: 'dshquor-btn',
                'aria-pressed': active,
                style: active ? Object.assign({}, UI.segButton, UI.segButtonActive) : UI.segButton,
                onClick: function () {
                  props.onChange(option.value)
                },
              },
              option.label,
            )
          }),
        )
      }

      function WallBars(props) {
        const bars = []
        for (let i = 0; i < Q.MAX_WALLS; i += 1) {
          const filled = i < props.count
          const style = filled
            ? Object.assign({}, UI.bar, props.side === RED ? UI.barRed : UI.barBlue)
            : UI.bar
          bars.push(h('i', { key: i, style: style }))
        }
        return h('span', { style: UI.bars, 'aria-label': (props.side === RED ? '红方' : '蓝方') + '剩余 ' + props.count + ' 面墙' }, bars)
      }

      function distanceLabel(value) {
        if (value >= Q.INF) return '被困死'
        return '距终点 ' + value
      }

      function RulesModal(props) {
        function p(text) {
          return h('p', { style: UI.p }, text)
        }
        function li(key, children) {
          return h('li', { key: key, style: UI.li }, children)
        }
        return h(
          'div',
          {
            style: UI.mask,
            onMouseDown: function (event) {
              if (event.target === event.currentTarget) props.onClose()
            },
          },
          h(
            'div',
            { style: UI.modal, role: 'dialog', 'aria-modal': 'true', 'aria-label': '墙棋详细规则' },
            h(
              'div',
              { style: UI.modalHead },
              h('div', { style: UI.modalTitle }, '墙棋 Quoridor · 详细规则'),
              h(
                'button',
                { type: 'button', className: 'dshquor-btn', style: UI.modalClose, onClick: props.onClose, 'aria-label': '关闭' },
                '×',
              ),
            ),
            h(
              'div',
              { style: UI.modalBody },
              h('h3', { style: UI.h3 }, '一、棋盘与目标'),
              h('p', { style: UI.p }, '棋盘是 ', h('b', null, '9×9 的格子'), '，格子与格子之间的缝隙上可以插墙。'),
              h(
                'ul',
                { style: UI.ul },
                li('b1', [h('b', { key: 'b1a' }, '红方'), '从底边正中出发，目标是走到', h('b', { key: 'b1b' }, '最上面一行'), '。']),
                li('b2', [h('b', { key: 'b2a' }, '蓝方'), '从顶边正中出发，目标是走到', h('b', { key: 'b2b' }, '最下面一行'), '。']),
                li('b3', ['注意：不是走到某个特定格子，而是', h('b', { key: 'b3a' }, '踏上对面那一行的任意一格'), '就算到达。']),
                li('b4', ['双方轮流行动，', h('b', { key: 'b4a' }, '红方先手'), '。']),
              ),
              h('h3', { style: UI.h3 }, '二、每回合只能做一件事（二选一）'),
              h(
                'ul',
                { style: UI.ul },
                li('c1', [h('b', { key: 'c1a' }, '走子'), '：把自己的棋子往上下左右挪一格。']),
                li('c2', [h('b', { key: 'c2a' }, '放墙'), '：消耗一面墙，挡住对手的路。']),
              ),
              h('div', { style: UI.tip }, ['这两件事不能同一回合都做 —— 这是墙棋最核心的取舍：', h('b', { key: 'tip1' }, '你每放一面墙，就等于放弃一次前进'), '。']),
              h('h3', { style: UI.h3 }, '三、走子细则'),
              h(
                'ul',
                { style: UI.ul },
                li('d1', ['一次只能走一格，', h('b', { key: 'd1a' }, '不能斜着走'), '（除非触发下面的「斜跳」）。']),
                li('d2', '不能穿墙，也不能走出棋盘。'),
              ),
              p(['撞上对手怎么办？如果对手正好站在你要去的那个格子上：']),
              h(
                'ul',
                { style: UI.ul },
                li('e1', [h('b', { key: 'e1a' }, '跳过去'), '：正常情况下，你可以直接越过对手，落在它身后的一格。']),
                li('e2', [h('b', { key: 'e2a' }, '斜跳'), '：如果对手身后是墙、或者它已经贴着棋盘边，你可以', h('b', { key: 'e2b' }, '斜着跳到它两侧'), '的格子。']),
                li('e3', ['斜跳时，', h('b', { key: 'e3a' }, '对手的格子和你落点之间不能有墙'), '。']),
              ),
              h('h3', { style: UI.h3 }, '四、放墙细则'),
              h(
                'ul',
                { style: UI.ul },
                li('f1', ['每人有 ', h('b', { key: 'f1a' }, '10 面墙'), '，用完就没了，之后只能走子。']),
                li('f2', [h('b', { key: 'f2a' }, '一面墙横跨两格'), '，挡在两个相邻格子之间。']),
                li('f3', ['墙与墙', h('b', { key: 'f3a' }, '不能重叠、不能交叉'), '；但可以', h('b', { key: 'f3b' }, '首尾相接'), '——拼成更长的墙、拐个弯，或者围出一个角，都是允许的。']),
                li('f4', ['墙是', h('b', { key: 'f4a' }, '双方共用'), '的障碍物：你放的墙挡住对手，同样也挡你自己。']),
              ),
              h(
                'div',
                { style: UI.warn },
                ['⚠️ ', h('b', { key: 'warn1' }, '不能把任何一方彻底堵死。'), '放下的墙无论怎么挡，双方都必须各自至少还剩一条路能走到自己的终点。如果一面墙会把某一方完全困死，这步就是非法的 —— 界面上会显示', h('b', { key: 'warn2' }, '红色的墙预览'), '提示你放不了。'],
              ),
              h('h3', { style: UI.h3 }, '五、怎么算赢'),
              h('ul', { style: UI.ul }, li('g1', '先踏上对面那一行任意一格的一方获胜，棋局立即结束。')),
              h('h3', { style: UI.h3 }, '六、操作方式'),
              h(
                'ul',
                { style: UI.ul },
                li('h1', [h('b', { key: 'h1a' }, '点格子'), ' —— 走子。轮到你时，可走的格子上会显示小圆点。']),
                li('h2', [h('b', { key: 'h2a' }, '点格子之间的缝隙'), ' —— 放墙。会出现预览：', h('b', { key: 'h2b' }, '绿色'), '表示可以放，', h('b', { key: 'h2c' }, '红色'), '表示非法。']),
                li('h3', ['键盘 R 切换横墙 / 竖墙；U 悔棋；N 新开一局；空格暂停（仅 AI 对 AI）。']),
                li('h4', '状态栏显示双方剩余墙数和各自距离终点的最少步数。'),
              ),
              h('h3', { style: UI.h3 }, '七、一点策略'),
              h(
                'ul',
                { style: UI.ul },
                li('i1', ['墙', h('b', { key: 'i1a' }, '不是越多越好'), '，它既是武器也是消耗品。只挡一格的小便宜，往往不值得白送对手一步。']),
                li('i2', ['划算的做法是：', h('b', { key: 'i2a' }, '用最少的墙，逼对手绕最远的路'), '。把对手逼进一条长走廊，比零散地挡几下有用得多。']),
                li('i3', '别光顾着堵人 —— 墙用完以后，终究要回到「谁离终点更近」的赛跑上。堵的同时自己也要往前跑。'),
                li('i4', '残局时留意：如果对手只差一两步就赢，那这一步必须用来挡，而不是自己前进。'),
              ),
            ),
          ),
        )
      }

      const INITIAL_SNAPSHOT = {
        mode: 'pvp',
        mySide: RED,
        level: 2,
        speed: SPEED_DEFAULT,
        paused: false,
        busy: false,
        over: false,
        winner: -1,
        turn: RED,
        walls: [Q.MAX_WALLS, Q.MAX_WALLS],
        dist: [8, 8],
        histLen: 0,
        canUndo: false,
        tooSmall: false,
        failure: null,
      }

      function Game(props) {
        const rootRef = React.useRef(null)
        const hostRef = React.useRef(null)
        const gameRef = React.useRef(null)
        const [snapshot, setSnapshot] = React.useState(INITIAL_SNAPSHOT)
        const [error, setError] = React.useState(null)
        const [rulesOpen, setRulesOpen] = React.useState(false)
        const [attempt, setAttempt] = React.useState(0)

        React.useEffect(function () {
          const host = hostRef.current
          if (!host) return undefined
          let instance = null
          try {
            instance = createGame(host, {
              onState: function (next) {
                setSnapshot(next)
                setError(null)
              },
              onError: function (message) {
                setError(message)
              },
            })
            gameRef.current = instance
          } catch (createError) {
            console.error('[dsh-game-quoridor] failed to start', createError)
            setError('游戏启动失败，点「重试」重新开始。')
            return undefined
          }
          return function cleanup() {
            gameRef.current = null
            try {
              instance.destroy()
            } catch (destroyError) {
              console.error('[dsh-game-quoridor] cleanup failed', destroyError)
            }
          }
        }, [attempt])

        const call = React.useCallback(function (method, argument) {
          const instance = gameRef.current
          if (!instance) return
          try {
            instance[method](argument)
          } catch (error) {
            console.error('[dsh-game-quoridor] action failed:', method, error)
            setError('游戏遇到问题，点「重试」重新开始。')
          }
        }, [])

        const onNew = React.useCallback(function () {
          call('newGame')
        }, [call])

        const onUndo = React.useCallback(function () {
          call('undo')
        }, [call])

        const onRetry = React.useCallback(function () {
          setError(null)
          setAttempt(function (value) {
            return value + 1
          })
        }, [])

        const onKeyDown = React.useCallback(
          function (event) {
            if (rulesOpen) {
              if (event.key === 'Escape') {
                event.preventDefault()
                setRulesOpen(false)
              }
              return
            }
            const target = event.target
            const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) {
              return
            }
            const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
            if (key === 'r') {
              event.preventDefault()
              call('toggleFlip')
            } else if (key === 'u') {
              event.preventDefault()
              call('undo')
            } else if (key === 'n') {
              event.preventDefault()
              call('newGame')
            } else if ((key === ' ' || key === 'spacebar') && snapshot.mode === 'eve') {
              event.preventDefault()
              call('togglePause')
            }
          },
          [call, rulesOpen, snapshot.mode],
        )

        const mode = snapshot.mode
        const showSide = mode === 'pve'
        const showLevel = mode === 'pve'
        const showSpeed = mode !== 'pvp'
        const showPause = mode === 'eve'
        const showUndo = mode !== 'eve'
        const winnerName = snapshot.winner === RED ? '红方' : '蓝方'
        const turnColor = snapshot.turn === RED ? COLOR_RED : COLOR_BLUE
        const winnerColor = snapshot.winner === RED ? COLOR_RED : COLOR_BLUE

        return h(
          'div',
          {
            ref: rootRef,
            style: UI.root,
            tabIndex: 0,
            onKeyDown: onKeyDown,
            'data-dsh-game': GAME_ID,
          },
          h('style', null, STYLE_TEXT),
          h(
            'div',
            { style: UI.header },
            h(
              'div',
              { style: UI.titleBlock },
              h('div', { style: UI.title }, '墙棋'),
              h('div', { style: UI.subtitle }, '点格子走子 · 点缝隙放墙 · 先到对面一行者胜'),
            ),
            h('div', { style: UI.spacer }),
            h(Segmented, {
              label: '对局模式',
              options: MODE_OPTIONS,
              value: mode,
              onChange: function (value) {
                call('setMode', value)
              },
            }),
            showSide
              ? h(Segmented, {
                  label: '我执',
                  options: SIDE_OPTIONS,
                  value: snapshot.mySide,
                  onChange: function (value) {
                    call('setSide', value)
                  },
                })
              : null,
            showLevel
              ? h(Segmented, {
                  label: '难度',
                  options: LEVEL_OPTIONS,
                  value: snapshot.level,
                  onChange: function (value) {
                    call('setLevel', value)
                  },
                })
              : null,
            showSpeed
              ? h(
                  'label',
                  { style: UI.speedBox },
                  h('span', null, 'AI 节奏'),
                  h('input', {
                    type: 'range',
                    min: SPEED_MIN,
                    max: SPEED_MAX,
                    step: 50,
                    value: snapshot.speed,
                    style: { width: 84 },
                    'aria-label': 'AI 每步最小间隔',
                    onChange: function (event) {
                      call('setSpeed', Number(event.target.value))
                    },
                  }),
                  h('b', { style: UI.speedValue }, snapshot.speed + 'ms'),
                )
              : null,
            h(
              'div',
              { style: UI.group },
              showPause
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshquor-btn',
                      style: UI.button,
                      onClick: function () {
                        call('togglePause')
                      },
                    },
                    snapshot.paused ? '▶ 继续' : '⏸ 暂停',
                  )
                : null,
              showUndo
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshquor-btn',
                      style: UI.button,
                      disabled: !snapshot.canUndo,
                      onClick: onUndo,
                    },
                    '悔棋',
                  )
                : null,
              h(
                'button',
                { type: 'button', className: 'dshquor-btn', style: UI.button, onClick: onNew },
                '新开一局',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshquor-btn',
                  style: UI.button,
                  onClick: function () {
                    setRulesOpen(true)
                  },
                },
                '📖 规则',
              ),
            ),
          ),
          h(
            'div',
            { style: UI.statusRow },
            h(
              'div',
              { style: UI.turn, role: 'status' },
              h('span', {
                style: Object.assign({}, UI.dot, { background: snapshot.over ? winnerColor : turnColor }),
              }),
              h('span', null, snapshot.over ? winnerName + '获胜' : (snapshot.turn === RED ? '红方' : '蓝方') + '回合'),
            ),
            snapshot.busy && !snapshot.over ? h('span', { style: UI.thinking }, 'AI 思考中…') : null,
            snapshot.paused ? h('span', { style: UI.thinking }, '已暂停') : null,
            h(
              'div',
              { style: UI.wallLine },
              h('span', { style: UI.wallName }, '红墙'),
              h(WallBars, { side: RED, count: snapshot.walls[RED] }),
              h('span', { style: UI.distText }, distanceLabel(snapshot.dist[RED])),
            ),
            h(
              'div',
              { style: UI.wallLine },
              h('span', { style: UI.wallName }, '蓝墙'),
              h(WallBars, { side: BLUE, count: snapshot.walls[BLUE] }),
              h('span', { style: UI.distText }, distanceLabel(snapshot.dist[BLUE])),
            ),
            snapshot.over
              ? h(
                  'div',
                  { style: UI.banner },
                  winnerName + '获胜！',
                  h(
                    'button',
                    { type: 'button', className: 'dshquor-btn', style: UI.button, onClick: onNew },
                    '再来一局',
                  ),
                )
              : null,
          ),
          h(
            'div',
            { style: UI.stage },
            h('div', { ref: hostRef, style: UI.host }),
            error
              ? h(
                  'div',
                  { style: UI.overlay },
                  h(
                    'div',
                    { style: UI.panel },
                    h('div', { style: UI.panelTitle }, '游戏出错'),
                    h('div', { style: UI.panelSub }, error),
                    h(
                      'button',
                      { type: 'button', className: 'dshquor-btn', style: UI.button, onClick: onRetry },
                      '重试',
                    ),
                  ),
                )
              : null,
          ),
          rulesOpen
            ? h(RulesModal, {
                onClose: function () {
                  setRulesOpen(false)
                },
              })
            : null,
        )
      }

      class GameBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error, info) {
          console.error('[dsh-game-quoridor] component crashed', error, info)
        }

        render() {
          if (this.state.failed) {
            return h('div', { style: UI.crash }, '墙棋加载失败，请切走再重新进入「游戏」页。')
          }
          return this.props.children
        }
      }

      function GameEntry(props) {
        return h(GameBoundary, null, h(Game, props))
      }

      /* 冻结的稳定 matched 对象：避免 chain 渲染每次看到新引用。 */
      const MATCHED = Object.freeze({})

      return {
        inject: ['slots'],
        apply: function apply(ctx) {
          try {
            ctx.slots.inject('game.stage', function () {
              try {
                return ctx.slots.register(
                  {
                    name: 'game.stage',
                    id: GAME_ID,
                    label: function () {
                      return '墙棋'
                    },
                    select: function (ownerProps) {
                      return ownerProps && ownerProps.gameId === GAME_ID ? MATCHED : null
                    },
                  },
                  GameEntry,
                )
              } catch (error) {
                console.error('[dsh-game-quoridor] slot registration failed', error)
                return function () {}
              }
            })
          } catch (error) {
            console.error('[dsh-game-quoridor] slot inject failed', error)
          }
        },
      }
    },
  })
})()
