# A retired protocol is never deleted from a workspace, and the standalone host never prunes at all

## Goal

Close two gaps in the `.agents/` retirement prune: extend its scope to `protocols/` so a protocol
removed from the bundle is removed from users' workspaces, and wire the prune into the standalone
composition root, which has never called it.

### Problem Analysis

`.agents/` is copied into every workspace in full. `ControlPlaneMigrationService.ts:704` runs
`_copyDirectoryRecursive(bundledAgentDir, <workspace>/.agents, { overwrite: false,
overwriteIfDiffers: true })` over the entire tree, with a two-entry blocklist
(`personas/switchboard_operator.md` and the ledger file itself, `:1042-1048`). Protocols are copied
like everything else.

Deletion does not have the same reach.

**Gap 1 — `protocols/` is out of the prune's scope, by construction.** `pruneRetiredBundleFiles`
deletes ledger-tracked files no longer in the current bundle, and its `currentBundlePaths` are
documented as *"skills + workflows"* (`:1305-1307`). The reconcile sweep beneath it hard-codes the
same list: `const scopes = ['skills', 'workflows']` (`:1387`), with a comment that
*"personas/, rules/, scripts/ are out of scope for this reconcile."* `protocols/` is not named in
that comment at all — it is neither deliberately excluded nor included, it is simply absent.

The call site confirms the ledger can never contain a protocol: `extension.ts:400-401` builds
`currentBundlePaths` from exactly two crawls, prefixed `skills/` and `workflows/`.

So a protocol file copied into a workspace stays there permanently. If it is deleted from the
bundle, the workspace keeps its copy, and the extension keeps injecting prompts that reference
`.agents/protocols/<name>/SKILL.md` — a path that now resolves to a stale file rather than failing
loudly.

**This blocks a plan already on the board.** `protocols-as-db-rows-not-scaffolded-files.md` moves 29
of 32 protocols into the store and shrinks `.agents/protocols/` to two files. Under today's prune,
that ships 29 orphans into every existing workspace, permanently, while the extension delivers the
row versions — two sources of truth for the same protocol, differing by exactly the edits made after
the migration.

**And the damage from stale protocol copies is documented, not speculative.**
`protocol-paths-in-agent-instructions-point-nowhere.md` records what happened the last time two
copies of one protocol existed: an agent read the canonical `improve-feature`, edited it correctly,
and wrote the result to a historical path, producing *"two diverged copies of a dispatched protocol,
each holding one edit the other lacks."* That was a path that no longer existed. An orphan that
still exists, and still matches the path in the injected prompt, is worse — nothing about it looks
wrong.

**Gap 2 — the standalone host never prunes.** `pruneRetiredBundleFiles` has exactly one caller in
the repo: `src/extension.ts:405`. `bootstrap.ts` references `ControlPlaneMigrationService` nowhere.
So on the standalone/npx host no retirement prune runs for any surface — not protocols, not skills,
not workflows. A skills file retired three releases ago is still live in a standalone workspace.

This is the composition-root divergence `CLAUDE.md` names as the trap: *"service seams, options
objects handed to shared services, and `Promise<void>` callbacks where 'never wired' and 'working'
are the same value."* The prune returns drift counts nobody asserts, and the seed path — which
*is* wired in both — keeps the workspace looking healthy.

### Root Cause

The prune was built alongside the `.claude` mirror's ledger (`ClaudeCodeMirrorService:486-508`) at a
time when `.agents/` held only `skills/` and `workflows/`. `protocols/` arrived later, by a rename
from `.switchboard/protocols/` on 2026-08-21 (`33d4f3d2`, per the path history in
`protocol-paths-in-agent-instructions-point-nowhere.md`). The copy path is recursive and picked the
new directory up for free; the prune path enumerates scopes by name and did not. Nothing failed,
because a prune that deletes nothing is indistinguishable from a prune with nothing to delete.

The standalone gap has the same shape: `bootstrap.ts` was written as a server host, and activation
housekeeping stayed in `extension.ts` where it was already working.

### Non-goals

- **Not moving protocols into the DB.** That is `protocols-as-db-rows-not-scaffolded-files.md`; this
  plan is its prerequisite, not its implementation.
- **Not extending the prune to `personas/`, `rules/` or `scripts/`.** Those are deliberately out of
  scope per the existing comment and stay that way.
- **Not changing the copy path.** It already reaches protocols correctly.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, bugfix, devops, infrastructure

None.

### Sequencing: the first release only starts tracking

This is how the ledger works, not a choice. On the release that adds `protocols/` to
`currentBundlePaths`, the *previous* ledger holds no protocol entries, so the prune deletes nothing
and the reconcile counts every protocol as "extra". The ledger is seeded, not acted on.

**Therefore `protocols-as-db-rows-not-scaffolded-files.md` must land at least one release after this
one.** Shipping them together removes 29 protocols from the bundle while the ledger still has no
record of them, so nothing is pruned and all 29 strand in every workspace — the outcome this plan
exists to prevent.

### The stray file under `.agents/protocols/` is agent-written, not user-written

An unshipped file there is never ledger-tracked, so it is never pruned; it surfaces only as drift in
the activation log. That is the right behaviour, and the drift count is the only thing that would
ever reveal it.

