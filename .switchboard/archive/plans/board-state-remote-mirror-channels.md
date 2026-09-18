# Board State Remote Mirror: Configurable Export Destinations + Git-Native Remote Control

**Plan ID:** f89dabb4-14c9-4a85-aafe-89b6a4a71889

> **Improve-plan pass (2026-07-01) — session insights folded in.** A ground-truth code audit refines three load-bearing assumptions (detail in-line and in `## Adversarial Synthesis`): (1) the `RemoteProvider` interface is **pull-only** — no push methods — so the git providers' *inbound* deltas plug into the existing seam, but the *outbound* mirror push is **net-new**, not "implement the same interface Linear/Notion do"; (2) `RemoteControlService` has **no auto-start** (only a manual `start()` + `silentSync` + `pingFrequencySeconds`; no `pingMode`/`restoreFromConfig`), so the "web agent checks in periodically" story depends on the **startup reconciler** plan; (3) plan files do **not** carry a `**Column:**` line today — §3's inbound state signal requires a net-new export change. Consistent with: the remote-sync surface is experimental/unshipped → clean break, **no migration**.

## Goal

Give a workspace an explicit choice of **where** (if anywhere) its kanban board state gets mirrored for remote/web-agent visibility, decoupled from the git history developers actually work in — and let the git-native destinations (control plane, wiki) support the same **bidirectional** remote-control capability Notion/Linear already have, not just one-way state export.

### Problem & background (root cause)

`KanbanDatabase.exportStateToFile()` writes `.switchboard/kanban-board.md` and `.switchboard/kanban-state-*.md` directly into the active project's own working tree on every DB persist, and these are git-tracked (carved out of the managed `.switchboard/*` ignore block) so they get committed alongside real development work. This exists for a real reason: a remote/web-only agent (e.g. a claude.ai session with no DB or local API access) has no other way to read current board state — it reads these files from the repo and can recreate them as an artifact.

The root cause of the friction is that **this is the only distribution channel that exists**, so it conflates two orthogonal concerns: developer-facing git history, and remote-agent-facing state visibility. Two concrete problems fall out of that conflation, both already observed (not hypothetical) in this repo's own history over the course of this investigation:

