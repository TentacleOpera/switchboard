# Make plan project assignment deterministic — pins are ingest-only, and no ambient auto-assign

## Goal

Make a card's project assignment fully deterministic and eliminate every implicit writer:

1. A plan file's `**Project:**` pin resolves **once, at first import**, and never again — a file re-save must never move a card between project boards.
2. `kanban.activeProjectFilter` **stays, with its purpose intact**: a pinless plan lands on the currently active project, else unassigned. What changes is the key's integrity: **the user's dropdown action becomes its ONLY writer** — no constructor restore-write, no refresh-loop re-assert, no side-channel — and the board UI always displays exactly what the key holds, so the stamp can never act on a value the user isn't seeing.
3. After a card has arrived on a board, the board (and its API) is the **sole** authority over the card's project.

Design rule that resolves every incident below: the active-project value lives in ONE store (the per-workspace DB config), has ONE writer (the user's dropdown), and everything else — display, importer stamping, prompt pins — READS it. Every incident traces to extra writers and extra replicas of this one value. (Docs follow-up: CLAUDE.md's pinning section currently says a pinless plan "lands unassigned" — update it to "lands on the active project selected in the board dropdown, else unassigned.")

> **Clarification (single-writer precision, not a scope change):** "the dropdown is the ONLY writer" means the only *user-intent* writer. Two **bounded system-correction writers** legitimately touch the key and stay: `KanbanDatabase.deleteProject` (KanbanDatabase.ts:3409–3414) clears the key when the *active* project is the one being deleted, and the new departed-workspace clear (below). Neither is ambient — each writes a value the user would expect. The invariant is "one user writer + targeted corrections," and the grep gate is scoped accordingly.

### Problem & background — two incidents in 24 hours, both release-blocking

**Incident A (2026-07-19): file pin re-applied on save.** Proved the pin-contract violation end-to-end:

1. `merge-dev-docs-into-docs-tab.md` carries `**Project:** Website` in its Metadata block. At first import (04:38 UTC) the pin legitimately assigned the card to the Website project — sanctioned ingest-time behavior.
2. The user later moved the card to the workspace (root) board using the board's reassign button. That works correctly: `assignSelectedToProject` → `KanbanDatabase.setProjectForPlans` (KanbanDatabase.ts:3472) writes `project`, `project_id`, `updated_at` immediately.
3. An agent then edited the plan file (content amendments, 21:05–21:07 local). Each save fired `GlobalPlanWatcherService._handlePlanFile`, whose **update branch re-applied the file's stale pin** — six times in a row (Switchboard output log, "Updated plan" ×6) — silently dragging the card back onto the Website board and overruling the user's board decision.
4. A feature was then created from this plan plus another. `createFeatureFromPlanIds` (KanbanProvider.ts:11391) inherits the feature's project from the first subtask that has one — it faithfully inherited the corrupted `Website` value, so the feature landed on the Website board. Its subtasks nest under the feature card, so **both plans and the feature vanished from the root board the user was watching**. Cards appeared deleted; nothing was deleted.

**Incident B (2026-07-20): pinless import auto-assigned to a ghost filter the user never saw.** This very plan file was written by an agent with **no** `**Project:**` pin — the documented contract says it lands unassigned. Instead it appeared on the **Browser Switchboard** project board, while the user was on the workspace board and had not visited the Browser board at all. Cause chain: the editor restarted that morning (API port changed, proving reactivation); the KanbanProvider constructor (KanbanProvider.ts:384–401) restores the **last-ever persisted dropdown selection** from `workspaceState` — in this case `Browser Switchboard`, from an earlier session — and immediately writes it into the `kanban.activeProjectFilter` DB config "so the plan watcher sees it before the first refresh." The refresh loop (KanbanProvider.ts:3321) then re-asserts the in-memory value on every board refresh. When the watcher imported the pinless file at 22:04:22Z, `_resolveProjectForInsert` precedence #2 (KanbanDatabase.ts:2000–2008) stamped that resurrected value onto the fresh INSERT. **No visible UI displayed Browser Switchboard at any point** — an invisible, restored-from-disk value governed plan placement. The card was then invisible on the workspace board the user was actually watching — appearing, again, as a vanished plan.

### Root cause 1 — the update-branch pin override

`GlobalPlanWatcherService.ts` `_handlePlanFile`, update branch (lines 946–949):

