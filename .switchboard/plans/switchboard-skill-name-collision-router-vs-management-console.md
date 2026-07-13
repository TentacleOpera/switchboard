# Switchboard Skill Name Collision — Stale Router Artifact Survives Upgrade (Delivery/Removal Asymmetry)

## Goal

Make bare `/switchboard` deterministically run the management-console Entry Protocol (snapshot + menu) in every Switchboard-managed workspace, by fixing the upgrade pipeline that stranded a stale, superseded "router" skill under the name `switchboard` in child workspaces (observed live in the Gitlab workspace). The fix is to the **propagation machinery** (workflow-file delivery + mirror regeneration ordering), not to the stale artifact itself — the artifact is generated output and regenerates correctly once the machinery is fixed.

### Core Problem (observed symptom — unchanged)

When a user types bare `/switchboard` in the Gitlab workspace, the agent produces a generic greeting ("tell me what you want to do") instead of the management-console entry snapshot (liveness, board counts, terminals, menu). The skill that answers is the old **router** design ("Front door for Switchboard — routes the user's request…", "reply with a **short, welcoming prompt**") — a design the four-front-doors refactor explicitly abandoned and superseded.

### Root Cause — verified on disk and in code, 2026-07-13

> **Superseded:** There are two different skills both named `switchboard` with contradictory purposes… The two were never reconciled. The router skill's opener section directly contradicts the management console workflow's §1 Entry Protocol.
> **Reason:** The reconciliation *did* happen — the four-front-doors refactor replaced the router model with the console door, and the switchboard repo's `.agents/workflows/` now contains exactly the four doors (`switchboard.md`, `switchboard-cloud.md`, `switchboard-remote.md`, `switchboard-memo.md`). The Gitlab copy of the router is not a live competing design; it is a **stale generated artifact that survived the upgrade** because of two independent gaps in the propagation pipeline (below). Framing it as "two designs never reconciled" points the fix at editing the artifact, which is the wrong layer.
> **Replaced with:** The refactor half-landed in child workspaces. Verified state of the Gitlab workspace (2026-07-13, re-confirmed this pass):
> 1. `Gitlab/.agents/workflows/` is **empty** (dir mtime Jul 12 08:08) — the refactor's stale-file cleanup ran and deleted the ten retired workflow files, but the four new door files were **never delivered**.
> 2. `Gitlab/.claude/skills/switchboard/SKILL.md` is the **Jul 9 router-era generated skill** (mtime Jul 9 21:00) — the abandoned `switchboard-index.md` body (description: "Front door for Switchboard — routes the user's request…").
> 3. `Gitlab/.claude/.switchboard-generated.json` was regenerated Jul 11 23:39 (v1.7.13) with the *new* manifest — and contains **none of the four doors**: their sources were missing from `Gitlab/.agents/workflows/`, so the mirror skipped them. The ledger therefore **dropped** the `switchboard` name while the on-disk skill dir was left in place.
>
> The code-level gaps that produce this (re-verified against current `main` tree):
> - **Gap 1 — deletion is unconditional, delivery is version-gated.** `cleanupLegacyAgentFiles` runs on every activation that has a workspace root (`extension.ts:800`, list at `:3541-3585` includes all ten retired four-front-doors files). Workflow-file delivery is gated on an extension **version-number change** (`shouldRefreshAgentWorkspaceFiles`, `extension.ts:222-237`; used as `needsAgentRefresh` at `:301` and as `needsWorkflowMigration` at `:3678`). The refactor landed in dev builds without a version bump (1.7.13 before and after), so the gate reported "already copied 1.7.13" and the doors never shipped — while the cleanup still deleted the old files. A rename therefore becomes **delete-without-replace** on any same-version install.
> - **Gap 2 — the activation content-hash self-heal covers skills only.** `refreshWorkspaceControlPlane`'s per-file content-hash seed loop (`extension.ts:302-340`) crawls `.agents/skills/` exclusively; `.agents/workflows/` has no hash-based path and relies entirely on the version gate. (This is the same frozen-copy failure previously fixed for skills — the fix was never extended to workflows.) The dual path in `performSetup` (`extension.ts:3687-3698`) also special-cases workflows as version-gated overwrite while non-workflow agent files use content-hash — same asymmetry.
>
> > **Superseded (Gap 3 as originally stated):** `generateClaudeMirror` skips missing sources (`ClaudeCodeMirrorService.ts:447`) and does **not** remove the previously generated skill dir for that entry. A live manifest name (`switchboard`) can therefore keep serving a stale body from an earlier design indefinitely. Plan proposed implementing ledger-scoped prune.
> > **Reason:** Ledger-scoped prune **already shipped** in commit `df9ecb1` (2026-07-12) at `ClaudeCodeMirrorService.ts:498-520`. On each mirror pass it reads the previous `.switchboard-generated.json`, deletes any ledger-tracked skill name that was **not** regenerated this run, and rewrites the ledger. Path-traversal guard + "user files leave the dir" already present. Framing Gap 3 as "must implement prune" would re-implement dead work.
> > **Replaced with (residual Gap 3 — pre-prune orphan):** The prune only sees names present in the **previous** ledger. The pre-prune Jul 11 mirror pass rewrote the ledger **without** `switchboard` (source missing → skip → not pushed into `generatedSkills` → ledger rewrite dropped the name) while leaving the on-disk dir. After prune landed, subsequent passes have no ledger record of `switchboard`, so they never delete the orphan. **However, this residual is self-healed by Gap 1+2 alone:** once the four door sources land in `.agents/workflows/`, the next `generateClaudeMirror` finds `workflows/switchboard.md`, regenerates `.claude/skills/switchboard/SKILL.md` via `writeFileSync` (overwrite), and the router body dies without needing a delete. Residual prune for pre-ledger orphans is optional cleanup of *retired* names that never reappear in the manifest — not required for the primary success criterion.
>
> **Activation ordering (verified):** multi-root `refreshWorkspaceControlPlane` runs at `extension.ts:609-616` (early). `cleanupLegacyAgentFiles` runs later at `:798-801`. Mirror regeneration lives inside `scaffoldProtocolLayers` (`:3427-3430`), which is invoked from `refreshWorkspaceControlPlane` only when `needsAgentRefresh || agentsChanged` (`:343-357`). Therefore the hash-seed must set `agentsChanged = true` on any workflow write so the **same activation pass** regenerates the mirror against freshly delivered doors. Without that flag, the first post-fix pass could still serve a doorless or stale mirror.
>
> Net effect: in a Gitlab session, the only `switchboard` skill the host can inject is the stale router — the greeting wins and the Entry Protocol never runs.

