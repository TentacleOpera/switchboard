# Make manifest re-delivery idempotent (fix stranded-manifest state reversion)

## Goal

Stop a git-tracked `manifest.json` that has already been consumed from silently
re-asserting stale `status` / `project` / `epicId` on a later re-consume. Make manifest
application idempotent so a stranded or resurrected manifest is a **no-op**, regardless of
whether the file was ever reaped from git.

### Core problem & root cause (observed bug)

A manifest for already-actioned work was found still sitting in `.switchboard/plans/manifest.json`
at HEAD (the comms-monitor entry from PR #31), and it resurrects in every fresh clone. Three
facts combine to make this a correctness bug, not just clutter:

1. **The manifest is permanently git-tracked.** `.gitignore` ignores `.switchboard/*` but
   un-ignores the whole `.switchboard/plans/` dir (`.gitignore:74-77`), and the manifest lives
   there. It *must* be committable — that is how a remote agent's manifest travels to the local
   extension — so it cannot simply be untracked the way the board-state mirrors were in
   `de3f563` ("chore: untrack board-state mirror files").

2. **Reaping is local-only and PR merges bypass it.** The consume-then-delete
   (`PlanManifestService._safeDelete`) runs on the local extension's filesystem; the deletion
   only reaches git via the extension's `switchboard: sync kanban board state` auto-commit. A
   manifest delivered by a **merged PR** (like #31) is never reaped by the merge — no CI or hook
   does it (confirmed: nothing under `.github/` touches the manifest) — so it stays in git
   indefinitely and reappears on every checkout.

3. **Only the column field is re-delivery-safe.** In `_applyEntry`
   (`src/services/PlanManifestService.ts:264-339`), the `kanbanColumn` move is gated on
   `plan.kanbanColumn === fromColumn` (`line 276`) — a stale move is skipped. But `status`
   (`287-298`), `project` (`304-309`), and `epicId` (`311-339`) have **no equivalent guard**:
   they re-apply unconditionally whenever present. So each time a stranded manifest is
   re-consumed, it reverts any human change to those fields made since the first consume
   (e.g. re-links an epic the user detached, resets a project the user reassigned).

**Root cause:** the manifest is a message on a git transport, but the guarantee that a message
applied twice equals applied once was only ever built for the column field. The other fields
assume the file is deleted after one consume — an assumption git-tracking + PR delivery break.

## Metadata

- **Project:** Switchboard
- **Tags:** manifest, watcher, correctness, migration, remote-control
- **Complexity:** 6

## Implementation

Preferred approach — a **consumed-manifest ledger** (robust regardless of reaping), plus
best-effort deletion retained:

1. **Record consumption by content hash.** When a manifest is fully applied, compute a stable
   hash of its normalized content (sorted entries) and record it in a small DB table
   (`consumed_manifests(workspace_id, content_hash, consumed_at)`). Add the table to the schema
   (`KanbanDatabase.ts` schema block ~`120-183`) and an idempotent migration (`~243-245`).

2. **Skip already-consumed manifests.** At the top of `PlanManifestService.applyManifest`
   (`PlanManifestService.ts:85`), after parsing, compute the hash and short-circuit (do not
   apply, then best-effort delete) if the hash is already in the ledger. This makes a resurrected
   manifest a true no-op even when the file was never deleted from git — closing the PR-delivery
   gap without depending on reaping.

3. **Keep delete-on-consume as cleanup, not correctness.** `_safeDelete` still runs so the
   steady state stays clean locally; but correctness no longer depends on the deletion
   propagating.

Alternative / complementary — **per-field staleness guards** mirroring `fromColumn`: add optional
`fromStatus`, `fromProject`, `fromEpicId` (or default non-column fields to apply only when the
target field is currently empty / on first import). This makes intent explicit but changes the
producer contract across the ~6 skill docs that emit manifests; the ledger needs no producer
change and covers all fields at once, so prefer the ledger and treat per-field guards as
optional defense-in-depth.

4. **Reaping note (docs).** Document that PR-delivered manifests are not auto-reaped; the ledger
   is what guarantees safety. Optionally have the epic's `column-transition-frontmatter-retire-manifest.md`
   path supersede this entirely — once column moves ride in `.md` frontmatter, the manifest's
   remaining role shrinks.

## User Review Required

- Choose the mechanism: **consumed-manifest ledger** (recommended — no producer change, covers
  all fields) vs per-field `from*` guards vs both.
- Confirm the ledger key: content-hash of the whole manifest vs per-entry fingerprint. (Per-entry
  is finer-grained but more state; whole-file hash is simplest and matches consume-then-delete
  semantics.)
- Decide whether to also `git rm --cached` any manifest currently stranded on `main` as a
  one-time cleanup (separate from the code fix).

## Complexity Audit

### Routine
- Adding a small table + idempotent migration (follows existing patterns).
- Computing a content hash and a ledger lookup at the top of `applyManifest`.

### Complex / Risky
- **Hash stability.** The hash must be computed over *normalized* content (stable entry order,
  whitespace-insensitive) or a re-serialized-but-equivalent manifest would miss the ledger and
  re-apply. Normalize before hashing.
- **Migration on ~4,000 installs.** New table only; no backfill. Existing already-consumed
  manifests aren't in the ledger, so the *first* re-consume after upgrade still applies — the
  fix is forward-looking. Acceptable, but note it: a currently-stranded manifest (e.g. #31's)
  will apply once more on the first post-upgrade consume, then be ledgered. If that single
  re-apply is itself unwanted, pair with the one-time `git rm --cached` cleanup.
- **Interaction with legitimate re-delivery.** A remote agent that *intentionally* re-sends an
  updated manifest with the same content would be skipped. Since identical content = identical
  intent, this is correct; a genuinely new instruction has different content and a different
  hash.

## Edge-Case & Dependency Audit

- **Relationship to the epic.** This hardens the *existing* manifest mechanism; the sibling
  `column-transition-frontmatter-retire-manifest.md` *reduces* reliance on it. They are
  complementary — ship this so in-flight manifests (including this epic's own subtask-link
  entries) are safe during the retirement's one-release compat window.
- **This epic's own manifest entries** ride the same mechanism; once this lands, their
  re-application on re-clone is provably a no-op.
- **Multi-workspace:** ledger is keyed by `workspace_id`.
- **Migration-sensitivity:** manifests are a shipped remote surface (per CLAUDE.md, assume
  shipped and preserve compat) — the ledger is additive and backward compatible; no manifest
  producer changes required.
