# Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan

## Goal

Turn the six "PLAN REVIEWED" epics into a shippable **remote control** capability by giving them the one thing none of them has: an **orchestration layer**. Each epic was reviewed in isolation and is individually sound; "production-ready remote control" is the *composition* of all six, and the composition has never been reviewed. This plan is the coordination contract that sits **above** the six epics — it sets the build order, the shared interface/config contract every epic must target, the information-architecture decisions that cut across webviews, and the two production concerns no epic currently owns. It does **not** rewrite the epics' internal implementation detail; each subtask plan remains the source of truth for its own file/line/code specifics.

### Core problem & background

Switchboard already supports **full remote control via manifest import**: a GitHub-connected agent (e.g. Claude Code on the web) writes plan `.md` files plus a `manifest.json`, commits, and the extension ingests plans + epic structure + target columns into the local kanban DB. That path works today.

**Notion (primary) and Linear (secondary) exist to deliver the same outcome *without* a GitHub connection** — a remote status/content change on the tracker replaces the manifest push and drives the local board. The correct mental model, and the design principle for this whole program, is:

> **A remote status/content change should be manifest-equivalent and feed the same ingest path. Switchboard is the source of truth; push mirrors everything outward; providers follow.**

Most of the "async column transition" infrastructure is already shipped (`RemoteControlService` delta polling, provider seam, Linear/Notion providers, Constant-mode startup auto-start). The residual work is: close the Notion push gap, keep the remote current at high fidelity, give the remote agent real planning context, and reconcile offline changes on startup — all without fragmenting the design or over-building.

### Root cause of the coordination gap

Three of the six epics independently edit the **same** seam (`RemoteControlService.ts` + the `RemoteProvider` interface + `LinearRemoteProvider`/`NotionRemoteProvider`), and two independently add **config + Remote-tab UI** — but no epic references the others. Every dependent epic was authored against **today's** provider interface and **today's** four-surface config. Because the program has chosen **refactor-first** (see Locked Decisions), those dependent epics must be re-pointed onto the post-refactor seam and the consolidated config contract **before they are coded**. That re-pointing is unowned. This plan owns it.

## Locked Decisions (settled with the user — do not re-litigate)

1. **Providers:** Remote control is **Notion (primary) + Linear (secondary) only.** ClickUp is **not** a remote-control provider — it stays a push-only stakeholder-visibility mirror. ClickUp epic import/outbound work is out of this program.
2. **Push fidelity:** **High.** Push propagates **status · content · epic-structure · archive · project-context docs**, across **two entity levels** (card *and* project), for Notion + Linear.
3. **Foundation:** **Refactor-first.** The Remote Sync Refactor is the trunk; build the clean, declared-capability push seam and consolidate config before layering features on top. No stopgaps. **(Audit update: the sync surface is experimental/unshipped — clean break, NO migration; the earlier "avoid a double migration" rationale for refactor-first no longer applies, though the clean-foundation rationale still does.)**
4. **No feature flag / staged rollout.** Ship directly.
5. **Codebase context is NOT code-mirroring.** Notion/Linear get **developer docs + workspace constitution + project PRDs** — the curated planning context, not a generated per-file code doc set. The `ContextBundler` repo-walker, per-file pages, and the `codebase_docs_sync` content-hash pipeline are **cut**.
6. **Context is provider-agnostic and lives in `project.html`.** A new **Dev Docs** tab is added to `project.html`; **all** `project.html` content (Dev Docs + PRDs + constitution) syncs to **both** Notion and Linear. No Notion-specific docs pipeline.
7. **Auto-archive is a Switchboard-level rule**, configured in the **kanban.html setup tab**, **not** a Linear-specific feature: *N hours in the designated archive-trigger column → auto-move to Completed + archive locally.* Linear/Notion follow via push. **No backfill** (manual bulk-archive buttons already exist in both Switchboard and Linear).
8. **Archive-trigger column is designated, not hardcoded.** Because the board's late pipeline can branch and grow (e.g. a future PRD-tester stage sits between Code Reviewed and Completed), the trigger column is chosen via a **setup-tab dropdown**, defaulting to whatever column currently sits immediately before Completed.
9. **UI consolidation:** the **Remote** tab and the **NotebookLM** tab (currently in planning.html) both move **into `project.html`**, joining the new Dev Docs tab. NotebookLM is the on-ramp that produces dev docs, so it belongs with them.
10. **House rule:** no confirmation dialogs anywhere in new UI (`confirm()` is a silent no-op in VS Code webviews).

