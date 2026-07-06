# Finish the session_id Deprecation: Migrate Readers to plan_id and Remove the Registry Convergence Shim

**Plan ID:** c5d6671c-2cbb-4ec2-bd34-3e27586585aa

## Goal

Complete the half-finished `session_id` deprecation: migrate every production reader that still resolves plans by `session_id` onto `plan_id` (via a single shared resolver), retire the deprecated session-keyed `deletePlan`, and then remove the plan-registry canonicalization shim whose only purpose is forcing `session_id = plan_id` — the shim whose destructive delete+reinsert implementation caused the feature `is_feature` clobber.

### Problem & background

`session_id` was deprecated as a row key in migration V20 (UNIQUE constraint removed; the unique key became `(plan_file, workspace_id)` — see `MIGRATION_V20_SQL` at KanbanDatabase.ts:409; `KanbanDatabase.deletePlan` carries an explicit `@deprecated session_id is no longer the unique key` marker at KanbanDatabase.ts:2354). The deprecation was never finished:

- **April 2026** (`231c3b4`): a "stale entry" sweep landed in `TaskViewerProvider._loadPlanRegistry` (TaskViewerProvider.ts:11569-11634). Its purpose is a compatibility shim — force `session_id = plan_id` on every row so legacy session-keyed lookups keep resolving. It was implemented destructively (`deletePlan` + lossy re-insert via `insertFileDerivedPlan`), which is what demoted features to `is_feature=0` (see companion plan `fix-is-feature-clobber-persist-interleave-race.md`).
- **June 16, 2026** (`c2eb8dd`, "Fix Immediate session_id Lookup Risks"): an agent migrated a handful of lookups from `getPlanBySessionId` to `getPlanByPlanId` inside `_registerPlan` — but left the shim itself, and the remaining ~47 session-keyed call sites, untouched.

Current production surface (originally surveyed 2026-07-06 *before* the companion fix landed; **all line numbers re-verified 2026-07-06 against `main` after the companion landed** — see the freshness note below):

