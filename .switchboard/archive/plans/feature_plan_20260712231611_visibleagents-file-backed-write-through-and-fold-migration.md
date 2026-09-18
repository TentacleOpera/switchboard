---
description: "Close the read/write asymmetry that lets the machine-global ~/.switchboard config silently mask agent-visibility toggles. getVisibleAgents/getCustomAgents read the global file FIRST, but the board/setup toggle paths write only globalState + state.json — so once the file holds a visibleAgents key (any user who has ever started/stopped the MCP monitor, whose setVisibleAgent writes the file), unticking coder/lead/etc. is ignored and the column never hides. startupCommands already does this correctly (file-first read + setAgentStartupCommands write-through); mirror that for visibleAgents and its twin customAgents, plus a one-time fold migration that merges existing globalState/state.json toggles into the file WITHOUT clobbering file-only keys (mcp_monitor) — the ~4,000-install data-safety trap."
---

# Fix: visibleAgents (and customAgents) Must Be File-Backed on Write, Not Just Read — Close the Masking Asymmetry Safely

## Goal

A user who unticks an agent must see its built-in kanban column hide, on every
install. Today that works only for users whose machine-global `~/.switchboard`
config has never had a `visibleAgents` key written to it. The moment the file
holds that key, the board reads the file and ignores the fresh toggle.

### Problem / root cause (verified in source, 2026-07-12)

There is a **read/write asymmetry** across the three machine-global agent-config
keys. All three are read **file-first**:

- `getVisibleAgents` (`TaskViewerProvider.ts:4589`) → `GlobalIntegrationConfigService.getAgentConfig('visibleAgents')` first (`:4610`), then `globalState` (`:4618`), then `state.json` (`:4626`). When the file value is defined it returns `{ ...defaults, ...fileValue }` and **never consults globalState/state.json**.
- `getCustomAgents` (`:4640`) → `getAgentConfig('customAgents')` first (`:4642`).
- `getStartupCommands` (`:4490`) → `getAgentStartupCommands()` (file) first (`:4496`).

But only **one** of the three writes the file on save:

- `startupCommands` — the setup save calls `GlobalIntegrationConfigService.setAgentStartupCommands(data.commands)` (`:9099`) with the full map. **Consistent.** This is the reference implementation.
- `visibleAgents` — the board toggle (`handleToggleKanbanColumnVisibility:9251`), the setup-save patch (`:9046`), reset/delete handlers, and `handleSaveCustomAgent` all write via `updateState` → `globalState` mirror (`:2626-2630`) + `state.json` (`:2635`). **None writes the file.** The *only* file write for `visibleAgents` is `setVisibleAgent('mcp_monitor', …)` (`:22238`, called at `:17238/:17308/:22100/:22224`) — MCP-monitor start/stop.
- `customAgents` — same shape: `handleSaveCustomAgent` (`:9270`) and the setup save write `updateState` only; the sole file write is the one-time migration (`:1047`). **No save-time write-through.**

**The masking bug, concretely:** the first time a user starts/stops the MCP
monitor, `setVisibleAgent` seeds the file with `{ mcp_monitor: false }` (a
non-empty `visibleAgents` value). From then on every `getVisibleAgents` returns
`{ ...defaults, mcp_monitor:false }` — so a subsequent "untick coder" (which lands
in globalState/state.json only) is **silently dropped**; `CODER CODED` stays
visible. Same failure for `customAgents` on any install whose file holds that key
(migration-seeded from a populated DB config). `startupCommands` is immune only
because it writes the file on every save.

### Why this surfaced now

The just-shipped "one uniform visibility rule" plan
(`feature_plan_20260711131500_fix-intern-column-hide-and-created-bucket-fallback.md`)
made **every** built-in role column follow its tick (previously only the four
`hideWhenNoAgent` columns did, and those defaulted to intern-visible /
researcher-tester-ticketupdater-hidden, so the masking rarely showed). Now
unticking lead/coder/planner/reviewer is supposed to hide their columns — and for
MCP-monitor users it doesn't. That review also fixed the *refresh* half (a
`_markConfigDirty()` bump in `sendVisibleAgents` so the toggle-triggered refresh
isn't dropped as a no-op); this plan fixes the *storage* half so the refresh reads
the value the user actually set. Both are required for the toggle to work
end-to-end on every install.

### The fix, in one line

