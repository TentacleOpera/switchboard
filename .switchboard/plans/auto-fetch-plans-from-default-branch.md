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
- **Control surface:** a toggle lives directly in the **KANBAN PLANS tab** of the board (`project.html`), not just in VS Code settings — backed by the same setting key so the two stay in sync.

### Non-goals

- No full `git pull`/merge of arbitrary branches; no merging into a feature branch; no conflict resolution UI.
- No change to the existing plan-import / kanban pipeline.
- No per-feature-branch plan sourcing (explicitly deferred — see Alternatives).

## Design: constrained fast-forward of the default branch

Because plan files are **tracked**, we must update them through git (writing remote versions straight to disk would surface them as phantom "modified" files in Source Control). The mechanism is a **fast-forward-only** advance of the default branch, applied only when it is provably safe and trusted.

### Fetch cycle (`PlanAutoFetchService.runCycle()`)

For each workspace folder that contains a `.switchboard/` directory and is inside a git repo:

1. Resolve the git root (mirror the root-resolution pattern used by the worktree code — `effectiveGitRoot` is a *local variable* in `KanbanProvider._createSafetyWorktree` at `src/services/KanbanProvider.ts:8363-8368`, not a reusable method; replicate the control-plane-vs-repo-root resolution logic rather than calling it).
2. Resolve the default branch:
   - `git symbolic-ref --quiet refs/remotes/origin/HEAD` → returns `refs/remotes/origin/<default>`; strip the prefix to get `<default>`.
   - fall back to the `switchboard.planAutoFetch.defaultBranch` setting if set;
   - if still unknown, **skip** (do not guess `main`/`master`).
3. `git fetch <remote> <default>` (network-only; never touches the working tree). Timeout ~15s. This updates `refs/remotes/<remote>/<default>`.
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
- **Multi-root workspaces:** iterate over each workspace folder independently (reuse the `_getAllowedRoots()` pattern from `PlanningPanelProvider` at `src/services/PlanningPanelProvider.ts:1795`, or the workspace-folder fallback in `GlobalPlanWatcherService._getAllMappedFolders` at `src/services/GlobalPlanWatcherService.ts:270`).
- This runs the extension's own git (consistent with existing worktree merges in `KanbanProvider.ts:7905-7906`, which uses `promisify(cp.execFile)` + `execFileAsync('git', [...], { cwd, timeout })`); it is unrelated to the agent-facing `GIT_PROHIBITION_DIRECTIVE`, which only constrains *agents*.
- **Trust-gate limitation (Clarification, not new requirement):** git author emails are not cryptographically verified (unless commits are GPG-signed and the gate is extended to verify signatures). The gate matches "commits my sessions authored" by email convention; it is a safety rail against accidentally fast-forwarding a collaborator's or bot's commits, not a security boundary against a determined spoofer. This matches the user-confirmed decision above and needs no change.

## UI control (KANBAN PLANS tab)

The feature is toggled from the board itself, following the existing webview-toggle pattern (cf. the cyber-animation / colour-icons switches: webview checkbox → `postMessage` → provider `config.update()` → state hydrated back on load).

> **Correction of original plan:** the board `project.html` is backed by **`PlanningPanelProvider`** (`src/services/PlanningPanelProvider.ts`), **not** `KanbanProvider`. Verified: `fetchKanbanPlans` is handled at `PlanningPanelProvider.ts:2976`, and cyber-animation state is hydrated to `_projectPanel` at `PlanningPanelProvider.ts:404-409`. All new message-handler cases and webview-ready hydration therefore go in `PlanningPanelProvider`, not `KanbanProvider`.

- **Location:** a small control block in the **KANBAN PLANS** tab of `src/webview/project.html` (the first tab, `data-tab="kanban"` at `project.html:1415`), inside the existing `kanban-controls-strip` (`project.html:1425`) or immediately below it, near the existing toolbar controls.
- **Elements:**
  - An **"Auto-fetch plans from `<default>`"** checkbox bound to `switchboard.planAutoFetch.enabled`.
  - A **"Fetch now"** button to trigger a cycle on demand.
  - A **status line** showing the last cycle's outcome — e.g. *"Fast-forwarded 2 plans"*, *"Up to date"*, or a skip reason (*"on a feature branch"*, *"working tree not clean"*, *"untrusted author — skipped"*). This is important precisely because the feature silently no-ops; the status line makes the reason visible instead of leaving the user guessing why a plan didn't appear.
