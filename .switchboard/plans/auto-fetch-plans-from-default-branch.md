# Auto-Fetch Plans from the Default Branch on Startup

## Goal

Make plans authored in remote agent sessions (e.g. Claude Code on the web) **appear on the local kanban board automatically**, without the user manually running `git pull` after every session.

### Background / current behavior

The local import pipeline is **already fully automatic**:

- `GlobalPlanWatcherService` + the periodic **Plan Scanner** (`switchboard.planScanner`, default 10s) watch `.switchboard/plans/` and import any new/changed plan file into the kanban DB as a `CREATED` card. (`src/services/GlobalPlanWatcherService.ts`, `src/services/PlanFileImporter.ts`.)
- So once a plan file is **physically present on disk** in `.switchboard/plans/`, it shows up on the board within ~10s with no manual step.

`.switchboard/plans/` is **git-tracked** by default — the `targetedGitignore` strategy explicitly keeps it under version control (`!.switchboard/plans/` in `src/services/WorkspaceExcludeService.ts:13`). Plans created in a web session are therefore committed and pushed to the remote, and ultimately land on the **default branch** once the session's PR is merged.

### Core problem / root cause

The gap is purely **getting the bytes from GitHub onto local disk**. After a session merges its plans into the default branch, those plan files do not exist locally until the user manually fetches/pulls. That manual `git pull` is the entire friction point. The import side needs no change — only a mechanism to bring the remote plan commits down safely and automatically.

### Decisions locked in with the user

- **Source:** the **default branch** (plans matter locally after the PR is merged into main). No per-feature-branch discovery.
- **Trust gate:** only auto-advance when **every** new commit is authored by the user's local `git config user.email`. (User confirmed their session commits are authored by their own email, not a bot identity, so this gate will actually match.)
- **Trigger:** on extension **startup** *and* on a **periodic** interval.

### Non-goals

- No full `git pull`/merge of arbitrary branches; no merging into a feature branch; no conflict resolution UI.
- No change to the existing plan-import / kanban pipeline.
- No per-feature-branch plan sourcing (explicitly deferred — see Alternatives).

## Design: constrained fast-forward of the default branch

Because plan files are **tracked**, we must update them through git (writing remote versions straight to disk would surface them as phantom "modified" files in Source Control). The mechanism is a **fast-forward-only** advance of the default branch, applied only when it is provably safe and trusted.

### Fetch cycle (`PlanAutoFetchService.runCycle()`)

For each workspace folder that contains a `.switchboard/` directory and is inside a git repo:

1. Resolve the git root (reuse the same root-resolution the worktree code uses — `effectiveGitRoot` in `KanbanProvider`).
2. Resolve the default branch:
   - `git symbolic-ref --quiet refs/remotes/origin/HEAD` → `origin/<default>`;
   - fall back to the `switchboard.planAutoFetch.defaultBranch` setting if set;
   - if still unknown, **skip** (do not guess `main`/`master`).
3. `git fetch <remote> <default>` (network-only; never touches the working tree). Timeout ~15s.
4. **Guard checks — skip the cycle (no merge) unless ALL hold:**
   - current branch (`git rev-parse --abbrev-ref HEAD`) **==** the default branch (not detached, not a feature branch);
   - working tree is **clean** (`git status --porcelain` is empty);
   - local is strictly behind remote and fast-forwardable: `git merge-base --is-ancestor HEAD <remote>/<default>` succeeds **and** `HEAD != <remote>/<default>`;
   - **every** new commit is trusted: every author email in `git log --format=%ae HEAD..<remote>/<default>` equals the local `git config user.email` (case-insensitive), or is in the optional `trustedAuthors` allowlist.
5. If all pass → `git merge --ff-only <remote>/<default>`. This cannot conflict (ff-only aborts otherwise) and lands the plan files as a clean commit. The existing watcher imports them within one scan interval.
6. If any guard fails → **skip silently** (log to the Switchboard output channel; optional unobtrusive status-bar tick). Never block the user, never show modal errors.

### Safety / edge cases

- No `origin` remote, detached HEAD, offline, or fetch failure → catch, log, skip. No error spam.
- **Network backoff:** on consecutive fetch failures, apply exponential backoff (cap, e.g., at the interval × 8) so a flaky network doesn't hammer git on every tick.
- **Overlap guard:** a single in-flight flag prevents a periodic cycle from overlapping with the startup cycle or a previous slow cycle.
- **Multi-root workspaces:** iterate over each workspace folder independently.
- This runs the extension's own git (consistent with existing worktree merges in `KanbanProvider.ts`); it is unrelated to the agent-facing `GIT_PROHIBITION_DIRECTIVE`, which only constrains *agents*.

## Implementation steps

1. **New service** `src/services/PlanAutoFetchService.ts`:
   - `initialize()`: run one cycle on activation, then `setInterval` at the configured cadence; subscribe to config changes to restart/stop the timer; expose `dispose()` to clear the interval.
   - `runCycle()` implementing the fetch + guard + ff-only logic above, using `execFile`/`execFileAsync` (same pattern as existing git calls — no new dependency).
   - In-flight flag + failure backoff state.
2. **Wire into activation** in `src/extension.ts` (alongside the `GlobalPlanWatcherService` init, ~lines 500–524); register the service for disposal.
3. **Settings schema** in `package.json` (`contributes.configuration`), following the `switchboard.<subsystem>.<setting>` convention:
   - `switchboard.planAutoFetch.enabled` (boolean) — see open question on default.
   - `switchboard.planAutoFetch.intervalSeconds` (int, default `300`, min ~60) — periodic cadence. Deliberately slower than the 10s local scanner to avoid frequent network fetches.
   - `switchboard.planAutoFetch.remote` (string, default `"origin"`).
   - `switchboard.planAutoFetch.defaultBranch` (string, default `""` → auto-detect via `origin/HEAD`).
   - `switchboard.planAutoFetch.trustedAuthors` (string[], default `[]` → falls back to local `user.email`).
   - Scope: `resource` (per workspace folder), matching other workspace-git settings.
4. **Logging:** reuse the existing Switchboard output channel; log each cycle's decision (fetched / skipped-reason / fast-forwarded N commits) for debuggability.
5. **No migration required.** This is net-new behavior with net-new settings — no released state changes shape, so per the migration policy it's a clean addition (a no-op for anyone who leaves it disabled).

## Testing

- Unit-test the guard logic with mocked git outputs: clean ff by trusted author → merges; mixed/foreign author → skips; dirty tree → skips; on a feature branch → skips; diverged (non-ff) → skips; detached HEAD → skips; no remote → skips.
- Manual: create a plan commit on the remote default branch authored by the user, confirm it auto-fast-forwards and the card appears; then make local edits / switch to a feature branch and confirm it cleanly no-ops.

## Open question for review

- **Default for `switchboard.planAutoFetch.enabled`.** Defaulting **ON** delivers the "just works" experience but introduces a startup `git fetch` for ~4,000 existing installs (a behavioral change, minor network cost; all mutations are still gated). Defaulting **OFF** is conservative and opt-in. Recommendation: **default ON** since every state-changing step is heavily guarded and it no-ops safely, but flagging it explicitly because it changes startup behavior for the existing install base.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, devops, reliability
