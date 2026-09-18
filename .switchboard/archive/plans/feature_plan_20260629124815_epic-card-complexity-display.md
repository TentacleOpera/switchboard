# Show Epic Complexity on the Epic Card (Replace the Timestamp)

## Metadata
**Complexity:** 2
**Tags:** frontend, ui, feature

## Goal

On the kanban board, replace the **timestamp** in the epic card's meta line with the epic's **complexity**, rendered with the same colored chip every normal plan card already uses. Today the epic meta line is `EPIC: N SUBTASKS · <timeAgo>`; it becomes `EPIC: N SUBTASKS · Complexity: <chip>`. Non-epic ("normal plan") cards are **not touched** — they keep `Complexity: <chip> · <timeAgo>` exactly as today.

### Problem Analysis

Now that an epic carries a real, derived complexity (see dependency below), the epic card has no way to surface it: the epic branch of `cardMetaContent` (`kanban.html:5384`, inside `createCardHtml`) swapped the complexity chip for the subtask count and shows only `EPIC: N SUBTASKS · <timeAgo>`. The relative timestamp is the least useful token on an epic card — the routing-relevant fact (how complex, therefore which lane) is invisible. We reclaim that slot for the complexity chip.

The `complexityValue`, `category`, and `complexityClass` variables are already computed **unconditionally for every card** at `kanban.html:5323-5325` (the non-epic branch at `:5386` uses them). So no new derivation is needed — the epic branch simply starts consuming values that are already in scope and already being computed for the card. The chip CSS for every category — including the space-bearing `very-low` and `very-high` classes produced by `categoryToCssClass` (`:5316-5318`) — already exists at `kanban.html:960-965`, so no CSS changes are required.

The frontend read path is verified: epic cards populate `card.complexity` from the DB row (`KanbanProvider.ts:1237` and the parallel completed-epic path at `:1254`; also `:2157`/`:2177`). Once the dependency stores the numeric max in the DB `complexity` column for epic rows, `scoreToCategory` (`:5303-5314`) maps it to the right category and the chip renders correctly.

### Dependency

This depends on **`feature_plan_20260629091401_epics-always-high-complexity.md`** (epic complexity = max of subtasks) landing first. Before it, an epic's stored complexity is `'Unknown'` → `category` is `Unknown`, and this card would read `EPIC: N SUBTASKS · Complexity: Unknown`. Ship the derive-complexity plan first (or together); do not ship this one alone.

## Decision (no open product questions)

- **Replace `· <timeAgo>` with `· Complexity: <chip>` on the epic branch only.** The timestamp is dropped from epic cards; it remains on normal plan cards.
- **Reuse the existing chip**, `<span class="complexity-indicator ${complexityClass}">${category}</span>` — identical markup/coloring to normal cards, so the board reads consistently. (If the raw numeric score is preferred over the category word, swap `${category}` for `${complexityValue}` — one-token change. Default: category chip, matching every other card.)
- **No changes to the non-epic branch, to card CSS, or to any plan `.md` file.** Scope is the single `card.isEpic ? … : …` ternary in `createCardHtml` (`kanban.html:5384`).

### Deliberate Tradeoff — completed epics lose their timestamp
The user explicitly asked to **replace** (not append to) the timestamp on epic cards. This applies to completed epics too: a done epic will show `EPIC: N SUBTASKS · Complexity: <chip>` with no "when did this finish?" token. This is an intentional consequence of the replace directive, not an oversight. If temporal info on completed epics is later deemed necessary, it can be reintroduced on the completed-epic branch only — out of scope here.

### Rejected Alternatives
- *Append complexity and keep the timestamp* — rejected: the user asked to **replace** the timestamp; the meta line has limited width and `EPIC: N SUBTASKS · Complexity: High · 2m ago` is cramped.
- *Add a separate complexity row* — rejected: inconsistent with normal cards, which carry complexity inline in the same meta line.

## User Review Required

- Confirm the **release-ordering gate** (see Edge-Case & Dependency Audit): this plan must not ship in a VSIX before `feature_plan_20260629091401_epics-always-high-complexity.md` and its backfill have landed in the same VSIX. Shipping this alone regresses every epic card from a useful timestamp to a gray `Complexity: Unknown`.
- Confirm the **completed-epic timestamp loss** (above) is acceptable as a deliberate tradeoff.