1. The mirror files' embedded `*Updated: <timestamp>*` line changes on every DB persist, making the working tree look dirty almost continuously. This already broke `planAutoFetch`'s clean-tree guard (fixed separately in `PlanAutoFetchService.ts`, commit `faf4d82` — that fix stays in place as defense-in-depth, but doesn't address the underlying commit-to-`main` behavior).
2. Because the timestamp line differs between any two independently-generated copies of the file, two concurrent sessions/branches regenerating it are close to guaranteed to produce a textual merge conflict on that exact line when merged — this repo alone merged two independent agent-authored PRs (#26, #27) during this investigation, each carrying its own regenerated copy.

This feature has **no released users** (confirmed) — no migration path is required. The fix is free to change the default behavior outright rather than staging a transition.

## What gets built

### 1. A `boardStateExport` setting: `none | control-plane | wiki | notion | linear`

- **`control-plane`:** requires a control plane to be configured (see §2). The control-plane directory itself becomes (or already is) its own git repo with a remote; the mirror is pushed there instead of into any managed project's repo.
- **`wiki`:** for standalone workspaces without a control plane. Mirror is pushed to `<remote>.wiki.git` instead of `main`.
- **`none`:** `kanban-board.md` / `kanban-state-*.md` are not git-tracked or committed anywhere. Board state remains exactly where it already lives (DB + local files) with zero git footprint.
- **`notion` / `linear`:** unchanged — existing providers, included here only as sibling options in the same setting.

`none`, `control-plane`, and `wiki` are mutually exclusive per workspace (one export target at a time); `notion`/`linear` remain governed by the existing remote-control provider config, unaffected by this plan.

**Default is flat `none`, unconditionally — no auto-detection.** The relevant axis is not "is this specific destination safe to expose to" (an earlier, narrower framing considered and rejected during design) — it's that turning on *any* remote-publishing behavior is categorically something a tool must never do on its own, independent of how safe the specific instance looks. This matters most for `control-plane`: today a control plane is a purely local, git-free directory; silently defaulting to `control-plane` whenever one exists would obligate it to become a git repo with a configured remote and a background push loop the moment this feature ships — a new infrastructure and network-activity commitment the user never asked for when they set up their control plane for an unrelated, purely-local reason. `wiki` has the same problem for the same reason, independent of the private/public-repo distinction. Enabling any destination is therefore always an explicit, deliberate per-workspace action — never inferred, never automatic, regardless of migration status (this plan is free to change the default later with zero migration cost, but "free to change later" is not a reason to default to "on" now).

### 2. Control plane becomes an optional git-backed remote-control provider

Today `ControlPlaneMigrationService` treats the control-plane directory as purely local and actively discourages git-tracking it (existing warning at line 574: *"Your parent folder is a git repository. You may still need `.gitignore` entries for `.switchboard/` here."*). For workspaces that opt into `control-plane` as their export destination, this is reversed:

- If the control-plane root isn't already a git repo, offer (opt-in, not automatic) to `git init` it and accept a remote URL (`git remote add`).
- Generate/verify a `.gitignore` in the control-plane root that excludes every managed project subdirectory by name, derived from the existing workspace-mapping config (the same mappings `PlanAutoFetchService._getAllowedRoots()` already reads via `WorkspaceIdentityService`), plus a catch-all safety net. This is required, not optional: git does not auto-absorb a nested repo's content (a subdirectory containing its own `.git` is a boundary — at worst, an unguarded `git add .` creates a bare "gitlink" pointer, not a copy of the nested repo's files), but relying on that alone is fragile; an explicit `.gitignore` per managed subdirectory makes it impossible to accidentally stage one.
- The mirror content itself reuses the control plane's existing `.switchboard/` location (`kanban-board.md`, `kanban-state-*.md`, plan mirrors) — no new subfolder. The control plane already owns this data; this plan only makes it optionally push-able.
- The existing line-574 warning is suppressed for control planes that have explicitly opted in — the opposite guidance now applies (`.switchboard/`-derived mirror content is exactly what should be tracked there).

### 3. A `GitStateProvider` implementing the existing `RemoteControlService` provider interface

`control-plane` and `wiki` both implement the same state-delta + comment-delta interface Linear/Notion already implement, so they plug into `RemoteControlService`'s existing 60s (30–120s configurable) polling loop rather than standing up a parallel system.

**Hard invariant: mirror files are Switchboard-exclusive to write.** `kanban-board.md` / `kanban-state-*.md` must never be generated or committed by anything other than Switchboard's own local export cycle — never bundled into an agent's or human's PR alongside real content (a new plan file, a code change, etc.). This is what keeps merges conflict-free: a PR that only ever adds/edits genuine content (e.g. a new plan authored by an agent) can never collide with the mirror files, because nothing on the other side of that merge has touched them independently. This is the exact discipline that was missing in the pre-fix state, where two independent sessions each regenerated the same file and collided on merge (PR #26/#27).

- **State signal** (mirrors Notion's page-property / Linear's issue-status channel): each mirrored plan file carries a structured `**Column:** <name>` line. On each poll, `git fetch` + `git log <lastSeenSha>..<remoteHead>` over the mirror path; any plan whose `**Column:**` line differs from the last-known value is mirrored as a local column move, through the same column-validation guard the Linear/Notion state-delta path already uses.
- **Comment signal** (mirrors the existing `KanbanProvider.ts:1632` inbound-comment path): any new content appended beneath a plan's `**Column:**` line since `lastSeenSha` is appended locally as an `## Inbound Comment (<timestamp>)` section and dispatches the current column's agent (`:1638`) — no command-syntax parsing, identical behavior to today's Notion/Linear comment flow.
- **Cursor:** `remote.stateCursor.{control-plane|wiki}` and `remote.commentCursor.{control-plane|wiki}`, stored in the same DB config table Linear/Notion cursors already use — but holding the **last-processed commit SHA**, not a timestamp. This is strictly simpler than the existing providers: Notion's timestamp cursor needs a 500-ID de-dup cache (`remote.commentSeen.*`) to work around same-minute filter ambiguity; a commit SHA has no such ambiguity, so no de-dup cache is needed for the git-native providers.
- **Outbound push cadence:** debounced/coalesced identically to today's local-file writer (single-flight, trailing-request coalescing), with a floor equal to the poll interval — outbound pushes and inbound polls run on a comparable cadence rather than pushing on every card move. Each push cycle fetches first and reconciles (merge/rebase) against any commits that landed since the last local push, so an inbound edit from a remote agent never causes an outbound push to be rejected as a non-fast-forward — this reconcile step lives inside `GitStateProvider` itself, it is not a reuse of `PlanAutoFetchService` (which guards a different thing: untrusted code landing in a human's active branch, not signal commits in a dedicated mirror repo).
- **Inbound trust guard:** every state/comment delta is checked against an author allowlist before being mirrored locally or dispatched to an agent, mirroring `PlanAutoFetchService`'s trusted-author check (`PlanAutoFetchService.ts:238-251`) — reusing the same commit-author-email mechanism, git-side. This matters more here than it does for `planAutoFetch`: an untrusted inbound comment there just sits inert in a workspace, but here it flows directly into agent dispatch (`KanbanProvider.ts:1638`), so an unauthenticated/untrusted git author must never reach that path. Untrusted deltas are dropped and surfaced the same way `planAutoFetch` surfaces a skip reason, not silently ignored.

