import './styles.scss'

const THEME_PREF_KEY = 'pref.txt'

/** Edit here only. Both `false` ≈ legacy routing (pre–heuristics / no dodge). */
const curveRoutingRulesEnabled = false
const obstacleAvoidanceEnabled = true

const root = document.documentElement

const storedTheme = localStorage.getItem(THEME_PREF_KEY)
if (storedTheme === 'light' || storedTheme === 'dark') {
  root.setAttribute('data-theme', storedTheme)
}

window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'd') return

  event.preventDefault()

  const current = root.getAttribute('data-theme')
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const next =
    current != null
      ? current === 'dark'
        ? 'light'
        : 'dark'
      : systemPrefersDark
        ? 'light'
        : 'dark'

  root.setAttribute('data-theme', next)
  localStorage.setItem(THEME_PREF_KEY, next)
  requestAnimationFrame(refreshVisibleArrowLabels)
})

const app = document.getElementById('app')

if (!app) {
  throw new Error('Missing #app root element')
}

/** When true, arrow / label / state hit areas are drawn for debugging (see `.tm-show-colliders` in styles). */
const SHOW_COLLIDER = false

app.className = 'tm-canvas'
app.classList.toggle('tm-show-colliders', SHOW_COLLIDER)

const SVG_NS = 'http://www.w3.org/2000/svg'
const ARROW_HEAD_LENGTH = 12
const ARROW_HEAD_HALF_WIDTH = 5
const arrowLayer = document.createElementNS(SVG_NS, 'svg')
arrowLayer.classList.add('tm-arrow-layer')
arrowLayer.setAttribute('aria-hidden', 'true')
arrowLayer.setAttribute('width', '100%')
arrowLayer.setAttribute('height', '100%')
app.appendChild(arrowLayer)

const shadow = document.createElement('div')
shadow.className = 'tm-shadow-state'
shadow.setAttribute('aria-hidden', 'true')
app.appendChild(shadow)

const STATE_RADIUS = 22
/**
 * Diagonal (non-axis-aligned) edges may use straight routing when:
 * - both sides of the chord have very little nearby mass (open corridor), or
 * - left/right crowding is nearly equal (no strong reason to bulge).
 * Weights are `1/(dist²+soften)` sums; a global total threshold was misleadingly high.
 */
/** Diagonal straight only when corridor is open and sides are balanced (both required). */
const DIAG_STRAIGHT_OPEN_PER_SIDE = 0.00014
const DIAG_STRAIGHT_MAX_IMBALANCE_RATIO = 0.038

/**
 * Short diagonals (center distance < this × GRID_SIZE) use a straight shaft when the
 * attachment segment clears third states (`straightShaftAttachmentsClearThirdStates`). Always
 * evaluated—does not depend on `curveRoutingRulesEnabled`.
 */
const SHORT_DIAG_STRAIGHT_MAX_GRID_MULTIPLIER = 2
const SHORT_DIAG_STRAIGHT_CLEAR_MARGIN = 6

/** Samples along the chord for crowding (avoids midpoint-only blind spots). */
const EDGE_CROWD_SAMPLE_TS = [0.18, 0.5, 0.82] as const

/** `computeEdgeLeanSign`: blend local crowding vs outward flow from diagram centroid. */
const LEAN_WEIGHT_CROWD = 0.52
const LEAN_WEIGHT_FLOW = 0.48

/** Single-direction edges (no reverse): lateral offset so the shaft clears other state circles. */
const DODGE_PADDING_BASE = 10
/** Scales with chord length; combined per node with `t` (see `computeDodgeNormalOffset`). */
const DODGE_PADDING_PER_LENGTH = 0.072
/** Endpoints still get strong clearance; middle gets a small extra boost. */
const DODGE_PADDING_ALONG_MIN_BLEND = 0.9
const DODGE_PADDING_ALONG_MAX_BLEND = 1
const DODGE_GAIN = 1.05
/** Base cap; long chords use `max(this, chordLen * DODGE_MAX_OFFSET_PER_CHORD_LEN)`. */
const MAX_DODGE_NORMAL_OFFSET = 80
const DODGE_MAX_OFFSET_PER_CHORD_LEN = 0.32
/**
 * Quadratic lateral displacement at parameter u is ~2·u·(1−u)·|controlOffset| from the chord.
 * Near u≈0 or 1 that factor is tiny, so we scale required penetration (endpoint obstacles need
 * larger control offsets). Floor avoids divide blow-ups.
 */
const DODGE_SHAPE_FLOOR = 0.044
const DODGE_MAX_SHAPE_SCALE = 24
/** Blends toward 1 so endpoint scaling is helpful but less drastic than raw `shapeScale`. */
const DODGE_SHAPE_ATTENUATION = 0.68

const GRID_SIZE = 140
const GRID_OFFSET = GRID_SIZE / 2
const LEASH_RADIUS = 12
const LAG_FACTOR = 0.18
const GRID_BOX_SCALE = 0.98

/** Max characters for an arrow transition label. */
const ARROW_LABEL_MAX_LEN = 3

/** When the label is full length, force the third character to A–Z if the user typed a–z. */
const applyArrowLabelThirdCharUppercase = (value: string): string => {
  if (value.length !== ARROW_LABEL_MAX_LEN) return value
  const third = value[2]
  if (third >= 'a' && third <= 'z') {
    return value.slice(0, 2) + third.toUpperCase()
  }
  return value
}

/** Padding (px) around the label field bbox; adds to the arrow shaft collider when the label is shown. */
const ARROW_LABEL_COLLIDER_INSET = 10

/**
 * Dynamic placement scoring: candidates are built from
 *   (t along the curve) × (side of the curve normal) × (perpendicular gap, px).
 * The lowest-scoring candidate wins. The defaults at the front are cheapest - they only get rejected
 * when something is in the way, so a free arrow lands at `t≈0.5, gap≈26`.
 */
const ARROW_LABEL_T_OPTIONS = [0.5, 0.44, 0.56, 0.36, 0.64, 0.28, 0.72, 0.2, 0.8] as const
const ARROW_LABEL_LOOP_T_OPTIONS = [0.5, 0.44, 0.56, 0.38, 0.62] as const
const ARROW_LABEL_SIDE_OPTIONS = [-1, 1] as const
const ARROW_LABEL_GAP_OPTIONS = [18, 26, 36, 50, 68, 88] as const
const ARROW_LABEL_LOOP_GAP_OPTIONS = [10, 16, 24, 36, 52] as const

/** Min reserved label bbox; ensures a 1-char label still reserves room for the eventual 3-char width. */
const ARROW_LABEL_RESERVED_MIN_W = 64
const ARROW_LABEL_RESERVED_MIN_H = 30

/** Matches `--arrow-label-extra-lift` in styles.scss. Wrap is translated up by this much. */
const ARROW_LABEL_EXTRA_LIFT_PX = 1.5

/** Penalty buffers for each obstacle class (px beyond the contour where score starts climbing). */
const ARROW_LABEL_STATE_BUFFER = 8
const ARROW_LABEL_FROMTO_BUFFER = 4
const ARROW_LABEL_LABEL_BUFFER = 8
const ARROW_LABEL_EDGE_BUFFER = 8

/** The label may tilt a little toward its owning arrow, but never enough to feel like rotated UI chrome. */
const ARROW_LABEL_MAX_ROTATION_DEG = 18
const ARROW_LABEL_ROTATION_DEADBAND_DEG = 4

/**
 * In-development later feature: connector/leader lines are intentionally disabled for now.
 * The production behavior should be self-evident without them: proximity, local rotation, and obstacle-aware
 * placement must make ownership clear even in busy diagrams. Keep this false until the line design is tested.
 */
const ARROW_LABEL_LEADER_ENABLED = false

/** Bezier sampling for "nearest owning arrow" and arrow-shaft overlap tests. */
const ARROW_LABEL_NEAREST_SAMPLES = 48
const ARROW_LABEL_ARROW_SAMPLES = 28

/** In-development leader-line constants. Kept with the disabled feature for later iteration. */
const ARROW_LABEL_LEADER_HANDLE_FRAC = 0.45
const ARROW_LABEL_LEADER_HANDLE_MIN = 8
const ARROW_LABEL_LEADER_HANDLE_MAX = 32
const ARROW_LABEL_LEADER_MIN_LEN = 3

app.style.setProperty('--arrow-label-collider-inset', `${ARROW_LABEL_COLLIDER_INSET}px`)

let nextStateId = 1

let targetX = 0
let targetY = 0
let shadowX = 0
let shadowY = 0
let hasPointer = false
let lastPointerClientX = 0
let lastPointerClientY = 0
let hasPointerPosition = false
/** Set when pointerdown blurs an arrow label; next click must not place nodes / edit states. */
let suppressCanvasClickAfterArrowLabelBlur = false

const syncArrowHoverShadow = (target: EventTarget | null) => {
  if (!(target instanceof Element)) {
    shadow.classList.remove('is-hover-arrow')
    return
  }
  const hit = target.closest(
    '.tm-arrow-collider:not(.is-draft), .tm-arrow-label-collider:not(.is-draft), .tm-arrow-label',
  )
  if (hit) shadow.classList.add('is-hover-arrow')
  else shadow.classList.remove('is-hover-arrow')
}

type Point = {
  x: number
  y: number
}

type ArrowCurve = {
  start: Point
  c1: Point
  c2: Point
  end: Point
}

type ArrowShape = {
  collider: SVGPathElement
  /** Hit + debug rect: label field footprint + inset, unioned with `collider` when label is visible. */
  labelCollider: SVGRectElement
  path: SVGPathElement
  head: SVGPolygonElement
  /** Cubic bezier that re-ties an offset label to its arrow: underline → nearest point on shaft. */
  labelLeader: SVGPathElement
}

/** Anchor + reserved size of a placed label. Anchor is where wrap.style.left/top go; after the
 *  `translate(-50%, -100% - lift)` transform, the wrap's bottom-center lands at the anchor. */
type LabelPlacement = {
  anchorX: number
  anchorY: number
  rotateDeg: number
  wrapW: number
  wrapH: number
}

type StoredArrow = {
  fromId: string
  toId: string
  shape: ArrowShape
  targetCurve: ArrowCurve
  currentCurve: ArrowCurve
  /** Shown after first click on this arrow's collider; removed when the arrow is deleted. */
  label: string
  /** Wrapper: inset padding + `data-arrow-*` so label hits merge with arrow collider handling. */
  labelWrap: HTMLDivElement | null
  /** Three one-character cells; displayed with → and , between (see `.tm-arrow-label-fmt`). */
  labelInputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement] | null
  labelVisible: boolean
  /** Cached: where the wrap sits (anchor) and its reserved size. Set by `placeArrowLabel`. */
  labelPlacement: LabelPlacement | null
}