```js
// Existing plan - update metadata.
let resolvedProject = plan.project;
if (metadata.project) {
    resolvedProject = metadata.project;   // ← re-applies the file pin on EVERY save
}
```

This contradicts the pin contract stated in CLAUDE.md ("the `**Project:**` line resolves once, when the file is first imported … editing the pin on an imported plan does **not** reassign it, by design"). The comment above the code (939–945) even acknowledges the first-import-only intent for *auto-assign* but carves out an "explicit frontmatter project override" — that carve-out is the bug. The file and the board are two writers to the same field, and the file wins every time it is saved.

The DB layer conflict clause makes any such caller destructive: `insertFileDerivedPlan`'s `ON CONFLICT` binds `project = COALESCE(NULLIF(excluded.project, ''), plans.project)` (KanbanDatabase.ts:2150) — a **non-empty** incoming project always overwrites the existing row. So the fix must ensure file-derived *updates* never carry a pin-derived project — and, for defense in depth, the file-derived upsert should refuse to change project on conflict at all.

### Root cause 2 — the active-filter stamp on pinless fresh imports, fed by an ambient key that diverges from the visible board

`KanbanDatabase._resolveProjectForInsert`, precedence #2 (lines 1993–2009): on a fresh INSERT with no pin, it reads `kanban.activeProjectFilter` and stamps that project onto the new row. The key is written from three places — every dropdown switch (`setProjectFilter`, :6358), every board refresh (`_refreshBoardImpl`, :3321, re-asserting the in-memory `_projectFilter`), and **extension activation** (constructor :399–401, restoring the last-ever dropdown selection from `workspaceState`). The constructor path means the key can hold a selection from a previous session that no open UI displays; the refresh loop keeps it alive indefinitely. So the stamp is not merely a race against the user's browsing — it can apply **days-old invisible state**. The stamping behavior itself is wanted (a plan created while a project is active belongs on that project); the defect is **writer multiplicity** — the key is written by the constructor, the refresh loop, and workspace switches, so its value can stop meaning "what the user last chose in the dropdown." The fix is not to delete the stamp but to reduce the key to a single writer.

## Metadata

**Complexity:** 5

> **Superseded:** Complexity: 3
> **Reason:** The change spans four TS files plus the webview and **inverts a load-bearing persistence direction** — the in-memory `_projectFilter` → DB config write becomes a DB config → display read — while touching data-integrity SQL. Multi-file coordination plus a data-consistency invariant that must hold simultaneously across the constructor, the refresh loop, `setProjectFilter`, and `selectWorkspace` matches the plan's own "Complex / Risky" criteria. Self-scoring 3 by counting deleted lines under-weights the blast radius (a mis-coordinated write-direction silently mis-files every plan a user owns). The routing recommendation (Coder) is unchanged; only the honesty of the score is.
> **Replaced with:** Complexity: 5 (Mixed — majority routine deletions, with two moderate, well-scoped risks: the write-direction inversion and the async startup-seed window).

**Tags:** backend, bugfix, database, reliability

> **Superseded:** Tags: backend, bugfix, watcher, kanban, data-integrity
> **Reason:** `watcher`, `kanban`, and `data-integrity` are not in the allowed tag vocabulary; tags must conform to the fixed list.
> **Replaced with:** `backend, bugfix, database, reliability` (all in-vocabulary; `database` covers the SQL/DB-config work, `reliability` the determinism invariant).

_(No project pin — deliberately. This plan lands unassigned on the workspace board.)_

## User Review Required