**Audit correction (2026-07-01) — inbound plugs in, outbound is net-new.** The `RemoteProvider` interface (`src/services/remote/RemoteProvider.ts:40`) is **pull-only**: `fetchStateDeltas` / `fetchCommentDeltas` / `stateKeyToColumn` / `refreshLocalPlanFromRemote` / `importRemotePlan` / `postComment`. So `GitStateProvider`'s **inbound** half (read column/comment deltas via `git log`, ack via `postComment`) genuinely implements the existing seam and rides the existing `_poll()` loop. But there is **no `pushState`/`pushContent`** on the interface — push today lives unabstracted in `ContinuousSyncService` + the column-move handlers (Linear/ClickUp only; Notion can't be pushed to). So the **outbound** mirror push (git commit+push of the regenerated export) is a *net-new mechanism layered on `exportStateToFile()`*, not a provider-interface method. Build it standalone here, but coordinate with the Remote Sync Refactor (which later generalizes push into a declared provider capability) so the two don't build conflicting push paths. Also net-new: plan files do **not** carry a `**Column:**` line today (verified — column lives in the DB and the grouped `kanban-state-*.md`, not per-plan), so the export must be extended to emit the per-plan `**Column:**` signal §3 reads.

### 4. Wiki provider

Push the mirror to `<remote>.wiki.git` using the same ambient git-credential path (`execFileAsync('git', [...])`) already used throughout this codebase (`PlanAutoFetchService`, `TaskViewerProvider.autoCommitForCodeReview`) — zero new auth surface. Confirmed working, zero-API-needed read path for any web agent: `raw.githubusercontent.com/wiki/<owner>/<repo>/<Page>.md` returns plain markdown with a bare unauthenticated fetch (verified live against a public repo during design).

**Documented limitation, not a defect:** GitHub wiki visibility always exactly matches the parent repo's visibility (confirmed against GitHub's own docs) — there is no way to have a private wiki on a public repo. `wiki` is offered as a zero-setup fallback for standalone workspaces that are fine with that; workspaces that need board state private on a public/OSS repo should use `control-plane` instead, since that's a wholly separate repo with its own independent visibility.

### 5. Control-plane local sync (pulling in externally-merged content)

A distinct need from §3: an agent (connected to both the control plane and a project repo) can write a genuinely **new** plan directly into the control plane's `.switchboard/plans/` on a branch and open a PR there; the user reviews and merges it on GitHub like any other PR. That merge only updates the *remote* — Switchboard's local checkout of the control plane needs to actually pull it down before the existing local plan-file-watcher (unchanged; the same mechanism that already turns a new on-disk plan file into a CREATED-column card today) can see it.

