# Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan

> **Rev 2 (2026-07-02).** Restructured after the board grouping pass. The program is now **seven epics** on the Remote sync board: the two formerly-unowned production concerns (Notion overwrite guard, sync health surfacing) are owned by **Auto-Archive & Production Hardening**; the Dev Docs tab / project.html IA and project-context sync live in **Project Context & Remote UI Hub**; and a new **Git-Native Remote Control Channel** epic owns the manifest-ingest + board-state-mirror path. Sequencing is stated at **epic granularity**: epics dispatch as whole units on the kanban board (an epic card bundles all its subtasks into one dispatch), so the build order below is an **epic dispatch order** — subtasks are never split out of their epic or interleaved across epics. Rev 1's plan-level STEP 0–5 ordering survives only as *internal* sequencing notes within each epic.

## Goal

Turn the seven "PLAN REVIEWED" epics into a shippable **remote control** capability by giving them the one thing none of them has: an **orchestration layer**. Each epic was reviewed in isolation and is individually sound; "production-ready remote control" is the *composition* of all seven, and the composition has never been reviewed. This plan is the coordination contract that sits **above** the epics — it sets the epic dispatch order, the shared interface/config contract every epic must target, the information-architecture decisions that cut across webviews, and the resolution of the two seams where epic boundaries and build dependencies cross. It does **not** rewrite the epics' internal implementation detail; each subtask plan remains the source of truth for its own file/line/code specifics.

### Core problem & background

Switchboard already supports **full remote control via manifest import**: a GitHub-connected agent (e.g. Claude Code on the web) writes plan `.md` files plus a `manifest.json`, commits, and the extension ingests plans + epic structure + target columns into the local kanban DB. That path works today.

**Notion (primary) and Linear (secondary) exist to deliver the same outcome *without* a GitHub connection** — a remote status/content change on the tracker replaces the manifest push and drives the local board. The correct mental model, and the design principle for this whole program, is:

> **A remote status/content change should be manifest-equivalent and feed the same ingest path. Switchboard is the source of truth; push mirrors everything outward; providers follow.**

Most of the "async column transition" infrastructure is already shipped (`RemoteControlService` delta polling, provider seam, Linear/Notion providers, Constant-mode startup auto-start). The residual work is: close the Notion push gap, keep the remote current at high fidelity, give the remote agent real planning context, and reconcile offline changes on startup — all without fragmenting the design or over-building.

### Root cause of the coordination gap

Three of the seven epics edit the **same** seam (`RemoteControlService.ts` + the `RemoteProvider` interface + `LinearRemoteProvider`/`NotionRemoteProvider`), and two add **config + Remote-tab UI** — but the epics were authored against **today's** provider interface and **today's** config surface. Because the program has chosen **refactor-first** (see Locked Decisions), every epic downstream of the Remote Sync Refactor must be re-pointed onto the post-refactor seam and consolidated config **at dispatch time, before it is coded**. The 2026-07-02 grouping pass fixed *ownership* (every plan now has an epic); what remained unowned was *order and the cross-epic contracts* — this plan owns those.

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

## Epic Dispatch Order

Dispatch each epic **whole**, in this order. Member plans are listed so this contract is self-contained; each epic's internal sequencing is the dispatched agent's job, guided by the member plans' own dependency sections.

### 1. Project Context & Remote UI Hub
*Members:* `project-html-dev-docs-tab-and-ia.md` · `project-context-sync-to-notion-and-linear.md` · `linear-remote-agent-skill-copy-button.md` · `phase2-remote-plan-from-notion-docs.md`