- **Wiring:**
  - `project.js`: change listener on the checkbox → `vscode.postMessage({ type: 'setPlanAutoFetchEnabled', enabled })`; "Fetch now" → `{ type: 'planAutoFetchRunNow' }`; handle inbound `planAutoFetchState` messages to hydrate the checkbox + status line (add a new `case 'planAutoFetchState':` alongside the existing `case 'cyberAnimationSetting':` at `project.js:392`).
  - **`PlanningPanelProvider`** message handler (the provider backing `project.html`): add cases `setPlanAutoFetchEnabled` (→ `config.update('planAutoFetch.enabled', …, vscode.ConfigurationTarget.Workspace)`, then start/stop the service timer) and `planAutoFetchRunNow` (→ `PlanAutoFetchService.runCycle()`), then post `planAutoFetchState` back. Add these cases in the `_handleMessage` switch near `PlanningPanelProvider.ts:2972-2975` (the `createPlan` / `fetchKanbanPlans` cluster).
  - On project-panel webview-ready (where the board already hydrates its initial state at `PlanningPanelProvider.ts:404-409`), post the current `enabled` value + last-cycle status so the toggle renders correctly.
  - `PlanAutoFetchService` records the last cycle's result (outcome + reason + timestamp) so both the periodic run and "Fetch now" can report it to the webview. `PlanningPanelProvider` reads this via a method on the service (e.g. `getStatus()`).
- **Sync with settings:** because the toggle and the VS Code setting are the *same* key, flipping either updates the other (the webview re-hydrates from config on focus/refresh). No duplicate state.

## Implementation steps

1. **New service** `src/services/PlanAutoFetchService.ts`:
   - `initialize()`: run one cycle on activation, then `setInterval` at the configured cadence; subscribe to config changes to restart/stop the timer; expose `dispose()` to clear the interval.
   - `runCycle()` implementing the fetch + guard + ff-only logic above, using `execFile`/`execFileAsync` (same pattern as existing git calls — `promisify(cp.execFile)` then `execFileAsync('git', [...], { cwd, timeout })`, cf. `KanbanProvider.ts:7905-7906`; no new dependency).
   - In-flight flag + failure backoff state.
   - `getStatus(): { enabled, lastOutcome, lastReason, lastTimestamp }` for webview hydration.
2. **Wire into activation** in `src/extension.ts` (alongside the `GlobalPlanWatcherService` init at `extension.ts:500-505`); construct `PlanAutoFetchService`, call `initialize()`, register for disposal on `context.subscriptions`. Pass it to `PlanningPanelProvider` (or expose via a getter) so the board's message handler can call `runCycle()` / `getStatus()`.
3. **Settings schema** in `package.json` (`contributes.configuration`), following the `switchboard.<subsystem>.<setting>` convention (cf. `switchboard.planWatcher.*` at `package.json:507-519`):
   - `switchboard.planAutoFetch.enabled` (boolean, default `false` — see open question) — opt-in.
   - `switchboard.planAutoFetch.intervalSeconds` (int, default `300`, min ~60) — periodic cadence. Deliberately slower than the 10s local scanner to avoid frequent network fetches.
   - `switchboard.planAutoFetch.remote` (string, default `"origin"`).
   - `switchboard.planAutoFetch.defaultBranch` (string, default `""` → auto-detect via `origin/HEAD`).
   - `switchboard.planAutoFetch.trustedAuthors` (string[], default `[]` → falls back to local `user.email`).
   - Scope: `resource` (per workspace folder), matching other workspace-git settings.
