---
description: "Fix the root cause behind ≥5 failed 'make the skills consistent' attempts: bundled .agents/skills is copied skip-if-exists on every activation and the .claude mirror only regenerates on a version bump, so dev-repo skill fixes never reach the .claude copy Claude Code loads. Replace the skip-if-exists / version-gated freeze at ALL THREE copy sites (activation skill-seed loop + performSetup + ControlPlaneMigrationService) with content-hash self-healing, and regenerate the .claude mirror whenever .agents changed — not only on version change."
---

# Switchboard Control-Plane: Content-Hash Skill Propagation

> **Status: PLAN — reviewed, corrected & decisions locked (improve-plan, 2026-07-10).** This is the durable fix for the recurring "skill fixes don't stick" bug (diagnosed 2026-07-10 with checksums + timestamps + code). It replaces per-incident manual reconciles with a self-healing propagation layer. **The improve-plan pass found the original scope targeted only one of three copy sites and missed the routine per-activation freeze — corrected below with superseded callouts. Both open decisions are now resolved per user directive: simple content-hash variant accepted; blast-radius signed off (see User Review).**

## Goal

Make Switchboard skill/workflow fixes **actually reach the copy an agent loads in a consumer workspace**, automatically, without a version bump and without manual reconciliation. Today they do not — and have not across at least five prior fix attempts plus an entire feature yesterday (`feature-creation-skill-wiring`, `agent-skills-improvements`).

### Problem / root cause (verified in source + on disk, 2026-07-10)

There are **four copies** of every skill:
- `switchboard/.agents/skills/` — the authored **source of truth** (dev repo).
- `switchboard/.claude/skills/` — a transformed mirror generated from it.
- `<workspace>/.agents/skills/` — a copy deployed into each consumer workspace from the extension bundle.
- `<workspace>/.claude/skills/` — the mirror generated from *that* copy. **This is the one Claude Code loads when the cwd is the workspace.**

**Three independent copy sites deploy `.agents/` into a workspace, and each freezes an existing skill file. The mirror regenerates only on a version bump.**

> **Superseded:** "Two gates freeze the consumer copy: (1) `.agents/skills/` is copied with `overwrite:false` at `ControlPlaneMigrationService.ts:692-697`; (2) the `.claude/` mirror only regenerates on a version bump at `ControlPlaneMigrationService.ts:728-730`."
> **Reason:** The two cited gates are real, but `_bootstrapControlPlaneLayout`/`_copyDirectoryRecursive` **only run during user-initiated control-plane migration / multi-repo setup** (callers: `ControlPlaneMigrationService.ts:208,328,856`, `MultiRepoScaffoldingService.ts:262`). They are **not** on the routine activation path. When a user simply opens a workspace, the freeze is enforced by two *other* copy sites in `extension.ts` that the original diagnosis never inspected. Fixing only `_copyDirectoryRecursive` leaves the loaded copy frozen on the path the user actually hits — the classic "green tests, bug survives" failure.
> **Replaced with:** the three-site analysis below.

**Site 1 — activation-time skill-seed loop (`extension.ts:480-501`). The dominant routine freeze.** Runs **unconditionally on every activation** for the active `workspaceRoot`. For each bundled `.agents/skills/**` file it does `vscode.workspace.fs.stat(destUri)` → **if the file exists, skip** (comment: "exists → skip to preserve user customizations"); else copy with `{ overwrite: false }`. An existing skill file is therefore **never** rewritten, on any activation, version bump or not.

**Site 2 — the `.claude` mirror trigger at activation (`extension.ts:505`, calling `scaffoldProtocolLayers` → `generateClaudeMirror` at `extension.ts:3330`).** The mirror regeneration is gated on `needsAgentRefresh = shouldRefreshAgentWorkspaceFiles(...)` (`extension.ts:478,220-235`), which is **pure version-string inequality**. So even if `.agents` were refreshed, the `.claude` mirror the agent loads only rebuilds on a version change — and it reads from the (frozen) workspace `.agents`, so it mirrors stale content when it does run.

