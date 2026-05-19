# Global Solver Plan For Arrow Rule Inputs

## Goal

Replace the current greedy/multipass label placer with a full global solver that chooses every visible rule input placement together, producing the minimum-cost valid layout over a declared finite candidate space.

This is the important constraint: "truly optimal" means exact optimum over the solver's candidate set and cost model. The candidate set must be rich enough to cover the visual design space, but finite enough that the browser can solve it quickly and deterministically.

## Dependency: Future Line Geometry

This plan assumes the connector-line model described in `line-imp.md`:

- Label placement is primary.
- Connector geometry is derived from a chosen placement.
- The connector is represented by explicit anchors/normals/handle length.
- Rendering is separate from solving.

Connector lines should remain disabled until they are ready, but the solver can still precompute connector geometry as part of candidate ownership scoring. That keeps today's visual behavior line-free while making the future line feature cheap to enable.

## Design Thesis

Every rule input should look like it belongs to exactly one arrow because its underline is close to that arrow, tilted with that arrow, unobscured by diagram geometry, and globally coordinated with every other visible input.

## Current Limitation

The current placement system is heuristic:

- Each label picks a locally good candidate.
- Multiple passes reduce stale label-label conflicts, but do not prove global optimality.
- Dense diagrams can still settle into order-dependent local minima.
- Rotation is locally bounded and helpful, but not optimized globally with placement.

The global solver should remove order dependence.

## Exact Optimization Model

Model the layout as a weighted constraint optimization problem.

For each visible arrow label `i`, generate a finite candidate set:

```ts
type CandidateId = number

type SolverCandidate = {
  id: CandidateId
  arrowIndex: number
  placement: LabelPlacement
  connector: LabelConnectorGeometry | null
  baseCost: number
  hardInvalid: boolean
  conflicts: BitSet
  pairCosts: Map<CandidateId, number>
}
```

The solver chooses exactly one candidate per visible label:

```text
minimize:
  sum(baseCost[i, chosenCandidate])
  + sum(pairCost[i,j, chosenCandidateI, chosenCandidateJ])

subject to:
  exactly one candidate is selected for each visible label
  no selected hard-conflict pair is allowed
```

This is a weighted constraint satisfaction problem. Solve it exactly with branch-and-bound plus bitset pruning. The result is globally optimal over the candidate set.

## Candidate Generation

Candidate generation must be broad enough that the exact solver has meaningful choices.

For every label:

1. Sample owning-arrow curve positions:
   - Normal arrows: `t = [0.18, 0.24, 0.30, 0.36, 0.42, 0.48, 0.52, 0.58, 0.64, 0.70, 0.76, 0.82]`
   - Straight short arrows: emphasize center positions, but keep endpoints as fallback.
   - Reverse-pair arrows: add candidates biased to the outside of each paired curve.
   - Self-loops: sample around the loop apex and both loop shoulders.

2. Sample placement side:
   - Normal arrows: both curve normals.
   - Reverse pairs: prefer outside normal, include inside only as fallback.
   - Self-loops: prefer outward radial direction, include tangential and inward fallback near canvas edges.

3. Sample gap:
   - Normal arrows: `[10, 14, 18, 24, 32, 44, 60, 80]`
   - Self-loops: `[8, 12, 18, 26, 38, 54]`
   - Dense conflict fallback: add `[96, 124]` only if all smaller candidates are invalid.

4. Sample rotation:
   - Compute the nearest owning-arrow tangent from the candidate underline.
   - Generate a small rotation family around that tangent:
     - `0deg`
     - clamped tangent angle
     - clamped tangent angle `+/- 6deg`
     - for near-horizontal arrows, keep `0deg` dominant
   - Cap production rotation at `24deg` unless a later usability check proves larger angles remain readable.

5. Clamp and reject:
   - Clamp label bboxes inside the canvas edge buffer when possible.
   - Reject candidates that still clip after clamping.
   - Reject candidates whose visible underline is crossed by the owning arrow or any other arrow.
   - Reject candidates whose bbox overlaps a non-endpoint state circle.

This should produce roughly 100-400 candidates per visible label before pruning, and far fewer after hard-invalid filtering.

## More Robust Rotation Plan

Rotation should be a first-class solver dimension, not just a rendering afterthought.

For each candidate, compute underline geometry explicitly:

