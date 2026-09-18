# Stop Switchboard Scaffolding Litter in Child Repos

## Goal

Stop the extension from planting Switchboard scaffolding (`.switchboard/`, `.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`) inside repos the user never set up as Switchboard workspaces — specifically child repos opened in an IDE window (e.g. the Gitlab child repos viaapp/fe/be, which map to the `Gitlab/` control-plane parent).

### Problem & root-cause analysis

Observed 2026-07-13: full agent scaffolding (AGENTS.md, CLAUDE.md, ~65 `.agents/skills` files, `.claude/skills`, `.agent_version.json`) appeared in every Gitlab child repo (viaapp, fe, be, viaapp-web, ai, analytics-dashboard, funnel-sandbox), in unrelated repos (patrickwork, autism360-analytics), and even in non-repo folders (`~/Documents`, home). All untracked — nothing was committed — but it pollutes `git status` in work repos and risks accidental commits.

Three composing defects (the third found during plan review):

1. **The local board mirror auto-creates the opt-in marker.** `KanbanDatabase._writeLocalBoardMirror` (src/services/KanbanDatabase.ts:8182) writes `kanban-state-*.md` / `kanban-board.md` into `.switchboard/` under **every workspace root that gets a DB instance**, unconditionally creating the directory (`fs.promises.mkdir(..., { recursive: true })` at :8300). `_resolveExportRoot` (:8055) only *redirects* to the control plane when `boardStateExport === 'control-plane'`; the default `'none'` does not disable the write — it falls through to `this._workspaceRoot`. So merely opening a child repo in any window with the extension active (VS Code, Devin's IDE) grows a `.switchboard/` with its own workspace id. This is how viaapp/fe/be acquired `.switchboard/` in June. (How a *mapped* child still gets a child-rooted DB instance: `KanbanDatabase.forWorkspace` (:919) redirects via the mapping index, but the index is built only from **open folders' existing DBs** — `initializeMappingIndex` at extension.ts:185. In a window where the parent isn't open, the index is empty and no redirect happens.)

2. **The scaffolding gate trusts that marker.** The Jul 11 multi-root activation refresh (commit 300f5ee, extension.ts:558–583) scaffolds every open workspace folder that passes `isSwitchboardManagedFolder` (extension.ts:245) — whose sole test is "does `<root>/.switchboard/` exist as a directory". Its own comment claims this "prevents littering unrelated open repos", but defect #1 auto-creates that marker, so the gate is self-defeating. Before 300f5ee only the focused folder was refreshed, which masked defect #1; after it, every open child repo got the full control-plane dump on the next version bump (Jul 11–12). `isSwitchboardManagedFolder` has exactly one caller (extension.ts:577), so the gate change is fully contained.

3. **Workspace-identity writers also plant the marker.** `tryWriteCommittedWorkspaceId` (src/services/WorkspaceIdentityService.ts:187, mkdir at :190) and `tryWriteCommittedWorkspaceIdIfDifferent` (:203, mkdir at :219) do `fs.promises.mkdir(path.dirname(committedPath), { recursive: true })` and write `.switchboard/workspace-id` into any unmapped root they run against. Callers include `PlanFileImporter.importPlanFiles` (:52), `TaskViewerProvider._getOrCreateWorkspaceId` (:12820), and `KanbanDatabase.invalidateWorkspace` (:1099). This matters doubly: it is a second litter creator, and it plants the very file this plan proposes as a tier-3 "deliberate setup" marker.

## Metadata

- **Tags:** bugfix, reliability
- **Complexity:** 6

## User Review Required

- None. (One pre-ship verification item is listed under Uncertain Assumptions — it is a local data check, not a product decision.)

## Complexity Audit

### Routine

- Fix #1/#1b are early-bail guards in existing writer functions — no behavior change for real workspaces (their `.switchboard/` always exists).
- The tiered gate replaces one small predicate with one call to an existing resolver (`resolveEffectiveWorkspaceRootFromMappings`) plus three `fs.existsSync` checks.
- Cleanup-verb extension follows the exact shape of the existing `.agent`-dir cleanup in SetupPanelProvider (state fn + perform fn + webview button).

### Complex / Risky

- Gate must not lock out any *legacy shipped* single-folder layout — a real workspace that has `.switchboard/` + plans but none of the tier-3 markers would silently stop receiving skill/protocol refreshes (mitigated: verify one real install layout before ship; add its distinguishing file to the allow-list if needed).
- Litter removal touches user filesystems across ~4,000 installs — must never delete genuine plan files that agents mistakenly wrote into a child repo's `.switchboard/plans/`.
- Tier-1 depends on the mapping index being built before the refresh loop runs (ordering invariant, currently satisfied: extension.ts:501 before :558).

## Edge-Case & Dependency Audit

- **Race Conditions:** Mapping index is built from open folders' DBs only (extension.ts:185–219). In a child-only window the index is empty → tier-1 cannot fire; tier-3 markers are the backstop and littered children carry none of them. The refresh loop (:576) must keep running after `initializeMappingIndex` (:501) — add a comment stating this invariant. `resolveEffectiveWorkspaceRootFromMappings` memoizes "no mapping" results, but `buildMappingIndexFromDbs` replaces the cache wholesale (WorkspaceIdentityService.ts:90), so pre-build poisoning self-heals.
- **Security:** No new attack surface. Cleanup deletes only well-known paths under user-visible roots, never follows symlinks (reuse the lstat symlink guard from `_performAgentDirCleanup`, SetupPanelProvider.ts:1683).
- **Side Effects:** After fix #1, `_writeKanbanStateBackup` (KanbanDatabase.ts:7886) — which writes to `this._workspaceRoot` with no mkdir — would fail-and-log on every persist in a non-workspace. Give it the same silent early-bail. `BoardSnapshotPublisher` (git orphan-branch export) is opt-in and writes no workspace files — untouched.
- **Dependencies & Conflicts:** `ControlPlaneMigrationService` audit result: `.switchboard`-existence checks at :172 (`cleanupEligible`, migration-preview display only) and :570 (`alreadyControlPlane`, checks `kanban.db` specifically) do not scaffold unrelated repos — leave both. `createIfMissing` (KanbanDatabase.ts:1783–1791) already refuses to create a DB in a mapped child — consistent with this plan. The `switchboard` skill and orchestration flows read kanban-state files from *real* workspaces only; fix #1 does not change their behavior there.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) tier-3 marker `workspace-id` is self-plantable by identity writers — closed by fix #1b; (2) cleanup could delete genuine stray plan files — closed by the plans-preserving rule; (3) a legacy shipped layout lacking all tier-3 markers would stop refreshing — closed by pre-ship layout verification with allow-list extension. Mitigations are all stop-writing or additive; nothing destroys shipped-install state.

## Proposed Changes

### 1. Board mirror must never create `.switchboard/` — `src/services/KanbanDatabase.ts`

In `_writeLocalBoardMirror` (:8182):

- After resolving `exportRoot` (:8192), **bail out early if `path.join(exportRoot, '.switchboard')` does not already exist as a directory**. No `mkdir` of the root marker. A genuine Switchboard workspace always has `.switchboard/` (created by explicit setup / DB creation for the control-plane root); a repo that lacks it was never set up and must not be converted.
- The per-column `mkdir` at :8300 targets `path.dirname(perColPath)` which *is* `<exportRoot>/.switchboard` — once the early bail exists, this mkdir is a no-op re-creation guard; keep it only if the bail already passed (covers a mid-write deletion edge without converting a non-workspace).
- The `kanban-board.md` write (:8354) and the stale `kanban-state.json` unlink (:8349–8352) are downstream of the same bail — no separate handling needed.
- `_writeKanbanStateBackup` (:7886) writes `kanban-state-backup.json` to `this._workspaceRoot` (note: NOT `exportRoot`) and has no mkdir, so it cannot create litter — but after this fix it would error-log forever on non-workspaces. Add the same silent early-bail (dir must exist) at its top.
- Do NOT change the meaning of `boardStateExport: 'none'` — shipped installs and the `switchboard` skill rely on local kanban-state files existing in real workspaces. The fix is "never create the marker", not "stop exporting".

### 1b. Identity writers must never create `.switchboard/` — `src/services/WorkspaceIdentityService.ts`

In `tryWriteCommittedWorkspaceId` (:187) and `tryWriteCommittedWorkspaceIdIfDifferent` (:203):

- Replace the `mkdir(..., { recursive: true })` (:190, :219) with an existence check on `<root>/.switchboard`: if absent, return silently without writing `workspace-id`. Identity resolution itself (`ensureWorkspaceIdentity`) still returns the id — only the *file mirror* is skipped for non-workspaces.
- This is a **Clarification** required by the existing goal, not new scope: without it, defect #3 re-plants the tier-3 marker the strengthened gate trusts, and callers like the Tickets tab (`TaskViewerProvider._getOrCreateWorkspaceId`, :12820) or `KanbanDatabase.invalidateWorkspace` (:1099) would silently re-arm an unrelated root for scaffolding.
- `ensureWorkspaceIdentity`'s mapped-child branch (:237–243) already avoids writing into children — unchanged.

### 2. Strengthen `isSwitchboardManagedFolder` — config first, markers as fallback — `src/extension.ts`

The workspace mappings configured in setup.html are the authoritative opt-in signal and must be consulted first. Each mapping carries `parentFolder` + an explicit `workspaceFolders` child list, and `resolveEffectiveWorkspaceRootFromMappings(root)` (WorkspaceIdentityService.ts:111) already answers "does this folder redirect to a parent?" in one call. Gate each refresh target in tiers (replace the body of `isSwitchboardManagedFolder`, :245, keeping its single call site at :577):

1. **Mapped child** — `resolveEffectiveWorkspaceRootFromMappings(root) !== root` → **never scaffold**. The folder belongs to a parent that is already in the refresh-target set (mapping parents are added to `refreshTargets` at :566–572). This stops the Gitlab child-repo case for any child listed in the mapping — *when the parent's DB is visible to the window* (see limitation below).
2. **Configured parent** — root equals a mapping's resolved `parentFolder` (covered by the same resolver returning `root` for parents that appear in a mapping — distinguish via `getMappingsFromIndex()` if needed) → scaffold. Explicit user opt-in from setup.html.
3. **Unclaimed by config** (standalone installs with no mappings, or folders not in any `workspaceFolders` list — config cannot distinguish these from random opened repos) → fall back to a marker test. `.switchboard/` existing is not sufficient (defects #1/#3 auto-create it); require evidence of deliberate setup, any of:
   - `.switchboard/kanban.db` (real standalone workspace),
   - `.switchboard/db-pointer` (redirected root; only ever written for mapping parents via `writeDbPointer`, KanbanDatabase.ts:856),
   - `.switchboard/workspace-id` (legacy id file used by skills — see caveat).

   Littered dirs (e.g. viaapp's: only kanban-state files, `dbbackup/`, `epics/`, `plans/`, a `.migrated.bak`) contain none of these (verified against viaapp 2026-07-13: only `plans/` remains).

   **Caveat on `workspace-id`:** historically plantable by defect #3, so a littered root *could* carry it if identity flows ever ran there. Fix #1b stops future planting; the marker stays on the allow-list because legacy shipped installs genuinely use it as the first-time-setup identity carrier (`ensureWorkspaceIdentity` PRIORITY 2, WorkspaceIdentityService.ts:254). Residual risk (historically self-planted `workspace-id` on a littered root) is accepted: worst case is that one root keeps receiving refreshes until the user runs the cleanup verb, which reports it.

**Tier-1 limitation (document in code):** the mapping index is built from open folders' DBs only (`initializeMappingIndex`, extension.ts:185). In a window containing only a child repo, the index is empty and tier-1 cannot fire — tier-3 is the operative backstop there. Also add a comment at the refresh loop (:558) stating the ordering invariant: it must run after `initializeMappingIndex` (:501).

Audit result (this review): `isSwitchboardManagedFolder` has exactly one caller (extension.ts:577). `ControlPlaneMigrationService`'s `.switchboard`-existence checks (:172, :570) are migration-preview/parent-detection logic, not scaffolding gates — leave them.

Migration note (shipped-state rule): this makes the gate *stricter*, which can only stop writes, never destroy data — no migration needed. Verify one real single-folder install layout satisfies at least one of the tier-3 markers before shipping; if some legacy layout has `.switchboard/` + plans but none of the markers, add that layout's distinguishing file to the allow-list rather than weakening back to dir-existence.

### 3. Litter detection in the existing cleanup verb — `src/services/SetupPanelProvider.ts`

Extend the existing agent-dir cleanup path (`_getAgentDirCleanupState` :1614 / `_performAgentDirCleanup` :1663, message handlers around :1391) to also recognize a *littered* folder — `.switchboard/` present but failing the strengthened predicate — and offer to remove the full scaffold set (`.switchboard/`, `.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`) from it. Rules:

- **Scan set:** `_resolveWorkspaceRoots()` (open folders) **plus** all mapped children from `getMappingsFromIndex()` — the mapped children are the known primary victims and may not be open in the current window. Litter in arbitrary non-open, non-mapped folders (e.g. `~/Documents`) is out of reach of this verb; document that limitation in the panel copy.
- **Skip anything git-tracked** (`git ls-files --error-unmatch` or equivalent) — belt-and-braces; litter is untracked by definition.
- **Preserve plan files:** if `<root>/.switchboard/plans/` contains any `.md` files, do NOT delete them (agents have mistakenly written genuine plans into child repos). Delete the rest of the scaffold set and report the preserved `plans/` directory to the user instead of removing `.switchboard/` wholesale in that case.
- **Symlink guard:** reuse the lstat pattern from `_performAgentDirCleanup` (:1683) — never delete through a symlink.
- No automatic deletion on activation: detection is automatic, removal stays a button (NO confirmation dialog on the button, per project rule — the gated part is that deletion only happens on explicit click). This gives the ~4,000-install base a supported way to clean historical litter.

## Verification Plan

(Per session directives: no compilation step, no automated test runs.)

Manual verification via installed VSIX:

- Open a fresh repo (no `.switchboard/`) in a window with the extension active, use the board in another workspace, bump the version, reactivate: the fresh repo gains **zero** Switchboard files (covers fixes #1 and #1b — no kanban-state files, no `workspace-id`).
- A repo listed as a mapped child in setup.html workspace mappings is **never** scaffolded on activation, even if it has a full `.switchboard/` dir (tier-1; test with the parent folder open in the same window).
- A child repo with pre-existing litter (kanban-state files only) and no mapping entry is **not** re-scaffolded on activation and shows as "littered" in the cleanup state (tier-3 backstop; test in a child-only window).
- Running the cleanup on a littered root that contains `.switchboard/plans/*.md` removes the scaffold set but preserves the plan files and reports them.
- A real workspace (has `kanban.db` or `db-pointer`) still receives skill seeds + protocol files on version bump, and its kanban-state mirror still updates on card moves.
- Control-plane redirected export (`boardStateExport: 'control-plane'`) still writes to the mapping parent only.
- Tickets tab pointed at a non-Switchboard root still resolves a workspace id (no error) but writes no `workspace-id` file there.

### Automated Tests

Skipped per session directive. If added later: unit tests for the tiered predicate (mapped child / parent / marker fallback matrix) and for the mirror/identity early-bails against a temp dir without `.switchboard/`.

## Uncertain Assumptions

- Whether every *legacy shipped* single-folder install layout carries at least one tier-3 marker (`kanban.db`, `db-pointer`, or `workspace-id`). This is an install-base data question, not web-researchable — verified locally against one real install before ship (see Migration note in Proposed Changes §2). No web research required; all other claims were verified directly against the code in this review.

---

## Completion Report

Implemented the three fixes described above:
1. `KanbanDatabase._writeLocalBoardMirror` and `_writeKanbanStateBackup` now bail out if `<root>/.switchboard/` does not exist as a directory, preventing the mirror from creating `.switchboard/` in non-workspaces.
2. `WorkspaceIdentityService.tryWriteCommittedWorkspaceId` and `tryWriteCommittedWorkspaceIdIfDifferent` replaced `mkdir` with an existence check on `.switchboard/`; they no longer create the directory.
3. `extension.ts isSwitchboardManagedFolder` now uses a tiered predicate (mapped-child block / mapping-parent allow / marker fallback) and `SetupPanelProvider` cleanup was extended to detect and remove scaffold litter in non-managed roots, preserving `.switchboard/plans/*.md` files and guarded against git-tracked files and symlinks.

Files modified: `src/services/KanbanDatabase.ts`, `src/services/WorkspaceIdentityService.ts`, `src/extension.ts`, `src/services/SetupPanelProvider.ts`, `src/webview/setup.html`.

Notes: `TaskViewerProvider.ts` and `.switchboard/plans/feature_plan_20260712231611_visibleagents-file-backed-write-through-and-fold-migration.md` had pre-existing unrelated changes in the working tree and were left untouched. Compilation and automated tests were skipped per the session directive; verification is the manual VSIX checklist in the plan.

**Recommendation: Send to Coder** (Complexity 6)

## Review Findings

**CRITICAL (fixed): the litter cleanup was destroying user-owned data.** `_performScaffoldLitterCleanup` did `rm -rf` on `.claude/`, `AGENTS.md`, and `CLAUDE.md` wholesale — but Switchboard does not own those: it writes only ledger-tracked skills into `.claude/` (the user's Claude Code config dir, holding their settings.json/settings.local.json/commands/plans/skills) and only a marker-delimited managed block into CLAUDE.md/AGENTS.md (which coexist with user content — this repo's own CLAUDE.md carries user rules above the block). The delete set therefore vaporized the user's Claude Code config and any hand-authored CLAUDE.md/AGENTS.md. Rewrote the cleanup to be surgical, mirroring `ClaudeCodeMirrorService`'s own discipline: `.claude/` → remove only skills listed in `.switchboard-generated.json` (no ledger = don't touch); CLAUDE.md/AGENTS.md → strip only the managed block (first-start→last-end), delete the file only if nothing else remains; `.switchboard/` (preserve `plans/*.md`) and `.agents/` stay wholesale as genuinely Switchboard-owned. Verified against a temp dir: user rules preserved on strip, block-only files deleted, marker-less files untouched, user `.claude/` skills + settings.json preserved.

## UAT Failure 2026-07-13 (17:06 activation of fixed 1.7.13 build)

UAT FAILED with the fixed build installed and running. Three holes found and closed:

1. **The api-server-port.txt broadcaster was never guarded.** `TaskViewerProvider._startLocalApiServer` wrote the port file into EVERY workspace root with `mkdir(..., {recursive: true})`, filtered only by `_filterMappedRoots` — and the polluted folders (switchboard-site, patrickwork, analytics-dashboard) are all UNMAPPED, so the filter passed them. This freshly created `.switchboard/` in brand-new repo switchboard-site at 17:06. **Fixed:** port file now written only into roots whose `.switchboard/` already exists (`_filterPortFileEligibleRoots`, no mkdir); watchdog liveness check updated so a window with zero eligible roots doesn't restart-loop.
2. **Tier-3 `workspace-id` allow-list re-armed littered roots.** The plan's "accepted residual risk" was real: analytics-dashboard carried a self-planted `workspace-id` (May 28, defect-#3 era, no kanban.db) and therefore received the full `.agents`/`.claude`/protocol refresh at 14:51. **Fixed:** `workspace-id` removed from the tier-3 marker list in both `extension.ts` and `SetupPanelProvider.ts` — markers are now `kanban.db`/`db-pointer` only. A genuine root misclassified self-heals the moment its board is used (kanban.db appears).
3. **Pre-guard-era full scaffolds pass as real workspaces.** patrickwork/.switchboard (Apr 2026) has a real kanban.db with 20 plans — indistinguishable from a deliberate workspace by any predicate; removal is a user decision, not code.

Litter cleaned during UAT triage: switchboard-site/.switchboard (port file only) deleted; analytics-dashboard `.agents/`, ledger-tracked `.claude/skills` + ledger, and pure-managed-block AGENTS.md/CLAUDE.md removed (`.claude/settings.json` and `.switchboard/` left — May-era config, user call).

**CRITICAL (fixed): confirm gate.** Removed the DELETE/CANCEL modal (two-click confirm gate violating the hard no-confirm rule and plan §3); the CLEAN UP button now removes on click, and the always-visible card enumerates exactly what each root loses.

Also verified sound and kept: lazy `_initialize` (identity/mirror existence-bails can't break legit bootstrap), tier-1/2/3 gate, `git ls-files --error-unmatch` tracked-guard. Files changed: `src/services/SetupPanelProvider.ts` (surgical cleanup + `_removeMirroredClaudeSkills`/`_stripManagedBlock` helpers + block-marker constants), `src/webview/setup.html` (confirm gate removed, accurate card preview), `src/extension.ts` (stale comment). Validation: `SetupPanelProvider.ts` TS-parse clean, `setup.html` JS-parse clean, helper behavior temp-dir verified (compile/tests skipped per session directive). Deferred NITs: duplicated tiered predicate across two files, dead `_resolveWorkspaceRoots`, redundant inline `require`.
