# Every Node command dials the resolved target, not loopback

## Goal

Thread the resolved `ApiTarget` through every remote-capable Node command, so
that `apiRequest` builds its URL from the target instead of a `127.0.0.1`
literal and a port. This is the call-site half: the resolver already exists
(*A tagged `ApiTarget`*), and this subtask makes the ~38 sites that currently
take a port consume it — plus the three guards that stop a remote invocation
doing something local and wrong.

After this lands, `npx switchboard plans` against a remote target prints the
remote board's plans, a remote write carries the remote root, and
`switchboard --remote labcom plans` cannot start a board on the laptop.

## Why it does not work today

### 1. The request URL is loopback, literally

```ts
let url = `http://127.0.0.1:${port}${pathname}`;
```

`cli.ts:525`, inside `apiRequest`. There is no host parameter. The transport is `http.request`
(`:567`) with no `https` branch, so the `tailscale serve` route is unreachable even if the host were
configurable.

### 2. `workspaceRoot` is routed by method family, from the CLI's cwd

`apiRequest` routes `workspaceRoot` by method family — query param for GET/DELETE, body field for
POST/PUT/PATCH (`cli.ts:524-543`) — and the value comes from the CLI's cwd. A laptop path
(`/Users/p/work/labcom`) names nothing on the Pi. Getting this half-right — remote root on reads,
local cwd on writes — is a silent cross-board write, the worst outcome this feature can produce.

### 3. `--remote` before the verb falls through to a local board launch

Node's dispatch reads `process.argv[2]` for the subcommand (`cli.ts:3723`, and every
`process.argv[2] === '…'` branch). `switchboard --remote labcom plans` leaves `argv[2]` as
`--remote`, so the `plans` branch never fires, `!firstArg` is false, and control falls into the
server-start path (`:4743`) — `findRunningInstance`, then a *local board launch on the laptop*.
The single worst silent outcome this feature can produce, and it is the natural way to type the
command. (The Go client is already safe — `extractConnectionFlags` runs before verb dispatch,
`main.go:52`; `--remote` joins its `connectionFlags` map.)

## Scope

**Standalone only**, and within it `src/standalone/cli.ts` only. The CLI is a standalone-host
surface and the extension host does not have one. Per the cutover rule the extension is out of scope
and its absence here is the intended state, not a divergence. No `extension.ts` composition-root
seam is touched, and none should be added. `LocalApiServer` is not modified.

**Out of scope, deliberately:** the resolver itself (*A tagged `ApiTarget`* — this subtask imports
`resolveApiTarget` and does not reimplement or extend its precedence), the `remote` subcommand and
`remotes.json` (*Named remotes and the source line*), and the printed source line (same). Where this
subtask needs a target it calls the resolver; where a refusal message would name a remote, it names
whatever `target.source` says.

**The Go client needs no change in this subtask.** Its transport already builds `BaseURL + pathname`
and merges the server root into write payloads with no loopback literal anywhere
(`internal/client/transport.go:93`), and `extractConnectionFlags` already runs before verb dispatch.
This subtask is Node catching up to it — which is the parity direction, not a divergence.

## Metadata

**Complexity:** 5
**Tags:** cli, api, feature, infrastructure
**Feature:** 30f625e0-feb9-4e96-aadb-af04610e3643

## Complexity Audit

### Routine

- Adding an `https` branch to the Node request builder.
- Node whitelist bookkeeping for the local-only refusals.

### Complex / Risky

**Thread `ApiTarget` through the board commands only** — `plans`, `ready`, `dispatch`, `done`,
`accept`, `next`, `reports`, `clear`, `fleet`, `verb`, `api`, `status`, and the board-console branch
of the bare menu. Each site becomes `const target = await resolveApiTarget(…)` followed by
`apiGet(target, …)`.

**Count the sites in review; the seam is two-layer and larger than it looks.** There are ~13
`findRunningInstance(workspaceRoot)` resolution sites in the board commands (`cli.ts:1177, 1256,
1385, 1451, 1670, 1927, 2073, 2176, 2297, 2396, 2479, 3005, 3507, 4583`) and ~25
`apiGet`/`apiPost`/`apiRequest` request sites that all take the resolved `port`. Counting only
`apiRequest`'s own edges — its definition, `apiGet`, `apiPost` and the raw `api` verb — undercounts
by an order of magnitude.

**`controller` is refused under a remote target in v1.** `apiRequest` is injected into
`runController` (`cli.ts:1876`) as a `ControllerApiRequest` (`controller/capabilities.ts:35`) whose
signature is `(port: number, method, pathname, workspaceRoot, …)`, threaded through ~20 internal call
sites in `controller/controller.ts`. Changing that signature ripples across the controller module, so
its retargeting is a follow-up card.

**`probe` and `heap-snapshot` are refused under a remote target** because they read the *local*
`/proc` and write *local* paths — a remote `probe` would emit plausible zeros.

- **The write path merges `workspaceRoot` into the payload (`cli.ts:541-543`).** A remote target
  must merge the *remote* root. Taking it from `target` rather than a separate argument is what makes
  the half-right read/write split structurally impossible, so do not keep a parallel root parameter
  alive "for compatibility".
- **Timeouts.** 15 s default (`cli.ts:520`) is a loopback budget. A tailnet hop to a sleeping Pi
  wants a connect-phase wall-clock timeout distinct from the inactivity timeout —
  `isHttpsOriginReachable` documents exactly this failure: `req.setTimeout` arms on socket
  inactivity, so a DNS lookup that neither resolves nor NXDOMAINs leaves the promise pending forever
  (`tailnetOrigin.ts:86-90`). The error must name which phase expired.

## Edge-Case & Dependency Audit

1. **`discoverAuthToken` can leak the local board's credential to the remote.** Under a remote
   target it is called with the remote's root (`cli.ts:522`), and `fs.existsSync(<remoteRoot>/
   .switchboard/api-server-token.txt)` is evaluated on the *laptop's* disk. A laptop that happens to
   have a directory at the same absolute path (a shared mountpoint convention, a same-named
   checkout) sends its own board's token to the Pi. Gate token-file discovery on `!isRemote` — under
   a remote target the only credential sources are `SWITCHBOARD_API_TOKEN` and `--token-file`.
2. **A remote target plus a local-only subcommand**: refuse with a clear message. The refuse list is
   `stop`, `logs`, `service`, `init`, `scaffold`, `control-plane`, `setup`, `secrets`, `token`,
   `export`, `import` (the last two open `kanban.db` on the *local* disk via `openBoardDatabase`,
   `cli.ts:3986`), `launcher-state`, `probe`, `heap-snapshot`, `controller`, and the serve modes
   `local`/`tailnet`/`service` (a remote target on a serve command is meaningless). `status` is
   remote-capable — it is a pure HTTP read. `stop` over a tailnet is a separate decision, not an
   accident.
3. **`emitOfflineGuidance` gives wrong advice for a remote failure.** It prints "Run `switchboard
   local`" (`cli.ts:370-376`) — nonsense when the intended board is on the Pi. Remote resolution
   failure emits its own error naming the target and URL; the local guidance stays local-only.
4. **The bare menu's serve branches.** A remote target with no verb reaches the front-door menu
   (`cli.ts:4739`); its `local`/`tailnet`/`setup` branches spawn a board *on the laptop*. Under a
   remote target only the board-console branch is meaningful — the serve branches refuse with a
   message naming the target.
5. **Flag conflicts.** `--remote` + `--workspace`, `--remote` + `--port` (`probe`'s `explicitPort`,
   `cli.ts:1511`), `--remote` + serve-mode flags: refuse loudly. `--workspace` names a local path;
   under a remote the remote names its own root.
6. **`apiRequest`'s `req.setTimeout` is inactivity-based** (`cli.ts:580`). For remote, add a
   connect-phase wall-clock timer (the `tailnetOrigin.ts:86-90` pattern) so a hung DNS/connect
   fails naming the phase.
7. **Local behaviour is untouched.** With no remote named, every command behaves exactly as today,
   with no extra output and no new failure mode.

## Dependencies

- *A tagged `ApiTarget` — one board resolution chain, both clients* — **must land first.** This
  subtask imports `resolveApiTarget` and the `ApiTarget` shape; it does not define them.
- *Named remotes and the source line, in both clients* — lands after this, and adds the `remote`
  subcommand plus the printed line on top of the converted call sites.
- `go-cli-client-verbs.md` — **shipped**; the Go transport this subtask brings Node to parity with.

## Adversarial Synthesis

Risk Summary: the original framing understated this work by an order of magnitude (four call sites is
really ~38), and the two failure modes it can produce are both silent. (1) A write carrying the local
cwd to a remote board — mitigated by taking the root from `target` so the read/write split is
structurally impossible, and by a behavioural test asserting what a mock host actually received.
(2) The flag-before-verb position falling through to a *local board launch* — mitigated by splicing
the flag out of `process.argv` before Node's `firstArg` dispatch, covered by an explicit test.

## Proposed Changes

### `apiRequest` takes a target, not a port

```ts
function apiRequest(target: ApiTarget, method: string, pathname: string, payload?, query?, timeoutMs?)
```

`workspaceRoot` comes from `target`, not from a separate argument, which structurally prevents the
half-right read/write split named in the Complexity Audit. Pick `http` or `https` from `baseUrl`.
Keep the `X-Switchboard-Client` marker unconditionally. `discoverAuthToken` is gated on
`!target.isRemote` (Edge Case 1); under a remote target the token resolves from
`SWITCHBOARD_API_TOKEN` then `--token-file` only.

The real call-site count is in the Complexity Audit above: ~13 `findRunningInstance` sites and ~25
`api*` sites across the remote-capable command set — `plans`, `ready`, `dispatch`, `done`, `accept`,
`next`, `reports`, `clear`, `fleet`, `verb`, `api`, `status`, and the board console. Each takes the
same three-line shape: `const target = await resolveApiTarget(…)` (which emits remote-specific
failure or today's `emitOfflineGuidance` for the local case), then `apiGet(target, …)`.
`controller`, `probe`, `heap-snapshot`, and every local-only subcommand get the refusal instead.

**Flag handling:** extract `--remote`/`--workspace-root`/`--token-file` from `process.argv` and
splice them out *before* the `firstArg`/`KNOWN_SUBCOMMANDS` dispatch (Edge Case in §3 of Why it does
not work today), so position is free and `switchboard --remote labcom plans` can never reach the
serve path.

## Verification Plan

### Goal Invariants

1. `switchboard --remote labcom plans` on a laptop prints the Pi's board, not the laptop's, through
   `node dist/standalone/cli.js` / `npx switchboard`.
2. With no remote named, every command behaves exactly as today, with no extra output.
3. A write against a remote target carries the remote root in its payload. There is no path where a
   read uses the remote root and a write uses the local cwd.
4. **`switchboard --remote labcom plans` (flag before verb) never reaches the serve path** — it
   resolves the remote or fails naming it, and a local board is never launched. Negative/positive
   pair: the flag is absent from `process.argv` when verb dispatch runs, and the resolved target is
   present in the request that fires.
5. A remote target on a local-only subcommand refuses with a message naming the cause and the
   recovery step, never a bare failure.

### Automated Tests

Extend the contract suite `src/test/cli-api-target-contract.test.js`:

- `apiRequest` contains no literal `127.0.0.1` in its URL construction; the base comes from the
  target.
- Write payload merges `target.workspaceRoot`, asserted against a mock host that records what it
  received. This is invariant 3 and it needs a behavioural test, not a source-shape one.
- Under a remote target, `discoverAuthToken` never reads a token file from the remote root's path —
  asserted by planting a decoy token file at the same-named local directory and confirming no
  `Authorization` header leaves the process (Edge Case 1).
- `switchboard --remote labcom plans` with the flag first: assert the argv splice ran before
  `firstArg` dispatch (invariant 4) — a source-shape assertion that the flag is extracted ahead of
  the `KNOWN_SUBCOMMANDS` block, plus a behavioural run against a mock remote.
- Each local-only subcommand under a remote target refuses, and the message contains a recovery
  step. Assert on the message, not just the exit code.
- A connect-phase hang fails naming the phase, distinctly from an inactivity timeout.

`npm run compile-tests` before running, per the build rule.

### Manual Verification

1. From a second machine on the tailnet, with `SWITCHBOARD_SERVER_URL` set: `switchboard plans`,
   `ready`, `fleet` — all show the Pi's board, through `npx switchboard`.
2. A verb POST against the remote; confirm on the Pi's own board that it landed on the named root.
3. Stop Tailscale on the laptop; every remote command fails naming the target, and the local board
   is never read.
4. `switchboard --remote labcom plans` with the flag first — reaches the remote, and no board
   process starts on the laptop.
5. With no remote named, `switchboard plans` behaves exactly as before, byte-for-byte.

## Recommendation

**Send to Coder.** Complexity 5: wide but mechanical — one signature change propagated across ~38
sites, plus three guards (argv splice, local-only refusals, token gating) that each need a
behavioural test because each failure is silent.

## Completion summary (Coding-coder-1)

`apiRequest`/`apiGet`/`apiPost` now take the resolved `ApiTarget`: URL construction is `target.baseUrl + pathname` (https-aware, no loopback literal), reads carry `target.workspaceRoot` as a query param, writes inject it into the body and the target root wins over any payload-supplied `workspaceRoot`. Every remote-capable command (plans, ready, dispatch, done, accept, next, reports, clear, fleet, verb, api, status, about, board console + console helpers + `resolvePrefix`/`doDispatch`) resolves once through `resolveBoardTarget`/`tryResolveBoardTarget`; local-only paths (stop, token, launcher-state, heap-snapshot, controller) wrap the discovered port via `localTarget`. Connection flags (`--remote`, `--server`/`--endpoint`, `--workspace-root`, `--token-file`) are spliced from argv before the heap re-exec and verb detection, so `switchboard --remote labcom plans` resolves the remote and never enters the serve path; the re-exec spawn passes the raw argv so the child re-splices. Two refusal gates fire under a remote target: local-only verbs refuse naming the verb, the cause, and the recovery, and anything that still reaches the serve path refuses outright — a remote target can never launch a local board. Remote requests distinguish a connect-phase wall-clock timeout (message names the phase and baseUrl) from the existing inactivity timeout, and the workspace token file is never read for a remote target so the local board's credential is not leaked. Also fixed: `heap-snapshot` was missing from KNOWN_SUBCOMMANDS and could never reach its dispatch. Contract tests were extended (source pins plus a live-socket behavioral pin that a write carries the target root and a remote target ignores the client cwd token file); per dispatch directives, compilation and test runs were skipped.

## Review Findings

Audited the full path — `extractConnectionFlags` splice at `main()`'s first statement (before the heap re-exec gate and `firstArg`), the `remoteTargetRequested()` local-only/serve-flag refusals, the bare-remote board-console branch, the serve-path refusal, `apiRequest`'s `target.baseUrl + pathname` construction with the target root injected LAST into write payloads, and the `!isRemote` gate on the workspace token file. Every surviving `findRunningInstance` call site is a verb in `LOCAL_ONLY_REMOTE_VERBS` (`probe`, `heap-snapshot`, `controller`, `stop`, `token`, `launcher-state`) or a serve/detach path behind the remote refusal, so no remote-capable command re-derives a port. The connect-phase wall-clock timer is armed only for `target.isRemote` and its message names the phase and the base URL, as specified; the resolver's own health dial lacked the equivalent guard and was fixed under the sibling `ApiTarget` card. No code changes were needed in this subtask. Verification: `test:contract:api-target` ALL PASSED (including the live-socket pins that a write carries the target root and a remote target ignores the client-cwd token file), typecheck clean.

## Deferred Findings

- NIT `src/standalone/cli.ts:810` — `remoteTargetRequested()` reads `remotes.json` from disk on every invocation and is called up to three times per run; a corrupt file therefore throws out of `main()` for *every* command, including purely local ones such as `switchboard local`. It surfaces as corrupt rather than as unconfigured (which is the rule), and the message now names the repair, but the blast radius is wider than the remote paths.
- NIT `src/standalone/cli.ts:797` — `extractConnectionFlags` accepts `--remote=<v>` and `--remote <v>` but does not reject a value that looks like the next flag (`--remote --json` consumes `--json` as the remote name); it fails loudly at resolution, so it is a message-quality issue, not a silent one.