**Why first:** it owns the project.html information architecture (Dev Docs tab new; Remote + NotebookLM tabs moved in). That IA must be locked before any later epic builds UI into the panel — most critically before Refactor 3/3 ships the Remote-tab UX, which must be built in its **final** home, not built elsewhere and relocated. Internal note: the IA plan is the gating member; the outbound sync member targets the unified push contract that epic 2 formalizes (the contract is fully specified in epic 2's plans — build to it, do not invent a parallel pipeline).

### 2. Remote Sync Refactor *(the trunk)*
*Members:* `remote-sync-refactor-1-provider-capabilities-and-unified-push.md` · `remote-sync-refactor-2-notion-push-pipeline.md` · `remote-sync-refactor-3-config-consolidation-and-remote-tab-ux.md` · `linear-bidirectional-description-sync.md`

**Why second:** every remaining epic builds on its declared-capability push seam and consolidated config. Internal order is strict: **1/3 → 2/3 → 3/3**, with the Linear description sync implemented as a capability on the 1/3 seam, never a separate path. 1/3 declares the full push surface up front (status · content · structure · **archive** · project-docs) and both entity levels (card + project). 3/3's Remote-tab UX lands in project.html per epic 1's IA. Config is a clean break — experimental/unshipped surface, no migration.

### 3. Epic: Remote Planning Infrastructure
*Members:* `kanban-startup-reconciler.md` · `improve-remote-plan-skill.md` · `create-epic-skill.md` · `sw-remote-entry-skill.md` · `epic-grouping-awareness-in-chat-and-memo-skills.md`

**Why third:** the reconciler and skills must be re-pointed onto the consolidated config from 2's 3/3 (reuse existing `_poll()`/cursors — no new keys). The two orientation skills (`/sw-remote`, `/switchboard-remote`) collapse into **one**.

### 4. Remote Epic Structure (Notion + Linear)
*Members:* `notion-backup-epic-schema-and-remote-orientation.md` · `remote-control-epic-aware-mirroring.md`

**Why fourth:** epic-aware state mirroring adds `parentRemoteId`/`isEpicCandidate` on the **refactored** `RemoteProvider` — meaningless to build before epic 2 lands. Keep the insert-before-write planId-race fix and the Notion `single_property` self-relation approach.

### 5. Tracker-Structure Round-Trip (Tickets-Tab Import + Outbound Epic Sync)
*Members:* `epic-sync-outbound.md` · `clickup-import-epic-linking.md` · `linear-import-epic-linking.md`

**Why fifth:** outbound epic structure is a capability on epic 2's unified push, and structure ingest follows epic 4's mirroring model. **The ClickUp members are cut from this program** (Locked Decision 1) — they stay parked inside the epic as non-program work; the dispatched agent implements the Notion + Linear slice and leaves ClickUp import/outbound untouched.

### 6. Git-Native Remote Control Channel
*Members:* `fix-manifest-silent-failure.md` · `board-state-remote-mirror-channels.md`

**Why sixth:** the mirror-channels member depends on epic 3's startup reconciler for the offline catch-up story, and its `GitStateProvider` plugs into the post-refactor provider seam. The manifest-fix member has no dependencies at all — it hardens today's working ingest path and is the natural first piece the dispatched agent lands.

### 7. Auto-Archive & Production Hardening
*Members:* `linear-free-tier-auto-archive-on-completion.md` · `notion-overwrite-guard.md` · `remote-sync-health-surfacing.md` · `hide-triage-and-automation-setup-sections.md`

**Why last by design:** the auto-archive rule rides epic 2's declared archive capability; health surfacing exists to observe everything built above it (last poll/push status, rate-limit backoff, persistent-failure indicator in the Remote tab). The overwrite guard completes and hardens the guard contract that epic 2's Notion push was built against (see seam A below).

## Cross-epic seams (decided — not open questions)

- **A. Overwrite-guard contract (epic 2 ↔ epic 7).** Refactor 2/3 builds `pushContent` **to the guard's contract** — append-by-default (`API-patch-block-children`); full `replace_content` only after a verified no-inline-children check; fail safe to append/abort. Epic 7's guard member then completes, centralizes, and hardens that implementation as the single guarded write path for **all** Notion body writes (`pushContent`, `/improve-remote-plan` write-back, project-context sync). The contract lives in `notion-overwrite-guard.md`; epic 2's agent reads it before coding 2/3.
- **B. Release gate (epic 7).** If a release is cut before epic 7 is dispatched, pull the `hide-triage-and-automation-setup-sections` card forward and ship it standalone — it is the pre-release UI gate for the untested ClickUp/Linear automation surfaces and depends on nothing.
- **C. ClickUp scope (epic 5).** The ClickUp import/outbound members are out of program scope and are not implemented during epic 5's dispatch. No re-grouping needed; scope is enforced at dispatch time by this contract.

## The unified push contract (all push routes through epic 2's 1/3)

High-fidelity push currently lives fragmented across three epics (Notion status+content in Remote Sync Refactor; Linear description in the same epic post-grouping; epic-structure in Tracker-Structure Round-Trip). **If these are built as separate paths, the program rebuilds the exact fragmentation the refactor exists to eliminate.** Contract:

- Refactor 1/3 defines `capabilities` + `pushState` / `pushContent` (and the seam for the additional verbs below) as the *single* push dispatch.
- **Archive** is a distinct provider verb (Linear archive ≠ status change; Notion page archive/trash ≠ a column value) — declare it as a capability in 1/3, do not retrofit it when the auto-archive rule lands in epic 7.
- **Project-context docs** are a *project-level* target (Linear project docs/description; Notion project page), not an issue body — declare the project entity level in 1/3 so epic 1's project-context sync rides the same seam.
- Linear description/content push and outbound epic structure are **capabilities on this seam**, not separate code paths.
- Declared capabilities gate the UI honestly: ClickUp = push-only; Notion = pull + push (after 2/3); no toggle ever offers a capability a provider lacks.

## Auto-archive rule (epic 7)

- **Where:** kanban.html **setup tab** (house-rule: no confirm dialog).
- **Config:** an **archive-trigger-column dropdown** (default = the column immediately before Completed) + a **threshold** (default ~2h, configurable).
- **Behavior:** a plan resident in the designated column past the threshold is **auto-moved to Completed and archived locally**. Because the local board is the source of truth and push mirrors it, **Linear and Notion follow** — archive flows out via the 1/3 archive capability. No separate Linear archive feature, no backfill.
- **Why designated, not hardcoded:** Code Reviewed is a short holding pen, but stages can be inserted behind it (e.g. a PRD-tester column between Code Reviewed and Completed). The trigger must track "final pre-Completed stage" as the board evolves; a designated column keeps it unambiguous when the late pipeline branches (Acceptance Tested / Ticket Updater / etc.).

## project.html information architecture (epic 1)

- Add **Dev Docs** tab (authoring surface for developer docs; the authored context that syncs out).
- **Move** the **Remote** tab into project.html (out of its current home).
- **Move** the **NotebookLM** tab from planning.html into project.html — it is the on-ramp: *bundle code → NotebookLM analysis → author Dev Docs → Dev Docs + PRDs + constitution sync to Notion/Linear → remote agent reads real context.*
- Migration risk is low: these are webview relocations; the per-workspace settings behind them are storage-keyed, not webview-keyed. Verify NotebookLM/ContextBundler state and any active-tab persistence survive the move; the DOCX/NotebookLM export flow itself is untouched.

## Risks & mitigations

- **Re-pointing debt (highest risk).** Epics 3–7 carry file/line/interface assumptions against today's seam and config. *Mitigation:* at each epic's dispatch, the agent updates its member plans to the post-refactor seam + consolidated config before coding; navigate by method name (several subtask plans already have stale line numbers).
- **Push re-fragmentation.** *Mitigation:* enforce the unified push contract — Linear description push and outbound structure are capabilities on 1/3's dispatch, reviewed against that seam, not separate paths.
- **Config scope (NOT migration).** The audit found config is already ~2 surfaces (remote-control config is a single `remote.config` blob), not four — and the whole remote-sync surface is **experimental/unshipped**, so per the project rule this is a **clean break: no migration, no legacy-flag preservation, no `*.migrated.bak`.** 3/3 simply defines the consolidated per-board contract as the sole path; downstream epics add a few keys (startup reconcile, auto-archive, project-context sync) directly to it.
- **project.html surgery collision.** Remote-tab UX (epic 2's 3/3), Dev Docs, and two tab-moves all land in project.html. *Mitigation:* epic 1 locks the IA before epic 2 is dispatched.
- **Irreversible Notion writes.** *Mitigation:* seam A — 2/3 builds to the guard contract; epic 7 hardens it into the single guarded write path.

## Verification plan

> Automated tests are authored but **not run** in this planning pass (per session directive; the user runs the suite separately). This lists what to verify as each epic lands.

- **Epic 1 (IA):** Remote tab and NotebookLM tab function in their new project.html home; per-workspace settings survive the move; DOCX/NotebookLM export unaffected.
- **Epic 2 (trunk):** existing delta-polling / echo-guard orchestration tests still pass after 1/3; `targetColumn === plan.kanbanColumn` no-op and `authoredBySelf` skip remain intact. A local column move / content edit / archive writes back to the correct Notion page property/body/archive state (2/3); echo guards hold on the new round trip. The consolidated per-board contract is the sole config path (3/3).
- **Epic 3 (planning infra):** Manual-mode `restoreFromConfig()` runs exactly one `_poll()` and schedules no timer; Constant-mode unchanged; clean no-op when unconfigured. One orientation skill remains.
- **Epics 4–5 (structure):** parent-with-subtasks round-trips as epic + linked subtasks for Notion + Linear; outbound structure flows through the unified push; ClickUp members untouched.
- **Epic 6 (git channel):** a bare-filename manifest entry is accepted (or visibly rejected — never silently consumed); board-state mirror pushes only to the configured destination, defaulting `none`; mirror files remain Switchboard-exclusive to write.
- **Epic 7 (hardening):** a plan in the designated column past the threshold auto-moves to Completed + archives locally and the archive propagates via push; changing the designated column re-targets the rule; writing content/project-docs to a Notion page **with** inline children uses append and does not orphan sub-pages or change existing block IDs; full overwrite occurs only when the page is verified childless; a forced remote poll/push failure and a rate-limit backoff are visible in the Remote tab, not just the console.
- **Manual end-to-end (no GitHub):** claude.ai + Notion session invokes the orientation skill → reads project-context docs → authors/improves a plan → writes it back with the trigger status → restart IDE → card advances exactly once and the destination agent dispatches, with no duplicate and no orphaned epic link.

## Metadata

**Complexity:** 8
**Tags:** backend, frontend, ui, api, refactor, reliability, infrastructure, feature
**Repo:** switchboard