**Site 3 — `performSetup` full `.agents` copy (`extension.ts:3562-3583`).** User-triggered setup path: workflow files overwrite on version change (`needsWorkflowMigration`); every other file (skills included) is `stat`→skip. Same freeze, different entry point. Ends by calling `scaffoldProtocolLayers(...,'Setup')` (`:3613`), so its mirror runs but again reads the just-frozen `.agents`.

**Site 4 (migration/multi-repo only) — `ControlPlaneMigrationService._copyDirectoryRecursive` (`:1033`), called by `_bootstrapControlPlaneLayout` (`:667`, invoked at `:208,328,856` and `MultiRepoScaffoldingService.ts:262`).** Copies `.agents` with `{ overwrite: false, overwriteWorkflows: needsAgentMigration }`. Inside (`:1053-1056`): `shouldOverwrite = options.overwrite || (isWorkflowFile && options.overwriteWorkflows)` — always `false` for a skill file → `if (!shouldOverwrite && fs.existsSync(targetPath)) continue`. The `.claude` mirror it triggers is gated on `needsAgentMigration` (`:728-730`). This is the site the original plan diagnosed; it is real but **not** on the routine activation path.

`needsAgentMigration` / `needsAgentRefresh` are both pure version-string inequality (`ControlPlaneMigrationService.ts:795-801`; `extension.ts:220-235`). So a skill fix shipped **without** a version bump propagates to no one; a skill fix shipped **with** a version bump refreshes workflows but still not skills (all three sites skip existing skill files).

**Evidence (this machine):** `group-into-features` — `switchboard/.agents` (Jul 9, fix landed) vs `Gitlab/.agents` (Jul 7, frozen) vs `Gitlab/.claude` (Jul 10, regenerated **from the Jul-7 stale source**). Four distinct checksums. `create-feature-from-plans` happened to already match. The propagation is silently, per-file lossy — exactly the failure mode where "the fix looks applied" but the loaded copy never changes. (The `Gitlab` workspace is loaded via the routine activation path — Sites 1 & 2 — which is why fixing only Site 4 would not have helped.)

Net: it was **architecturally impossible** for a skill-content fix in the dev repo to reach an existing workspace, across **every** deployment path — routine activation (Sites 1+2), setup (Site 3), and migration (Site 4). The content was never wrong; the propagation layer discards it.

## Metadata
- **Tags:** infrastructure, bugfix, reliability, devops
- **Complexity:** 7

> **Superseded:** Complexity 6; Tags `[infrastructure, control-plane, bug, scaffolding, agent-skills]`.
> **Reason:** (a) Scope corrected upward from one copy site to three copy sites + the activation-time mirror gate, spanning `extension.ts` (activation + `performSetup`) *and* `ControlPlaneMigrationService` — genuine multi-file coordination on code that writes into ~4,000 installs, which is High (7), not Medium (6). (b) `control-plane`, `bug`, `scaffolding`, and `agent-skills` are not in the allowed tag list; mapped to the nearest allowed tags (`bug`→`bugfix`, added `reliability`, `devops`).
> **Replaced with:** Complexity 7; the allowed-list tags above.