Make `visibleAgents` and `customAgents` writes go **through the machine-global
file** (merge-preserving, like a generalized `setVisibleAgent`), exactly as
`startupCommands` already does — and run a one-time **fold** migration that merges
each install's existing globalState/state.json toggles into the file without
clobbering file-only keys (`mcp_monitor` and the other grid-only agents).

## Metadata
- **Tags:** bugfix, backend, migration, config
- **Complexity:** 7

> **Complexity 7 → Lead Coder.** The code change is small and has a working
> reference (`startupCommands`). The risk is the **fold migration on ~4,000
> installs**: a naive "write the full state.visibleAgents map to the file" blanks
> the file-only `mcp_monitor`/grid keys, and a naive "skip if file already
> populated" seed (the existing v2 behavior) leaves real toggles unmerged for
> exactly the MCP-monitor users who trip the bug. Getting the merge precedence
> and the wipe-guard interaction right — where wrong means silently dropping a
> user's agent configuration — is a data-safety task, not plumbing.

## User Review Required
- **None.** The behavior is a bug fix (toggles must persist and be read back); the
  merge precedence, migration guard, and scope (include `customAgents`) are decided
  below. No product decision is deferred.

## Scope

### ✅ IN SCOPE
1. **Write-through for `visibleAgents`.** Every save path that mutates
   `state.visibleAgents` must also persist the merged full map to the machine-global
   file, preserving keys it does not own. Route through a single helper (generalize
   `setVisibleAgent` into a `mergeVisibleAgentsToGlobalFile(patch)` that does
   read-file → `{ ...file, ...patch }` → `setAgentConfig('visibleAgents', …)`), and
   call it from:
   - `handleToggleKanbanColumnVisibility` (`:9251`) — the structure-tab SHOW/HIDE.
   - the setup-save `visibleAgentsPatch` branch (`:9046-9051`).
   - `handleResetAgents` / built-in-role clear (`:9196` area) and the custom-agent
     delete path that prunes `visibleAgents` (`:9312` area) — deletions must reach
     the file too (subject to the wipe guard).
   - **Clarification — empty-remainder prune guard:** when the delete path prunes
     custom-role keys from `visibleAgents` and the remainder is `{}`, the wipe guard
     (`GICS:200-207`) *refuses* the write and the file keeps the stale custom-role keys
     → ghost columns persist. The helper must detect an empty remainder and
     skip-and-warn (do NOT attempt a blanking write — it will be silently dropped).
     In practice built-in keys (`lead`, `coder`, …) are always present so an empty
     remainder only arises from a prune-logic bug; the guard makes that bug visible
     instead of silent.
   - keep `setVisibleAgent('mcp_monitor', …)` as-is — it already merges to the file
     per-key; the new helper is the same operation for built-in/custom role keys.

   **Merge direction is load-bearing.** The helper writes `{ ...currentFile, ...patch }`
   — the patch (the just-toggled built-in/custom roles) wins for its keys; every
   other key already in the file (notably `mcp_monitor`, `claude_artifacts`,
   `phone_a_friend`, `project_manager` and any custom-agent flags set elsewhere) is
   preserved. Never write `state.visibleAgents` wholesale to the file (it lacks the
   file-only keys and would blank them).

2. **Write-through for `customAgents`.** Confirm the asymmetry (grep: the only
   `setAgentConfig('customAgents', …)` is the migration at `:1047`; `handleSaveCustomAgent`
   `:9270` and the setup save write `updateState` only) and apply the same
   write-through: after `updateState` sets `state.customAgents`, write the full
   `customAgents` array to the file via `setAgentConfig('customAgents', state.customAgents)`.
   `customAgents` is a full-list replace (not a per-key merge) and the wipe guard
   already exempts it (`GlobalIntegrationConfigService.ts:198-199` — it may legitimately
   go to `[]`), so a straight write matches its semantics. Save, delete-one, and
   delete-all custom-agent paths all included.

   **Clarification — known trade-off (customAgents fold un-delete):** the fold's
   "most-populated wins / never shrink a populated file list" heuristic can resurrect
   custom agents a user *deleted* in a workspace (a shorter, more-correct legacy list
   loses to a longer stale file list). This is a defensible one-time trade (data-loss >
   un-delete), but it is a correctness inversion the coder must know: after the fold,
   the user may need to re-delete resurrected agents. The write-through keeps the file
   in sync from that point on, so the inversion is one-shot, not ongoing.

