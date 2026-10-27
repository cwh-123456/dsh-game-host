import { api, clientState } from './harness.mjs'
import * as oracle from './oracle.mjs'

const positions = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 3, y: 0 },
  { x: 0, y: 2 },
  { x: 1, y: 2 },
  { x: 3, y: 2 },
  { x: 1, y: 4 },
  { x: 2, y: 4 },
  { x: 0, y: 4 },
  { x: 3, y: 4 },
]
const level = api.LEVELS[0]
const cs = clientState(0, positions)
const i = 4
const dest = api.destinations(cs, i)
console.log('dest keys', Object.keys(dest))
console.log('listMoves', JSON.stringify(api.listMoves(cs, i)))
console.log('oracle moves', JSON.stringify(oracle.listMoves(positions, level, i)))
console.log('canSlide down1', api.canSlide(cs, i, 0, 1, 1), 'down2', api.canSlide(cs, i, 0, 1, 2))
console.log('pieces', cs.pieces.map((p) => p.id + '@' + p.x + ',' + p.y).join(' '))