- `getPlanBySessionId` callers: **TaskViewerProvider.ts ×23 calls** (+2 comment references at 2413, 15296), **KanbanProvider.ts ×14** (10 direct lookups + 3 hand-rolled fallbacks + 1 comment at 10313), **ContinuousSyncService.ts:1155**, **SessionActionLog.ts:76**. (These four are the *only* production files that call it — no other source file outside `KanbanDatabase.ts` does; test files are out of scope.)
- Deprecated `deletePlan(sessionId)` callers: **TaskViewerProvider.ts ×7** (11150, 11791, 11798, 13122, 13754, 14831, 15304).
- Several sites already use a hand-rolled two-key fallback — but in **two different orders**: KanbanProvider.ts:7752, 7780, 8122 use plan-id-first (`getPlanByPlanId(id) ?? getPlanBySessionId(id)`), while TaskViewerProvider.ts:2416, 12177, 14709 use session-id-first (`getPlanBySessionId(id) ?? getPlanByPlanId(id)`). Both prove the ids flowing through these paths are usually plan ids already; the resolver standardizes all of them on plan-id-first (see Phase B edge cases — this flips the TaskViewerProvider trio's precedence, intentionally).

> **Line-number freshness.** All line numbers below were re-verified on 2026-07-06 against `main` *after* the companion fix (`b259620`) landed. KanbanProvider / ContinuousSyncService / SessionActionLog and everything above ~line 11500 in TaskViewerProvider are current; TaskViewerProvider's registry region (`_loadPlanRegistry` / `_registerPlan` and everything after) shifted ~+35 lines vs the original survey because the companion added the canonicalization plumbing there. Treat every number as advisory — **re-grep each signature immediately before editing**. The grep-gate in the Verification Plan, not these numbers, is the completeness check.

The shim cannot be deleted first: legacy session-keyed readers depend on the `session_id = plan_id` convergence for modern rows. Ordering therefore must be **readers first, shim last**.

**Root cause of the mess:** identifiers named `sessionId` flow through webview messages, run sheets, and API params, but for all rows created since V20 they are semantically plan ids (or empty strings for watcher-imported rows). The DB layer kept a session-keyed API alive, so callers kept using it, so the registry had to keep forcing the two columns equal — a circular dependency between a deprecated key and the shim propping it up.

### Relationship to the companion plan

`fix-is-feature-clobber-persist-interleave-race.md` (must land FIRST) makes the shim **non-destructive** (in-place canonicalization, batched sweep, `sessionId = planId` at feature mint). This plan then removes the need for the shim altogether. Do not start Phase D until the companion plan is deployed and verified.

**Companion status (verified 2026-07-06):** the companion is **already committed to `main`** — commit `b259620` "Fix is_feature clobber via insertFileDerivedPlan race". Its two new DB methods are live: `canonicalizeSessionIdByPlanId` (KanbanDatabase.ts:2380, in-place) and the batched `canonicalizeSessionIds` (2393), and `_registerPlan` (TaskViewerProvider.ts:11787) / `_loadPlanRegistry` (11647) now canonicalize in place rather than via delete+reinsert. The **code-level** dependency is therefore satisfied — Phases A–C can proceed now. The **remaining gate is release + soak**: the companion must ship in a released VSIX and run at least one normal release cycle (Sequencing step 4) before Phase D removes the shim.

## Metadata

**Tags:** backend, refactor, database, reliability
**Complexity:** 7

## User Review Required

- None. (One judgment call is pre-decided below: the `session_id` **column stays** in the schema — it still stores genuine legacy `sess_*` ids from released versions and run-sheet keys. Only its use as a lookup/convergence key is removed.)

## Complexity Audit

### Routine

- Adding `KanbanDatabase.resolvePlanByAnyId(id)` — a thin `getPlanByPlanId(id) ?? getPlanBySessionId(id)` wrapper (with empty-string guard), the pattern six call sites already hand-roll.
- Mechanical replacement of `getPlanByPlanId(x) ?? getPlanBySessionId(x)` pairs and plain `getPlanBySessionId(x)` calls with the resolver.
- Replacing `deletePlan(sessionId)` calls with `deletePlanByPlanId` where the variable is provably a plan id (e.g. TaskViewerProvider.ts:11154 already passes `planId`).
- Deleting the stale-sweep block and `_getRegistrySessionId`/`_getRegistrySessionIdCandidates` once nothing needs convergence.

### Complex / Risky

- **Per-site identifier classification** across ~47 sites: each `sessionId` variable must be traced to its source (webview card id, run-sheet key, API param, DB row field) and classified as plan-id, genuine legacy session-id, or ambiguous. Misclassification silently breaks a flow (lookups return null → features/cards vanish from that flow, the same failure family as the clobber).
- `SessionActionLog._resolvePlan` (SessionActionLog.ts:76) is keyed by "sessionIdOrPlanFile" — a three-way ambiguous identifier; needs the resolver plus its existing plan-file fallback, in the right order.
- Removing the sweep changes an invariant (`session_id = plan_id` on modern rows) that unknown external consumers (agent scripts, `query_switchboard_kanban` SQL, archived tooling) may have started relying on.

## Edge-Case & Dependency Audit

**Race Conditions**

- The resolver is read-only; no new write paths. Removing the sweep removes writes, shrinking the race surface that caused the original clobber.
- `deletePlan(existing.sessionId)` at TaskViewerProvider.ts:11758/11764 is deleted together with the sweep (the companion plan already defangs it in the interim).

**Security**

- No new inputs; all queries stay parameterized. Empty-string guard in the resolver prevents `getPlanBySessionId('')` matching arbitrary watcher-imported rows (a known footgun — see comments at KanbanProvider.ts:10222 and TaskViewerProvider.ts:2413).

**Side Effects**

- Rows created between V20 and the companion plan's fix may have `session_id = ''` or random UUIDs forever (no more convergence). That is fine once no reader keys on session_id — but it means the resolver's session_id fallback must stay for genuine legacy `sess_*` rows from released versions (~4,000-install base; assume they exist). **Do not "tidy away" `getPlanBySessionId` after Phase D** — it stays public as the resolver's fallback arm. Keep its `@deprecated — use resolvePlanByAnyId` doc comment (added in Phase A) explicit so a future cleanup pass does not delete the only path that resolves long-tail legacy rows.
- Run sheets: `SessionActionLog` keys run-sheet rows by the id passed to `createRunSheet`. Verify run-sheet reads join on `plan_id` (they do via `getRunSheetByPlanId`, SessionActionLog.ts:453) — the run-sheet table is NOT part of this migration.

**Dependencies & Conflicts**

- **Hard dependency:** companion plan `fix-is-feature-clobber-persist-interleave-race.md` deployed and verified first.
- Published-extension rule: `session_id` column and its legacy `sess_*` values shipped — never drop the column, never rewrite legacy values. This plan only changes lookup behavior.
- Do not edit shipped `MIGRATION_Vnn_SQL` bodies. No new migration is required by this plan (no data change — deliberately).

## Dependencies

- Plan: `fix-is-feature-clobber-persist-interleave-race.md` (a1c3f7d2-8e5b-4a91-b6c0-9d2e4f8a1b5c) — must be coded, reviewed, and verified first.

## Adversarial Synthesis

Key risks: (1) misclassifying one of the ~40 identifier sites and silently breaking a lookup flow (features/cards vanish from that flow — the same failure family as the clobber); (2) the three TaskViewerProvider fallbacks flip from session-id-first to plan-id-first when collapsed — benign for all legitimate ids but a real precedence change a reviewer must see acknowledged; (3) hidden external consumers of the `session_id = plan_id` invariant; (4) scope creep into the run-sheet subsystem. Mitigations: a single shared resolver with plan-id-first/session-id-fallback semantics (behavior-preserving for every legitimate input), phased landing (one file per commit) with the shim removed only in the final phase after a soak, and explicitly excluding run-sheet keying and the `session_id` column itself from scope. The code-level companion dependency (`b259620`) is already on `main`; only its release + soak remains before Phase D.

## Proposed Changes

### Phase A — `src/services/KanbanDatabase.ts`: single shared resolver

- **Context:** six call sites already hand-roll `getPlanByPlanId(id) ?? getPlanBySessionId(id)`; the rest call `getPlanBySessionId` directly even though their ids are plan ids for all post-V20 rows.
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
- **Edge cases:** keep `getPlanBySessionId` public (legacy-only, used by the resolver); add `@deprecated — use resolvePlanByAnyId` to its doc comment.

### Phase B — migrate all production readers to the resolver

- **Files & sites (line numbers re-verified 2026-07-06 post-companion; re-grep before editing):**
  - `src/services/KanbanProvider.ts` — 10 direct lookup sites: 3317, 5667, 5725, 5744, 5785, 5865, 6929, 7858, 7878, 7897, plus collapse the 3 hand-rolled plan-id-first fallbacks at 7752, 7780, 8122 into the resolver.
  - `src/services/TaskViewerProvider.ts` — 23 sites: 1413, 1908, 2416 (collapse fallback — **flips to plan-id-first**), 3152, 3206, 3238, 3273, 3403, 11876, 12131, 12177 (collapse fallback — **flips to plan-id-first**), 12576, 13548, 13618, 13676, 13752, 14263, 14481, 14709 (collapse fallback — **flips to plan-id-first**), 14829, 14871, 15238, 16473, plus the `_registerPlan` internals.
  - `src/services/ContinuousSyncService.ts:1155` and `src/services/SessionActionLog.ts:76` (`_resolvePlan`, keyed by `sessionIdOrPlanFile` — resolver first, then its existing plan-file fallback that runs at SessionActionLog.ts:564).
- **Logic per site:** trace the identifier's source. If it is provably a `plan_id` (comes from `plan.planId`, a card id the webview built from `plan_id`, or an API `planId` param), call `getPlanByPlanId` directly. If ambiguous or run-sheet-derived, call `resolvePlanByAnyId`. Never leave a bare `getPlanBySessionId`.
- **Edge cases:** sites that guard against empty session ids (TaskViewerProvider.ts:2413-2416, KanbanProvider.ts:10313 comment) can drop their local guards — the resolver guards centrally. Preserve any surrounding null-handling behavior exactly.
- **Clarification — fallback-order standardization (not a new requirement):** the three TaskViewerProvider fallbacks being collapsed (2416, 12177, 14709) currently resolve **session-id-first** (`getPlanBySessionId(x) ?? getPlanByPlanId(x)`), whereas the resolver — like the KanbanProvider fallbacks — is **plan-id-first**. Collapsing them therefore flips precedence. This is intentional and behavior-preserving for every legitimate input: for all post-V20 rows `session_id = plan_id`, so both orders hit the same row; the only divergence is a pathological id that is simultaneously one row's `plan_id` and a *different* row's legacy `sess_*`, and there plan-id-first (canonical key wins) is the correct resolution, not merely an equivalent one. Do **not** preserve the old session-id-first order at these three sites.

### Phase C — retire deprecated `deletePlan(sessionId)`

- **Sites:** TaskViewerProvider.ts 11150, 11791, 11798, 13122, 13754, 14831, 15304.
- **Logic:** 11150 already passes a plan id (`await db.deletePlan(planId)`) → `deletePlanByPlanId(planId)`. 13122 passes `plan.sessionId` where `plan` is a resolved record → use `deletePlanByPlanId(plan.planId)`. 11791/11798/13754 belong to the sweep/duplicate machinery (inside `_registerPlan` / the stale-row purge) and are removed with Phase D — or, where the duplicate-purge logic must survive for brain rows, switched to `deletePlanByPlanId(duplicate.planId)`. 14831 (`deletePlan(sid)`) / 15304 (`deletePlan(sessionId)`): resolve the record first, then delete by its `planId`.
- **Then:** delete `KanbanDatabase.deletePlan` itself (KanbanDatabase.ts:2354-2362) once zero callers remain. Its body already resolves via `getPlanBySessionId` and then deletes by `plan.planId`, so replacing a caller with `deletePlanByPlanId` is exactly behavior-preserving whenever the argument is already a plan id.

### Phase D — remove the convergence shim (LAST, after a soak period)

- **Context:** with Phases A-C landed, no production code requires `session_id = plan_id`.
- **Implementation:**
  - `TaskViewerProvider._loadPlanRegistry` (method starts 11565; the `staleEntries` block spans ~11572–11656, including the batched `canonicalizeSessionIds(localSessionOnlyPairs)` call at 11647): delete the `staleEntries` collection and normalization loop for `sourceType='local'` rows entirely. **Keep** the brain-mirror normalization (`antigravity_` prefix / plan-id rename cases) — that is genuine data repair, not a session-id shim.
  - `_registerPlan` (method starts 11774): drop the session-id canonicalization branch — including the in-place `canonicalizeSessionIdByPlanId(entry.planId, sessionId)` call at 11787 added by the companion plan; keep the brain duplicate-purge with plan-id-keyed deletes.
  - Remove `canonicalizeSessionIds` (KanbanDatabase.ts:2393) batch plumbing if the local sweep was its only caller (keep `canonicalizeSessionIdByPlanId` at KanbanDatabase.ts:2380 only if brain paths still use it). Also retire `_getRegistrySessionId` (TaskViewerProvider.ts:11444) and `_getRegistrySessionIdCandidates` (11453) once nothing needs convergence, as flagged in the Complexity Audit — but confirm the brain/candidate paths (`_getRegistrySessionIdCandidates` is also read at 11794 and 11874) no longer need them first.
  - `createFeatureFromPlanIds` keeps `sessionId = planId` from the companion plan — harmless, and stops creating divergent rows.
- **Edge cases:** grep `.agents/skills/` and docs for SQL that assumes `session_id = plan_id` (e.g. `query_switchboard_kanban` examples) and update those examples to key on `plan_id`.

## Sequencing

1. Phase A (resolver) — additive, zero-risk, can ship alone.
2. Phase B (reader migration) — one file per commit (KanbanProvider, TaskViewerProvider, then the two small services) so a regression bisects to a file.
3. Phase C (delete-path retirement) — after B, since some deletes resolve via the migrated readers.
4. **Soak:** run at least one normal release cycle with Phases A-C live and the (companion-plan-defanged) shim still converging ids. Watch for `resolvePlanByAnyId` null-resolution warnings.
5. Phase D (shim removal) — only after the soak shows no session-id-fallback dependencies beyond legacy `sess_*` rows.

## Verification Plan

### Automated Tests

- Extend `src/test/kanban-complexity.test.ts`-style DB tests: `resolvePlanByAnyId` resolves (a) a modern row by plan_id, (b) a legacy row whose only match is `session_id='sess_x'`, (c) returns null for `''` and whitespace.
- A grep-gate in review: zero production `getPlanBySessionId(` calls outside `KanbanDatabase.ts` and zero `\.deletePlan(` calls anywhere after Phase C.

### Manual verification (installed VSIX)

1. Exercise the flows behind the highest-risk migrated sites: card move/complete from the board, sidebar plan complete/restore, ClickUp/Linear sync tick, plan delete from sidebar, feature create + subtask add.
2. Legacy-row check: hand-insert a row with `plan_id != session_id` (`sess_test123`) via sqlite3, confirm it still resolves in the sidebar and board after Phase D (fallback intact).
3. After Phase D: create a feature, click through the sidebar (fires `_loadPlanRegistry`), then `SELECT session_id, plan_id, is_feature FROM plans ORDER BY created_at DESC LIMIT 3;` — row untouched by any sweep, `is_feature=1`.

## Recommendation

**Send to Lead Coder** (Complexity 7).
