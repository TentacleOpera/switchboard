# Fix skill/instruction propagation — content-hash reconcile that honors retirements

## Goal

Make skill and instruction changes in the switchboard source (`.agents/` + `MIRROR_MANIFEST`) reliably propagate to every workspace — **additions, edits, AND deletions** — without requiring an extension version bump. Today only version bumps trigger a refresh, `overwrite:false` means edits and deletes never reach existing workspaces, and the result is silent drift (verified: 3 retired skills stranded in a live workspace's `.claude`).

### Problem Analysis (background + root cause)

`switchboard` is the source of truth. Two mechanisms copy it into each workspace, and both are gated wrong:

1. **`.agents` copy** — `ControlPlaneMigrationService._copyDirectoryRecursive(bundledAgentDir, <ws>/.agents, { overwrite: false, overwriteWorkflows: needsAgentMigration })` (~`ControlPlaneMigrationService.ts:692`). `overwrite:false` means once a skill file exists in a workspace it is **frozen** — source edits never land — and nothing ever **deletes** a skill removed from the bundle.
2. **`.claude` mirror** — `ClaudeCodeMirrorService.generateClaudeMirror` transforms `.agents` → `.claude` (frontmatter per `MIRROR_MANIFEST`, plus a dynamic scan of `.agents/skills/`), gated on `needsAgentMigration` (version change). It **does** have retirement logic — a ledger (`.switchboard-generated.json`) drives removal of generated skills no longer produced (`ClaudeCodeMirrorService.ts:487`) — but it only runs on a version bump.

**Net:** a fix without a version bump reaches nobody. A deletion reaches nobody, ever. Concrete evidence found this session:
- 3 skills retired from source still live in `Gitlab/.claude`: `switchboard-feature` (a dropped `improve-feature` alias), `switchboard-remote-notion` (source is a `switchboard_remote_notion.md.migrated.bak` — a retirement marker), `switchboard-split` (no source, not in manifest). *(Removed manually as a stopgap; this plan prevents recurrence.)*
- `rearrange-feature` exists in `switchboard/.agents/skills/` but is **missing from `switchboard/.claude`** — the source repo's own mirror is stale (proves the version-gate even bites the dev repo).
- Because agents naturally edit `.claude` (the mirror), not `.agents`, mirror-only edits get silently reverted on the next regen — lost work, invisible to `.agents`-reading agents.

### Current State (verified this session — code read, not assumed)

A prior implementation pass already landed most of the edit/mirror work. The plan's original "Proposed Changes" sections 1 (edit path) and 2 (mirror ungating) describe work that is **already done in `main`**. Verified against current source:

- **`.agents` edit propagation — DONE.** `extension.ts:320–410` `refreshWorkspaceControlPlane` runs a content-hash skill seed loop AND a content-hash workflow seed loop every activation (not version-gated). On hash mismatch it overwrites; on dest-absent it copies. `ControlPlaneMigrationService._copyDirectoryRecursive` (the bootstrap path at `:694`) also carries `{ overwrite: false, overwriteIfDiffers: true }` and `_existsAndDiffers` (`:1091`) does the sha256 compare. Edits land without a version bump.
- **`.claude` mirror ungating — DONE.** `ControlPlaneMigrationService.ts:731` gates the mirror regen on `needsAgentMigration || agentsChanged`. `agentsChanged` is set by the hash-seed loops whenever any bundle file was written, so a content-only fix with no version bump still rebuilds `.claude`.
- **`.claude` retirement ledger — DONE.** `ClaudeCodeMirrorService.ts:486–508` removes ledger-tracked `.claude/skills/<name>/` dirs whose `name` was not regenerated this run, with a path-traversal guard and "leave the dir if non-empty (user files)" semantics. User-authored `.claude` skills are never touched.
- **`.agents` deletion path — STILL MISSING.** There is no bundle-membership ledger for `.agents`. `cleanupLegacyAgentFiles` (`extension.ts:3599`) only removes a **hardcoded** list of legacy files (`rules/no_git_for_agents.md`, `rules/switchboard_modes.md`, `handoff*.md`). A skill removed from the bundle stays in every workspace's `.agents/` forever — the original "deletions reach nobody, ever" failure is **not yet fixed**. This is the single remaining functional gap.
- **Dev-repo self-consistency — NOT DONE.** Verified on disk this session: `rearrange-feature` exists in `switchboard/.agents/skills/` but is absent from `switchboard/.claude/skills/`. `switchboard/.agents/skills/switchboard_remote_notion.md.migrated.bak` still present (clutter in the source of truth). No CI check exists.
- **Drift self-check — NOT DONE.** No activation-time bundle-vs-workspace delta log.

## Metadata

**Tags:** backend, reliability, bugfix
**Complexity:** 5

## User Review Required

Yes. Review centers on one design decision: introducing a new on-disk ledger file (`.agents/.switchboard-bundled.json`) into every workspace's `.agents/` tree to drive `.agents` deletions. This is a new persistent artifact in user-visible workspace state and the discriminator for "delete vs preserve" — a wrong call here can delete user-authored skills. Review the ledger semantics in Proposed Changes §1 before implementation. Also review whether the dev-repo CI check (§4) should be a hard gate or warn-only.

## Complexity Audit

### Routine
- Dev-repo cleanup: delete `switchboard/.agents/skills/switchboard_remote_notion.md.migrated.bak`, regenerate `switchboard/.claude` from `.agents` (one `generateClaudeMirror` call). Pure mechanical.
- Drift self-check: one log line comparing bundle skill-set to workspace skill-set on activation. No state, no deletion authority.
- Re-scoping the plan's obsolete sections to "already done" callouts — documentation only.

### Complex / Risky
- **`.agents` bundle-membership ledger + delete path** — the one genuinely new pattern. Must distinguish bundle-tracked files from user-authored files with zero false positives; a bug here deletes user work. Mirrors the proven `.claude` ledger pattern but applied to a directory that, unlike `.claude`, is also a legitimate user-editing surface.
- **Ledger lifecycle vs crash safety** — if the ledger is written after the copy phase and activation crashes mid-reconcile, the next run sees a stale ledger and could delete a file that was just added. Needs atomic write + safe-default-on-missing-ledger.
- **First-run migration** — existing workspaces have no ledger. First run with no ledger must NOT delete anything (treat as "nothing proven tracked yet"); the ledger only starts gating deletes from the second run onward. This is a behavioral subtlety easy to get wrong.
- **CI check for dev mirror** — new CI surface; needs to run `generateClaudeMirror` and diff, which means the CI environment must reproduce the generation faithfully.

## Edge-Case & Dependency Audit

- **Race Conditions:** Concurrent activations of the same workspace (two VS Code windows) could race the ledger write. The hash-seed loops are already idempotent (hash match = no-op); the ledger write must be atomic (write temp + rename) so a partial ledger never persists. Low probability, high blast radius if it corrupts the discriminator.
- **Security:** The ledger must never be a vector for path traversal. The `.claude` retirement code already guards with `staleDir.startsWith(skillsRoot + path.sep)` (`ClaudeCodeMirrorService.ts:501`) — the `.agents` delete path must apply the same guard before any `rmSync`/`unlinkSync`. Ledger file itself is JSON in a user-writable dir; treat as untrusted input (validate shape, validate paths are inside `.agents/`).
- **Side Effects:** A wrong delete removes a user-authored skill with no undo beyond git (and `.agents/` is frequently gitignored in consumer workspaces). Mitigation: log every deletion at warn level; never delete a directory, only files (matches `.claude` `rmdirSync`-with-fallback pattern at `:503`); leave user files in place even if the dir entry is in the ledger.
- **Dependencies & Conflicts:** Touches `extension.ts` `refreshWorkspaceControlPlane` (add post-seed reconcile-and-prune step) and introduces a new ledger module (or extends `ControlPlaneMigrationService`). No conflict with `cleanupLegacyAgentFiles` — that path remains for its hardcoded legacy list; the new ledger is the general-case delete path. The plan `codify-plan-autosplit-rule-across-authoring-surfaces.md`'s rule-text edits propagate via the already-done edit path; this plan no longer blocks it (the dependency was on the edit path, which is shipped).

## Dependencies

None blocking. Supersedes the ad-hoc reconcile step noted in `codify-plan-autosplit-rule-across-authoring-surfaces.md` — that plan's rule-text edits still propagate only once the (already-shipped) edit path runs; the remaining `.agents` delete path in this plan does not gate it further.

## Adversarial Synthesis

Key risks: (1) the `.agents` bundle-membership ledger is the sole discriminator for deletes — a bug or corrupt ledger deletes user-authored skills with no undo in gitignored consumer workspaces; (2) first-run-with-no-ledger must default to "delete nothing," a behavioral subtlety easy to invert by accident; (3) the plan as originally written is largely obsolete (edit + mirror paths already shipped), so an implementer who doesn't re-read current code will re-implement existing work and risk regressions. Mitigations: mirror the proven `.claude` ledger semantics exactly (path-traversal guard, leave-non-empty-dirs, atomic write, safe default on missing ledger); prefix all deletes with warn-level logs; gate the whole prune step behind a "ledger exists and is well-formed" check.

## Proposed Changes

> **Superseded:** Original §1 "`.agents` reconcile by content-hash + bundle-membership ledger" described both the edit path and the delete path as net-new work.
> **Reason:** The edit path (content-hash overwrite on mismatch, copy on absent) is already implemented in `extension.ts:320–410` `refreshWorkspaceControlPlane` and `ControlPlaneMigrationService._copyDirectoryRecursive` (`:1036`, `overwriteIfDiffers: true`). Re-implementing it risks double-write and regressions.
> **Replaced with:** §1 below covers ONLY the missing piece — the bundle-membership ledger and the delete path. The edit path is treated as already shipped and is referenced, not re-authored.

> **Superseded:** Original §2 "`.claude` mirror ungated + retirement honored" described ungating `generateClaudeMirror` and wiring the retirement ledger to run on content change.
> **Reason:** Already shipped. `ControlPlaneMigrationService.ts:731` gates on `needsAgentMigration || agentsChanged`; `ClaudeCodeMirrorService.ts:486–508` runs the ledger-based retirement every regen. No code change needed.
> **Replaced with:** §2 below is a no-op confirmation — no implementation work. Listed for traceability so an implementer does not re-touch the mirror gate.

> **Superseded:** Original §3 "Preserve user skills (safety invariant)" implied the invariant was not yet enforced.
> **Reason:** The `.claude` side already enforces it via the ledger (only ledger-tracked names are deleted; user dirs left if non-empty). The `.agents` side has no delete path at all today, so user skills are safe by absence-of-path — but once §1 adds the `.agents` delete path, the invariant must be enforced there too.
> **Replaced with:** §3 below specifies the invariant as a hard requirement on the new `.agents` delete path, not a separate work item.

### 1. `.agents` bundle-membership ledger + delete path (the actual remaining work)
- **Context:** `extension.ts` `refreshWorkspaceControlPlane` already seeds/overwrites `.agents` files by content hash. It does NOT delete files removed from the bundle. `cleanupLegacyAgentFiles` only handles a hardcoded legacy list.
- **Logic:** After the existing seed loops in `refreshWorkspaceControlPlane` (`extension.ts:~410`, after the workflow seed loop completes), add a prune step:
  1. Build the **current bundle set** — the set of relative paths under `.agents/` that the bundle shipped (skills + workflows, excluding `AGENT_COPY_BLOCKLIST` entries). This is already enumerated by the `crawlDirectory` calls at `:331` and `:376`; reuse those results rather than re-crawling.
  2. Read the **bundle-membership ledger** at `<root>/.agents/.switchboard-bundled.json`. If absent or malformed → **skip the prune step entirely** (safe default: nothing proven tracked, delete nothing). This is the first-run guard.
  3. For each path in the ledger's `files` array: if it is NOT in the current bundle set AND it exists on disk under `<root>/.agents/` → delete the file (warn-level log). Apply the path-traversal guard: resolved path must start with `<root>/.agents/` + path.sep. Never delete a directory; if the file's parent dir becomes empty, leave it (matches `.claude` semantics).
  4. Write the new ledger atomically: build the new `files` array from the current bundle set, write to a temp file in `<root>/.agents/`, `fs.rename` over the ledger. Atomic rename ensures a crash never leaves a half-written discriminator.
- **Implementation:**
  - New helper, e.g. `pruneRetiredBundleFiles(root, currentBundlePaths)` in `extension.ts` near `refreshWorkspaceControlPlane`, or a static on `ControlPlaneMigrationService` to keep migration logic colocated. Prefer the latter for testability.
  - Ledger shape: `{ "generator": "SwitchboardControlPlane", "version": "<ext version>", "generatedAt": "<iso>", "files": ["skills/foo.md", "workflows/bar.md", ...] }` — mirrors the `.claude` `GENERATED_MANIFEST_FILE` shape for consistency.
  - Reuse `ControlPlaneMigrationService.hashFile` / `crawlDirectory` — do not duplicate.
  - The ledger file itself (`/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/.switchboard-bundled.json`) MUST be excluded from the bundle set (it is generated, not bundled) — add to `AGENT_COPY_BLOCKLIST` or skip by name in the seed loops.
- **Edge Cases:** First-run (no ledger → no deletes). Crash mid-write (atomic rename → either old or new ledger, never partial). User-authored skill with the same relative path as a retired bundle skill (the ledger says it was bundle-tracked, so it WILL be deleted — this is correct: the user overwrote a bundle file, and the bundle has now retired it; if the user wants to keep it they should rename it. Document this in the drift log). Concurrent activations (atomic rename + idempotent hash loops = safe).

### 2. `.claude` mirror ungated + retirement honored — NO-OP (already shipped)
- **Context:** Confirm only. `ControlPlaneMigrationService.ts:731` `if (needsAgentMigration || agentsChanged) { generateClaudeMirror(...) }` already runs the mirror on content change. `ClaudeCodeMirrorService.ts:486–508` already prunes ledger-tracked `.claude` skills not regenerated this run.
- **Logic:** No change. Implementer should verify with the test in Verification Plan §1 and stop if it already passes.
- **Edge Cases:** None new. Existing path-traversal guard at `:501` covers it.

### 3. Preserve user skills (safety invariant) — requirement on §1, not separate work
- **Context:** The `.claude` side already enforces this. The `.agents` side must enforce it once §1 lands.
- **Logic:** The §1 prune step deletes ONLY paths in the ledger's `files` array that are absent from the current bundle. A user-authored skill (never in the bundle → never in the ledger) is never in the candidate set. The invariant holds by construction of the candidate set, not by a runtime check — but add a defensive assertion: log a warning if a to-be-deleted file's content hash matches any current bundle file (would indicate a ledger/bundle desync, not a user file).
- **Edge Cases:** A user who copied a bundle file to a new name (e.g. `skills/my-foo.md` derived from `skills/foo.md`) is safe — the new name was never in the ledger. A user who edited a bundle file in place and the bundle then retired it — the file is deleted (correct per ledger semantics; document in drift log).

### 4. Dev-repo self-consistency + cleanup
- **Context:** Verified this session: `switchboard/.claude/skills/` is missing `rearrange-feature` (present in `.agents/skills/`); `switchboard/.agents/skills/switchboard_remote_notion.md.migrated.bak` still litters the source of truth.
- **Logic:**
  1. Delete `switchboard/.agents/skills/switchboard_remote_notion.md.migrated.bak` from the source repo.
  2. Regenerate `switchboard/.claude` from `switchboard/.agents` by invoking `generateClaudeMirror(switchboardRoot, version)` once (or by running the extension's activation against the dev repo). Confirm `rearrange-feature` now appears in `.claude/skills/`.
  3. Add a CI check (GitHub Actions or existing CI) that runs `generateClaudeMirror` on `switchboard/.agents` and `git diff --exit-code switchboard/.claude` — non-zero exit fails the build. This catches mirror lag before it ships.
- **Implementation:** The CI check needs the generator runnable in CI. If `generateClaudeMirror` is not easily callable from a standalone script, add a thin `scripts/verify-claude-mirror.ts` entry that imports and invokes it. Confirm the import path works under the CI toolchain before relying on it.
- **Edge Cases:** The CI check must not modify `.claude` — run the generator into a temp dir and diff, OR run in-place and `git checkout` afterward. In-place + diff is simpler but leaves the working tree dirty on failure; prefer temp-dir + diff for CI cleanliness.

### 5. Drift self-check on activation (diagnostic)
- **Context:** No activation-time visibility into bundle-vs-workspace delta today. Future stranding is silent.
- **Logic:** At the end of `refreshWorkspaceControlPlane`, log one line: `[Switchboard] .agents drift: <N> bundle files missing, <M> workspace files not in bundle, <K> retired files pruned.` Use the sets already computed for the seed + prune steps — no extra I/O. Log at info level for normal drift, warn if `K > 0` (deletions happened) or `N > 0` (bundle files failed to seed).
- **Implementation:** Pure logging, no new state. Reuse the `currentBundlePaths` set from §1 and the `skillFiles`/`workflowFiles` arrays from the seed loops.
- **Edge Cases:** None. Diagnostic only; never throws.

## Verification Plan

> Per session directive: NO compilation steps and NO automated tests are run as part of this plan. Verification is manual/observational only. The "Automated Tests" subsection is omitted by directive.

1. **Edit propagation (confirm already-shipped behavior)** — change a skill body in `switchboard/.agents` with NO version bump → open an existing workspace → on activation its `.agents` and `.claude` both update. Observe via `diff` or the drift log from §5. If this already works (expected), no code change was needed for the edit path.
2. **Delete propagation (the new §1 path)** — remove a test skill from the bundle → run activation against a workspace that had it → confirm it disappears from the workspace's `.agents/`; run a second activation → confirm a user-authored skill in the same dir is still present. The first activation after the bundle change is the one that prunes (ledger from prior run lists the retired file).
3. **Add propagation** — add a new source skill → confirm it appears downstream on next activation. Also confirm `rearrange-feature` reaches `switchboard/.claude` after §4 step 2.
4. **User-skill safety** — author a workspace-only skill under `.agents/skills/my-test.md` (a name never in the bundle) → run several activations including one that prunes a different retired skill → confirm `my-test.md` is never modified or deleted and never appears in the drift log's "pruned" count.
5. **First-run safety** — delete `.agents/.switchboard-bundled.json` from a workspace → run activation with a deliberately retired bundle file present on disk → confirm NO deletion occurs (safe default) and the ledger is regenerated listing the current bundle set; a subsequent activation with the file still retired then prunes it.
6. **Dev consistency** — `switchboard/.claude` regenerates from `.agents` with zero diff (after §4 step 2); the CI check (§4 step 3) passes; `switchboard_remote_notion.md.migrated.bak` is gone from `.agents/skills/`.
7. **Idempotency** — a second activation with no source change is a pure no-op (all hashes match, ledger unchanged, drift log reports 0/0/0).
8. **Crash safety (manual)** — interrupt activation (kill the extension host) between the seed loop and the ledger rename → confirm the ledger is either the old or new version, never partial (atomic rename); confirm the next activation completes cleanly.

## Definition of Done

- Source edits, additions, and deletions propagate to existing workspaces without a version bump. (Edits/adds: already shipped. Deletes: new §1 work.)
- Retired skills are removed downstream; user-authored skills are never touched.
- `switchboard/.claude` matches `switchboard/.agents` (dev mirror self-consistent), enforced by a CI check.
- The `.agents` bundle-membership ledger is written atomically and defaults to "delete nothing" on first run / missing ledger.
- An activation drift-report makes any future divergence visible.

## Uncertain Assumptions

No external (bucket-3) uncertainties. All findings in this plan were verified by reading the current source (`extension.ts`, `ControlPlaneMigrationService.ts`, `ClaudeCodeMirrorService.ts`) and on-disk state of `switchboard/.agents` and `switchboard/.claude`. No web research is needed.

## Completion Report

Implemented the remaining `.agents` bundle-membership ledger + delete path (§1), the activation drift self-check (§5), and the dev-repo self-consistency cleanup (§4). §2 (`.claude` mirror ungating) and §3 (user-skill safety) required no new code — §2 already shipped, §3 is enforced by construction (only ledger-tracked paths are ever pruned) plus a defensive content-hash desync warning added to the prune step. Files changed: `src/services/ControlPlaneMigrationService.ts` (new `pruneRetiredBundleFiles` static method — reads `<root>/.agents/.switchboard-bundled.json`, deletes only prior ledger entries absent from the current bundle, path-traversal guard, never deletes dirs/the ledger itself, atomic temp+rename write, first-run missing-ledger → deletes nothing; ledger filename added to `AGENT_COPY_BLOCKLIST`); `src/extension.ts` (`refreshWorkspaceControlPlane` now hoists `skillFiles`/`workflowFiles`, and after the seed loops calls `pruneRetiredBundleFiles` with the unioned `skills/`+`workflows/` bundle set, then logs the `.agents drift:` line); `src/services/ClaudeCodeMirrorService.ts` (added `rearrange-feature` to `MIRROR_MANIFEST` so the mirror generator produces it — the root cause of its absence from `.claude/skills/`); deleted `.agents/skills/switchboard_remote_notion.md.migrated.bak`; created `.claude/skills/rearrange-feature/SKILL.md` via the exact `buildSkillMd` transform (description JSON-quoted per `escapeYamlValue` because of the apostrophe in "feature's"). The CI drift guard (§4 step 3) was already in place (`scripts/check-claude-mirror.js` + `npm run mirror:check` in `integration-tests.yml`). No compilation or automated tests were run per session directive; verification is observational via the drift log on next activation and the existing CI mirror check. No issues encountered.

## Review Findings

In-place reviewer pass (2026-07-20). Stage 1 (Grumpy) + Stage 2 (Balanced) run; one CRITICAL fix applied. The §1 ledger/prune implementation is correct: first-run missing-ledger → no deletes, atomic temp+rename write, path-traversal guard (`abs.startsWith(agentsDir + path.sep)`), never deletes dirs/the ledger itself, defensive desync hash warning, cross-platform posix normalization (`rel.split(path.sep).join('/')` in extension.ts, `rel.split('/')` in the resolver). §3 user-skill safety holds by construction (only ledger-tracked paths are candidates). No orphaned references to the deleted `.migrated.bak`. **CRITICAL fix applied:** the dev-repo `.claude/skills` mirror was stale for 5 files (`deep-planning`, `improve-plan`, `switchboard-cloud`, `switchboard-memo`, `switchboard-remote`) whose `.agents` sources were edited in the same commit but whose mirror was never regenerated — `npm run mirror:check` failed (the exact failure mode this plan exists to prevent). Regenerated all 5 from `.agents` via a standalone script replicating `buildSkillMd`/`escapeYamlValue`/`parseSource` exactly (no compilation, per directive); verified idempotent and that the autosplit text now lands in the mirror. `rearrange-feature/SKILL.md` confirmed byte-identical to the transform output (the local `mirror:check` "missing from regenerated" for it is a stale-`out/` artifact only — CI runs `npm run compile-tests` first, which includes the new manifest entry). Files changed by review: `.claude/skills/{deep-planning,improve-plan,switchboard-cloud,switchboard-memo,switchboard-remote}/SKILL.md`. Remaining risks: (1) `mirror:check` was not fully run against a fresh compile (directive forbids compilation) — CI will be the ground truth on next PR; (2) pre-existing Windows blocklist-match bug for `personas/switchboard_operator.md` (uses `/` but `path.join` produces `\` on Windows) is out of scope and not touched by this plan; the new `.switchboard-bundled.json` entry has no separator so it is cross-platform safe.