This reuses `PlanAutoFetchService` rather than inventing a second pull mechanism: extend it to also target the control-plane root (alongside project repos), with the *same* guard chain — clean-tree check (already correctly excludes the mirror files per the `faf4d82` fix), fast-forwardable check, trusted-author check — but **not** the same interval. `PlanAutoFetchService`'s existing 300s default (60s floor) was tuned for keeping a project checkout from going stale, a much less time-sensitive job than "a human just merged a PR and expects it to show up." The control-plane-targeting pull uses `RemoteControlService`'s cadence instead (60s default, 30–120s configurable) — same guard chain, different interval, decided explicitly rather than inherited by accident. Since the user is the one clicking merge on GitHub, the merge commit's author is the user, so it passes the trust check the same way any of the user's own merges do. This is intentionally the *narrow* pull-and-checkout mechanism (bring files onto disk for the existing watcher) — distinct from §3's `GitStateProvider`, which reads state/comment deltas via `git log` diffing without necessarily touching the working tree. The two are complementary: §5 is how a whole new plan enters the system; §3 is how an existing plan's column/comments get remotely signaled.

**Critical addition the dirty-check exclusion alone does not cover.** Excluding mirror files from the *dirty-tree check* only stops a needless "skipped: dirty" report — it does not make the subsequent `git merge --ff-only` safe. Because `control-plane` mode has §3 actively pushing regenerated mirror files to this same remote/branch, the remote side of a pull can legitimately also touch `kanban-board.md`/`kanban-state-*.md`. If local has uncommitted (dirty) content in those same files at that moment — which is likely, since a prior pull's newly-landed plan triggers an immediate local regeneration — git's fast-forward checkout refuses with "local changes would be overwritten by merge," and the pull fails on essentially every cycle where a pull and a regeneration land close together. The fix: immediately before attempting the merge, discard (`git checkout --` / reset) any uncommitted local changes matching the exact mirror-file pattern already defined in `PlanAutoFetchService.MIRROR_FILE_RE` — safe by construction, since these files are always fully re-derived from the DB and never hand-authored, so nothing is lost. This discard-before-merge step is required for §5's control-plane target; it is *not* required for a project-repo target once `none` is the default, since remote will never touch these files there. It is, however, a live gap in the already-shipped `faf4d82` fix as it stands today, while `main` in this repo still commits these files — worth patching immediately as a follow-up to `faf4d82`, independent of the rest of this plan's rollout.

## Rejected alternatives (do not re-litigate without new information)

- **GitHub Issues (PATCH body via REST API).** Conceptually the cleanest (fully outside the git object graph, no branch/commit involvement at all), but this extension has **zero existing GitHub API/token auth** — confirmed: every git operation today rides the user's ambient local SSH/credential-helper setup, with no PAT/OAuth flow anywhere in the codebase. Building that from scratch is disproportionate for an experimental feature.
- **GitHub Pages.** The non-branch-polluting way to do this (Actions-based deployment, not the legacy `gh-pages` branch) requires a checked-in workflow file and CI runs — heavier machinery than warranted here, and introduces Actions usage into a repo that may not already have any.
- **Per-project dedicated private companion repo.** Superseded by extending the control plane's existing role instead of inventing a new per-project repo concept from scratch — the control plane already aggregates multiple sibling projects under one location, so it's a strictly better version of the same idea.
- **Committing mirror files to `main`/feature branches (status quo).** This is the root cause this plan exists to fix, not an option going forward.

## Known limitation: eventual consistency, not real-time

Every destination in this plan is a downstream export of a single, non-distributed, local-machine-authoritative DB — there is exactly one live copy of "the board," on whichever machine is running the extension for that workspace, and no destination here is a live sync of it. A remote reader always sees a snapshot as of the last successful push, bounded by the outbound push cadence (§3, deliberately debounced to the poll interval — 30–120s — rather than pushing on every card move), plus however long the source machine has been offline, asleep, or not running the extension. This is inherent to the design, not a defect to fix later: a web agent reading board state may occasionally see a card in a column it's already moved out of locally, or miss a plan added moments ago. Acceptable for the target use case (a web agent checking in periodically, building an artifact from roughly-current state) — not a substitute for, or comparable to, real-time collaborative state.