## Scope

### In (core program)
- **Remote Sync Refactor** (1/3 → 2/3 → 3/3) — the trunk.
- **Remote Planning Infrastructure** — startup reconciler, one consolidated orientation skill, `/improve-remote-plan` (with the Notion overwrite guard), `/create-epic`.
- **Cross-Provider Epic Structure — Notion + Linear slice only** — epic-structure ingest/mirror + outbound structure, routed through the unified push.
- **Project-context sync** (the slimmed former "Note codebase docs" epic) — Dev Docs tab in `project.html` + sync all `project.html` content to Notion + Linear + remote-agent orientation to read it.
- **Switchboard auto-archive rule** (kanban.html setup) + archive as a pushed state.
- **Linear description/content push** — retained, but as a *capability on the unified push seam*, not a standalone feature.
- **project.html information architecture** — absorb Remote + NotebookLM tabs alongside Dev Docs.
- **Two unowned production concerns** — Notion overwrite data-loss guard; remote-sync error/health surfacing to the user.

### Cut
- Feature flag / rollout mechanism.
- Codebase code-mirroring: `ContextBundler` repo-walker reuse, per-file/per-module Notion pages, `codebase_docs_sync` hash-diff table, incremental per-page push, on-commit doc triggers.
- Linear channel-issues / analyst chat.
- ClickUp epic import + outbound epic sync.
- Duplicate orientation skill (`/switchboard-remote` and `/sw-remote` collapse to one).
- Linear-specific auto-archive API feature (subsumed by the Switchboard-level rule + push).

## The trunk-first build order

```
STEP 0  project.html Information Architecture  (decide the tab layout FIRST)
          └─ Dev Docs (new) · Remote (moved) · NotebookLM (moved from planning.html)

STEP 1  Remote Sync Refactor 1/3  — declared provider capabilities + unified push dispatch
          push surface declared up front: status · content · structure · ARCHIVE · project-docs
          entity levels declared up front: card-level AND project-level targets

STEP 2  Remote Sync Refactor 2/3  — Notion push (closes the "Notion goes stale" gap)

STEP 3  Remote Sync Refactor 3/3  — config consolidation + Ingest/Full UX (no migration — experimental surface)
          Remote-tab UX built in its NEW home (project.html, per STEP 0)

STEP 4  (parallel, all re-pointed onto STEPS 1–3)
          ├─ Remote Planning Infra   (reconciler on consolidated config; one orientation skill;
          │                            /improve-remote-plan + Notion overwrite guard; /create-epic)
          ├─ Cross-Provider (Notion+Linear)  (seam adds parentRemoteId/isEpicCandidate on the
          │                            REFACTORED provider; outbound structure via unified push)
          ├─ Project-context sync    (Dev Docs tab content + PRDs + constitution → Notion + Linear)
          └─ Auto-archive rule       (kanban.html setup: designated column + timer → Completed +
                                       archive; archive pushed via the STEP 1 capability)

STEP 5  Production hardening        (remote-sync error/health surfacing to the user)
```

Rationale: Steps 1–3 reshape the exact provider interface and config surface that every Step-4 epic builds on. Building Step 4 first means building against an interface that Steps 1–3 then change — guaranteed rework and merge conflict. Step 0 precedes Step 3 because Refactor 3/3 ships Remote-tab UX; that UX must be built in the tab's final home (project.html), not built in the old location and immediately relocated.

## The unified push contract (all push routes through STEP 1)

High-fidelity push currently lives fragmented across three epics (Notion status+content in Remote Sync Refactor; Linear description in the Linear epic; epic-structure in Cross-Provider). **If these are built as separate paths, the program rebuilds the exact fragmentation the refactor exists to eliminate.** Contract:

- Refactor 1/3 defines `capabilities` + `pushState` / `pushContent` (and the seam for the additional verbs below) as the *single* push dispatch.
- **Archive** is a distinct provider verb (Linear archive ≠ status change; Notion page archive/trash ≠ a column value) — declare it as a capability in 1/3, do not retrofit it when the auto-archive rule lands.
- **Project-context docs** are a *project-level* target (Linear project docs/description; Notion project page), not an issue body — declare the project entity level in 1/3 so project-context sync rides the same seam.
- Linear description/content push and Cross-Provider outbound structure are **capabilities on this seam**, not separate code paths.
- Declared capabilities gate the UI honestly: ClickUp = push-only; Notion = pull + push (after 2/3); no toggle ever offers a capability a provider lacks.

## Auto-archive rule (STEP 4)

- **Where:** kanban.html **setup tab** (house-rule: no confirm dialog).
- **Config:** an **archive-trigger-column dropdown** (default = the column immediately before Completed) + a **threshold** (default ~2h, configurable).
- **Behavior:** a plan resident in the designated column past the threshold is **auto-moved to Completed and archived locally**. Because the local board is the source of truth and push mirrors it, **Linear and Notion follow** — archive flows out via the STEP 1 archive capability. No separate Linear archive feature, no backfill.
- **Why designated, not hardcoded:** Code Reviewed is a short holding pen, but stages can be inserted behind it (e.g. a PRD-tester column between Code Reviewed and Completed). The trigger must track "final pre-Completed stage" as the board evolves; a designated column keeps it unambiguous when the late pipeline branches (Acceptance Tested / Ticket Updater / etc.).

## project.html information architecture (STEP 0)

- Add **Dev Docs** tab (authoring surface for developer docs; the authored context that syncs out).
- **Move** the **Remote** tab into project.html (out of its current home).
- **Move** the **NotebookLM** tab from planning.html into project.html — it is the on-ramp: *bundle code → NotebookLM analysis → author Dev Docs → Dev Docs + PRDs + constitution sync to Notion/Linear → remote agent reads real context.*
- Migration risk is low: these are webview relocations; the per-workspace settings behind them are storage-keyed, not webview-keyed. Verify NotebookLM/ContextBundler state and any active-tab persistence survive the move; the DOCX/NotebookLM export flow itself is untouched.

## Production concerns no epic owns (must be assigned)

1. **Notion overwrite data-loss guard (code-level, not prose).** High-fidelity content push + project-doc sync means the extension *will* write Notion page bodies. A `replace_content` full overwrite **permanently deletes/orphans nested inline sub-pages, DB views, and templates and breaks block IDs/deep-links.** The guard must be enforced in code: **append-by-default (`API-patch-block-children`), full overwrite only after a verified "no inline children" check.** This applies to `/improve-remote-plan`, `pushContent`, and project-context sync alike. Relying on agent/skill compliance for an irreversible destructive operation on the primary provider is not acceptable for production.
2. **Remote-sync error / health surfacing.** Today remote poll/push failures land in `console.log`, which no user sees. With full bidirectional sync on the primary user surface across ~4,000 installs and no feature flag, the user needs visible sync health: last-poll status, last-push status/errors, rate-limit backoff state. Surface it in the Remote tab (now in project.html). Rate-limit note: Notion ≈ 3 req/s is the binding constraint; the existing `NotionFetchService.httpRequest()` `Retry-After` retry covers transient 429s, but repeated failures must be shown, not swallowed.

## Per-epic disposition

