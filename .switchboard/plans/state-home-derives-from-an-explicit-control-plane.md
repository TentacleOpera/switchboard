# The state home derives from an explicitly configured control plane

<!-- board-collapse-07 -->
> **PARKED IN BACKLOG 2026-09-04 (Board Collapse 07).** Not cancelled — **unreachable until the storage programme's first step lands**: *Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding*. sql.js holds the whole database in memory and rewrites the entire image on each persist, so nothing here that assumes concurrent or remote writers can be built on it. The full seven-step order is stated once, in the *Storage layer overhaul* feature file. Leaving these in Planned invited a coder to start one; move it back when step 1 lands.


## Goal

When a control plane is **explicitly** configured, resolve the machine state home
— `secrets.enc`, `.master-key`, `integration-config.json`, `cache/`,
`configbackup/` — from it instead of from `os.homedir()`, so a control plane can
hold its own credentials. Fall back to `~/.switchboard` otherwise, migrate
existing tokens deliberately, and keep both hosts resolving the same path for the
same control plane.

### Problem Analysis

**One machine can hold one account per provider.** Secret keys are flat —
`switchboard.linear.apiToken`, `switchboard.clickup.apiToken`,
`switchboard.notion.apiToken`, `switchboard.stitch.apiKey` — in a store resolved
from `stateFile()` → `stateHome()` → `os.homedir()`
(`src/utils/stateHome.ts:19-35`). So a work control plane and a personal one share
one Linear token. If a control plane is an org or client context, that is a real
limitation rather than a preference.

**Auto mode makes the control plane the workspace, which is where secrets must not
go.** `getControlPlaneSelectionStatus` (`KanbanProvider.ts:7966`) returns
`mode: 'explicit'` with the configured root, or `mode: 'auto'` — and in `auto`,
`controlPlaneRoot` **is the workspace root**, with no detection involved.

Deriving the state home from that would put `secrets.enc` back inside the
workspace, which is precisely what `migrateLegacyWorkspaceSecrets`
(`hostServices.ts:185`) exists to undo and what `WorkspaceExcludeService.ts:36`
still excludes. **So: explicit only.** Auto mode falls back to the home directory,
always. This is the load-bearing rule of the plan and the one a later
"convenience" will try to relax.

**The two hosts share this store, and a divergence is silent.** The extension is
authoritative through VS Code SecretStorage, and **mirrors four of the five keys**
into the machine-global file store so standalone can use them
(`extension.ts:612-645`, `MIRRORED_SECRET_KEYS` — `switchboard.apiToken` is
deliberately excluded, staying editor-only). There is a read-back path too
(`:672-676`) that backfills the editor from the store.

If the extension resolves one state home and standalone resolves another, the
mirror keeps working perfectly and writes to a file nobody reads. The symptom is
"Linear isn't connected" in standalone, with no error anywhere. **Both hosts must
resolve identically for the same control plane** — that is the correctness
requirement, more than the relocation itself.

**Resolution is synchronous and happens at construction.** `stateHome()` is a pure
sync function with no config or DB access, and `stateFile()` is called while
constructing stores (`extension.ts:623`, `hostServices.ts:175`) as well as lazily
in getters (`GlobalIntegrationConfigService.ts:80`, `:84`, `:184`). So the control
plane must be resolved and handed to the resolver **before the first store is
constructed** — and the explicit root lives in
`_context.workspaceState` (`KanbanProvider.ts:7968`), which is extension-only and
not readable from a shared sync function.

**Getting the path wrong does not raise an error.** The store renames an
undecryptable file aside (`_handleCorruptStore`), and refuses writes when the file
is present but unreadable (`_unreadable`). It also tries multiple candidate keys
specifically so a host lacking `SWITCHBOARD_MASTER_KEY` cannot declare a good
store corrupt and destroy the other host's tokens. A relocation that points at an
empty directory therefore presents an empty store — no error, no tokens, and the
user reconnects everything believing they lost them.

### Root Cause

The state home was defined as "the machine", which was right when there was one
board per machine. The canonical layout makes a control plane the unit of setup, and
nothing carried that through to where credentials live.

### Non-goals

- **Deriving from an auto-detected control plane.** Explicit configuration only.
- **Changing VS Code SecretStorage usage.** The extension keeps `context.secrets`
  as authoritative for its keys; only the file-backed mirror's *location* changes.
- **Changing what is mirrored.** `MIRRORED_SECRET_KEYS` stays as it is, and
  `switchboard.apiToken` stays editor-only.
- **A keychain for the standalone host**, or changing the encryption.
- **Moving `.master-key` away from the ciphertext**, or key management generally.
- **Any automatic migration back to `~/.switchboard`.**
- **Backing the state home up.** Explicitly out of scope for
  `backups-that-can-actually-be-restored.md` too — a backup set must never sweep
  `secrets.enc` and `.master-key` into a store that may be a git repo, since the
  key sits beside the ciphertext it decrypts.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 5
**Tags:** security, backend, infrastructure, devops, reliability

## Dependencies

