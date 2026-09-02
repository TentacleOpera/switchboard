# Retire `sb_api_call.sh` — move every agent protocol, skill and workflow onto the CLI

## Goal

Rewrite the thirty-eight agent-facing files that reach the Switchboard API through `curl` /
`sb_api_call.sh` so they invoke `switchboard` CLI subcommands instead, then delete
`.agents/skills/_lib/sb_api_call.sh` and the port-discovery preamble every one of them carries.
One transport, one auth path, one offline message.

### Problem Analysis

**The agent-facing layer and the CLI are two independent clients of the same server, and only one
of them is correct.**

Zero of `.agents/protocols/*/SKILL.md`, `.agents/skills/*/SKILL.md`, `.agents/workflows/*.md` and
`.claude/skills/*/SKILL.md` reference a `switchboard` subcommand. Thirty-eight of them reference
`sb_api_call`, `curl`, or `.switchboard/api-server-port.txt` directly. The heaviest are
`switchboard-orchestration/SKILL.md` (21 curl invocations),
`switchboard-mission-control-http/SKILL.md` (21) and `switchboard-mission-control/SKILL.md` (8).

Three concrete costs:

1. **No auth.** `sb_api_call.sh` never sends an `Authorization` header. After `switchboard token
   set`, every skill 401s while the CLI keeps working. Two protocols instruct the agent to *"pass
   `Authorization: Bearer <token>`"* (`switchboard-mission-control-http/SKILL.md:45`,
   `switchboard-orchestration/SKILL.md:45`) with no mechanism that does it.

2. **Port discovery is copy-pasted prose.** `switchboard-mission-control/SKILL.md` carries a
   "Port Discovery" section instructing the agent to paste a four-line resolve *at the top of each
   block* — *"it is four lines and not one because your shell does not survive between snippets."*
   That entire section is `findRunningInstance()` reimplemented in markdown, thirty-eight times,
   with the liveness caveat (`a port file is not liveness`) restated by hand in each place that
   remembered it.

