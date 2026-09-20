# Add Machine is a Name and a Connection String

## Goal

Replace the six-field machine editor with what the operator actually asked for: a **name** and a
**connection string** (`ssh tower`), plus the remote working directory — the one field beyond the
connection that real work needs. Everything else the form collects today is either derivable
(transport, ID) or belongs to scaffolding, not configuration (CLI path). The probe goes with it:
remote setup is the operator's responsibility, documented on the docs site, not something the panel
verifies.

### Problem analysis

- **The form is the schema, not the task.** `AgentMachine` has six stored fields, so the editor grew
  six inputs (`agent-control.html:3063-3086`). But the operator's mental model has two things: what
  the box is called and how to reach it. `transport` + `transportPrefix` are a decomposition of
  `ssh tower`; `id` is a storage key the operator should never have had to invent.
- **`cliPath` is scaffolding, not config.** The field overrides where `switchboard` resolves on the
  remote box. But a remote seat needs the `switchboard` CLI installed there *regardless* — it is
  the seat's only callback channel (`next`, `done`, `accept`). Installing it, on `PATH`, is part of
  setting the box up; a box without it fails no matter what the form collects. An override for
  "installed somewhere weird" optimises for the case the setup docs should just forbid.
- **The probe is overbuilt reassurance.** `probeMachine` ssh's `true` then `command -v switchboard`
  (`KanbanProvider.ts:14675`, `TaskViewerProvider.ts:16400`). It can only ever report "you didn't
  set it up" — information the docs page and the first dead seat both deliver, without a verb, two
  provider arms, and an `execFile` wrapper to maintain. Operator direction: it is on the user to set
  the remote up correctly.
- **Removing the probe removes a constraint.** The probe passes `transportPrefix` as ONE argv
  element to `execFile` — the reason "prefix" had to be a single `user@host` token. With the probe
  gone, the only consumer is `renderSpawnCommand`, which builds a shell string typed into a pty:
  `ssh -p 2222 tower` in a connection string just works.

## Metadata

**Feature:** 2b621be1-366c-4bf5-8aaf-183c3f852742 (Agent Control becomes its own panel — same
feature as the machine editor itself)
**Complexity:** 3
**Tags:** ux, agents, remote
**Project:** Browser Switchboard
**Dependencies:** None. Textual adjacency with
`build-target-moves-to-its-own-tab-in-agent-control.md` (both edit the AGENTS tab region of
`agent-control.html`) — land in either order, resolve the diff, no semantic conflict.

## User Review Required

- **`AgentMachine.cliPath` is deleted, not hidden.** Remote seats resolve bare `switchboard` via
  the remote's `PATH`, always. A box that needs the CLI somewhere else must put it on `PATH` — that
  is the scaffolding contract the docs page will state.
- **`probeMachine` is deleted** — button, verb, and both provider arms.
- **Working directory becomes required.** The old "optional" label described the field's empty
  state, not the need — a remote seat in `$HOME` has no checkout. Blank is now an inline error.
- **A docs link is added** to the form pointing at `labcom.dev/docs/remote-machines` (page lands
  at launch — see Outstanding Questions).

## Complexity Audit

### Routine

- Rewriting the form markup (six inputs → three) and its save/load JS.
- Slugify: `name.trim().toLowerCase()` with whitespace→`-` and invalid chars stripped, then the
  existing uniqueness check. Reuses the existing ID validation regex.
- Deleting the PROBE button, status span, and `agentsTabProbeMachine`.

### Complex / Risky

- **`cliPath` removal crosses both composition roots' providers.** `saveMachine` arms persist it
  and `probeMachine` arms read it in BOTH `KanbanProvider.ts` and `TaskViewerProvider.ts`; deleting
  the field in one provider and not the other is the classic divergence — a machine saved through
  one host's panel would carry a key the other host neither writes nor strips. Both provider diffs
  land together, and `protocol-catalog.json` + `verbAllowlist.ts` are regenerated after the
  `probeMachine` verb comes out.
