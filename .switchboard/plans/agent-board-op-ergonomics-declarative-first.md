# Make Board/Feature Ops Ergonomic for Agents: Declarative-First, No UUID Choreography

**Feature:** eadc0c9f-9d3b-45ce-b457-455f8762ddce

## Goal

Cut the interaction cost of driving the board from an agent. Adding one plan to a feature and
placing its card should be **one path/slug-addressed call (or zero, via the file)**, not a
multi-step UUID dance. Concretely: (1) add the **missing clean single-add primitive** — an
additive, path/slug-addressed assign that takes one plan and one feature with no UUID and no
full-set enumeration; (2) fix the file-based `**Feature:**` link so authoring a plan file self-links
it on import (the zero-call path); (3) make the declarative `POST /kanban/features/reconcile` the
*documented default* for multi-plan restructures; and (4) clean up the script output that makes the
imperative path fragile.

### The missing primitive (the headline gap)

There is **no clean way to add a single plan to a feature** today — every path is flawed:
- **`assign-to-feature.js`** — additive and safe, but requires raw planId UUIDs for *both* the
  feature and the plan (`plan_ids_json` is a JSON array of planIds). UUID choreography.
- **`reconcile`** — path/slug-addressed (no UUID), but **converge-to-set**: you must declare the
  feature's *entire* desired subtask set; omitting a subtask detaches it (per its own docs). Wrong
  shape for "add one" — to add a single plan you must first fetch the full current set, append, and
  resend all of it.
- **`**Feature:** <uuid>` file line** — the intended zero-call path, but it **silently no-ops on
  import** (confirmed twice this session) and still needs the feature UUID.

The primitive that should exist: additive (never detaches), single-plan, resolves feature *and*
plan by path/slug/name/id, no full-set enumeration. e.g. `POST /kanban/features/assign
{ feature: <name|path|slug|id>, plan: <path|slug|id> }` and a matching `assign-to-feature`
that accepts paths.

### Background & root-cause (observed live, 2026-07-09)

Discovery is not the problem here — the feature-op tools are perfectly discoverable. **Ergonomics**
is: once you've found the right tools, using them is expensive and full of footguns. Adding a
single subtask to a feature this session took ~6 round-trips with two dead-ends:

1. Wrote the plan file → waited for async import.
2. `get-state.js` — piped stdout failed to parse as JSON (a `[KanbanData…]` **log line leaked to
   stdout**, though the skill claims diagnostics go to stderr).
3. `move-card.js <plan_file> "PLAN REVIEWED"` — worked (it already accepts a path — good).
4. Discovered the `**Feature:** <uuid>` line written into the plan file **did not link it** on
   import (the auto-block still showed the old set; no `subtask-of:` marker).
5. `assign-to-feature.js` — failed once because arg 2 must be a **JSON array of planIds**
   (`'["<uuid>"]'`), not a bare id.
6. Retried `assign-to-feature.js` with the JSON array → finally linked.

The declarative fix already exists: `POST /kanban/features/reconcile` (`reconcile-features.js`) is
**path/slug-addressed, needs no UUID**, and does file-write + import + link in one idempotent call.
The gap is that (a) agent guidance still leads with the imperative UUID scripts, (b) the
file-based `**Feature:**` link — the zero-call path — silently no-ops, and (c) script stdout
hygiene breaks the imperative fallback. This is guidance + two bug-fixes, **not new plumbing**
(the endpoint is built). See the existing project note "feature-ops are UUID-choreography — bad
agent UX."

## Metadata

- **Tags:** refactor, devops, cli, docs
- **Complexity:** 5

## User Review Required

- **Keep the imperative verb scripts?** Recommendation: **yes, keep** `assign-to-feature.js` /
  `remove-from-feature.js` / `move-card.js` etc. as low-level primitives, but **de-emphasize them
  in agent-facing guidance** in favor of `reconcile` + path-addressed calls. Not a deletion.

## Complexity Audit

### Routine
- Rewriting the `kanban_operations` / `switchboard-manage` guidance to lead with `reconcile`
  (path/slug) and document `move-card.js`'s existing path-addressing.
- Routing `get-state.js` diagnostics to stderr so stdout is clean JSON.

