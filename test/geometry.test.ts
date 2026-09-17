import { describe, expect, test } from 'bun:test'
import { captionCenter, parseCaptionPaste, routeCost, type Curve } from '../web/src/geometry'

const straight: Curve = {
  start: { x: 40, y: 140 }, c1: { x: 140, y: 140 },
  c2: { x: 240, y: 140 }, end: { x: 340, y: 140 },
}
const bent: Curve = { ...straight, c1: { x: 140, y: 40 }, c2: { x: 240, y: 40 } }

describe('routing clearance', () => {
  test('prefers a straight line through an open corridor', () => {
    expect(routeCost(straight, [], 400, 300)).toBeLessThan(routeCost(bent, [], 400, 300))
  })
  test('prefers a bend over crossing a state', () => {
    const obstacles = [{ x: 190, y: 140 }]
    expect(routeCost(bent, obstacles, 400, 300)).toBeLessThan(routeCost(straight, obstacles, 400, 300))
  })
  test('penalizes clipping at the canvas boundary', () => {
    const clipped = { ...straight, c1: { x: 140, y: -160 }, c2: { x: 240, y: -160 } }
    expect(routeCost(clipped, [], 400, 300)).toBeGreaterThan(routeCost(bent, [], 400, 300))
  })
  test('handles a zero-length curve without NaN', () => {
    const p = { x: 60, y: 60 }
    expect(Number.isFinite(routeCost({ start: p, c1: p, c2: p, end: p }, [p], 375, 300))).toBe(true)
  })
})

describe('caption geometry and editing', () => {
  test('clears horizontal shafts equally above and below', () => {
    const p = { x: 180, y: 140 }
    const above = captionCenter(p, { x: 0, y: 1 }, 120, 42, -1, 8)
    const below = captionCenter(p, { x: 0, y: 1 }, 120, 42, 1, 8)
    expect(above.y + 21).toBe(132)
    expect(below.y - 21).toBe(148)
  })
  test('reserves width beside vertical shafts', () => {
    expect(captionCenter({ x: 180, y: 140 }, { x: 1, y: 0 }, 120, 42, 1, 8).x - 60).toBe(188)
  })
  test('accepts compact and formatted transitions', () => {
    for (const text of ['01r', '0 → 1, r', '0 -> 1, R']) {
      expect(parseCaptionPaste(text)).toEqual(['0', '1', 'R'])
    }
  })
  test('keeps incomplete pasted transitions in their respective cells', () => {
    expect(parseCaptionPaste('0')).toEqual(['0', '', ''])
    expect(parseCaptionPaste('')).toEqual(['', '', ''])
  })
})