## Scope & non-goals

- No migration for existing installs — confirmed unreleased/experimental, so the default can change outright.
- No changes to Notion/Linear provider behavior itself; they're included in the setting only as sibling options behind the same interface.
- Not building GitHub Issues or Pages support (see rejected alternatives).
- Not solving privacy-independent-of-repo-visibility for `wiki` — that's what `control-plane` is for.

## Worked end-to-end scenario (acceptance case)

1. User invokes `/sw`; the agent reads current `kanban-state.md`/planning instructions from the configured destination.
2. User describes a plan idea.
3. Agent writes the plan file and opens a PR against the control-plane repo.
4. User reviews and merges the PR on GitHub.
5. Within ~60–120s, §5's pull cycle fast-forwards the local control-plane checkout, landing the new plan file; the existing plan-file-import-watcher (unchanged) inserts it into the DB.
6. That DB write triggers `exportStateToFile()`, regenerating `kanban-state.md`/`kanban-board.md` locally; §3's outbound push cycle commits and pushes within its own ~60–120s window.
7. A new agent session starting fresh (e.g. a new `/sw` invocation, or a fresh clone/pull of the control-plane remote) sees the merged plan reflected in `kanban-state.md` — total convergence time on the order of 1–4 minutes end to end (step 5's pull interval plus step 6's push interval), not instant, per the eventual-consistency limitation above.

This is the concrete case the §5 interval decision above is sized for — it fails the "a minute or so" expectation if left at `PlanAutoFetchService`'s original 300s default, which is why that default is explicitly overridden rather than inherited.

## Open items to resolve during implementation (not product decisions — verification tasks)

1. Confirm whether `KanbanDatabase.exportStateToFile()`'s target path, **and the existing plan-file-import-watcher**, already resolve to the control-plane root when control-plane mode is active, the same way `PlanAutoFetchService._runCycleForRoot` resolves `effectiveGitRoot` via `getControlPlaneSelectionStatus` (`KanbanProvider.ts:4668`). If yes, this plan only needs to add git init/remote/push on top of the existing write/import paths. If no, both the exporter and the import-watcher need the same control-plane-path resolution added — step 5 of the worked scenario above depends on this being true for either reason.
2. Confirm there's no existing generated `.gitignore` content in `ControlPlaneMigrationService` that the new managed-subdirectory exclusion block would need to merge with rather than overwrite.

## User Review Required

1. **Outbound push = net-new — standalone or folded into the Remote Sync Refactor?** The `RemoteProvider` seam is pull-only; the git outbound push has no interface to plug into. Confirm building it standalone (git commit+push around `exportStateToFile()`) now, with a note to reconcile with the Remote Sync Refactor's future declared push capability.
2. **Net-new `**Column:**` per-plan export line** — §3's inbound signal reads a line plan files don't carry today. Confirm the export is extended to emit it (format + placement).
3. **Startup reconciliation is a hard dependency** — remote control does not auto-start; the "checks in every ~60–120s" scenario only holds while the poll is running. Confirm `kanban-startup-reconciler` gates the offline-then-resume path.
4. **Default `none`, no auto-detection** — already decided; re-affirm.
5. **Trust guard is bounded by mirror push-access** (see Security) — confirm acceptable.

## Complexity Audit

### Routine
- `boardStateExport` enum setting + setup UI (mirrors existing per-workspace settings).
- Reusing the `PlanAutoFetchService` guard chain (`_getAllowedRoots`, `_runCycleForRoot`, `MIRROR_FILE_RE:284`, `trustedAuthors:150/245`) for §5's control-plane pull.
- Wiki push via the existing ambient-git `execFileAsync('git', …)` path — no new auth.
- Reusing `RemoteControlService`'s `_poll()` loop + cursor-storage pattern for inbound deltas.

