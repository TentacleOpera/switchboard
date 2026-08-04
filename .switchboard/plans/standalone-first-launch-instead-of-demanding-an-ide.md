# Make standalone the first-class entry point: `/switchboard` launches or attaches instead of demanding an IDE

## Goal

Invert the `/switchboard` entry protocol so its **first** action is to bring a Switchboard server up —
launching the standalone host when nothing is running, attaching to whatever is already running when
something is — instead of probing `.switchboard/api-server-port.txt` and, on a miss, telling the user to
go open the workspace in VS Code. An agent in Antigravity (or any host without the extension live)
should get a working board, not an instruction to change editors.

Delivering that needs four things the codebase does not have today: a **resolvable launcher** (there
is currently no runnable standalone binary reachable from a generic workspace), **attach semantics** in
the CLI (it presently hard-exits when a server is already up), a **way to stop a launched server** (the
teardown exists but only reachable via a signal to a process you have a terminal for — and this plan
detaches it), and the **skill protocol inversion** itself. The first three are prerequisites, not polish
— the skill change alone would emit a command that fails, and detaching without a stop path leaves a
server nothing can shut down.

### The observed failure

A user with the Antigravity app open types `/switchboard`. The agent runs the §1 entry protocol, finds
no port file, and per `.claude/skills/switchboard/SKILL.md:47` reports:

> If the port file is missing, tell the user to open the workspace in VS Code with the Switchboard
> extension active. Do not fall back to direct DB access.

So the console's front door is conditional on a *different application* being open. Standalone exists
precisely to remove that dependency, and the agent-facing protocol never reaches for it.

### Root cause 1 — the CLI refuses to attach, and a stale comment says it does

`src/standalone/cli.ts:206-211`:

```ts
const existing = await findRunningInstance(workspaceRoot);
if (existing !== null) {
    console.error(`[switchboard] Another Switchboard instance is already running on port ${existing} for ${workspaceRoot}.`);
    console.error(`[switchboard] Reusing is not supported (single writer). Use that instance or shut it down.`);
    process.exit(1);
}
```

`findRunningInstance` (`:110-118`) already does the right discovery — reads the port file, probes
`/health`, confirms `status === 'ok' && json.port === port`. It correctly identifies a live server. Then
the caller throws that away and exits 1.

Meanwhile `src/services/TaskViewerProvider.ts:2183-2190` documents the opposite behaviour as though it
shipped:

```
// serve the shell + panel HTML from the extension's LocalApiServer so that
// `npx switchboard` (which detects the running extension via
// api-server-port.txt and opens a browser to this port) gets the
// full shell + panel HTML + verb dispatch in one server.
```

Attach-and-open-a-browser was the design intent, the extension-side half of it was built (the extension
serves the full shell), and the CLI-side half is an `exit 1`. The single-writer rule is real and must be
preserved — but "do not start a second writer" and "refuse to help the user" are different
requirements, and the code conflates them. Attaching starts no writer at all.

### Root cause 2 — there is no launcher to invoke *yet*, and B4 is what supplies one

The obvious command does not exist **today**. Verified on this machine:

- `which switchboard` → not found; `npm ls -g` → not installed.
- `npx switchboard` fetches the **wrong package**: per `b4-npx-distribution-publish.md`'s verified
  finding, `npm view switchboard` returns an unrelated composite-event-listener library
  (brynbellomy/jonschlinkert, `1.3.0`, last published ~2024), so publishing under that name 403s and a
  fresh machine running `npx switchboard` gets that library. `package.json` declares
  `bin: { switchboard: './dist/standalone/cli.js' }`, but nothing publishes it.

**This is not a permanent constraint — it is `b4-npx-distribution-publish.md`'s job**, and that plan is
already in `PLAN REVIEWED` with the packaging verified npx-ready (`webpack.config.js:146` already builds
the standalone target; `sql.js` is pure WASM so no `node-gyp`; `files:` already ships the served assets).
Once B4 publishes under a claimable name, `npx <name>` becomes the launcher and this plan's resolution
logic collapses to "prefer the published CLI." **Sequence B4 first** — see Dependencies.

Until then, the only real artifact is the bundle inside an installed extension — and **the target host
cannot host one at all.**

