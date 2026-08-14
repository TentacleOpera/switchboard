# The mirror generator deletes shipped skill files silently, and its drift check prints the one remedy that causes the deletion

## Goal

Make `.claude/skills` mirror divergence **loud and non-destructive**: stop `generateClaudeMirror`'s prune loop from unlinking generated skill files without a trace, and stop `mirror:check` from printing a single remedy that is correct for two of its three failure buckets and destructive for the third. Both changes are backstops for a defect that already happened — the `delegates` skill (see `mirror-check-red-delegates-skill-missing-manifest-entry.md`), where a missing manifest entry put a working skill on a deletion path and the failing check's own instructions performed the deletion.

### Problem Analysis

**Correction to the framing this plan was proposed under.** The guard originally suggested — "a check that every `.claude/skills/*/SKILL.md` has a `MIRROR_MANIFEST` entry" — **already exists and already works.** `scripts/check-claude-mirror.js` regenerates the mirror into a temp root and computes three buckets against the committed tree:

```js
const missing  = committedFiles.filter(f => !generatedSet.has(f));   // committed but NOT regenerated  ← the orphan case
const extra    = generatedFiles.filter(f => !committedSet.has(f));   // regenerated but not committed
const drifted  = [/* same path, different sha256 */];
```

The `missing` bucket is exactly the orphan detector, and it is what caught `delegates`. Nothing needs building there. **Detection is not the gap.** The gap is what happens on either side of it: the generator's response to divergence is a silent delete, and the check's response is a misdirecting instruction. This plan addresses those two, and nothing else.

---

#### Defect 1 — the prune loop unlinks shipped state with no diagnostic

`src/services/ClaudeCodeMirrorService.ts:503-525`, the stale-mirror cleanup:

```ts
for (const prev of prevSkills) {
    if (!prev?.name || regenerated.has(prev.name)) continue;
    const staleDir = path.join(skillsRoot, prev.name);
    if (!staleDir.startsWith(skillsRoot + path.sep)) continue; // path-traversal guard
    fs.rmSync(path.join(staleDir, 'SKILL.md'), { force: true });
    try { fs.rmdirSync(staleDir); } catch { /* non-empty (user files) — leave the dir */ }
}
```

The loop is correct in intent — without it, retired commands stay user-invokable in Claude Code forever on existing installs. Three problems with its execution:

1. **It names nothing.** No log line records which skills were deleted. `MirrorResult` is `{status, reason, skillsWritten}` — there is no field for it, and the sole caller surfaces only those three (`extension.ts:3918-3919`: `outputChannel?.appendLine('[…] .claude/skills mirror: ${m.status} — ${m.reason}')`). A deletion leaves the same output line as a clean run.
2. **It unlinks rather than archives.** `.claude/skills/` is generated content on a published extension with ~4,000 installs, so it is shipped state. This project's own rule for shipped state is to *archive* legacy files as `*.migrated.bak` rather than unlink them — a convention already established and contract-tested elsewhere in this codebase (`src/standalone/hostServices.ts:231-233`, guarded by `standalone-secrets-bridge-contract.test.js`). The prune loop predates or ignores it.
3. **It cannot fully distinguish a retirement from a divergence.**

   > **Superseded:** "It cannot distinguish a retirement from a divergence. At runtime the state is identical in both cases: the ledger says 'I wrote X', the manifest produces nothing for X. Whether that is *'the entry was deliberately retired'* (delete is right) or *'the entry was never added and this file is real'* (delete is data loss) is not recoverable from the state."
   > **Reason:** Factually wrong in one direction, and verified so against the live fixture. The ledger entries are `{source, name, relPath}` — `.claude/.switchboard-generated.json:157-159` carries `"source": "skills/delegates"` — so the generator *can* ask whether `.agents/<source>` still exists. That answer is **one-sided but real**: if the source is gone, the skill is definitely retired; if the source is still on disk (which it is, right now, at `.agents/skills/delegates/SKILL.md`), the case is genuinely ambiguous, because a manifest entry can also be retired deliberately while the `.agents/` document is kept (`switchboard-orchestrator` is exactly that shape — deliberately absent from `MIRROR_MANIFEST`, source retained).
   > **Replaced with:** The loop can prove "definitely retired" but can never prove "definitely a mistake". Because the ambiguous branch is the one that loses data, it must still not silently choose deletion — the archive stays for **both** branches. The discriminator is used only to make the diagnostic specific: source-still-present is the signature of a missing manifest entry, and the log says so instead of hedging.

The `delegates` case is what this looks like in practice: ledger 48, manifest 47, one working skill on the deletion path, and nothing anywhere that would have said so.

**The deletion is visible to the user immediately, and still unexplained.** Per SQ6 of `docs/claude_code_project_skills_and_configuration_architecture.md`, Claude Code has watched `.claude/skills/` with a file-watcher since 2.1.0 and hot-reloads it mid-session. So the prune does not wait for a restart: an extension activation while a session is open makes the skill disappear from that live session on the next turn. The user gets the symptom instantly and the diagnosis never — which is exactly the wrong way round, and is why the fix is about the *record*, not the timing.

#### Defect 2 — one remedy for three buckets, wrong for the destructive one

The check prints a single header regardless of which bucket fired (`scripts/check-claude-mirror.js:145-149`):