type DraftArrow = {
  fromId: string
  shape: ArrowShape
  targetCurve: ArrowCurve
  currentCurve: ArrowCurve
  targetStateId: string | null
}

let draftArrow: DraftArrow | null = null
const arrows: StoredArrow[] = []

const findStoredArrowFromHitTarget = (target: Element | null): StoredArrow | null => {
  if (!target) return null
  const svgHit = target.closest(
    '.tm-arrow-collider:not(.is-draft), .tm-arrow-label-collider:not(.is-draft)',
  )
  if (svgHit instanceof SVGElement) {
    const fromId = svgHit.dataset.arrowFrom
    const toId = svgHit.dataset.arrowTo
    if (fromId && toId) {
      return arrows.find((a) => a.fromId === fromId && a.toId === toId) ?? null
    }
  }
  const labelHit = target.closest('.tm-arrow-label')
  if (labelHit instanceof HTMLElement && labelHit.dataset.arrowFrom && labelHit.dataset.arrowTo) {
    const fromId = labelHit.dataset.arrowFrom
    const toId = labelHit.dataset.arrowTo
    return arrows.find((a) => a.fromId === fromId && a.toId === toId) ?? null
  }
  return null
}

const setShadowPosition = (x: number, y: number) => {
  shadow.style.left = `${x}px`
  shadow.style.top = `${y}px`
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const computeGridGeometry = (width: number, height: number) => {
  const paddedWidth = width * GRID_BOX_SCALE
  const paddedHeight = height * GRID_BOX_SCALE
  const insetX = Math.min(paddedWidth / 2, Math.max(STATE_RADIUS, GRID_OFFSET))
  const insetY = Math.min(paddedHeight / 2, Math.max(STATE_RADIUS, GRID_OFFSET))
  const cols = Math.max(1, Math.floor((paddedWidth - 2 * insetX) / GRID_SIZE) + 1)
  const rows = Math.max(1, Math.floor((paddedHeight - 2 * insetY) / GRID_SIZE) + 1)
  const gridWidth = cols === 1 ? 2 * insetX : 2 * insetX + (cols - 1) * GRID_SIZE
  const gridHeight = rows === 1 ? 2 * insetY : 2 * insetY + (rows - 1) * GRID_SIZE
  const originX = (width - gridWidth) / 2
  const originY = (height - gridHeight) / 2
  const firstX = cols === 1 ? originX + gridWidth / 2 : originX + insetX
  const firstY = rows === 1 ? originY + gridHeight / 2 : originY + insetY

  return { cols, rows, firstX, firstY }
}

const initialRect = app.getBoundingClientRect()
const frozenGridGeometry = computeGridGeometry(initialRect.width, initialRect.height)

const getGridPoint = (clientX: number, clientY: number) => {
  const rect = app.getBoundingClientRect()
  const { cols, rows, firstX, firstY } = frozenGridGeometry
  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const col = cols === 1 ? 0 : clamp(Math.round((localX - firstX) / GRID_SIZE), 0, cols - 1)
  const row = rows === 1 ? 0 : clamp(Math.round((localY - firstY) / GRID_SIZE), 0, rows - 1)
  const x = cols === 1 ? firstX : firstX + col * GRID_SIZE
  const y = rows === 1 ? firstY : firstY + row * GRID_SIZE
  return { x, y, localX, localY }
}

const updateShadowTarget = (clientX: number, clientY: number) => {
  const { x, y, localX, localY } = getGridPoint(clientX, clientY)
  const dx = localX - x
  const dy = localY - y
  const distance = Math.hypot(dx, dy)
  const leashScale = distance > LEASH_RADIUS ? LEASH_RADIUS / distance : 1

  targetX = x + dx * leashScale
  targetY = y + dy * leashScale
}

const gridKey = (x: number, y: number) => `${x},${y}`

const isOccupied = (x: number, y: number) =>
  app.querySelector(`.tm-state[data-grid="${gridKey(x, y)}"]`) !== null

const pointOnCircle = (center: Point, toward: Point, radius: number): Point => {
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  const distance = Math.hypot(dx, dy)
  if (distance < 0.001) {
    return { x: center.x + radius, y: center.y }
  }
  return {
    x: center.x + (dx / distance) * radius,
    y: center.y + (dy / distance) * radius,
  }
}

const getStateCenter = (stateEl: HTMLElement): Point => {
  const x = Number(stateEl.dataset.x)
  const y = Number(stateEl.dataset.y)
  return { x, y }
}

const createArrowShape = (): ArrowShape => {
  const collider = document.createElementNS(SVG_NS, 'path')
  collider.classList.add('tm-arrow-collider')
  const labelCollider = document.createElementNS(SVG_NS, 'rect')
  labelCollider.classList.add('tm-arrow-label-collider')
  const path = document.createElementNS(SVG_NS, 'path')
  path.classList.add('tm-arrow-path')
  const head = document.createElementNS(SVG_NS, 'polygon')
  head.classList.add('tm-arrow-head')
  const labelLeader = document.createElementNS(SVG_NS, 'path')
  labelLeader.classList.add('tm-arrow-label-leader')
  arrowLayer.appendChild(collider)
  arrowLayer.appendChild(labelCollider)
  arrowLayer.appendChild(path)
  arrowLayer.appendChild(head)
  arrowLayer.appendChild(labelLeader)
  return { collider, labelCollider, path, head, labelLeader }
}

const removeArrowShape = (shape: ArrowShape) => {
  shape.collider.remove()
  shape.labelCollider.remove()
  shape.path.remove()
  shape.head.remove()
  shape.labelLeader.remove()
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))

const cubicBezierPoint = (curve: ArrowCurve, tRaw: number): Point => {
  const t = clamp01(tRaw)
  const u = 1 - t
  const tt = t * t
  const uu = u * u
  const uuu = uu * u
  const ttt = tt * t

  return {
    x:
      uuu * curve.start.x +
      3 * uu * t * curve.c1.x +
      3 * u * tt * curve.c2.x +
      ttt * curve.end.x,
    y:
      uuu * curve.start.y +
      3 * uu * t * curve.c1.y +
      3 * u * tt * curve.c2.y +
      ttt * curve.end.y,
  }
}

const cubicBezierTangent = (curve: ArrowCurve, tRaw: number): Point => {
  const t = clamp01(tRaw)
  const u = 1 - t
  return {
    x:
      3 * u * u * (curve.c1.x - curve.start.x) +
      6 * u * t * (curve.c2.x - curve.c1.x) +
      3 * t * t * (curve.end.x - curve.c2.x),
    y:
      3 * u * u * (curve.c1.y - curve.start.y) +
      6 * u * t * (curve.c2.y - curve.c1.y) +
      3 * t * t * (curve.end.y - curve.c2.y),
  }
}

/** Unit-length normal at curve(t). Falls back to (0,-1) if the tangent is degenerate. */
const curveUnitNormal = (curve: ArrowCurve, t: number): Point => {
  const tan = cubicBezierTangent(curve, t)
  const m = Math.hypot(tan.x, tan.y)
  if (m < 0.001) return { x: 0, y: -1 }
  return { x: -tan.y / m, y: tan.x / m }
}

/** Coarse sample + golden-section refine for the closest point on a cubic to `p`. */
const nearestPointOnCubic = (
  curve: ArrowCurve,
  p: Point,
): { point: Point; t: number; tangent: Point } => {
  let bestT = 0
  let bestD2 = Infinity
  for (let i = 0; i <= ARROW_LABEL_NEAREST_SAMPLES; i++) {
    const t = i / ARROW_LABEL_NEAREST_SAMPLES
    const pt = cubicBezierPoint(curve, t)
    const d2 = (pt.x - p.x) ** 2 + (pt.y - p.y) ** 2
    if (d2 < bestD2) {
      bestD2 = d2
      bestT = t
    }
  }
  let lo = Math.max(0, bestT - 1 / ARROW_LABEL_NEAREST_SAMPLES)
  let hi = Math.min(1, bestT + 1 / ARROW_LABEL_NEAREST_SAMPLES)
  for (let i = 0; i < 16; i++) {
    const a = lo + (hi - lo) * 0.382
    const b = lo + (hi - lo) * 0.618
    const pa = cubicBezierPoint(curve, a)
    const pb = cubicBezierPoint(curve, b)
    const da = (pa.x - p.x) ** 2 + (pa.y - p.y) ** 2
    const db = (pb.x - p.x) ** 2 + (pb.y - p.y) ** 2
    if (da < db) hi = b
    else lo = a
  }
  const t = (lo + hi) / 2
  return {
    point: cubicBezierPoint(curve, t),
    t,
    tangent: cubicBezierTangent(curve, t),
  }
}

type LabelRect = { l: number; t: number; r: number; b: number }

type LabelCandidate = LabelPlacement & {
  bbox: LabelRect
  center: Point
  curvePoint: Point
  curveT: number
  gap: number
  isLoop: boolean
  side: 1 | -1
}

const distancePointToRect = (p: Point, rect: LabelRect): number => {
  const dx = Math.max(rect.l - p.x, 0, p.x - rect.r)
  const dy = Math.max(rect.t - p.y, 0, p.y - rect.b)
  return Math.hypot(dx, dy)
}

const pointInsideRect = (p: Point, rect: LabelRect, pad = 0): boolean =>
  p.x >= rect.l - pad &&
  p.x <= rect.r + pad &&
  p.y >= rect.t - pad &&
  p.y <= rect.b + pad

const rectsIntersect = (a: LabelRect, b: LabelRect, buffer = 0): boolean =>
  !(a.r + buffer < b.l || b.r + buffer < a.l || a.b + buffer < b.t || b.b + buffer < a.t)

const rectIntersectionArea = (a: LabelRect, b: LabelRect): number => {
  const w = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l))
  const h = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t))
  return w * h
}

const orientation = (a: Point, b: Point, c: Point): number =>
  (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)

const rangesOverlap = (a: number, b: number, c: number, d: number): boolean =>
  Math.max(Math.min(a, b), Math.min(c, d)) <= Math.min(Math.max(a, b), Math.max(c, d))

const segmentsIntersect = (a: Point, b: Point, c: Point, d: Point): boolean => {
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  if (Math.abs(o1) < 1e-8 && Math.abs(o2) < 1e-8 && Math.abs(o3) < 1e-8 && Math.abs(o4) < 1e-8) {
    return rangesOverlap(a.x, b.x, c.x, d.x) && rangesOverlap(a.y, b.y, c.y, d.y)
  }
  return o1 * o2 <= 0 && o3 * o4 <= 0
}

const segmentIntersectsRect = (a: Point, b: Point, rect: LabelRect): boolean => {
  if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true
  const tl = { x: rect.l, y: rect.t }
  const tr = { x: rect.r, y: rect.t }
  const br = { x: rect.r, y: rect.b }
  const bl = { x: rect.l, y: rect.b }
  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  )
}