## Complexity Audit

### Routine
- One-line edit to the epic branch of the `card.isEpic ? … : …` ternary in `createCardHtml` (`kanban.html:5384-5386`): drop `${timeAgo}`, append `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`.
- Reuses variables already computed unconditionally at `:5323-5325` (`complexityValue`, `category`, `complexityClass`).
- Reuses existing chip CSS at `:960-965` — no new styles.
- Non-epic branch, card CSS, plan `.md` files, and all backend code untouched.

### Complex / Risky
- None in-code. The only risk is **release ordering** vs. the dependency plan (see Edge-Case & Dependency Audit), not implementation difficulty.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `cardMetaContent` is a pure template string built synchronously per render from already-computed locals; no async, no shared mutable state.
- **Security:** None. All interpolated values (`${category}`, `${complexityClass}`) are derived from `card.complexity` via pure local functions (`scoreToCategory`, `categoryToCssClass`) and are not user-controlled free text. No new `escapeHtml`/`escapeAttr` surface is introduced or removed.
- **Side Effects:** Dropping `${timeAgo}` from the epic branch removes the only consumer of `timeAgo` for epic cards, but `timeAgo` is still computed at `:5321` and still used by the non-epic branch at `:5386` — no dead-code concern worth a separate cleanup. No backend, DB, or plan-file effects.
- **Dependencies & Conflicts:**
  - **Hard dependency on `feature_plan_20260629091401_epics-always-high-complexity.md`.** That plan stores the derived max in the DB `complexity` column for epic rows; this plan reads it via `card.complexity` (`KanbanProvider.ts:1237`). Without it, every epic renders `Complexity: Unknown` (gray chip) — a strict UX regression from today's useful timestamp.
  - **Release-ordering gate:** This plan must ship in the **same VSIX** as (or a later VSIX than) the dependency, and the dependency's backfill (`_runMigrations` epic-complexity UPDATE) must have run on upgraded installs. Do not release this in a standalone VSIX before the dependency.
  - **No conflict** with the worktree chip (`:5388-5397`): that chip is appended to the *topic* line, not the meta line, so the meta-line edit does not interact with it.
  - **Meta-line width:** the widest realistic epic meta line is `EPIC: 12 SUBTASKS · Complexity: Very High`. The implementer should eyeball this once in the rendered webview to confirm no overflow/truncation in `.card-meta`; the existing normal-card line `Complexity: Very High · <timeAgo>` is comparable in width and renders fine today, so no issue is expected.

## Dependencies

- `feature_plan_20260629091401_epics-always-high-complexity.md` — epic complexity = max of active subtasks (stores numeric max in DB `complexity` column; backfills legacy epics). Must land in the same or an earlier VSIX than this plan.

## Adversarial Synthesis

Key risks: (1) **release-ordering regression** — shipping this before the dependency turns every epic card's useful timestamp into a gray `Complexity: Unknown` for all installs; (2) **completed-epic timestamp loss**, a deliberate but irreversible-per-release UX change. Mitigations: gate release to the same VSIX as the dependency and its backfill; document the completed-epic tradeoff as an explicit decision. The implementation itself is a verified one-line edit with all variables, CSS, and the frontend read path confirmed in scope.

## Proposed Changes

### `src/webview/kanban.html` — epic branch of `cardMetaContent` in `createCardHtml` (`:5384-5386`)
Current:
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · ${timeAgo}`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```
Change the epic branch to drop `${timeAgo}` and render the complexity chip instead (non-epic branch unchanged):
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

**Context:** `complexityValue`/`category`/`complexityClass` are computed at `:5323-5325`; chip CSS at `:960-965`; epic `card.complexity` sourced from the DB at `KanbanProvider.ts:1237` (and `:1254` for completed epics).
**Logic:** Pure template-string change, no control-flow or state change.
**Implementation:** Single edit to the epic branch of the ternary. Do not touch the non-epic branch.
**Edge Cases:** All-unscored epic → `Complexity: Unknown` (gray chip) — acceptable **only when** the dependency has landed (unscored epics are then the genuine edge case, not the default). Completed epics lose their timestamp (deliberate, see Decision).