- **Release phase:** Control-plane correctness — ships to all installs (the propagation layer itself). Requires a version bump to deliver *this* fix (bootstrap); after it lands, future skill fixes propagate with no version bump.
- **Relates to:** `feature-creation-skill-wiring`, `agent-skills-improvements` (both prior attempts that fixed content but couldn't propagate it), `ClaudeCodeMirrorService` (the `.claude` generator), `MultiRepoScaffoldingService` (the migration scaffold path), `extension.ts` `activate()` + `performSetup` (the routine + setup scaffold paths).

*(No `**Repo:**` line — single-repo workspace per session directive.)*

## User Review Required — RESOLVED (user directive, 2026-07-10)
- **DECIDED: simple content-hash variant.** The plan uses the content-hash overwrite variant (Scope §1). It will overwrite a bundled skill file in a workspace whenever it differs from the bundle — **including if the *user* hand-edited that bundled skill.** This is **accepted**: bundled Switchboard skills are generated control-plane, and user customization belongs in a *separate* (non-bundled) skill, which is never touched (the copy only writes files present in the bundle). The manifest-tracked variant (Scope §Optional) is **NOT chosen** — kept documented as a future option only.
- **DECIDED: blast radius signed off.** This changes file-write behavior on **every activation for ~4,000 installs**. Accepted with the mandatory guardrail that the content-hash overwrite is **fail-safe (skip-on-hash-error, never clobber blindly)** and per-file write errors are caught and logged. No further sign-off gate before build.
- Otherwise: None.

## Complexity Audit
### Routine
- Adding a content-hash compare to the copy decision (the `hashFile` sha256 helper already exists at `ControlPlaneMigrationService.ts:1081`, `public static`, reusable from `extension.ts`).
- Returning a written-file count so callers know whether `.agents` changed.
- Broadening the mirror trigger from version-gated to "version bump OR agents changed".

### Complex / Risky
- **Wrong-copy-site risk (the finding this review exists to catch).** The fix must land at **all three** deployment sites (`extension.ts:480` activation loop, `extension.ts:3562` `performSetup`, `ControlPlaneMigrationService._copyDirectoryRecursive`) **and** the activation-time mirror gate (`extension.ts:505`). Fixing only the migration service leaves the routine-activation freeze fully intact — the plan would pass its own tests while the loaded skill never changes.
- **Byte-compat on ~4,000 installs.** This code writes into every user's control plane on activation. A wrong compare could clobber files en masse — the hash compare must be exact and **fail-safe (skip on error, never overwrite blindly)**.
- **User-customization tradeoff** (see User Review). The simple variant overwrites hand-edited bundled skills — **decision made: accepted** (user directive 2026-07-10); manifest variant deferred.
- **Post-`.agents` mirror ordering.** `.claude` must regenerate *after* `.agents` refreshed, reading the fresh source — get the sequencing right at each site or `.claude` mirrors pre-refresh content. (Sites already order skill-copy before mirror; preserve that when the copy becomes content-aware.)
- **Packaging origin.** If the bundle isn't repackaged from current `.agents/`, the whole fix silently propagates stale content — the packaging check is load-bearing, not optional polish.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent activation / re-entrancy.** The migration path is guarded by the `_scaffolding` lock (`MultiRepoScaffoldingService.ts:53,166`); respect it so refresh isn't run twice concurrently. The `extension.ts` `activate()` path runs once per activation and is not re-entrant in practice, but the content-hash compare is idempotent regardless (identical → skip), so a double-run is safe.
- **Mirror-after-agents ordering.** Each site must regenerate `.claude` strictly after `.agents` is refreshed in the same pass, reading fresh source.

### Security
- No new trust boundary crossed — all reads/writes stay within already-validated Switchboard-managed directories (`isAllowedSwitchboardLocation` at the bootstrap path; `workspaceRoot`-scoped URIs at activation).
- Respect `AGENT_COPY_BLOCKLIST` (`ControlPlaneMigrationService.ts:1050`) and the `extension.ts` blocklist (`:3592-3607`) — blocklisted files stay skipped/removed under the new logic.

### Side Effects
- Overwrites hand-edited **bundled** skills on drift (documented tradeoff, see User Review). User-authored **non-bundled** skills are never touched — the copy iterates the bundle tree only.
- Mirror may now regenerate on more activations (whenever `.agents` changed). `generateClaudeMirror` is idempotent and cheap for ~25 skills; confirm cost is negligible (it may simply run every activation).
- `.agent_version.json` / `getLastCopiedAgentVersion` stamp keeps updating for telemetry, but **no longer gates content refresh**.

### Dependencies & Conflicts
- `ControlPlaneMigrationService.hashFile` (`:1081`, `public static async`) — present, reuse from both `ControlPlaneMigrationService` and `extension.ts` (which has no `crypto` import; call the shared helper rather than adding one).
- `generateClaudeMirror` (`ClaudeCodeMirrorService.ts:325`) — present, idempotent, returns `MirrorResult`; reuse unchanged.
- Read-only / permission-denied workspaces: catch write errors per file, log, continue — one unwritable file must not abort the whole refresh.
- **Bootstrap paradox:** this fix lives in compiled extension code, so the *first* delivery still requires the user to update the extension (and a version bump). Only *subsequent* skill-content fixes become bump-free. Document explicitly so it isn't mistaken for not working on the very first release.

## Dependencies
- None — no cross-session (`sess_…`) dependencies. Self-contained control-plane change.
- **Unblocks** every future skill/content fix (incl. the DB→local-`kanban-state` content correction) actually reaching workspaces.

## Adversarial Synthesis

**Risk Summary:** The dominant risk is fixing the wrong layer — the original scope patched only the migration-flow copy (`_copyDirectoryRecursive`), which does not run on routine activation, so the loaded `.claude/skills` would stay frozen while tests pass green; the fix must cover all three copy sites plus the version-gated activation mirror trigger (`extension.ts:505`). The second risk is byte-compat across ~4,000 installs: the content-hash overwrite must be fail-safe (skip-on-hash-error, never clobber blindly) and the destructive-overwrite-of-user-edits tradeoff must be a signed-off decision. Mitigations: land the change at every deployment site, make the mirror trigger content-aware not version-gated, reuse the existing sha256 `hashFile` helper with per-file try/catch, add a CI drift guard and a packaging-origin assertion so a stale bundle can never silently re-freeze propagation.

## Scope

### ✅ IN SCOPE
1. **Content-hash refresh at ALL THREE `.agents` copy sites (the core fix).**

   > **Superseded:** "Content-hash refresh for `.agents/` (the core fix). Add `overwriteIfDiffers?: boolean` to `_copyDirectoryRecursive`'s options … Pass `overwriteIfDiffers: true` on the `.agents` copy call (`:693-697`)."
   > **Reason:** `_copyDirectoryRecursive` is only the migration/multi-repo site (Site 4). The routine per-activation freeze is `extension.ts:480-501` (Site 1) and the setup freeze is `extension.ts:3562-3583` (Site 3). Content-hash logic added to only Site 4 does not reach the copy a normally-opened workspace loads.
   > **Replaced with:** apply the same content-hash "overwrite iff bundle content differs from workspace content" decision at **all three** sites:
   > - **Site 1** (`extension.ts:480-501`): replace the `stat`→skip branch so an existing skill file is overwritten when `hashFile(bundleSrc) !== hashFile(dest)`; skip (no write) if hashing throws.
   > - **Site 3** (`extension.ts:3562-3583`, `performSetup`): same content-hash decision for non-workflow files (workflow overwrite-on-version stays or is subsumed).
   > - **Site 4** (`ControlPlaneMigrationService._copyDirectoryRecursive`, `:1033`): add `overwriteIfDiffers?: boolean` to the options type; `shouldOverwrite = options.overwrite || (isWorkflowFile && options.overwriteWorkflows) || (options.overwriteIfDiffers && existsAndDiffers(sourcePath, targetPath))`; pass `overwriteIfDiffers: true` at the caller (`:693-697`). This subsumes the `overwriteWorkflows`/`needsAgentMigration` special-case for content that differs.
   > Reuse `ControlPlaneMigrationService.hashFile` (`:1081`) at all sites. **Not** version-gated at any site.

2. **Return / track what changed.** Each copy site reports whether ≥1 file was actually written (`_copyDirectoryRecursive` returns a written-file count/list; the `extension.ts` loops track a boolean), so the caller knows whether `.agents` changed this run.
3. **Regenerate `.claude/` when `.agents/` changed — at the activation site too.**

   > **Superseded:** "Regenerate `.claude/` when `.agents/` changed. Change the caller (`:728-730`) to run `generateClaudeMirror` when `needsAgentMigration || agentsChanged`."
   > **Reason:** `:728-730` is only the migration-service mirror trigger. The routine activation mirror is gated separately at `extension.ts:505` on `needsAgentRefresh` (version-only). Broadening only the migration caller leaves the activation mirror version-gated, so a content-only `.agents` change still won't rebuild the `.claude` the agent loads.
   > **Replaced with:** broaden **both** mirror triggers to "run when version changed **or** `.agents` changed this run":
   > - `extension.ts:505`: run `scaffoldProtocolLayers` (which calls `generateClaudeMirror`) when `needsAgentRefresh || agentsChanged`, where `agentsChanged` comes from the Site-1 loop. Alternatively, since `generateClaudeMirror` is idempotent and cheap for ~25 skills, run it unconditionally each activation (confirm cost).
   > - `ControlPlaneMigrationService.ts:728-730`: `needsAgentMigration || agentsChanged` (from Scope §2).

4. **Fail-safe on hash error.** If hashing either side throws, **skip** (do not overwrite) and log — never clobber a workspace file on an I/O error. Respect both blocklists (`ControlPlaneMigrationService.ts:1050`; `extension.ts:3592-3607`).
5. **Retroactive self-heal.** No migration script needed: on the first activation carrying this fix, every already-frozen workspace's stale bundled skills refresh automatically at Site 1 (unconditional, content-based), and the mirror rebuilds because `agentsChanged` is now true. Document this.
6. **Dev-repo drift guard (CI).** Add a check that the committed `switchboard/.claude/skills` equals `generateClaudeMirror(switchboard/.agents)` output (regenerate into a temp dir and diff), failing CI on drift — so the source repo can never commit a stale mirror again. Wire into the existing `.github/workflows/integration-tests.yml` as a new step (alongside `parity:check` / `push-routing:check`), e.g. `npm run mirror:check`.
7. **Packaging-origin check.** Verify the extension package build copies the current `.agents/` into the bundle (all copy sites read `extensionPath/.agents` or `context.extensionUri/.agents`; a stale bundle would refresh stale content). Add/confirm a build-time assertion or test. **Prerequisite, not polish** — a stale bundle defeats every other step silently.

### ⚙️ Optional — NOT CHOSEN (documented for the future only)
- **Manifest-tracked overwrite.** *Deferred per user decision 2026-07-10 — the simple content-hash variant (§1) is the chosen approach; do not implement this unless the "preserve user edits to bundled skills" requirement is later reinstated.* Record each bundled file's installed hash in a workspace manifest (mirroring the `.claude` `.switchboard-generated.json` invariant). On refresh, overwrite a file only if its current content still equals the last-installed hash (user hasn't edited it); if it diverges from both the last-installed and the new bundle hash, skip and warn. Preserves user edits AND self-heals untouched files. Would have to be applied at all three sites too.