**Antigravity has no extension host.** Antigravity 2 is Google's agent platform and extends via
**skills**, not VS Code-style extensions — there is no marketplace install path for Switchboard there.
The `~/.antigravity/extensions/turnzero.switchboard-1.5.9` directory present on this machine is **dead
residue from the older VS Code-fork generation of Antigravity** (every folder under
`~/.antigravity/extensions/` is dated Mar–May 2026, nothing since 23 May) and must not be read as a
capability. Do **not** design around "the Antigravity install is old"; design around "Antigravity has no
extension, therefore no `LocalApiServer`, therefore no port file unless some *other* process wrote one."

This is the whole reason the plan exists, and it makes launch the **normal** path in Antigravity rather
than an edge case: a `/switchboard` there can only ever attach to a server another process started, or
start standalone itself. It also means the `/switchboard` **skill** is the only integration surface
Antigravity offers — which is precisely why the protocol inversion in change 5, not an extension-side
fix, is the deliverable.

Bundles measured across this machine's IDE install roots (all of these are *sources to copy a launcher
from*, reachable by reading the filesystem — none require an extension host in the IDE the agent is
running in):

| Install root | Version | `dist/standalone/cli.js` |
|---|---|---|
| `~/.devin/extensions/turnzero.switchboard-1.7.13` | 1.7.13 | **present** (6.7 MB) |
| `~/.windsurf/extensions/turnzero.switchboard-1.7.3` | 1.7.3 | unchecked |
| `~/.vscode`, `~/.cursor` | — | not installed |
| `~/.antigravity/…-1.5.9` | — | **not an install** — stale pre-fork residue, ignore |

So even after B4, the pre-upgrade population needs a fallback, and a plan that assumes "launch the
bundled binary from the host you're in" is broken for the host that prompted the request — not because
its bundle is missing, but because it has no extension at all. The launcher resolves a published CLI
first and falls back to scanning install roots on disk, picking a version deliberately and failing with
something actionable when nothing qualifies.

Note also that the **launcher core already shipped** — `extract-standalone-npx-04-npx-distribution.md`
(`CODE REVIEWED`, in the *Standalone Headless Switchboard (npx)* feature) delivered the `bin` entry,
boot, `/health` gate, one-time-token handoff and browser-open. What it did **not** deliver is
attach-to-a-running-instance: its only "reuse" semantics are token single-use enforcement. So root cause
1 is genuinely unbuilt rather than regressed, and this plan extends that shipped launcher rather than
duplicating it.

### Root cause 3 — the protocol treats the port file as a fact about the world

The entry protocol reads `api-server-port.txt` as "is Switchboard available", when it actually means
"did some host previously write a port here". Two consequences:

- **A miss is treated as terminal** rather than as "nothing is up yet — start it."
- **A hit is trusted structurally.** `findRunningInstance` health-probes before believing it; the skill's
  §1 does not, it just `cat`s the file and calls `/health` on that port. A stale port file from a
  crashed host makes the agent report a port that answers nothing. (In practice `/health` failing is
  caught, but the protocol has no *recovery* step — and after this change, recovery is exactly
  "launch".)

Note the port file is host-agnostic: `cli.ts:111` and `bootstrap.ts:1462` write it for standalone, and
`TaskViewerProvider.ts:2397/2451/2483` write it for the extension (gated by the eligibility rule at
`:2567`). So the file identifies *a* server, never *which kind*. Attach logic must not assume either.

### Root cause 4 — the skill edit will not reach the running agent by itself

`src/extension.ts:363`, `:408` and `:4106` all copy skill templates with
`vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false })`. A workspace's skill copy is
therefore frozen at first install: editing `.claude/skills/switchboard/SKILL.md` in this repo does not
update an already-scaffolded workspace.

**The freeze is per-workspace, not per-IDE.** The scaffolded copy lives in the *workspace*
(`<root>/.claude/skills/…`), written by whichever extension host ran there first — so the relevant
question is "when was this workspace scaffolded", never "which IDE is the agent in". This matters
especially for Antigravity, which has no extension host and therefore never scaffolds or refreshes
anything: an agent there reads whatever copy some other host left behind, and has no mechanism of its own
to update it. So shipping the skill change without a propagation path leaves the target host permanently
on the old protocol.

