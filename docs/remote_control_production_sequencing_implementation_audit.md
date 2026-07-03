# Remote Control Production Sequencing — Implementation Audit

**Date:** 2026-07-03
**Scope:** Verify whether `feature_plan_20260701_remote-control-production-sequencing.md` (the seven-epic coordination plan) has been fully implemented.
**Worktree audited:** `/Users/patrickvuleta/Documents/GitHub/worktrees/switchboard/remote-sync-2` (branch `remote-sync-2`)
**HEAD at audit:** `2ec90db` ("remote-sync health: surface poll/push status, backoff, persistent failures")
**Method:** Static code inspection — one verification pass per epic (reading each member plan, then locating and reading the actual implementation), followed by a dedicated shipping/distribution re-audit. One `tsc --noEmit` run. **No runtime end-to-end testing was performed** (see *Audit limitations*).

---

## How to read this audit (owner note, 2026-07-03)

**The coordination plan is a planning input, not a binding spec.** The branches evolved past it, and some deviations are deliberate owner decisions — those are **not defects**. This audit originally treated every deviation from the coordination plan as a gap/violation; that was an over-anchoring error. Findings therefore come in two kinds, and only the second kind is a "problem":

- **Deviations from the coordination plan** (e.g., ClickUp kept in Epic 5, outbound via a bespoke path, the `restoreFromConfig` vocabulary): may be intentional — flagged as "differs from plan, confirm intent," not as defects.
- **Plan-independent functional defects** (the 2 compile errors; skills advertised in `AGENTS.md` that never generate into user workspaces; the auto-archive dwell proxy; `boardStateExport:none` leaving mirror files tracked): real regardless of any plan.

Read the per-epic sections with that lens.

---

## ⚠️ Correction (2026-07-03): Epic 2 IS implemented — now merged into `remote-sync-2`

> **UPDATE (2026-07-03, later the same day): the trunk is no longer unmerged.** `remote-sync-refactor-implementation` was **merged into `remote-sync-2`** (merge commit `3a3dd7b`). The `RemoteProvider` interface was unioned (capabilities `{pull, push, projectContextPush, archive}`; verbs `pushState`/`pushContent` + `pushProjectContext`/`archiveCard`), the poll loop reconciled (description-pull + epic-mirror + health), and `ClickUpRemoteProvider`/`GitStateProvider` were brought onto the merged interface. `tsc` returned to the 6 pre-existing baseline errors (zero merge-introduced). The refactor's Remote-tab controls (Ingest/Full mode, push, comments, capability-gating) were then ported from `kanban.html` into `project.html`/`project.js` (commit `7d5e485`), since Epic 1 had moved that tab. **Sections below that describe Epic 2 as "unmerged" / "absent from remote-sync-2" now describe the pre-merge state and are retained as history.** Residual work still standing: the 2 pre-existing `tsc` errors (`epicIssueId`/`epicTaskId`), the unproven 3/3 config consolidation (`realTimeSyncEnabled` still present), and no runtime/UI exercise of the merged sync.

The original version of this audit concluded "Epic 2 (the trunk) largely not implemented as scoped." **That was wrong** and is corrected here. A second reviewer flagged it; the correction was then independently verified. (It was subsequently merged — see the UPDATE above.)

**The Epic 2 refactor was implemented — once — on branch `remote-sync-refactor-implementation`** (commits `6092e67` "Remote Sync Refactor 1/3 + Linear bidirectional description sync", `b0c6dc4` "2/3 — Notion Push Pipeline", `2d24100` "3/3 — Config Consolidation + Remote-Tab UX"). That branch is an ancestor of **neither `main` nor `remote-sync-2`** (`git merge-base --is-ancestor` returns false for both), so the work is real but **unmerged**.

Verified contents on `remote-sync-refactor-implementation`:
- `RemoteProvider.ts`: `RemoteProviderCapabilities { pull, push }` (`:45-49`), `readonly capabilities` (`:56`), `pushState(remoteId, column)` (`:101`), `pushContent(remoteId, markdown)` (`:108`), `RemoteStateDelta.description?` (`:27`).
- `ClickUpRemoteProvider.ts` exists (`capabilities.pull = false`, push-only); push routes through `provider.pushState` (`KanbanProvider.ts:2191`) / `provider.pushContent` (`ContinuousSyncService.ts:999`) with `capabilities.push` gating.
- Linear bidirectional description sync: `_pollDescriptions` (`RemoteControlService.ts:435`), description-sync cursors + `onDescriptionPulled` (`:83-88,498-499`), `_stripH1Header` promoted to `public` (`LinearSyncService.ts:505`).

**Why the original audit missed it:** the audit was scoped to the `remote-sync-2` worktree (as asked) and then compared only against `main`. It never enumerated all branches. On `remote-sync-2` the Epic 2 symbols genuinely are absent — that observation was accurate — but the leap to "not implemented anywhere" was not checked and was wrong.

**Corrected framing:** the program is **fragmented across branches**, which is a worse integration problem than a missing trunk:

| Branch | Epic 1 | Epic 2 (trunk) | Epics 3–7 | Notes |
|---|---|---|---|---|
| `main` | ❌ | ❌ | ❌ (own partial/parallel snapshots only) | Behind both feature branches |
| `remote-sync-refactor-implementation` | partial (branched at `c49e1ea`, mid-Epic-1) | ✅ **full** | ❌ | 4 ahead of base, 24 behind `main` |
| `remote-sync-2` | ✅ full | ✅ (merged in — `3a3dd7b`) | ✅ | The audited worktree — now carries Epics 1–7 **and** the trunk |

So Epics 3–7 (on `remote-sync-2`) were built on top of a branch that lacks Epic 2's unified seam — which is exactly why, *on this worktree*, Epic 5's outbound rides a bespoke path and Epic 7's guard has only two of its "three" write paths. Those downstream observations remain accurate **for `remote-sync-2`**; they are consequences of the branch fragmentation, not of the trunk never being built.

**Caveats on the correction:**
- **Config consolidation (3/3) looks partial:** `realTimeSyncEnabled` occurrence count is `main` 30 / `remote-sync-2` 34 / `remote-sync-refactor-implementation` 35 — the legacy flag was **not** removed even on the refactor branch, so 3/3's "clean-break" config consolidation is unproven (it did add the consolidated contract + Remote-tab UX in `kanban.html`). Differing branch bases make the raw count only a rough proxy; verify directly before signing off 3/3.
- **Merge will not be clean:** `remote-sync-refactor-implementation` predates `main`'s `GitStateProvider.ts` / Git-Native channel and the later Epic 3–7 work. Integrating it needs a rebase with conflicts concentrated in `src/services/remote/` and `RemoteControlService.ts` (both branches rewrite these).

The per-epic Epic 2 section below is retained but should be read as **"state on `remote-sync-2`"** — not as a global "never built" claim.

---

## Bottom line

**The plan is NOT fully implemented.**

