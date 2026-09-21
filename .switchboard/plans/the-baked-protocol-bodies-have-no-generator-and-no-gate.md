# The Baked Protocol Bodies Have No Generator and No Gate

## Goal

`src/services/bundledProtocols.ts` and `.agents/protocols/<name>/SKILL.md` can hold different
text for the same protocol, and nothing anywhere notices. Close that: a gate that fails when the
two disagree, and a file header that tells the truth about which one owns which protocol.

### Problem analysis

**The header makes a promise the repo does not keep.** `bundledProtocols.ts:1` reads:

```
// Auto-generated bundled protocols. Do not edit directly.
```

There is no generator. Nothing in `scripts/`, `package.json` or any workflow writes this file —
the only script that touches it is `scripts/update-reports-channel-doc.js`, a one-off patcher for
an unrelated string. The header's own line 2 then contradicts line 1 with an `EXCEPTION:` noting
that the `archive` protocol was hand-edited here because its source markdown no longer exists.

So an agent reading that header is misled twice: told not to edit a file that must sometimes be
edited by hand, and pointed at a generator that does not exist.

**The drift is real and was hit, not theorised.** Measured 2026-09-21: an edit to
`.agents/protocols/improve-plan/SKILL.md` (adding over-engineering guards to its Step 4) left
`bundledProtocols.ts` holding the 17,416-character pre-edit body while the workspace file held
22,844 characters. `npm run compile`, `npm run compile-tests`, `npm run catalog:check` and
`test:contract:claude-protocol-block-size-contract` were all green across that divergence. The
mismatch was found by hand, by grepping the baked file for a phrase that had just been written
into the markdown.

**Why `catalog:check` does not cover it.** `catalog:check` is
`generate-protocol-catalog.js && generate-verb-allowlist.js`. Those assert that
`protocol-catalog.json` and `src/generated/verbAllowlist.ts` match the *arms and verbs* parsed out
of the protocol corpus (677 arms, 577 verbs at time of writing). They say nothing about whether a
protocol's **body text** matches its workspace file. A body can change completely without moving
either count.

**Which file owns which protocol — the part that makes the naive fix wrong.** There are **29**
protocols in `BUNDLED_PROTOCOLS` and exactly **two** directories under `.agents/protocols/`:
`improve-plan` and `improve-feature`. The other 27 protocol bodies exist *only* in
`bundledProtocols.ts` and have no on-disk source at all.

So "write a generator that rebuilds `bundledProtocols.ts` from `.agents/protocols/`" would delete
27 protocols. The ownership is genuinely split and must stay split:

| protocol set | source of truth | why |
| :--- | :--- | :--- |
| `improve-plan`, `improve-feature` | the workspace `.md` | `ProtocolService.resolveProtocol` ranks the workspace file **above** the control-plane registry for exactly these two (`ProtocolService.ts:143-150`), so the `.md` is what a planner actually reads on a machine that has one |
| the other 27 | `bundledProtocols.ts` | no on-disk source exists; the baked string is the only copy |

**The consequence is the repo's own banned pattern.** On this machine the workspace file wins, so
the edit was live and looked fine. On a fresh install there is no workspace file, resolution falls
through to the seeded bundled body, and the planner silently gets the *old* protocol — without the
guards, with no error and no log line. That is a default behaving exactly like a configured value
on a configuration read, which `CLAUDE.md` bans outright. The two-copy shape is also the same
defect class the `improve-plan` guards were written to catch.

**`contentHash` drifts with it, and it is load-bearing.** Each entry carries
`contentHash: sha256(body)`. `ProtocolService.ts:180-182` uses it to key the materialisation cache
at `~/.switchboard/cache/protocols/<contentHash>/SKILL.md`. A hand-edited body with a stale hash
serves a cached copy of the *previous* body from a path that claims to be the new one — a stale
read that survives restarts.

## Metadata

- **Tags:** reliability, test, infrastructure
- **Complexity:** 3

## User Review Required

None.

## Complexity Audit

### Routine

- Reading two files and comparing strings.
- Recomputing a sha256 over a string.
- Adding one npm script and one CI step alongside the existing `catalog:check` line.

### Complex / Risky

- **Getting the ownership direction backwards.** A gate that "fixes" drift by overwriting the
  workspace `.md` from the bundle would silently discard an operator's edit — the precise thing
  `filesPreserved` in `ClaudeCodeMirrorService` and the resolve-order comment at
  `ProtocolService.ts:143` exist to prevent. The gate must **report**, never auto-repair.
- **The 27 source-less protocols.** Any check must key off "does a workspace file exist for this
  name", never off the bundled list, or it fails 27 times on day one and gets disabled.
- **`archive` is a documented hand-edit.** The header records it. A gate that forbids hand-editing
  the file outright contradicts a decision already taken.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — both inputs are files read at check time.
- **Security:** none.
- **Side Effects:** the gate is read-only. It must not write either file. Repair stays a
  deliberate, human-run command.