Either way, any plan that "fixes the skill" and stops there fixes nothing the user will actually run. The
propagation path has to be part of the deliverable or explicitly deferred with a named manual step.

## Metadata
- **Tags:** standalone, cli, agent-protocol, dx, feature-standalone-cli
- **Complexity:** 7

> **Superseded:** **Complexity:** 6
> **Reason:** re-scored on adding change 3 (lifecycle). Shutdown is not a bolt-on: it introduces a pid
> file whose consistency with the port file must hold across every exit path, a SIGHUP gap that currently
> leaks PTY children, and a PID-recycling refusal case that a naive implementation gets dangerously wrong.
> **Replaced with:** **Complexity:** 7
- **Repo:** `switchboard`
- **Feature:** Standalone CLI Scaffolding

## User Review Required (decisions, with defaults)

1. **What does attach do — open a browser, or just report the port?** Default (**decided by the user,
   2026-08-04**): **open the browser, exactly as launch does.** The human contract is "type the command,
   leave the terminal running, get a board" — and it must not silently change depending on whether a
   server happened to already be up. So `--no-open` stays the single opt-out for **both** paths, and the
   agent's helper script (change 2) passes `--no-open` explicitly rather than the CLI defaulting to
   closed. Attach also opens no browser when it cannot mint a session (see change 1's token
   requirement) — it says why instead of opening a tab that 401s.

   > **Superseded:** Default was "report the port and URL on stdout, and open a browser only when
   > `--open` is passed", on the reasoning that the agent case is primary and an agent does not want a
   > tab.
   > **Reason:** that optimises the agent path at the cost of the human one, and makes `npx <name>`
   > behave differently for the same typed command depending on invisible state. The agent path can ask
   > for `--no-open`; the human should not have to ask for the board.

2. **Which launcher wins when several exist?** Default: **highest semver across all IDE install roots**,
   preferring an exact match to the workspace's own `dist/standalone/cli.js` when the workspace *is* the
   switchboard repo (so developers test what they just built). Alternative: prefer a bundle belonging to
   the host the agent is running in — rejected outright, not merely deprioritised: Antigravity has no
   extension host, so "the host I'm in" supplies nothing at all there. Resolution must never be scoped to
   the current IDE.

3. **Should the launcher be a new CLI subcommand, a script, or skill-embedded shell?** Default: **a
   committed helper script** (`.agents/scripts/switchboard-up.sh` or `.js`) that the skill calls, so the
   resolution logic is testable, versioned, and fixable without editing prose in N frozen skill copies.
   Rejected: embedding a multi-step resolution heuristic in SKILL.md, which cannot be tested and
   inherits the freeze problem in change 6.

4. **How much version skew is tolerable?** A 1.5.9 CLI opening a DB that a 1.7.13 extension has migrated
   is a real hazard — `KanbanDatabase` migrations are live and actively failing in one case (see the
   separate *V20 migration fails on every fresh DB* plan). Default: **launch the newest available and
   warn if it is older than any extension that has run against this workspace**; refuse only if the DB
   records a schema version the CLI does not know. Needs your call on whether refusing is too strict.

5. **Should `/switchboard` launch without asking?** Default: **yes, launch silently and report it** —
   this is the substance of the request. But it starts a background process the user did not explicitly
   ask for, which cuts against the skill's "no eager action on entry" rule (Hard Rule 3). Default
   resolves the tension by treating *bringing up the board* as reading state, not acting on it; nothing
   is dispatched, no card moves. Flagging because it is a genuine rule change, not an omission.

## Dependencies

**Hard: `npx Distribution (publish the standalone CLI to npm)`** (`b4-npx-distribution-publish.md`,
currently `PLAN REVIEWED`). **Land B4 first.** It resolves the naming blocker and makes a published CLI
fetchable, which is what turns change 2 from "scavenge bundles across IDE install directories" into
"invoke the published binary, with scavenging as a fallback for un-upgraded installs". Landing this plan
first means building resolution machinery that B4 largely obsoletes, and shipping an agent protocol whose
happy path is a fallback.

Also worth knowing, not blocking:

- **`extract-standalone-npx-04-npx-distribution.md`** (`CODE REVIEWED`) already shipped the launcher
  core — `bin` entry, boot, `/health` gate, token handoff, browser-open. Read it before implementing
  change 1; this plan extends that code path rather than creating a second one.