const normalizeLabelAngleDeg = (rawDeg: number): number => {
  let deg = rawDeg
  while (deg > 90) deg -= 180
  while (deg < -90) deg += 180
  if (Math.abs(deg) < ARROW_LABEL_ROTATION_DEADBAND_DEG) return 0
  return clamp(deg, -ARROW_LABEL_MAX_ROTATION_DEG, ARROW_LABEL_MAX_ROTATION_DEG)
}

const labelGeometryForPlacement = (
  anchorX: number,
  anchorY: number,
  wrapW: number,
  wrapH: number,
  rotateDeg: number,
): { bbox: LabelRect; center: Point } => {
  const angle = (rotateDeg * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const pivot = { x: anchorX, y: anchorY - ARROW_LABEL_EXTRA_LIFT_PX }
  const localCorners = [
    { x: -wrapW / 2, y: -wrapH },
    { x: wrapW / 2, y: -wrapH },
    { x: wrapW / 2, y: 0 },
    { x: -wrapW / 2, y: 0 },
  ]
  const corners = localCorners.map((p) => ({
    x: pivot.x + p.x * cos - p.y * sin,
    y: pivot.y + p.x * sin + p.y * cos,
  }))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  return {
    bbox: {
      l: Math.min(...xs),
      t: Math.min(...ys),
      r: Math.max(...xs),
      b: Math.max(...ys),
    },
    center: {
      x: corners.reduce((sum, p) => sum + p.x, 0) / corners.length,
      y: corners.reduce((sum, p) => sum + p.y, 0) / corners.length,
    },
  }
}

/** Reconstructs another label's reserved bbox from its cached placement (no DOM read). */
const getCachedLabelRect = (other: StoredArrow): LabelRect | null => {
  if (!other.labelVisible || !other.labelPlacement) return null
  const { anchorX, anchorY, wrapW, wrapH, rotateDeg } = other.labelPlacement
  return labelGeometryForPlacement(anchorX, anchorY, wrapW, wrapH, rotateDeg).bbox
}

const distanceToCurveSamples = (curve: ArrowCurve, p: Point): number => {
  let best = Infinity
  for (let i = 0; i <= ARROW_LABEL_ARROW_SAMPLES; i++) {
    const t = i / ARROW_LABEL_ARROW_SAMPLES
    const pt = cubicBezierPoint(curve, t)
    best = Math.min(best, Math.hypot(pt.x - p.x, pt.y - p.y))
  }
  return best
}

const isLoopArrow = (arrow: StoredArrow) => arrow.fromId === arrow.toId

const loopOutwardUnit = (arrow: StoredArrow, curvePoint: Point, fallback: Point): Point => {
  const state = getStateById(arrow.fromId)
  if (!(state instanceof HTMLElement)) return fallback
  const c = getStateCenter(state)
  const dx = curvePoint.x - c.x
  const dy = curvePoint.y - c.y
  const m = Math.hypot(dx, dy)
  return m > 0.001 ? { x: dx / m, y: dy / m } : fallback
}

const buildLabelCandidate = (
  arrow: StoredArrow,
  wrapW: number,
  wrapH: number,
  t: number,
  side: 1 | -1,
  gap: number,
): LabelCandidate => {
  const curvePoint = cubicBezierPoint(arrow.targetCurve, t)
  const normal = curveUnitNormal(arrow.targetCurve, t)
  const isLoop = isLoopArrow(arrow)
  const placementVector = isLoop ? loopOutwardUnit(arrow, curvePoint, normal) : normal
  const underlineX = curvePoint.x + placementVector.x * side * gap
  const underlineY = curvePoint.y + placementVector.y * side * gap
  const anchorX = underlineX
  const anchorY = underlineY + ARROW_LABEL_EXTRA_LIFT_PX + ARROW_LABEL_COLLIDER_INSET
  const nearest = nearestPointOnCubic(arrow.targetCurve, { x: underlineX, y: underlineY })
  const rotateDeg = normalizeLabelAngleDeg((Math.atan2(nearest.tangent.y, nearest.tangent.x) * 180) / Math.PI)
  const { bbox, center } = labelGeometryForPlacement(anchorX, anchorY, wrapW, wrapH, rotateDeg)
  return {
    anchorX,
    anchorY,
    rotateDeg,
    wrapW,
    wrapH,
    bbox,
    center,
    curvePoint,
    curveT: t,
    gap,
    isLoop,
    side,
  }
}

const clampLabelCandidateToApp = (
  candidate: LabelCandidate,
  appW: number,
  appH: number,
): LabelCandidate => {
  let dx = 0
  let dy = 0
  if (candidate.bbox.l < ARROW_LABEL_EDGE_BUFFER) dx = ARROW_LABEL_EDGE_BUFFER - candidate.bbox.l
  if (candidate.bbox.r > appW - ARROW_LABEL_EDGE_BUFFER) {
    dx = Math.min(dx, appW - ARROW_LABEL_EDGE_BUFFER - candidate.bbox.r)
  }
  if (candidate.bbox.t < ARROW_LABEL_EDGE_BUFFER) dy = ARROW_LABEL_EDGE_BUFFER - candidate.bbox.t
  if (candidate.bbox.b > appH - ARROW_LABEL_EDGE_BUFFER) {
    dy = Math.min(dy, appH - ARROW_LABEL_EDGE_BUFFER - candidate.bbox.b)
  }
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return candidate

  const anchorX = candidate.anchorX + dx
  const anchorY = candidate.anchorY + dy
  const { bbox, center } = labelGeometryForPlacement(
    anchorX,
    anchorY,
    candidate.wrapW,
    candidate.wrapH,
    candidate.rotateDeg,
  )
  return {
    ...candidate,
    anchorX,
    anchorY,
    bbox,
    center,
  }
}

const scoreLabelCandidate = (
  arrow: StoredArrow,
  candidate: LabelCandidate,
  appW: number,
  appH: number,
): number => {
  const { bbox, center, curveT, gap, isLoop, side } = candidate
  let score = 0

  // 1. Canvas edges (hard: never let the label clip off-screen).
  const eb = ARROW_LABEL_EDGE_BUFFER
  if (bbox.l < eb) score += (eb - bbox.l) * 100
  if (bbox.t < eb) score += (eb - bbox.t) * 100
  if (bbox.r > appW - eb) score += (bbox.r - (appW - eb)) * 100
  if (bbox.b > appH - eb) score += (bbox.b - (appH - eb)) * 100

  // 2. State circles. Endpoint states get a lighter buffer; self-loops keep the apex legible.
  for (const stateEl of app.querySelectorAll('.tm-state')) {
    if (!(stateEl instanceof HTMLElement)) continue
    const c = getStateCenter(stateEl)
    const sid = getStateId(stateEl)
    const isEndpoint = sid === arrow.fromId || sid === arrow.toId
    const buffer = isEndpoint ? ARROW_LABEL_FROMTO_BUFFER : ARROW_LABEL_STATE_BUFFER
    const d = distancePointToRect(c, bbox)
    const radius = STATE_RADIUS + buffer
    if (d < radius) {
      const over = radius - d
      score += over * (isEndpoint ? (isLoop ? 24 : 2) : 16)
    }
  }

  // 3. Own arrow and other arrows must not pass under the input. Other nearby arrows also erode ownership.
  const ownerDistance = distanceToCurveSamples(arrow.targetCurve, center)
  for (const other of arrows) {
    const isOwner = other === arrow
    let arrowHitsLabel = 0
    let arrowNearLabel = 0
    let prev = cubicBezierPoint(other.targetCurve, 0)
    for (let i = 1; i <= ARROW_LABEL_ARROW_SAMPLES; i++) {
      const t = i / ARROW_LABEL_ARROW_SAMPLES
      const pt = cubicBezierPoint(other.targetCurve, t)
      if (segmentIntersectsRect(prev, pt, bbox) || pointInsideRect(pt, bbox, 1)) arrowHitsLabel += 1
      else {
        const d = distancePointToRect(pt, bbox)
        if (d < 8) arrowNearLabel += 8 - d
      }
      prev = pt
    }
    if (isOwner) {
      score += arrowHitsLabel * 55 + arrowNearLabel * 4
      continue
    }
    score += arrowHitsLabel * 85 + arrowNearLabel * 7
    const otherDistance = distanceToCurveSamples(other.targetCurve, center)
    if (otherDistance < ownerDistance + 10) {
      score += (ownerDistance + 10 - otherDistance) * 4
    }
  }

  // 4. Other visible labels.
  for (const other of arrows) {
    if (other === arrow) continue
    const obox = getCachedLabelRect(other)
    if (!obox) continue
    if (rectsIntersect(obox, bbox, ARROW_LABEL_LABEL_BUFFER)) {
      score += 22 + rectIntersectionArea(obox, bbox) * 0.08
    }
  }

  // 5. Soft preferences: close to its arrow, near curve midpoint, and only gently rotated.
  score += gap * (isLoop ? 0.04 : 0.09)
  score += Math.abs(curveT - 0.5) * (isLoop ? 3 : 8)
  score += Math.abs(candidate.rotateDeg) * 0.12
  if (isLoop && side < 0) score += 20

  return score
}

/** Picks the lowest-cost placement, writes anchor/rotation to CSS, and caches the choice. */
const placeArrowLabel = (arrow: StoredArrow) => {
  if (!arrow.labelWrap || !arrow.labelVisible) return

  const previousRotate = arrow.labelWrap.style.getPropertyValue('--arrow-label-rotate')
  arrow.labelWrap.style.setProperty('--arrow-label-rotate', '0deg')
  const wrapRect = arrow.labelWrap.getBoundingClientRect()
  if (previousRotate) arrow.labelWrap.style.setProperty('--arrow-label-rotate', previousRotate)
  const wrapW = Math.max(wrapRect.width, ARROW_LABEL_RESERVED_MIN_W)
  const wrapH = Math.max(wrapRect.height, ARROW_LABEL_RESERVED_MIN_H)

  const appRect = app.getBoundingClientRect()
  const appW = appRect.width
  const appH = appRect.height

  let best: { candidate: LabelCandidate; score: number } | null = null
  const tOptions = isLoopArrow(arrow) ? ARROW_LABEL_LOOP_T_OPTIONS : ARROW_LABEL_T_OPTIONS
  const gapOptions = isLoopArrow(arrow) ? ARROW_LABEL_LOOP_GAP_OPTIONS : ARROW_LABEL_GAP_OPTIONS
  const sideOptions = isLoopArrow(arrow) ? ([1, -1] as const) : ARROW_LABEL_SIDE_OPTIONS

  for (const t of tOptions) {
    for (const side of sideOptions) {
      for (const gap of gapOptions) {
        const candidate = clampLabelCandidateToApp(
          buildLabelCandidate(arrow, wrapW, wrapH, t, side, gap),
          appW,
          appH,
        )
        const score = scoreLabelCandidate(arrow, candidate, appW, appH)
        if (best === null || score < best.score) best = { candidate, score }
      }
    }
  }

  if (!best) return

  const { candidate } = best
  arrow.labelPlacement = {
    anchorX: candidate.anchorX,
    anchorY: candidate.anchorY,
    rotateDeg: candidate.rotateDeg,
    wrapW,
    wrapH,
  }
  arrow.labelWrap.style.left = `${candidate.anchorX}px`
  arrow.labelWrap.style.top = `${candidate.anchorY}px`
  arrow.labelWrap.style.setProperty('--arrow-label-rotate', `${candidate.rotateDeg}deg`)
  updateArrowLabelLeader(arrow)
}

/**
 * Draws the leader: a cubic bezier whose tangent is perpendicular to the underline at p0 and
 * perpendicular to the arrow's local tangent at p3 (nearest point on `currentCurve`). The
 * underline endpoint slides horizontally along the underline toward the arrow, so the leader
 * never reads as crossing the field. Re-run each animation frame so the arrow-side endpoint
 * tracks the animated `currentCurve`.
 */
const updateArrowLabelLeader = (arrow: StoredArrow) => {
  const leader = arrow.shape.labelLeader
  if (!ARROW_LABEL_LEADER_ENABLED) {
    leader.classList.remove('is-visible')
    leader.removeAttribute('d')
    return
  }

  const placement = arrow.labelPlacement
  if (!arrow.labelVisible || !placement) {
    leader.classList.remove('is-visible')
    leader.removeAttribute('d')
    return
  }

  const { anchorX, anchorY, wrapW } = placement
  const wrapPad = ARROW_LABEL_COLLIDER_INSET
  // Underline = bottom edge of the field, which is the wrap's bottom minus its padding.
  const underlineY = anchorY - ARROW_LABEL_EXTRA_LIFT_PX - wrapPad
  const fieldLeftX = anchorX - wrapW / 2 + wrapPad
  const fieldRightX = anchorX + wrapW / 2 - wrapPad

  const first = nearestPointOnCubic(arrow.currentCurve, { x: anchorX, y: underlineY })
  const attachX = clamp(first.point.x, fieldLeftX + 2, fieldRightX - 2)
  const refined = nearestPointOnCubic(arrow.currentCurve, { x: attachX, y: underlineY })

  const p0 = { x: attachX, y: underlineY }
  const p3 = refined.point
  const dx = p3.x - p0.x
  const dy = p3.y - p0.y
  const len = Math.hypot(dx, dy)
  if (len < ARROW_LABEL_LEADER_MIN_LEN) {
    leader.classList.remove('is-visible')
    leader.removeAttribute('d')
    return
  }

  // Underline normal points toward the arrow. The underline is horizontal in screen space.
  const ulSign = dy >= 0 ? 1 : -1
  const ulNormal: Point = { x: 0, y: ulSign }

  // Arrow normal at p3, flipped to point toward p0 (out of the arrow into the label).
  const tan = refined.tangent
  const tMag = Math.hypot(tan.x, tan.y)
  let arrowNormal: Point =
    tMag > 0.001 ? { x: -tan.y / tMag, y: tan.x / tMag } : { x: 0, y: -ulSign }
  if ((p0.x - p3.x) * arrowNormal.x + (p0.y - p3.y) * arrowNormal.y < 0) {
    arrowNormal = { x: -arrowNormal.x, y: -arrowNormal.y }
  }

  const handle = clamp(
    len * ARROW_LABEL_LEADER_HANDLE_FRAC,
    ARROW_LABEL_LEADER_HANDLE_MIN,
    ARROW_LABEL_LEADER_HANDLE_MAX,
  )
  const p1 = { x: p0.x + ulNormal.x * handle, y: p0.y + ulNormal.y * handle }
  const p2 = { x: p3.x + arrowNormal.x * handle, y: p3.y + arrowNormal.y * handle }

  leader.setAttribute(
    'd',
    `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`,
  )
  leader.dataset.arrowFrom = arrow.fromId
  leader.dataset.arrowTo = arrow.toId
  leader.classList.add('is-visible')
}

/** Per-frame cheap update: reuse cached placement, only re-trace the leader against `currentCurve`. */
const positionArrowLabel = (arrow: StoredArrow) => {
  if (!arrow.labelWrap || !arrow.labelVisible) return
  if (!arrow.labelPlacement) {
    placeArrowLabel(arrow)
    return
  }
  arrow.labelWrap.style.left = `${arrow.labelPlacement.anchorX}px`
  arrow.labelWrap.style.top = `${arrow.labelPlacement.anchorY}px`
  arrow.labelWrap.style.setProperty('--arrow-label-rotate', `${arrow.labelPlacement.rotateDeg}deg`)
  updateArrowLabelLeader(arrow)
}

const syncArrowLabelFromInputs = (arrow: StoredArrow) => {
  const ins = arrow.labelInputs
  if (!ins) return
  let s = ins[0].value + ins[1].value + ins[2].value
  if (s.length === ARROW_LABEL_MAX_LEN) {
    const normalized = applyArrowLabelThirdCharUppercase(s)
    if (normalized !== s) {
      ins[2].value = normalized[2] ?? ''
      s = normalized
    }
  }
  arrow.label = s
}

const pushLabelToInputs = (arrow: StoredArrow) => {
  const ins = arrow.labelInputs
  if (!ins) return
  const raw = arrow.label.slice(0, ARROW_LABEL_MAX_LEN)
  for (let i = 0; i < ARROW_LABEL_MAX_LEN; i++) {
    ins[i].value = raw[i] ?? ''
  }
  syncArrowLabelFromInputs(arrow)
}

const focusArrowLabelField = (arrow: StoredArrow) => {
  const ins = arrow.labelInputs
  if (!ins) return
  const idx = ins.findIndex((el) => !el.value)
  ins[idx === -1 ? 0 : idx].focus()
}

const ensureArrowLabelInput = (arrow: StoredArrow) => {
  if (arrow.labelInputs && arrow.labelWrap) return

  const wrap = document.createElement('div')
  wrap.className = 'tm-arrow-label'
  const field = document.createElement('div')
  field.className = 'tm-arrow-label-field'
  field.setAttribute('role', 'group')
  field.setAttribute('aria-label', 'Arrow transition label')

  const sepArrow = document.createElement('span')
  sepArrow.className = 'tm-arrow-label-fmt'
  sepArrow.setAttribute('aria-hidden', 'true')
  sepArrow.textContent = '→'
  const sepComma = document.createElement('span')
  sepComma.className = 'tm-arrow-label-fmt'
  sepComma.setAttribute('aria-hidden', 'true')
  sepComma.textContent = ','

  const inputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement] = [
    document.createElement('input'),
    document.createElement('input'),
    document.createElement('input'),
  ]

  inputs.forEach((el, index) => {
    el.type = 'text'
    el.className = 'tm-arrow-label-input'
    el.maxLength = 1
    el.inputMode = 'text'
    el.autocomplete = 'off'
    el.spellcheck = false
    el.dataset.index = String(index)

    const normalizeCellAndSync = (): string => {
      let v = el.value
      if (v.length > 1) v = v.slice(-1)
      el.value = v
      syncArrowLabelFromInputs(arrow)
      return v
    }

    const maybeAdvanceToNext = (v: string) => {
      if (v.length === 1 && index < ARROW_LABEL_MAX_LEN - 1) {
        arrow.labelInputs![index + 1].focus()
      }
    }

    el.addEventListener('input', (ev) => {
      if ((ev as InputEvent).isComposing) return
      maybeAdvanceToNext(normalizeCellAndSync())
    })

    el.addEventListener('compositionend', () => {
      maybeAdvanceToNext(normalizeCellAndSync())
    })

    el.addEventListener('keydown', (e) => {
      const ins = arrow.labelInputs
      if (!ins) return

      if (e.key === 'Backspace') {
        const focusPrevCaretEnd = () => {
          if (index <= 0) return
          const prev = ins[index - 1]
          prev.focus()
          requestAnimationFrame(() => {
            const len = prev.value.length
            prev.setSelectionRange(len, len)
          })
        }

        if (el.value === '') {
          e.preventDefault()
          focusPrevCaretEnd()
          return
        }
        if (el.value.length === 1) {
          e.preventDefault()
          el.value = ''
          syncArrowLabelFromInputs(arrow)
          requestAnimationFrame(() => el.setSelectionRange(0, 0))
          return
        }
      }

      if (e.key === 'ArrowLeft' && el.selectionStart === 0 && index > 0) {
        ins[index - 1].focus()
        e.preventDefault()
      }
      if (e.key === 'ArrowRight' && el.selectionStart === el.value.length && index < ARROW_LABEL_MAX_LEN - 1) {
        ins[index + 1].focus()
        e.preventDefault()
      }
    })
  })

  field.appendChild(inputs[0])
  field.appendChild(sepArrow)
  field.appendChild(inputs[1])
  field.appendChild(sepComma)
  field.appendChild(inputs[2])

  field.addEventListener('paste', (e) => {
    e.preventDefault()
    const t = e.clipboardData?.getData('text/plain') ?? ''
    const raw = t.slice(0, ARROW_LABEL_MAX_LEN)
    for (let i = 0; i < ARROW_LABEL_MAX_LEN; i++) {
      inputs[i].value = raw[i] ?? ''
    }
    syncArrowLabelFromInputs(arrow)
    const focusIdx = Math.min(Math.max(0, raw.length), ARROW_LABEL_MAX_LEN - 1)
    inputs[focusIdx].focus()
  })

  wrap.appendChild(field)
  app.appendChild(wrap)

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.classList.contains('tm-arrow-label-input')) return
    const stack =
      typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(e.clientX, e.clientY)
        : []
    const hit = stack.find(
      (node): node is HTMLInputElement =>
        node instanceof HTMLInputElement && node.classList.contains('tm-arrow-label-input'),
    )
    if (hit) {
      hit.focus()
      requestAnimationFrame(() => {
        const len = hit.value.length
        hit.setSelectionRange(len, len)
      })
      return
    }
    focusArrowLabelField(arrow)
  })

  arrow.labelWrap = wrap
  arrow.labelInputs = inputs
  pushLabelToInputs(arrow)
}