### Why this matters beyond `/switchboard`

The same asymmetry will fire on **every future workflow rename or door change** for any install that receives a rebuild without a version bump (dev installs today; any hotfix-without-bump tomorrow). This plan fixes the class (workflow delivery self-heal), not the instance. Mirror prune for retired names is already present; the residual pre-ledger orphan is a one-shot historical scar that Gap 1+2 overwrites for live manifest names.

## Metadata
**Tags:** bugfix, infrastructure, devops, reliability
**Complexity:** 5

## User Review Required
1. **Delivery mechanism choice — RECOMMEND extending the content-hash loop.** Option A (recommended): extend the activation content-hash seed loop in `refreshWorkspaceControlPlane` to also crawl `.agents/workflows/` (identical semantics to the skills loop: copy if absent, overwrite iff bundle hash differs). Also drop the workflow special-case in `performSetup` so workflows use the same content-hash path as other agent files (or keep the version-gated fast path as a redundant best-effort — but the hash path must be the delivery guarantee). This permanently retires the version gate as the *sole* workflow-delivery trigger and matches the already-established skills fix. Option B: keep the version gate but force a one-time migration marker for this release. Option B fixes this instance and leaves the class unfixed — not recommended.
2. **Managed-workflow contract (confirm).** Hash overwrite formalizes "bundled workflow files are Switchboard-managed; user edits are lost on next activation when the bundle differs." This is already the documented intent of `isWorkflowFile && needsWorkflowMigration` and of `cleanupLegacyAgentFiles`. Confirm that remains desired; note it in the user manual if not already stated.
3. **Optional residual orphan sweep — DEFER unless product wants it.** Pre-prune orphans whose names are absent from both the current manifest and the current ledger (e.g. historical `switchboard` until doors land) are overwritten once their source returns, or left forever if the name is fully retired and never ledgered. A hard-coded retired-name delete list already exists on the workflow side (`cleanupLegacyAgentFiles`). Adding a second list for `.claude/skills/<retired>/` is optional and out of scope unless the user wants belt-and-suspenders cleanup of non-live names. Default: defer.

## Complexity Audit

### Routine
- Extending the content-hash seed loop to a second directory is pattern reuse — the skills loop at `extension.ts:302-340` is copied with a different crawl root (`.agents/workflows`); per-file fault tolerance semantics already established.
- Aligning `performSetup`'s workflow branch (`:3687-3698`) with the same hash semantics is a small, local change (remove or narrow the version-only special case).
- The Gitlab repair is zero-touch once the machinery lands: next activation hash-seeds the four doors (dest absent → copy → `agentsChanged=true`), and the same-pass mirror regenerates `switchboard/SKILL.md` from `workflows/switchboard.md`, overwriting the router body.