- **`Standalone init` Command** (`CREATED`) also grows the CLI's command surface. No file conflict
  expected — that plan adds a subcommand, this one changes default-command semantics in `main()` — but
  landing both means two edits to `cli.ts:143+`. Whichever lands second rebases.
- **`Standalone: GET /catalog 404s`** (in *Headless Host Correctness*) affects the *quality* of the
  attached session, not attaching. Independent.

## Proposed Changes

### 1. Attach instead of exiting — `src/standalone/cli.ts`

Replace the `exit 1` at `:206-211` with an attach path:

- Keep `findRunningInstance` (`:110-118`) unchanged — it already health-probes.
- On a hit: print the port, the board URL (built with the same `resolveHostname` used for launch), and
  which host answered. Determine host kind from `/health` rather than guessing: the response already
  carries `roots`, `terminals`, `terminalCount` and `selectedWorkspaceRoot`. If a discriminator is
  needed, add an explicit `host: 'extension' | 'standalone'` field to `/health` — cheap and removes all
  inference. Exit **0**. Open a browser only per decision 1.
- **Start no server on this path.** The single-writer invariant is preserved by construction, and the
  message should say attaching rather than the current "Reusing is not supported".
- On a miss: launch exactly as today (`:215+`).
- **Stale port file:** if the file exists but `/health` fails, treat it as a miss and launch. Do not
  delete the file first — `bootstrap.ts:1462` overwrites it on successful bind, so cleanup is implicit
  and unlinking it early would lose the diagnostic if the launch itself fails.

**Attach must be able to mint a browser session, and today it cannot. This is the hard part of change 1,
not the `exit 1` removal.** The two hosts differ:

- **Standalone** mints exactly **one** token, at boot: `bootstrap.ts:304` generates `oneTimeToken` and
  `:1437` rejects everything else forever — `if (oneTimeConsumed || t !== oneTimeToken) return false`.
  There is no minting endpoint. So once the original launch's browser consumed it, a *newly attaching*
  process has no way to authorise a browser at all. A tab opened against that server gets the 401 at
  `LocalApiServer.ts:569` — "Open the board URL from a fresh `npx switchboard` launch".
- **Extension** keeps a TTL'd map (`TaskViewerProvider.ts:2505-2518`) and *can* issue fresh tokens — that
  is what its open-in-browser button does — but exposes no way for a separate CLI process to ask for one.

So attach-and-open only works by accident today: it works if the *same* browser still holds a valid
`sb_session` cookie from the original launch, and fails in a different browser, a private window, or after
a cookie clear. Resolve it explicitly:

- Add a **token-mint path on the running server** that a local attaching process can call —
  `POST /session/token` returning a fresh single-use token. Standalone's `oneTimeConsumed` boolean must
  become a TTL'd set to support more than one, matching the extension's existing model
  (`TaskViewerProvider.ts:2505-2518`) rather than inventing a second one.
- **The mint endpoint cannot be gated on the existing credential, and this is the crux.** Standalone's
  `getAuthToken()` returns `sessionToken` (`bootstrap.ts:305`, `:1365`) — 32 random bytes generated
  per-process and held **only in memory**, never written to disk. So an attaching process has no
  credential to present: gating the mint on the session cookie is circular (the cookie is what we want),
  and gating it on the auth token is *equally* circular, because that token is the same unreachable
  in-memory secret. Either gate leaves attach unable to authenticate at all.
  **The trust boundary therefore has to move to the filesystem:** the running server writes its
  mint credential to `.switchboard/api-server-token.txt` with `0600`, and the attaching process reads it.
  This is the Jupyter-token / Docker-socket pattern — "a process running as this user, able to read this
  workspace" becomes the authorisation, which is coherent because such a process can already read
  `kanban.db`, every plan file, and the secrets store. Write it from the same place as the port and pid
  files and unlink it in `stop()`, so all three stay consistent. Do **not** put it in the DB or a
  world-readable location.