const showArrowLabel = (arrow: StoredArrow) => {
  ensureArrowLabelInput(arrow)
  arrow.labelVisible = true
  arrow.labelWrap?.classList.add('is-visible')
  placeArrowLabel(arrow)
  if (arrow.labelWrap instanceof HTMLElement) {
    arrow.labelWrap.dataset.arrowFrom = arrow.fromId
    arrow.labelWrap.dataset.arrowTo = arrow.toId
  }
  focusArrowLabelField(arrow)
  requestAnimationFrame(() => updateLabelColliderRect(arrow))
}

const removeArrowLabelEl = (arrow: StoredArrow) => {
  arrow.labelWrap?.style.removeProperty('--arrow-label-rotate')
  arrow.labelWrap?.remove()
  arrow.labelWrap = null
  arrow.labelInputs = null
  arrow.labelVisible = false
  arrow.labelPlacement = null
  arrow.shape.labelLeader.classList.remove('is-visible')
  arrow.shape.labelLeader.removeAttribute('d')
  updateLabelColliderRect(arrow)
}

const setArrowHead = (head: SVGPolygonElement, tip: Point, tangent: Point) => {
  const mag = Math.hypot(tangent.x, tangent.y)
  const ux = mag > 0.001 ? tangent.x / mag : 1
  const uy = mag > 0.001 ? tangent.y / mag : 0
  const bx = tip.x - ux * ARROW_HEAD_LENGTH
  const by = tip.y - uy * ARROW_HEAD_LENGTH
  const nx = -uy
  const ny = ux
  const lx = bx + nx * ARROW_HEAD_HALF_WIDTH
  const ly = by + ny * ARROW_HEAD_HALF_WIDTH
  const rx = bx - nx * ARROW_HEAD_HALF_WIDTH
  const ry = by - ny * ARROW_HEAD_HALF_WIDTH
  head.setAttribute('points', `${tip.x},${tip.y} ${lx},${ly} ${rx},${ry}`)
}

