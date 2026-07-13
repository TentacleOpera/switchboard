# Switchboard Skill Name Collision — Stale Router Artifact Survives Upgrade (Delivery/Removal Asymmetry)

## Goal

Make bare `/switchboard` deterministically run the management-console Entry Protocol (snapshot + menu) in every Switchboard-managed workspace, by fixing the upgrade pipeline that stranded a stale, superseded "router" skill under the name `switchboard` in child workspaces (observed live in the Gitlab workspace). The fix is to the **propagation machinery** (workflow-file delivery + mirror pruning), not to the stale artifact itself — the artifact is generated output and regenerates correctly once the machinery is fixed.

### Core Problem (observed symptom — unchanged)

When a user types bare `/switchboard` in the Gitlab workspace, the agent produces a generic greeting ("tell me what you want to do") instead of the management-console entry snapshot (liveness, board counts, terminals, menu). The skill that answers is the old **router** design ("Front door for Switchboard — routes the user's request…", "reply with a **short, welcoming prompt**") — a design the four-front-doors refactor explicitly abandoned and superseded.

### Root Cause — verified on disk and in code, 2026-07-13

> **Superseded:** There are two different skills both named `switchboard` with contradictory purposes… The two were never reconciled. The router skill's opener section directly contradicts the management console workflow's §1 Entry Protocol.
> **Reason:** The reconciliation *did* happen — the four-front-doors refactor replaced the router model with the console door, and the switchboard repo's `.agents/workflows/` now contains exactly the four doors (`switchboard.md`, `switchboard-cloud.md`, `switchboard-remote.md`, `switchboard-memo.md`). The Gitlab copy of the router is not a live competing design; it is a **stale generated artifact that survived the upgrade** because of two independent gaps in the propagation pipeline (below). Framing it as "two designs never reconciled" points the fix at editing the artifact, which is the wrong layer.
> **Replaced with:** The refactor half-landed in child workspaces. Verified state of the Gitlab workspace (2026-07-13):
> 1. `Gitlab/.agents/workflows/` is **empty** (dir mtime Jul 12 08:08) — the refactor's stale-file cleanup ran and deleted the ten retired workflow files, but the four new door files were **never delivered**.
> 2. `Gitlab/.claude/skills/switchboard/SKILL.md` is the **Jul 9 router-era generated skill** (mtime Jul 9 21:00) — the abandoned `switchboard-index.md` body.
> 3. `Gitlab/.claude/.switchboard-generated.json` was regenerated Jul 11 23:39 (v1.7.13) with the *new* manifest — and contains **none of the four doors**: their sources were missing from `Gitlab/.agents/workflows/`, so the mirror skipped them and left the stale router dir in place.
>
> The three code-level gaps that produce this:
> - **Gap 1 — deletion is unconditional, delivery is version-gated.** `cleanupLegacyAgentFiles` runs on every activation (`extension.ts:767`), but workflow-file delivery is gated on an extension **version-number change** (`shouldRefreshAgentWorkspaceFiles`, `extension.ts:222-238`; used at `:301` and as `needsWorkflowMigration` at `:3678`). The refactor landed in dev builds without a version bump (1.7.13 before and after), so the gate reported "already copied 1.7.13" and the doors never shipped — while the cleanup still deleted the old files. A rename therefore becomes **delete-without-replace** on any same-version install.
> - **Gap 2 — the activation content-hash self-heal covers skills only.** `refreshWorkspaceControlPlane`'s per-file content-hash seed loop (`extension.ts:302-341`) crawls `.agents/skills/` exclusively; `.agents/workflows/` has no hash-based path and relies entirely on the version gate. (This is the same frozen-copy failure previously fixed for skills — the fix was never extended to workflows.)
> - **Gap 3 — the mirror skips missing sources without pruning.** `generateClaudeMirror` skips a manifest entry whose source file is absent (`ClaudeCodeMirrorService.ts:447` — "source missing — skip, never fail") and does **not** remove the previously generated skill dir for that entry. A live manifest name (`switchboard`) can therefore keep serving a stale body from an earlier design indefinitely.
>
> Net effect: in a Gitlab session, the only `switchboard` skill the host can inject is the stale router — the greeting wins and the Entry Protocol never runs.

### Why this matters beyond `/switchboard`