```js
console.error('❌ mirror:check — .claude/skills drift detected. Run the extension activation (or `generateClaudeMirror` on the repo root) and commit the regenerated mirror.');
if (missing.length)  console.error(`  Missing from regenerated (committed only): …`);
if (extra.length)    console.error(`  Extra in regenerated (not committed): …`);
if (drifted.length)  console.error(`  Content drift: …`);
```

The three buckets have **opposite** remedies:

| Bucket | Means | Correct remedy |
| :--- | :--- | :--- |
| `drifted` | committed mirror is stale against a current manifest | regenerate and commit — the printed remedy is right |
| `extra` | manifest gained an entry, mirror not yet committed | regenerate and commit — the printed remedy is right |
| `missing` | a committed mirror the generator does **not** produce | **make the generator produce it.** Regenerating *deletes the file* and turns the check green |

> **Superseded:** the `missing` remedy stated as, flatly, "add the manifest entry."
> **Reason:** Incomplete, and incompleteness here reproduces the original defect in a new place. `missing` has **two** causes, not one. (a) `MIRROR_MANIFEST` has no entry for the skill — the `delegates` case. (b) An entry exists but its `source` no longer resolves under `.agents/` (moved, renamed, deleted): `resolveSourceFile` returns `null` and `ClaudeCodeMirrorService.ts:451-453` does `continue`, so nothing is generated and the committed mirror lands in `missing` exactly as in case (a). A reader in case (b) who follows "add the manifest entry" finds the entry already there and is stuck — the check would print its shiny new text and still misdirect.
> **Replaced with:** the `missing` remedy names both causes and gives the one-line test that separates them: *does `.agents/<source>` exist?* If yes → case (a), add the entry. If no → case (b), restore or repoint the source. Neither is "regenerate".

For `missing`, following the printed instruction destroys the artefact and produces a passing check. The failure and the fix are indistinguishable in the output. That is not a hypothetical: it is the exact trap the `delegates` plan had to be written around.

### Root Cause

Both defects share a shape: **divergence is treated as a single condition with a single response.** The generator collapses "retired" and "never registered" into one delete branch; the check collapses "mirror behind manifest" and "mirror ahead of manifest" into one regenerate instruction. In each case the two sub-cases call for opposite actions, and in each case the default lands on the destructive one — quietly.

**Why the divergence arises at all is the host split, and both halves are documented.** Antigravity does filesystem auto-discovery of `.agents/skills/<name>/SKILL.md` (§1 of `docs/imported_document_2026_07_09t00_31_11.md`), so dropping a skill *directory* there makes it work immediately with no registration step. Claude Code reads `.claude/skills/`, which is **generated** from `MIRROR_MANIFEST` (SQ4 of `docs/claude_code_project_skills_and_configuration_architecture.md`). Adding a skill therefore needs two edits in lockstep, and only the first gives any feedback — the skill visibly works the moment the directory exists. `delegates` is exactly that: a directory, live on Antigravity, unregistered for Claude Code, and one activation from deletion. The two defects below are what turn that easy mistake into data loss.

### Why this is worth its own plan

Six contract failures were investigated in this sweep and five were stale tests. This is the one that is not: a live path that deletes a working file on a published extension, with no record. Repairing the `delegates` entry closes the instance; nothing closes the mechanism. The next skill added without a manifest entry gets the same silent deletion, and the next person reading `mirror:check`'s output gets the same destructive instruction.

## Metadata

**Tags:** devops, infrastructure, reliability, bugfix
**Complexity:** 5

## User Review Required

None.

## Resolved Assumptions

Settled by direct inspection at HEAD during the improve pass. Do not re-open these; they are recorded so a later pass does not re-derive or re-research them.