const buildLoopCurve = (center: Point, angle: number = -Math.PI / 2): ArrowCurve => {
  // Your original angles were -32 and -148, which is exactly +/- 58 degrees from -90.
  const spreadOffset = (58 * Math.PI) / 180 
  const startAngle = angle + spreadOffset
  const endAngle = angle - spreadOffset

  const start = {
    x: center.x + STATE_RADIUS * Math.cos(startAngle),
    y: center.y + STATE_RADIUS * Math.sin(startAngle),
  }
  const end = {
    x: center.x + STATE_RADIUS * Math.cos(endAngle),
    y: center.y + STATE_RADIUS * Math.sin(endAngle),
  }

  // Find the unit vectors for the direction we are pointing, and the 90-degree perpendicular
  const forwardX = Math.cos(angle)
  const forwardY = Math.sin(angle)
  const perpX = -Math.sin(angle) // Equivalent to cos(angle + 90deg)
  const perpY = Math.cos(angle)  // Equivalent to sin(angle + 90deg)

  // Use the exact proportions from your original code (3.6 and 2.5)
  const forwardDist = STATE_RADIUS * 3.6
  const perpDist = STATE_RADIUS * 2.5

  const c1 = {
    x: center.x + forwardX * forwardDist + perpX * perpDist,
    y: center.y + forwardY * forwardDist + perpY * perpDist,
  }
  const c2 = {
    x: center.x + forwardX * forwardDist - perpX * perpDist,
    y: center.y + forwardY * forwardDist - perpY * perpDist,
  }

  return { start, c1, c2, end }
}

const quadraticToCubic = (start: Point, control: Point, end: Point): ArrowCurve => ({
  start,
  c1: {
    x: start.x + ((control.x - start.x) * 2) / 3,
    y: start.y + ((control.y - start.y) * 2) / 3,
  },
  c2: {
    x: end.x + ((control.x - end.x) * 2) / 3,
    y: end.y + ((control.y - end.y) * 2) / 3,
  },
  end,
})

const pointToSegmentDist = (
  p: Point,
  a: Point,
  b: Point,
): { dist: number; closest: Point; t: number } => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y
  const len2 = abx * abx + aby * aby
  if (len2 < 1e-18) {
    return { dist: Math.hypot(p.x - a.x, p.y - a.y), closest: { ...a }, t: 0 }
  }
  const t = clamp((apx * abx + apy * aby) / len2, 0, 1)
  const cx = a.x + t * abx
  const cy = a.y + t * aby
  return { dist: Math.hypot(p.x - cx, p.y - cy), closest: { x: cx, y: cy }, t }
}

const quadraticPoint = (t: number, s: Point, ctrl: Point, e: Point): Point => {
  const u = 1 - t
  return {
    x: u * u * s.x + 2 * u * t * ctrl.x + t * t * e.x,
    y: u * u * s.y + 2 * u * t * ctrl.y + t * t * e.y,
  }
}

/** Min distance from p to a quadratic Bezier (uniform samples); used for angled-shaft dodge. */
const minDistToQuadratic = (
  p: Point,
  s: Point,
  ctrl: Point,
  e: Point,
  steps = 28,
): { dist: number; closest: Point; t: number } => {
  let best = Infinity
  let bestPt = s
  let bestT = 0
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const q = quadraticPoint(t, s, ctrl, e)
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d < best) {
      best = d
      bestPt = { ...q }
      bestT = t
    }
  }
  return { dist: best, closest: bestPt, t: bestT }
}

/**
 * Signed offset along the shaft normal: pushes the quadratic control so the stroke
 * clears other states. Uses attachment points on the circles (actual shaft), not
 * center-to-center. For curved single-direction edges, clearance uses distance to the
 * bent quadratic (pre-dodge control), not only the chord.
 */
const computeDodgeNormalOffset = (
  fromId: string,
  toId: string,
  fromCenter: Point,
  toCenter: Point,
  shaft: 'straight' | 'curved',
  leanSign: 1 | -1,
): number => {
  const start = pointOnCircle(fromCenter, toCenter, STATE_RADIUS)
  const end = pointOnCircle(toCenter, fromCenter, STATE_RADIUS)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chordLen = Math.hypot(dx, dy)
  if (chordLen < 0.001) return 0

  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const nx = -dy / chordLen
  const ny = dx / chordLen
  const curvature = Math.min(90, Math.max(26, chordLen * 0.22))
  const quadCtrl: Point =
    shaft === 'curved'
      ? {
          x: mid.x + nx * curvature * leanSign,
          y: mid.y + ny * curvature * leanSign,
        }
      : mid

  let offset = 0

  for (const el of app.querySelectorAll('.tm-state')) {
    if (!(el instanceof HTMLElement)) continue
    const id = getStateId(el)
    if (id === fromId || id === toId) continue
    const c = getStateCenter(el)

    let dist: number
    let closest: Point
    let tAlong: number

    if (shaft === 'straight') {
      const seg = pointToSegmentDist(c, start, end)
      dist = seg.dist
      closest = seg.closest
      tAlong = seg.t
    } else {
      const q = minDistToQuadratic(c, start, quadCtrl, end)
      dist = q.dist
      closest = q.closest
      tAlong = q.t
    }

    const alongSpan = 4 * tAlong * (1 - tAlong)
    const lengthBlend =
      DODGE_PADDING_ALONG_MIN_BLEND +
      (DODGE_PADDING_ALONG_MAX_BLEND - DODGE_PADDING_ALONG_MIN_BLEND) * alongSpan
    const extraPadding =
      DODGE_PADDING_BASE + chordLen * DODGE_PADDING_PER_LENGTH * lengthBlend
    const clearance = STATE_RADIUS + extraPadding
    if (dist >= clearance) continue

    const penetration = clearance - dist
    const cross = dx * (c.y - closest.y) - dy * (c.x - closest.x)
    let side: number
    if (Math.abs(cross) < 1e-8) {
      side = c.x + c.y >= closest.x + closest.y ? 1 : -1
    } else {
      side = Math.sign(cross)
    }
    const shape = 2 * tAlong * (1 - tAlong)
    const shapeScale = Math.min(
      1 / Math.max(shape, DODGE_SHAPE_FLOOR),
      DODGE_MAX_SHAPE_SCALE,
    )
    const effectiveShapeScale =
      1 + (shapeScale - 1) * DODGE_SHAPE_ATTENUATION
    const penetrationScaled = penetration * DODGE_GAIN * effectiveShapeScale
    if (side > 0) offset -= penetrationScaled
    else offset += penetrationScaled
  }

  const maxDodge = Math.max(
    MAX_DODGE_NORMAL_OFFSET,
    chordLen * DODGE_MAX_OFFSET_PER_CHORD_LEN,
  )
  return clamp(offset, -maxDodge, maxDodge)
}

const buildStraightCurve = (from: Point, to: Point, dodgeNormalOffset = 0): ArrowCurve => {
  const start = pointOnCircle(from, to, STATE_RADIUS)
  const end = pointOnCircle(to, from, STATE_RADIUS)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const nx = length > 0.001 ? -dy / length : 0
  const ny = length > 0.001 ? dx / length : -1
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const control = {
    x: mid.x + nx * dodgeNormalOffset,
    y: mid.y + ny * dodgeNormalOffset,
  }
  return quadraticToCubic(start, control, end)
}

const buildCurvedCurveWithSign = (
  from: Point,
  to: Point,
  sign: 1 | -1,
  dodgeNormalOffset = 0,
): ArrowCurve => {
  const start = pointOnCircle(from, to, STATE_RADIUS)
  const end = pointOnCircle(to, from, STATE_RADIUS)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const nx = length > 0.001 ? -dy / length : 0
  const ny = length > 0.001 ? dx / length : -1
  const curvature = Math.min(90, Math.max(26, length * 0.22))
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const control = {
    x: mid.x + nx * (curvature * sign + dodgeNormalOffset),
    y: mid.y + ny * (curvature * sign + dodgeNormalOffset),
  }
  return quadraticToCubic(start, control, end)
}

const buildParallelPairCurve = (
  from: Point,
  to: Point,
  anchorSide: 1 | -1,
  curveSide: 1 | -1,
): ArrowCurve => {
  const baseAngle = Math.atan2(to.y - from.y, to.x - from.x)
  const stemOffset = (24 * Math.PI) / 180
  const startAngle = baseAngle + anchorSide * stemOffset
  const endAngle = baseAngle + Math.PI - anchorSide * stemOffset
  const start = {
    x: from.x + STATE_RADIUS * Math.cos(startAngle),
    y: from.y + STATE_RADIUS * Math.sin(startAngle),
  }
  const end = {
    x: to.x + STATE_RADIUS * Math.cos(endAngle),
    y: to.y + STATE_RADIUS * Math.sin(endAngle),
  }

  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const nx = length > 0.001 ? -dy / length : 0
  const ny = length > 0.001 ? dx / length : -1
  const curvature = Math.min(52, Math.max(12, length * 0.13))
  const control = {
    x: (start.x + end.x) / 2 + nx * curvature * curveSide,
    y: (start.y + end.y) / 2 + ny * curvature * curveSide,
  }

  return quadraticToCubic(start, control, end)
}

