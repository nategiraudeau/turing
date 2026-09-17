export type Point = { x: number; y: number }
export type Curve = { start: Point; c1: Point; c2: Point; end: Point }

export function captionCenter(point: Point, normal: Point, width: number, height: number, side: number, gap: number): Point {
  const clearance = Math.abs(normal.x) * width / 2 + Math.abs(normal.y) * height / 2 + gap
  return { x: point.x + normal.x * side * clearance, y: point.y + normal.y * side * clearance }
}

export function parseCaptionPaste(text: string): string[] {
  const formatted = text.trim().match(/^(.)\s*(?:→|->)\s*(.)\s*,\s*([a-z])$/i)
  const raw = formatted ? formatted.slice(1).join('') : text.trim().slice(0, 3)
  return [raw[0] ?? '', raw[1] ?? '', (raw[2] ?? '').toUpperCase()]
}

/** Score actual shaft segments, including clearance between samples. */
export function routeCost(curve: Curve, obstacles: Point[], width: number, height: number): number {
  let cost = 0
  let previous = curve.start
  for (let i = 1; i <= 64; i++) {
    const t = i / 64
    const u = 1 - t
    const point = {
      x: u ** 3 * curve.start.x + 3 * u * u * t * curve.c1.x + 3 * u * t * t * curve.c2.x + t ** 3 * curve.end.x,
      y: u ** 3 * curve.start.y + 3 * u * u * t * curve.c1.y + 3 * u * t * t * curve.c2.y + t ** 3 * curve.end.y,
    }
    const dx = point.x - previous.x
    const dy = point.y - previous.y
    const length = Math.hypot(dx, dy)
    cost += length * 0.02
    cost += Math.max(0, 8 - point.x, point.x - width + 8, 8 - point.y, point.y - height + 8) * 100
    for (const obstacle of obstacles) {
      const projection = Math.max(0, Math.min(1,
        ((obstacle.x - previous.x) * dx + (obstacle.y - previous.y) * dy) / (length * length || 1)))
      const distance = Math.hypot(obstacle.x - previous.x - projection * dx, obstacle.y - previous.y - projection * dy)
      cost += Math.max(0, 32 - distance) ** 2 * length
    }
    previous = point
  }
  return cost
}