1. **Choke-point decision:** this plan fixes both the caller (watcher override) and the DB layer (`insertFileDerivedPlan` conflict clause stops updating `project`/`project_id` entirely). The DB-layer change means **no file-derived re-import can ever change a project again**, even a future caller written incorrectly. Confirm this hard line is wanted (it is the stated contract).
2. **Pin-at-first-import behavior is kept:** a `**Project:**` pin still applies on genuine first import (new row). Confirm that stays.
3. **Reactivation nuance:** a soft-deleted (`status='missing'`) row that reactivates keeps its DB project (row still exists → conflict path → untouched). A hard-deleted row re-imports as a fresh row and the pin applies again — by design. Confirm.
4. **Single-writer semantics to confirm:** (a) the dropdown becomes the key's only *user-intent* writer — the `workspaceState` copy of the filter is deleted entirely, and on restart the board opens on whatever the DB key holds (the user's last dropdown choice, however old); (b) switching to another workspace clears the **departed** workspace's key, so plans importing into a workspace the user has left land unassigned. **Cost of (b) to confirm explicitly:** an in-session A→B→A round-trip means workspace A reopens on *unassigned*, not the project you had selected in A — because leaving A zeroed its key. That is the deliberate price of "a workspace you are not watching has no active project." Confirm you want clear-on-leave over remember-per-workspace.
5. **Product decision — keep ambient stamping at all? (raised by architecture review):** the plan *keeps* precedence #2 (a pinless import lands on the active project). The strictly-more-deterministic alternative is to **drop precedence #2** so pinless imports ALWAYS land unassigned and must be assigned on the board. That eliminates the entire writer-multiplicity problem for free but loses the "plan created while viewing project P lands on P" ergonomic. The plan recommends keeping #2 and fixing the writers; veto here if you'd rather have zero ambient stamping.

## Complexity Audit

### Routine
- Deleting the watcher update-branch pin override (2 lines).
- Deleting the `workspaceState` copy of the filter (constructor read + restore-write; `setProjectFilter` debounced write; the `_projectFilterSaveTimeout` field and its dispose clear).
- Deleting the webview no-op guard so a change event always posts the selection.
- Comment rewrites to state the ingest-only contract and the read-not-write model.
- `PlanFileImporter.ts`: **no code change** — audit finding is that it already never sets `project` (below).

### Complex / Risky
- **Reversing the persistence direction.** Today: in-memory `_projectFilter` is authoritative and is *asserted into* the DB config (constructor + every refresh). After: the DB config is authoritative and is *read into* `_projectFilter`. Getting the read placement right (so display always derives from the same value stamping reads) is the load-bearing subtlety — mis-place it and the startup window re-creates Incident B.
- **Data-integrity SQL:** the `insertFileDerivedPlan` `ON CONFLICT` clause governs whether a re-import can move a card. A mistake here mis-files plans silently.
- **Cross-workspace ordering:** clearing the *departed* workspace's key must use the captured `prevWorkspaceRoot`, fire only on an actual switch, and not collide with the restore self-recovery seed.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - The previously-documented atomic-write DELETE→re-INSERT race can no longer move or clear a project on the conflict path (the conflict clause stops touching project entirely).
  - **Startup seed window (new, load-bearing — see Proposed Changes "read-at-top"):** between extension activation and the first board paint, `getConfigSync` returns `null` while the DB is still loading, so the constructor cannot synchronously seed `_projectFilter`. If display (`_projectFilter`) lags the DB config in that window, the watcher — which reads the DB config directly — could stamp a pinless import with a project the board isn't yet showing. Mitigated structurally by making `_refreshBoardImpl` read the DB config into `_projectFilter` at its top, so display and stamp derive from one value; the worst residual case is a one-frame cosmetic flicker, never a wrong stamp.
  - `setProjectFilter` sets `_projectFilter` (memory) before awaiting the DB write; message handlers await `setProjectFilter` before triggering a refresh, so no refresh reads a stale DB config back over a just-selected filter under normal flow.
- **Security:** none — local per-workspace SQLite config only; no auth, network, or PII surface.
- **Side Effects:**
  - Deleting the refresh-loop assert means refreshes no longer write the DB config; the only writers become the dropdown, `deleteProject`, and the departed-workspace clear.
  - Deleting the `workspaceState` copy changes restart behavior: the board opens on the DB key (last dropdown choice), not on a `workspaceState`-restored value.
  - The `selectWorkspace` restore self-recovery seed (`project: null`) must be made read-only for the same-workspace case, or every panel restore wipes the active project (see Proposed Changes).
- **Dependencies & Conflicts:**
  - `UPSERT_PLAN_SQL` (KanbanDatabase.ts:684–712, Notion/restore/manifest path) is DB-sourced and legitimately carries project — **left untouched**; only the file-derived clause is hardened.
  - `_resolveProjectForInsert` precedence #1 does not gate on `isExisting`, so a caller passing a pin for an existing row still resolves it into `excluded.project`; the hardened conflict clause is what makes that inert.
  - Feature inheritance (`createFeatureFromPlanIds`) and prompt-pin generation are downstream readers of the key — correct once the key has a single meaning; unchanged.