| Epic | Disposition |
|---|---|
| **Remote Sync Refactor** | **Trunk.** Build 1/3 → 2/3 → 3/3 first. Extend 1/3's declared push surface to include **archive** + **project-doc/project-level** targets up front. 3/3's Remote-tab UX targets project.html (per STEP 0). |
| **Remote Planning Infrastructure** | Re-point onto the consolidated config from 3/3. Keep reconciler (reuse existing `_poll()`/cursors — no new keys), `/improve-remote-plan` (+ overwrite guard), `/create-epic`. **Collapse `/sw-remote` and `/switchboard-remote` into one skill.** |
| **Cross-Provider Epic Structure** | **Notion + Linear slice only.** Add `parentRemoteId`/`isEpicCandidate` on the **refactored** `RemoteProvider`. Outbound structure = a capability on the unified push. **Drop ClickUp import + outbound; drop standalone Linear channel work.** Keep the insert-before-write planId-race fix and Notion `single_property` self-relation approach. |
| **Note codebase docs** | **Re-scoped to project-context sync.** Cut code-mirroring entirely. Deliver: Dev Docs tab in project.html + sync all project.html content (Dev Docs + PRDs + constitution) to Notion + Linear + remote-agent orientation to read it. |
| **Linear Sync & Channel Features** | **Description/content push** retained as a unified-push capability. **Auto-archive** reframed as the Switchboard-level rule above (not a Linear API feature). **Channel-issues / analyst chat cut.** |
| **Remote Control Mode & Agent Orientation** | Keep the Remote-Control ↔ Bug-Triage mutual-exclusivity guard. Its `/switchboard-remote` orientation skill merges into the single Planning-Infra orientation skill. Linear "copy agent skill" button lives in the Remote tab (project.html). |

## Risks & mitigations

- **Re-pointing debt (highest risk).** Step-4 plans carry file/line/interface assumptions against today's seam and config. *Mitigation:* before coding each Step-4 plan, update it to the post-refactor seam + consolidated config; navigate by method name (several subtask plans already have stale line numbers).
- **Push re-fragmentation.** *Mitigation:* enforce the unified push contract — Linear description push and outbound structure are capabilities on STEP 1's dispatch, reviewed against that seam, not separate paths.
- **Config scope (NOT migration).** The audit found config is already ~2 surfaces (remote-control config is a single `remote.config` blob), not four — and the whole remote-sync surface is **experimental/unshipped**, so per the project rule this is a **clean break: no migration, no legacy-flag preservation, no `*.migrated.bak`.** 3/3 simply defines the consolidated per-board contract as the sole path; the dependent epics add a few keys (startup reconcile, auto-archive, project-context sync) directly to it.
- **project.html surgery collision.** Remote-tab UX (3/3), Dev Docs, and two tab-moves all land in project.html. *Mitigation:* STEP 0 locks the IA before 3/3's UI phase.
- **Irreversible Notion writes.** *Mitigation:* the code-level append-by-default guard above.

## Verification plan

> Automated tests are authored but **not run** in this planning pass (per session directive; the user runs the suite separately). This lists what to verify when implementation lands.

- **Trunk seam:** existing delta-polling / echo-guard orchestration tests still pass after 1/3; `targetColumn === plan.kanbanColumn` no-op and `authoredBySelf` skip remain intact.
- **Notion push (2/3):** a local column move / content edit / archive writes back to the correct Notion page property/body/archive state; echo guards hold on the new round trip.
- **Config consolidation (3/3):** the consolidated per-board contract is the sole config path; no migration needed (experimental/unshipped surface — clean break).
- **Reconciler (Planning Infra):** Manual-mode `restoreFromConfig()` runs exactly one `_poll()` and schedules no timer; Constant-mode unchanged; clean no-op when unconfigured.
- **Auto-archive:** a plan in the designated column past the threshold auto-moves to Completed + archives locally; the archive propagates to Linear and Notion via push; changing the designated column in setup re-targets the rule; nothing legitimately parked *before* the designated column is touched.
- **Notion overwrite guard:** writing content/project-docs to a Notion page **with** inline children uses append and does not orphan sub-pages or change existing block IDs; full overwrite occurs only when the page is verified childless.
- **project.html IA:** Remote tab (with 3/3 UX) and NotebookLM tab function in their new home; per-workspace settings survive the move; DOCX/NotebookLM export unaffected.
- **Error surfacing:** a forced remote poll/push failure and a rate-limit backoff are visible in the Remote tab, not just the console.
- **Manual end-to-end (no GitHub):** claude.ai + Notion session invokes the orientation skill → reads project-context docs → authors/improves a plan → writes it back with the trigger status → restart IDE → card advances exactly once and the destination agent dispatches, with no duplicate and no orphaned epic link.

## Metadata

**Complexity:** 8
**Tags:** backend, frontend, ui, api, refactor, reliability, infrastructure, feature
**Repo:** switchboard