- **Note the hosts differ and the plan must not assume otherwise.** Standalone always has a real token, so
  `_checkAuth` genuinely enforces. The extension's `getAuthToken()` reads `switchboard.apiToken` from
  SecretStorage (`TaskViewerProvider.ts:1978-1981`), which is empty unless a user set it and has no
  setter UI — so `_checkAuth`'s `if (!expected) return true` (`LocalApiServer.ts:529`) makes the extension
  pure localhost-trust today. Attaching to an extension therefore needs no credential, and minting against
  one must not assume a token exists.
- The attaching CLI mints a token, builds the board URL with it, and opens that. If minting is
  unavailable (older server, no API token configured), **print the URL and say the browser may need a
  session** rather than opening a tab that 401s — a confusing failure is worse than an honest message.
- If this is judged too large, the honest fallback is: attach reports the port and does **not** claim it
  opened a board. What must not ship is an attach path that opens a tab which silently 401s.

Fix the stale comment at `TaskViewerProvider.ts:2183-2190` in the same change so it describes what the
code now does.

### 2. Launcher resolution — new committed helper

Add `.agents/scripts/switchboard-up.js` (Node, no dependencies, mirroring the existing
`.agents/scripts/` convention). **With B4 landed, step 2 is the happy path and steps 3–4 exist only for
un-upgraded installs** — do not over-invest in the fallback. It resolves the first workable entry point
in order:

1. `$ROOT/dist/standalone/cli.js` — only when `$ROOT` is the switchboard repo itself (checked via
   `package.json` `name`), so a developer's build wins locally.
2. **The published CLI** — `<published-name>` on `PATH`, else `npx --yes <published-name>`. B4 fixes the
   name, so take the final name from B4 rather than hardcoding `switchboard`; a hardcoded `switchboard`
   would fetch the unrelated third-party library. If B4 has not landed, this step is a no-op.
3. The newest `dist/standalone/cli.js` found by scanning extension install roots on disk —
   `~/.{vscode,vscode-insiders,cursor,windsurf,devin}/extensions/turnzero.switchboard-*/`. This is a
   filesystem scan for a *file to execute*; it does not require an extension host in the IDE the agent is
   running in, which is what makes it usable from Antigravity at all. Sort by parsed semver from the
   directory name, not lexically (`1.7.13` must beat `1.5.9`, which a string sort gets wrong). **Skip
   candidates whose `dist/standalone/cli.js` is absent** — older versions predate the standalone target,
   so enumerating roots is not enough on its own. Scanning `~/.antigravity/extensions/` is harmless but
   pointless: it holds only stale pre-fork residue.
4. Nothing found → exit non-zero with a message naming what was tried and the real remedies (install the
   published CLI, or build the repo), never "open VS Code" and never "install the extension in this IDE"
   — that instruction is impossible in Antigravity.

Then: run the resolved launcher with `--workspace $ROOT`, wait for health using the same
`waitForHealth` contract as `cli.ts:133-141`, and print a single machine-readable line the skill can
parse (`SWITCHBOARD_PORT=<port>` plus `SWITCHBOARD_MODE=attached|launched`). Emitting the mode is what
lets the skill report honestly which happened.

Detach the child (`spawn(..., { detached: true, stdio: 'ignore' }).unref()`, as `openBrowser` at
`cli.ts:119-131` already does) so the server outlives the agent's shell invocation — otherwise the
board dies with the tool call that started it, because an agent's tool-call shell exits the moment the
command returns. Log the child's stdout/stderr to `.switchboard/standalone-launch.log` so a failed boot
is diagnosable after detaching. **Detaching makes change 3 mandatory, not optional** — a server with no
controlling terminal and no shutdown affordance is unstoppable without `lsof`.

### 3. Lifecycle — a way to stop what was started, and a clean death — `src/standalone/cli.ts`

The teardown already exists and is thorough: `bootstrap.ts:1481-1491`'s `stop()` disposes the terminal
WS gateway, `ptyFleetService.disposeAll()`, the ingestion engine and every provider, stops the server,
and unlinks the port file. `cli.ts:240-248` wires it to SIGINT and SIGTERM. Nothing exposes it to a
*different* process, which is what detaching requires. Three gaps, all small:

- **No PID is recorded anywhere** (verified: no pid file is written in `src/`). Write
  `.switchboard/api-server-pid.txt` alongside the port file, from the same place
  (`bootstrap.ts:1461-1463`), and unlink it in `stop()` next to the port-file unlink so the pair is
  always consistent. Without this, "stop the server" degrades to `lsof -i :<port>`.
  Treat the three discovery files — `api-server-port.txt`, `api-server-pid.txt` and change 1's
  `api-server-token.txt` — as **one atomic set**: written together at bind, unlinked together in `stop()`.
  A surviving token file for a dead server is the worst of the three to leave behind.
- **No way in.** Add a `switchboard stop [--workspace <path>]` subcommand next to the existing `secrets`
  subcommands (`cli.ts:170-201`): read the pid + port files, health-probe to confirm it is really ours,
  send SIGTERM, wait for the port to stop answering, then report. Prefer this over a `POST /shutdown`
  endpoint (none exists today) — an HTTP kill switch on a loopback server is reachable by any local
  process and by any page the browser loads, and the session-cookie gate is not a defence worth relying
  on for "terminate the process". If a `/shutdown` endpoint is wanted anyway, gate it behind the API
  token, not the session cookie.
- **SIGHUP is not trapped** (verified: no `SIGHUP` handler anywhere in `src/`). So closing the launching
  terminal today kills the process via Node's default SIGHUP behaviour **without** running `stop()` —
  leaving a stale port file and potentially orphaned PTY children. Add `SIGHUP` to the existing
  `process.on` list at `cli.ts:247-248`. This is worth fixing regardless of this plan: it makes closing a
  window as clean as Ctrl-C.

Also expose it to the agent: the skill (change 5) should mention `switchboard stop` as the counterpart to
launching, so an agent that started a server can be asked to stop it. `SIGKILL` remains untrappable by
definition — the stale-port-file path in change 1 is what makes that survivable.

### 4. Version-skew guard — `.agents/scripts/switchboard-up.js` + `src/standalone/bootstrap.ts`

Per decision 4: after resolving a candidate, compare its version against the highest
`turnzero.switchboard-*` present on the machine and warn on stdout when launching an older CLI. Have
`bootstrap.ts` refuse to open a `kanban.db` whose recorded schema version exceeds the maximum migration
the running build knows, with an explicit message, rather than attempting a downgrade path that does not
exist.

### 5. Invert the skill's entry protocol — `.claude/skills/switchboard/SKILL.md`

Rewrite §1 step 1 so **Command A becomes "bring it up"**:

- Resolve `$ROOT` as today (walk for `.switchboard/`, or take it from the dispatch prompt).
- Run `node .agents/scripts/switchboard-up.js --workspace "$ROOT"`, read `SWITCHBOARD_PORT` and
  `SWITCHBOARD_MODE` from its output, and set `BASE` from that. This **replaces** reading
  `api-server-port.txt` — the script owns discovery, including the health probe.
- Delete the "tell the user to open the workspace in VS Code" instruction (`:47`). Replace it with the
  launcher's own failure output, which names concrete remedies.
- Keep Command B (the local `kanban-state-*.md` awk) exactly as-is — unchanged, and still the source of
  board counts.
- Report the mode in the entry snapshot: "Switchboard is live (port 60837)" when attached, "Started
  standalone Switchboard (port 61402)" when launched. The user must be able to see that a process was
  started on their behalf.
- Keep the cross-check that `$ROOT` appears in `health.roots`.

Note in the skill that `.switchboard/` must already exist for the workspace to be Switchboard-managed;
the launcher creating `.switchboard/` (as `cli.ts:158-161` does) must **not** be treated as adopting an
arbitrary directory — guard on an existing `.switchboard/` or `kanban.db` before launching, or
`/switchboard` in a random folder silently scaffolds one.

### 6. Propagation — make the skill edit actually reach users

Per root cause 4, `{ overwrite: false }` at `extension.ts:363`, `:408`, `:4106` freezes workspace skill
copies. Choose one and state it in the plan's outcome:

- **Preferred:** content-hash refresh — re-copy when the source differs from the destination and the
  destination has no local modifications, which is the general fix this repo already needs (see the
  separate skill-propagation work). Scope here: apply it to the `switchboard` skill and
  `.agents/scripts/`.
- **Minimum:** ship the change and document a one-line manual reconcile (`rsync` the skill + scripts
  into the workspace), acknowledging that existing workspaces stay stale until run.

Do **not** silently rely on `overwrite: false` — that is what makes "we fixed the skill" untrue.