### Complex / Risky
- **The `**Feature:**`-on-import fix is the load-bearing, non-trivial part.** It touches the plan
  watcher / importer, which runs for ~4,000 installs. Must be apply-if-empty (never clobber an
  existing feature link) and must not regress the existing import path. Root cause is unconfirmed
  (placement? parse? the ID-assign vs link-apply ordering?) — investigation required before the fix.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `**Feature:**` link and the planId assignment happen during the same
  import; the fix must apply the link in that pass, not depend on a second scan.
- **Security:** None.
- **Side Effects:** Changing importer link behavior affects every plan file carrying a `**Feature:**`
  line — verify apply-if-empty so it can't detach/re-home an already-linked plan.
- **Dependencies & Conflicts:** No file overlap with the other subtasks (they touch
  `MIRROR_MANIFEST` / skill bodies; this touches the watcher + `kanban_operations` guidance +
  `get-state.js`). Independent.

## Dependencies

- `sess_local_agent_skills_improvements — feature "Agent skills improvements"`. Independent of the
  other three subtasks; shares no files. Like them, its guidance/skill changes propagate to the
  install base only via the version bump (the release subtask), so it should be merged before that
  bump if it is to ship in 1.7.6.

## Adversarial Synthesis

**Risk Summary:** Mostly guidance/output hygiene (low risk), with one real code change — the
importer's `**Feature:**` link — that touches the ~4,000-install import path and must be
apply-if-empty so it never clobbers or detaches an existing link. Root cause of the observed
no-op is unconfirmed, so scope the importer change behind an investigation step and verify the
existing import path is unaffected.

## Proposed Changes

### Clean single-add primitive (headline) — additive, path/slug-addressed assign
- **Context:** No clean single-plan → feature add exists (see "The missing primitive" above).
- **Logic:** Add an **additive** assign that resolves both operands by path/slug/name/id and never
  detaches: `POST /kanban/features/assign { feature, plan }` (server resolves via the same
  path/slug index `reconcile` uses), and extend `assign-to-feature.js` to accept paths/slugs (not
  just planId UUIDs). Additive = it only links; it never touches the feature's other subtasks, so
  it is safe to call for one plan without knowing the full set.
- **Implementation:** Reuse the resolver behind `reconcile` (it already maps path/slug/topic → planId
  server-side); the assign endpoint is a thin additive wrapper (no converge/detach logic).
- **Edge Cases:** Already-linked plan → no-op (idempotent); unknown feature/plan ref → clear error,
  never silently create or detach.

### Plan watcher / importer — fix `**Feature:** <uuid>` on import
- **Context:** A `**Feature:**` line written into a new plan file did not link it this session.
- **Logic:** Reproduce, find the root cause (parsing of the `**Feature:**` line, its accepted
  placement, or the ID-assign-vs-link ordering), and fix so the link applies on the import that
  assigns the planId — apply-if-empty (never overwrite an existing feature link).
- **Edge Cases:** Line placement variants (in `## Metadata` vs top-of-file), UUID vs slug value,
  already-linked plans (must skip).

### Agent guidance — declarative-first (`kanban_operations` SKILL + `switchboard-manage`)
- **Context:** Guidance leads agents to the imperative UUID scripts for simple structure changes.
- **Logic:** Make `POST /kanban/features/reconcile` (path/slug) the documented default for add/
  re-home/restructure; state plainly that `move-card.js` already takes a **plan file path** (no
  UUID) and that plan files should carry `**Feature:**` to self-link. Keep the imperative verbs
  documented as primitives, below the declarative path.
- **Edge Cases:** `reconcile` converges a feature's whole subtask set — document that you must list
  the full desired set (omission can detach), so agents don't accidentally strip subtasks.

### `get-state.js` — stdout hygiene
- **Context:** A `[KanbanData…]` log line leaked to stdout, breaking `| jq` / JSON parsing.
- **Logic:** Route all diagnostics to stderr; emit only parseable JSON on stdout (the skill already
  claims this — enforce it).

## Verification Plan

> Per session directive, no compilation / no automated tests in this session.

