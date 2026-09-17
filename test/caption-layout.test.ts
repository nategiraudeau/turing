import { expect, test } from 'bun:test'
import { layoutCaptions, type CaptionEdge, type CaptionPlacement } from '../web/src/caption-layout'

const size = { width: 40, height: 18 }
const edge = (id: string, y: number): CaptionEdge => ({ id, size, curve: {
  start: { x: 80, y }, c1: { x: 160, y }, c2: { x: 240, y }, end: { x: 320, y },
} })
const overlap = (a: CaptionPlacement, b: CaptionPlacement) =>
  Math.abs(a.anchorX - b.anchorX) < (a.wrapW + b.wrapW) / 2 &&
  Math.abs(a.anchorY - b.anchorY) < (a.wrapH + b.wrapH) / 2

test('compact captions sit three pixels from an open shaft without a connector', () => {
  const p = layoutCaptions([edge('a', 100)], [], 400, 300).get('a')!
  expect(Math.abs(p.anchorY - 100)).toBeCloseTo(12)
  expect(p.anchorX).toBeCloseTo(200)
  expect(p.leader).toBe(false)
})

test('nearby parallel arrows retain their own captions without overlap', () => {
  const edges = [edge('a', 100), edge('b', 120), edge('c', 140), edge('d', 160)]
  const result = layoutCaptions(edges, [], 400, 300)
  const labels = [...result.values()]
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(overlap(labels[i], labels[j])).toBe(false)
  for (const e of edges) {
    const p = result.get(e.id)!
    expect(Math.abs(p.anchorY - e.curve.start.y)).toBeLessThanOrEqual(27)
    if (!p.leader) for (const other of edges) if (other.id !== e.id) {
      expect(Math.abs(p.anchorY - e.curve.start.y)).toBeLessThan(Math.abs(p.anchorY - other.curve.start.y))
    }
  }
})

test('slides along the curve around a state instead of drifting far away', () => {
  const p = layoutCaptions([edge('a', 100)], [{ x: 200, y: 100 }], 400, 300).get('a')!
  expect(Math.abs(p.anchorX - 200)).toBeGreaterThan(40)
  expect(Math.abs(p.anchorY - 100)).toBeCloseTo(12)
})

test('edge captions remain within a narrow viewport', () => {
  const p = layoutCaptions([edge('a', 4)], [], 375, 300).get('a')!
  expect(p.anchorY - p.wrapH / 2).toBeGreaterThanOrEqual(4)
  expect(p.anchorX + p.wrapW / 2).toBeLessThanOrEqual(371)
})

test('a stable scene produces stable placements on repeated solves', () => {
  const edges = [edge('a', 100), edge('b', 120)]
  const first = layoutCaptions(edges, [], 400, 300)
  const second = layoutCaptions(edges.map((e) => ({ ...e, previous: first.get(e.id) })), [], 400, 300)
  for (const e of edges) {
    expect(second.get(e.id)!.anchorX).toBe(first.get(e.id)!.anchorX)
    expect(second.get(e.id)!.anchorY).toBe(first.get(e.id)!.anchorY)
  }
})

test('captions clear arrowheads on nearby unlabeled edges', () => {
  const foreign = edge('unlabeled', 84)
  foreign.size = undefined
  foreign.curve = { start: { x: 200, y: 25 }, c1: { x: 200, y: 45 }, c2: { x: 200, y: 65 }, end: { x: 200, y: 84 } }
  const p = layoutCaptions([edge('a', 100), foreign], [], 400, 300).get('a')!
  const head = foreign.curve.end
  const clearance = Math.hypot(Math.max(Math.abs(head.x - p.anchorX) - p.wrapW / 2, 0), Math.max(Math.abs(head.y - p.anchorY) - p.wrapH / 2, 0))
  expect(clearance).toBeGreaterThanOrEqual(12)
})

test('previous placement yields to obstacles as the geometry moves', () => {
  let previous: CaptionPlacement | undefined
  for (const y of [100, 110, 120, 130, 140]) {
    const current = edge('a', y)
    current.previous = previous
    const obstacle = { x: 200, y: 110 }
    const p = layoutCaptions([current], [obstacle], 400, 300).get('a')!
    const clearance = Math.hypot(Math.max(Math.abs(obstacle.x - p.anchorX) - p.wrapW / 2, 0), Math.max(Math.abs(obstacle.y - p.anchorY) - p.wrapH / 2, 0))
    expect(clearance).toBeGreaterThanOrEqual(26)
    expect(p.curvePoint.y).toBeCloseTo(y)
    previous = p
  }
})