### 7. Tests

- `findRunningInstance` returns the port on a healthy server, `null` on a stale port file, `null` on a
  malformed one (`:113-115` already guards `NaN` — assert it).
- Attach path: with a stub server answering `/health`, `main()` exits 0, prints the port, and starts no
  listener. Assert *no second bind*, which is the invariant.
- Launcher resolution: given a fixture tree of install roots, picks the highest semver **that has a
  `cli.js`**; skips a bundle-less older version in favour of a newer one; prefers the repo build when
  `$ROOT` is the switchboard repo; exits non-zero with the roots listed when nothing matches. Assert
  semver ordering, not string ordering.
- Signal parity: SIGINT, SIGTERM **and SIGHUP** each run `stop()` exactly once and leave neither the port
  file nor the pid file behind. Assert idempotence — a second signal arriving mid-teardown must not
  double-dispose the PTY fleet.
- `switchboard stop`: stops a live server for the named workspace; is a no-op with a clear message when
  nothing is running; **refuses** when the pid file's PID exists but does not answer `/health` as this
  workspace's server (PID recycling), rather than signalling a stranger.
- Skill guard: assert `SKILL.md` no longer contains "open the workspace in VS Code" and does contain the
  launcher invocation — the same style of guard the tooltip and column plans use, so the instruction
  cannot silently regress.

## Verification Plan

1. **Reproduce.** With no server running, in a workspace with `.switchboard/`, run the current §1 entry
   protocol: port file missing → the protocol's only outcome is "open VS Code". Confirm
   `which switchboard` is empty and `npx switchboard` does not resolve to this package.
2. **Launch from cold.** Nothing running: `node .agents/scripts/switchboard-up.js --workspace "$ROOT"`
   → resolves a launcher, boots, prints `SWITCHBOARD_MODE=launched` and a port, `/health` answers with
   `$ROOT` in `roots`. Confirm the server **survives** the invoking shell exiting.
2a. **The human contract, both ways.** Nothing running: type the launch command in a terminal, leave it
   open → a browser tab lands on the board, authenticated. Then, with that server still up, run the same
   command again in a second terminal → it attaches and **also** lands a working board tab (decision 1).
   Repeat the attach case in a **private window / different browser** to prove the minted session works
   rather than relying on the first tab's cookie — this is the case that fails today.
3. **Attach to a live extension.** With VS Code/Devin running the extension, run the same command →
   `SWITCHBOARD_MODE=attached`, the port equals the extension's, and **no second process** appears
   (`lsof -i` shows one listener; the DB has one writer). This is the single-writer regression test.
4. **Attach to a live standalone.** Launch standalone, run the script again → attaches to itself, does
   not double-bind, exits 0.
5. **Resolution from a host with no extension.** Run the script from Antigravity — which has no extension
   host, so nothing local supplies a launcher — and confirm it still finds the published CLI, or failing
   that the 1.7.13 Devin bundle by filesystem scan. Then make no bundle resolvable and confirm the failure
   message names what was tried and says neither "open VS Code" nor "install the extension in this IDE".
   Assert the scan ignores `~/.antigravity/extensions/` residue rather than treating 1.5.9 as a candidate.
6. **Stale port file.** Write a bogus port into `api-server-port.txt`, kill nothing, run the script →
   treats it as a miss and launches; the file ends up holding the new port.
7. **Version skew.** Force-resolve the older CLI against a DB migrated by a newer build → warning
   emitted; if the DB's schema version exceeds the CLI's known maximum, it refuses with a clear message
   instead of attempting a migration.
8. **`/switchboard` end-to-end in Antigravity — the acceptance test.** Close every IDE running the
   extension, open Antigravity, type `/switchboard`. The agent must launch standalone, print the snapshot,
   say it *started* standalone, and never mention opening or installing anything in another editor. This
   is the normal path in Antigravity, not an edge case — there is no extension host there, so launch is
   the only way a server ever comes to exist. Then, with a *different* IDE's extension running against the
   same workspace, repeat from Antigravity and confirm it *attaches* to that server (says *live*, not
   *started*) and starts no second writer.
9. **Not a scaffolder.** Run `/switchboard` in a directory with no `.switchboard/` → refuses rather than
   creating one.