3. **Every snippet is a place to get the shape wrong.** The `cmdVerb` implementation carries a
   comment recording exactly this: the terminal rail never 404s for an unknown verb, it returns a
   502 with `not implemented`, so a 404-only fallback *"never fired, and every kanban verb
   (including the plan's own `verb moveCard` example) died on the terminal rail."* That knowledge
   now lives in one compiled place. In a markdown snippet it would still be wrong.

**Eight scripts have the same problem in JavaScript.** `.agents/skills/kanban_operations/*.js`
(`move-card.js`, `create-feature.js`, `assign-to-feature.js`, `delete-feature.js`,
`reconcile-features.js`, `remove-from-feature.js`, `split-feature.js`, `get-state.js`) each open
their own socket with the same port-file-then-request pattern and the same missing token.

### Root Cause

`sb_api_call.sh` predates the CLI. When the CLI arrived it was scoped as a *user's* terminal
interface — `plans`, `ready`, `dispatch`, `fleet` are each a human workflow — and nothing prompted a
sweep of the agent layer, because the agent layer was green: `sb_api_call` still worked for every
user who had never set a token. The two clients drifted with no gate able to see it, because no
test reads the markdown for transport choice.

### Non-goals

- **Not changing any endpoint or verb.** This is a transport rewrite; every call keeps its method,
  path and payload.
- **Not rewriting protocol content.** Prose, personas and decision rules stay as they are except
  where they describe the transport.
- **Not adding named domain subcommands.** Migration targets `switchboard api` plus the existing
  board commands.
- **Not touching `ClaudeCodeMirrorService.ts`'s reference** to the lib path without checking what
  it mirrors — see Edge-Case audit.

## Metadata

**Complexity:** 6
**Tags:** docs, refactor, cli, security, devops, reliability
**Feature:** 6fc37578-c8e2-4de7-be8e-8aed2976fe7d

## Dependencies

- **Hard prerequisite:** `switchboard-api-escape-hatch-in-the-cli.md`. Eleven of the routes these
  files call are plain REST and unreachable from `verb`. Migrating before `switchboard api` exists
  would strand them on curl and leave two transports documented — the exact state this plan ends.

## User Review Required

None.

**Both trees are edited by hand; regeneration is not relied on.** `.claude/skills/` carries copies
(`manage-features`, `worktree-cleanup`, `switchboard`, `kanban-operations`) which are *derived* today
by `generateClaudeMirror` — but that runs from `extension.ts:4106` and **nowhere else**, so the
standalone host never regenerates, and
`feature_plan_20260827144002_claude-mirror-not-regenerating-on-deletion.md` records that it does not
always fire where it is wired.

`delete-the-claude-mirror-generator.md` then removes the generator entirely and commits the eight
files as ordinary bundle assets, after which nothing regenerates them anywhere. Either way the safe
instruction is the same: **migrate both trees explicitly in this change**, and do not assume a
regeneration will carry the edit across. A `.claude/` copy left behind keeps teaching curl to
whichever host reads it.

### How protocols reach a workspace (settled — no action needed for this plan)

Protocol edits in this repo **do** reach users, by two hops:

1. **Into the VSIX.** `.vscodeignore:56-57` — *"Keep `.agents/` — workflow assets are shipped with
   the extension"* — negates the whole tree, `protocols/` included.
2. **Into each workspace.** `ControlPlaneMigrationService.ts:704` calls
   `_copyDirectoryRecursive(bundledAgentDir, <workspace>/.agents, { overwrite: false,
   overwriteIfDiffers: true })` — the entire tree, recursively. The only exclusions are the
   two-entry `AGENT_COPY_BLOCKLIST` (`:1042-1048`): `personas/switchboard_operator.md` and the
   ledger file. Protocols are in neither.

`.agents/.switchboard-bundled.json` is **not a copy list** — it is the retirement prune ledger
(`:1050-1053`: *"On-disk ledger of which files the bundle last shipped into `.agents/`. Drives the
`.agents` retirement prune"*), generated at runtime into each workspace and blocklisted from
shipping. Its absence of a `protocols/` entry says nothing about copying.

**But it does say something about deletion — see the note below.**

## Complexity Audit

### Routine

- Mechanical substitution of `sb_api_call GET /x` → `switchboard api GET /x` in most files.
- Deleting the port-discovery preamble from each file that carries one.

### Complex / Risky

- **`src/test/mission-control-tick-and-reports-contract.test.js` greps these exact files.** It reads
  `PERSONA`, `EXTERNAL_RUNSHEET`, `INTERNAL_RUNSHEET`, `ORCHESTRATION`, `LAUNCHER` and `GROUPING`
  by path and asserts on their content, precisely because *"a persona is executable specification
  with no compiler"*. Rewriting these files without updating the gate turns it red; updating it
  carelessly deletes the coherence checks it exists to enforce. The gate is edited deliberately, in
  the same commit, preserving every assertion that is about meaning rather than transport.
- **Verb-rail knowledge must not be lost in translation.** The `mission-control-http` protocol owns
  the canonical-column rule and the verb-rail traps, and the contract test asserts they live
  *somewhere other than git history*. Substituting the transport must not drop the surrounding
  prose those assertions read.
- **The eight `kanban_operations/*.js` scripts are called by name from personas.** The Mission
  Control persona's Hard Rule 3 names `node .agents/skills/kanban_operations/move-card.js <planId>
  <COLUMN>` explicitly. Their invocation contract cannot change; only their internals move to
  shelling out to the CLI (or to a shared helper that does).
- **`ClaudeCodeMirrorService.ts` references `sb_api_call`.** Deleting the file without
  understanding that reference risks breaking the Claude mirror generation. Read it first.
- **`terminal-token-transport-contract.test.js` references it too** — likely the test that should
  be *asserting* the token gap and currently is not. Check whether it can be inverted into the
  regression guard for this plan.

## Edge-Case & Dependency Audit

- **`CLAUDE.md` documents the lib path** (*"shell out via `.agents/skills/_lib/sb_api_call.sh`"*).
  It is updated in the same change, or the repo's own instructions point at a deleted file.
- **Bundle manifest.** `.agents/.switchboard-bundled.json` lists `skills/_lib/sb_api_call.sh`.
  Deleting the file without removing the manifest entry leaves the copier looking for a file that
  does not exist. `ControlPlaneMigrationService.ts:1210` has a *"creation-path guard: when a bundled
  file is absent from the workspace"* — read it before deleting to see which way it fails.
- **Protocols are copied but never pruned.** The prune ledger's `currentBundlePaths` are documented
  as *"skills + workflows"* (`ControlPlaneMigrationService.ts:1305-1307`), so no protocol file is
  ever tracked for retirement. This plan only rewrites protocol *content* — an overwrite, which
  `overwriteIfDiffers: true` handles — so it is unaffected. It is called out here because the same
  gap blocks `protocols-as-db-rows-not-scaffolded-files.md`, and is planned separately in
  `retired-protocol-files-are-never-pruned-from-a-workspace.md`.
- **Existing installs carry the old file.** Per `CLAUDE.md`'s migration rule, `sb_api_call.sh`
  shipped in a released version, so workspaces have it on disk. It is archived as
  `sb_api_call.sh.migrated.bak` rather than unlinked, and unknown sibling files under `_lib/` are
  preserved.
- **`switchboard` must be on PATH.** The CLI ships as a `bin` entry (`package.json`), so an agent
  in a fresh shell may need `npx switchboard`. Every migrated snippet uses one form consistently,
  and the choice is stated once per file rather than assumed.
- **Offline behaviour changes shape.** `sb_api_call` emitted a JSON `{"error": …}` on stderr; the
  CLI emits its own offline guidance and a distinct exit code. Any skill that branches on the old
  string must be updated, not just retargeted.

## Adversarial Synthesis

Key risks: the "read before deleting" step names two `src/` files but doesn't specify the action,
leaving a coder to re-derive the verdict; the eight `kanban_operations/*.js` scripts each carry
their own `httpJson` and the plan doesn't say whether they converge on a shared helper or shell to
the CLI independently; the Mission Control contract test's transport-vs-protocol assertions are not
enumerated, risking a trial-and-error edit that deletes coherence checks. Mitigations: step 1 now
records the verdict and action for each `src/` file; step 2 specifies a shared `_lib/cli-call.js`
helper; the contract-test note identifies the `cat`-of-port-file assertion as the one that flips.

## Proposed Changes

Sequenced so each step is independently verifiable.

### 1. Read before deleting — verdict and action

`ClaudeCodeMirrorService.ts` and `terminal-token-transport-contract.test.js` both reference
`sb_api_call.sh` in `src/`, outside the transport sweep's scope (`.agents/` + `.claude/skills/`).
Neither encodes a transport contract that breaks on deletion; both carry **documentation** that
goes stale when the shim is deleted. The verdict and action for each:

- **`ClaudeCodeMirrorService.ts:18`** — invariant comment names `_lib/sb_api_call.sh` as an
  auxiliary file that is NOT copied into `.claude/`. After deletion, the comment points at a ghost.
  **Action:** update the comment to name the CLI as the transport (the invariant — "auxiliary files
  are not copied" — still holds; the example changes). **`ClaudeCodeMirrorService.ts:98-107`** — the
  `SWITCHBOARD_ALLOW_ENTRIES` comment and list include `Bash(curl *)` and `Bash(source *)` as
  patterns `sb_api_call.sh` runs. After migration, no mirrored skill invokes `curl` or `source`.
  **Action:** remove `Bash(curl *)` and `Bash(source *)` from the allow list (dead entries after
  migration), or retain them if any non-mirrored skill still uses them — verify before removing.
  These are `src/` documentation/allow-list edits, not swept by the transport gate.

- **`terminal-token-transport-contract.test.js:14,152`** — comments name `sb_api_call.sh` as the
  thing "the whole skill ecosystem rides" with no token handling. After migration, the ecosystem
  rides the CLI. **Action:** update the comments to reference the CLI. The test's assertions
  (terminal token transport, CSP legality, `getAuthToken` not returning the terminal token) are
  unaffected — they are about the terminal channel, not the HTTP API transport.

### 2. Migrate the eight `kanban_operations/*.js` scripts

Their CLI invocation contract is fixed by the personas that name them. Change internals only.
**Converge on a shared `_lib/cli-call.js` helper** (beside the existing `_lib/workspace-root.js`)
that shells out to `switchboard api` and inherits token discovery, offline handling, and exit-code
mapping from the CLI. Each script's `httpJson` + `findApiPort` is replaced by a call to this helper
— one place for the transport, not eight. The helper resolves the workspace root via the existing
`_lib/workspace-root.js`, then invokes `switchboard api <METHOD> <path> [json]` and parses the
`--json` envelope. Verify `move-card.js` still moves a card end-to-end before touching any markdown.

### 3. Migrate `.agents/skills/` (bundled)

`switchboard-orchestration` (21 calls), `manage-features`, `worktree-cleanup`, `improve-feature`,
`external-team-lead`, `kanban_operations/SKILL.md`, `query-kanban`. Delete each file's port-discovery
preamble; replace snippets with CLI invocations.

### 4. Migrate `.agents/workflows/switchboard.md` (bundled, 4 calls)

### 5. Migrate `.agents/protocols/` — pending the User Review answer above

Seventeen files. The three Mission Control documents are the delicate ones and are done last, with
the contract gate updated in the same commit.

**Contract-test assertion map (`mission-control-tick-and-reports-contract.test.js`):**
- **Flips from transport to CLI:** the `## Port Discovery` section assertion (line 182) and the
  `PORT=$(cat …api-server-port.txt)` negative assertion (line 192) — these check that the persona
  resolves the port through a health-checked probe. After migration, the persona resolves through
  the CLI, so the section and the `cat`-of-port-file negative both change shape. The `A port file is
  not liveness` and `does not mean no terminals exist` assertions (lines 184-190) are **protocol
  invariants that stay** — the CLI still needs to communicate that a stale port is not liveness.
- **Protocol invariants — stay untouched:** the ready-to-go query (lines 141-154), the
  `POST /kanban/dispatch` forbidden-verb assertion (lines 170-179), `ptySendPrompt` (line 176), the
  `progress.json` / `stallCount` assertion (lines 120-123), the `session.md` / `session-log.md`
  assertion (lines 133-139), the Hard-Rule scope exclusion (lines 105-118), the self-wake contract
  (lines 197-252), the handoff decision (lines 254-260), and the Miscellaneous sweep (lines 295-310).
  These are about meaning, not transport — editing them deletes coherence checks the gate exists to
  enforce.

### 6. Mirror `.claude/skills/`

Four files, kept identical to their `.agents/` counterparts.

### 7. Delete `sb_api_call.sh`; update `CLAUDE.md` and the bundle manifest

## Verification Plan

### Automated Tests

1. **Transport sweep (new gate).** No file under `.agents/` or `.claude/skills/` contains
   `sb_api_call`, `curl `, or `api-server-port.txt`. This is the assertion that makes the migration
   irreversible by accident — it is the gate whose absence let the two clients drift for a release.
2. **`mission-control-tick-and-reports-contract.test.js` stays green,** with its
   meaning-level assertions intact. Reviewed line by line rather than adjusted until green.
3. **Every migrated snippet names a real command.** Extract each `switchboard …` invocation from the
   markdown and assert its subcommand is in the CLI's `KNOWN_SUBCOMMANDS`. Catches a typo'd
   subcommand, which is otherwise invisible until an agent runs it at 3am.
4. **`move-card.js` and `create-feature.js` end-to-end** against a stub server, asserting the
   `Authorization` header is present — the defect this migration exists to fix.
5. **Bundle manifest consistency:** every path in `.agents/.switchboard-bundled.json` exists, and
   `sb_api_call.sh` is absent from both.

### Goal Invariants

- A workspace with `switchboard token set` configured can run every documented skill invocation
  successfully. Today none of them can.
- No agent-facing document instructs a reader to discover a port or health-check a server.

### Manual

- With a token set, exercise one skill per domain (ClickUp fetch, Linear move, worktree cleanup,
  diagram generate) and confirm each succeeds where it previously 401'd.
- Upgrade an existing workspace and confirm `sb_api_call.sh` is archived as `.migrated.bak`, not
  deleted, and that no sibling `_lib` file was lost.

**Complexity: 6 → Send to Coder.** Multi-file migration with one delicate contract-gate edit;
mechanical in most files, risky in the Mission Control trio. The contract-test assertion map above
removes the trial-and-error risk.