### Complex / Risky
- **Ordering within activation:** delivery (hash-seed) must run before mirror regeneration in the same activation pass, and hash writes must flip `agentsChanged` so `scaffoldProtocolLayers` actually runs when the version gate is false. Existing structure already supports this (`:343-357`); implementer must not place the workflow loop after the scaffold gate or forget the flag.
- **Workflow overwrite semantics on user-edited files.** The hash loop overwrites when bundle ≠ workspace. Workflow files are Switchboard-managed (user edits not preserved — consistent with `cleanupLegacyAgentFiles` behavior), but this makes that contract mechanical; document if missing from the user manual.
- **Dual call sites.** Both `refreshWorkspaceControlPlane` (activation multi-root loop) and `performSetup` (setup command / silent protocol setup) must converge. Fixing only activation leaves first-time setup or silent setup on the version gate.
- ~~Mirror pruning must delete only mirror-owned dirs~~ — **already implemented** (`ClaudeCodeMirrorService.ts:498-520`). Do not re-implement; do not expand unless residual orphan sweep is explicitly approved.

## Edge-Case & Dependency Audit
- **Race Conditions:** none new — all changes run inside the existing single-pass activation flow; per-file try/catch tolerance preserved. Cleanup still runs later in activation (`:800`) and only deletes *retired* relative paths; newly delivered door files are not on that list.
- **Security:** none — no new surface; existing mirror prune remains ledger-scoped with path-traversal guard.
- **Side Effects:** installs that customized bundled workflow files lose those edits on next activation (managed-file contract, now enforced by hash on every activation, not only version bumps). Stale generated skills under live manifest names are overwritten once sources land (intended). Version stamp (`setLastCopiedAgentVersion`) still fires when `agentsChanged` is true, so subsequent same-version activations stay quiet if hashes match.
- **Dependencies & Conflicts:** completes the four-front-doors refactor's §F migration story (its cleanup shipped; its delivery didn't). Related prior art: the skills-freeze fix that introduced the content-hash loop — this plan extends it to workflows. Mirror prune (df9ecb1) is a peer already landed — do not conflict or duplicate. No change to `MIRROR_MANIFEST` contents themselves (`ClaudeCodeMirrorService.ts:47-60` already maps the four doors correctly).

## Dependencies
- `sess_four_front_doors` — Four-front-doors refactor (landed in repo `.agents/workflows/` — the four door files are the payload this plan delivers to child workspaces; `cleanupLegacyAgentFiles` + performSetup blocklist already list retired names).
- `sess_skills_content_hash` — Prior skills content-hash self-heal (`extension.ts:302-340`) — the pattern being extended.
- `sess_mirror_ledger_prune` — Ledger prune already landed (`ClaudeCodeMirrorService.ts:498-520`, commit `df9ecb1`) — do not re-implement; treat as settled peer.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) workflow hash-seed lands but `agentsChanged` is not set / scaffold gate is skipped → doors on disk but mirror still stale for one more session; (2) only one of the two call sites (`refreshWorkspaceControlPlane` vs `performSetup`) is fixed → setup-path or activation-path remains delete-without-replace; (3) re-implementing mirror prune as if it were missing would churn a settled ledger contract. Mitigations: assert `agentsChanged` on every successful workflow write; cover both call sites with the same hash semantics; leave `generateClaudeMirror` prune alone and rely on overwrite for the live Gitlab scar. Self-heal by design — no per-install manual repair once machinery ships.

## Proposed Changes

### [MODIFY] `src/extension.ts` — deliver workflow files by content hash, not version gate (Gap 1 + Gap 2)

#### A. `refreshWorkspaceControlPlane` (`extension.ts:296-358`)
- **Context:** Function docstring (`:286-295`) still says "content-hash skill seed + version-gated protocol scaffold". Skill seed only at `:302-340`. Ordering contract already: (1) capture `needsAgentRefresh`, (2) content-hash seed, (3) scaffold iff `needsAgentRefresh || agentsChanged`.
- **Logic:** After the skills loop (or as a second identical loop), crawl `vscode.Uri.joinPath(context.extensionUri, '.agents', 'workflows')` with the **same** per-file semantics:
  1. dest absent → `createDirectory` parent + `copy` (`overwrite: false`) → `agentsChanged = true`
  2. dest present → `hashFile` both sides; if `srcHash !== destHash` → copy `overwrite: true` → `agentsChanged = true`
  3. per-file try/catch; warn + skip; never abort the loop
  4. outer try/catch around the crawl so a missing bundle workflows dir no-ops without failing activation