- **`resolveCliInvocationForMachine` loses its configured-path arm.** The remote branch becomes
  bare `switchboard` unconditionally. This is the behaviour the field's absence already produced —
  empty cliPath resolved to PATH lookup — so the deletion cannot regress a working remote seat; it
  can only remove an override nothing in the UI could set anyway after this lands.
- **Edit-mode recomposition.** EDIT must rebuild the connection string from the stored record
  (`${transport} ${transportPrefix}`) so a round-trip through the form is lossless. Machines the
  operator already saved keep working: their records already carry `transport`/`transportPrefix`,
  which is exactly what the new form writes.

## Edge-Case & Dependency Audit

- **Connection strings with flags.** `ssh -p 2222 tower` parses to transport `ssh`, prefix
  `-p 2222 tower` — and works, because `renderSpawnCommand` emits a shell string into a pty. The
  parse rule is `^(ssh|mosh)\s+(.+)$`: first token the transport, the rest the prefix verbatim.
  Anything else is a form error naming the expected shape (`ssh user@host`).
- **Local machines cannot be created here.** `local` is built-in and undeletable; a connection
  string is always required, so every machine added through this form is remote by construction.
- **Stored `cliPath` values on existing records** are dead weight after this lands. The machines
  feature (2026-09-13) and these fields (2026-09-18) have only ever existed in unreleased dev work
  — clean break per the migrations rule: the key is ignored on read and dropped on next save. No
  migration.
- **Existing records without `remoteCwd`** (saved under the old optional form) keep spawning into
  remote `$HOME` — spawn behaviour is unchanged by this plan. The new required-field rule applies
  at the form: editing such a machine forces the operator to state the directory explicitly, which
  is exactly the conversation the old "optional" label let them skip.
- **Race conditions:** none — same save path, fewer fields.
- **Security:** removing the `execFile` probe removes an argv-boundary that was load-bearing *for
  the probe*; the spawn path's threat model is unchanged (operator's own command typed into their
  own pty). No new injection surface is created — `transportPrefix` reached the pty as shell text
  before and after.
- **Standalone parity:** `agent-control.html`/`.js` are served by both hosts, so the UI change is
  parity-by-construction; the provider deletions (`probeMachine`, `cliPath` persistence) are NOT —
  they must land in both `KanbanProvider` and `TaskViewerProvider`, verified by diff, not inferred.

## Dependencies

None blocking. See Metadata for the textual adjacency with the build-target tab plan.

## Adversarial Synthesis

The honest risk is deleting something that is quietly load-bearing elsewhere. Checked: `cliPath`'s
only readers are `resolveCliInvocationForMachine`, the two `probeMachine` arms (deleted here), and
the two `saveMachine` persistence arms (updated here) — nothing else consumes it; `machineStartupCommands`
(the per-role agent CLIs like `agy`/`claude`) is a different, untouched mechanism. `probeMachine`'s
only callers are the webview button and the verb surface; nothing else probes. The residual risk is
a missed reference in `cli.ts` or the contract tests — the verification section pins both.

## Proposed Changes

### 1. The form: three fields and a link

`agent-control.html` machine form becomes:

- **Name** — display label; the ID is slugified from it on save (not an input).
- **Connection** — e.g. `ssh tower`, `ssh user@host -p 2222`, `mosh tower`. Required.
- **Working directory on that machine** — **required, not "optional".** Today's label says optional
  because the *field* may be empty, but empty resolves to remote `$HOME` — a seat with no repo, no
  `.switchboard/`, nothing to work on. That is a wrong answer wearing a default, not a real choice;
  the local seat's implicit workspace cwd has no remote equivalent to fall back to. If a checkout
  genuinely lives at the remote `$HOME`, typing `~` or `$HOME` says so explicitly. Required field,
  inline error when blank, placeholder keeps the `e.g. /home/user/checkout` hint.
- A static line under Connection: *"Remote machines need the `switchboard` CLI installed and on
  PATH — see the setup guide."* linking to `https://labcom.dev/docs/remote-machines` (slug TBD
  until launch — see Outstanding Questions).

Removed: ID input, Transport select, Transport prefix input, CLI path input, PROBE button and its
status span.

### 2. Parse and save (`agent-control.js`)