### ⚙️ OUT OF SCOPE
- **Skill *content* correctness** (e.g. the DB-vs-local-`kanban-state` inconsistency in `create-feature-from-plans`/`group-into-features`). That is a separate edit on the single source; this plan only makes such edits *reach* workspaces. Track it separately.
- Changing the `.claude` transform (`buildSkillMd`, `MIRROR_MANIFEST`) — unchanged.
- Deleting stale skills removed from the bundle (no `--delete` semantics) — user-authored skills must survive; bundle removals are a separate concern.

## Proposed Changes

### `src/extension.ts` — `activate()` skill-seed loop (`:480-501`) — Site 1, the dominant fix
- **Context:** Runs unconditionally every activation; currently `stat(dest)`→skip for existing files, `copy {overwrite:false}` for new ones. This is why a normally-opened workspace never receives skill fixes.
- **Logic:** For each bundled skill file: if dest absent → copy (unchanged). If dest present → compute `ControlPlaneMigrationService.hashFile(src)` vs `hashFile(dest)`; overwrite iff they differ; skip on hash error. Track `agentsChanged = true` when any file is written.
- **Implementation:** Replace the `try { stat } catch { copy }` block with a hash-aware branch; accumulate `agentsChanged`. Reuse the shared `hashFile` (no `crypto` import needed in `extension.ts`).
- **Edge Cases:** hash throws → skip + log; blocklisted files unaffected; identical content → no write (idempotent, no spurious `agentsChanged`).