### Complex / Risky
- **Net-new outbound push half** — the seam is pull-only; the git push is greenfield and must coordinate with the Remote Sync Refactor.
- **Net-new `**Column:**` export signal** — the inbound channel rests on an export-format change that doesn't exist yet.
- **§5 discard-before-merge** racing a concurrent regeneration — must be strictly ordered after a completed single-flight export.
- **Trust guard flows into agent dispatch** (`KanbanProvider.ts:1638`) — security-sensitive; the allowlist is only as strong as who can push to the mirror.
- **Control-plane git init/remote/`.gitignore` generation** — reverses existing `ControlPlaneMigrationService` guidance; must not stage nested managed repos.

## Edge-Case & Dependency Audit

**Race Conditions**
- Concurrent inbound pull + local regeneration touching the same mirror files (§5). Mitigation: single-flight export; discard only `MIRROR_FILE_RE`-matching paths *after* a completed export, immediately before `merge --ff-only`.
- Outbound push vs. an inbound commit landing between fetch and push → non-fast-forward. Mitigation: fetch+reconcile inside the push cycle before pushing (already in §3).
- `_polling` re-entrancy guard prevents overlapping poll cycles (existing).

**Security**
- Inbound deltas flow into agent dispatch, gated by a trusted-author check (git commit-author email, `PlanAutoFetchService`-style). **Caveat (folded in):** commit-author email is spoofable; the guard's real strength is *who can push to the mirror repo*. For `control-plane` (separate, access-controlled repo) this is meaningful — document that the allowlist assumes restricted push. Untrusted deltas are dropped and surfaced, not silently ignored.
- No new auth surface — all git ops ride ambient credentials.

**Side Effects**
- Enabling `control-plane` obligates the control-plane dir to become a git repo with a remote + background push loop — never automatic (default `none`).
- `.gitignore` generation in the control-plane root excludes managed subdirectories.

**Dependencies & Conflicts**
- **Hard dependency on the startup reconciler** (`kanban-startup-reconciler`) for offline-resume reconciliation.
- **Coordinate outbound push with the Remote Sync Refactor** (declared push capability) to avoid two push mechanisms.
- Reuses `PlanAutoFetchService`, `RemoteControlService`, `ControlPlaneMigrationService`, `WorkspaceIdentityService`, `KanbanProvider:1632/1638` — no rebuilds.

## Adversarial Synthesis

Key risks: (1) the plan says the git providers "implement the same interface Linear/Notion do," but that interface is **pull-only** — the outbound mirror push is net-new and must coordinate with the Remote Sync Refactor rather than assume an existing push seam; (2) the inbound state signal depends on a per-plan `**Column:**` export line that **does not exist today**; (3) the periodic check-in story depends on the **startup reconciler**, since remote control does not auto-start. Mitigations: build outbound push standalone-but-coordinated, add the `**Column:**` export emission, make the reconciler a hard dependency, and strictly order §5's discard-before-merge after a completed single-flight export. The trust guard is sound but bounded by mirror push-access — document it.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — `exportStateToFile()`
- **Context:** already writes `kanban-board.md` / `kanban-state-*.md` (one-way export, verified).
- **Logic:** (a) resolve the export target to the control-plane root when `boardStateExport = control-plane` (Open Item 1); (b) emit a per-plan `**Column:** <name>` line (net-new) so §3's inbound signal has something to diff.
- **Edge Cases:** single-flight so a discard-before-merge can't race a partial write.

### `src/services/remote/GitStateProvider.ts` (new)
- **Context:** implements the pull-only `RemoteProvider` interface for `control-plane`/`wiki`.
- **Logic:** `fetchStateDeltas`/`fetchCommentDeltas` via `git fetch` + `git log <sha>..<head>` diffing `**Column:**` lines and appended comment blocks; SHA cursor (`remote.stateCursor.{control-plane|wiki}` / `remote.commentCursor.*`) — no de-dup cache needed. `postComment` via git commit. **Outbound push (net-new, not an interface method):** commit+push the exported mirror, fetch+reconcile first.
- **Edge Cases:** non-ff on push → reconcile; untrusted author → drop + surface.

### `src/services/RemoteControlService.ts`
- Register the git providers in the existing `_poll()` loop (started via manual `start()`; `pingFrequencySeconds` cadence). No auto-start here — that's the reconciler plan.