`canonical-control-plane-layout-with-sibling-repos.md` — this is the same
derive-from-one-root idea applied to credentials, and it should land after the
layout so there is a configured control plane to derive from.

## Proposed Changes

### 1. `stateHome()` gains a set-once override

```ts
setStateHomeOverride(root: string | null): void   // sync, idempotent, sealable
```

Precedence, highest first:

1. `SWITCHBOARD_STATE_HOME` — unchanged. It is the escape hatch and the test
   sandbox depends on it (`stateHome()` throws in an unsandboxed test process).
2. The override, when a host has set one from an **explicit** control-plane root.
3. `os.homedir()`.

**Sealed on first read.** The first `stateFile()` call seals the resolution;
setting the override afterwards throws in development and is logged-and-ignored in
production. Without this, an ordering mistake resolves some stores under one root
and some under another — the divergence above, but within a single process. Making
it loud is the whole value of the seam.

### 2. Each host resolves the control plane before constructing anything

- **Extension** — read the explicit root the way
  `getControlPlaneSelectionStatus` does (`_context.workspaceState`), at the top of
  `activate`, before the `globalSecrets` construction at `:623`. Only
  `mode: 'explicit'` sets the override.
- **Standalone** — `createStandaloneHostSecrets(workspaceRoot?)` already takes a
  root (`hostServices.ts:174`); resolve the explicit control plane from the
  standalone host's own config provider and set the override before the two
  `stateFile()` calls at `:175-176`.

**One resolution function, shared, taking the explicit root as an argument.**
Not two implementations reading two config sources — that is exactly how the two
hosts end up on different paths, and this codebase has the rule about it.

### 3. Migration: copy, verify, and leave the original

On the first resolve to a control-plane state home:

- if that directory has no `secrets.enc` **and** `~/.switchboard/secrets.enc`
  exists → copy `secrets.enc` and `.master-key`, then **verify by opening the copy
  and comparing its key set to the source's**. Only report success on a match.
- **Leave the originals in place.** Per project rules, legacy state is archived
  rather than unlinked, and here it is also the fallback if the copy is wrong.
- `integration-config.json` is copied the same way. `cache/` and `configbackup/`
  are regenerable and are not migrated.
- Report what happened, once, in a surface the user will see. A silent credential
  relocation is indistinguishable from credential loss.
- If the source store is unreadable or undecryptable, **do not copy** — copying
  ciphertext without a working key produces a store that will be renamed aside on
  first read.

### 4. Make the resolved path visible

Show the effective state home, its source (env / control plane / home), and
whether a migration has run, in Setup beside the control-plane selection. Two
questions get asked when this goes wrong — *where are my tokens* and *why does
standalone not see them* — and both are answered by printing the path.

### Migration (install-level)

Nobody's path changes unless they configure an explicit control plane. `auto` mode,
which is the default, resolves exactly as today. `SWITCHBOARD_STATE_HOME` users are
unaffected.

## Verification Plan

1. **Auto mode never relocates** — with no explicit control plane, assert the
   state home is `os.homedir()` even when the workspace looks like a control plane.
   Then assert no `secrets.enc` is ever created inside a workspace root. This is
   the rule that reverses a completed migration if broken.
2. **Precedence** — `SWITCHBOARD_STATE_HOME` beats an override; an override beats
   the home directory.
3. **Sealing** — setting the override after the first `stateFile()` throws in
   development; assert the seal cannot be bypassed by re-import.
4. **Both hosts agree** — configure one explicit control plane; assert the
   extension host and the standalone host resolve the identical path, and that the
   mirror handshake works end to end: set a Linear token in the editor, read it
   from standalone.
5. **The divergence is caught** — force the two hosts to resolve differently and
   assert the failure is visible (a reported mismatch), not a silently empty store.
   This is the failure mode the plan exists to prevent, so it needs a test that
   the *symptom* is loud.
6. **Migration copies and verifies** — a home store with four tokens migrates to a
   fresh control-plane home; assert all four decrypt from the copy, the originals
   remain, and the result is reported.
7. **Migration refuses on an unreadable source** — make the source undecryptable;
   assert nothing is copied and the reason is reported, and that the source is not
   renamed aside as a side effect.
8. **No re-migration** — a control-plane home that already has `secrets.enc` is
   left alone, even if the home store has different keys.
9. **`switchboard.apiToken` stays editor-only** — assert it is never written to
   the file store under any path, before or after relocation.
10. **Two control planes, two accounts** — configure two explicit control planes
    with different Linear tokens; assert each resolves its own and neither reads
    the other's. This is the capability the plan is for.
11. **Backups exclude it** — assert a backup set contains no `secrets.enc` and no
    `.master-key`, wherever the state home resolved to.

### Goal Invariants

- A secrets store is never created inside a workspace root.
- Both hosts resolve the same state home for the same control plane, and a
  mismatch is reported rather than silent.
- No credential is moved; copies are verified and originals are kept.
- An install that has not configured an explicit control plane sees no change.
- Two control planes can hold two different accounts for the same provider.
- No backup or published artifact ever contains the secrets store or its key.