## Verification Plan

### Automated Tests
None — this is a single-line frontend template change with no new logic, no new state, and no new CSS. Behavior is covered by manual visual verification on the installed VSIX. (Per session directive, automated tests are not run here; the suite will be run separately by the user.)

### Manual (installed VSIX — dev does not use `dist/`)
1. With the derive-complexity plan in place, create an epic from score-3 plans → card reads `EPIC: 3 SUBTASKS · Complexity: Low` with the Low-colored chip; no timestamp.
2. Create an epic containing a score-8 plan → card reads `… · Complexity: High` with the High chip.
3. Confirm a **normal** plan card is unchanged: `Complexity: <chip> · <timeAgo>`, timestamp still present.
4. An epic whose subtasks are all unscored reads `… · Complexity: Unknown` (gray chip) — acceptable; tracked by the existing Unknown handling.
5. **Failure-path regression check (release ordering):** temporarily revert the dependency (or test on a build without it) and confirm an epic card reads `EPIC: N SUBTASKS · Complexity: Unknown` with **no timestamp** — this documents the exact regression users would see if this plan shipped in a VSIX before the dependency. Use this to confirm the release-ordering gate is enforced, not to ship this state.
6. Eyeball the widest epic meta line `EPIC: 12 SUBTASKS · Complexity: Very High` in the rendered webview to confirm no overflow/truncation in `.card-meta`.
7. Confirm a completed epic shows `EPIC: N SUBTASKS · Complexity: <chip>` with no timestamp (deliberate tradeoff, see Decision).

## Recommendation

Complexity 2 → **Send to Intern**. One-line template edit, all variables/CSS/read-path verified in scope, no backend or state changes. The only non-trivial constraint is the release-ordering gate against `feature_plan_20260629091401_epics-always-high-complexity.md`, which is a release-management concern, not an implementation one.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> **It's a one-line edit. It's correct.** The epic branch of `cardMetaContent` (`kanban.html:5350-5351`) now reads `EPIC: N SUBTASKS · Complexity: <chip>` — the `${timeAgo}` is gone, the complexity chip is in. The non-epic branch (`:5352`) is unchanged: `Complexity: <chip> · ${timeAgo}`. The `complexityValue`/`category`/`complexityClass` variables are computed unconditionally at `:5289-5291`, before the ternary. The chip CSS at `:960-965` is untouched. There is nothing to complain about. The dependency (`feature_plan_20260629091401`) has landed — epic complexity is now the derived max, stored in the DB, so `card.complexity` carries a real value. The release-ordering gate is satisfied.

### Stage 2 — Balanced Synthesis

**Keep:**
- The epic branch template change — `${timeAgo}` dropped, complexity chip appended.
- The non-epic branch — untouched, timestamp preserved.
- All variable computation — unconditional at `:5289-5291`, in scope for both branches.

**Fix now:** None required.

**Defer:** None.

### Files Changed (Verified)
- `src/webview/kanban.html` — epic branch of `cardMetaContent` in `createCardHtml` (`:5350-5351`): `${timeAgo}` replaced with `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`. Non-epic branch unchanged (`:5352`).

### Validation Results
- **Grep verification:** `cardMetaContent` — 3 hits (declaration `:5350`, epic branch `:5351`, non-epic branch `:5352`). `EPIC:.*SUBTASK` — 1 hit at `:5351`, confirms the epic branch. `timeAgo` — still computed at `:5287` and used by non-epic branch at `:5352`. No dead-code concern.
- **Dependency check:** `feature_plan_20260629091401_epics-always-high-complexity.md` — landed. `recomputeEpicComplexity` stores numeric max in DB `complexity` column. `card.complexity` sourced from DB at `KanbanProvider.ts:1237`. Release-ordering gate satisfied.
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.

### Remaining Risks
- **Release-ordering:** This plan and its dependency must ship in the same VSIX. Both are now implemented — the gate is satisfied as long as they release together.
- **Completed-epic timestamp loss:** Deliberate tradeoff per the plan's Decision section. Completed epics show `Complexity: <chip>` with no timestamp. Acceptable.
