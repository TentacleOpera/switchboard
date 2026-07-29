# Replace the Plan Auto-Fetch Service with a Dedicated "Fetch Cloud Plans" Scheduler Source

## Goal

Retire the over-engineered plan auto-fetch feature (`PlanAutoFetchService` + the `project.html` "⚙ AutoFetch" modal + its `switchboard.planAutoFetch.*` settings) and replace it with a single new **Scheduler source** in the AUTOMATION tab that dispatches an agent, on a timer, to grab the latest plan files off new remote branches.

### Problem / root-cause analysis

The current auto-fetch is heavy machinery aimed slightly off its own target:

- **Its only real use case** is pulling in plans authored on a cloud VM (Claude VM / GPT VM) that pushes plan files up so the local `.switchboard/plans/` can absorb them.
- **But cloud VMs push those plans on _new branches_**, and `PlanAutoFetchService` only ever fast-forwards the **default branch**. Its whole cycle is: `git fetch origin <default-branch>` → guard (must be *on* the default branch, clean tree, fast-forwardable, every new commit from a *trusted author*) → `git merge --ff-only`. It structurally cannot pick up plans sitting on a feature branch — which is exactly where they are. So it carries a large maintenance surface (backoff maps, trusted-author allow-lists, control-plane git-root resolution, a modal, five VS Code settings, and a host service running on a 60s timer) while not actually serving the workflow it exists for.
- **The owner's real workflow is already agent-driven**: "I just ask an agent to grab the latest plans on new branches." That is precisely the Scheduler's native shape — *a prompt sent to an agent on a recurring timer*. The Scheduler mode even ships an empty sibling stub (`reconcile`, "Reconcile cloud work") demonstrating the intended pattern.

The fix is to delete the bespoke service and express the capability where it belongs: as one more Scheduler source, `fetch-plans`, that ships an authored preset prompt so it works with zero configuration — the automated version of the manual habit.

### Non-goals

- Not touching the Scheduler engine's core model (source → prompt, target → agent surface). The new source rides the existing tick/dispatch path.
- Not building a new host-side git service. The agent does the git work via the preset prompt, against whatever target the user selects (local terminal / Antigravity / cloud).
- Not repurposing the existing `reconcile` source — this is a **dedicated, separately-named** source (decision confirmed with owner).

## Metadata

**Complexity:** 5
**Tags:** refactor, feature, frontend, backend
**Project:** _(none — no project named and no PROJECT PIN directive; leave unassigned, reassign on the board if desired)_

## Part A — Remove the Plan Auto-Fetch feature

1. **Delete the service.** Remove `src/services/PlanAutoFetchService.ts` in full.
2. **`src/extension.ts`** — remove the import (line ~41), the `new PlanAutoFetchService(...)` construction + `initialize()` + `context.subscriptions.push(...)` block (lines ~728–733), and the `planningPanelProvider.setPlanAutoFetchService(...)` wiring (line ~1184).
3. **`src/services/PlanningPanelProvider.ts`** — remove the import (line ~42), the `_planAutoFetchService` field (line ~278), the `setPlanAutoFetchService` setter (lines ~319–320), the two `planAutoFetchState` status-push sites (the initial push ~653–658 and the `onDidChangeConfiguration` push ~686–690 gated on `switchboard.planAutoFetch`), and the two message handlers `setPlanAutoFetchEnabled` (~3767) and `planAutoFetchRunNow` (~3778–3792).
4. **`src/webview/project.html`** — remove the "Auto-Fetch Plans" modal (`#autofetch-modal`, lines ~1534–1563) and the `#kanban-meta-autofetch-btn` "⚙ AutoFetch" button (line ~2030).
5. **`src/webview/project.js`** — remove the `planAutoFetchState` message handler (lines ~418–441), the `#kanban-meta-autofetch-btn` open-modal wiring, the `#btn-close-autofetch-modal` handler, the `#kanban-auto-fetch-enabled` change → `setPlanAutoFetchEnabled` post, and the `#btn-plan-auto-fetch-now` → `planAutoFetchRunNow` post. Grep `project.js` for `autoFetch`/`auto-fetch`/`AutoFetch` to catch every reference.
6. **`package.json`** — remove the five `switchboard.planAutoFetch.*` configuration contributions (`enabled`, `intervalSeconds`, `remote`, `defaultBranch`, `trustedAuthors`, lines ~551–580).

### Migration note (published extension, ~4,000 installs)

- The `switchboard.planAutoFetch.*` keys shipped in released versions, but they are **VS Code settings, not user data**. Removing the contribution points only stops them being surfaced/validated; any value already in a user's `settings.json` is silently ignored by VS Code — nothing is destroyed. **No migration or `*.migrated.bak` archival is required**, and removing them is a safe clean break. (Call this out explicitly in the PR so a reviewer doesn't flag it against the migrations rule.)
- No plan files are affected — this removes a *fetch mechanism*, never any `.switchboard/plans/` content.
- Any user who had auto-fetch enabled loses a background behavior; the new Scheduler source is the documented replacement. Note this in the changelog.

