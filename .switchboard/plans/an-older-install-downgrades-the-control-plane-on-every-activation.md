# An older install overwrites the control plane on every activation, so opening the repo in a second IDE downgrades it

## Goal

Refuse to deliver the control plane when the running extension is **older** than the version that
last wrote it. Today an older install overwrites `.agents/` on every activation — not merely on a
version change — and the resulting `agentsChanged` flag then drags the protocol blocks and the
`.claude/` mirror down with it.

### Problem Analysis

**The reported symptom.** Multiple IDEs (VS Code, Cursor, Windsurf, Antigravity) each carry their own
installed Switchboard. Opening a workspace in an IDE holding an older version rewrites that
workspace's control plane to the older content. Reopening in the up-to-date IDE rewrites it forward.
The files flip-flop with whichever editor was opened last, and each flip can be captured by a commit.

**There is no version ordering anywhere.** `shouldRefreshAgentWorkspaceFiles` decides with plain
inequality:

```js
// Refresh if versions differ
if (currentVersion !== lastVersion) {
    return true;
}
```

A downgrade and an upgrade are the same input. `grep` for
`semver|compareVersion|isNewer|isOlder|versionGte` across `extension.ts` and
`ControlPlaneMigrationService.ts` returns nothing — no ordering comparison exists in the codebase.
The stamp itself (`.switchboard/.agent_version.json`) records only `{ version, lastUpdated }`, so the
data needed for an ordering test is present; nothing consults it that way.

**And the version gate does not guard the seed at all.** The ordering contract at
`extension.ts:313-319` is explicit:

| step | action | version-gated? |
| :--- | :--- | :--- |
| 1 | capture `needsAgentRefresh` | — |
| 2 | `seedBundleSurface('skills', …)` (`:344`) | **no** |
| 3 | `seedBundleSurface('workflows', …)` (`:346`) | **no** |
| 4 | `scaffoldProtocolLayers` + stamp (`:353`) | `needsAgentRefresh \|\| agentsChanged` |

Steps 2 and 3 run **unconditionally on every activation**. So "if I open it accidentally" understates
it: an older install overwrites `.agents/skills` and `.agents/workflows` every single time it
activates, whatever the stamp says. And because the overwrite returns `changed: true`, `agentsChanged`
forces step 4 as well — so one activation of an old IDE also rewrites the `CLAUDE.md` and `AGENTS.md`
managed blocks and regenerates the `.claude/` mirror from the older bundle. The stamp gates only the
scaffold, and `agentsChanged` routes around it.

**Consequence: fixing the comparison alone is insufficient.** Making
`shouldRefreshAgentWorkspaceFiles` version-aware would leave steps 2–3 untouched, `agentsChanged`
would still be set by the old bundle's hash difference, and step 4 would still fire. The gate has to
cover the seed, not just the scaffold.

**This is a shipped bug, not a dev-repo annoyance.** It affects any user with two editors — a
population that includes anyone trialling Cursor alongside VS Code. The observed damage in this repo
is the same mechanism at larger amplitude: `abd3659` took `.agents/skills/` from 17 files to 69 and
returned `<available_skills>` to ~91 entries from 4.

### Root Cause

Delivery is unconditional and version-blind. The extension assumes the bundle it carries is never
older than what is on disk — true for a single install upgrading over time, false the moment a second
install exists.

### Relationship to the other two plans

- `the-extension-must-not-seed-its-own-source-repo.md` protects **one** repo (the extension's own
  source) from **all** versions. This plan protects **all** workspaces from **older** versions. They
  overlap on the Switchboard repo and neither subsumes the other; a user's own project is covered only
  by this one.
- `packaging-must-refuse-a-clobbered-control-plane.md` catches a clobber before it ships and carries
  the repair of the two currently-clobbered protocol files. It is the backstop for both.

### Non-goals

- Not the standalone wiring gap; not the mirror removal; not the packaging guard.
- Not a confirmation gate anywhere (`CLAUDE.md`).
- No change to `same`-version or `newer`-version behaviour — those paths must stay byte-for-byte as
  they are today. Same-version seeding is a useful repair path for a corrupted file and is retained.

## Metadata

**Complexity:** 4
**Tags:** infrastructure, reliability, bugfix

## Proposed Changes

