# Future Connector Line Implementation

## Status

Connector lines are an in-development later feature. The current production label system should remain understandable without them. This document describes a cleaner JS/CSS makeup for adding them later in a way that is easy to position, test, and keep visually quiet.

## Design Goal

A connector line should be a geometry primitive owned by one arrow-label pair: it should be easy to attach to the input underline, easy to attach to a precise point on the arrow, and easy to redraw without depending on DOM layout side effects.

## Problems With The Current Scaffold

The existing scaffold stores a single SVG path on `ArrowShape`. That is enough to draw a line, but it makes the implementation awkward in three ways:

- The line endpoint math depends on the transformed HTML label, while the path lives in the SVG coordinate system.
- The line is hard to reason about when the label rotates because underline geometry is implicit in CSS transforms.
- The line has no explicit concept of anchor points, normals, or handles; those are recomputed inside rendering code rather than represented as inspectable state.

## Proposed Makeup

Use one SVG `<g>` per label connector, owned by the corresponding arrow shape:

```html
<g class="tm-arrow-label-connector" data-arrow-from="s1" data-arrow-to="s2">
  <path class="tm-arrow-label-connector-path" />
  <circle class="tm-arrow-label-connector-dot tm-arrow-label-connector-dot--label" />
  <circle class="tm-arrow-label-connector-dot tm-arrow-label-connector-dot--arrow" />
</g>
```

The dots should be hidden by default, but they are useful for debug mode and make the geometry inspectable. The production line can render only the path.

## Geometry State

Store connector geometry separately from `labelPlacement`:

```ts
type LabelConnectorGeometry = {
  labelAnchor: Point
  labelNormal: Point
  arrowAnchor: Point
  arrowNormal: Point
  handleLength: number
  visible: boolean
}
```

This makes the line easy to manipulate:

- `labelAnchor` is a point on the visible underline, after label rotation.
- `labelNormal` is perpendicular to the rotated underline and points away from the label toward the arrow.
- `arrowAnchor` is the chosen point on the owning arrow.
- `arrowNormal` is perpendicular to the arrow tangent at `arrowAnchor` and points toward the label.
- `handleLength` controls how taut or curved the connector is.

The path is then deterministic:

```ts
M labelAnchor
C labelAnchor + labelNormal * handleLength,
  arrowAnchor + arrowNormal * handleLength,
  arrowAnchor
```

## Anchor Selection

The label endpoint should not always be the underline center. Instead, compute several legal underline anchor points:

- center of underline
- 25% from left
- 25% from right
- nearest point on underline segment to `arrowAnchor`

Pick the anchor that gives the shortest connector without crossing the label bbox. This preserves the feeling that the connector emerges from the exact side of the underline that belongs to the arrow.

The arrow endpoint should be chosen from the same sampled curve data used by the label solver:

- nearest point from the chosen underline anchor to the owning curve
- nearest point constrained to a small `t` window around the label's owning `curveT`
- nearest point that avoids crossing other visible labels

For loops, prefer the loop apex neighborhood and only fall back to other loop segments when the apex connector would cross the label or state circle.

## JS Ownership

Recommended shape:

```ts
type ArrowShape = {
  collider: SVGPathElement
  labelCollider: SVGRectElement
  path: SVGPathElement
  head: SVGPolygonElement
  labelConnector: SVGGElement
  labelConnectorPath: SVGPathElement
}
```

Recommended stored arrow addition:

```ts
type StoredArrow = {
  // existing fields...
  labelConnector: LabelConnectorGeometry | null
}
```

Rendering should be split:

- `placeArrowLabel(arrow)` chooses label placement and rotation.
- `computeLabelConnector(arrow)` computes connector geometry from the final placement.
- `renderLabelConnector(arrow)` writes SVG attributes only.

This keeps solver decisions separate from drawing.

## CSS Makeup

Use the same visual language as the input underline:

```scss
.tm-arrow-label-connector {
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.tm-arrow-label-connector.is-visible {
  opacity: 1;
}

.tm-arrow-label-connector-path {
  fill: none;
  stroke: color-mix(in srgb, var(--dot-stroke) 45%, transparent);
  stroke-width: 1px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tm-arrow-label-connector-dot {
  display: none;
}

.tm-canvas.tm-show-colliders .tm-arrow-label-connector-dot {
  display: block;
  fill: var(--dot-fill);
  opacity: 0.45;
}
```

Do not use dashed lines, glow, thick strokes, arrowheads, or animation loops. The connector is an ownership cue, not a decoration.

## Positioning API

Expose tiny geometry helpers rather than manipulating SVG attributes throughout the code:

```ts
const setConnectorPath = (path: SVGPathElement, g: LabelConnectorGeometry) => {
  const h = g.handleLength
  const c1 = {
    x: g.labelAnchor.x + g.labelNormal.x * h,
    y: g.labelAnchor.y + g.labelNormal.y * h,
  }
  const c2 = {
    x: g.arrowAnchor.x + g.arrowNormal.x * h,
    y: g.arrowAnchor.y + g.arrowNormal.y * h,
  }
  path.setAttribute(
    'd',
    `M ${g.labelAnchor.x} ${g.labelAnchor.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${g.arrowAnchor.x} ${g.arrowAnchor.y}`,
  )
}
```

The solver can then score connector length, crossings, and endpoint clarity without caring how SVG paths are written.

## How This Informs The Global Solver

The global solver should treat connectors as optional geometry derived from a chosen label placement, not as an independent primary object. A candidate label placement can include a precomputed connector candidate:

```ts
type LabelCandidate = {
  placement: LabelPlacement
  connector: LabelConnectorGeometry | null
  cost: number
  conflicts: BitSet
}
```

Even while connector lines remain disabled, this representation is useful because the same anchor points and nearest-arrow calculations improve ownership scoring. When connectors are enabled later, the solver does not need a new architecture; it only starts rendering already-computed geometry.

## Rollout

1. Keep `ARROW_LABEL_LEADER_ENABLED = false`.
2. Introduce connector geometry types and render helpers behind the flag.
3. In debug mode, render endpoint dots before rendering production paths.
4. Add connector scoring to the global solver candidates, but keep production rendering disabled.
5. Enable production connector rendering only after dense-diagram manual checks show that lines reduce ambiguity without adding visual clutter.
