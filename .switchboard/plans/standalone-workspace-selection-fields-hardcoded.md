# Standalone Workspace-Selection Payload Is Seven Hardcoded Fields — Repo Scope and Project Context Are Dead

## Metadata

**Complexity:** 4
**Tags:** bug, backend, standalone, parity
**Project:** Browser Switchboard

## Goal

The standalone/browser host fabricates the entire control-plane and scope section of its `updateWorkspaceSelection` message. Repo-scope filtering and project context are permanently off in the browser, and control-plane mode is permanently `'none'`. Send live values where the concept applies, and make the remaining constants explicit and justified rather than accidental.

### Problem analysis and root cause

Both standalone state builders emit seven fabricated fields:

- `pushFullState` — `src/standalone/bootstrap.ts:341`
- `getFullState` — `src/standalone/bootstrap.ts:370`

```typescript
activeFilter: null, controlPlaneMode: 'none', controlPlaneRoot: null,
effectiveControlPlaneRoot: workspaceRoot, explicitControlPlaneRoot: workspaceRoot,
pendingCandidate: null, repoScopeFilter: null, projectContextEnabled: false
```

The extension derives all of them (`src/services/KanbanProvider.ts:1154-1168`) from two resolvers computed just above at `:1142-1143`:

```typescript
const cpStatus = this.getControlPlaneSelectionStatus(root);
const projectContextEnabled = await this._resolveProjectContextEnabled(root);
```

feeding `activeFilter: this._repoScopeFilter || null`, `controlPlaneMode: cpStatus.mode`, `controlPlaneRoot`, `effectiveControlPlaneRoot`, `explicitControlPlaneRoot`, `pendingCandidate`, `repoScopeFilter: cpStatus.repoScopeFilter`, and `projectContextEnabled`.

**Why this looked wired.** `projectFilter` and `projects` in the same payload **are** real in standalone — `setProjectFilter` is explicitly handled at `bootstrap.ts:791`, and `addProject` / `deleteProject` at `:799` / `:808`. So project *filtering* works, which makes the message look implemented. The control-plane and repo-scope half beside it is fabricated. A spot check of "does project filtering work in the browser?" passes and proves nothing about the other seven fields.

One instance of the hardcoded-payload class described in `standalone-push-parity-guard.md` — and the one where some constants may be *correct*, which is exactly why they must be made deliberate.

### Decision: derive what applies, constant-with-reason for what does not

Some of these concepts may have no meaning in a single-root standalone host. The rule for this plan:

- **Derive** every field the provider can resolve for the served workspace root — `repoScopeFilter`, `activeFilter`, `projectContextEnabled`, and the control-plane fields via `getControlPlaneSelectionStatus`.
- Where a concept genuinely has no standalone meaning, keep the constant but make it **explicit**: a named constant with an inline comment stating why, so it reads as a decision rather than an oversight and the parity guard can allowlist it with a reason.

No field may remain an unexplained literal. That is the failure mode this whole feature exists to end.

## User Review Required

None.

## Complexity Audit

### Routine
- Wiring `getControlPlaneSelectionStatus` and `_resolveProjectContextEnabled` into both builders.

### Complex / Risky
- **Deciding which fields are meaningful.** `getControlPlaneSelectionStatus` may assume multi-root editor state. Each of the seven fields needs a determination — derive or documented-constant — and getting this wrong in the permissive direction (deriving a value the standalone host cannot honour) surfaces UI affordances that then do nothing, which is worse than the current honest-but-wrong `'none'`.
- **`effectiveControlPlaneRoot` / `explicitControlPlaneRoot` currently both equal `workspaceRoot`.** That may be exactly right for a single-root host. Confirm against `getControlPlaneSelectionStatus`'s contract rather than assuming; if right, keep it as a documented constant.
- **`projectContextEnabled` is async** (`_resolveProjectContextEnabled`). `pushFullState`'s assembly must await it without disturbing broadcast order.
- **Both builders must change.**
- **Interaction with the parity guard's allowlist.** Any field kept constant must land in `scripts/standalone-parity-allowlist.json` with its justification in the same change, or the guard's baseline hides it again.

## Edge-Case & Dependency Audit

**Race Conditions** — none beyond the existing coalesced push (`bootstrap.ts:395`).

**Security** — control-plane roots are filesystem paths already known to the host; no new exposure.

**Side Effects**
- Repo-scope filtering becoming live changes which cards the browser board displays for multi-repo workspaces. Users may see fewer cards than before — correct, but a visible change. Release-note it.
- `projectContextEnabled` turning on may change prompt generation for dispatches initiated from the browser. Verify a browser-initiated dispatch produces the same prompt as the editor for the same card.

**Dependencies & Conflicts**
- Same two payload entries as the column-structure plan; expect merge conflicts if developed in parallel.

## Dependencies

- None (hard). Sequencing: after `standalone-push-parity-guard.md`, and ideally after the column-structure plan since both rewrite the `updateWorkspaceSelection` / `updateColumns` entries.

## Implementation

### 1. Determine per-field disposition

**File:** none — analysis step, recorded in the code comments produced by step 2.

For each of the seven fields, determine derive-vs-constant against `getControlPlaneSelectionStatus`'s contract for a single-root host. Record the reason inline.

### 2. Wire the derived values

**File:** `src/standalone/bootstrap.ts`

- Call the provider's `getControlPlaneSelectionStatus(root)` and `_resolveProjectContextEnabled(root)` (exposed publicly as needed) in both builders and map their results onto the payload exactly as `KanbanProvider.ts:1154-1168` does.
- Replace every remaining literal with a named constant carrying a one-line justification.

**File:** `src/services/KanbanProvider.ts`

- Expose the two resolvers if they are not already public. Do not reimplement either in standalone.

### 3. Record intentional constants

**File:** `scripts/standalone-parity-allowlist.json`

- Add any field deliberately kept constant, with its reason.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Logic:** Derived control-plane and scope fields in both builders; named, justified constants for the rest.
- **Edge Cases:** Async `projectContextEnabled` must not disturb broadcast order; no unexplained literals may remain.

### `src/services/KanbanProvider.ts`
- **Logic:** Public access to the two existing resolvers.

### `scripts/standalone-parity-allowlist.json`
- **Logic:** Justified exemptions for fields with no standalone meaning.

## Verification Plan

### Automated
- Test: `getFullState()`'s `updateWorkspaceSelection` reflects a configured repo-scope filter rather than `null`.
- Test: `projectContextEnabled` reflects real configuration.
- Test: no field in the entry is an unexplained literal — every constant appears in the allowlist with a non-empty reason.
- Guard: `standalone-parity:check` hardcoded-field baseline drops.

### Manual (standalone host)
1. Set a repo-scope filter in the editor; reload the browser — the board shows the scoped card set, matching the editor.
2. Clear it — the full set returns.
3. With project context enabled, dispatch a card from the browser and confirm the generated prompt matches the editor's for the same card.
4. Project filtering (already working) still behaves — guard against regressing the half that was correct.
5. Read the final payload construction and confirm every constant carries a stated reason.
6. Extension unaffected.

## Recommendation

Complexity 4 → **Send to Lead Coder.** Mechanically small, but it requires a per-field judgement about what the single-root host can honour, and getting that wrong in the permissive direction surfaces dead affordances.