- **Dependencies & Conflicts:** `.agents/` is a projected tree (`.agents/.switchboard-bundled.json`
  lists `protocols/improve-plan/SKILL.md`), and `ClaudeCodeMirrorService` owns that projection. The
  new check must run against the on-disk file and must not fight the projector. Confirm whether the
  projector can overwrite a workspace `.md` from the bundle — if it can, that is a second write path
  into the same file and belongs in this plan's finding set.

## Dependencies

None.

## Adversarial Synthesis

Key risks: a gate written in the wrong direction destroys operator edits; a gate keyed off the
bundled list instead of the workspace tree fails 27 times and gets switched off; a gate that
checks bodies but not `contentHash` leaves the cache-poisoning half of the defect open.
Mitigations: report-only with a separate explicit `--fix` path, key strictly off directories that
exist under `.agents/protocols/`, and assert body and hash as two separate named assertions so a
failure says which one drifted.

## Proposed Changes

### `scripts/check-protocol-bodies.js` (new)

- **Context:** sibling to `check-protocol-parity.js`; same reporting style and exit convention.
- **Logic:** for each directory under `.agents/protocols/`, read `<name>/SKILL.md`, parse the
  matching entry out of `BUNDLED_PROTOCOLS`, and assert two things separately:
  1. `bundled.body === <the file's exact bytes>`
  2. `bundled.contentHash === sha256(bundled.body)`
  Assertion 2 runs for **all 29** entries, not just the two with workspace files — a stale hash is
  wrong regardless of where the body came from.
- **Implementation:** report-only. On drift, print the protocol name, which assertion failed, both
  lengths, and the first differing line number, then exit non-zero with the exact command that
  repairs it. Never write.
- **Edge cases:** a workspace directory with no matching bundled entry is a failure naming the
  orphan; a bundled entry with no workspace directory is **normal** (27 of them) and must not be
  reported.

### `scripts/sync-protocol-bodies.js` (new) — the repair path, run by hand

- Copies each workspace `.md` **into** `bundledProtocols.ts` (never the reverse) and recomputes
  that entry's `contentHash`. Also recomputes any entry whose stored hash disagrees with its own
  body. Prints what it changed.
- Direction is one-way by construction, so the script cannot discard an operator edit.

### `package.json`

- Add `"protocol-bodies:check": "node scripts/check-protocol-bodies.js"`.
- Add `"protocol-bodies:sync": "node scripts/sync-protocol-bodies.js"`.

### `.github/workflows/integration-tests.yml`

- Add a `run: npm run protocol-bodies:check` step immediately after the existing
  `npm run catalog:check` step. Defining the script without wiring the step is the exact
  "green while incomplete" hole this plan exists to close.

### `src/services/bundledProtocols.ts` — the header

Replace the false header with the real contract: this file is the **source of truth** for every
protocol that has no directory under `.agents/protocols/` and is hand-edited for those; for the
protocols that do have one, the workspace `.md` is the source and this file is a generated mirror
kept in step by `npm run protocol-bodies:sync`; `contentHash` is `sha256(body)` and is verified by
`npm run protocol-bodies:check`. Keep the existing `archive` note — it is a real exception and the
new wording accommodates it rather than contradicting it.

## Verification Plan

### Automated Tests

- `npm run protocol-bodies:check` passes on a clean tree.
- **Discrimination proof, body:** append one character to `.agents/protocols/improve-plan/SKILL.md`;
  the check fails naming `improve-plan` and the body assertion. Restore by the inverse edit and it
  passes. Never `git restore`.
- **Discrimination proof, hash:** corrupt one `contentHash` digit in `bundledProtocols.ts`; the
  check fails naming that protocol and the hash assertion, and the body assertion stays green —
  proving the two are independently diagnostic. Restore by inverse edit.
- **The 27 must not fire:** with a clean tree, assert the check reports zero findings for every
  bundled protocol that has no `.agents/protocols/<name>/` directory.
- `npm run protocol-bodies:sync` on a drifted tree makes the check pass, and changes
  `bundledProtocols.ts` only.
- Existing `catalog:check` and `test:contract:claude-protocol-block-size-contract` still pass.

### Goal Invariants

- `scripts/check-protocol-bodies.js` exists, and `.github/workflows/integration-tests.yml` contains
  a `npm run protocol-bodies:check` step (defined **and** invoked — the paired assertion).
- For every directory `d` under `.agents/protocols/`, `BUNDLED_PROTOCOLS[d].body` equals the bytes
  of `.agents/protocols/d/SKILL.md`.
- For all 29 entries, `contentHash === sha256(body)`.
- `sync-protocol-bodies.js` contains no write to any path under `.agents/` — the repair direction is
  one-way, asserted as a negative.
- The string `Auto-generated bundled protocols. Do not edit directly.` is absent from
  `bundledProtocols.ts`, and the replacement header naming both ownership directions is present.

## Outstanding Questions

- **[user]** Should `protocol-bodies:check` also fail when a bundled protocol has **no** workspace
  file but its body is edited in a commit — i.e. a ratchet on hand-edits to the 27? Proceeding
  without it: `archive` proves hand-editing is legitimate, and a ratchet there needs a per-protocol
  allowlist this plan would otherwise have to invent.
