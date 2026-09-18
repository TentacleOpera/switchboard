# board-read-endpoints Is Red: the Bundled HTTP Contract No Longer Matches Its Skill Source

**Complexity:** 2
**Tags:** testing, protocols, build

## Goal

# board-read-endpoints Is Red: the Bundled HTTP Contract No Longer Matches Its Skill Source

## Goal

Get `board-read-endpoints-contract` green, and make the parity it guards hard to break by hand.

### Problem analysis

**One test fails; 36 pass.** The failing assertion is *the bundled HTTP contract is byte-identical to
its skill source (no half-updated copy)*:

```js
const bundled = bundledProtocol('switchboard-mission-control-http');
const skill = fs.readFileSync(path.join(AGENTS, 'skills', 'switchboard-orchestration', 'SKILL.md'));
assert.strictEqual(bundled, skill,
  'the two copies of the read contract must not drift -- an agent reads whichever one its host serves');
```

`.agents/skills/switchboard-orchestration/SKILL.md` has 7 uncommitted insertions in the working tree.
`src/services/bundledProtocols.ts` still holds the pre-edit copy, so the two have drifted and the
test is doing its job.

**The reason it matters is in the assertion message.** An agent reads whichever copy its host serves,
so a drifted pair means two agents given the same nominal contract can behave differently. This is
not a cosmetic test.

**The regeneration path is unclear, and one protocol has already lost its source.** `bundledProtocols.ts`
is headed *Auto-generated bundled protocols. Do not edit directly*, but no script in `scripts/` writes
it, and the `archive` protocol's source markdown does not exist anywhere in the repo -- that file is
now its only copy, and it had to be edited in place on 2026-09-18. So the banner is true for some
entries and false for others, with nothing marking which.

### Root Cause

Two copies of a contract with a test asserting equality, and no reliable generator keeping them
equal. The test is the only thing holding the invariant, so every source edit turns the suite red
until someone hand-syncs the bundle.

### What this card must do

1. Sync the bundled `switchboard-mission-control-http` entry with the current SKILL.md and get the
   suite green.
2. Find or restore the generator. If one exists, document the command in the file header; if it does
   not, say so in the header and note which entries have no source.
3. Recover or recreate a source for the `archive` protocol, or state explicitly that
   `bundledProtocols.ts` is its home so the next editor is not working against the banner.
4. Consider making the test point at the generator: regenerate into a temp file and compare, so the
   failure says "run X" instead of "these differ".

## Metadata

**Complexity:** 2
**Tags:** testing, protocols, build
**Dependencies:** none. Independent of the archive work, though the archive protocol's missing source
was found during it.

## User Review Required

1. **Should the SKILL.md edit in the working tree be committed as-is?** It is the operator's, not
   from the archive work, and this card assumes it is intended. If it was experimental, reverting it
   turns the test green with no other change.

