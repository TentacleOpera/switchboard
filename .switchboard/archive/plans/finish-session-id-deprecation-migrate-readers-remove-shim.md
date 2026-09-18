# Add a Shared `resolvePlanByAnyId` Resolver (plan_id-first, session_id fallback)

**Plan ID:** c5d6671c-2cbb-4ec2-bd34-3e27586585aa

## Goal

Add one shared, read-only helper — `KanbanDatabase.resolvePlanByAnyId(id)` — that resolves a plan by `plan_id` first and falls back to the legacy `session_id`, with a central empty-string guard. Mark `getPlanBySessionId` `@deprecated` in favour of it. Nothing else changes: no readers are migrated, no delete paths touched, no shim removed.

### Problem & background

`session_id` was deprecated as a row key in migration V20 (the unique key became `(plan_file, workspace_id)` — `MIGRATION_V20_SQL` at KanbanDatabase.ts:409). Since then, identifiers named `sessionId` flow through webview messages, run sheets, and API params but are semantically **plan ids** for every row created after V20 (or empty strings for watcher-imported rows). Genuine legacy `sess_*` ids still exist only in rows from released versions (~4,000-install base — assume they exist).

The result is a scattered pattern: six call sites already hand-roll `getPlanByPlanId(id) ?? getPlanBySessionId(id)` (in two different orders), and ~34 more call `getPlanBySessionId` directly. There is no single, guarded way to resolve an id of ambiguous vintage, so each new lookup re-invents one — and a bare `getPlanBySessionId('')` can match arbitrary watcher-imported rows (a known footgun; see comments at KanbanProvider.ts:10222 and TaskViewerProvider.ts:2413).

**Scope note (why this plan is small).** The data-corruption bug that motivated the original, larger "finish the deprecation" effort — the `is_feature` clobber — was already fixed by the companion plan `fix-is-feature-clobber-persist-interleave-race.md` (commit `b259620`, on `main`). That commit replaced the destructive delete+reinsert shim with a benign in-place `UPDATE` (`canonicalizeSessionIdByPlanId`, KanbanDatabase.ts:2380). With the harm gone, the remaining reader-migration and shim-removal work is a high-risk chase for tidiness against the two largest files in the codebase, whose failure mode is the *same* "cards/features vanish" symptom that was just fixed. That work has been **cut**. This plan keeps only the one piece that is purely additive and useful on its own: the resolver. Future callers can adopt it opportunistically; no mass migration is mandated.

## Metadata

**Tags:** backend, database, reliability
**Complexity:** 1

## User Review Required

- None. (The `session_id` column and its legacy `sess_*` values ship in released versions and are untouched — this plan only adds a read helper.)

## Complexity Audit

### Routine

- Add `KanbanDatabase.resolvePlanByAnyId(id)` — a thin `getPlanByPlanId(id) ?? getPlanBySessionId(id)` wrapper with an empty-string guard, matching the pattern six call sites already hand-roll.
- Add an `@deprecated — use resolvePlanByAnyId` doc comment to `getPlanBySessionId`.

### Complex / Risky

- None. The change is additive and read-only.

## Edge-Case & Dependency Audit

**Race Conditions**
- None. The resolver is read-only and introduces no write path.

**Security**
- No new inputs; both underlying queries stay parameterized. The empty-string guard prevents `getPlanBySessionId('')` from matching arbitrary watcher-imported rows.

**Side Effects**
- `getPlanBySessionId` stays public — it is the resolver's fallback arm and the only path that resolves long-tail legacy `sess_*` rows. The `@deprecated` marker documents intent without removing the method; do not let a future cleanup delete it.

**Dependencies & Conflicts**
- Published-extension rule: the `session_id` column and its legacy values shipped — never dropped, never rewritten. This plan changes nothing about them.
- No migration required (no data change).
- No dependency on any other plan. (The companion `is_feature` fix is already on `main`, but this plan does not depend on it — the resolver is orthogonal.)

## Adversarial Synthesis

The only risk of a purely-additive read helper is that it is written wrong. Two failure modes to check in review: (1) the empty-string guard must reject whitespace, not just `''`, so it cannot fall through to `getPlanBySessionId(' ')`; (2) ordering must be plan-id-first so the canonical key always wins over a legacy `session_id` collision. Both are covered by the unit tests below. Because no existing call site is changed, there is no behavior-change surface and nothing to migrate, soak, or bisect.

## Proposed Changes

### `src/services/KanbanDatabase.ts`: single shared resolver

- **Context:** six call sites already hand-roll `getPlanByPlanId(id) ?? getPlanBySessionId(id)`; the rest call `getPlanBySessionId` directly. This adds the canonical, guarded version they can adopt over time.
- **Implementation:** add immediately after `getPlanByPlanId` (KanbanDatabase.ts:3192; `getPlanBySessionId` is at 3100 — the resolver calls both). Confirmed absent as of 2026-07-06, so this is purely additive:
  ```typescript
  /**
   * Resolve a plan by an identifier of ambiguous vintage: plan_id first (the
   * canonical key), then session_id (legacy sess_* rows from released versions).
   * Empty/blank ids resolve to null — never let '' match a watcher-imported row.
   */
  public async resolvePlanByAnyId(id: string): Promise<KanbanPlanRecord | null> {
      if (!id || !id.trim()) return null;
      return (await this.getPlanByPlanId(id)) ?? (await this.getPlanBySessionId(id));
  }
  ```
- **Also:** add `@deprecated — use resolvePlanByAnyId` to the `getPlanBySessionId` doc comment (KanbanDatabase.ts:3100). Do not change its behavior or remove it — it remains the resolver's legacy fallback.

## Sequencing

1. Add the resolver + deprecation comment. Ships alone; additive; zero risk.

## Verification Plan

### Automated Tests

- Extend the `src/test/kanban-complexity.test.ts`-style DB tests: `resolvePlanByAnyId` resolves (a) a modern row by `plan_id`, (b) a legacy row whose only match is `session_id='sess_x'`, (c) returns `null` for `''` and for whitespace-only ids.

### Manual verification

- None required — no existing flow changes. A green build plus the unit tests above is sufficient.

## Recommendation

**Routine — assign to any coder.** Complexity 1, purely additive.

## Review Findings

Implementation matches the plan exactly (commit `52ac2af`). **Files changed:** `src/services/KanbanDatabase.ts` (added `resolvePlanByAnyId` at :3212 with the `!id || !id.trim()` guard; redirected `getPlanBySessionId`'s existing `@deprecated` marker to the resolver, behavior unchanged) and new `src/test/kanban-resolve-plan-by-any-id.test.ts` (7 tests: modern plan_id, legacy session_id fallback, plan_id-wins-on-collision, empty, whitespace `' '`/`'\t'`/`'\n'`, unknown-id). **Validation:** compile/tests skipped per review prompt; static checks confirm zero callers (purely additive, no regression surface), all test-referenced DB methods exist, `upsertPlans` persists empty `planId`/`sessionId` verbatim so the legacy/watcher test rows are valid, and `getPlanBySessionId` was already deprecated so no new build warnings. **Remaining risks:** none material — one harmless NIT (the fallback arm re-queries `plan_id` a third time via `getPlanBySessionId`'s own internal fallback; dead query, plan-id-first precedence preserved) left unfixed because touching `getPlanBySessionId` is out of scope.
