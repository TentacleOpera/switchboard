# Named remotes and the source line, in both clients

## Goal

Give the operator named boards instead of URLs to retype — `switchboard remote
add|list|remove|default`, backed by `~/.switchboard/remotes.json` at `0600` —
and make every remote command say which board it resolved and where that came
from. Both clients gain both, identically: a remote added through the packaged
binary resolves through `npx switchboard`, and the two print the same line.

This is the operator-ergonomics layer. It sits on top of a resolver that already
reads its tiers (*A tagged `ApiTarget`*) and call sites that already take a
target (*Every Node command dials the resolved target*).

## Why this is the last piece

Without it the feature works but is unusable at the fingertips: every command
carries a full URL and an explicit `--workspace-root`, and nothing on screen
says which board answered. The second half matters more than the ergonomics —
this is the tagging half of the project's fallback rule. A source that is
resolved but never shown leaves "which board answered?" unanswerable in exactly
the situation the rule exists for: a sticky configured default silently
retargeting every command.

## Scope

**Standalone only**, both clients: `src/standalone/cli.ts` (the `remote`
subcommand and the three whitelists), a new remotes-config module backed by
`stateFile('remotes.json')`, and `cmd/switchboard` + `internal/client` on the Go
side. The CLI is a standalone-host surface and the extension host does not have
one. Per the cutover rule the extension is out of scope and its absence here is
the intended state, not a divergence. `LocalApiServer` is not modified.

**Out of scope:** the resolver's precedence tiers (*A tagged `ApiTarget`* defines
them; this subtask writes the config they read) and the call-site conversion
(*Every Node command dials the resolved target*). This subtask does not change
how a target is chosen — only how one is named, stored, and shown.

**Client parity is this subtask's divergence rule.** `remote add` output, refusal
messages, and the source line land identically in both clients or land nowhere.
A behaviour that differs by which binary the operator happened to install is a
divergence.

## Metadata

**Complexity:** 5
**Tags:** cli, api, feature, infrastructure
**Feature:** 30f625e0-feb9-4e96-aadb-af04610e3643

## User Review Required

- **A stored default is a sticky remote.** `remote default <name>` makes every
  bare command target that board. This is safe only because the source line is
  printed on every remote command — the stickiness is visible, not silent. The
  two ship together; a default tier without the printed line is the quiet-wrong-
  answer shape this feature exists to remove.
- **Config is new, unreleased state.** No migration is owed.

## Complexity Audit

### Routine

- `switchboard remote add|list|remove|default` as a new subcommand family, backed by
  `stateFile('remotes.json')` (`src/utils/stateHome.ts:34` — `~/.switchboard/remotes.json`, already
  the per-operator store and already `SWITCHBOARD_STATE_HOME`-sandboxed for tests).
- Node whitelist bookkeeping: `remote` joins `KNOWN_SUBCOMMANDS` (`cli.ts:3713`),
  `HEAP_REEXEC_EXEMPT_SUBCOMMANDS` (`:3664`), and the `subcommandTargetsCwd` exclusion list
  (`:3810-3820`) so `switchboard remote add` from a non-workspace directory does not mint a stray
  `.switchboard/` in the laptop's cwd.

### Complex / Risky

- **Two clients, one file.** Both read and write the same `remotes.json` at the same path with the
  same schema. The Go client honours `SWITCHBOARD_STATE_HOME` in `stateHome()`'s order — env first —
  so a remote added through one binary resolves through the other. A schema that drifts between
  clients is a divergence that no gate catches: both keep working, against different stored state.
- **`add` must not store a target it cannot use.** Probing `/health` proves reachability but not
  usability; a board with a durable token configured answers `/health` and then `401`s the first
  real read. Storing that target hands the operator a remote that fails on every subsequent command
  with no explanation.
- **The source line must not fire locally.** A local invocation must acquire no new output. The line
  is a remote-only affordance.