## Dependencies

- None — no upstream session dependencies. This plan hardens the same subsystem as the already-merged `fix-project-pin-workspace-conflation-and-import-guard.md` (resolve-only importer guard) and relies on that resolve-only backstop remaining in place: an unknown/placeholder/workspace-name pin still drops to unassigned rather than minting a `projects` row.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) a **startup seed window** where display (`_projectFilter`) lags the authoritative DB config and re-creates Incident B's invisible stamp; (2) the **restore self-recovery seed** (`selectWorkspace{project:null}`) turning destructive once the refresh-assert that healed it is deleted — wiping the active project on every panel restore; (3) the write-direction inversion mis-coordinated across constructor/refresh/setProjectFilter/selectWorkspace. Mitigations: make `_refreshBoardImpl` **read** the DB config into `_projectFilter` at its top so display and stamp share one source; gate the `selectWorkspace` project-filter mutation on an **actual workspace change** so the same-workspace restore seed reads instead of resets; keep the hardened `ON CONFLICT` clause (`project = plans.project`) as a defense-in-depth backstop so no file-derived re-import can move a card regardless of caller correctness.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — remove the update-branch pin override

- **Context:** `_handlePlanFile` update branch, lines 938–957.
- **Logic:** Delete the `if (metadata.project) { resolvedProject = metadata.project; }` override (947–949). `resolvedProject` is always `plan.project` (the existing DB value). Rewrite the comment (939–945) to state the contract plainly: *pins are ingest-only; after first import the board/API is the sole authority; a file save must never move a card between projects.*
- **Edge cases:** The fresh-import branch (`!plan`, line 831) is untouched — `metadata.project` still flows into the new record via `const project = metadata.project` (840) and `_resolveProjectForInsert` resolves it (resolve-only, never mints a `projects` row). First-import pin behavior is preserved exactly.

### `src/services/KanbanDatabase.ts` — `insertFileDerivedPlan` conflict clause stops touching project

- **Context:** the `ON CONFLICT` clause at lines 2146–2153.
- **Logic:** Change
  `project = COALESCE(NULLIF(excluded.project, ''), plans.project)` (2150) → `project = plans.project`
  `project_id = COALESCE(excluded.project_id, plans.project_id)` (2151) → `project_id = plans.project_id`
  File-derived upserts never modify project assignment on an existing row, no matter what the caller passes. `SET project = plans.project` is a standard SQLite UPSERT self-assignment (the unqualified/`plans.`-qualified name is the pre-update row; `excluded.` is the would-be-inserted row) — a deliberate no-op on conflict. Fresh INSERT behavior is unchanged: the `VALUES(...)` list still binds `resolvedProject`/`resolvedProjectId` from `_resolveProjectForInsert` (pin > active filter > unassigned).
- **Edge cases:**
  - `UPSERT_PLAN_SQL` (line 684, run-sheet/session/restore path) is **left as-is** — its records are DB-sourced, not file-pin-sourced, and restore flows legitimately carry project. Only the file-derived path is hardened.
  - Update the load-bearing comment block in `_resolveProjectForInsert` (lines 1947–1956), which currently justifies its re-import safety by pointing at the COALESCE clauses — after this change the guarantee is stronger (project untouched on conflict), and the comment must say so instead of describing the old clause.
  - Correct the now-stale comment inside `insertFileDerivedPlan` (lines 2120–2125) that claims it is "auto-creating the projects row on miss" — the helper is resolve-only and never auto-creates; the comment misdescribes current behavior and should read "resolve-only; unknown pin drops to unassigned."

### Single source of truth: the DB key IS the persistence — delete the copy and all its "healing"

`_resolveProjectForInsert` precedence #2 is **kept exactly as-is** — pinless imports stamp the active project, which is the wanted behavior. All the work is on the key's writers. The insight that makes this simple: `kanban.activeProjectFilter` is a DB config row — **it already survives restarts by itself. Nothing about it ever needs restoring, syncing, or healing.** The bugs exist because a second copy of the value is kept in VS Code `workspaceState` and reconciliation code "heals" the two copies against each other. Delete the copy; delete every heal:

