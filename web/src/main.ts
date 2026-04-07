import './styles.scss'

const THEME_PREF_KEY = 'pref.txt'
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
})

const app = document.getElementById('app')

if (!app) {
  throw new Error('Missing #app root element')
}

app.className = 'tm-canvas'

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
const GRID_SIZE = 140
const GRID_OFFSET = GRID_SIZE / 2
const LEASH_RADIUS = 12
const LAG_FACTOR = 0.18
const GRID_BOX_SCALE = 0.98

let nextStateId = 1

let targetX = 0
let targetY = 0
let shadowX = 0
let shadowY = 0
let hasPointer = false
let lastPointerClientX = 0
let lastPointerClientY = 0
let hasPointerPosition = false

arrowLayer.addEventListener('pointerover', (event) => {
  const target = event.target
  if (!(target instanceof SVGElement)) return
  if (target.closest('.tm-arrow-collider')) {
    shadow.classList.add('is-hover-arrow')
  }
})

arrowLayer.addEventListener('pointerout', (event) => {
  const target = event.target
  if (!(target instanceof SVGElement)) return
  if (target.closest('.tm-arrow-collider')) {
    shadow.classList.remove('is-hover-arrow')
  }
})

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
  path: SVGPathElement
  head: SVGPolygonElement
}

type StoredArrow = {
  fromId: string
  toId: string
  shape: ArrowShape
  targetCurve: ArrowCurve
  currentCurve: ArrowCurve
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
  const path = document.createElementNS(SVG_NS, 'path')
  path.classList.add('tm-arrow-path')
  const head = document.createElementNS(SVG_NS, 'polygon')
  head.classList.add('tm-arrow-head')
  arrowLayer.appendChild(collider)
  arrowLayer.appendChild(path)
  arrowLayer.appendChild(head)
  return { collider, path, head }
}

const removeArrowShape = (shape: ArrowShape) => {
  shape.collider.remove()
  shape.path.remove()
  shape.head.remove()
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

const buildStraightCurve = (from: Point, to: Point): ArrowCurve => {
  const start = pointOnCircle(from, to, STATE_RADIUS)
  const end = pointOnCircle(to, from, STATE_RADIUS)
  const control = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  }
  return quadraticToCubic(start, control, end)
}

