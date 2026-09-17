import { captionCenter, type Curve, type Point } from './geometry'

export type CaptionPlacement = {
  anchorX: number; anchorY: number; wrapW: number; wrapH: number
  curveT: number; curvePoint: Point; leader: boolean
}
export type CaptionEdge = {
  id: string; curve: Curve; size?: { width: number; height: number }
  loopCenter?: Point; previous?: CaptionPlacement | null
}
type Rect = { l: number; r: number; t: number; b: number }
type Sample = Point & { t: number; length: number }
type Candidate = CaptionPlacement & { rect: Rect; cost: number }

export function curvePoint(curve: Curve, t: number): Point {
  const u = 1 - t
  return {
    x: u ** 3 * curve.start.x + 3 * u * u * t * curve.c1.x + 3 * u * t * t * curve.c2.x + t ** 3 * curve.end.x,
    y: u ** 3 * curve.start.y + 3 * u * u * t * curve.c1.y + 3 * u * t * t * curve.c2.y + t ** 3 * curve.end.y,
  }
}
function sampleCurve(curve: Curve): Sample[] {
  const samples: Sample[] = []
  let length = 0
  for (let i = 0; i <= 64; i++) {
    const point = curvePoint(curve, i / 64)
    if (i) length += Math.hypot(point.x - samples[i - 1].x, point.y - samples[i - 1].y)
    samples.push({ ...point, t: i / 64, length })
  }
  return samples
}
function distanceToRect(point: Point, rect: Rect): number {
  return Math.hypot(Math.max(rect.l - point.x, 0, point.x - rect.r), Math.max(rect.t - point.y, 0, point.y - rect.b))
}
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
function intersects(a: Point, b: Point, rect: Rect): boolean {
  let lo = 0, hi = 1
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, rect.l, rect.r], [a.y, b.y - a.y, rect.t, rect.b]]) {
    if (Math.abs(delta) < 1e-9) { if (start < min || start > max) return false; continue }
    const u = (min - start) / delta, v = (max - start) / delta
    lo = Math.max(lo, Math.min(u, v)); hi = Math.min(hi, Math.max(u, v))
    if (lo > hi) return false
  }
  return true
}
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
}
function leaderStart(placement: CaptionPlacement): Point {
  const dx = placement.curvePoint.x - placement.anchorX, dy = placement.curvePoint.y - placement.anchorY
  // A zero component must not constrain the intersection with the rectangle.
  const t = Math.min(dx ? placement.wrapW / 2 / Math.abs(dx) : Infinity, dy ? placement.wrapH / 2 / Math.abs(dy) : Infinity, 1)
  return { x: placement.anchorX + dx * t, y: placement.anchorY + dy * t }
}
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l) + 3
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t) + 3
  return w > 0 && h > 0 ? 2000 + w * h * 10 : 0
}

/** Solve measured captions together. Search along actual curve length before
 * moving outward; never let a far-away empty patch masquerade as ownership. */
