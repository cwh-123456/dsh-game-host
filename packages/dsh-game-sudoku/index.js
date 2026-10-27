/**
 * Host half of @local/dsh-game-sudoku.
 *
 * All gameplay and UI live in the Client module (`client.js`, the `game.stage`
 * slot registration). This half only gives the bundle a Cordis loader entry, so
 * it deliberately stays empty: no services, no timers, no side effects.
 */
export function apply() {}