1. **Add a version comparison helper** in `ControlPlaneMigrationService` (shared code, so a later
   standalone wiring inherits it). `semver` is not a dependency and is not transitively resolvable —
   verified — so hand-roll a dotted-numeric compare returning `-1 | 0 | 1 | undefined`:
   - Split on `.`, compare the first three components numerically.
   - Any non-numeric component, missing version, or unparseable input yields `undefined` (unknown),
     never a guess.
   - Ignore prerelease/build suffixes for ordering; document that the extension has only ever shipped
     plain `MAJOR.MINOR.PATCH` (`1.7.13`), so suffix ordering is out of scope rather than wrong.

2. **Replace the refresh decision with a three-state one.** `shouldRefreshAgentWorkspaceFiles` returns
   a decision, not a boolean:
   - `installed > stamped` → **deliver** (upgrade — today's behaviour).
   - `installed === stamped` → **deliver** (repair path — today's behaviour; the bundle matches what
     this version already wrote, so seeding is a no-op or a repair).
   - `installed < stamped` → **skip** (downgrade — the fix).
   - either version missing or unknown → **deliver** (defensive; matches today's
     `!currentVersion || !lastVersion → true`). A stuck workspace with no control plane is a worse
     failure than the downgrade this plan prevents, so unknown must not fail closed.

3. **Move the gate to cover the seed loops.** In `refreshWorkspaceControlPlane`, return early on the
   `skip` decision — before `seedBundleSurface` at `:344`, not after. This is the substantive change:
   guarding only step 4 leaves `agentsChanged` free to route around it. Log one line naming the
   installed version, the stamped version, and the skip.

4. **Never stamp on the skipped path.** `setLastCopiedAgentVersion` must not run when the delivery was
   skipped. Stamping the older version would make the *next* activation read `same` and deliver the
   old bundle after all — reopening the hole one activation later.

5. **Leave the explicit Setup path (`:4455`) working.** A deliberate downgrade (rolling back a broken
   release) needs a way to bring the matching control plane with it. That is a user click, logged, not
   silent activation.

## Verification Plan

1. **The downgrade is a no-op.** Stamp a workspace at `1.7.13`, activate a fixture reporting `1.6.0`,
   and assert `.agents/skills`, `.agents/workflows`, `CLAUDE.md`, `AGENTS.md`, and `.claude/skills/`
   are all byte-identical before and after. This is the direct test for the reported symptom.
2. **The seed itself is gated, not just the scaffold.** Assert `seedBundleSurface` is not invoked at
   all on the skip path — spy on the call, do not infer from file state. A test that only checks
   `CLAUDE.md` would pass against the insufficient fix described above.
3. **The stamp is untouched by a skip.** Assert `.switchboard/.agent_version.json` still reads
   `1.7.13` after the `1.6.0` activation, and that a second `1.6.0` activation is also a no-op — the
   regression test for change 4.
4. **Upgrade still delivers.** Stamp at `1.6.0`, activate `1.7.13`, assert full delivery exactly as
   today.
5. **Same version still repairs.** Stamp at `1.7.13`, corrupt one bundled skill file, activate
   `1.7.13`, assert the file is restored — the repair path must not regress.
6. **Unknown fails open.** Assert a malformed or absent stamp, and a malformed installed version,
   both deliver rather than skip.
7. **Comparison unit tests.** `1.7.13 > 1.7.9` (numeric, not lexicographic — the string compare that
   would call `1.7.9` newer is the obvious wrong implementation), `1.10.0 > 1.9.99`, `1.7 vs 1.7.0`,
   `1.7.x` → unknown, `""` → unknown.
8. **The flip-flop is gone end to end.** Activate `1.7.13`, then `1.6.0`, then `1.7.13` again against
   one workspace; assert `git status --porcelain -- .agents .claude CLAUDE.md AGENTS.md` is empty
   throughout. Today this sequence produces two rewrites.
9. **Both hosts.** The helper and the decision live in shared code and are unit-tested there.
   Standalone wires none of these seams, so the expected result for that host is "no behaviour change";
   do not read a green `npm run standalone-parity:check` as parity evidence — it is scoped to the
   browser read-back path, not the composition root.

## Outstanding Questions

- **[user]** Which IDEs actually hold old installs, and what are their versions? Not needed to
  implement — the fix is version-generic — but it would size the exposure and confirm whether any
  install predates the `.switchboard/.agent_version.json` stamp existing at all. A workspace stamped
  by no version reads `unknown` and therefore still delivers, which is the one case this plan
  deliberately leaves open.