### `src/extension.ts` — activation mirror trigger (`:505`) — Site 2
- **Context:** `scaffoldProtocolLayers` (→ `generateClaudeMirror`) currently runs only `if (needsAgentRefresh)` (version-only).
- **Logic:** Run when `needsAgentRefresh || agentsChanged` (from Site 1), or unconditionally if per-activation cost is confirmed negligible.
- **Implementation:** Widen the `if` at `:505`; ensure it runs after the Site-1 loop so the mirror reads refreshed `.agents`.
- **Edge Cases:** `generateClaudeMirror` already idempotent + failure-isolated (try/catch at `:3332`); returns `MirrorResult` for logging.

### `src/extension.ts` — `performSetup` copy loop (`:3562-3583`) — Site 3
- **Context:** User-triggered setup; workflow files version-overwrite, others `stat`→skip. Ends with `scaffoldProtocolLayers(...,'Setup')` (`:3613`).
- **Logic:** Apply the same content-hash overwrite for non-workflow files.
- **Implementation:** Mirror the Site-1 change inside this loop; the trailing `scaffoldProtocolLayers` already rebuilds the mirror.
- **Edge Cases:** identical to Site 1; blocklist deletion at `:3592-3607` still runs after.

### `src/services/ControlPlaneMigrationService.ts` — `_copyDirectoryRecursive` (`:1033`) + caller (`:691-698`) + mirror trigger (`:728-730`) — Site 4
- **Context:** Migration / multi-repo control-plane path only.
- **Logic:** Add `overwriteIfDiffers?: boolean`; `shouldOverwrite = options.overwrite || (isWorkflowFile && options.overwriteWorkflows) || (options.overwriteIfDiffers && existsAndDiffers(sourcePath, targetPath))`. `existsAndDiffers` hashes both, returns `false` (skip) on error. Return written-file count. Caller passes `{ overwrite:false, overwriteIfDiffers:true }` (drop redundant `overwriteWorkflows`) and captures `agentsChanged`. Mirror trigger → `needsAgentMigration || agentsChanged`.
- **Implementation:** Localized to this file; reuse `hashFile` (`:1081`).
- **Edge Cases:** `AGENT_COPY_BLOCKLIST` still honored; per-file write errors caught + logged, loop continues; `_scaffolding` lock respected upstream.