- **3 epics fully implemented:** Epic 1 (Project Context & Remote UI Hub), Epic 3 (Remote Planning Infrastructure — *with a shipping caveat, see below*), Epic 4 (Remote Epic Structure).
- **1 epic largely NOT implemented as scoped:** Epic 2 (Remote Sync Refactor — *the trunk everything else was meant to build on*).
- **1 epic substantially implemented with 3 gaps:** Epic 7 (Auto-Archive & Production Hardening).
- **1 epic partially done:** Epic 6 (Git-Native Remote Control Channel — manifest fix ✅; board-state mirror has 2 gaps).
- **1 epic implemented, with an intentional scope decision:** Epic 5 (Tracker-Structure Round-Trip — Linear + ClickUp both done; ClickUp was deliberately kept on this branch, overriding the coordination plan's "cut ClickUp" decision — not a defect).

Two structural findings dominate:

1. **The trunk (Epic 2) is absent from this worktree — it lives on the unmerged branch `remote-sync-refactor-implementation`** (see Correction above). On `remote-sync-2`, only the two provider verbs downstream epics needed (`archive`, `projectContext`) exist; status/content push still run on the pre-refactor fragmented paths. So the Epic 3–7 work here was built against a unified seam it never received — which cascades into the divergences seen in Epics 5 and 7. The real issue is branch fragmentation, not a trunk that was never built.

2. **A distribution defect makes two of this plan's new skills unshippable** (plus three pre-existing skills of the same class). They exist only in the dev repo's generated `.claude/skills/` tree, are advertised in the shipped `AGENTS.md`, but are never generated onto a user's machine.

---

## Distribution mechanism (the lens for the shipping finding)

Understanding how skills reach users is prerequisite to the shipping finding:

- The VSIX bundles **`.agents/`** (`.vscodeignore:25-26` — "Keep .agents/ — workflow assets are shipped with the extension").
- On a user machine, `ControlPlaneMigrationService._bootstrapControlPlaneLayout` copies the bundled `.agents/` into the workspace (`ControlPlaneMigrationService.ts:701-705`), then calls `generateClaudeMirror(...)` (`extension.ts:3252`, `ControlPlaneMigrationService.ts:740`).
- `generateClaudeMirror` (`ClaudeCodeMirrorService.ts:266`) **generates** `.claude/skills/<name>/SKILL.md` from `.agents/` for each `MIRROR_MANIFEST` entry (`:41-105`, 29 entries) plus a dynamic scan for `.agents/skills/switchboard-*.md` (`:300-332`). It **never copies** the dev repo's own `.claude/` and **never prunes** (`:263` "never touches skills it did not generate").

**Consequence:** a skill ships to users **only** if it is in `MIRROR_MANIFEST` with an existing `.agents/` source, or is a `switchboard-*.md` scan hit. A file that exists only in `.claude/skills/` is **dev-repo-only** — it works for an agent operating on the Switchboard source repo, but is invisible to end users.

---

## Per-epic findings

### Epic 1 — Project Context & Remote UI Hub — ✅ FULLY IMPLEMENTED

Members: `project-html-dev-docs-tab-and-ia`, `project-context-sync-to-notion-and-linear`, `linear-remote-agent-skill-copy-button`, `phase2-remote-plan-from-notion-docs`.

| Deliverable | Status | Evidence |
|---|---|---|
| Dev Docs tab added to project.html (full authoring surface) | ✅ | `src/webview/project.html:1635`, `:1828-1858` |
| Dev Docs stored per-workspace at `.switchboard/devdocs/<slug>.md` | ✅ | `PlanningPanelProvider.ts:2424-2443`, `:8616-8644` |
| Path-traversal protection (`_resolveDevDocPath`) | ✅ | `PlanningPanelProvider.ts:8650-8658` |
| No confirm dialogs on delete | ✅ | `PlanningPanelProvider.ts:2445-2459` |
| Remote tab relocated into project.html | ✅ | `project.html:1639`, `:1905-2011` |
| NotebookLM tab relocated into project.html | ✅ | `project.html:1638`, `:1860-1903`; `project.js:3680-3760` |
| No orphaned refs left in planning.html/js | ✅ | `planning.html:480,3503`, `planning.js:1716,3989` are comments only |
| Per-workspace settings survive move (`notebook.root`, `remote.config`) | ✅ | `PlanningPanelProvider.ts:2281-2297`; storage-keyed not webview-keyed |
| Project-context bundle (Dev Docs + PRDs + constitution) | ✅ | `projectContextSync.ts:91-159` |
| Coarse sha256 change gate (timestamp excluded); state in DB `config` | ✅ | `projectContextSync.ts:130-132`, `:20,55-74` |
| Push via unified provider seam for **both** providers | ✅ | `RemoteProvider.ts:150` (`pushProjectContext`); called `KanbanProvider.ts:2087,2090` |
| Notion push obeys overwrite guard | ✅ | `NotionRemoteProvider.ts:222-244` → `notionOverwriteGuard.ts:96` |
| In-flight guard for context sync (review fix) | ✅ | `KanbanProvider.ts:153`, `:2041-2048,2116` |
| Linear "Copy Agent Skill" button, provider-gated | ✅ | `project.html:1967-1973`; `project.js:3596-3608`; `KanbanProvider.ts:1950-1991` |
| Phase-2 orientation content | ✅ (relocated) | `.agents/workflows/sw-remote.md:70-110` + `.claude` mirror |

**Awareness items (non-blocking):**
- Linear GraphQL document mutations (`documentCreate`/`documentUpdate`, `LinearRemoteProvider.ts:239-268`) are structurally correct but **not statically verifiable against Linear's live schema** — needs one end-to-end confirmation.
- Phase-2 skill was relocated by a later epic (`03fb102` → `6d40d30`); original `.agents/skills/switchboard_remote_notion.md` archived as `.migrated.bak`. Content is intact and live.

---

### Epic 2 — Remote Sync Refactor (the trunk) — ✅ IMPLEMENTED ON `remote-sync-refactor-implementation`; ❌ ABSENT FROM THIS WORKTREE

> **Read this table as "state on `remote-sync-2`," not "never built."** See the Correction at the top: all four member plans (1/3, 2/3, 3/3, Linear bidi) are implemented on the unmerged `remote-sync-refactor-implementation` branch. The table below documents what is present/absent on the audited worktree (`remote-sync-2`), which is what determines whether this worktree can ship the capability today. Every "❌ MISSING" row is present on the refactor branch.

Members: `remote-sync-refactor-1-provider-capabilities-and-unified-push`, `remote-sync-refactor-2-notion-push-pipeline`, `remote-sync-refactor-3-config-consolidation-and-remote-tab-ux`, `linear-bidirectional-description-sync`.

**On `remote-sync-2`,** the `RemoteProvider` seam has only `archive` + `projectContext` verbs (added here to serve Epics 7 and 1) and a git-native channel — the core unified-push trunk deliverables are absent from this branch (they live on the refactor branch).

| Deliverable (status = **on `remote-sync-2`**) | Status | Evidence |
|---|---|---|
| `capabilities` descriptor on `RemoteProvider` | 🔀 DIVERGED | `RemoteProvider.ts:38-43` — descriptor is `{ projectContextPush, archive }`, **not** the `{ pull, push }` specified |
| `pushState(remoteId, column)` — single status dispatch | ❌ MISSING | No `pushState` in `src/`. Status push still fragmented: `KanbanProvider.ts:2559,2589` call `linear/clickUp.debouncedSync` directly |
| `pushContent(remoteId, markdown)` — single content dispatch | ❌ MISSING | No `pushContent` method. Content push still fragmented: `ContinuousSyncService.ts:878-905` |
| `ClickUpRemoteProvider` behind the seam (push-only) | ❌ MISSING | `RemoteProviderKind = 'linear'\|'notion'\|'control-plane'\|'wiki'`; no `'clickup'` |
| Archive as a **distinct** capability/verb | ✅ | `RemoteProvider.ts:42,158`; `LinearRemoteProvider.ts:170-183` (`issueArchive`); `NotionRemoteProvider.ts:194-211` |
| Project-context as a **project-level** target | ✅ | `RemoteProvider.ts:39,150`; Linear `:193-268`; Notion `:222-285` |
| ONE unified push dispatch (no fragmentation) | ❌ MISSING | Two legacy paths remain; the refactor did not happen |
| Notion `pushState` (write Kanban Column select) | ❌ MISSING | No `pushState`; no `_queueNotionSync` |
| Notion `pushContent` (page body write-back) | ❌ MISSING | `NotionFetchService.updatePageContent` only called by `ResearchImportService` |
| Notion pushContent honors overwrite guard | ⚠️ PARTIAL | Guard is correct (`notionOverwriteGuard.ts:96-145`) but used by `pushProjectContext`, not a plan-body `pushContent` (which doesn't exist) |
| Consolidated single per-board config contract | ❌ MISSING | `RemoteControlService.ts:36-51` still `{ provider, boards, silentSync, pingFrequencySeconds }` — no `mode`/`push`/`comments` |
| Old scattered config removed (clean break) | ❌ MISSING | `realTimeSyncEnabled`/`completeSyncEnabled` still live across 6+ files |
| Ingest\|Full radio + push/comments toggles + capability-gated UI | ❌ MISSING | `project.html:1905-2011` has no mode radio / push toggle / comments toggle |
| Remote-tab relocated to project.html | ✅ | `project.html:1476,1905` (driven by Epic 1's IA) |
| `linear-bidirectional-description-sync` (`RemoteStateDelta.description/updatedAt`, `_pollDescriptions`, cursors, loop-guard hash) | ❌ MISSING | Interface never extended; entire pull-back path absent; `_stripH1Header` still `private` (`LinearSyncService.ts:504`) |

**Verdict (this worktree):** ~2 of ~16 trunk deliverables are present on `remote-sync-2`, and those two are the scope-update *additions* to plan 1/3, not its core. **The full trunk exists on `remote-sync-refactor-implementation` and needs to be merged/rebased into the line carrying Epics 3–7** — it is not new work to write, it is integration work. Verify 3/3's config consolidation directly during that merge (see Correction caveat — the legacy `realTimeSyncEnabled` flag was not removed on the refactor branch).

**What is solid and reusable on `remote-sync-2` regardless:** the `archive`/`archiveCard` verb, the project-context bundle + `pushProjectContext`, and `notionOverwriteGuard` (append-by-default, verified-childless replace, fail-safe abort) — the last is exactly the append-safe contract the refactor branch's Notion `pushContent` should ride once the branches are combined.

---

### Epic 3 — Remote Planning Infrastructure — ⚠️ FULLY CODED, BUT TWO SKILLS DON'T SHIP

Members: `kanban-startup-reconciler`, `improve-remote-plan-skill`, `create-epic-skill`, `sw-remote-entry-skill`, `epic-grouping-awareness-in-chat-and-memo-skills`.

| Deliverable | Status | Evidence |
|---|---|---|
| Startup reconciler runs exactly one `_poll()`, schedules no timer | ✅ | `RemoteControlService.ts:250-255` (`reconcileOnce()`) |
| Clean no-op when unconfigured | ✅ | `RemoteControlService.ts:252` (`boards.length === 0` guard) |
| Constant mode unchanged | ✅ | `RemoteControlService.ts:227-241` |
| Reuses existing cursors; **no new config keys** | ✅ | `RemoteControlService.ts:36-52,74-79` |
| Reconciler wired at startup | ✅ | `KanbanProvider.ts:1898-1905` → `TaskViewerProvider.ts:2645-2649` |
| `improve-remote-plan` skill (read→deepen→write→advance) | ✅ coded / ❌ **doesn't ship** | `.claude/skills/improve-remote-plan/SKILL.md` — see shipping finding |
| `create-epic` skill (direct epic-file write for remote) | ✅ coded / ❌ **remote skill doesn't ship** | `.claude/skills/create-epic/SKILL.md` — see shipping finding |
| Orientation skills collapsed to ONE | ✅ | Second skill archived `.migrated.bak`; only `sw-remote` remains |
| `sw-remote` skill functional and **shipping** | ✅ | `.agents/workflows/sw-remote.md` + manifest entry `ClaudeCodeMirrorService.ts:47` |
| Epic-grouping awareness in chat + memo (7 surfaces) | ✅ | chat SKILL `:77`, workflow `:76`; `agentPromptBuilder.ts:642`; memo SKILL `:54`, workflow `:53`; `TaskViewerProvider.ts:3004`; sw-remote `:204` |

**Note on acceptance-criteria vocabulary:** the coordination plan's verification text names `restoreFromConfig()`, "Manual/Constant mode", and "epic-2 consolidated config." None of those exist as symbols. The equivalent behavior ships under `reconcileOnce()` and the pre-existing `silentSync` boolean — the member plan explicitly rejected the fabricated `restoreFromConfig`/mode-enum vocabulary, and the code faithfully implements the member plan. Behavioral criteria (one poll, no timer, no-op unconfigured, no new keys) are all met.

**Corrected verdict:** the reconciler and `sw-remote` are done and ship; **two of the three skills do not reach users** (see shipping finding). Not "minor."

---

### Epic 4 — Remote Epic Structure (Notion + Linear) — ✅ FULLY IMPLEMENTED

Members: `notion-backup-epic-schema-and-remote-orientation`, `remote-control-epic-aware-mirroring`. Implementing commit: `6d40d30`.

| Deliverable | Status | Evidence |
|---|---|---|
| Notion DB `Is Epic` + `Epic` (self-relation) props created | ✅ | `NotionBackupService.ts:243-246`, `_ensureEpicProperties:435-452` |
| Epic props written (two-pass) via `epicIdToNotionPageId` | ✅ | `NotionBackupService.ts:538-567`, setup two-pass `:311-353` |
| `restoreFromNotion` applies epic structure | ✅ | `NotionBackupService.ts:116,145-148,176-186` |
| `RemoteStateDelta.parentRemoteId` + `isEpicCandidate` on **refactored** seam | ✅ | `remote/RemoteProvider.ts:19-30` (single interface, no old duplicate) |
| Linear provider populates parent/children | ✅ | `LinearRemoteProvider.ts:52-77` |
| Notion provider reads `Is Epic`/`Epic` with safe fallback | ✅ | `NotionRemoteProvider.ts:98-114` |
| `_mirrorEpicStructure` called before `_applyStateMirror`; idempotent echo guard | ✅ | `RemoteControlService.ts:425-426,474-508` |
| Insert-before-write planId-race fix intact | ✅ | `LinearSyncService.ts:2613-2716` (DB insert precedes `fs.writeFile`) |
| Parent-with-subtasks round-trips both providers | ✅ | Notion out+in+restore; Linear in |
| Orientation "Epics" section | ✅ (relocated) | `.claude/skills/sw-remote/SKILL.md:152-181` + `.agents/workflows/sw-remote.md` |

**Caveats (non-blocking):** restore cannot demote `is_epic=1`→0 (sticky upsert, `KanbanDatabase.ts:638,1630`) — documented, safe. **Adjacent (out of Epic 4 scope):** two real `tsc` errors in the outbound epic-push path (see Compile errors below).

---

### Epic 5 — Tracker-Structure Round-Trip — ✅ IMPLEMENTED (Linear + ClickUp)

> **Reframed 2026-07-03 (owner correction):** the coordination plan's Locked Decision 1 said to cut ClickUp, but **that decision was intentionally reversed — the ClickUp epic code is meant to be on this branch.** So this is not a "scope violation"; it is a deliberate scope decision that simply differs from the (non-binding) coordination plan. The rows below are reclassified accordingly. See the note at the top of this document: the coordination plan is a planning input, not a binding spec.

Members: `epic-sync-outbound`, `linear-import-epic-linking`, `clickup-import-epic-linking` (coordination plan marked CUT; **owner kept it in — intended on this branch**).

| Deliverable | Status | Evidence |
|---|---|---|
| Linear import: recursive 5-level hierarchy query | ✅ | `LinearSyncService.ts:2457-2511` |
| Linear import: two-pass (filter→write+insert→link), insert-before-write | ✅ | `LinearSyncService.ts:2553-2819` |
| Linear import: cycle-safe flatten walk | ✅ | `LinearSyncService.ts:2772-2819` |
| Linear outbound: `syncEpicWithSubtasks` | ✅ | `LinearSyncService.ts:2837-2893` |
| Linear outbound: `unlinkSubtasksFromEpic` | ✅ | `LinearSyncService.ts:2899-2928` |
| `_syncEpicOutbound` fan-out wired into create/assign/promote | ✅ | `KanbanProvider.ts:10056-10095`, `:9979`, `:10044`, `:8800` |
| **ClickUp import epic-linking** | ✅ IMPLEMENTED (intended) | `ClickUpSyncService.ts:2924,3042,3090-3123,3227` — complete two-pass import; kept on this branch by design |
| **ClickUp `syncEpicWithSubtasks`/`unlinkSubtasksFromEpic`** | ✅ IMPLEMENTED (intended) | `ClickUpSyncService.ts:3251-3327,3333+`; wired at `KanbanProvider.ts:10081-10083` |
| Outbound rides epic-2 **unified push seam** | 🔀 differs from coordination plan (likely intentional) | Built as bespoke `_syncEpicOutbound` fanning out to legacy services. Matches the `epic-sync-outbound.md` member plan; the unified seam isn't on this branch anyway (Epic 2 unmerged). Confirm whether re-pointing onto the seam post-merge is wanted. |

**Notes:** the ClickUp epic work (now committed on the branch — was ~328 lines of WIP at audit time in `ClickUpSyncService.ts`) is a **deliberate** addition, not a defect. **Genuine functional gap (plan-independent):** `deleteEpic` (`KanbanProvider.ts:~8875`) does not call `unlinkSubtasksFromEpic`, so external trackers retain the parent link to a deleted epic — worth fixing regardless of scope. **Compile error (plan-independent):** `ClickUpSyncService.ts:3326` TS18004 (see Compile errors) lives in this ClickUp path.

---

### Epic 6 — Git-Native Remote Control Channel — 🟡 MANIFEST FIX DONE; MIRROR HAS 2 GAPS

Members: `fix-manifest-silent-failure`, `board-state-remote-mirror-channels`. Commits `e1fd13a`, `1a3eb73`, `e48f1fe`.

**Plan A — manifest fix: ✅ FULLY IMPLEMENTED**

| Deliverable | Status | Evidence |
|---|---|---|
| Bare filename auto-resolved to `.switchboard/plans/<name>` | ✅ | `PlanManifestService.ts:202-208` |
| `'rejected'` return type; all 3 silent-skip paths return it | ✅ | `PlanManifestService.ts:192,195,223,232` |
| Surface rejection then consume once (no re-toast loop) | ✅ | `:167-173`; watcher toast `GlobalPlanWatcherService.ts:848-851` (gated on `rejected>0 && consumed`) |
| Epic-misroute warning tests ORIGINAL `entry.planFile` | ✅ | `PlanManifestService.ts:215` (the `e48f1fe` fix) |
| Doc examples use full plan paths | ✅ | improve-plan.md, switchboard-chat.md + mirrors |

The two review commits (`1a3eb73` re-toast, `e48f1fe` regex) are coherent, not conflicting.

**Plan B — board-state mirror: substantially done; 2 gaps**

| Deliverable | Status | Evidence |
|---|---|---|
| `boardStateExport` setting, default `none` | ✅ | `package.json:542-551` |
| `GitStateProvider implements RemoteProvider` (all 8 methods) | ✅ | `GitStateProvider.ts:24`; interface `RemoteProvider.ts:98-159` |
| GitStateProvider registered + dispatched + polled | ✅ | `KanbanProvider.ts:1626,1634,1663-1679`; `RemoteControlService.ts:285,293-294` |
| Per-plan `**Column:**` export signal | ✅ | emit `KanbanDatabase.ts:6134`; parse `GitStateProvider.ts:386-412` |
| Comment signal (`## Inbound Comment`) | ✅ | `GitStateProvider.ts:261-283,414-451` |
| Outbound push single-flight + fetch/reconcile before push | ✅ | `GitStateProvider.ts:298-382` |
| Push only to configured destination, default off | ✅ | `RemoteControlService.ts:283,299-304` |
| Inbound trust guard (author allowlist) | ✅ | `GitStateProvider.ts:108-128,193-214,472-495` |
| control-plane pull target added to PlanAutoFetch | ✅ | `PlanAutoFetchService.ts:373-389` |
| Startup-reconciler dependency (offline catch-up) wired | ✅ | `reconcileOnce` invoked `TaskViewerProvider.ts:2646` |
| **`none` = zero git footprint (mirror files NOT tracked)** | ⚠️ GAP | `WorkspaceExcludeService.ts:19-20` unconditionally un-ignores `kanban-board.md`/`kanban-state-*.md`, **not** gated on `boardStateExport`. On default `targetedGitignore` the mirror files stay git-tracked — the exact carve-out the plan set out to remove |
| **control-plane pull cadence ~60s (not shared 300s)** | ⚠️ GAP | `PlanAutoFetchService.ts:77-95` still uses the 300s default; the "faster cadence" comment (`:128-129`) has no backing override. Misses the plan's ~60-120s convergence target |
| `boardStateExport` enum includes notion/linear | 🔀 minor | `package.json:544-548` is `none\|control-plane\|wiki`; notion/linear ride `remote.config` instead |

---

### Epic 7 — Auto-Archive & Production Hardening — ✅ SUBSTANTIALLY IMPLEMENTED; 3 GAPS

Members: `linear-free-tier-auto-archive-on-completion`, `notion-overwrite-guard`, `remote-sync-health-surfacing`, `hide-triage-and-automation-setup-sections`. Commits `3fe0e84`, `3af85b8`, `2ec90db`, `8e05427`.

**Auto-archive rule:**

| Deliverable | Status | Evidence |
|---|---|---|
| `AutoArchiveService` real + scheduled (5-min sweep) | ✅ | `AutoArchiveService.ts:58,140`; started `extension.ts:850` via `KanbanProvider.ts:1782` |
| Trigger column = configurable dropdown | ✅ | `kanban.html:2690`; populated `KanbanProvider.ts:1755` |
| Default = column-before-Completed, **not hardcoded** | ✅ | `KanbanProvider._getDefaultTriggerColumn:1726` (`'CODE REVIEWED'` only an error fallback `:1734,1739`) |
| Threshold configurable, 2h default, clamp 0.25–720h | ✅ | `AutoArchiveService.ts:36,114`; `kanban.html:2694` |
| Move→Completed + archive locally + push archive | ✅ | `AutoArchiveService.ts:195,206,220`; gated on `capabilities.archive` `:185` |
| No backfill | ✅ | Sweep reads only `getPlansByColumn(trigger)` + dwell `:175,192` |
| No confirm dialog | ✅ | `kanban.html:2674-2701`, autosave `:9164` |
| Linear `issueArchive`/`issueUnarchive` (correct mutations) | ✅ | `LinearSyncService.ts:1681,1719` |
| **Dwell = true time-in-column** | 🔀 GAP | `_sweep` uses `plan.updatedAt` as the dwell proxy (`AutoArchiveService.ts:190-192`). Any edit resets the clock; a busy plan can dodge archiving indefinitely. No `columnEnteredAt` field exists (would need a schema migration). **The one real behavioral divergence.** |

**Notion overwrite guard:**

| Deliverable | Status | Evidence |
|---|---|---|
| Append-by-default + verified-childless check + fail-safe | ✅ | `notionOverwriteGuard.ts:96-145` |
| Single guarded path — project-context sync | ✅ | `NotionRemoteProvider.pushProjectContext:242` |
| Single guarded path — content push (`updatePageContent`) | ✅ | `NotionFetchService.updatePageContent:659` (dynamic import `:645`) |
| Called by all **three** named paths | 🔀 GAP (not a leak) | Only **two** Notion body-write sites exist and both route through the guard. `pushContent` and the `/improve-remote-plan` write-back named in the coordination text **do not exist in code** (guard docstring marks both "future" `:13`). No destructive Notion write bypasses the guard — the only ungated PATCH is inside `createPage` (`:735`, appends to a fresh childless page). |

**Health surfacing:**

| Deliverable | Status | Evidence |
|---|---|---|
| Last poll status surfaced in Remote tab | ✅ | `RemoteControlService.ts:307-318`, `getHealth:120`; rendered `project.js:3496-3502` |
| Rate-limit / backoff visible | ✅ | `RemoteControlService.ts:322-328`; rendered `project.js:3510-3518` |
| Persistent-failure indicator | ✅ | `consecutiveFailures:318`; rendered at `>=3` `project.js:3520-3527` (threshold hardcoded 3 — nit) |
| Rendered in Remote tab, not console-only | ✅ | `project.html:1957`; 15s poll `project.js:3470-3479` |
| **Last push status breadth** | ⚠️ PARTIAL | Only archive (`AutoArchiveService.ts:223-229`) + project-context (`KanbanProvider.ts:2101`) pushes record health. Status-mirror (column moves) and git `pushExportedState` do **not** feed the health UI |

**Hide triage/automation setup sections:** ✅ all ClickUp + Linear triage buttons/hints and Kanban-mapping/Automation sections carry `display:none` (`setup.html:824-828,834,901,1021-1025,1031,1097`); error surfaces preserved; no confirm dialogs.

---

## Shipping / distribution finding (skill mirror trap)

Five skills are committed to the dev repo's `.claude/skills/` but are **absent from `MIRROR_MANIFEST`** and don't match the `switchboard-*.md` scan — so `generateClaudeMirror` never emits them on a user machine. Four of the five are **advertised in the shipped `AGENTS.md`/`CLAUDE.md` registry** (`AGENTS.md:85,86,103,104`) — advertised-but-absent, worse than merely missing.

| Skill | Advertised in `AGENTS.md`? | `.agents/` source? | In manifest? | Ships? | Origin |
|---|---|---|---|---|---|
| `improve-remote-plan` | ✅ ("use in remote sessions") | ❌ none | ❌ | **No** | **This plan** — Epic 3, commit `6d40d30` |
| `create-epic` | ✅ ("when the extension is not running") | ❌ (only `kanban_operations/create-epic.js`) | ❌ | **No** (remote skill) | **This plan** — Epic 3, commit `6d40d30` |
| `clickup_move_task` | ✅ | ✅ `.agents/skills/clickup_move_task.md` | ❌ | **No** | Pre-existing — commit `74c362d` |
| `linear_move_issue` | ✅ | ✅ `.agents/skills/linear_move_issue.md` | ❌ | **No** | Pre-existing — commit `74c362d` |
| `sw` (`/sw` alias) | — (alias, not in table) | ❌ | ❌ | **No** | Pre-existing — commit `48e81c5` |

**The cruelest detail:** `create-epic`'s advertised purpose is to be the fallback *"when `create-epic.js` is unreachable"* (i.e., in a remote session with the extension off) — and the fallback is precisely the copy that doesn't ship. `improve-remote-plan` is likewise a remote-session skill that never reaches remote sessions.

**What this plan touched that DOES ship (re-verified):** `sw-remote`, `switchboard-chat`, `improve-plan`, `memo` (all manifest workflows — so Epic 3's grouping-awareness edits and Epic 6's manifest doc-example fixes landed in shipped sources), `kanban_operations` + its `create-epic.js`/`assign-to-epic.js`/`move-card.js`/`get-state.js` scripts (ship via the `.agents/` copy — so **local** epic creation works), and `group-into-epics`. Git status confirms the `.agents/` sources for the grouping and kanban_operations edits are modified.

**Fix (all five are the same one-class bug):**
- `clickup_move_task`, `linear_move_issue`: add a one-line `MIRROR_MANIFEST` entry each — `.agents/` sources already exist.
- `improve-remote-plan`, `create-epic`: create the `.agents/` source from the existing `.claude/` body + add a manifest entry.
- `sw`: add a manifest entry aliasing `switchboard-chat`, or drop the dead `.claude/sw` dir.
- Then re-run the cross-reference to prove `.claude/skills/` regenerates to a superset of the manifest with zero orphans.

---

## Consolidated prioritized gaps

**Blocking / correctness:**
1. **Epic 2 trunk is on an unmerged branch, not integrated** — the unified push dispatch (`pushState`/`pushContent`), ClickUp-behind-seam, Linear description pull-back, and consolidated-config contract all exist on `remote-sync-refactor-implementation` but were never merged into the Epic 3–7 line (`remote-sync-2`) or `main`. The largest item, but it is **integration/merge work with expected conflicts** (`src/services/remote/`, `RemoteControlService.ts`), not greenfield implementation. Confirm 3/3's config clean-break during the merge (legacy `realTimeSyncEnabled` still present on all branches).
2. **Two `tsc` compile errors (TS18004, `let`-in-`try` scoping)** in the outbound epic-push path: `LinearSyncService.ts:2892` and `ClickUpSyncService.ts:3326`. Now committed as WIP (`f4093e8`). Plan-independent — real bugs to fix.
3. **Two of this plan's skills don't ship (Epic 3)** — `improve-remote-plan`, `create-epic` (remote). Advertised in `AGENTS.md`, never generated on user machines. Plan-independent (a functional shipping defect, not a plan-alignment issue) — but confirm these are meant to be user-facing skills.

**Behavioral:**
5. **Auto-archive dwell proxy (Epic 7)** — uses `plan.updatedAt`, not true time-in-column; needs a `columnEnteredAt` field.
6. **`boardStateExport: none` still leaves mirror files git-tracked (Epic 6)** — `WorkspaceExcludeService.TARGETED_RULES:19-20` not gated on the setting.
7. **Control-plane pull cadence (Epic 6)** — inherits 300s instead of the ~60s the plan sized for.

**Minor:**
- `deleteEpic` doesn't unlink subtasks from the tracker (Epic 5).
- Push-health doesn't cover status-mirror / git pushes (Epic 7).
- Persistent-failure threshold hardcoded to 3 (Epic 7).
- Three pre-existing skills share the shipping trap (`clickup_move_task`, `linear_move_issue`, `sw`).

---

## Compile errors (verified via `tsc --noEmit`)

- `LinearSyncService.ts:2892` — TS18004, `let` declared in `try` and returned outside scope, inside `syncEpicWithSubtasks`.
- `ClickUpSyncService.ts:3326` — same class, inside the ClickUp `syncEpicWithSubtasks`.
- (Also 4× TS2835 import-extension artifacts on dynamic imports in `KanbanProvider`/`TaskViewerProvider`/`ClickUpSyncService` — pre-existing style artifacts, not new bugs.)

Both real errors live in the Epic 5 outbound epic-push path (`syncEpicWithSubtasks` on both services). Plan-independent — worth fixing regardless of scope.

---

## Audit limitations (stated honestly)

- **Static inspection only.** No runtime end-to-end test was run (no live IDE session, no live Notion/Linear round-trip). The Linear GraphQL `documentCreate`/`documentUpdate` and archive mutations are structurally correct but unverified against Linear's live schema.
- **Verdicts are against the member plans + the coordination contract.** Where the two disagree (e.g. Epic 3's `restoreFromConfig` vocabulary, Epic 5's outbound path), this is called out; the code often follows the member plan, which predates the re-pointing directive.
- **This audit under-verified three times before landing.** (1) It initially treated "the file/service exists" as evidence of implementation. (2) It filed the Epic 3 skill-shipping issue as "minor" before tracing the distribution mechanism. (3) **It only inspected `remote-sync-2` and `main`, never enumerating all branches — so it wrongly concluded Epic 2 was "not implemented" when the full refactor lives on `remote-sync-refactor-implementation`** (caught by a second reviewer, then independently verified; see Correction). Lesson: "is X implemented?" for a multi-branch program requires a branch sweep (`git branch --contains`, `git log --all -- <path>`), not a single-worktree grep. All three were corrected in-document.

---

## Recurring risk worth internalizing

The single decision that explains most divergences: **Epic 2 (the re-pointing trunk) was built on its own branch (`remote-sync-refactor-implementation`) and never merged into the line where Epics 3–7 were built (`remote-sync-2`).** Downstream epics were therefore developed against a seam their branch never received, so they either followed their pre-refactor member plans (Epic 5's bespoke outbound path) or referenced trunk deliverables absent from their branch (Epic 7's guard "three paths"; Linear bidi). The coordination plan flagged "re-pointing debt" as its highest risk — it materialized as **branch fragmentation**: the trunk and its dependents were built in parallel and never integrated. The remediation is a deliberate merge/rebase of `remote-sync-refactor-implementation` into the Epic 3–7 line (with conflict resolution in `src/services/remote/` and `RemoteControlService.ts`), followed by re-pointing Epics 5/7 onto the now-present unified seam.