The same asymmetry will fire on **every future workflow rename or door change** for any install that receives a rebuild without a version bump (dev installs today; any hotfix-without-bump tomorrow). And Gap 3 means any manifest entry whose source goes missing — for any reason — silently serves its last-generated body forever. This plan fixes the class, not the instance.

## Metadata
**Tags:** bugfix, infrastructure, devops, reliability
**Complexity:** 5

## User Review Required
1. **Delivery mechanism choice — RECOMMEND extending the content-hash loop.** Option A (recommended): extend the activation content-hash seed loop to also crawl `.agents/workflows/` (identical semantics to the skills loop: copy if absent, overwrite iff bundle hash differs). This permanently retires the version gate as the sole workflow-delivery trigger and matches the already-established skills fix. Option B: keep the version gate but force a one-time migration marker for this release. Option B fixes this instance and leaves the class unfixed — not recommended.
2. **Mirror prune scope.** When a manifest entry's source is missing, this plan deletes the previously generated `.claude/skills/<name>/` dir (ledger-verified — only dirs the mirror itself wrote). Confirm no host relies on a generated skill outliving its source.

## Complexity Audit

### Routine
- Extending the content-hash seed loop to a second directory is pattern reuse — the skills loop at `extension.ts:302-341` is copied with a different crawl root; per-file fault tolerance semantics already established.
- The Gitlab repair is zero-touch once the machinery lands: next activation hash-seeds the four doors (dest absent → copy), and the next mirror pass regenerates `switchboard/SKILL.md` from `workflows/switchboard.md`, overwriting the router body.

### Complex / Risky
- **Mirror pruning must delete only mirror-owned dirs.** The prune must consult the generation ledger (`ClaudeCodeMirrorService.ts:~506`) or the previous `.switchboard-generated.json` `relPath` entries — never delete a `.claude/skills/` dir the mirror didn't write, or user-authored skills die.
- **Workflow overwrite semantics on user-edited files.** The hash loop overwrites when bundle ≠ workspace. Workflow files are documented as Switchboard-managed (user edits not preserved — consistent with `cleanupLegacyAgentFiles` behavior), but this makes that contract mechanical; note it in the user manual.
- **Ordering within activation:** delivery (hash-seed) must run before mirror regeneration in the same activation pass, or the first post-fix activation still generates a doorless mirror and needs a second pass.

## Edge-Case & Dependency Audit
- **Race Conditions:** none new — all changes run inside the existing single-pass activation flow; per-file try/catch tolerance preserved.
- **Security:** none — no new surface; prune is ledger-scoped.
- **Side Effects:** installs that customized bundled workflow files lose those edits on next activation (managed-file contract, now enforced by hash). Stale generated skills under live manifest names disappear (intended).
- **Dependencies & Conflicts:** completes the four-front-doors refactor's §F migration story (its cleanup shipped; its delivery didn't). Related prior art: the skills-freeze fix that introduced the content-hash loop — this plan extends it to workflows. No conflict with the mirror manifest contents themselves.

## Dependencies
- Four-front-doors refactor (landed in repo `.agents/workflows/` — the four door files are the payload this plan delivers to child workspaces).
- Prior skills content-hash self-heal (`extension.ts:302-341`) — the pattern being extended.

## Adversarial Synthesis
**Risk Summary:** The dangerous edit is the mirror prune — an unscoped delete could destroy user-authored `.claude/skills/` dirs, so it must be strictly ledger-scoped. The workflow hash-overwrite formalizes "workflow files are managed, user edits lost" — acceptable and consistent with existing cleanup behavior, but must be stated, not implied. The fix is self-healing by design: no per-install manual repair, no data migration; if the hash loop fails on one file it skips and logs, leaving behavior no worse than today.

## Proposed Changes

