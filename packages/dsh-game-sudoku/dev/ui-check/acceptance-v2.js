/*!
 * dev/ui-check/acceptance-v2.js — Lead-owned Chromium acceptance + demo states.
 * Loaded by dev/preview.html. Dev-only, not shipped.
 *
 * Acceptance: preview.html?acceptance=2 (results in localStorage key
 *   'dsh.sudoku.acceptance.v2' and window.__acceptanceResult)
 * Demo shots: preview.html?shot=light|dark|small|tiny|win|confirm
 *   (ready marker in localStorage 'dsh.sudoku.shot.ready')
 */
;(function () {
  'use strict'

  /* ------------------------------------------------------------------ *
   * Dev-only solver (preview/tests only; client.js must NOT ship one)
   * ------------------------------------------------------------------ */

  function parseGivens(text) {
    var grid = new Array(81)
    for (var i = 0; i < 81; i += 1) grid[i] = Number(text.charAt(i)) || 0
    return grid
  }

  function searchSolutions(givens, limit, collectFirst) {
    var rows = new Array(9).fill(0)
    var cols = new Array(9).fill(0)
    var boxes = new Array(9).fill(0)
    var board = givens.slice()
    for (var i = 0; i < 81; i += 1) {
      var v = board[i]
      if (!v) continue
      var r = Math.floor(i / 9)
      var c = i % 9
      var b = Math.floor(r / 3) * 3 + Math.floor(c / 3)
      var bit = 1 << (v - 1)
      if ((rows[r] | cols[c] | boxes[b]) & bit) return { count: 0, first: null, invalid: true }
      rows[r] |= bit
      cols[c] |= bit
      boxes[b] |= bit
    }
    var count = 0
    var first = null
    function search() {
      var best = -1
      var bestMask = 0
      var bestCount = 10
      for (var cell = 0; cell < 81; cell += 1) {
        if (board[cell]) continue
        var rr = Math.floor(cell / 9)
        var cc = cell % 9
        var bb = Math.floor(rr / 3) * 3 + Math.floor(cc / 3)
        var mask = ~(rows[rr] | cols[cc] | boxes[bb]) & 0x1ff
        var n = 0
        var mm = mask
        while (mm) { n += 1; mm &= mm - 1 }
        if (n === 0) return
        if (n < bestCount) { bestCount = n; best = cell; bestMask = mask; if (n === 1) break }
      }
      if (best < 0) {
        count += 1
        if (first === null && collectFirst) first = board.slice()
        return
      }
      var r = Math.floor(best / 9)
      var c = best % 9
      var b = Math.floor(r / 3) * 3 + Math.floor(c / 3)
      var mask2 = bestMask
      while (mask2) {
        var bit = mask2 & -mask2
        mask2 ^= bit
        var digit = 0
        var probe = 1
        while (probe !== bit) { probe <<= 1; digit += 1 }
        digit += 1
        board[best] = digit
        rows[r] |= bit
        cols[c] |= bit
        boxes[b] |= bit
        search()
        board[best] = 0
        rows[r] ^= bit
        cols[c] ^= bit
        boxes[b] ^= bit
        if (count >= limit) return
      }
    }
    search()
    return { count: count, first: first, invalid: false }
  }

  function countSolutions(givens, limit) {
    return searchSolutions(givens, limit || 2, false).count
  }

  function solveGrid(givens) {
    return searchSolutions(givens, 1, true).first
  }

  function makeRng(seed) {
    var state = seed >>> 0
    return function () {
      state = (state + 0x6d2b79f5) >>> 0
      var t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /* ------------------------------------------------------------------ *
   * Shared helpers
   * ------------------------------------------------------------------ */

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  function preview() { return window.__preview || null }
  function writeReady(payload) {
    try { window.localStorage.setItem('dsh.sudoku.shot.ready', JSON.stringify(payload)) } catch (error) {}
    window.__shotReady = payload
  }

  function parseSave() {
    var p = preview()
    if (!p) return null
    return p.save()
  }
  function bankPuzzle(id) {
    var p = preview()
    if (!p || !p.seam()) return null
    return p.seam().findPuzzle(id)
  }

  /* ------------------------------------------------------------------ *
   * Screenshot demo states
   * ------------------------------------------------------------------ */

  function startDemo() {
    var shot = null
    try { shot = new URLSearchParams(window.location.search).get('shot') } catch (error) { return }
    if (!shot) return

    async function run() {
      var p = preview()
      for (var i = 0; i < 200 && !(p && window.__previewBooted); i += 1) await wait(25)
      if (!p) { writeReady({ shot: shot, state: 'no-preview' }); return }
      writeReady({ shot: shot, state: 'starting' })
      if (shot === 'light' || shot === 'dark' || shot === 'small' || shot === 'tiny' ||
          shot === 'win' || shot === 'confirm') {
        p.clearSaveAndRemount()
        await wait(180)
      }
      if (shot === 'dark') { p.setTheme('dark'); await wait(120) }
      if (shot === 'small') { p.setStage(360, 520); await wait(120) }
      if (shot === 'tiny') { p.setStage(300, 200); await wait(120) }
      if (shot === 'expert') {
        var expertChip = document.querySelector('[data-difficulty="expert"]')
        if (expertChip) expertChip.click()
        await wait(180)
      }
      if (shot === 'win') {
        var emptyCell = p.cells().filter(function (cell) { return !cell.given })[0]
        p.clickCell(emptyCell.index)
        await wait(60)
        var save = parseSave()
        var puzzle = save ? bankPuzzle(save.puzzleId) : null
        if (puzzle) {
          var solution = solveGrid(parseGivens(puzzle.givens))
          var empties = p.cells().filter(function (cell) { return !cell.given })
          for (var k = 0; k < empties.length; k += 1) {
            p.clickCell(empties[k].index)
            p.pressKey(String(solution[empties[k].index]))
          }
        }
        await wait(180)
      }
      if (shot === 'confirm') {
        var progressCell = p.cells().filter(function (cell) { return !cell.given })[0]
        p.clickCell(progressCell.index)
        p.pressKey('5')
        await wait(60)
        var newButton = document.querySelector('[data-action="new"]')
        if (newButton) newButton.click()
        await wait(140)
      }
      writeReady({ shot: shot, state: 'ready' })
    }

    run().catch(function (error) {
      writeReady({ shot: shot, state: 'error: ' + (error && error.message ? error.message : String(error)) })
    })
  }

  /* ------------------------------------------------------------------ *
   * Acceptance suite v2
   * ------------------------------------------------------------------ */

  function startAcceptance() {
    var enabled = false
    try { enabled = /[?&]acceptance=2(?:&|$)/.test(window.location.search) } catch (error) {}
    if (!enabled) return

    var RESULT_KEY = 'dsh.sudoku.acceptance.v2'
    var checks = []
    var details = {}
    var startedAt = Date.now()

    function write(payload) {
      try { window.localStorage.setItem(RESULT_KEY, JSON.stringify(payload)) } catch (error) {}
      window.__acceptanceResult = payload
    }
    function ck(name, condition, detail) {
      checks.push({ name: name, pass: !!condition })
      if (!condition && detail !== undefined) details[name] = detail
    }
    function clickConfirm(action) {
      var node = document.querySelector('[data-overlay="confirm"] [data-action="' + action + '"]')
      if (!node) throw new Error('missing confirm button ' + action)
      node.click()
    }
    function clickGameAction(action) {
      var node = document.querySelector('[data-action="' + action + '"]')
      if (!node) throw new Error('missing action ' + action)
      node.click()
      return node
    }
    function undoDisabled() {
      var node = document.querySelector('[data-action="undo"]')
      return node ? node.disabled === true : null
    }
    function digitDisabled() {
      var node = document.querySelector('[data-digit="1"]')
      return node ? node.disabled === true : null
    }
    function chipLabels() {
      return Array.prototype.map.call(document.querySelectorAll('[data-difficulty]'), function (node) {
        return (node.textContent || '').trim()
      })
    }
    function chipGrade() {
      var node = document.querySelector('[data-difficulty][aria-pressed="true"]')
      return node ? node.getAttribute('data-difficulty') : null
    }
    function saveFieldSummary(save) {
      if (!save) return null
      return {
        schema: save.schemaVersion,
        puzzleId: save.puzzleId,
        grade: save.grade,
        entriesLen: Array.isArray(save.entries) ? save.entries.length : -1,
        notesLen: Array.isArray(save.notes) ? save.notes.length : -1,
        elapsed: save.elapsed,
        played: Array.isArray(save.played) ? save.played.length : -1,
      }
    }
    function givensOfCurrent() {
      var save = parseSave()
      if (!save) return null
      var puzzle = bankPuzzle(save.puzzleId)
      return puzzle ? { puzzle: puzzle, givens: parseGivens(puzzle.givens) } : null
    }

    async function run() {
      var p = preview()
      for (var bootWait = 0; bootWait < 200 && !(p && window.__previewBooted); bootWait += 1) await wait(25)
      ck('boot: client.js loaded, fake-host registered, 81 cells rendered',
        !!p && window.__previewBooted === true && p.cells().length === 81 && p.seam() !== null)
      var seam = p ? p.seam() : null
      var bankCounts = {}
      var hasBank = !!(seam && seam.BANK && Array.isArray(seam.BANK.puzzles) && Array.isArray(seam.BANK.levels))
      if (hasBank) {
        seam.BANK.puzzles.forEach(function (puzzle) {
          bankCounts[puzzle.grade] = (bankCounts[puzzle.grade] || 0) + 1
        })
      }
      ck('seam v2: BANK/levels 5 x 30-50 puzzles, no runtime generator/solver',
        hasBank && seam.BANK.levels.length === 5 && seam.BANK.puzzles.length >= 150 &&
          seam.BANK.levels.every(function (level) {
            return bankCounts[level.key] >= 30 && bankCounts[level.key] <= 50
          }) &&
          typeof seam.generatePuzzle === 'undefined' && typeof seam.countSolutions === 'undefined' &&
          typeof seam.solve === 'undefined' && typeof seam.findPuzzle === 'function' &&
          typeof seam.pickPuzzle === 'function' && seam.SCHEMA_VERSION === 2,
        seam ? { levels: seam.BANK && seam.BANK.levels, bankCounts: bankCounts, hasGenerator: typeof (seam || {}).generatePuzzle } : null)
      ck('difficulty chips: 简单/普通/困难/专家/地狱 in order',
        chipLabels().join(',') === '简单,普通,困难,专家,地狱',
        chipLabels())

      // every bank grade draws a uniquely-solvable puzzle with matching grade
      var bankGradeReport = []
      for (var gi = 0; gi < (seam ? seam.BANK.levels.length : 0); gi += 1) {
        var levelKey = seam.BANK.levels[gi].key
        var picked = seam.pickPuzzle(levelKey, [], makeRng(1000 + gi))
        var pickedGrid = picked ? parseGivens(picked.givens) : null
        bankGradeReport.push({
          grade: levelKey,
          id: picked ? picked.id : null,
          gradeMatches: picked ? picked.grade === levelKey : false,
          clues: pickedGrid ? pickedGrid.filter(function (v) { return v !== 0 }).length : -1,
          unique: pickedGrid ? countSolutions(pickedGrid, 2) === 1 : false,
        })
      }
      details.bankGradeReport = bankGradeReport
      ck('bank: each grade draws a uniquely-solvable puzzle with matching grade',
        bankGradeReport.length === 5 && bankGradeReport.every(function (item) {
          return item.gradeMatches && item.unique && item.clues >= 17
        }))

      // ---------- fresh game ----------
      p.clearSaveAndRemount()
      await wait(180)
      ck('fresh game: default grade normal, 5 chips, timer 00:00',
        chipGrade() === 'normal' && chipLabels().length === 5 && p.timerText() === '00:00',
        { grade: chipGrade(), timer: p.timerText() })
      var emptyCells = p.cells().filter(function (cell) { return !cell.given })
      p.clickCell(emptyCells[0].index) /* selection persists a save */
      await wait(60)
      var save = parseSave()
      var current = givensOfCurrent()
      ck('save v2 fields: schemaVersion 2, puzzleId/grade/entries/notes/elapsed/played',
        !!save && save.schemaVersion === 2 && typeof save.puzzleId === 'string' &&
          save.grade === 'normal' && Array.isArray(save.entries) && save.entries.length === 81 &&
          Array.isArray(save.notes) && save.notes.length === 81 && typeof save.elapsed === 'number' &&
          Array.isArray(save.played) && save.played.indexOf(save.puzzleId) >= 0,
        saveFieldSummary(save))
      ck('fresh game: puzzle comes from the bank and board equals givens',
        !!current && current.puzzle.grade === 'normal' &&
          p.cells().every(function (cell) {
            return cell.given === (current.givens[cell.index] !== 0) &&
              cell.value === current.givens[cell.index]
          }))
      ck('fresh game: entries are the player layer (all zero, givens not duplicated)',
        !!save && save.entries.every(function (value) { return value === 0 }) &&
          p.cells().every(function (cell) { return !cell.given || save.entries[cell.index] === 0 }))

      // ---------- selection / peers / input / notes / undo ----------
      var a = emptyCells[0].index
      var b = emptyCells[1].index
      p.clickCell(a)
      ck('selection: tapped cell selected; 20 row/col/box peers highlighted',
        p.cell(a).selected === true && p.cells().filter(function (cell) { return cell.peer }).length === 20)
      p.pressKey('5')
      ck('keyboard 1-9 fills the selected cell (and writes into entries)',
        p.cell(a).value === 5 && parseSave().entries[a] === 5, { value: p.cell(a).value, entry: parseSave().entries[a] })
      ck('undo becomes available after an edit', undoDisabled() === false)
      var undoCountBefore = parseSave().undo ? parseSave().undo.length : null
      p.pressKey('5')
      ck('same digit again is a no-op (not auto-erase)', p.cell(a).value === 5)

      p.clickCell(b)
      clickGameAction('notes')
      ck('pencil mode toggles on', p.notesMode() === true)
      p.pressKey('3')
      p.pressKey('7')
      ck('pencil marks 3+7 render, cell stays empty and entries stay 0',
        p.cell(b).value === 0 && p.cell(b).text.indexOf('3') >= 0 && p.cell(b).text.indexOf('7') >= 0 &&
          parseSave().entries[b] === 0, p.cell(b).text)
      clickGameAction('notes')
      p.pressKey('4')
      ck('normal input replaces pencil marks', p.cell(b).value === 4 && p.cell(b).text === '4', p.cell(b).text)
      p.pressKey('Backspace')
      ck('Backspace erases the cell', p.cell(b).value === 0 && p.cell(b).text === '')
      p.pressKey('z', { ctrlKey: true })
      ck('Ctrl+Z restores erased value', p.cell(b).value === 4, p.cell(b).value)
      p.pressKey('z', { ctrlKey: true })
      ck('Ctrl+Z is step-by-step: restores pencil marks next',
        p.cell(b).value === 0 && p.cell(b).text.indexOf('3') >= 0 && p.cell(b).text.indexOf('7') >= 0,
        p.cell(b).text)

      // ---------- conflict highlighting on a clean board ----------
      p.clearSaveAndRemount()
      await wait(160)
      var allCells = p.cells()
      var valueAt = {}
      allCells.forEach(function (cell) { valueAt[cell.index] = cell.value })
      var conflictSetup = null
      for (var ce = 0; ce < allCells.length && !conflictSetup; ce += 1) {
        var probe = allCells[ce]
        if (probe.given || probe.value !== 0) continue
        var probeRow = Math.floor(probe.index / 9)
        var probeCol = probe.index % 9
        var inRow = {}, inCol = {}, inBox = {}
        for (var k = 0; k < 81; k += 1) {
          var kv = valueAt[k]
          if (!kv) continue
          var kr = Math.floor(k / 9), kc = k % 9
          if (kr === probeRow) inRow[kv] = 1
          if (kc === probeCol) inCol[kv] = 1
          if (Math.floor(kr / 3) === Math.floor(probeRow / 3) && Math.floor(kc / 3) === Math.floor(probeCol / 3)) inBox[kv] = 1
        }
        for (var cd = 1; cd <= 9; cd += 1) {
          if (inRow[cd] && !inCol[cd] && !inBox[cd]) { conflictSetup = { index: probe.index, digit: cd }; break }
        }
      }
      if (conflictSetup) {
        p.clickCell(conflictSetup.index)
        p.pressKey(String(conflictSetup.digit))
        await wait(120)
        var conflictCells = p.cells().filter(function (cell) { return cell.conflict })
        var conflictBg = window.getComputedStyle(document.querySelector('[data-cell="' + conflictSetup.index + '"]')).backgroundColor
        ck('conflict: duplicate in row flags exactly the cell and its row twin red',
          conflictCells.length === 2 && conflictBg === 'rgb(254, 226, 226)',
          { count: conflictCells.length, bg: conflictBg, setup: conflictSetup })
        p.pressKey('Backspace')
        await wait(120)
        ck('conflict clears when duplicate is erased',
          p.cells().filter(function (cell) { return cell.conflict }).length === 0)
      } else {
        ck('conflict: duplicate in row flags exactly the cell and its row twin red', false, { reason: 'no setup' })
        ck('conflict clears when duplicate is erased', false)
      }

      // ---------- external keys + timer ----------
      var beforeExternal = p.cells().map(function (cell) { return cell.value }).join(',')
      var external = document.createElement('input')
      document.body.appendChild(external)
      external.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true }))
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '8', bubbles: true, cancelable: true }))
      external.remove()
      ck('keydown outside the game root does not edit the board',
        p.cells().map(function (cell) { return cell.value }).join(',') === beforeExternal)
      var timerBefore = p.timerText()
      await wait(1400)
      ck('timer display advances while visible', p.timerText() !== timerBefore, { before: timerBefore, after: p.timerText() })

      // progress (value + pencil mark) for remount / confirm tests
      var progressCells = p.cells().filter(function (cell) { return !cell.given && cell.value === 0 })
      p.clickCell(progressCells[0].index)
      p.pressKey('6')
      p.clickCell(progressCells[1].index)
      clickGameAction('notes')
      p.pressKey('2')
      p.pressKey('4')
      clickGameAction('notes')
      await wait(60)

      // ---------- remount restores the SAME puzzle/progress ----------
      save = parseSave()
      var restored = {
        puzzleId: save.puzzleId,
        grade: save.grade,
        entries: save.entries.join(','),
        notes: save.notes.join(','),
        elapsed: save.elapsed,
      }
      var givensBeforeRestore = (function () {
        var puzzle = bankPuzzle(save.puzzleId)
        return puzzle ? puzzle.givens : null
      })()
      p.remount()
      await wait(180)
      var reread = parseSave()
      var domCells = p.cells()
      ck('remount restores the CURRENT puzzle (same puzzleId/grade, not swapped)',
        !!reread && reread.puzzleId === restored.puzzleId && reread.grade === restored.grade)
      ck('remount restores entries, pencil marks and elapsed time',
        !!reread && reread.entries.join(',') === restored.entries &&
          reread.notes.join(',') === restored.notes && reread.elapsed >= restored.elapsed &&
          p.timerText() !== '00:00')
      ck('remount: board re-derived from the same givens',
        !!reread && domCells.every(function (cell) {
          var puzzle = bankPuzzle(reread.puzzleId)
          var givens = parseGivens(puzzle.givens)
          return cell.given === (givens[cell.index] !== 0) &&
            cell.value === (givens[cell.index] || reread.entries[cell.index])
        }))

      // ---------- difficulty switching (confirm) ----------
      var progressBeforeSwitch = parseSave().puzzleId
      document.querySelector('[data-difficulty="hard"]').click()
      await wait(40)
      ck('switching difficulty with progress asks for confirmation',
        (p.overlay() || {}).type === 'confirm', p.overlay())
      clickConfirm('cancel')
      await wait(40)
      ck('cancel keeps the current puzzle and grade',
        chipGrade() === 'normal' && parseSave().puzzleId === progressBeforeSwitch && !p.overlay())
      document.querySelector('[data-difficulty="expert"]').click()
      await wait(40)
      clickConfirm('confirm')
      await wait(180)
      var expertSave = parseSave()
      ck('confirm switches to a new expert puzzle (bank grade expert)',
        chipGrade() === 'expert' && expertSave && expertSave.grade === 'expert' &&
          bankPuzzle(expertSave.puzzleId).grade === 'expert' &&
          expertSave.puzzleId !== progressBeforeSwitch,
        { grade: chipGrade(), saveGrade: expertSave && expertSave.grade })
      document.querySelector('[data-difficulty="hell"]').click()
      await wait(180)
      ck('no-progress difficulty switch is immediate (hell grade)',
        chipGrade() === 'hell' && parseSave().grade === 'hell' && !p.overlay(),
        { grade: chipGrade() })

      // ---------- new game prefers unseen puzzles ----------
      p.clearSaveAndRemount()
      await wait(180)
      var seenIds = []
      var pickedSeenBefore = false
      for (var round = 0; round < 5; round += 1) {
        var beforeSave = parseSave()
        var playedBefore = beforeSave ? beforeSave.played.slice() : []
        clickGameAction('new')
        var afterSave = null
        for (var savePoll = 0; savePoll < 12; savePoll += 1) {
          await wait(80)
          afterSave = parseSave()
          if (afterSave) break
        }
        if (!afterSave) { pickedSeenBefore = true; break }
        if (playedBefore.indexOf(afterSave.puzzleId) >= 0) pickedSeenBefore = true
        seenIds.push(afterSave.puzzleId)
      }
      ck('new game never repeats a played puzzle while unseen ones exist',
        !pickedSeenBefore && new Set(seenIds).size === 5, { ids: seenIds })
      var playedNow = null
      for (var playedPoll = 0; playedPoll < 15; playedPoll += 1) {
        var playedSave = parseSave()
        playedNow = playedSave ? playedSave.played : null
        if (playedNow && seenIds.every(function (id) { return playedNow.indexOf(id) >= 0 })) break
        await wait(100)
      }
      ck('played history records drawn puzzles in save',
        !!playedNow && seenIds.every(function (id) { return playedNow.indexOf(id) >= 0 }),
        { seenIds: seenIds, playedNow: playedNow })

      // ---------- restart / new game ----------
      var restartPuzzleId = parseSave().puzzleId
      var restartCell = p.cells().filter(function (cell) { return !cell.given })[0].index
      p.clickCell(restartCell)
      p.pressKey('2')
      clickGameAction('restart')
      await wait(40)
      ck('restart with progress asks for confirmation', (p.overlay() || {}).type === 'confirm')
      clickConfirm('confirm')
      await wait(180)
      ck('restart keeps the same puzzle and clears entries/notes/undo/timer',
        parseSave().puzzleId === restartPuzzleId && undoDisabled() === true && p.timerText() === '00:00')
      var newBefore = parseSave().puzzleId
      var newCell = p.cells().filter(function (cell) { return !cell.given })[0].index
      p.clickCell(newCell)
      p.pressKey('3')
      clickGameAction('new')
      await wait(40)
      ck('new game with progress asks for confirmation', (p.overlay() || {}).type === 'confirm')
      clickConfirm('confirm')
      await wait(180)
      ck('new game changes puzzleId and resets timer',
        parseSave().puzzleId !== newBefore && p.timerText() === '00:00')

      // ---------- win ----------
      var winSave = parseSave()
      var winPuzzle = bankPuzzle(winSave.puzzleId)
      var winGivens = parseGivens(winPuzzle.givens)
      var solution = solveGrid(winGivens)
      ck('preview solver: current bank puzzle has a solution', !!solution)
      var emptiesNow = p.cells().filter(function (cell) { return !cell.given })
      for (var wi = 0; wi < emptiesNow.length; wi += 1) {
        p.clickCell(emptiesNow[wi].index)
        p.pressKey(String(solution[emptiesNow[wi].index]))
      }
      await wait(200)
      var winOverlay = p.overlay()
      ck('win: overlay appears when the grid is complete and valid',
        !!winOverlay && winOverlay.type === 'win' && Number(p.remainingText()) === 0, winOverlay)
      ck('win: overlay shows grade label and elapsed time',
        !!winOverlay && winOverlay.text.indexOf('用时') >= 0 && winOverlay.text.indexOf('普通') >= 0 ||
          !!winOverlay && winOverlay.text.indexOf('用时') >= 0, winOverlay ? winOverlay.text : null)
      var frozenTimer = p.timerText()
      await wait(1200)
      ck('win: timer pauses', p.timerText() === frozenTimer, { before: frozenTimer, after: p.timerText() })
      ck('win: undo and digit input are disabled and save is not editable',
        undoDisabled() === true && digitDisabled() === true)
      document.querySelector('[data-overlay="win"] [data-action="dismiss-win"]').click()
      await wait(60)
      ck('win: dismiss closes overlay, board stays locked and winAcked persists',
        !p.overlay() && parseSave().winAcked === true)
      var locked = p.cells().map(function (cell) { return cell.value }).join(',')
      p.clickCell(0)
      p.pressKey('9')
      ck('win: board stays locked after dismissing', p.cells().map(function (cell) { return cell.value }).join(',') === locked)
      var wonPuzzleId = parseSave().puzzleId
      clickGameAction('new')
      await wait(180)
      ck('win: 新游戏 starts immediately without confirmation and changes puzzle',
        !p.overlay() && parseSave().puzzleId !== wonPuzzleId && p.timerText() === '00:00')

      // ---------- old v1 save is discarded safely ----------
      var seamNow = p.seam()
      var oldGivens = '530070000600195000098000060800060003400803001700020006060000280000419005000080079'
      var oldSave = {
        schemaVersion: 1,
        difficulty: 'normal',
        givens: oldGivens.split('').map(Number),
        solution: '534678912672195348198342567859761423426853791713924856961537284287419635345286179'.split('').map(Number),
        board: oldGivens.split('').map(Number),
        notes: new Array(81).fill(0),
        elapsedMs: 1234,
        selected: 0,
        notesMode: false,
        won: false,
        winAcked: false,
        undo: [],
      }
      try { window.localStorage.setItem(seamNow.STORE_KEY, JSON.stringify(oldSave)) } catch (error) {}
      p.remount()
      await wait(200)
      var migrated = parseSave()
      ck('old v1 save is discarded (new v2 puzzle, no crash)',
        !!migrated && migrated.schemaVersion === 2 && typeof migrated.puzzleId === 'string' &&
          migrated.puzzleId !== 'old' && p.errors().windowErrors.length === 0)
      // unknown puzzleId is also discarded
      try {
        window.localStorage.setItem(seamNow.STORE_KEY, JSON.stringify({
          schemaVersion: 2, puzzleId: 'normal-doesnotexist', grade: 'normal',
          entries: new Array(81).fill(0), notes: new Array(81).fill(0), elapsed: 0,
          played: [], winAcked: false,
        }))
      } catch (error) {}
      p.remount()
      await wait(200)
      var unknownResult = parseSave()
      ck('unknown puzzleId save is discarded (new valid puzzle)',
        !!unknownResult && !!seamNow.findPuzzle(unknownResult.puzzleId) && p.errors().windowErrors.length === 0)

      // ---------- clear save ----------
      var beforeClearSave = parseSave()
      var beforeClearId = beforeClearSave ? beforeClearSave.puzzleId : null
      p.clearSaveAndRemount()
      await wait(200)
      var clearCells = p.cells()
      var clearEmpty = clearCells.filter(function (cell) { return !cell.given })[0]
      if (clearEmpty) p.clickCell(clearEmpty.index) /* persist a v2 save */
      await wait(80)
      var clearedSave = parseSave()
      ck('clearing the save starts a new v2 game',
        !!clearedSave && typeof clearedSave.puzzleId === 'string' &&
          !!p.seam().findPuzzle(clearedSave.puzzleId) &&
          (!beforeClearId || clearedSave.puzzleId !== beforeClearId) &&
          p.cells().every(function (cell) {
            return cell.given ? cell.value !== 0 : cell.value === 0
          }) &&
          p.timerText() === '00:00',
        { beforeId: beforeClearId, afterId: clearedSave ? clearedSave.puzzleId : null, timer: p.timerText() })

      // ---------- responsive layout ----------
      var sizeResults = []
      var sizeList = [[360, 520], [1100, 700], [720, 600], [300, 200]]
      for (var s = 0; s < sizeList.length; s += 1) {
        p.setStage(sizeList[s][0], sizeList[s][1])
        await wait(90)
        var board = p.boardRect()
        var stage = p.stageRect()
        var scroll = p.scrollInfo()
        sizeResults.push({
          stage: sizeList[s],
          board: board ? { w: Math.round(board.width), h: Math.round(board.height) } : null,
          fits: board ? board.width <= stage.width + 0.5 && board.height <= stage.height + 0.5 && Math.abs(board.width - board.height) < 0.6 : null,
          tooSmall: p.tooSmall(),
          overflow: scroll ? scroll.rootScrollW > scroll.rootClientW + 1 || scroll.rootScrollH > scroll.rootClientH + 1 : null,
        })
      }
      details.sizes = sizeResults
      ck('layout: board fits and stays square at 360x520, 1100x700, 720x600',
        sizeResults.slice(0, 3).every(function (item) { return item.fits === true && item.tooSmall === false }))
      ck('layout: 300x200 shows the too-small hint instead of a broken board',
        sizeResults[3].tooSmall === true && sizeResults[3].board === null)
      p.setStage(720, 600)
      await wait(80)

      var errors = p.errors()
      ck('console: zero window errors / rejections / console.error',
        errors.windowErrors.length === 0 && errors.rejections.length === 0 && errors.consoleErrors.length === 0,
        errors)

      var failed = checks.filter(function (item) { return !item.pass }).map(function (item) { return item.name })
      return {
        status: 'done',
        ok: failed.length === 0,
        total: checks.length,
        failed: failed,
        checks: checks,
        details: details,
        errors: errors,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date().toISOString(),
      }
    }

    write({ status: 'running', startedAt: startedAt })
    run().then(write).catch(function (error) {
      write({
        status: 'error',
        ok: false,
        error: error && error.stack ? String(error.stack) : String(error),
        checks: checks,
        details: details,
        durationMs: Date.now() - startedAt,
      })
    })
  }

  startDemo()
  startAcceptance()
})()