3. **One-time fold migration (`switchboard.agents.fileFold.v1`).** A new guarded
   pass, distinct from the existing `globalFileSeed.v2` seed
   (`_migrateStartupCommandsToGlobalFile:995`). For `visibleAgents` and
   `customAgents` (startupCommands is already consistent — leave it), compute the
   authoritative pre-fix value from the legacy stores and **merge it into** the file
   rather than skipping when the file is non-empty:
   - `visibleAgents`: `merged = { ...fileValue, ...legacyToggles }` where
     `legacyToggles` is the full toggle map from `globalState('switchboard.agents.visibleAgents')`
     (falling back to the active-workspace `state.json` / per-workspace DB config
     `agents.visibleAgents` when globalState is empty). `fileValue` as the base
     preserves `mcp_monitor`; `legacyToggles` overlays the real built-in/custom
     toggles (fresh > any stale partial-seed value in the file). Write via
     `setAgentConfig` (the wipe guard blocks an empty overlay from blanking).
   - `customAgents`: the legacy source (globalState/state.json) is authoritative for
     the user's real list; write it to the file if the file's list is empty or a
     stale partial. Because a full-list replace can't "merge", prefer the
     **most-populated** legacy source (reuse the existing `_agentConfigScore`
     tie-break at `:1046`), and never overwrite a populated file list with a shorter one.
   - Guard once per IDE via `globalState('switchboard.agents.fileFold.v1')`;
     idempotent; a crash mid-pass re-runs next launch. Per-workspace DBs are never
     deleted, so a wrong fold is recoverable (mirror the safety note at `:992`).
   - **Clarification — per-workspace fold scope:** the guard is per-IDE-profile, and the
     fold only processes workspace roots *open at fold time* (same root-collection as the
     existing seed). A workspace not open during the fold launch is skipped; its first
     post-upgrade render still shows the masked bug until the user toggles (write-through
     then self-heals it). This matches the existing v2 seed's limitation and is acceptable
     for a one-time migration with a write-through backstop, but the "every install" goal
     is technically "every workspace open at fold time" — state this in the PR description.

4. **Post-migration read verification.** After the fold, `getVisibleAgents` /
   `getCustomAgents` return the folded file value, so no getter change is needed —
   the file-first read is now correct because the file is authoritative. Confirm the
   getters are left file-first (do NOT switch them to a merge-read: that would let a
   stale per-workspace `state.json` override a fresh cross-IDE file value written by
   another IDE, breaking the cross-IDE guarantee `startupCommands` relies on).

### ⚙️ OUT OF SCOPE
- `startupCommands` — already file-backed on write (`:9099`) and file-first on read
  (`:4496`). Reference implementation; do not touch.
- The `updateState` → `globalState` + `state.json` mirror (`:2626-2635`) — keep it;
  legacy code paths and the fold's fallback sources still read those. The file
  becomes the primary; the mirror stays as a compatibility copy.
- The kanban column-visibility *rule* and the `sendVisibleAgents` `_markConfigDirty`
  refresh fix — shipped in the predecessor plan; not re-touched here.
- Changing the on-disk `~/.switchboard` schema or the wipe-guard thresholds.

## Complexity Audit
### Routine
- The write-through calls themselves (one helper + ~5 call sites for visibleAgents,
  ~3 for customAgents) — direct copy of the `startupCommands` pattern.