- On save: match the connection string against `^(ssh|mosh)\s+(.+)$`. No match → inline error
  ("Connection must start with `ssh` or `mosh`, e.g. `ssh user@host`"), no post. Match →
  `transport` = token, `transportPrefix` = rest.
- ID = slugified name; empty result → error; collision with an existing id in add-mode → error
  (existing check reused).
- Save posts the same `{ machine, mode }` shape as today — the record is unchanged minus `cliPath`,
  so `saveMachine` needs no new contract.
- Working directory blank → inline error, no post (same pattern as the connection error).
- On edit: name → name field; connection field = `${transport} ${transportPrefix}`; remote cwd →
  its input.
- `agentsTabProbeMachine` and its listener deleted.

### 3. `cliPath` and `probeMachine` come out — both providers

- `AgentMachine.cliPath` deleted (`GlobalIntegrationConfigService.ts`); `resolveCliInvocationForMachine`
  remote arm → bare `switchboard` unconditionally (`cliPathToken.ts`).
- `saveMachine` arms in `KanbanProvider.ts` AND `TaskViewerProvider.ts` stop persisting `cliPath`.
- `probeMachine` arms deleted in BOTH providers; `probeMachine` removed from the verb surface and
  `protocol-catalog.json` / `verbAllowlist.ts` regenerated (`npm run catalog:check` green).
- `agent-machines-contract.test.js` §10 updated: the cliPath-resolution cases become "remote always
  resolves bare `switchboard`"; any probe assertions deleted.

### 4. Docs

No repo docs page exists for remote setup yet — the form links the docs site root/slug and the
page content is a launch deliverable, tracked here only as the link target.

## Verification Plan

- The form shows Name, Connection, Working directory, and the docs link — nothing else.
- `ssh tower` + name `Tower` + cwd `/home/patrick/checkout` saves
  `{ id: 'tower', name: 'Tower', transport: 'ssh', transportPrefix: 'tower',
  remoteCwd: '/home/patrick/checkout' }`; `mosh tower` saves transport `mosh`; `ssh -p 2222 tower`
  saves prefix `-p 2222 tower`.
- `tower` alone, `telnet tower`, or a blank working directory is refused inline with a field-level
  error — no post reaches `saveMachine`.
- Editing an existing machine round-trips: the connection field shows the recomposed string and a
  save with no edits changes nothing.
- A seat dispatched to a remote machine emits bare `switchboard` in `<cliPath>` substitutions —
  never the host's absolute path (existing negative assertion stays green).
- `grep -rn 'cliPath' src/` finds only the `<cliPath>` *token* machinery (prompt substitution),
  never `machine.cliPath` / `cliPath:` persistence; `grep -rn 'probeMachine' src/` finds nothing.
- `npm run compile-tests`, `test:contract:agent-machines`, `catalog:check` all green.
- Panel verified in BOTH hosts: standalone board and extension — same form, same save.

### Goal Invariants

- **Positive:** the machine form contains exactly three inputs (name, connection, working
  directory) — all three required.
- **Positive:** saving `ssh <dest>` produces a record indistinguishable from today's
  `{ transport: 'ssh', transportPrefix: '<dest>' }`.
- **Positive:** remote `<cliPath>` resolution is bare `switchboard` with no configured-path branch.
- **Negative:** no `probeMachine` verb, button, or provider arm survives; catalog regenerated.
- **Negative:** `extension.ts` and `standalone/bootstrap.ts` are untouched — the providers carry
  this change, the composition roots do not.

## Outstanding Questions

- **[ANSWERED 2026-09-19 — the site is labcom.dev, not switchboard.dev.]** The form links
  `https://labcom.dev/docs/remote-machines`. The remote-setup page does not exist yet; direction is
  that it will at launch — if the slug differs the link is one line. Note for that launch sweep:
  `protocolScaffolder.ts` still emits `switchboard.dev/docs` references, which are out of scope here
  but ride the same rename.
- **[ANSWERED 2026-09-19 — required, per operator.]** "If it is needed, why is it labelled
  optional?" — it isn't, anymore. Working directory is a required field; `$HOME` remains reachable
  by typing it explicitly.
