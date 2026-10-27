import { api, clientState } from './harness.mjs'

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
const cs = clientState(0, positions)
console.log('destinations source:\n' + api.destinations.toString())
console.log('keys', Object.keys(api.destinations(cs, 4)))
console.log('own dest via listMoves', api.listMoves(cs, 4).map((m) => m.x + ',' + m.y))
console.log('dest object prototype', Object.getPrototypeOf(api.destinations(cs, 4)))