### [MODIFY] `src/extension.ts` — deliver workflow files by content hash, not version gate (Gap 1 + Gap 2)
- **Context:** `refreshWorkspaceControlPlane` (`extension.ts:296-360`) hash-seeds `.agents/skills/` only; workflow delivery hides behind `needsAgentRefresh`/`needsWorkflowMigration` (version-gated, `:222-238`, `:3678`).
- **Logic:** extend the activation seed loop to also crawl the bundle's `.agents/workflows/` with identical semantics: dest absent → copy; dest present → overwrite iff bundle hash ≠ workspace hash; per-file try/catch, never abort the loop. Set `agentsChanged = true` on any write so the downstream scaffold + version stamp still fire.
- **In `performSetup` (`:3687-3699`):** the `isWorkflowFile && needsWorkflowMigration` fast path can remain (harmless when the hash loop has already converged the files), or be simplified to the hash path; either way the hash loop is now the delivery guarantee.
- **Edge Cases:** unwritable file → warn + skip (existing posture); empty bundle workflows dir → loop no-ops.

### [MODIFY] `src/services/ClaudeCodeMirrorService.ts` — prune stale generated skills when the source is missing (Gap 3)
- **Context:** `generateClaudeMirror` skips missing sources (`:447`) and writes a generation ledger (`:~506`, `.switchboard-generated.json` with per-skill `relPath`).
- **Logic:** on a skipped-missing-source entry, if the ledger (previous generation record) shows a `relPath` the mirror previously wrote for that skill name, **delete that skill dir** and record the removal in the new ledger. Additionally, prune any ledger-listed dir whose name is no longer in the manifest at all (retired names — e.g. `switchboard-manage`, `switchboard-chat`, `memo` on old installs).
- **Edge Cases:** dir already gone → no-op; dir not in ledger (user-authored or foreign) → NEVER delete; delete failure → warn + continue (stale body survives one more pass, logged).

### [VERIFY] No hand-edits to generated files
> **Superseded:** [MODIFY] Router skill — remove the greeting opener… **File:** `/Users/patrickvuleta/Documents/Gitlab/.claude/skills/switchboard/SKILL.md` (and any distributed copies) … replace the "## The opener" section with a deferral directive; update the description.
> **Reason:** That file is **generated output** of `ClaudeCodeMirrorService` — hand-edits are clobbered on the next successful mirror pass, and the router body it contains is a superseded design that should not exist anywhere, not a layer to make "defer". Editing artifacts instead of the generator is why this bug class recurs.
> **Replaced with:** No edits to any `.claude/skills/` file. With the two machinery fixes above, the next activation in each affected workspace hash-delivers the four door files into `.agents/workflows/` and the next mirror pass regenerates `switchboard/SKILL.md` from `workflows/switchboard.md` (console body), automatically overwriting the router artifact. The find-all-copies audit is replaced by the self-healing pass — every Switchboard-managed workspace converges on next activation.

### [OPTIONAL — immediate manual unblock for the Gitlab workspace]
Until the machinery fix ships: copy the four door files from the repo `.agents/workflows/` into `Gitlab/.agents/workflows/` and delete `Gitlab/.claude/skills/switchboard/`, then reload the window so the next mirror pass regenerates it. One-time, superseded by the self-heal.

## Verification Plan

### Automated Tests
- Unit-test the extended seed loop (mirror the existing skills-loop coverage): bundle workflow file absent in workspace → copied; present-but-different hash → overwritten; identical hash → untouched; write error → skipped without aborting siblings.
- Unit-test mirror pruning: manifest entry with missing source + ledger `relPath` → dir deleted and ledger updated; missing source + no ledger record → dir untouched; name absent from manifest but present in ledger → dir deleted.

### Manual (the real acceptance gate)
1. Seed a workspace simulating Gitlab's observed state: empty `.agents/workflows/`, stale router body at `.claude/skills/switchboard/SKILL.md`, old ledger. Activate the extension **without a version bump**. Assert: four door files appear in `.agents/workflows/`; `.claude/skills/switchboard/SKILL.md` now contains the management-console body; generated manifest lists all four doors.
2. In that workspace, type bare `/switchboard` → Entry Protocol runs (health check, kanban-state awk, snapshot, menu) — no greeting.
3. Type `/switchboard` with no extension running → port-file-missing message per the workflow, not a greeting.
4. Regression: a user-authored `.claude/skills/<custom>/` dir (not in ledger) survives a mirror pass with pruning enabled.

---

**Recommendation:** Complexity 5 → **Send to Coder.** Two well-scoped mechanism fixes reusing an established pattern; the only sharp edge is ledger-scoping the prune. Fixes the class (rename = delete-without-replace on same-version installs; stale mirror bodies under live names), and every affected workspace self-heals on next activation — no per-install surgery.