const buildDraftToPointCurve = (from: Point, pointer: Point): ArrowCurve => {
  const start = pointOnCircle(from, pointer, STATE_RADIUS)
  const end = pointer
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const nx = length > 0.001 ? -dy / length : 0
  const ny = length > 0.001 ? dx / length : -1
  const curvature = Math.min(72, Math.max(20, length * 0.18))
  const control = {
    x: (start.x + end.x) / 2 + nx * curvature,
    y: (start.y + end.y) / 2 + ny * curvature,
  }
  return quadraticToCubic(start, control, end)
}

const buildStraightToPointCurve = (from: Point, to: Point): ArrowCurve => {
  const start = pointOnCircle(from, to, STATE_RADIUS)
  const end = to
  const control = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  }
  return quadraticToCubic(start, control, end)
}

const cloneCurve = (curve: ArrowCurve): ArrowCurve => ({
  start: { ...curve.start },
  c1: { ...curve.c1 },
  c2: { ...curve.c2 },
  end: { ...curve.end },
})

const lerp = (from: number, to: number, t: number) => from + (to - from) * t

const lerpPoint = (from: Point, to: Point, t: number): Point => ({
  x: lerp(from.x, to.x, t),
  y: lerp(from.y, to.y, t),
})

const lerpCurve = (from: ArrowCurve, to: ArrowCurve, t: number): ArrowCurve => ({
  start: lerpPoint(from.start, to.start, t),
  c1: lerpPoint(from.c1, to.c1, t),
  c2: lerpPoint(from.c2, to.c2, t),
  end: lerpPoint(from.end, to.end, t),
})

const renderArrowShape = (shape: ArrowShape, curve: ArrowCurve) => {
  shape.path.setAttribute(
    'd',
    `M ${curve.start.x} ${curve.start.y} C ${curve.c1.x} ${curve.c1.y} ${curve.c2.x} ${curve.c2.y} ${curve.end.x} ${curve.end.y}`,
  )
  setArrowHead(shape.head, curve.end, {
    x: curve.end.x - curve.c2.x,
    y: curve.end.y - curve.c2.y,
  })
}

/** Collider uses the target curve only; it does not interpolate with arrow animation. */
const renderArrowCollider = (shape: ArrowShape, curve: ArrowCurve) => {
  shape.collider.setAttribute(
    'd',
    `M ${curve.start.x} ${curve.start.y} C ${curve.c1.x} ${curve.c1.y} ${curve.c2.x} ${curve.c2.y} ${curve.end.x} ${curve.end.y}`,
  )
}

const updateLabelColliderRect = (arrow: StoredArrow) => {
  const rect = arrow.shape.labelCollider
  rect.dataset.arrowFrom = arrow.fromId
  rect.dataset.arrowTo = arrow.toId

  if (!arrow.labelVisible || !arrow.labelWrap) {
    rect.classList.remove('has-label')
    rect.setAttribute('x', '0')
    rect.setAttribute('y', '0')
    rect.setAttribute('width', '0')
    rect.setAttribute('height', '0')
    if (arrow.labelWrap instanceof HTMLElement) {
      delete arrow.labelWrap.dataset.arrowFrom
      delete arrow.labelWrap.dataset.arrowTo
    }
    return
  }

  if (arrow.labelWrap instanceof HTMLElement) {
    arrow.labelWrap.dataset.arrowFrom = arrow.fromId
    arrow.labelWrap.dataset.arrowTo = arrow.toId
  }

  const appRect = app.getBoundingClientRect()
  const labelRect = arrow.labelWrap.getBoundingClientRect()
  const x = labelRect.left - appRect.left
  const y = labelRect.top - appRect.top
  const w = Math.max(0, labelRect.width)
  const h = Math.max(0, labelRect.height)
  rect.setAttribute('x', String(x))
  rect.setAttribute('y', String(y))
  rect.setAttribute('width', String(w))
  rect.setAttribute('height', String(h))
  rect.classList.add('has-label')
}

const getStateId = (stateEl: HTMLElement) => stateEl.dataset.stateId ?? ''

const getStateById = (stateId: string): HTMLElement | null =>
  app.querySelector(`.tm-state[data-state-id="${stateId}"]`)

/** Average of all state centers; used for outward-flow curve bias. */
const getDiagramCentroid = (): Point => {
  let sx = 0
  let sy = 0
  let n = 0
  for (const el of app.querySelectorAll('.tm-state')) {
    if (!(el instanceof HTMLElement)) continue
    const c = getStateCenter(el)
    sx += c.x
    sy += c.y
    n++
  }
  if (n === 0) return { x: 0, y: 0 }
  return { x: sx / n, y: sy / n }
}

const isAxisAligned = (from: Point, to: Point) =>
  Math.abs(from.x - to.x) < 0.001 || Math.abs(from.y - to.y) < 0.001

const hasReverseArrow = (fromId: string, toId: string) =>
  arrows.some((arrow) => arrow.fromId === toId && arrow.toId === fromId)

const hasArrow = (fromId: string, toId: string) =>
  arrows.some((arrow) => arrow.fromId === fromId && arrow.toId === toId)

const hasReverseArrowWithVirtual = (
  fromId: string,
  toId: string,
  virtualArrow: { fromId: string; toId: string } | null,
) => {
  if (hasReverseArrow(fromId, toId)) return true
  return (
    virtualArrow !== null &&
    virtualArrow.fromId === toId &&
    virtualArrow.toId === fromId
  )
}

/**
 * Per-side mass along the chord: multi-sample along the segment (not only the midpoint),
 * inverse distance² to the chord, plus other transitions as light point masses.
 */
const getEdgeCrowdingForSegment = (
  fromId: string,
  toId: string,
  fromCenter: Point,
  toCenter: Point,
  virtualArrow: { fromId: string; toId: string } | null,
): { crowdingPos: number; crowdingNeg: number } => {
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  const length = Math.hypot(dx, dy)
  if (length < 0.001) return { crowdingPos: 0, crowdingNeg: 0 }

  const nx = -dy / length
  const ny = dx / length
  const len2 = length * length
  const onLineEps = STATE_RADIUS * 0.12
  const soften = (STATE_RADIUS * 2.2) ** 2

  const addMass = (
    px: number,
    py: number,
    weightScale: number,
    mx: number,
    my: number,
  ): { pos: number; neg: number } => {
    const vx = px - mx
    const vy = py - my
    const s = vx * nx + vy * ny
    const t = clamp((vx * dx + vy * dy) / len2, 0, 1)
    const projX = fromCenter.x + t * dx
    const projY = fromCenter.y + t * dy
    const dist2 = (px - projX) ** 2 + (py - projY) ** 2
    const w = weightScale / (dist2 + soften)
    if (Math.abs(s) < onLineEps) {
      return { pos: w * 0.5, neg: w * 0.5 }
    }
    if (s > 0) {
      return { pos: w, neg: 0 }
    }
    return { pos: 0, neg: w }
  }

  const averageSidesForPoint = (
    px: number,
    py: number,
    weightScale: number,
  ) => {
    let pos = 0
    let neg = 0
    for (const t of EDGE_CROWD_SAMPLE_TS) {
      const mx = fromCenter.x + t * dx
      const my = fromCenter.y + t * dy
      const { pos: p, neg: n } = addMass(px, py, weightScale, mx, my)
      pos += p
      neg += n
    }
    const nSamples = EDGE_CROWD_SAMPLE_TS.length
    return { pos: pos / nSamples, neg: neg / nSamples }
  }

  let crowdingPos = 0
  let crowdingNeg = 0

  for (const el of app.querySelectorAll('.tm-state')) {
    if (!(el instanceof HTMLElement)) continue
    const id = getStateId(el)
    if (id === fromId || id === toId) continue
    const c = getStateCenter(el)
    const { pos, neg } = averageSidesForPoint(c.x, c.y, 1)
    crowdingPos += pos
    crowdingNeg += neg
  }

  for (const a of arrows) {
    if (a.fromId === fromId && a.toId === toId) continue
    const fs = getStateById(a.fromId)
    const ts = getStateById(a.toId)
    if (!(fs instanceof HTMLElement) || !(ts instanceof HTMLElement)) continue
    const fc = getStateCenter(fs)
    const tc = getStateCenter(ts)
    const { pos, neg } = averageSidesForPoint((fc.x + tc.x) / 2, (fc.y + tc.y) / 2, 0.45)
    crowdingPos += pos
    crowdingNeg += neg
  }

  if (virtualArrow) {
    const same =
      virtualArrow.fromId === fromId && virtualArrow.toId === toId
    if (!same) {
      const vfs = getStateById(virtualArrow.fromId)
      const vts = getStateById(virtualArrow.toId)
      if (vfs instanceof HTMLElement && vts instanceof HTMLElement) {
        const vfc = getStateCenter(vfs)
        const vtc = getStateCenter(vts)
        const { pos, neg } = averageSidesForPoint(
          (vfc.x + vtc.x) / 2,
          (vfc.y + vtc.y) / 2,
          0.45,
        )
        crowdingPos += pos
        crowdingNeg += neg
      }
    }
  }

  return { crowdingPos, crowdingNeg }
}

/**
 * Combine local clearance (which side is emptier) with outward bias from the diagram
 * centroid so edges tend to sweep around the cluster instead of cutting through it.
 */
const computeEdgeLeanSign = (
  fromCenter: Point,
  toCenter: Point,
  crowdingPos: number,
  crowdingNeg: number,
  diagramCentroid: Point,
  dx: number,
  dy: number,
): 1 | -1 => {
  const fallback = (Math.sign(dx * dy) || 1) as 1 | -1
  const length = Math.hypot(dx, dy)
  if (length < 0.001) return fallback

  const nx = -dy / length
  const ny = dx / length
  const mx = (fromCenter.x + toCenter.x) / 2
  const my = (fromCenter.y + toCenter.y) / 2

  const total = crowdingPos + crowdingNeg
  const crowdNorm =
    total > 1e-12 ? (crowdingNeg - crowdingPos) / total : 0

  const rx = mx - diagramCentroid.x
  const ry = my - diagramCentroid.y
  const rmag = Math.hypot(rx, ry)
  let flowNorm = 0
  if (rmag > 8) {
    flowNorm = (nx * rx + ny * ry) / rmag
  }

  const blend =
    LEAN_WEIGHT_CROWD * crowdNorm + LEAN_WEIGHT_FLOW * flowNorm

  if (Math.abs(blend) < 0.04) {
    if (Math.abs(crowdingNeg - crowdingPos) > 1e-12) {
      return (crowdingNeg > crowdingPos ? 1 : -1) as 1 | -1
    }
    if (rmag > 8) {
      return (flowNorm >= 0 ? 1 : -1) as 1 | -1
    }
    return fallback
  }
  return (blend > 0 ? 1 : -1) as 1 | -1
}