export function layoutCaptions(edges: CaptionEdge[], states: Point[], width: number, height: number): Map<string, CaptionPlacement> {
  const samples = new Map(edges.map((edge) => [edge.id, sampleCurve(edge.curve)]))
  const pools = new Map<string, Candidate[]>()
  for (const edge of edges) {
    if (!edge.size) continue
    const { width: w, height: h } = edge.size
    const own = samples.get(edge.id)!
    const length = own.at(-1)!.length
    const candidates: Candidate[] = []
    // Arc-length spacing keeps long curves flexible and short loops readable.
    const steps = Math.max(8, Math.min(32, Math.ceil(length / 12)))
    for (let i = 0; i <= steps; i++) {
      const fraction = 0.16 + i / steps * 0.68
      const distance = fraction * length
      const index = Math.max(1, own.findIndex((sample) => sample.length >= distance))
      const a = own[index - 1], b = own[index]
      const blend = (distance - a.length) / (b.length - a.length || 1)
      const t = a.t + (b.t - a.t) * blend
      const point = curvePoint(edge.curve, t)
      const tangent = { x: b.x - a.x, y: b.y - a.y }
      const mag = Math.hypot(tangent.x, tangent.y) || 1
      let normal = { x: -tangent.y / mag, y: tangent.x / mag }
      if (edge.loopCenter) {
        const dx = point.x - edge.loopCenter.x, dy = point.y - edge.loopCenter.y
        const len = Math.hypot(dx, dy) || 1
        normal = { x: dx / len, y: dy / len }
      }
      for (const side of [-1, 1]) for (const gap of [3, 7, 12, 18]) {
        const center = captionCenter(point, normal, w, h, side, gap)
        // Clamping is part of scoring: it may bring text closer to a different edge.
        center.x = Math.max(w / 2 + 4, Math.min(width - w / 2 - 4, center.x))
        center.y = Math.max(h / 2 + 4, Math.min(height - h / 2 - 4, center.y))
        const rect = { l: center.x - w / 2, r: center.x + w / 2, t: center.y - h / 2, b: center.y + h / 2 }
        let cost = gap * 3 + Math.abs(fraction - 0.5) * 12
        if (edge.loopCenter && side < 0) cost += 80
        if (normal.y * side > 0) cost += 0.5
        for (const state of states) {
          const intrusion = 26 - distanceToRect(state, rect)
          if (intrusion > 0) cost += 3000 + intrusion * 100
        }
        let ownDistance = Infinity, foreignDistance = Infinity
        const tetherStart = leaderStart({ anchorX: center.x, anchorY: center.y, wrapW: w, wrapH: h, curvePoint: point, curveT: t, leader: true })
        for (const [id, line] of samples) {
          let nearest = Infinity, hits = false, tetherCrossing = false
          for (let j = 1; j < line.length; j++) {
            nearest = Math.min(nearest, distanceToSegment(center, line[j - 1], line[j]))
            hits ||= intersects(line[j - 1], line[j], rect)
            if (id !== edge.id) tetherCrossing ||= segmentsCross(tetherStart, point, line[j - 1], line[j])
          }
          // Reserve space for the arrowhead, which extends beyond the shaft.
          const headIntrusion = 12 - distanceToRect(line.at(-1)!, rect)
          if (headIntrusion > 0) cost += 3000 + headIntrusion * 100
          if (hits) cost += id === edge.id ? 2200 : 3000
          if (tetherCrossing) cost += 500
          if (id === edge.id) ownDistance = nearest
          else foreignDistance = Math.min(foreignDistance, nearest)
        }
        const ambiguous = foreignDistance < ownDistance + 6
        cost += Math.max(0, ownDistance + 6 - foreignDistance) * 40
        cost += ownDistance * 0.3
        if (edge.previous) cost += Math.min(60, Math.hypot(center.x - edge.previous.anchorX, center.y - edge.previous.anchorY)) * 0.03
        candidates.push({ anchorX: center.x, anchorY: center.y, wrapW: w, wrapH: h, curveT: t, curvePoint: point, leader: gap >= 12 || ambiguous, rect, cost })
      }
    }
    pools.set(edge.id, candidates.sort((a, b) => a.cost - b.cost))
  }
  // Place constrained edges first, then relax all labels against one another.
  const order = [...pools.keys()].sort((a, b) => pools.get(b)![0].cost - pools.get(a)![0].cost || a.localeCompare(b))
  const chosen = new Map<string, Candidate>()
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const id of order) {
      let best: Candidate | undefined, bestCost = Infinity
      for (const candidate of pools.get(id)!) {
        if (candidate.cost > bestCost) break
        let cost = candidate.cost
        for (const [other, placement] of chosen) if (other !== id) {
          cost += overlap(candidate.rect, placement.rect)
          if (candidate.leader && intersects(leaderStart(candidate), candidate.curvePoint, placement.rect)) cost += 2500
          if (placement.leader && intersects(leaderStart(placement), placement.curvePoint, candidate.rect)) cost += 2500
          if (candidate.leader && placement.leader && segmentsCross(leaderStart(candidate), candidate.curvePoint, leaderStart(placement), placement.curvePoint)) cost += 500
        }
        if (cost < bestCost) { best = candidate; bestCost = cost }
      }
      if (chosen.get(id) !== best) changed = true
      chosen.set(id, best!)
    }
    if (!changed) break
  }
  return chosen
}