const buildCurvedCurveWithSign = (from: Point, to: Point, sign: 1 | -1): ArrowCurve => {
  const start = pointOnCircle(from, to, STATE_RADIUS)
  const end = pointOnCircle(to, from, STATE_RADIUS)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const nx = length > 0.001 ? -dy / length : 0
  const ny = length > 0.001 ? dx / length : -1
  const curvature = Math.min(90, Math.max(26, length * 0.22))
  const control = {
    x: (start.x + end.x) / 2 + nx * curvature * sign,
    y: (start.y + end.y) / 2 + ny * curvature * sign,
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

const getStateId = (stateEl: HTMLElement) => stateEl.dataset.stateId ?? ''

const getStateById = (stateId: string): HTMLElement | null =>
  app.querySelector(`.tm-state[data-state-id="${stateId}"]`)

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
  const gaps: { center: number; size: number }[] = []

  for (let i = 0; i < angles.length; i++) {
    const start = angles[i]
    const end = (i === angles.length - 1) ? angles[0] + 2 * Math.PI : angles[i + 1]
    gaps.push({
      center: (start + end) / 2,
      size: end - start
    })
  }

  // 3. Find the "Ideal Flow" direction (Original Logic)
  const flowAngle = Math.atan2(sumY, sumX) + Math.PI

  // 4. Find the best gap
  // We want a gap that is:
  // a) Large enough to hold the loop (at least ~60 degrees)
  // b) As close to the "Flow Angle" as possible
  let bestGap = gaps[0]
  let minDiff = Infinity

  // If there's a "Mega Gap" (> 210 deg), prioritize it regardless of flow
  const megaGap = gaps.reverse().find(g => g.size > Math.PI * 1.2)
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

const buildFinalCurve = (
  fromId: string,
  toId: string,
  fromCenter: Point,
  toCenter: Point,
  virtualArrow: { fromId: string; toId: string } | null = null,
): ArrowCurve => {
  if (fromId === toId) {
    const optimalAngle = getOptimalLoopAngle(fromId, fromCenter)
    return buildLoopCurve(fromCenter, optimalAngle)
  }
  
  const aligned = isAxisAligned(fromCenter, toCenter)
  const reverseExists = hasReverseArrowWithVirtual(fromId, toId, virtualArrow)
  
  if (!reverseExists && aligned) {
    return buildStraightCurve(fromCenter, toCenter)
  }
  
  if (reverseExists) {
    return buildParallelPairCurve(fromCenter, toCenter, -1, -1)
  }

  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  
  // Calculate flow direction to make curve visually pleasing
  const flowSign = (Math.sign(dx * dy) || 1) as 1 | -1
  
  return buildCurvedCurveWithSign(fromCenter, toCenter, flowSign)
}

const renderStoredArrow = (arrow: StoredArrow) => {
  renderArrowShape(arrow.shape, arrow.currentCurve)
  arrow.shape.collider.dataset.arrowFrom = arrow.fromId
  arrow.shape.collider.dataset.arrowTo = arrow.toId
  renderArrowCollider(arrow.shape, arrow.targetCurve)
}

const setStoredArrowTargets = (virtualArrow: { fromId: string; toId: string } | null = null) => {
  arrows.forEach((arrow) => {
    const fromState = getStateById(arrow.fromId)
    const toState = getStateById(arrow.toId)
    if (!(fromState instanceof HTMLElement) || !(toState instanceof HTMLElement)) return

    const fromCenter = getStateCenter(fromState)
    const toCenter = getStateCenter(toState)
    arrow.targetCurve = buildFinalCurve(arrow.fromId, arrow.toId, fromCenter, toCenter, virtualArrow)
  })
}

const rerenderStoredArrows = () => {
  setStoredArrowTargets()
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
    targetCurve = buildFinalCurve(draftArrow.fromId, toId, from, toCenter)
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
  shape.path.classList.add('is-draft')
  shape.head.classList.add('is-draft')
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
  draftArrow.shape.path.classList.remove('is-draft')
  draftArrow.shape.head.classList.remove('is-draft')
  arrows.push({
    fromId,
    toId,
    shape: draftArrow.shape,
    targetCurve: cloneCurve(draftArrow.currentCurve),
    currentCurve: cloneCurve(draftArrow.currentCurve),
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
})

app.addEventListener('pointermove', (event) => {
  lastPointerClientX = event.clientX
  lastPointerClientY = event.clientY
  hasPointerPosition = true
  updateShadowTarget(event.clientX, event.clientY)
  updateDraftArrow(event.clientX, event.clientY)
})

app.addEventListener('pointerleave', () => {
  hasPointer = false
  hasPointerPosition = false
  shadow.classList.remove('is-visible')
})

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

  // Do not interfere with typing inside inputs.
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    (event.target instanceof HTMLElement && event.target.isContentEditable)
  ) {
    return
  }

  if (!hasPointerPosition) return
  event.preventDefault()

  const hovered = document.elementFromPoint(lastPointerClientX, lastPointerClientY)
  if (!hovered) return

  // Arrow deletion takes precedence if an arrow collider is under the pointer.
  const arrowCollider = hovered.closest('.tm-arrow-collider') as SVGPathElement | null
  if (arrowCollider) {
    const fromId = arrowCollider.dataset.arrowFrom
    const toId = arrowCollider.dataset.arrowTo
    if (!fromId || !toId) return

    const index = arrows.findIndex((arrow) => arrow.fromId === fromId && arrow.toId === toId)
    if (index === -1) return

    const [arrow] = arrows.splice(index, 1)
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
      removeArrowShape(arrow.shape)
      arrows.splice(i, 1)
    }
  }

  stateEl.remove()
  rerenderStoredArrows()
})