4. **Logging:** reuse the existing Switchboard output channel; log each cycle's decision (fetched / skipped-reason / fast-forwarded N commits) for debuggability.
5. **Board UI control** in the KANBAN PLANS tab: add the checkbox + "Fetch now" button + status line to `src/webview/project.html` (inside/near `kanban-controls-strip` at `project.html:1425-1446`); wire `project.js` listeners/hydration (new `case 'planAutoFetchState':` near `project.js:392`); add the `setPlanAutoFetchEnabled` / `planAutoFetchRunNow` cases to the **`PlanningPanelProvider`** message handler (near `PlanningPanelProvider.ts:2972`) and hydrate `planAutoFetchState` on project-panel webview-ready (near `PlanningPanelProvider.ts:404-409`). (See **UI control** section.)
6. **No migration required.** This is net-new behavior with net-new settings — no released state changes shape, so per the migration policy it's a clean addition (a no-op for anyone who leaves it disabled).

## Testing

- Unit-test the guard logic with mocked git outputs: clean ff by trusted author → merges; mixed/foreign author → skips; dirty tree → skips; on a feature branch → skips; diverged (non-ff) → skips; detached HEAD → skips; no remote → skips.
- Manual: create a plan commit on the remote default branch authored by the user, confirm it auto-fast-forwards and the card appears; then make local edits / switch to a feature branch and confirm it cleanly no-ops.

## Open question for review

- **Default for `switchboard.planAutoFetch.enabled`.** Defaulting **ON** delivers the "just works" experience but introduces a startup `git fetch` for ~4,000 existing installs (a behavioral change, minor network cost; all mutations are still gated). Defaulting **OFF** is conservative and opt-in. Now that there's a discoverable toggle **in the KANBAN PLANS tab**, the cost of defaulting OFF drops sharply — users flip it on right where they'd look. Updated recommendation: **default OFF**, with the in-board toggle as the one-click opt-in, so the existing install base sees no startup-behavior change.

## Metadata

**Complexity:** 5
**Tags:** feature, backend, devops, reliability

## User Review Required

- [ ] Confirm the **default for `switchboard.planAutoFetch.enabled`** (recommendation: `false` / opt-in). This is a behavioral decision affecting ~4,000 existing installs.
- [ ] Confirm the **trust-gate policy** is acceptable as written (email-match only, no GPG signature verification). The gate is a safety rail, not a security boundary.
- [ ] Confirm placement of the UI control block (inside `kanban-controls-strip` vs. a new row below it) matches the desired board layout.

## Complexity Audit

### Routine
- Adding the `package.json` configuration schema (5 settings) — mirrors the existing `switchboard.planWatcher.*` block.
- New service file with standard `execFileAsync('git', …)` plumbing — same pattern as `KanbanProvider` worktree merges.
- Webview checkbox + button + status line HTML/CSS — follows the existing `kanban-controls-strip` layout.
- `project.js` message listener cases — mirrors the existing `cyberAnimationSetting` handler.
- Activation wiring in `extension.ts` — one construction + `initialize()` + `subscriptions.push`.

### Complex / Risky
- The **fast-forward merge of the user's working repo** is the one moderate risk: a wrong guard could move the user's `HEAD` or clobber uncommitted work. Mitigated by the four-guard gate (correct branch, clean tree, strictly-behind + ff-only, trusted authors) and `--ff-only` aborting on any non-fast-forward. Well-scoped but deserves careful unit testing of every guard branch.
- **Multi-root / control-plane root resolution**: mirroring `effectiveGitRoot` correctly across control-plane vs. single-repo modes so the service runs git in the right directory. Reuses an existing pattern but is easy to get wrong for control-plane workspaces.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - User runs a manual `git pull`/`git merge` while a cycle is mid-flight → the in-flight flag prevents overlap from the *service* side, but an external git operation could move `HEAD` between the guard check and the `--ff-only` merge. Mitigation: `--ff-only` refuses if the working tree would be overwritten by tracked changes, and refuses non-fast-forwards; an external advance of `HEAD` simply makes the merge a no-op (already up to date) or aborts safely. Re-checking `HEAD` immediately before the merge is an optional hardening.
  - Plan watcher fires on files that the ff-merge just wrote → desired behavior (import the newly-arrived plans). No conflict; the watcher's 300ms debounce coalesces any burst.