## Part B — Add the `fetch-plans` Scheduler source

1. **`src/services/GlobalIntegrationConfigService.ts`** — extend the `ScheduledJob.source` union (line ~96) to include `'fetch-plans'`:
   `source: 'comms' | 'board-batch' | 'reconcile' | 'custom' | 'fetch-plans';`
   No `schemaVersion` bump — this is an additive, backward-compatible enum widening (existing persisted jobs never carry the value; old code never emits it). Add a one-line doc comment noting the new source and its `sourceConfig` shape (`{ remote?: string; branchGlob?: string }`).
2. **`src/webview/kanban.html` — source dropdown** (lines ~10142–10145): add `{ value: 'fetch-plans', label: 'Fetch cloud plans' }`. Suggested ordering: `board-batch → fetch-plans → reconcile → custom → comms`.
3. **`src/webview/kanban.html` — per-source config UI**: mirror the board-batch config row (~10184–10214) with a `fetch-plans` config row exposing two optional inputs, `data-field="fetchRemote"` (placeholder `origin`) and `data-field="fetchBranchGlob"` (placeholder `*`, e.g. `claude/*` to scope to VM branches). Show it only when `source === 'fetch-plans'` by extending `refreshSubForms()` (~10285) alongside the existing `isBatch` toggle.
4. **`src/webview/kanban.html` — `collectJobFromRow`** (~10325–10335): when `source === 'fetch-plans'`, pack `sourceConfig.remote` and `sourceConfig.branchGlob` from those inputs (default `remote: 'origin'`, `branchGlob: '*'`).
5. **`src/services/TaskViewerProvider.ts` — `_schedulerTick`** (~22278, the non-comms branch): add a `job.source === 'fetch-plans'` case that builds an **authored preset prompt** (new private helper `_buildFetchPlansPrompt(job)`, modeled on `_buildMcpMonitorPrompt`) when `promptOverride` is empty, and still honors a non-empty `promptOverride`. This keeps the source zero-config while preserving the existing override-precedence contract.
6. **Preset prompt content** (`_buildFetchPlansPrompt`): instruct the agent to, from the workspace root, `git fetch <remote>` (default `origin`), list remote branches matching `<branchGlob>` that were updated recently, and for each, copy the newest `.switchboard/plans/*.md` files that don't already exist locally into the working tree's `.switchboard/plans/` (e.g. via `git show <remote>/<branch>:<path>` or `git checkout <remote>/<branch> -- .switchboard/plans/`), without switching the local branch and without overwriting locally-modified plans. End by writing a one-line summary to `.switchboard/scheduler-<jobId>-latest.md` so the existing scheduler-output capture (`_startSchedulerOutputCapture`) surfaces results in the panel like every other source.
7. **Mode description** (`kanban.html` ~8932, the `scheduler` help text): add "fetch cloud plans" to the list of sources so the dropdown help stays accurate.

## Verification Plan

Because `dist/` is not used in testing (per repo rules — test via the installed VSIX, `src/` is source of truth), verify against `src/`:

**Part A (removal) — confirm nothing dangles:**
- `grep -rin "planAutoFetch\|PlanAutoFetch\|auto-fetch\|autofetch" src/ package.json` returns **no** matches (case-insensitive) except, if desired, a changelog entry.
- `src/services/PlanAutoFetchService.ts` no longer exists.
- TypeScript compiles clean: `npm run compile` succeeds with no unresolved-symbol errors from the removed import/field/setter.
- Build a VSIX, install it, open a Switchboard workspace: the project view shows **no** "⚙ AutoFetch" button and the `#autofetch-modal` is gone; VS Code Settings search for "Plan Auto Fetch" returns nothing.

**Part B (new source) — confirm it works end to end:**
- In the AUTOMATION tab, select **Scheduler**, add a job, and confirm **"Fetch cloud plans"** appears in the source dropdown; selecting it reveals the remote / branch-glob config row and hides the board-batch row.
- Save the job, reload the panel, and confirm the job round-trips (source, `sourceConfig.remote`, `sourceConfig.branchGlob`, interval all persist via `getSchedulerConfig`).
- With `target = local-terminal` and a running job terminal, let a tick fire (or shorten the interval): confirm the agent receives the preset prompt with **no** `promptOverride` set, that it fetches and copies a plan file authored on a matching remote branch into local `.switchboard/plans/`, and that `.switchboard/scheduler-<jobId>-latest.md` is written and surfaced in the panel.
- Set a non-empty `PROMPT` override and confirm it takes precedence over the preset (override contract preserved).
- With `target = antigravity` / `cloud`, confirm **COPY PROMPT** yields the preset text.

**Regression guard:**
- Confirm the existing `comms`, `board-batch`, `reconcile`, and `custom` sources are unaffected (dropdown, sub-forms, tick dispatch, and the `autoban-state-regression` test still pass).
- Confirm no `confirm()` / `window.confirm()` gate is introduced anywhere in the removed/added webview paths (repo hard rule).