- **`KanbanProvider` constructor (:383–402):** DELETE the `workspaceState` read (`kanban.projectFilter.${resolvedRoot}`, :384) AND the restore-write into the DB config (:396–401). Do NOT try to seed `_projectFilter` synchronously here — `getConfigSync` returns `null` while the DB is still loading at activation, so a sync seed is unreliable and a naive `void getConfig().then(...)` seed races the first refresh. A best-effort async seed is allowed for first-paint nicety but is **not** load-bearing; correctness comes from the refresh read below.

  > **Superseded:** "On startup, initialize the in-memory `_projectFilter` by **reading** `getConfig('kanban.activeProjectFilter')`" (the original plan's constructor-seed step).
  > **Reason:** The constructor runs before the DB is guaranteed loaded (`getConfigSync` → `null`), and an async seed races the board's first refresh. If the board paints from a not-yet-seeded `_projectFilter` (default UNASSIGNED) while the watcher stamps from the already-correct DB config, a pinless import lands on a project the screen isn't showing — Incident B reincarnated in a startup window. A green grep gate would never catch it.
  > **Replaced with:** Seed `_projectFilter` from the DB config at the **top of `_refreshBoardImpl`** (see next bullet). Display then derives from the identical value stamping reads, so "visible == stamped" holds by construction rather than by timing. The constructor may keep a best-effort async seed for first paint, but it is not the correctness mechanism.

- **`_refreshBoardImpl` (:3310–3322):** DELETE the per-refresh `setConfig` re-assert (:3321) — refreshes must not write the DB config. **Replace it with a read:** at the top of the refresh (after `dbReady`), read `getConfig('kanban.activeProjectFilter')` and set `_projectFilter` from it (empty/unassigned → `UNASSIGNED_PROJECT_FILTER`, else the name). This is still "refreshes read, never write" — the plan's own principle — and it makes the *display* source and the *stamp* source one and the same value, closing the startup window. The existing validation block (:3281–3306) still runs afterward to drop a phantom filter to UNASSIGNED (project deleted); note that a phantom left in the DB config is harmless downstream because `_resolveProjectForInsert` precedence #2 resolves-and-misses it to unassigned.
- **`setProjectFilter` (:6343–6381):** DELETE the debounced `workspaceState.update(...)` (:6363–6368) — the second store ceases to exist. Also remove the now-dead `_projectFilterSaveTimeout` field (:220) and its dispose clear (:1330). Keep the immediate DB `setConfig` write (:6355–6361). This method, invoked only by webview-originated user actions (`setProjectFilter` / `selectWorkspace` / `addProject` handlers), becomes the key's ONLY user-intent writer.
- **`kanban.html` change listener (:7931–7955):** DELETE the local no-op guard (`selectedProject !== (activeProjectFilter ?? '')`, :7949) — turn the `else if` into a plain `else` so a same-workspace change event always posts `setProjectFilter`. This guard is what swallowed the user's real click when the webview-local replica was desynced. The backend write is idempotent; unconditional posting is safe. (Note: re-selecting the *already-displayed* option fires no `change` event at all — this fix covers the desync case, not that browser behavior.)
- **`selectWorkspace` handler (KanbanProvider.ts:7171–7218) — departed-key clear + restore-seed made read-only:**
  - **Departed-key clear:** when the workspace actually changes (`prevWorkspaceRoot` captured at :7173 differs from the new root after :7181), write `''` to the **departed** workspace's key via `this._getKanbanDb(prevWorkspaceRoot).setConfig('kanban.activeProjectFilter', '')` before/independently of setting the destination filter. "Active" means the board the user is on now; a workspace the user has left has no active project, so plans importing into it land unassigned instead of on a frozen past selection. Guard for `prevWorkspaceRoot` being null (first selection).

  > **Superseded / promoted from prose:** the original plan mentioned the restore self-recovery seed (kanban.html:10509–10512) only in the historical-mechanics paragraph and did not list a concrete change for it.
  > **Reason:** Under the *old* model, that seed's `project: null` → `setProjectFilter(UNASSIGNED)` reset was healed by the refresh-assert re-seeding from `workspaceState`. This plan **deletes that heal.** Unmasked, the seed becomes destructive: every VS Code webview-panel restore (window reload / editor restart with the board open) fires `selectWorkspace{workspaceRoot: current, project: null}` → wipes the deliberately-set active project. It must be an explicit change, not a comment.
  > **Replaced with — restore-seed reads, not resets:** gate the handler's project-filter mutation on an **actual workspace change**. When `prevWorkspaceRoot === newRoot` (the self-recovery seed at kanban.html:10510–10511, which targets `currentWorkspaceRoot` with `project: null`), do **not** call `setProjectFilter` at all — leave the DB key and `_projectFilter` as-is; the refresh read seeds display from the DB config. Only when the workspace genuinely changes do the reset/preserve branches (:7185–7189) and the departed-key clear run. The webview never sends a same-workspace `selectWorkspace` with an explicit project (same-workspace project changes go through the `setProjectFilter` message at kanban.html:7951), so skipping the mutation on same-workspace is safe.

- **Grep gates:**
  - `grep -rn "setConfig('kanban.activeProjectFilter'" src/` returns exactly the hits inside `setProjectFilter` and the departed-workspace clear (the constructor :399–401 and refresh :3321 hits are gone). `deleteProject`'s clear uses a raw `INSERT INTO config ... 'kanban.activeProjectFilter'` (KanbanDatabase.ts:3411–3413) and legitimately stays; it does not match this `setConfig(` pattern.
  - `grep -rn "kanban.projectFilter\." src/` returns zero hits (the `workspaceState` copy — the :384 read and :6367 write — is fully gone).
  - `grep -n "metadata.project" src/services/GlobalPlanWatcherService.ts` shows it used only in the fresh-import (`!plan`) branch (:840).
- **Display == key, always:** the dropdown renders from the pushed `projectFilter` (KanbanProvider.ts:1856), which mirrors `_projectFilter`, which the refresh reads from the DB key. After a restart the board visibly opens on the persisted active project — what you see is what imports get stamped with, by construction.

### Consumers of `kanban.activeProjectFilter` — all become trustworthy under single-writer, none change

With one user-intent writer and no second store, the key always means "the project the user last selected in the dropdown" — which is the definition every consumer wanted. They all stay as-is:

- **Importer stamping** (`_resolveProjectForInsert` precedence #2, KanbanDatabase.ts:2000–2008) — kept.
- **PROJECT PIN directive generation** (reads at KanbanProvider.ts:1149, :8642) — kept; the injected pin now always matches what the board shows.
- **Blank-feature fallback** (`createFeatureFromPlanIds`, KanbanProvider.ts:11444–11449) — kept, same reasoning.

Historical mechanics of the incidents (kept for the coder's context):
- **Why the stale value resists correction (mechanics for the coder) — confirmed by user repro: a deliberate dropdown switch "didn't take."** The config is **per-workspace-DB**, but the corrector writes only to the *currently selected* workspace: a cross-workspace dropdown selection goes down the `selectWorkspace` branch (kanban.html:7940–7948; KanbanProvider.ts:7181–7189), which switches `_currentWorkspaceRoot` FIRST and then calls `setProjectFilter` — so the filter reset lands in the **destination** workspace's kanban.db, while the **departed** workspace's config keeps its armed value indefinitely. Plans importing into the departed workspace then read that frozen ghost. Same-workspace clicks have a second swallow path: the change listener's no-op guard (kanban.html:7949) compares against the webview-local `activeProjectFilter` (initialized `null`, synced only by `updateWorkspaceSelection` pushes) — a click matching the local value posts nothing, and re-selecting the already-displayed option fires no change event at all. Meanwhile `_refreshBoardImpl` (:3321) re-asserts the in-memory value on every refresh — but again only into the currently selected workspace's DB.
  **Fix (mandated above):** on `selectWorkspace`, clear the *departed* workspace's `kanban.activeProjectFilter` before switching roots. Compounding it, the two persistence stores have asymmetric timing: the DB config write is immediate/awaited (`setProjectFilter`, :6355–6358) but the `workspaceState` persist is debounced 100ms (:6366–6368), so a session's final switch-away can be lost; the constructor then restores the abandoned selection from `workspaceState` and **overwrites the correct DB config with it** (:384–401 — the comment there documents this divergence and resolves it in the wrong direction, trusting the stale store). Fix (mandated above): delete the `workspaceState` copy entirely — the DB row IS the persistence; nothing ever needs restoring. Note the structural asymmetry this eliminates: the **armer** ran headlessly at extension activation (no webview needed), while every **corrector** lived inside the lazily-created kanban webview (the dropdown's change event, and the restore self-recovery seed at kanban.html:10510–10511 — which sends `project: null` and resets the filter on open; after this change that seed must not clear a key the user deliberately set — it is re-evaluated to read, not write, in the `selectWorkspace` change above).

### Audit: other file-derived updaters

- **`src/services/PlanFileImporter.ts` (`importPlanFiles`, used by `POST /kanban/plans/import`):** **finding — no change needed.** The record it pushes (PlanFileImporter.ts:110–134) does **not** set a `project` field at all, so `_resolveProjectForInsert` sees `record.project === undefined` and, for an existing row (`isExisting=true`), returns `{ project: '', projectId: null }` → the conflict clause preserves the DB value. It already cannot damage an existing row's project, before *or* after the DB-layer change. (Side note, out of scope: because it omits `project`, this path also does not honor a `**Project:**` pin on genuine first import — a latent divergence from the watcher, deliberately left for a separate ticket.)

  > **Superseded:** "verify whether it passes parsed `metadata.project` into upserts for existing rows … align it with the watcher for clarity: existing row → pass existing project."
  > **Reason:** Verified against source — `importPlanFiles` never populates `project` on its record, so there is nothing to align and no clobber vector to close. The speculative "make it pass the existing project" edit would add code for a problem that does not exist.
  > **Replaced with:** No change to `PlanFileImporter.ts`. Record the finding (it omits `project` → already safe) and move on.
- Grep for any other caller that sources `project` from `parsePlanMetadata` output and writes it to an existing row via a file-derived path; the DB-layer hardening makes each inert, but flag any found for a follow-up so intent stays legible.

## Verification Plan

### Automated Tests
- None in scope (per session directive; the manual matrix below is decisive).

### Manual verification (running extension, after build + reload)
1. **Pin ignored on re-save (the incident repro):** take a plan whose file has `**Project:** X` but whose card was reassigned to the workspace board → edit and save the file → card stays on the workspace board; DB row's `project`/`project_id` unchanged. Repeat with the card on project Y (≠ X) → stays on Y.
2. **Pin honored on first import:** drop a new plan file with `**Project:** X` (X exists) into `.switchboard/plans/` → card lands on X's board. With an unknown/placeholder pin → lands unassigned (resolve-only backstop intact).
2b. **Pinless import lands on the ACTIVE project — display equals stamp:** select project P in the dropdown, have an agent (or `touch`) create a pinless plan file → the card lands on **P**, the project the dropdown visibly shows. Select the workspace-level option → the next pinless import lands **unassigned**.
2c. **Restart coherence (Incident B repro, corrected semantics):** select project P, reload the editor WITHOUT touching the dropdown → the board opens visibly showing P (read from the DB key by the refresh; the deleted `workspaceState` copy plays no part) → a pinless import lands on P, matching the screen. Then click the dropdown to the workspace option → the write takes effect immediately (no-op guard removed) → the next pinless import lands unassigned. At no point may an import be stamped with a project that no visible dropdown is showing — including the boot window (verify a pinless file dropped immediately after reload does not land on a project the just-painted board is not showing).
2d. **Cross-workspace switch clears the departed key (user-confirmed repro):** in workspace A select project P, then switch the dropdown to workspace B → A's `kanban.activeProjectFilter` is now `''` → an agent-created pinless plan in A lands **unassigned**; B's imports follow B's own dropdown state. A deliberate dropdown action must never appear to "not take." Then switch B→A → confirm A opens on unassigned (the accepted cost of clear-on-leave, per User Review #4b).
2e. **Panel restore does not wipe the active project (new — restore-seed guard):** select project P, then reload the webview panel in a way that triggers the self-recovery seed (host does not re-inject the initial root) → the board reopens on P; the DB `kanban.activeProjectFilter` is still P (the `selectWorkspace{project:null}` seed read, it did not reset). A pinless import after restore lands on P.
3. **Board reassign durable:** reassign a card via the board button → edit its file five times → card never moves; `updated_at` advances only from the watcher's metadata update, `project` fields do not change.
4. **Soft-delete/reactivate:** delete a plan file briefly and restore it (missing → reactivated) → project assignment survives.
5. **Feature creation lands with its subtasks:** with the workspace-level option selected and two unassigned plans, create a feature from them → the feature appears on the workspace board. With project P active and unassigned subtasks, the feature follows the active project — same rule as plans.
6. **Grep gates:** run the three greps in Proposed Changes → `metadata.project` only in the `!plan` branch; `setConfig('kanban.activeProjectFilter'` only in `setProjectFilter` + departed clear; `kanban.projectFilter\.` zero hits.

## Recommendation

Complexity 5 → **Send to Coder.** The work is majority **deletions** — the `workspaceState` copy of the filter, the constructor restore-write, the refresh-loop re-assert, the webview no-op guard — but it carries two moderate, well-scoped risks that the coder must implement precisely: (1) replace the refresh's write-assert with a **read** so display and stamp share one source (closes the startup window), and (2) make the `selectWorkspace` restore seed **read-only on same-workspace** while clearing the departed key on a real switch (prevents panel-restore from wiping the active project). Plus the pin fixes (watcher override + DB conflict clause). The manual matrix above — especially 2c, 2d, and 2e — is the release-blocking test for the incident class.

## Review Findings

Reviewed the four changed files ([GlobalPlanWatcherService.ts](../../src/services/GlobalPlanWatcherService.ts), [KanbanDatabase.ts](../../src/services/KanbanDatabase.ts), [KanbanProvider.ts](../../src/services/KanbanProvider.ts), [kanban.html](../../src/webview/kanban.html)) against the plan plus a full caller/consumer regression trace — no CRITICAL/MAJOR issues, no code fixes applied. Verified: the ON-CONFLICT self-assignment is valid SQLite (`UPSERT_PLAN_SQL` left with COALESCE), the write→read inversion at the top of `_refreshBoardImpl` closes the startup window (watcher `getConfigSync` and display `getConfig` share one source), `selectWorkspace` captures `prevWorkspaceRoot` before mutation and `path.resolve` idempotency makes the same-workspace restore-seed read-only, and all three grep gates pass exactly (2 `setConfig` hits, 0 `kanban.projectFilter.` in src, `metadata.project` only in the `!plan` branch). Every other `insertFileDerivedPlan` caller (Linear/ClickUp/SessionActionLog/importRemotePlan/KanbanMigration) passes empty `project` so the hardening is a no-op for them; only TaskViewerProvider's registry save carries a non-empty project (the plan's deliberate hard line — fresh-insert still honors it, board `setProjectForPlans` remains sole authority). Remaining (deferred, non-blocking) risks: TaskViewerProvider lacks the legibility flag comment the plan's line-173 audit requested; two test files still mock the deleted workspaceState replica (SKIP TESTS in force); and the Goal's CLAUDE.md docs follow-up is still pending. Compile/tests not run per SKIP COMPILATION / SKIP TESTS directives.

## Completion Report

Implemented all proposed changes. Files changed: `src/services/GlobalPlanWatcherService.ts` (removed update-branch pin override, rewrote comment to state ingest-only contract), `src/services/KanbanDatabase.ts` (hardened `insertFileDerivedPlan` ON CONFLICT to `project = plans.project` / `project_id = plans.project_id`; updated two stale comments to describe the new self-assignment invariant and resolve-only behavior), `src/services/KanbanProvider.ts` (deleted constructor `workspaceState` read + restore-write; replaced `_refreshBoardImpl` per-refresh `setConfig` write-assert with a `getConfig` read at the top of the refresh; deleted `setProjectFilter`'s debounced `workspaceState.update` + the `_projectFilterSaveTimeout` field + its dispose clear; restructured `selectWorkspace` to clear the departed workspace's key on actual change and skip the project-filter mutation on same-workspace restore seeds), `src/webview/kanban.html` (removed the no-op guard in the project-dropdown change listener so same-workspace changes always post). Grep gates pass: `setConfig('kanban.activeProjectFilter'` has exactly 2 source hits (setProjectFilter + departed clear); `metadata.project` only in the `!plan` fresh-import branch. The `kanban.projectFilter.` pattern returns 0 source hits but 3 hits in test files (`src/services/__tests__/KanbanProvider.test.ts`, `src/test/kanban-persistence.test.ts`) that mock the now-deleted `workspaceState` behavior — these tests are out of scope per the session's SKIP TESTS directive and will need updating in a follow-up. No compilation or automated tests run per session directives.