## Edge-Case & Dependency Audit

1. **Config file is new, unreleased state.** No migration is owed. It lives at
   `~/.switchboard/remotes.json` via `stateFile()` — per-operator, not per-board, and never inside a
   workspace's `.switchboard/`. Written `0600` (write-then-`chmodSync`, the `ptyBackend.ts:16`
   pattern — `writeFileSync`'s mode is umask-masked). The Go client reads the same path
   (`os.UserHomeDir()` + `SWITCHBOARD_STATE_HOME` honouring `stateHome()`'s order — env first) so a
   remote added through one binary resolves through the other.
2. **`add` against a token-configured board.** If the post-`/health` read returns `401`, refuse and
   name the cause and the remedy (`SWITCHBOARD_API_TOKEN` / `--token-file`, or `switchboard token
   clear` run on the remote) rather than storing a target that cannot be used.
3. **`remove` of the current default** clears the default too, and says so. A dangling
   `defaultRemote` pointing at a removed name would make every bare command fail with a confusing
   error about a remote the operator already deleted.
4. **`add` of an existing name** — refuse and name the existing target, or require an explicit
   overwrite. Silently rebinding a name retargets every command that uses it.
5. **`remote list` with no remotes** prints an empty-state line naming the add command, not a bare
   blank.
6. **`remote list`/`remove`/`default` need no endpoint resolution** — they touch only local config.
   Only `add` dials, and it resolves its own URL.
7. **Corrupt config.** A `remotes.json` that does not parse is surfaced as corrupt, never read as
   unconfigured — `catch { return {} }` on a config load is the exact shape CLAUDE.md names as a
   reported-bug source.

## Dependencies

- *A tagged `ApiTarget` — one board resolution chain, both clients* — **must land first.** It
  defines the `--remote`/`SWITCHBOARD_REMOTE`/`defaultRemote` tiers; this subtask writes the config
  they read and treats their absence as an absent tier.
- *Every Node command dials the resolved target, not loopback* — **must land first.** The source
  line is emitted per remote command, which requires the commands to be target-driven.
- `go-cli-client-verbs.md` — **shipped**; `Transport.Diag` (`transport.go:76`) is declared but never
  assigned, and this subtask is what assigns it.

## Adversarial Synthesis

Key risk: a sticky configured default silently retargeting every command. An operator who ran
`remote default labcom` weeks ago and then types `switchboard done` in a local checkout is acting on
the Pi's board without being told. This is the precise failure the project's fallback rule names,
and the mitigation is not to drop the default tier but to make it loud — the source line on every
remote command, which is why the two land together and neither ships alone.

Secondary risk: the two clients drifting on the stored schema. Both keep working, against different
state, and no gate catches it. Mitigated by a test that writes with one client's code path and reads
with the other's, asserting the same path and the same parsed result.

## Proposed Changes

### Change A — `switchboard remote add|list|remove|default` (both clients)

`add <name> <url> [--workspace-root <path>]` probes `/health` first and refuses to store a target it
cannot reach. It records the name, base URL, the roots the remote reported, and the chosen root.
`list` prints each remote with its URL, root, and last successful contact. `default <name>` (and
`default --clear`) sets the configured-default tier of the precedence chain — a stored default *is*
the sticky remote, and the printed source line (Change B) makes a sticky target visible on every
command, which answers the cross-board-write worry that argued for explicit-only. Config lives at
`~/.switchboard/remotes.json`, `0600`.

`add` probes `/health` and then makes one real read, so the target is stored only if it actually
answers. If that read returns `401`, the remote has a durable token configured; `add` refuses and
names the cause and the remedy (`SWITCHBOARD_API_TOKEN` / `--token-file`, or `switchboard token
clear` run on the remote) rather than storing a target that cannot be used.

In the Go client `remote` is handled before the owned-verb dispatch (`remote list`/`remove`/
`default` touch only local config and need no endpoint resolution; `add` resolves its own URL); in
Node it joins the three whitelists named in the audit. Output text is identical between clients.

### Change B — surface the target (both clients)

Every remote command prints one line before its output:

```
[switchboard] labcom · https://labcom.taile9aab9.ts.net · /home/patrick/labcom · via config:remotes.labcom
```

Suppressed under `--json` (where the same facts go into the payload — each `emitJson`/`emitJSON`
envelope for a remote invocation carries `target: { baseUrl, workspaceRoot, source }`) and absent
for local invocations. The Go client's `Transport.Diag` hook (`transport.go:76`) is declared but
never assigned — wire it or emit the line in `runOwnedVerb`; either way it exists after this change.
This is the tagging half of the fallback rule: the source is not merely returned, it is shown where
it is used.

## Verification Plan

### Goal Invariants

1. A remote added through one client resolves through the other — same path, same schema.
2. Every remote command prints the source line; no local command does.
3. `switchboard remote default labcom` then a bare command targets the Pi, and the printed line says
   `via config:remotes.labcom` — the stickiness is visible, not silent.
4. **No refusal in this subtask can lock the operator out silently.** Every auth-shaped or
   target-shaped refusal names the cause *and* the recovery step — a remote whose board has a
   durable token configured must say so and name `switchboard token clear` (run on the remote) or
   `SWITCHBOARD_API_TOKEN`/`--token-file`, not return a bare `401`. This invariant exists because
   credential lockouts are this product's documented failure history: the skill layer 401'ing
   wholesale, agents 401'ing under `switchboard tailnet` against help text promising no token, and
   the 2026-09-13 CSRF lockout where the operator could not reach their own board from any machine.
   A remote CLI is a fourth place for that to happen, and it must not be.
5. **Client parity:** for every stored-config and refusal case above, the Go client and the Node
   client produce the same outcome and the same message shape. Divergence is a failure, not a
   porting detail.

### Automated Tests

New contract suite `src/test/cli-remote-config-contract.test.js`, plus Go-side coverage:

- `remotes.json` is written `0600` and read identically by both clients (same path, same schema) —
  write through one code path, read through the other.
- `remote` is present in `KNOWN_SUBCOMMANDS`, `HEAP_REEXEC_EXEMPT_SUBCOMMANDS`, and the
  `subcommandTargetsCwd` exclusion list — the three whitelists a new client subcommand must join.
- `remote add` against a board that `401`s the post-health read refuses and does not store; the
  message contains the remedy (invariant 4).
- `remote add` of an existing name refuses naming the existing target.
- `remote remove` of the current default clears the default and says so.
- A corrupt `remotes.json` surfaces as corrupt, never as unconfigured.
- The source line is emitted for a remote invocation and absent for a local one; under `--json` it is
  absent from stdout and present in the payload as `target`.
- Every refusal path produces a message containing a recovery step. Assert on the message, not just
  the exit code — invariant 4 is about what the operator is told.

`npm run compile-tests` before running, per the build rule.

### Manual Verification

1. From a second machine on the tailnet: `switchboard remote add labcom http://labcom:7777` —
   succeeds and lists the Pi's roots. Repeat through `npx switchboard` — same output.
2. `switchboard --remote labcom plans`, `ready`, `fleet` — all show the Pi's board, flag before and
   after the verb, binary and npx.
3. `switchboard remote default labcom` then bare `switchboard plans` — hits the Pi, and the source
   line says `via config:remotes.labcom` so the stickiness is visible, not silent.
4. Repeat 2 against the `tailscale serve` HTTPS URL with a token (`SWITCHBOARD_API_TOKEN` /
   `--token-file`); then without one, and confirm the error explains the proxy/token posture rather
   than printing a bare 401.
5. A remote added through the binary is listed by npx, and vice versa.

## Recommendation

**Send to Coder.** Complexity 5: a small subcommand family, but it lands in two clients against one
shared file, and its refusal messages are the operator's only defence against a lockout.

## Implementation summary

Both clients gained the `remote add|list|remove|default` subcommand family against the shared `~/.switchboard/remotes.json` (0600 writes, corrupt-file refusal): Node in `src/standalone/cli.ts` (`cmdRemote*`, with `saveRemotesConfig` exported from `apiTarget.ts`), Go in `internal/client/remotes.go` (`RunRemote`, dispatched in `main.go` before the owned-verb endpoint gate). `remote add` validates the name, probes `/health`, then performs one real `/kanban/plans` read — a 401 there refuses with the full credential recovery line and stores nothing. Every remote command now emits `[switchboard] <name> · <url> · <root> · via <source>` once per invocation on stderr (Node via `recordActiveTarget`/`reportTargetSource` in `tryResolveBoardTarget`, Go via `DescribeTargetVia`/`TargetSourceLine` + wired `Transport.Diag`), and `--json` suppresses the line while appending `target` as the final envelope key — local invocations produce neither. `remote` joined all three Node whitelists (`KNOWN_SUBCOMMANDS`, heap re-exec exempt, cwd-subcommand exclusion) so config commands work outside a workspace without touching `.switchboard/`. Contract suite `src/test/cli-remote-config-contract.test.js` (npm script `test:contract:remote-config`) pins cross-client schema, whitelist membership, source-line/JSON-target behaviour, and shared refusal fragments; `internal/client/remotes_test.go` covers the Go store semantics — both written, not run per directive. Typecheck (`tsc -p tsconfig.test.json --noEmit`) clean; no commit made.

## Review Findings

Reviewed `cmdRemote*` in `src/standalone/cli.ts`, `saveRemotesConfig`/`loadRemotesConfig` in `src/standalone/apiTarget.ts`, `internal/client/remotes.go`, and the source-line wiring (`recordActiveTarget`/`emitJson` on the Node side, `DescribeTargetVia`/`TargetSourceLine`/`Transport.Diag`/`withTargetJSON` on the Go side); the 0600 write-then-chmod, the corrupt-file refusal, the `add` probe-then-real-read ordering, the 401 remedy text, the default-clearing `remove`, and the three Node whitelists all land as specified in both clients. Three MAJORs were fixed: the suite `src/test/cli-remote-config-contract.test.js` was RED on two of its own defects — the "never resolves a board target" assertion matched the word `resolveBoardTarget` inside the comment that explains it is not used, and the via-tag parity assertion searched only `cli.ts` for `flag:--remote `, a tag minted in `apiTarget.ts` — and the suite plus its `api-target` sibling were defined in `package.json` but invoked by nothing, the exact green-while-incomplete hole. Also fixed in both clients: the corrupt-`remotes.json` message now names the repair, because `switchboard remote default --clear` is itself blocked by a corrupt file and the operator was told only that the file was corrupt. Verification: `test:contract:remote-config` ALL PASSED (22 checks), `test:contract:api-target` ALL PASSED, both now wired into `.github/workflows/integration-tests.yml`; `go build`, `go vet`, `go test -count=1 ./internal/...` all ok; typecheck clean.

## Deferred Findings

- NIT `src/standalone/apiTarget.ts:241` — `saveRemotesConfig` is an unlocked read-modify-write of the whole config; two concurrent `switchboard remote add` invocations (or one Node and one Go) can silently lose one entry. Per-operator, human-paced, so low probability.
- NIT `src/standalone/cli.ts:2560` — `remote add` stores `roots` from the board's `/health` at add time and never refreshes it; `remote list` prints a `lastContact` that only `add` ever writes, so a remote used daily still reports its original contact time.
- NIT `src/standalone/cli.ts:396` — the source line is suppressed by `process.argv.includes('--json')` read globally rather than by the per-command `jsonFlag`; equivalent today because the flag is never a positional value, but the two spellings can drift.