9a. **Survives the terminal, and can still be stopped.** Launch via the script, then **close the
    launching terminal window** (not Ctrl-C) → the server keeps answering `/health`. Then
    `switchboard stop --workspace "$ROOT"` → the port stops answering, and **both** `api-server-port.txt`
    `api-server-pid.txt` and `api-server-token.txt` are all gone. Confirm no orphaned PTY children survive (`pgrep` the agent shells
    the fleet spawned) — that is what proves `stop()` ran rather than the process merely dying.
9b. **SIGHUP is clean now.** Launch in the *foreground*, close the terminal, and confirm the teardown ran:
    port file removed, PTY children reaped. Before the change this leaves both behind, so assert the
    before/after difference rather than just the after state.
9c. **Stop is honest about what it kills.** With a *different* workspace's server running, `switchboard
    stop --workspace <this root>` must not touch it. With a stale pid file pointing at a recycled PID,
    stop must health-probe first and refuse rather than SIGTERM an unrelated process — the failure mode
    that makes a naive pid-file implementation dangerous.
10. **Propagation.** In a workspace scaffolded before this change, confirm the new skill text is present
    after whichever mechanism change 6 selects (or that the documented manual step produces it).
11. `npm run lint` plus the standalone suites green, including
    `test:contract:secrets-bridge` — change 1 touches `main()`, through which the `secrets` subcommands
    return early (`cli.ts:170-201`); confirm that early return still precedes all attach logic.

## Uncertain Assumptions

- **That `/health` can distinguish extension from standalone.** Its current shape
  (`status`, `port`, `roots`, `terminals`, `terminalCount`, `selectedWorkspaceRoot`) has no host field.
  Change 1 proposes adding one rather than inferring — verify nothing already consumes `/health`
  positionally before extending it.
- **That the Windsurf 1.7.3 bundle exists.** Unchecked; only Devin was confirmed present. The resolver
  must handle absence per-root regardless, so this does not change the design — only the test fixture's
  realism.
- **That Antigravity 2 offers no extension mechanism at all** (confirmed against
  antigravity.google: it extends via *skills*, and its product material describes no extension
  marketplace). If a future Antigravity build gains one, the plan does not break — resolution already
  scans roots generically — but the "launch is the normal path there" framing would soften.
- **That launching standalone while the extension is *starting*** (port file not yet written) will not
  produce two writers. There is a genuine race between the extension's bind and the launcher's probe.
  Whether a lock file is required is unresolved; if a `.switchboard/` bind lock already exists, use it —
  otherwise this may need one, which would grow scope. **Check this before implementing change 1.**
- **That detaching is acceptable to the host.** Some agent harnesses reap process groups on tool-call
  exit, which would kill a detached child anyway. Verify in Antigravity specifically, since that is the
  target host.

## Out of Scope

- Publishing to npm or renaming the package. That is `b4-npx-distribution-publish.md`'s deliverable and a
  hard dependency of this plan, not an exclusion — this plan *consumes* the published name rather than
  choosing it. Previously listed here as out of scope; corrected once B4 was identified as the sibling.
- Removing the single-writer constraint or allowing two servers per workspace.
- Making the extension defer to a running standalone (the reverse direction).
- Auto-installing or auto-updating an extension bundle when none is found.
- Any change to how the board, panels or dispatch behave once a server is up — this plan only changes
  how one comes to exist and how it is stopped.
- Auto-stopping the server on idle, on workspace close, or after N minutes. A launched server outlives
  the session **deliberately** — that is what makes a second `/switchboard` an attach — so shutdown stays
  explicit (`switchboard stop`, a signal, or closing a foreground terminal). Automatic lifecycle
  management is follow-up work.
- A `POST /shutdown` HTTP endpoint. Change 3 argues against it (any local process, and any page the
  browser loads, can reach a loopback endpoint); if one is added later it must be API-token gated, not
  session-cookie gated.

> **Superseded:** this section previously read "Shutting a launched server down. It outlives the session
> by design; lifecycle management is follow-up work."
> **Reason:** the plan detaches the launched process, so excluding shutdown would ship a server with no
> controlling terminal, no recorded PID, and no stop path — strictly worse than today's foreground
> process. Shutdown is now change 3; only *automatic* lifecycle management remains out of scope.