```ts
type UnderlineSegment = {
  a: Point
  b: Point
  center: Point
  angleDeg: number
}
```

Then score rotation by four factors:

- `parallelCost`: absolute difference between underline angle and nearest owning-arrow tangent.
- `readabilityCost`: grows nonlinearly after `12deg`, heavily after `24deg`.
- `ambiguityCost`: penalty if the rotated underline becomes more parallel to a nearby non-owning arrow than to its owner.
- `collisionCost`: penalty or rejection if the rotated bbox/underline intersects any arrow shaft.

Recommended rotation cost:

```text
rotationCost =
  0.8 * parallelCost(owner)
  + 2.5 * max(0, abs(angle) - 12)^2
  + 6.0 * max(0, nonOwnerParallelAdvantage)
```

This makes rotation more dynamic in busy diagrams, where it helps association, while keeping quiet nearly-horizontal labels flat.

Special cases:

- Axis-aligned arrows: allow `0deg`, `+/-6deg`, and tangent-clamped rotation, but strongly prefer `0deg`.
- Diagonal arrows: allow the full tangent-clamped family.
- Curved arrows: use nearest point from underline center to curve, not the candidate's original `t`.
- Self-loops: rotate to the local loop tangent only at loop shoulders; near the apex, prefer flatter labels unless the loop tangent is visually clear.
- Very short arrows: prefer less rotation because the arrow's tangent direction changes less meaningfully.

## Cost Model

Each candidate gets `baseCost`.

Recommended base terms:

```text
baseCost =
  edgeCost
  + stateCost
  + ownArrowObstructionCost
  + otherArrowObstructionCost
  + ownershipDistanceCost
  + ownershipAmbiguityCost
  + rotationCost
  + connectorCost
  + specialCaseCost
```

Hard invalid conditions:

- Label bbox clips outside canvas after clamping.
- Visible underline intersects any arrow shaft.
- Label bbox intersects a non-endpoint state.
- Label bbox fully covers the owning arrow's arrowhead.
- Label bbox intersects the active input of another label.

Soft costs:

- Distance from underline to owning arrow.
- Being closer to another arrow than the owning arrow.
- Large rotation.
- Large connector length, even while connectors are disabled.
- Label-label proximity.
- Distance from preferred `t` for the arrow type.

Pair costs handle relationships between two chosen candidates:

- Label-label overlap: hard conflict.
- Label-label near miss: soft cost.
- Crossed connector geometries: hard conflict if connectors are enabled, soft future cost if disabled.
- Symmetric ambiguity: if two labels are both closer to each other's arrows than their own, hard conflict.
- Same-side crowding on reverse-pair arrows: soft cost.

## Exact Solver

Use branch-and-bound with bitsets.

Precomputation:

1. Generate candidates for each visible label.
2. Remove hard-invalid candidates.
3. Compute pair conflicts and pair costs.
4. For each label, sort candidates by base cost.
5. Compute a lower-bound table: cheapest candidate per unsolved label, ignoring pair costs.

Search:

```text
best = Infinity

search(partialAssignment, remainingLabels, currentCost):
  lowerBound = currentCost + sum(minBaseCost[label] for remainingLabels)
  if lowerBound >= best:
    prune

  label = chooseMostConstrainedLabel(remainingLabels)

  for candidate in candidates[label] sorted by optimistic total:
    if candidate conflicts with partialAssignment:
      continue

    delta = candidate.baseCost + pairCosts(candidate, partialAssignment)
    if currentCost + delta >= best:
      continue

    search(partialAssignment + candidate, remainingLabels - label, currentCost + delta)
```

This is exact because it enumerates every valid assignment not pruned by a mathematically safe lower bound. Pruning never discards a solution that could beat the best known solution.

## Efficiency Plan

The solver must feel instant for normal diagrams.

Use these constraints:

- Solve only visible labels, not every arrow in the graph.
- Cap candidates per label after pruning to the best `K = 80` by base cost, but only after preserving all candidates that are uniquely valid for a hard constraint class. If strict optimality over the larger generated set is required, do not cap; instead use a time budget fallback only for preview mode.
- Use bitsets for conflicts.
- Use typed arrays for base costs and pair costs.
- Recompute only affected labels when one arrow changes, then solve the global visible set.
- Cache curve samples for each arrow per render topology.
- Cache rotated bbox and underline segment per candidate.

Expected scale:

- 1-8 visible labels: exact solve should be trivial.
- 9-20 visible labels: branch-and-bound should remain fast with good ordering.
- 20+ visible labels: use stronger lower bounds and conflict-connected components.

Component decomposition:

Build a conflict graph where labels are connected if any candidate pair has nonzero pair cost or conflict. Solve each connected component independently. This preserves exactness because independent components have additive costs.

## Stronger Lower Bounds

Start with sum of cheapest candidate per remaining label. Add stronger bounds if needed:

- For each remaining label, cheapest candidate compatible with current partial assignment.
- Pairwise relaxation: for dense components, compute a cheap minimum pair penalty estimate.
- Dominance pruning: candidate A dominates candidate B if A has lower/equal base cost, no more conflicts, and no higher pair costs against every other candidate.

Dominance pruning is especially useful because many candidates differ only by small gap/rotation changes.

## Truly Global Optimality Contract

The solver must make this explicit in code comments and tests:

> The solver returns the exact minimum-cost assignment over the generated candidate sets and declared hard constraints.

Do not describe it as "optimal" without that scope. If candidate generation changes, the optimization domain changes. Tests should check both:

- the solver finds the exact best assignment for a fixed candidate set
- candidate generation includes enough practical choices for real diagrams

## Special Case Rules

### Self-Loops

Self-loop labels should prefer the loop apex, then loop shoulders.

Rules:

- Prefer outward radial placement from the state center through the loop point.
- If the state is near an edge, add tangential slide candidates along the loop instead of simply moving inward over the state.
- Inward candidates are allowed only if all outward/tangential candidates are invalid.
- Penalize labels that overlap the state circle much more heavily than normal endpoint labels.
- Rotation near the apex should be mild; rotation at shoulders can follow tangent more strongly.

### Reverse-Pair Arrows

Reverse-pair labels should stay on their respective outside curves.

Rules:

- Generate candidates biased to the outside of each parallel curve.
- Add a pair cost if two reverse labels choose positions that are mirror-overlapping around the chord midpoint.
- Prefer different `t` offsets when two labels would otherwise be parallel and adjacent.

### Dense Intersections

When many arrows cross near the same region:

- Ownership ambiguity cost becomes more important than raw distance.
- A label can move farther away if that makes the owning arrow the uniquely nearest arrow.
- Rotation can become more dynamic, but readability caps remain.
- Connector geometry may be computed and scored even when not rendered.

### Canvas Edges

Labels should not clip.

Rules:

- Candidate bboxes are clamped inside the edge buffer.
- If clamping changes ownership distance too much, add cost but keep the candidate if valid.
- If clamping causes state/arrow overlap, reject or heavily penalize.

## Testing Plan

Unit tests:

- Exact solver returns known optimum for small hand-authored candidate sets.
- Conflict bitsets reject impossible assignments.
- Dominance pruning preserves optimum.
- Component decomposition produces the same result as solving all labels together.
- Rotation cost prefers owner-parallel angles over nearby non-owner-parallel angles.

Geometry tests:

- Rotated bbox contains all rotated corners.
- Underline segment is transformed consistently with label CSS.
- Curve segment intersection includes endpoints.
- Self-loop edge cases produce at least one valid non-clipping candidate.

Adversarial fixtures:

- Two crossing diagonals with both labels visible.
- Four arrows crossing at one center point.
- Reverse-pair arrows with labels on both arrows.
- Self-loop at top edge, bottom edge, and corner.
- Dense cluster of states with 8-12 visible labels.

Manual checks:

- Labels remain readable.
- Ownership is obvious without connector lines.
- Rotation helps association rather than feeling decorative.
- No label is hidden under an arrow shaft or arrowhead.

## Rollout Plan

1. Extract current geometry helpers into pure functions.
2. Add candidate generation without changing production placement.
3. Add exact solver behind a feature flag.
4. Run current heuristic and global solver side-by-side in debug mode.
5. Add visual debug overlays for candidate winners, rejected candidates, and conflict components.
6. Switch production placement to the global solver only after adversarial fixtures pass.
7. Keep connector rendering disabled until the line implementation from `line-imp.md` is separately validated.

## Non-Goals

- Do not optimize over continuous space directly in the browser.
- Do not add decorative line styling.
- Do not make labels rotate freely beyond readable bounds.
- Do not solve hidden labels.
- Do not use randomized layout; the same diagram should produce the same placement every time.