| Claim | Verified |
| :--- | :--- |
| The `delegates` divergence is live and is a usable fixture | `MIRROR_MANIFEST` = 47 unique names, `delegates` absent; ledger = 48 unique names, `delegates` present; `.claude/skills/delegates/SKILL.md` and `.agents/skills/delegates/SKILL.md` both on disk. Computed prune target set = exactly `['delegates']`. |
| The dynamic `switchboard-*.md` scan (`ClaudeCodeMirrorService.ts:469-501`) is vestigial | Zero flat `.agents/skills/switchboard-*.md` files exist — every such skill is a directory, which the scan's `file.endsWith('.md')` test never matches. All 47 generated names come from the manifest. Stronger than "empty today": per §2 of `docs/imported_document_2026_07_09t00_31_11.md` (Antigravity Skills Guide), flat markdown directly under `.agents/skills/` is **ignored by Antigravity's discovery entirely**, so the file shape this scan targets is dead on the other host by design. It is dormant code, not a live second producer. |
| The prune log wording, restated | Say "the generator no longer produces", not "not in MIRROR_MANIFEST". <br/>**Corrected rationale:** the original justification — "the dynamic scan is a live second producer" — was wrong (see the row above). The wording still stands on a different and better footing: the scan is dormant, not deleted, so it remains a code path that can fire, and the phrase costs nothing while being true of every producer. Do not flip it back. |
| The `source` discriminator handles every ledger shape | Ledger `source` values take three forms: `skills/<dir>` (the overwhelming majority — e.g. `skills/delegates`, `skills/archive`), `workflows/<file>.md` (the four front doors), and `skills/<file>.md` — of which there is **exactly one**, `skills/refine_feature.md` at manifest line 161. The new `fs.existsSync(path.join(agentsDir, prev.source))` check resolves all three, because `existsSync` does not care whether the target is a file or a directory. No per-shape branching is needed. |
| `mirror:check` cannot see an archive placed at `.claude/.switchboard-pruned/` | `check-claude-mirror.js:123` lists **only** `CLAUDE_SKILLS_DIR` (`.claude/skills`); a sibling directory under `.claude/` is outside that walk. Separately, `main()` copies only `.agents` into the temp root (line 114), so no ledger exists there and the prune loop never executes during the check at all. |
| `MirrorResult` has exactly two real call sites and neither reads a new field | `extension.ts:3918` (reads `status` + `reason`), `ControlPlaneMigrationService.ts:743` (discards the result entirely). `check-claude-mirror.js:116` branches on `status === 'failed'`. Nothing in `src/test/` references `generateClaudeMirror` — no test asserts the `reason` string. |
| CI wiring | `.github/workflows/integration-tests.yml:52-53` runs `npm run mirror:check`. Triggers are `pull_request:`, `workflow_dispatch:`, and `schedule: '0 9 * * 1'` — there is no `push:`. |
| The `.gitignore` managed block is machine-written | `WorkspaceExcludeService.BLOCK_START/END` re-renders `# >>> Switchboard managed exclusions >>>` from `TARGETED_RULES`; a hand-added line inside it is wiped on the next render (the failure `standalone-secrets-bridge-contract.test.js:319` exists to prevent). `TARGETED_RULES` covers `.switchboard/` only — nothing about `.claude/`. |
| `.claude/.switchboard-pruned/` is inert to Claude Code | **Already researched and already built against.** `docs/claude_code_project_skills_and_configuration_architecture.md` is the standing reference: SQ4 fixes skill placement at `.claude/skills/<name>/SKILL.md`, and SQ6 scopes the hot-reload file-watcher to `.claude/skills/`. A sibling directory under `.claude/` is outside both. The generator already implements that doc — `buildSkillMd()` (lines 411-428) emits `user-invokable: false` (SQ2's "k" spelling), `disable-model-invocation: true`, and `allowed-tools` exactly as specified. **Settled twice. Do not re-open, and do not commission research on Claude Code's `.claude/` layout — read that doc.** |
| Whether `.claude/` ships in the VSIX today | Not settled, and **not a research question** — it is one command in this repo. `npx vsce ls \| grep -i '\.claude'` answers it definitively; it is verification step 8. |

## Scope fence

**In scope:** the prune loop's diagnostics and deletion behaviour; `mirror:check`'s per-bucket remedy text.

**Explicitly out of scope — do not add it here.** Local pre-commit / pre-push enforcement of `mirror:check`. There is currently no `.husky`, no `core.hooksPath`, no non-sample hook in `.git/hooks`, and no `prepare`/`precommit`/`lint-staged` script, so the check runs only in CI — which has no `push:` trigger and fires weekly. That timing gap is real, but closing it changes the daily commit loop and is the user's call, not this plan's. Raise it; do not wire it.

**Also out of scope:** adding the `delegates` manifest entry. That is `mirror-check-red-delegates-skill-missing-manifest-entry.md`. This plan must not fix that instance, or its own verification cannot distinguish the backstop working from the instance being gone.

**Also out of scope:** adding any `.claude/` rule to `WorkspaceExcludeService.TARGETED_RULES`. That block is rendered into ~4,000 users' `.gitignore` files; widening it is a separate, deliberate decision. See the Edge-Case audit — this repo's own `.gitignore` gets a rule **outside** the managed block, and the user-install consequence is raised, not wired.

## Complexity Audit

### Routine

- Two files. `MirrorResult` gains one optional field; the prune loop gains a rename, a discriminator, and a log; the check script gains per-bucket text.
- The archive convention is already established and contract-tested in this repo (`uniqueBackupPath` + `*.migrated.bak`, `src/standalone/hostServices.ts:242-247`) — the semantics are copied, not designed.
- `mirror:check` is already wired into CI and has a `package.json` script. No new wiring.
- The check-script change is pure output text: no predicate, no bucket logic, no exit-code change.
- The archive location question is settled by inspection rather than by judgement (see Resolved Assumptions): `.claude/.switchboard-pruned/` is outside both the check's walk and the host's skill-discovery path.

### Complex / Risky

- **This changes what the extension does to files on every activation, on ~4,000 installs.** The prune loop currently runs on activation for every workspace with a `.agents/` directory. A bug here does not fail a test — it leaves litter in every user's `.claude/`, or stops retiring skills that should be retired. Both are silent.
- **`renameSync` can throw where `rmSync({force:true})` effectively could not, and the ledger rewrite makes that permanent.** The whole prune block sits in one `try/catch` (lines 509-525) and the ledger is rewritten *after* it (line 537) with only the regenerated names. A throw mid-loop therefore aborts every remaining stale skill AND drops their names from the ledger, so the next activation never revisits them: they sit in `.claude/skills/` as orphans no code will ever touch again, and `mirror:check` stays red forever. This turns "silent delete" into "silent permanent orphan" — a different failure, not a smaller one. Per-iteration isolation is mandatory, not stylistic.
- **Archiving must not resurrect retired skills.** `SKILL.md.migrated.bak` must not be a file Claude Code loads as a skill, and the now-non-empty directory must not defeat the existing `rmdirSync` intent in a way that leaves a phantom skill entry. Archiving **outside** `.claude/skills/` removes this risk rather than mitigating it, and `.claude/.switchboard-pruned/` is outside the host's discovery roots entirely (see Resolved Assumptions). No residual risk here.
- **The `reason` string is a UI surface.** It is appended to the output channel verbatim. Folding an unbounded list of pruned names into it can produce an unreadable line; bound it. Its existing prefix must stay byte-identical so a clean run reads exactly as it does today.
- **Not over-correcting into a refusal-to-prune.** The prune loop exists for a real reason (retired commands staying invokable forever). Making it *loud* is the goal; making it *never delete* would reintroduce the bug it was written to fix. Keep the deletion, make it recoverable and recorded.
- **"Recorded" is not "noticed".** `reason` lands in a VS Code output channel that nobody reads unless already debugging. This change delivers an audit trail and a recovery path; it does not deliver a user-facing notification, and the plan does not claim to. The one escalation it does make is a `console.warn` for the ambiguous (source-still-present) branch, so the specific case that means "a live skill just went missing" reaches the extension host log as well.

## Edge-Case & Dependency Audit

- **Race conditions.** None. Generation is synchronous and runs at activation.

- **Security.** The prune loop's path-traversal guard (`staleDir.startsWith(skillsRoot + path.sep)`) must remain, and the archive path must be validated the same way — a rename is as capable of escaping the root as an unlink. `prev.name` is already constrained by the `staleDir` guard before the archive path is built, so the second guard is defence-in-depth; when it trips, fall back to the current `rmSync` behaviour rather than `continue`, so a hostile ledger name cannot *suppress* pruning. No new user input reaches either path.

- **Per-skill failure isolation — the load-bearing new edge case.** Wrap each skill's archive+rmdir in its own `try/catch`. A `renameSync` that throws (EPERM/EBUSY on Windows if the file is held open; a read-only `.claude/`) must log and continue, never abort the loop. Consider also whether a name whose archive failed should be omitted from `prunedSkills` — it should, because `prunedSkills` is the assertion surface for "this file was successfully moved".

- **Side effects — repeat activations must converge.** With archiving, a divergent skill produces a `.bak` on the first activation. The second activation must not produce a second one for the same already-deleted file: `SKILL.md` no longer exists, so the prune branch has nothing to rename. In practice the ledger is also rewritten without the name on the first run, so the loop never revisits it at all. Confirm both: the branch is a clean no-op rather than an error, and `uniqueBackupPath`'s counter suffix is only reached in a genuine collision (two activations from different builds pruning the same name).

- **`.bak` files must not become skills.** Claude Code discovers skills as `.claude/skills/<name>/SKILL.md`. Archiving to `.claude/.switchboard-pruned/<name>/SKILL.md.migrated.bak` puts the file outside that tree entirely, so this is designed out rather than mitigated.

  > **Superseded:** "this must be **verified against the host's actual discovery**, not assumed from the naming convention … If it is not provably inert, archive outside `skills/` instead."
  > **Reason:** The conditional is obsolete — the plan now commits to archiving outside `skills/` unconditionally, for an independently verified reason (the check's own recursive walk). The in-place `.bak` variant is no longer a live option, so verifying whether a sibling `.bak` is loaded as a skill answers a question this plan no longer asks.
  > **Replaced with:** Nothing to verify against the host. Claude Code's project-level discovery under `.claude/` is a fixed set of roots (`settings.json`, `settings.local.json`, `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`, plus what `settings.json` references); it does not enumerate arbitrary subdirectories, and `.switchboard-pruned` is none of them. Settled in Resolved Assumptions.

- **The empty-directory cleanup interacts with the archive.** Today `rmdirSync` succeeds when the directory holds only the deleted `SKILL.md`, and is deliberately swallowed when user files remain. Archiving **outside** `skills/` preserves this exactly: the stale directory is left genuinely empty and `rmdirSync` still removes it, so no residue accumulates in `.claude/skills/`. This is the second independent reason the archive root is not in-place.

- **`.gitignore` and packaging.** `.claude/.switchboard-pruned/` must not be committed by a careless `git add -A` and must not ship in the VSIX.
  - **This repo:** add the rule to `.gitignore` **outside** the `# >>> Switchboard managed exclusions >>>` block. `WorkspaceExcludeService` re-renders that block from `TARGETED_RULES`, so a line added inside it is wiped on the next render (verified; see Resolved Assumptions).
  - **User installs:** `TARGETED_RULES` covers `.switchboard/` only, so a pruned user gets an untracked `.claude/.switchboard-pruned/` in their repo with no managed rule for it. That is litter, and widening the managed block touches ~4,000 `.gitignore` files. **Raise it in the completion report; do not wire it** (see Scope fence).
  - **VSIX:** `.vscodeignore` currently has no `.claude` rule at all. Whether `.claude/` ships today is one command, not a research question: `npx vsce ls | grep -i '\.claude'` (verification step 8). Settle it there rather than by assumption.
  - `mirror:check` itself walks only `.claude/skills/` (`listFilesRecursive(CLAUDE_SKILLS_DIR)`), never `.claude/` as a whole, so the archive root is invisible to it.

    > **Superseded:** "a `.bak` left inside `skills/` would appear in the `missing` bucket and turn the check permanently red. **This alone likely settles the location question** toward archiving outside `skills/`."
    > **Reason:** "Likely" was a hedge on something now read directly out of `check-claude-mirror.js`. The walk is rooted at `CLAUDE_SKILLS_DIR` and skips only `.DS_Store`/`Thumbs.db`, so an in-place `.bak` *would* be reported in `missing`; a sibling under `.claude/` *cannot* be.
    > **Replaced with:** Settled, not likely. The archive root is `.claude/.switchboard-pruned/`, and it is invisible to the check by construction.

- **`MirrorResult` is consumed in three places** (`extension.ts:3918`, `ControlPlaneMigrationService.ts:743`, `scripts/check-claude-mirror.js:115`). A new **optional** field is additive and breaks none of them; the migration-service caller ignores the result entirely, which is fine. Do not change `status`, `reason`'s existing prefix, or `skillsWritten` — the check script branches on `result.status === 'failed'`. Note that no production caller reads `prunedSkills`: it exists as the assertion surface for verification step 2 and as a complete list for any future caller, while `reason` carries the bounded human-readable summary. That is deliberate, not scaffolding.

- **Dependencies & conflicts.** `uniqueBackupPath` is module-private in `src/standalone/hostServices.ts`. `src/services/` must not import from `src/standalone/` — standalone composes services, not the reverse — so either lift the helper to a shared util or keep a local five-line copy in `ClaudeCodeMirrorService.ts`. **Decision: keep a local copy.** It is five lines with no state, the alternative is a new shared module for one trivial function, and duplicating it keeps `ClaudeCodeMirrorService.ts` free of new imports. No gate reads these files beyond `mirror:check` itself.

## Dependencies

- `mirror-check-red-delegates-skill-missing-manifest-entry.md` — **soft, ordering only.** That plan clears the current `missing` bucket. This plan is easier to verify while the `delegates` divergence still exists (it is a live fixture for both defects), so **verify this plan first, or reconstruct the divergence synthetically** as described in Verification. Neither blocks the other from landing.
  - **Do not rely on the live fixture.** It is one activation away from evaporating: any extension run against this workspace from a `src/`-lineage build prunes `delegates` and rewrites the ledger to 47, self-healing the divergence and destroying the fixture. Treat the synthetic reconstruction in verification step 2 as the primary path and the live divergence as a convenience.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is over-correction in two directions at once: a prune loop that refuses to delete reintroduces the retired-commands-stay-invokable bug it exists to prevent, while a `renameSync` that throws inside the existing single `try/catch` aborts the rest of the loop and — because the ledger is rewritten immediately afterwards without those names — strands them in `.claude/skills/` permanently, trading a silent delete for a silent permanent orphan; per-skill `try/catch` is therefore mandatory. The second risk is the diagnostic being *recorded* rather than *noticed*: `reason` lands in an output channel nobody reads, so the ambiguous case (ledger source still present on disk, the signature of a missing manifest entry) is additionally escalated to `console.warn`, and the plan does not claim user-facing loudness it has not built. The third is blast radius — this changes file-deletion behaviour on every activation across ~4,000 installs, where a mistake produces litter or silently stops retiring skills rather than failing a test.

## Proposed Changes

### `src/services/ClaudeCodeMirrorService.ts` — record the prune, and make it recoverable

**Context.** The stale-mirror cleanup block (the `for (const prev of prevSkills)` loop, lines 503-525), the `MirrorResult` interface (lines 387-391), the success return (lines 543-547), and the constants block near `GENERATED_MANIFEST_FILE` (line 261).

**Logic.** Keep the deletion — it is load-bearing. Add four things: archive the file instead of unlinking it, isolate each skill's archive so one failure cannot abort the loop or strand the rest, collect the pruned names into `MirrorResult`, and use the ledger's `source` field to make the diagnostic specific where it can be. Because the loop can prove "retired" but never "mistake", the archive applies to both branches; the discriminator only sharpens the message.

**Implementation.**

```ts
// near GENERATED_MANIFEST_FILE (line 261)
const PRUNED_ARCHIVE_DIR = '.switchboard-pruned';
```

```ts
export interface MirrorResult {
    status: 'generated' | 'skipped' | 'failed';
    reason: string;
    skillsWritten: number;
    /** Ledger names this run did NOT regenerate, successfully archived rather than
     *  unlinked. This loop can prove a skill was RETIRED (its .agents/ source is gone)
     *  but can never prove the opposite case — a skill whose MIRROR_MANIFEST entry was
     *  never added — is not just a retirement with the doc kept. The second case is
     *  data loss, so nothing here is unlinked. `reason` carries a bounded summary for
     *  the output channel; this field carries the complete list. */
    prunedSkills?: string[];
}
```

```ts
/** First free path in the `<base>`, `<base>.1`, `<base>.2`… series.
 *  Local copy of the helper in src/standalone/hostServices.ts:242-247 — src/services/
 *  must not import from src/standalone/ (standalone composes services, not the reverse). */
function uniqueBackupPath(base: string): string {
    if (!fs.existsSync(base)) { return base; }
    let counter = 1;
    while (fs.existsSync(`${base}.${counter}`)) { counter++; }
    return `${base}.${counter}`;
}
```

The prune block, replacing lines 503-525 in full:

```ts
// Remove stale mirrors: skills this generator previously wrote (tracked in the
// ledger) that were NOT regenerated this run — the manifest entry was retired or
// its source removed. Without this, retired commands stay user-invokable in
// Claude Code on existing installs forever (the workflow-side equivalent is
// cleanupLegacyAgentFiles). Only ledger-tracked names under .claude/skills/ are
// ever deleted — user-authored skills are never touched.
//
// A ledger name the generator no longer produces is EITHER a deliberate retirement
// (removing it is correct) OR a skill whose MIRROR_MANIFEST entry was never added,
// in which case this is a live file and unlinking it is data loss. The ledger's
// `source` discriminates ONE side only: source gone => definitely retired; source
// still present => genuinely ambiguous, because an entry can also be retired while
// the .agents/ doc is deliberately kept (switchboard-orchestrator is exactly that).
// So: ARCHIVE rather than unlink in both branches, and NAME what happened. Adding
// `delegates` to .agents/skills/ without a manifest entry put a working skill on
// this path and nothing anywhere said so.
const prunedSkills: string[] = [];
const prunedRoot = path.join(claudeDir, PRUNED_ARCHIVE_DIR);
try {
    const ledgerPath = path.join(claudeDir, GENERATED_MANIFEST_FILE);
    if (fs.existsSync(ledgerPath)) {
        const previous = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        const regenerated = new Set(generatedSkills.map(s => s.name));
        const prevSkills: Array<{ name?: string; source?: string }> =
            Array.isArray(previous?.skills) ? previous.skills : [];
        for (const prev of prevSkills) {
            if (!prev?.name || regenerated.has(prev.name)) continue;
            const staleDir = path.join(skillsRoot, prev.name);
            if (!staleDir.startsWith(skillsRoot + path.sep)) continue; // path-traversal guard
            // Per-skill isolation. The ledger is rewritten below with ONLY the
            // regenerated names, so a name skipped by a thrown rename is never
            // revisited on any later activation — it would sit in .claude/skills/
            // as a permanent orphan, invisible to this code and red in mirror:check
            // forever. One failure must not cost the rest of the loop.
            try {
                const liveSkill = path.join(staleDir, 'SKILL.md');
                if (fs.existsSync(liveSkill)) {
                    const archived = uniqueBackupPath(
                        path.join(prunedRoot, prev.name, 'SKILL.md.migrated.bak'));
                    if (archived.startsWith(prunedRoot + path.sep)) {
                        fs.mkdirSync(path.dirname(archived), { recursive: true });
                        fs.renameSync(liveSkill, archived);
                    } else {
                        // Guard tripped on a hostile ledger name: fall back to the
                        // pre-existing behaviour. Never `continue` — that would let a
                        // crafted name SUPPRESS pruning, which is the opposite failure.
                        fs.rmSync(liveSkill, { force: true });
                    }
                    prunedSkills.push(prev.name);
                    if (prev.source && fs.existsSync(path.join(agentsDir, prev.source))) {
                        // Source still on disk => very likely a missing manifest entry,
                        // not a retirement. Escalate past `reason` (an output channel
                        // nobody reads unless already debugging) into the host log.
                        console.warn(
                            `[ClaudeCodeMirrorService] Pruned '${prev.name}' from .claude/skills/ `
                            + `but its source .agents/${prev.source} still exists — very likely a `
                            + `MISSING MIRROR_MANIFEST entry, not a retirement. Archived to ${archived}.`
                        );
                    }
                }
                try { fs.rmdirSync(staleDir); } catch { /* non-empty (user files) — leave the dir */ }
            } catch (e) {
                console.warn(
                    `[ClaudeCodeMirrorService] Failed to archive stale mirrored skill '${prev.name}':`, e);
            }
        }
    }
} catch (e) {
    console.warn('[ClaudeCodeMirrorService] Failed to clean stale mirrored skills:', e);
}
```

`prunedRoot` is `.claude/.switchboard-pruned/` — **outside** `.claude/skills/`, for three independently verified reasons: `mirror:check` walks `skills/` recursively and would report an in-place `.bak` in the `missing` bucket, turning the check permanently red; keeping `skills/<name>/` genuinely empty preserves the existing `rmdirSync` cleanup instead of silently disabling it; and Claude Code's hot-reload watcher is scoped to `.claude/skills/` (SQ6), so writing archive churn inside it would poke the host's watcher on every activation for no reason. Nothing under `.claude/` outside `skills/` is discovered or watched.

Then fold the names into `reason` so the existing caller reports them with no change at the call site:

```ts
const prunedNote = prunedSkills.length
    ? ` — archived ${prunedSkills.length} skill(s) the generator no longer produces `
      + `(${prunedSkills.slice(0, 5).join(', ')}${prunedSkills.length > 5 ? ', …' : ''}) `
      + `to .claude/${PRUNED_ARCHIVE_DIR}/; if any is a LIVE skill, its MIRROR_MANIFEST entry is missing`
    : '';
return {
    status: 'generated',
    reason: `Mirrored ${generatedSkills.length} skill(s) into .claude/skills/${prunedNote}`,
    skillsWritten: generatedSkills.length,
    prunedSkills,
};
```

> **Superseded:** a `reason` template of `` `Mirrored ${generatedSkills.length} skill(s) into .claude/skills/.${prunedNote}` `` with the note opening `" Archived N skill(s) no longer in MIRROR_MANIFEST …"`.
> **Reason:** Two defects. (1) It appended a full stop to the existing string, contradicting this plan's own Edge-Case rule that `reason`'s existing prefix must not change — a clean run's output-channel line would have shifted for no reason. (2) "no longer in MIRROR_MANIFEST" is inaccurate: the manifest is not the only producer. The dynamic `switchboard-*.md` scan (lines 469-501) also writes ledger entries, so a pruned name may never have had a manifest entry to lose.
> **Replaced with:** the template above — the prefix is byte-identical on a clean run, the note is an em-dash continuation, and it says "the generator no longer produces", which is true for both producers.

The list is truncated at five because `reason` is appended verbatim to the output channel and an unbounded list makes the line unreadable; `prunedSkills` carries the complete set for any caller that wants it.

**Edge cases.** On a second activation the archive branch is a no-op (`SKILL.md` no longer exists, and in practice the ledger no longer lists the name either), so no duplicate `.bak` is produced and `uniqueBackupPath`'s counter is reached only on a genuine collision. A name whose archive threw is logged, is **not** pushed to `prunedSkills`, and the loop continues. `.claude/.switchboard-pruned/` must be added to this repo's `.gitignore` **outside** the Switchboard managed block, and confirmed excluded from the VSIX.

### `scripts/check-claude-mirror.js` — one remedy per bucket

**Context.** The failure-report block, lines 145-149 (the `console.error` header plus the three bucket lines).

**Logic.** `drifted` and `extra` mean the mirror is *behind* the generator — regenerate. `missing` means the mirror is *ahead* of it, and regenerating removes the file. Print the remedy that belongs to each bucket instead of one header that is wrong for the destructive case, and — for `missing` — name both of its causes with the test that separates them. No predicate and no exit-code changes; this is output text only.

**Implementation.**

```js
console.error('❌ mirror:check — .claude/skills drift detected.');
if (missing.length) {
    console.error(`  Committed but NOT regenerated: \n    - ${missing.join('\n    - ')}`);
    console.error('  → The mirror is AHEAD of the generator: these files are committed but');
    console.error('    generateClaudeMirror produces nothing for them. Two causes, both fixed in');
    console.error('    src/services/ClaudeCodeMirrorService.ts:');
    console.error('      (a) MIRROR_MANIFEST has no entry for the skill. Add one — recover its exact');
    console.error('          shape from the committed file\'s own frontmatter: name, allowed-tools →');
    console.error('          allowedTools, user-invokable:false → invocation \'no-user\', description →');
    console.error('          descriptionFallback.');
    console.error('      (b) An entry exists but its `source` no longer resolves under .agents/ (moved,');
    console.error('          renamed, deleted) — resolveSourceFile returns null and the entry is skipped.');
    console.error('          Restore or repoint the source.');
    console.error('    To tell them apart: check whether .agents/<source> exists. If it does, it is (a).');
    console.error('    Do NOT regenerate to clear this — the prune path REMOVES these files from');
    console.error('    .claude/skills/ and the check then passes. That is how a live skill gets removed.');
}
if (extra.length) {
    console.error(`  Regenerated but NOT committed: \n    - ${extra.join('\n    - ')}`);
    console.error('  → The mirror is BEHIND the generator. Regenerate and commit.');
}
if (drifted.length) {
    console.error(`  Content drift: \n    - ${drifted.join('\n    - ')}`);
    console.error('  → The committed mirror is stale against its source. Regenerate and commit.');
}
process.exit(1);
```

**Edge cases.** Multiple buckets can fire at once and each prints its own remedy — that is correct, and the two instructions genuinely differ per file. The generic "run the extension activation" sentence is removed from the header precisely so it can never be read as applying to `missing`. `process.exit(1)` stays outside every bucket branch: it is the single line whose misplacement would make some divergences pass silently.

## Verification Plan

### Automated Tests

1. `npm run compile-tests` — required; `mirror:check` loads `out/services/ClaudeCodeMirrorService.js`.
2. **Reproduce the destructive path, then prove it is gone.** Use a scratch copy of the repo tree (never the working tree) containing a divergent skill. Build it **synthetically** — copy any generated `.claude/skills/<name>/SKILL.md` to a new name, add a matching `{source, name, relPath}` entry to `.claude/.switchboard-generated.json`, and add nothing to `MIRROR_MANIFEST`. (The live `delegates` divergence works as a fixture too, but do not depend on it: one activation from a `src/`-lineage build self-heals the ledger to 47 and destroys it.) Then run `generateClaudeMirror` on that root and assert:
   - the skill's `SKILL.md` is **gone from `.claude/skills/<name>/`** and the now-empty directory was removed (the prune still works — this must NOT regress),
   - the content is **recoverable** at `.claude/.switchboard-pruned/<name>/SKILL.md.migrated.bak` and byte-identical to what was removed,
   - `result.prunedSkills` contains the name,
   - `result.reason` names it and says a live skill would mean a missing manifest entry,
   - with the ledger `source` pointing at a path that still exists under `.agents/`, a `console.warn` naming that source is emitted; with the source removed, it is not.
3. **Second activation converges.** Run `generateClaudeMirror` on the same root again: no second `.bak`, no throw, `prunedSkills` empty (the ledger was rewritten without the name on the first run).
4. **A failed archive isolates and does not strand the rest.** Construct a root with two divergent skills where the first cannot be renamed (e.g. make `.claude/.switchboard-pruned/` a read-only directory, or a file where the directory is expected). Assert: the failure is logged, the **second** skill is still archived and appears in `prunedSkills`, the failed name does **not** appear in `prunedSkills`, and `generateClaudeMirror` returns `status: 'generated'` rather than throwing. This is the regression test for the permanent-orphan risk in the Complexity Audit — without per-skill isolation, the second skill is silently skipped and then dropped from the ledger forever.
5. **Nothing lands under `.claude/skills/`, and the check cannot see the archive.** Assert that after a prune, `listFilesRecursive('.claude/skills')` contains no `*.bak` path, and that `npm run mirror:check` is unaffected by the presence of `.claude/.switchboard-pruned/**` (it walks only `.claude/skills/`). The host side needs no check — `.switchboard-pruned` is outside Claude Code's discovery roots (see Resolved Assumptions).
6. **Per-bucket remedy text — all three buckets, independently.** In a scratch tree, produce each condition and confirm the printed remedy matches the table in Problem Analysis:
   - `missing`: a committed mirror with no manifest entry → must print **both** causes (a) and (b), the `.agents/<source>` discriminating test, and the "do NOT regenerate" warning; must **not** print "regenerate and commit".
   - `extra`: a manifest entry whose mirror file is deleted from the committed tree → "regenerate and commit".
   - `drifted`: a committed mirror file with one byte changed → "regenerate and commit".
   - Exit code must remain 1 in all three, and 0 with the success line when clean.
7. **Negative control — the check must still fail.** Confirm `mirror:check` exits 0 on a clean tree and 1 on each condition above. A text-only change that accidentally moved the `process.exit(1)` inside a bucket branch would make some divergences pass silently, which is the same class of defect this plan exists to remove.
8. **Packaging and ignore rules.**
   - Confirm `.gitignore` excludes `.claude/.switchboard-pruned/` and that the rule sits **outside** the `# >>> Switchboard managed exclusions >>>` block (`WorkspaceExcludeService` re-renders that block from `TARGETED_RULES` and would wipe a line placed inside it).
   - Run `npx vsce ls | grep -i '\.claude'` to settle empirically whether `.claude/` ships today. If it does, add a `.claude/**` exclusion to `.vscodeignore` **without** a blanket negation (see that file's header comment on how vsce negations override ignores unconditionally).
9. `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check` — green (none read these files).

### Manual

10. On a real activation in this workspace, confirm the output channel line still reads exactly `[…] .claude/skills mirror: generated — Mirrored N skill(s) into .claude/skills/` with **no** trailing period and no prune note on a clean tree, and that it gains the ` — archived …` continuation when a divergence is present.

## Agent Recommendation

**Send to Coder** (complexity 5) — two small, well-specified edits, but one of them changes file-deletion behaviour that runs on every activation across ~4,000 installs, and it introduces a throw-capable `renameSync` into a loop whose failure mode is permanent and silent.

The reviewer should check five things:

1. **The prune loop still deletes** from `.claude/skills/` and still removes the emptied directory. A fix that stops pruning reintroduces the retired-commands bug it was written to prevent.
2. **Per-skill `try/catch` is present** around the archive, and a name whose archive threw is excluded from `prunedSkills`. Without it, one throw aborts the remaining stale skills and the ledger rewrite immediately afterwards makes them permanently unreachable — a worse bug than the one being fixed. Verification step 4 is the test that proves it.
3. **The archive lands outside `.claude/skills/`** and `mirror:check` was actually run with the archive present. The traversal-guard fallback must be `rmSync`, not `continue` — a crafted ledger name must not be able to suppress pruning.
4. **All three remedy buckets were exercised separately** (step 6), the `missing` text names **both** causes plus the `.agents/<source>` discriminator, and it does not contain "regenerate" as an instruction. `process.exit(1)` must remain outside every bucket branch.
5. **`MIRROR_MANIFEST` is unchanged**, and `reason`'s clean-run prefix is byte-identical to today's (no trailing period). Adding the `delegates` entry belongs to the other plan; doing it here would erase this plan's own test fixture.

**Raise, do not wire — two items for the completion report:**

- **CI timing.** `.github/workflows/integration-tests.yml` triggers on `pull_request:`, `workflow_dispatch:`, and a weekly `schedule:` — there is **no** `push:`. Because work in this repo lands directly on `main`, the `pull_request` trigger never fires in practice and drift is detected up to seven days later, and only if nothing earlier in the workflow is red. Closing that gap means local pre-commit or pre-push enforcement — a change to the daily commit loop the user should opt into deliberately. Flag it; do not add a hook.
- **User-install `.gitignore` litter.** `WorkspaceExcludeService.TARGETED_RULES` covers `.switchboard/` only, so a pruned user install gets an untracked `.claude/.switchboard-pruned/` with no managed rule for it. Adding a `.claude/` rule to that block rewrites ~4,000 users' `.gitignore` files. Flag it; do not wire it.