const getOptimalLoopAngle = (stateId: string, center: Point): number => {
  const connectedArrows = arrows.filter(
    (a) => (a.fromId === stateId || a.toId === stateId) && a.fromId !== a.toId
  )

  // 1. Default for isolated nodes
  if (connectedArrows.length === 0) return -Math.PI / 2

  const angles: number[] = []
  let sumX = 0
  let sumY = 0

  connectedArrows.forEach((a) => {
    const otherId = a.fromId === stateId ? a.toId : a.fromId
    const otherState = getStateById(otherId)
    if (!otherState) return
    const oc = getStateCenter(otherState)
    
    const dx = oc.x - center.x
    const dy = oc.y - center.y
    const mag = Math.hypot(dx, dy)
    if (mag < 0.001) return

    sumX += dx / mag
    sumY += dy / mag

    let ang = Math.atan2(dy, dx)
    if (ang < 0) ang += 2 * Math.PI
    angles.push(ang)
  })

  // 2. Identify all "Safe Zones" (Gaps)
  angles.sort((a, b) => a - b)
  let gaps: { center: number; size: number }[] = []

  for (let i = 0; i < angles.length; i++) {
    const start = angles[i]
    const end = (i === angles.length - 1) ? angles[0] + 2 * Math.PI : angles[i + 1]
    gaps.push({
      center: (start + end) / 2,
      size: end - start
    })
  }

  gaps = gaps.reverse();

  // 3. Find the "Ideal Flow" direction (Original Logic)
  const flowAngle = Math.atan2(sumY, sumX) + Math.PI

  // 4. Find the best gap
  // We want a gap that is:
  // a) Large enough to hold the loop (at least ~60 degrees)
  // b) As close to the "Flow Angle" as possible
  let bestGap = gaps[0]
  let minDiff = Infinity

  // If there's a "Mega Gap" (> 210 deg), prioritize it regardless of flow
  const megaGap = [...gaps].find((g) => g.size > Math.PI * 1.2)
  if (megaGap) return megaGap.center

  gaps.forEach(gap => {
    // Normalize difference between gap center and flow angle
    let diff = Math.abs(((gap.center - flowAngle + Math.PI) % (2 * Math.PI)) - Math.PI)
    
    // Weighted scoring: prefer larger gaps, but lean towards the flow direction
    const score = diff - (gap.size * 0.2) 
    
    if (score < minDiff) {
      minDiff = score
      bestGap = gap
    }
  })

  return bestGap.center
}

/** Straight attachment segment clears every third state's outline (minimal gap). */
const straightShaftAttachmentsClearThirdStates = (
  fromId: string,
  toId: string,
  fromCenter: Point,
  toCenter: Point,
): boolean => {
  const start = pointOnCircle(fromCenter, toCenter, STATE_RADIUS)
  const end = pointOnCircle(toCenter, fromCenter, STATE_RADIUS)
  const minDistAllow = STATE_RADIUS + SHORT_DIAG_STRAIGHT_CLEAR_MARGIN
  for (const el of app.querySelectorAll('.tm-state')) {
    if (!(el instanceof HTMLElement)) continue
    const id = getStateId(el)
    if (id === fromId || id === toId) continue
    const c = getStateCenter(el)
    if (pointToSegmentDist(c, start, end).dist < minDistAllow) return false
  }
  return true
}

const buildFinalCurve = (
  fromId: string,
  toId: string,
  fromCenter: Point,
  toCenter: Point,
  virtualArrow: { fromId: string; toId: string } | null = null,
  diagramCentroid: Point | null = null,
): ArrowCurve => {
  if (fromId === toId) {
    const optimalAngle = getOptimalLoopAngle(fromId, fromCenter)
    return buildLoopCurve(fromCenter, optimalAngle)
  }

  const aligned = isAxisAligned(fromCenter, toCenter)
  const reverseExists = hasReverseArrowWithVirtual(fromId, toId, virtualArrow)

  /** Bidirectional pair: fixed geometry (unchanged); routing heuristics apply only below. */
  if (reverseExists) {
    return buildParallelPairCurve(fromCenter, toCenter, -1, -1)
  }

  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y

  if (aligned) {
    const dodgeNormalOffset = obstacleAvoidanceEnabled
      ? computeDodgeNormalOffset(
          fromId,
          toId,
          fromCenter,
          toCenter,
          'straight',
          1,
        )
      : 0
    return buildStraightCurve(fromCenter, toCenter, dodgeNormalOffset)
  }

  const chordLenCenters = Math.hypot(dx, dy)
  /** Default-on: short diagonal with a clear straight shaft prefers straight regardless of curve heuristics. */
  const shortDiagonalStraightEligible =
    chordLenCenters < SHORT_DIAG_STRAIGHT_MAX_GRID_MULTIPLIER * GRID_SIZE &&
    straightShaftAttachmentsClearThirdStates(fromId, toId, fromCenter, toCenter)

  if (shortDiagonalStraightEligible) {
    const dodgeNormalOffset = obstacleAvoidanceEnabled
      ? computeDodgeNormalOffset(
          fromId,
          toId,
          fromCenter,
          toCenter,
          'straight',
          1,
        )
      : 0
    return buildStraightCurve(fromCenter, toCenter, dodgeNormalOffset)
  }

  if (!curveRoutingRulesEnabled) {
    const flowSign = (Math.sign(dx * dy) || 1) as 1 | -1
    const dodgeNormalOffset = obstacleAvoidanceEnabled
      ? computeDodgeNormalOffset(
          fromId,
          toId,
          fromCenter,
          toCenter,
          'curved',
          flowSign,
        )
      : 0
    return buildCurvedCurveWithSign(fromCenter, toCenter, flowSign, dodgeNormalOffset)
  }

  const centroid = diagramCentroid ?? getDiagramCentroid()

  const { crowdingPos, crowdingNeg } = getEdgeCrowdingForSegment(
    fromId,
    toId,
    fromCenter,
    toCenter,
    virtualArrow,
  )

  const leanSign = computeEdgeLeanSign(
    fromCenter,
    toCenter,
    crowdingPos,
    crowdingNeg,
    centroid,
    dx,
    dy,
  )

  const totalCrowding = crowdingPos + crowdingNeg
  const imbalance = Math.abs(crowdingPos - crowdingNeg)
  const imbalanceRatio =
    totalCrowding > 1e-12 ? imbalance / totalCrowding : 0

  const openCorridor =
    crowdingPos < DIAG_STRAIGHT_OPEN_PER_SIDE &&
    crowdingNeg < DIAG_STRAIGHT_OPEN_PER_SIDE
  const nearlyBalancedSides =
    imbalanceRatio < DIAG_STRAIGHT_MAX_IMBALANCE_RATIO

  const useStraightShaft = openCorridor && nearlyBalancedSides
  const dodgeNormalOffset = obstacleAvoidanceEnabled
    ? computeDodgeNormalOffset(
        fromId,
        toId,
        fromCenter,
        toCenter,
        useStraightShaft ? 'straight' : 'curved',
        leanSign,
      )
    : 0

  if (useStraightShaft) {
    return buildStraightCurve(fromCenter, toCenter, dodgeNormalOffset)
  }

  return buildCurvedCurveWithSign(fromCenter, toCenter, leanSign, dodgeNormalOffset)
}

const renderStoredArrow = (arrow: StoredArrow) => {
  renderArrowShape(arrow.shape, arrow.currentCurve)
  arrow.shape.collider.dataset.arrowFrom = arrow.fromId
  arrow.shape.collider.dataset.arrowTo = arrow.toId
  renderArrowCollider(arrow.shape, arrow.targetCurve)
  positionArrowLabel(arrow)
  updateLabelColliderRect(arrow)
}

const setStoredArrowTargets = (virtualArrow: { fromId: string; toId: string } | null = null) => {
  const diagramCentroid = getDiagramCentroid()
  arrows.forEach((arrow) => {
    const fromState = getStateById(arrow.fromId)
    const toState = getStateById(arrow.toId)
    if (!(fromState instanceof HTMLElement) || !(toState instanceof HTMLElement)) return

    const fromCenter = getStateCenter(fromState)
    const toCenter = getStateCenter(toState)
    arrow.targetCurve = buildFinalCurve(
      arrow.fromId,
      arrow.toId,
      fromCenter,
      toCenter,
      virtualArrow,
      diagramCentroid,
    )
  })
  repositionVisibleArrowLabels()
}

const placementsClose = (a: LabelPlacement | null, b: LabelPlacement | null): boolean => {
  if (!a || !b) return a === b
  return (
    Math.abs(a.anchorX - b.anchorX) < 0.5 &&
    Math.abs(a.anchorY - b.anchorY) < 0.5 &&
    Math.abs(a.rotateDeg - b.rotateDeg) < 0.5 &&
    Math.abs(a.wrapW - b.wrapW) < 0.5 &&
    Math.abs(a.wrapH - b.wrapH) < 0.5
  )
}

const repositionVisibleArrowLabels = (maxPasses = 4) => {
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false
    arrows.forEach((a) => {
      if (!a.labelVisible) return
      const before = a.labelPlacement ? { ...a.labelPlacement } : null
      placeArrowLabel(a)
      if (!placementsClose(before, a.labelPlacement)) changed = true
    })
    if (!changed) return
  }
}

const rerenderStoredArrows = () => {
  setStoredArrowTargets()
  repositionVisibleArrowLabels()
  arrows.forEach(renderStoredArrow)
}

const getStateAtSnapPoint = (clientX: number, clientY: number): HTMLElement | null => {
  const { x, y } = getGridPoint(clientX, clientY)
  const snapped = app.querySelector(`.tm-state[data-grid="${gridKey(x, y)}"]`)
  return snapped instanceof HTMLElement ? snapped : null
}

const updateDraftArrow = (clientX: number, clientY: number) => {
  if (!draftArrow) return
  const fromState = getStateById(draftArrow.fromId)
  if (!(fromState instanceof HTMLElement)) {
    removeArrowShape(draftArrow.shape)
    draftArrow = null
    return
  }
  const from = getStateCenter(fromState)
  const snappedState = getStateAtSnapPoint(clientX, clientY)
  const snapped = getGridPoint(clientX, clientY)
  const snapPoint = { x: snapped.x, y: snapped.y }
  let targetCurve: ArrowCurve

  if (snappedState instanceof HTMLElement) {
    const toId = getStateId(snappedState)
    const toCenter = getStateCenter(snappedState)
    const diagramCentroid = getDiagramCentroid()
    targetCurve = buildFinalCurve(
      draftArrow.fromId,
      toId,
      from,
      toCenter,
      {
        fromId: draftArrow.fromId,
        toId,
      },
      diagramCentroid,
    )
    draftArrow.targetStateId = toId
    setStoredArrowTargets({
      fromId: draftArrow.fromId,
      toId,
    })
  } else {
    targetCurve = isAxisAligned(from, snapPoint)
      ? buildStraightToPointCurve(from, snapPoint)
      : buildDraftToPointCurve(from, snapPoint)
    draftArrow.targetStateId = null
    setStoredArrowTargets()
  }
  draftArrow.targetCurve = targetCurve
}