- **Do not** gate the workflow seed on `needsAgentRefresh` — that reintroduces Gap 1.
- **Edge Cases:** unwritable file → warn + skip (existing posture); empty/missing bundle workflows dir → loop no-ops; identical hashes → no write, no flag (quiet steady-state).

#### B. `performSetup` (`extension.ts:3657+`, workflow branch `:3687-3698`)
- **Context:** Today, `isWorkflowFile && needsWorkflowMigration` overwrites on version change only; non-workflow agent files already use content-hash (`:3700-3727`). Same-version installs that only ever run setup (or re-run silent setup) still fail to deliver renamed doors.
- **Logic (recommended):** Remove the workflow special-case branch so workflow `.md` files fall through the existing content-hash path (absent → copy; present → overwrite iff hash differs). The version gate becomes irrelevant for delivery; it may still drive other migration side effects elsewhere.
  - Alternative (acceptable): keep the version-gated overwrite as a redundant fast path *in addition to* always applying content-hash for workflows — never as the sole path.
- **Edge Cases:** same as skills; blocklist at `:3736-3766` still removes retired workflow paths after the copy loop (order already correct: copy then blocklist then `scaffoldProtocolLayers`).

#### C. Docstring / comments
- Update `refreshWorkspaceControlPlane` header comment (`:286-295`) to say "content-hash skill **and workflow** seed + conditional protocol scaffold" so the next reader does not re-introduce skills-only.

### [NO CHANGE] `src/services/ClaudeCodeMirrorService.ts` — prune already correct for going-forward; leave alone

> **Superseded:** [MODIFY] `generateClaudeMirror` — on a skipped-missing-source entry, if the ledger shows a `relPath` the mirror previously wrote, delete that skill dir; also prune ledger-listed dirs whose names left the manifest.
> **Reason:** That exact logic already exists at `ClaudeCodeMirrorService.ts:498-520` (df9ecb1). `generatedSkills` only lists successfully written entries; anything in the previous ledger not in `regenerated` is deleted (ledger-scoped, path-traversal-guarded). Re-implementing is churn and risk.
> **Replaced with:** No code change in this file for the primary fix. Once Gap 1+2 deliver door sources, the existing write path at `:454-461` overwrites `.claude/skills/switchboard/SKILL.md` with the console body. Residual pre-ledger orphans for *retired* names (if any remain on old installs) are outside the primary success criterion; handle only if User Review item 3 is approved (hard-coded retired skill-dir list, analogous to `cleanupLegacyAgentFiles`).

### [VERIFY] No hand-edits to generated files
> **Superseded:** [MODIFY] Router skill — remove the greeting opener… **File:** `/Users/patrickvuleta/Documents/Gitlab/.claude/skills/switchboard/SKILL.md` (and any distributed copies) … replace the "## The opener" section with a deferral directive; update the description.
> **Reason:** That file is **generated output** of `ClaudeCodeMirrorService` — hand-edits are clobbered on the next successful mirror pass, and the router body it contains is a superseded design that should not exist anywhere, not a layer to make "defer". Editing artifacts instead of the generator is why this bug class recurs.
> **Replaced with:** No edits to any `.claude/skills/` file. With the Gap 1+2 machinery fixes, the next activation in each affected workspace hash-delivers the four door files into `.agents/workflows/` and the same-pass mirror regenerates `switchboard/SKILL.md` from `workflows/switchboard.md` (console body), automatically overwriting the router artifact. The find-all-copies audit is replaced by the self-healing pass — every Switchboard-managed workspace converges on next activation.

### [OPTIONAL — immediate manual unblock for the Gitlab workspace]
Until the machinery fix ships: copy the four door files from the repo `.agents/workflows/` into `Gitlab/.agents/workflows/` and delete `Gitlab/.claude/skills/switchboard/`, then reload the window so the next mirror pass regenerates it. One-time, superseded by the self-heal. (If only the door sources are copied and the window reloaded / extension reactivated with a code path that runs mirror when `agentsChanged` would have fired — e.g. after a version bump or manual setup — overwrite also works without deleting the skill dir first.)

## Verification Plan

### Automated Tests
*(Session directive: do not run automated tests in this improve pass. Coder should add/extend the following when implementing.)*
- Unit-test the extended seed loop (mirror the existing skills-loop coverage in spirit of `src/test/agent-version-migration.test.js`): bundle workflow file absent in workspace → copied; present-but-different hash → overwritten; identical hash → untouched; write error → skipped without aborting siblings.
- Unit-test or integration-style: same-version activation (`needsAgentRefresh === false`) with empty workspace `.agents/workflows/` and populated bundle workflows → doors appear and `agentsChanged` path would trigger scaffold.
- Do **not** add tests that re-specify the already-landed ledger prune unless changing that code (out of scope).