- **Security:**
  - Author-email trust gate is not cryptographically enforced (see Clarification in Design). Acceptable per user decision; not a defense against spoofed author identity.
  - No secrets are read or logged; `git config user.email` is the only identity read.
- **Side Effects:**
  - `git fetch` writes to `.git/refs/remotes/<remote>/<default>` and `.git/FETCH_HEAD` — benign, standard git behavior.
  - `git merge --ff-only` advances `HEAD` and updates the working tree to match — the intended effect; only plan files (and any other tracked files in the merged commits) change on disk.
  - No writes to the kanban DB by the service itself; the existing watcher handles import.
- **Dependencies & Conflicts:**
  - No new npm dependencies (`cp.execFile` / `promisify` already used throughout).
  - No conflict with `GIT_PROHIBITION_DIRECTIVE` (that constrains agents, not the extension's own git calls).
  - No conflict with `GlobalPlanWatcherService` — complementary (one fetches bytes, the other imports files).
  - Settings namespace `switchboard.planAutoFetch.*` is new and unused.

## Dependencies

- None. This plan is self-contained; no other plan must complete first.

## Adversarial Synthesis

Key risks: (1) the ff-merge touches the user's live working repo — a guard bug could move `HEAD` or stomp uncommitted work; (2) control-plane vs. single-repo root resolution is easy to miswire for multi-root setups; (3) the email trust gate is convention-only, not cryptographic. Mitigations: the four-guard gate + `--ff-only` makes the merge provably safe (abort-on-any-anomaly), root resolution reuses the existing `effectiveGitRoot` pattern, and the trust gate matches the user-confirmed "my session commits" semantics (a safety rail, not a security claim).

## Proposed Changes

### `src/services/PlanAutoFetchService.ts` (NEW)
- **Context:** New service implementing the constrained fast-forward fetch cycle. No existing file to modify.
- **Logic:**
  - `initialize()`: read `switchboard.planAutoFetch.*` config; if `enabled`, run one startup cycle then `setInterval(runCycle, intervalSeconds * 1000)`; subscribe to `vscode.workspace.onDidChangeConfiguration` to restart/stop the timer on config change.
  - `runCycle()`: set in-flight flag; for each allowed workspace root with a `.switchboard/` dir inside a git repo: resolve git root (mirror `effectiveGitRoot` pattern), resolve default branch (`git symbolic-ref --quiet refs/remotes/<remote>/HEAD` → strip prefix; fallback to setting; else skip), `git fetch <remote> <default>` (timeout 15s; on failure increment backoff counter and skip), run the four guard checks (`git rev-parse --abbrev-ref HEAD`, `git status --porcelain`, `git merge-base --is-ancestor HEAD <remote>/<default>` + `HEAD != <remote>/<default>`, `git log --format=%ae HEAD..<remote>/<default>` filtered by `user.email`/`trustedAuthors`); if all pass → `git merge --ff-only <remote>/<default>`; record outcome + reason + timestamp.
  - `getStatus()`: return `{ enabled, lastOutcome, lastReason, lastTimestamp }` for webview hydration.
  - `dispose()`: clear interval + config listener.
- **Implementation:** `promisify(cp.execFile)` for git calls (cf. `KanbanProvider.ts:7905`); reuse the shared Switchboard output channel for logging.
- **Edge Cases:** offline/no-remote/detached-HEAD → catch + log + skip; consecutive fetch failures → exponential backoff capped at `interval × 8`; in-flight flag prevents overlapping cycles.

### `src/extension.ts` (activation, ~line 500-524)
- **Context:** Construct and start the service alongside `GlobalPlanWatcherService`.
- **Logic:** After `globalPlanWatcher.initialize()` (line 504), construct `PlanAutoFetchService(outputChannel)`, call `initialize()`, push to `context.subscriptions`. Hand the service instance to `PlanningPanelProvider` (via constructor arg or setter) so the board message handler can call `runCycle()` / `getStatus()`.
- **Edge Cases:** Service must be constructed even when `enabled=false` so the board toggle can start it on demand; `initialize()` handles the disabled case by not starting the timer.

### `package.json` (`contributes.configuration`, near line 507)
- **Context:** Add the `switchboard.planAutoFetch.*` settings block next to `switchboard.planWatcher.*`.
- **Logic:** Five settings as listed in Implementation step 3; scope `resource`; defaults per the open-question recommendation (`enabled: false`).
- **Edge Cases:** `defaultBranch: ""` must be documented as "auto-detect via `origin/HEAD`".

### `src/webview/project.html` (KANBAN PLANS tab, ~line 1425-1446)
- **Context:** Add the auto-fetch control block to the `kanban-controls-strip` (or a new row directly below it).
- **Logic:** Checkbox `id="kanban-auto-fetch-enabled"` with label "Auto-fetch plans from `<default>`"; button `id="btn-plan-auto-fetch-now"` "Fetch now"; status span `id="kanban-auto-fetch-status"`.
- **Edge Cases:** The `<default>` placeholder in the label must be hydrated from `planAutoFetchState` (the resolved branch name, or "default branch" if unknown).

### `src/webview/project.js` (message handler, ~line 384-396)
- **Context:** Wire outbound toggle/button clicks and inbound state hydration.
- **Logic:** Add `case 'planAutoFetchState':` (hydrate checkbox checked-state, status-line text, label branch name); add change listeners on the checkbox → `vscode.postMessage({ type: 'setPlanAutoFetchEnabled', enabled })` and on "Fetch now" → `vscode.postMessage({ type: 'planAutoFetchRunNow' })`.
- **Edge Cases:** Status line must render skip reasons verbatim so the user sees *why* a fetch was skipped.

### `src/services/PlanningPanelProvider.ts` (message handler ~line 2972 + webview-ready ~line 404-409)
- **Context:** Handle the two new outbound messages and hydrate state on board load. (Correction: this is the provider backing `project.html`, not `KanbanProvider`.)
- **Logic:** Add `case 'setPlanAutoFetchEnabled':` → `vscode.workspace.getConfiguration('switchboard.planAutoFetch').update('enabled', msg.enabled, vscode.ConfigurationTarget.Workspace)` then start/stop the service timer via the injected `PlanAutoFetchService`; add `case 'planAutoFetchRunNow':` → `await this._planAutoFetchService.runCycle()` then post `planAutoFetchState` back; on project-panel webview-ready (near line 404-409) post `planAutoFetchState` from `service.getStatus()`.
- **Edge Cases:** `config.update` is async and can reject (e.g. workspace-locked settings) — catch + log, do not throw to the webview.

## Verification Plan

### Automated Tests
- **Skipped per session directive** — the unit tests described in the **Testing** section (mocked git outputs for each guard branch) will be run separately by the user.
- Recommended unit-test matrix for when tests are run: clean ff by trusted author → merges; mixed/foreign author → skips; dirty tree → skips; on a feature branch → skips; diverged (non-ff) → skips; detached HEAD → skips; no remote → skips; fetch timeout/network failure → skips + backoff increments; `enabled=false` → no cycle runs.

### Manual Verification (no compilation/test steps per session directive)
- Confirm `package.json` parses (settings schema valid) by inspection.
- Confirm the new service file imports only existing modules (`cp`, `vscode`, the output channel) — no new dependencies.
- Confirm the `PlanningPanelProvider` message-handler cases and webview-ready hydration compile against the existing `_handleMessage` switch and `_projectPanel` field shapes.
- End-to-end manual check (user-run, after VSIX install): create a plan commit on the remote default branch authored by the user's email, confirm it auto-fast-forwards and the card appears on the board; toggle the board checkbox off → confirm no further fetches; switch to a feature branch → confirm "Fetch now" reports the skip reason in the status line.

### Recommendation
Complexity 5 → **Send to Coder**.