### CI + packaging
- **`.github/workflows/integration-tests.yml`:** add a `mirror:check` step (regenerate mirror from `.agents` into a temp dir, diff against committed `.claude/skills`, fail on drift).
- **Packaging build:** assert/confirm the bundled `.agents/` equals the repo `.agents/` at package time.
- **Version bump** so this fix ships (bootstrap only; subsequent skill fixes need no bump).

## Verification Plan

### Automated Tests
- **Unit (`_copyDirectoryRecursive`, Site 4):** with `overwriteIfDiffers:true` → overwrites an existing target whose content differs; **skips** an identical target; **never** creates a file absent from the source; **skips (not overwrites)** when hashing throws.
- **Unit (`extension.ts` Site 1 & 3 hash-aware copy):** existing dest with differing bundle content → overwritten; identical → not written + `agentsChanged` stays false; hash error → skipped + logged.
- **Integration (routine activation path — the real target):** seed a workspace `.agents/skills/x/SKILL.md` with STALE content + a NEWER bundle, run **activation** with **no version change** → workspace `.agents` skill AND regenerated `.claude` skill both match the bundle (checksum). This exercises Sites 1+2 specifically, since Site 4 does not run here.
- **Integration (migration path, Site 4):** same seed via the control-plane/multi-repo scaffold entry → both trees match bundle.
- **CI drift guard green:** committed `.claude/skills` == regenerated-from-`.agents`.