const cancelDraftArrow = () => {
  if (!draftArrow) return
  removeArrowShape(draftArrow.shape)
  draftArrow = null
  setStoredArrowTargets()
}

const startDraftArrow = (fromState: HTMLElement, clientX: number, clientY: number) => {
  cancelDraftArrow()
  const shape = createArrowShape()
  shape.collider.classList.add('is-draft')
  shape.labelCollider.classList.add('is-draft')
  shape.path.classList.add('is-draft')
  shape.head.classList.add('is-draft')
  shape.labelLeader.classList.add('is-draft')
  const snapped = getGridPoint(clientX, clientY)
  const snapPoint = { x: snapped.x, y: snapped.y }
  const from = getStateCenter(fromState)
  const initialCurve = isAxisAligned(from, snapPoint)
    ? buildStraightToPointCurve(from, snapPoint)
    : buildDraftToPointCurve(from, snapPoint)
  draftArrow = {
    fromId: getStateId(fromState),
    shape,
    targetCurve: initialCurve,
    currentCurve: cloneCurve(initialCurve),
    targetStateId: null,
  }
  updateDraftArrow(clientX, clientY)
}

const finalizeArrow = (toState: HTMLElement) => {
  if (!draftArrow) return
  const fromState = getStateById(draftArrow.fromId)
  if (!(fromState instanceof HTMLElement)) {
    cancelDraftArrow()
    return
  }

  const fromId = getStateId(fromState)
  const toId = getStateId(toState)

  if (hasArrow(fromId, toId)) {
    cancelDraftArrow()
    return
  }

  draftArrow.shape.collider.classList.remove('is-draft')
  draftArrow.shape.labelCollider.classList.remove('is-draft')
  draftArrow.shape.path.classList.remove('is-draft')
  draftArrow.shape.head.classList.remove('is-draft')
  draftArrow.shape.labelLeader.classList.remove('is-draft')
  arrows.push({
    fromId,
    toId,
    shape: draftArrow.shape,
    targetCurve: cloneCurve(draftArrow.currentCurve),
    currentCurve: cloneCurve(draftArrow.currentCurve),
    label: '',
    labelWrap: null,
    labelInputs: null,
    labelVisible: false,
    labelPlacement: null,
  })
  draftArrow = null
  rerenderStoredArrows()
}

const commitStateName = (stateEl: HTMLElement, inputEl: HTMLInputElement, nextRaw: string) => {
  const next = nextRaw.trim()
  const labelEl = stateEl.querySelector('.tm-state-label')
  if (!(labelEl instanceof HTMLSpanElement)) return

  labelEl.textContent = next
  labelEl.hidden = false
  inputEl.remove()
  stateEl.setAttribute('aria-label', next ? `State ${next}` : 'Turing machine state')
}

const startStateEdit = (stateEl: HTMLElement) => {
  const existingInput = stateEl.querySelector('.tm-state-input')
  if (existingInput instanceof HTMLInputElement) {
    existingInput.focus()
    existingInput.select()
    return
  }

  const labelEl = stateEl.querySelector('.tm-state-label')
  if (!(labelEl instanceof HTMLSpanElement)) return

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'tm-state-input'
  input.value = labelEl.textContent ?? ''
  input.setAttribute('aria-label', 'State name')
  labelEl.hidden = true
  stateEl.appendChild(input)
  input.focus()
  input.select()

  input.addEventListener('blur', () => {
    commitStateName(stateEl, input, input.value)
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      input.blur()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      labelEl.hidden = false
      input.remove()
    }
  })
}

const animateShadow = () => {
  if (hasPointer) {
    shadowX += (targetX - shadowX) * LAG_FACTOR
    shadowY += (targetY - shadowY) * LAG_FACTOR
    setShadowPosition(shadowX, shadowY)
  }

  if (draftArrow) {
    draftArrow.currentCurve = lerpCurve(draftArrow.currentCurve, draftArrow.targetCurve, 0.26)
    renderArrowShape(draftArrow.shape, draftArrow.currentCurve)
  }

  arrows.forEach((arrow) => {
    arrow.currentCurve = lerpCurve(arrow.currentCurve, arrow.targetCurve, 0.24)
    renderStoredArrow(arrow)
  })

  requestAnimationFrame(animateShadow)
}

requestAnimationFrame(animateShadow)

function refreshVisibleArrowLabels() {
  repositionVisibleArrowLabels()
  arrows.forEach((arrow) => {
    positionArrowLabel(arrow)
    updateLabelColliderRect(arrow)
  })
}

new ResizeObserver(refreshVisibleArrowLabels).observe(app)
document.fonts?.ready.then(refreshVisibleArrowLabels).catch(() => {})

app.addEventListener('pointerenter', (event) => {
  hasPointer = true
  lastPointerClientX = event.clientX
  lastPointerClientY = event.clientY
  hasPointerPosition = true
  updateShadowTarget(event.clientX, event.clientY)
  shadowX = targetX
  shadowY = targetY
  setShadowPosition(shadowX, shadowY)
  shadow.classList.add('is-visible')
  syncArrowHoverShadow(event.target)
})

app.addEventListener('pointermove', (event) => {
  lastPointerClientX = event.clientX
  lastPointerClientY = event.clientY
  hasPointerPosition = true
  updateShadowTarget(event.clientX, event.clientY)
  updateDraftArrow(event.clientX, event.clientY)
  syncArrowHoverShadow(event.target)
})

app.addEventListener('pointerleave', () => {
  hasPointer = false
  hasPointerPosition = false
  shadow.classList.remove('is-visible')
  shadow.classList.remove('is-hover-arrow')
})

// Blur runs on mousedown before `click`; by then `activeElement` is no longer the label input,
// so we blur here and suppress the following click from creating nodes.
app.addEventListener(
  'pointerdown',
  (event) => {
    if (!(event.target instanceof Element)) return
    if (draftArrow) return

    const target = event.target
    if (target.closest('.tm-arrow-collider, .tm-arrow-label-collider')) return
    if (target.closest('.tm-arrow-label')) {
      return
    }

    const active = document.activeElement
    if (!(active instanceof HTMLInputElement) || !active.classList.contains('tm-arrow-label-input')) {
      return
    }

    active.blur()
    suppressCanvasClickAfterArrowLabelBlur = true
  },
  true,
)

app.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return

  const existingState = target.closest('.tm-state')

  if (draftArrow) {
    const snappedState = getStateAtSnapPoint(event.clientX, event.clientY)
    if (snappedState instanceof HTMLElement) {
      finalizeArrow(snappedState)
      return
    }
    cancelDraftArrow()
    return
  }

  if (suppressCanvasClickAfterArrowLabelBlur) {
    suppressCanvasClickAfterArrowLabelBlur = false
    event.preventDefault()
    event.stopPropagation()
    return
  }

  const hitArrow = findStoredArrowFromHitTarget(target)
  if (hitArrow) {
    event.preventDefault()
    event.stopPropagation()
    showArrowLabel(hitArrow)
    return
  }

  if (existingState instanceof HTMLElement) {
    startStateEdit(existingState)
    return
  }

  // When an arrow collider is hovered, clicks should not create new nodes.
  if (shadow.classList.contains('is-hover-arrow')) return

  const { x, y } = getGridPoint(event.clientX, event.clientY)
  if (isOccupied(x, y)) return

  const circle = document.createElement('div')
  circle.className = 'tm-state'
  circle.style.left = `${x}px`
  circle.style.top = `${y}px`
  circle.dataset.x = `${x}`
  circle.dataset.y = `${y}`
  circle.dataset.stateId = `s${nextStateId}`
  nextStateId += 1
  circle.dataset.grid = gridKey(x, y)
  circle.setAttribute('tabindex', '0')
  circle.setAttribute('role', 'button')
  circle.setAttribute('aria-label', 'Turing machine state')
  const collider = document.createElement('div')
  collider.className = 'tm-state-collider'
  collider.setAttribute('aria-hidden', 'true')
  collider.dataset.stateId = circle.dataset.stateId
  const label = document.createElement('span')
  label.className = 'tm-state-label'
  circle.appendChild(collider)
  circle.appendChild(label)
  app.appendChild(circle)
})

app.addEventListener('contextmenu', (event) => {
  const state = getStateAtSnapPoint(event.clientX, event.clientY)
  if (!(state instanceof HTMLElement)) return
  event.preventDefault()
  startDraftArrow(state, event.clientX, event.clientY)
})

window.addEventListener('keydown', (event) => {
  const isModifier = event.metaKey || event.ctrlKey
  if (!isModifier || event.key.toLowerCase() !== 'k') return

  // Do not interfere with typing inside inputs (except arrow labels: Cmd+K should still delete).
  const keyTarget = event.target
  if (
    keyTarget instanceof HTMLInputElement &&
    !keyTarget.classList.contains('tm-arrow-label-input')
  ) {
    return
  }
  if (keyTarget instanceof HTMLTextAreaElement) {
    return
  }
  if (keyTarget instanceof HTMLElement && keyTarget.isContentEditable) {
    return
  }

  if (!hasPointerPosition) return
  event.preventDefault()

  const hovered = document.elementFromPoint(lastPointerClientX, lastPointerClientY)
  if (!hovered) return

  const hitArrow = findStoredArrowFromHitTarget(hovered)
  if (hitArrow) {
    const index = arrows.findIndex(
      (arrow) => arrow.fromId === hitArrow.fromId && arrow.toId === hitArrow.toId,
    )
    if (index === -1) return

    const [arrow] = arrows.splice(index, 1)
    removeArrowLabelEl(arrow)
    removeArrowShape(arrow.shape)
    rerenderStoredArrows()
    return
  }

  // Otherwise, delete the hovered node (and all incident arrows) based on the node collider.
  const stateCollider = hovered.closest('.tm-state-collider') as HTMLElement | null
  const stateEl = stateCollider
    ? (stateCollider.closest('.tm-state') as HTMLElement | null)
    : (hovered.closest('.tm-state') as HTMLElement | null)

  if (!stateEl) return

  const stateId = getStateId(stateEl)
  if (!stateId) return

  // Remove all arrows connected to this state.
  for (let i = arrows.length - 1; i >= 0; i -= 1) {
    const arrow = arrows[i]
    if (arrow.fromId === stateId || arrow.toId === stateId) {
      removeArrowLabelEl(arrow)
      removeArrowShape(arrow.shape)
      arrows.splice(i, 1)
    }
  }

  stateEl.remove()
  rerenderStoredArrows()
})