- Leaving the getters unchanged.
### Complex / Risky
- **Fold merge precedence (Scope #3):** base=file (preserves `mcp_monitor`),
  overlay=legacy toggles (real built-in/custom values win). Reverse it and you
  either drop the user's real toggles (file-wins) or blank `mcp_monitor`
  (state-wins-wholesale). This is the part that can destroy config on 4,000 installs.
- **customAgents is a replace, not a merge:** the fold must pick the most-populated
  legacy source and never shrink a populated file list — a wrong pick deletes a
  user's custom agents (and their exported skills drift).
- **Wipe-guard interaction:** `setAgentConfig` refuses an empty `visibleAgents`/`startupCommands`
  write (`:200-207`). The write-through helper must pass a *merged* (non-empty) map,
  and delete-all custom-agent flows must not rely on blanking `visibleAgents` via the
  guarded path — prune specific keys and write the remainder.
- **Ordering with the predecessor fix:** the fold must run before (or the getter must
  tolerate) the first board refresh after upgrade, else the first render still reads a
  stale file. Run the fold in the same activation seam as `_migrateStartupCommandsToGlobalFile`.

## Edge-Case & Dependency Audit
- **MCP-monitor user unticks coder:** helper writes `{ mcp_monitor:false, coder:false }`
  to the file; `getVisibleAgents` returns coder:false; column hides. The exact bug, fixed.
- **Never-touched-MCP-monitor user:** file `visibleAgents` was undefined → getter fell
  through to globalState (already worked); fold writes the file from globalState so it
  keeps working, now file-backed. No regression.
- **Fresh install, no legacy config:** fold finds no candidates → writes nothing →
  getter falls through to defaults. No-op.
- **Multi-IDE:** file is the cross-IDE source of truth; write-through means IDE B sees
  IDE A's toggle. Merge-read (rejected) would have broken this.
- **Delete last custom agent:** `customAgents` → `[]` written to file (guard exempts
  it); associated `visibleAgents` custom-role keys pruned from both file and legacy
  stores.
- **Reinstall (globalState reset):** wipe guard (`:200-207`) still protects a populated
  file from an empty relaunch save — unchanged.
- **Dependencies:** builds on the shipped predecessor plan's `sendVisibleAgents`
  refresh fix (both halves needed for the toggle to work end-to-end). No API/verb
  surface change → no catalog regen; no skill files → no mirror sync.

## Dependencies
- Predecessor: `feature_plan_20260711131500_fix-intern-column-hide-and-created-bucket-fallback.md`
  (the uniform-rule + `_markConfigDirty` refresh fix). This plan completes the storage
  half. No other plan dependencies.

## Adversarial Synthesis

**Key risks:** (1) the fold's per-IDE-profile guard only processes workspace roots open
at fold time — workspaces not open at launch are skipped (self-healing on next toggle via
write-through, but the first post-upgrade render still shows the masked bug for them);
(2) the customAgents "most-populated wins" fold heuristic can resurrect deleted agents
(defensible one-time trade: data-loss > un-delete, but a correctness inversion the coder
must know); (3) pruning custom-role keys from `visibleAgents` via the guarded path must
specify the empty-remainder case — if the remainder is `{}` the wipe guard refuses the
write and ghost columns persist. **Mitigations:** state the per-workspace fold scope
explicitly; name the un-delete trade-off; require the prune helper to guarantee a
non-empty remainder (built-in keys are always present, so an empty remainder only arises
from a logic bug — guard with a skip-and-warn, never a blanking write). The approach
itself (write-through + fold, getters stay file-first) is the strongest of the
alternatives: merge-read would break cross-IDE consistency, write-through-only would
half-fix the installed base.

## Proposed Changes

> **Clarification — line-number drift:** all line numbers below were verified against
> source on 2026-07-12 and have since drifted ~80 lines downward (the file grew). Every
> structural and logic claim was re-verified on 2026-07-13 and holds. The coder should
> grep for function names (`getVisibleAgents`, `setVisibleAgent`,
> `handleToggleKanbanColumnVisibility`, `handleSaveCustomAgent`,
> `_migrateStartupCommandsToGlobalFile`, `_agentConfigScore`) rather than trusting the
> exact offsets. Current verified anchors: `getVisibleAgents` ≈ `:4670`,
> `getCustomAgents` ≈ `:4721`, `setVisibleAgent` ≈ `:22319`,
> `handleToggleKanbanColumnVisibility` ≈ `:9332`, `handleSaveCustomAgent` ≈ `:9351`,
> `_migrateStartupCommandsToGlobalFile` ≈ `:1002`, `updateState` mirror ≈ `:2699-2718`,
> activation seam (constructor) ≈ `:503`.

### src/services/TaskViewerProvider.ts
- Add `mergeVisibleAgentsToGlobalFile(patch: Record<string, boolean>)` — read file,
  `{ ...file, ...patch }`, `setAgentConfig('visibleAgents', …)`. Refactor
  `setVisibleAgent` (`:22238`) to delegate to it (single-key patch).
- Call it from `handleToggleKanbanColumnVisibility` (`:9251`), the setup-save
  `visibleAgentsPatch` branch (`:9046`), and the reset/delete paths that mutate
  `state.visibleAgents` (`:9196`, `:9312` areas).
- After `updateState` sets `state.customAgents` in `handleSaveCustomAgent` (`:9270`),
  the setup save, and the delete paths, write `setAgentConfig('customAgents', state.customAgents)`.
- Add `_foldAgentConfigToGlobalFile()` guarded by `switchboard.agents.fileFold.v1`;
  invoke it from the same activation seam that runs `_migrateStartupCommandsToGlobalFile`.

### src/services/GlobalIntegrationConfigService.ts
- No change expected — `setAgentConfig`/`getAgentConfig` + wipe guard already support
  the merge writes. Confirm the wipe guard's meaningful-count for `visibleAgents`
  (`:185`) treats a merged map with `mcp_monitor:false` as non-empty (it does — counts keys).

## Verification Plan
### Automated Tests
- None required for sign-off (session SKIP TESTS / SKIP COMPILATION). Highest-value
  future unit targets: (a) `mergeVisibleAgentsToGlobalFile` preserves `mcp_monitor`
  while applying a `coder:false` patch; (b) `_foldAgentConfigToGlobalFile` on a file
  holding only `{mcp_monitor:false}` + globalState `{coder:false}` yields
  `{mcp_monitor:false, coder:false}`; (c) fold never shrinks a populated `customAgents`
  file list.

### Manual / behavioral
- **Headline / masking repro:** start then stop the MCP monitor (seeds the file), then
  untick coder in AGENT SETUP → `CODER CODED` hides; reload → stays hidden;
  `getVisibleAgents` (and `GET /kanban/columns`) report coder:false.
- **No-MCP-monitor path:** fresh-ish install, untick lead → `LEAD CODED` hides
  (unchanged good behavior, now file-backed).
- **Fold on upgrade:** pre-seed file `{mcp_monitor:false}` + globalState `{coder:false, planner:false}`,
  launch → file becomes `{mcp_monitor:false, coder:false, planner:false}`; both columns
  hidden; nothing lost.
- **customAgents:** add a custom agent on an install whose file holds a stale/empty
  `customAgents` → the agent appears and persists across reload; delete it → list
  shrinks correctly and the exported skill is cleaned.
- **Cross-IDE:** toggle in IDE A, open the board in IDE B → same column set.
- **Data-safety:** confirm no relaunch/reinstall blanks a populated file (wipe guard),
  and that the fold is a no-op on second launch (guard flag set).

---
**Recommendation:** Complexity 7 → Send to Lead Coder. The write-through is a
mechanical copy of the working `startupCommands` path, but the fold migration merges
agent configuration across three legacy stores on ~4,000 installs where a wrong
precedence silently deletes a user's toggles or custom agents — a data-safety review,
not plumbing.

## Completion Summary

Implemented file-backed write-through for `visibleAgents` and `customAgents` in `src/services/TaskViewerProvider.ts`: added a `mergeVisibleAgentsToGlobalFile` helper that merges a patch into the existing global file without clobbering file-only keys like `mcp_monitor`, and wired it into `handleToggleKanbanColumnVisibility`, `handleSaveStartupCommands`, `handleRestoreKanbanDefaults`, and `handleDeleteCustomAgent`. `customAgents` now writes through to the global file in `handleSaveCustomAgent`, `handleDeleteCustomAgent`, and `handleSaveStartupCommands`. Added a guarded `_foldAgentConfigToGlobalFile` migration that merges legacy `visibleAgents` toggles over the global file and only replaces `customAgents` when the legacy list is longer than the file's list; it is invoked from the constructor after the existing v2 seed. The getters remain file-first, and the global wipe guard is respected. No tests or compilation were run per the plan's skip directives.

## Review Findings

Reviewer trace found one material bug the plan's own "empty remainder only comes from a prune bug" reasoning missed: `handleRestoreKanbanDefaults` *deletes every built-in role*, so when the `~/.switchboard` file holds only built-in keys (the common no-MCP-monitor/no-custom-agent user) the remainder is `{}` — which BOTH the wipe guard and the new empty-remainder guard refuse — leaving hidden columns hidden after "Restore Defaults" (pre-existing, since `stateConfigBridge` already routed the write through the same guard). Fixed by resetting built-in roles to their default values (a non-empty patch) instead of deleting to empty; factored the canonical defaults into `_defaultVisibleAgents()` reused by `getVisibleAgents`. Files changed: `src/services/TaskViewerProvider.ts`. Verified via per-file TypeScript parse (no syntax diagnostics); tests/compile skipped per directives. Remaining (accepted, no fix): the write-through largely duplicates the pre-existing `stateConfigBridge` round-trip (idiomatic — mirrors the shipped `startupCommands` pattern), so the fold mainly benefits pre-bridge upgraders with a seeded `mcp_monitor`; the fold's globalState overlay can one-time-revert a fresh cross-IDE toggle or un-delete a `customAgents` entry (plan-acknowledged, self-heals on next toggle); and `GlobalIntegrationConfigService.saveGlobal` remains unserialized with a fixed `.tmp` path (pre-existing concurrent-write race, out of scope).