The author is not a user hand-editing. `protocol-paths-in-agent-instructions-point-nowhere.md`
records the real case: an agent wrote a new `improve-feature` protocol to
`.agents/skills/improve-feature/SKILL.md` — a path vacated four days earlier — while a second agent
edited the canonical copy 96 minutes before, *"two diverged copies of a dispatched protocol, each
holding one edit the other lacks."* An agent following stale instructions to a stale path is the
generator of these files, which is why the drift count is worth reading rather than suppressing.

## Complexity Audit

### Routine

- Adding `'protocols'` to the `scopes` array and to the `currentBundlePaths` crawl.

### Complex / Risky

- **The ledger is a delete list.** Anything wrongly added to `currentBundlePaths`, or wrongly
  omitted from it on a later run, becomes a deletion in a user's workspace. The existing guards must
  keep holding: the path-traversal check (`abs` must resolve strictly under `agentsDir`), the
  never-delete-a-directory rule, the ledger-self-exclusion, and the content-hash desync warning that
  catches a rename being mistaken for a retirement (`:1324-1331`).
- **Seeding the standalone caller is a first prune on machines that have never pruned.** A
  standalone workspace may carry years of retired skills. The first run there has no prior ledger,
  and `readBundleLedger` returning null must continue to mean *no deletes* — that safe default is
  what makes wiring the second root non-destructive. Verify it rather than trust it.
- **The two roots must produce the same `currentBundlePaths`.** The crawl lives at the call site
  (`extension.ts:399-401`), not in the service, so wiring `bootstrap.ts` by copying that block
  creates two crawls that can drift. Extract the crawl into the service and have both roots call
  one function — otherwise this plan fixes a divergence by adding one.
- **`overwrite: false, overwriteIfDiffers: true`.** A user who edited a shipped protocol in place
  has a differing file, which the copy path overwrites. That is existing behaviour and out of scope,
  but the prune must not compound it by also deleting files during the same pass for unrelated
  reasons.

## Edge-Case & Dependency Audit

- **Empty directories are left behind** by design (*"never delete a directory; only files"*).
  Shrinking `protocols/` from 32 to 2 leaves 30 empty directories. Harmless, but it should be a
  stated outcome rather than a surprise.
- **The `improve-plan` / `improve-feature` exception.** Those two are the persisted defaults of
  user-editable path fields (`kanban.html:3464`, `:3568`, per the db-rows plan). They must never be
  pruned while they remain the default values, or every install's planner add-on points at a
  deleted file.
- **Drift counts are logged and never asserted.** `extension.ts:406-412` writes a line to the output
  channel. Nothing reads it. If this plan's verification relies on drift counts, it must assert them
  in a test, not in a log.
- **A workspace with no `.agents/` at all** — prune must be a no-op, not an error.

## Proposed Changes

### 1. `ControlPlaneMigrationService.ts` — extract the bundle-path crawl

Move the `skills/` + `workflows/` crawl out of `extension.ts:399-401` into a service method that
both roots call. Add `protocols/` to it and to the `scopes` array at `:1387`. Update the scope
comment at `:1380-1384` to name `protocols/` as in-scope and to keep `personas/`, `rules/`,
`scripts/` named as out.

### 2. `src/standalone/bootstrap.ts` — wire the prune

Call `pruneRetiredBundleFiles` on startup with the shared crawl, fire-and-forget with the same
logging shape the extension uses. Placed with the other startup housekeeping, and never able to
throw into the server boot.

### 3. Guard `improve-plan` and `improve-feature`

Keep both permanently in the bundle so they are always in `currentBundlePaths` and therefore never
prune candidates. Add a test asserting it, so a later bundle change cannot silently orphan the two
path fields' defaults.

## Verification Plan

### Automated Tests

1. **A protocol retired from the bundle is deleted from the workspace** on the next run — with a
   prior ledger that contains it. The behaviour this plan exists to add.
2. **First run with no prior ledger deletes nothing**, seeds the ledger, and counts drift. The
   upgrade-safety gate, and the one that makes wiring standalone non-destructive.
3. **A user-authored protocol never in the bundle is never deleted**, across two runs.
4. **`improve-plan` and `improve-feature` are in `currentBundlePaths`** on every run. Pins the two
   user-editable defaults against a future bundle edit.
5. **Both roots call the same crawl function.** Source-level: `extension.ts` and `bootstrap.ts`
   each reference it, and neither contains its own `skills/`/`workflows/` prefix construction. This
   is the only gate that catches the divergence being re-created by copy-paste.
6. **Existing guards still hold** after the scope change: traversal rejection, directory
   non-deletion, ledger self-exclusion, and the rename-vs-retirement hash warning.
7. **No `.agents/` directory → no-op, no throw**, on both hosts.
8. **`personas/`, `rules/`, `scripts/` remain out of scope** — a file under each survives a prune.

### Goal Invariants

- A file removed from `.agents/protocols/` in the bundle is gone from a workspace within one
  upgrade of the release that ships the tracking.
- The standalone host prunes the same surfaces as the extension, from the same computed set.

### Manual

- Upgrade a workspace carrying a protocol that has been removed from the bundle; confirm it is gone
  and the activation log names it.
- Run the standalone host on a workspace with a long-retired skills file; confirm it is pruned on
  the second run and not the first.