### Manual (the real acceptance gate)
1. Seed a workspace simulating Gitlab's observed state: empty `.agents/workflows/`, stale router body at `.claude/skills/switchboard/SKILL.md`, ledger that does **not** list `switchboard` (current Gitlab ledger shape). Activate the extension **without a version bump**. Assert: four door files appear in `.agents/workflows/`; `.claude/skills/switchboard/SKILL.md` now contains the management-console body (not the router opener); generated ledger lists the four doors (or at least `switchboard` from `workflows/switchboard.md`).
2. In that workspace, type bare `/switchboard` → Entry Protocol runs (health check / snapshot / menu) — no welcoming-router greeting.
3. Type `/switchboard` with no extension running → port-file-missing message per the workflow, not a greeting.
4. Regression: a user-authored `.claude/skills/<custom>/` dir (not in ledger) survives a mirror pass (existing prune invariant — still holds).
5. Regression: second activation with matching hashes is a no-op (no rewrite storm, version stamp stable).

### Compile / package
*(Session directive: skip project compilation in this improve pass.)* Coder may compile locally when implementing; not a gate for this plan review.

---

**Recommendation:** Complexity 5 → **Send to Coder.** One well-scoped mechanism fix (extend content-hash seed to workflows at both activation and setup call sites), reusing an established pattern; do **not** touch mirror prune. Fixes the class (rename = delete-without-replace on same-version installs), and every affected workspace self-heals on next activation — no per-install surgery. The only sharp edges are (a) flipping `agentsChanged` so same-pass mirror runs, and (b) not forgetting `performSetup`.

---

## Completion Summary

Implemented the workflow content-hash self-heal at both call sites in `src/extension.ts`. (1) `refreshWorkspaceControlPlane` now runs a second content-hash seed loop over the bundle `.agents/workflows/` directory after the skills loop and before the scaffold gate, with identical per-file semantics (absent → copy, present → overwrite iff hash differs, per-file try/catch, outer try/catch so a missing bundle dir no-ops) and flips `agentsChanged = true` on every write so the same-pass `scaffoldProtocolLayers` regenerates the `.claude` mirror against freshly delivered doors. (2) `performSetup` retains the version-gated workflow overwrite as a redundant fast path but workflow `.md` files now fall through to the existing content-hash path when the version gate is false, closing the same-version delete-without-replace gap on the setup/silent-setup path. (3) Updated the `refreshWorkspaceControlPlane` docstring to reflect "content-hash skill **and workflow** seed" and the 4-step ordering contract. No changes to `ClaudeCodeMirrorService.ts` (ledger prune already correct) and no hand-edits to generated `.claude/skills/` files — the Gitlab router artifact self-heals on next activation once door sources land. Files changed: `src/extension.ts` only. No issues encountered; per session directives, compilation and automated tests were skipped.

## Review Findings

**Reviewer:** In-place direct review pass (Grumpy + Balanced, 2026-07-13). **No code fixes applied — implementation is correct as committed.** Verified: ordering contract (workflow seed :349-393 runs after skills loop, before scaffold gate :396), `agentsChanged` flag set on every workflow write, `performSetup` fallthrough (version-gated `continue` at :3754 only fires when gate is TRUE; workflow `.md` files fall through to content-hash at :3763 when gate is FALSE), no double-write, cleanup blocklist excludes the four new door names, `ClaudeCodeMirrorService.ts` untouched, no generated-file hand-edits. Caller audit: `refreshWorkspaceControlPlane` has 1 caller (activation :665), `performSetup` has 2 callers (silent :3228, interactive :3878) — both benefit, no signature changes. Race audit: activation is single-pass sequential; `GlobalPlanWatcherService` watches `.switchboard/plans/` not `.agents/workflows/`. On-disk confirmation: `Gitlab/.agents/workflows/` is empty and `Gitlab/.claude/skills/switchboard/SKILL.md` is the Jul 9 router body — the fix self-heals this on next activation. **NITs (deferred):** (1) workflow seed loop (:349-393) is a 45-line near-verbatim copy of the skills loop (:310-347) — a shared helper would reduce maintenance risk; (2) `performSetup` version-gated path overwrites all workflow files without hash check when gate is TRUE (pre-existing, not a regression). **Validation:** compilation and tests skipped per session directives; no code changes to verify. **Remaining risk:** the code duplication means a future bug fix in one seed loop may not be mirrored in the other — low probability, high impact if missed.