### Automated Tests
- None run here. A future importer unit test ("a plan file with `**Feature:** X` links to feature X
  on import, apply-if-empty") would lock in the load-bearing fix.

### Manual acceptance
1. **File-based link works:** write a new plan with a `**Feature:** <uuid>` line → on import it is
   linked (auto-block shows it; `subtask-of:` marker present) with **zero** script calls.
2. **Declarative add:** an agent can add a plan to a feature and place its card using path/slug
   only, in ≤2 calls, no UUID, no dead-ends.
3. **Clean stdout:** `node get-state.js <root> | jq .` parses without stripping log lines.

## Recommendation

**Complexity 5 → Send to Coder.** The guidance + stdout fixes are routine; the importer
`**Feature:**` fix is the real work and touches the install-base import path, so it needs the
investigation + apply-if-empty care called out above.

---

## Code Review — In-Place Reviewer Pass (2026-07-09)

Reviewed the committed implementation (`a4ad186`) against this plan. **Result: all four deliverables
land correctly; the load-bearing importer fix is done with proper apply-if-empty + defer/retry care;
no CRITICAL/MAJOR findings; no code fixes required.**

### Deliverable-by-deliverable
1. **Single-add primitive — DONE, correct.** `POST /kanban/features/assign`
   (`LocalApiServer.ts:624`, routed `:2411`): auth → `assignToFeature` option guard (503) →
   validates `feature` + `plan`/`plans` (400) → delegates. Wired via `TaskViewerProvider.ts:1271` →
   `KanbanProvider.assignPlansToFeature:11093`. Resolution is genuinely no-UUID:
   `db.resolveFeatureIdentifier` (`KanbanDatabase.ts:3562`: id→path→topic/slug→basename, `is_feature=1`)
   + `db.resolvePlanIdentifier` per plan. **Additive verified:** a plan already on a *different*
   feature is pushed to `skipped`, never re-homed (`KanbanProvider.ts:11126`); locked-column guard
   present (`:11116`). Additive alongside the retained singular `/kanban/feature/assign`.
2. **`**Feature:**`-on-import fix — DONE, correct (the real work).** Root cause was the link-apply
   step, not the parse: `parsePlanMetadata` (`planMetadataUtils.ts:110`) already extracts
   `**Feature:**` (regex handles plain / list / numbered / blockquote; accepts UUID *or* name).
   `_applyFeatureLink` (`GlobalPlanWatcherService.ts:651`) is **apply-if-empty** (only links when the
   subtask's `feature_id` is empty — never clobbers a DB/UI link, `:682`), defers with a max-retry
   drop when the feature isn't imported yet (`:669`), and regenerates the parent feature file so its
   Subtasks block updates (`:693`). Applied on **both** fresh import (`:897`) and re-save (`:1018`),
   and deferred links retry on feature-file import (`:893`) — so both import orders resolve.
3. **Declarative-first guidance — DONE.** `kanban_operations/SKILL.md` now leads with `reconcile`,
   documents `move-card.js`'s path-addressing, the new single-add endpoint, `**Feature:**`
   self-linking, and the converge-to-set caveat. `switchboard-manage` §2/§3 mirror it.
4. **`get-state.js` stdout hygiene — DONE, correct.** `console.log/info/warn/debug` redirected to
   stderr on line 2 **before** the `require('KanbanDatabase')` (so even an import-time capture gets
   the redirected binding), and `process.stdout.end(payload, cb)` flushes JSON before exit. The
   stale "don't parse stdout" warning was removed from the SKILL.

### Findings
- **NIT (defer):** stale endpoint naming — `LocalApiServer.ts:622` comment and
  `assign-to-feature.js:7` header still say the *singular* `/kanban/feature/assign` is "for the
  kanban_operations script," but the script now calls the *plural* endpoint (`:105`);
  `switchboard-orchestration/SKILL.md:117` documents only the singular. All cosmetic — both
  endpoints exist and both resolve refs. No functional impact.
- **NIT (defer):** re-assigning a plan already on the *same* feature reports it in `assigned` (not a
  no-op in the report), though it is a functional no-op. Harmless.

### Files changed by this review
- None (no CRITICAL/MAJOR findings).

### Validation (per directive: no compile, no tests)
- Confirmed `assign-to-feature.js` emits `{ok:true,assigned,skipped}` — matches the SKILL doc.
- Confirmed `parsePlanMetadata` populates `metadata.feature` (so the `else if (metadata.feature)`
  link branch is live, not dead code) and was unchanged by this commit — validating the
  root-cause-is-link-apply conclusion.
- Confirmed the additive skip path and locked-column guard by reading `assignPlansToFeature`.

### Remaining risks
- End-to-end acceptance (write a plan with `**Feature:**`, observe it link with zero script calls)
  requires a running extension; static review confirms the code path is correct and apply-if-empty.
- Ships to the install base only via the 1.7.6 bump (sibling subtask), as noted.