### `src/services/PlanAutoFetchService.ts`
- Extend `_getAllowedRoots()`/`_runCycleForRoot` to also target the control-plane root (§5), reusing the guard chain at `RemoteControlService`'s cadence; add the discard-of-`MIRROR_FILE_RE` step before `merge --ff-only`.

### `src/services/ControlPlaneMigrationService.ts`
- Opt-in `git init` + `git remote add` + generated `.gitignore` (managed-subdir exclusions from `WorkspaceIdentityService` mappings); suppress the line-574 warning for opted-in control planes.

### Settings + setup UI
- `boardStateExport: none | control-plane | wiki | notion | linear`, default `none`, no auto-detection.

## Verification Plan

### Automated Tests
> Suite run separately per session directive.
1. **Inbound state delta:** a commit changing a plan's `**Column:**` line → one local column move via the existing validation guard; SHA cursor advances once.
2. **Inbound comment:** appended block since `lastSeenSha` → local `## Inbound Comment` + column-agent dispatch; untrusted author → dropped + surfaced, no dispatch.
3. **Outbound push:** local card move → debounced commit+push; a concurrent inbound commit → fetch+reconcile, no non-ff failure.
4. **§5 discard-before-merge:** dirty mirror files + ff-merge touching them → discard (only `MIRROR_FILE_RE`) then merge succeeds; no non-mirror file discarded.
5. **Default off:** fresh workspace → `none`, zero git footprint, no push loop.
6. **Startup resume:** with the reconciler present, an offline period's remote column change reconciles on next startup poll.

## Dependencies

- `PlanAutoFetchService.ts` dirty-tree fix (commit `faf4d82`) — stays in place; this plan makes the underlying commit-to-`main` behavior it was patching around go away by default, rather than replacing the fix.
- `RemoteControlService.ts` polling loop and cursor-storage pattern; `KanbanProvider.ts:1632`/`:1638` comment-append and column-agent dispatch — reused, not rebuilt.
- `WorkspaceIdentityService` mappings — needed to generate the control-plane `.gitignore` exclusion list.
- `ControlPlaneMigrationService.ts` — needs the new opt-in git-init/remote/`.gitignore` setup flow.
- `PlanAutoFetchService._getAllowedRoots()` / `_runCycleForRoot` — needs to also accept the control-plane root as a target (§5), reusing its existing guard chain rather than a new implementation.

## Metadata

**Complexity:** 8
**Tags:** backend, infrastructure, api, reliability, feature
**Repo:** switchboard

## Recommendation

Complexity **8** (net-new outbound push half, a new git provider, a security-sensitive dispatch path, and multi-file coordination across `KanbanDatabase`, `RemoteControlService`, a new `GitStateProvider`, `ControlPlaneMigrationService`, and `PlanAutoFetchService`). → **Send to Lead Coder.**

## Review Findings

**Files changed (review fixes):** `src/services/remote/GitStateProvider.ts` (cumulative diff dedup + trust check), `src/services/ControlPlaneMigrationService.ts` (.gitignore catch-all fix + merge logic). The original implementation across 10 files was verified against the plan. **Fixes applied:** (1) `fetchStateDeltas`/`fetchCommentDeltas` were using per-commit cumulative diffs (`sinceCursor..sha`), causing intermediate column moves, spurious agent dispatches, and duplicate comment processing — replaced with a single `sinceCursor..remoteHead` diff plus all-authors trust check and deduplication; (2) `.gitignore` catch-all `/*/` was excluding `.switchboard/` (where mirror files live) — added `!.switchboard/` un-ignore; (3) `.gitignore` generation was overwriting existing user content — now merges with existing non-Switchboard lines. **Validation:** static verification only — TypeScript compilation skipped per session directive (typescript not installed in worktree). No confirm dialogs introduced. **Remaining risks:** the `_resolvePlanPathFromRemoteId` fallback uses `includes(remoteId)` which could match the wrong file if remoteId is a substring of another plan filename (NIT — direct match is tried first); the `getProvider` callback creates a new `GitStateProvider` per poll cycle, losing the trusted-emails cache (NIT — re-fetched each cycle).