*(Session directive: SKIP COMPILATION and SKIP TESTS for this planning pass — `npm run compile` and the scaffolding suite are listed as build-time gates for the implementer, not run now.)*

### Manual / behavioral (the real proof)
- Reproduce the reported failure on the **routine activation path**: change a skill in the bundle **without** bumping the skill's own version, activate in a previously-frozen workspace (e.g. the Gitlab workspace), and confirm the `.claude/skills/<name>/SKILL.md` that Claude Code loads reflects the change — no manual rsync, no version bump of the skill.
- Confirm a user-authored (non-bundled) skill in that workspace is untouched.
- Confirm all four trees agree by checksum per layer after activation.

## Effort note
One focused session, but broader than the original estimate: the copy-decision change now lands at three sites plus two mirror triggers (all small and localized, sharing one `hashFile` helper), and the CI drift guard + packaging assertion are the diligence that stops regressions. Materially higher leverage than any content fix — it's the layer that made all five prior content fixes invisible.

## Uncertain Assumptions
None requiring external research. Every claim in this plan was verified directly against the source in this session (`extension.ts:220-235,402-521,3305-3336,3539-3613`; `ControlPlaneMigrationService.ts:667-801,1033-1084`; `ClaudeCodeMirrorService.ts:301-390`; `.github/workflows/integration-tests.yml`). The `hashFile` helper, `generateClaudeMirror` idempotency, the three copy sites, and the version-only gates are confirmed in code, not assumed.

---

**Recommendation: Send to Lead Coder** (Complexity 7 — multi-file coordination across `extension.ts` activation + setup + `ControlPlaneMigrationService`, writing into ~4,000 installs on activation; requires the byte-safety and packaging diligence a senior implementer will enforce).

---

## Completion Report (implemented 2026-07-10)

Replaced the skip-if-exists / version-gated freeze with content-hash self-healing at all three `.agents` copy sites plus both mirror triggers. `src/extension.ts` activation skill-seed loop (Site 1) now hashes bundle vs workspace via the shared `ControlPlaneMigrationService.hashFile` and overwrites on diff (skip-on-hash-error, never clobber blindly), tracking `agentsChanged`; the activation mirror trigger (Site 2) widened to `needsAgentRefresh || agentsChanged`. The `performSetup` copy loop (Site 3) got the same content-hash decision for non-workflow files. `ControlPlaneMigrationService._copyDirectoryRecursive` (Site 4) gained an `overwriteIfDiffers` option + fail-safe `_existsAndDiffers` helper, returns a written-file count, and its caller now passes `overwriteIfDiffers:true` (subsuming the old `overwriteWorkflows` special-case) with the mirror trigger widened to `needsAgentMigration || agentsChanged`. Added a `mirror:check` CI gate (`scripts/check-claude-mirror.js` + `.github/workflows/integration-tests.yml` step) that regenerates the mirror from `.agents` and diffs against committed `.claude/skills`, plus a packaging-origin assertion (`.vscodeignore` re-includes `.agents/**` and `.agents` is not gitignored). Regenerated the stale committed `switchboard-manage` mirror and bumped the version 1.7.6 → 1.7.7 (bootstrap delivery). Added unit tests 12-14 covering overwrite-on-diff, idempotent skip-on-identical, and never-touch-absent-from-source. Per session directive, compilation and the automated test suite were skipped; `mirror:check` was run directly against the pre-existing `out/` build and passes green. Files changed: `src/extension.ts`, `src/services/ControlPlaneMigrationService.ts`, `src/test/agent-version-migration.test.js`, `scripts/check-claude-mirror.js` (new), `.github/workflows/integration-tests.yml`, `package.json`, `package-lock.json`, `.claude/.switchboard-generated.json`, `.claude/skills/switchboard-manage/SKILL.md`. No issues encountered.
