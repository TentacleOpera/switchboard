# Two Configurations: Board Only, and Board Plus Agents

## Goal

State — in the docs, the site and the setup flow — that LABCOM has **two** deployment shapes with
different requirements, and make the smaller one actually work:

- **Board only** — the board, the API and the pty host on a small box; agents run on other machines.
  **1 GB is enough.**
- **Board plus local agents** — everything on one box. **2 GB minimum, 4 GB comfortable.**

The site currently advertises only the second, so the cheapest useful configuration is invisible.

> **Superseded:** Complexity: 3
> **Reason:** The self-score of 3 understates the two real design surfaces this plan carries. Proposed Change #2 (repo-relative plan path) is cross-cutting: it touches the shared `_readRows` absolutization path (`KanbanDatabase.ts:14487`), the dispatch prompt template (`KanbanProvider.ts:5877`, `:5951`), and the `GET /kanban/board` response — a wrong move there breaks every board consumer. Proposed Change #1 (V8 heap ceiling) has a genuine mechanism question (V8 flags are parsed once at process startup; runtime derivation from `MemAvailable` is not possible without a launcher wrapper). The docs and site-copy work is routine, but the two functional changes are moderate, well-scoped risks extending existing patterns.
> **Replaced with:** Complexity: 5

### Problem analysis

**The board alone is small.** Measured on a Pi 400 with zero seats: **182 MB** RSS settled. Pi OS Lite
headless is ~100-150 MB. An ssh client per remote seat is a few MB. 1 GB is comfortable.

**And running agents elsewhere needs no new code.** A seat's startup command is a plain shell string
executed in a pty — today `agy --dangerously-skip-permissions`. Make it
`ssh desktop 'agy --dangerously-skip-permissions'` and the pty is local while the agent runs on the
other machine. The Pi holds ~5 MB for the client instead of ~250 MB for the agent.

**What actually has to change is small.** The earlier framing here — "the working tree must be where
the agent is", a shared mount versus drifting clones — was wrong. Both machines clone the same repo;
the agent works its own copy and git is the sync, which it already is (`feat(board): bidirectional
git-carried shared board snapshot`). Two concrete gaps:

1. **The plan path handed over is absolute.** `GET /kanban/board` returns `planFile` as
   `/home/patrick/switchboard/.switchboard/plans/…` even though the database stores it relative, so a
   lead filling the `Implement the plan at <path>` template (`KanbanProvider.ts:5877`, `:5951`) passes
   a board-host path that need not exist on the agent's machine. Hand over the **repo-relative** path
   and say it is relative to the agent's repo root. That is the whole fix.
2. **The plan must be committed and pushed before a remote dispatch.** Otherwise the path resolves to
   nothing in the agent's clone. This is a real constraint, not a theoretical one: **4 plan files are
   uncommitted on this box right now**, and commit `23244777` is literally titled *"board: commit
   three plan files that existed only on the Pi"*. A remote dispatch of an uncommitted plan fails, and
   it fails as "file not found" inside the agent rather than as a dispatch error.

**Completion already travels fine.** It is an HTTP call — `switchboard done --from <seat>` — which
`teamWiring.ts:456` describes as *"the explicit completion signal that replaces the unreliable
mtime-"* signal. The older mechanism, *"first plan-file mtime advance after dispatch"* (bundled
contracts skill, contract #2), is filesystem-local and will not fire for a remote agent — so the
activity light goes quiet even though completion is reported. Cosmetic, but it should be known rather
than discovered.

**Heap drift still eats a 1 GB margin.** The host grew **182 MB → 271 MB with no seats** over about an
hour (see `the-host-accumulates-heap-and-inotify-watches-over-a-days-use`). On 4 GB that is noise; on
1 GB it is a tenth of the machine, so that plan is a prerequisite for advertising 1 GB.

**On transport: SSH is not a LABCOM requirement, it is the only sane option.** What a seat needs is a
pty it can write to and read from. tmux sockets are unix-domain only — `-L name` or `-S path`
(`tmuxBackend.ts:74`) — so they cannot cross a machine boundary. A plain TCP pty service would be an
unauthenticated remote shell on the LAN. `mosh` is the better choice than raw `ssh` for a long-lived
seat because it survives a network drop instead of killing the session and the seat with it; both are
installed here. Being on the same LAN changes nothing — you still need authentication and a pty
multiplexer, and that is ssh.

## Metadata

**Complexity:** 5
**Tags:** docs, infrastructure, ux, api
**Dependencies:** `the-host-accumulates-heap-and-inotify-watches-over-a-days-use` must land before
1 GB is advertised.

## User Review Required

None.

## Complexity Audit

### Routine
- Documenting the remote-seat recipe in `docs/REMOTE_ACCESS.md` (prose, worked example).
- Site copy change: two lines replacing the single "Minimum: A 2 GB Raspberry Pi 4" line.
- The board-only vs board-plus-agents framing is already established in `docs/LOW_MEMORY_HOSTS.md` and the heap-drift plan; this plan states it in the user-facing surfaces.

### Complex / Risky
- **Repo-relative plan path (Change #2) is cross-cutting.** `KanbanDatabase._readRows` (`KanbanDatabase.ts:14487`) calls `_resolveAbsolutePlanFile` on every `plan_file` read, so the absolute path is consumed by 169+ references across the webview, board mirror, and dispatch paths. The fix must be *additive* (a new relative field / a relative path in the dispatch prompt only), NOT a global change to `_readRows` — changing the shared path breaks every board consumer.
- **V8 heap ceiling mechanism (Change #1).** `--max-old-space-size` is parsed once at V8 isolate creation; `v8.setFlagsFromString` at the top of the entry script is a silent no-op (measured). The knob must be a CLI flag in the node argv at **both** Go handoff sites — `HandoffStart` (`internal/launcher/discovery.go:185`, the launcher path) and `execNode` (`cmd/switchboard/main.go:302`, the terminal-typed path). Unconditional 512 — no `MemAvailable` threshold. **Premise corrected by research (2026-09-11):** the cap *raises* the ceiling above the 355 MB drift (the default ~342 MB ceiling on a 700 MB box is below the drift), it does not lower it for visibility — uncapped Node already dies with a loud V8 OOM abort. See Resolved Assumptions.
- **The commit-before-dispatch guard (Change #2 guard) has no "remote" signal.** A seat's startup command is an opaque shell string; the host cannot tell `ssh desktop 'agy …'` (remote) from `agy …` (local). A guard that "refuses/warns on remote dispatch" is unimplementable without a seat metadata flag marking the seat remote. See Outstanding Questions.

## Edge-Case & Dependency Audit

- **Race Conditions:** A plan committed-and-pushed between the dispatch and the agent's clone fetch resolves correctly (agent fetches latest). A plan committed but NOT pushed fails the same as an uncommitted one — the guard must check `git status` (working tree) AND that the commit is on the remote-tracking branch, or it gives a false "safe" signal.
- **Security:** The remote-seat recipe puts an authenticated pty (ssh/mosh) on the LAN. The board's loopback/tailnet guards (`docs/REMOTE_ACCESS.md`) are unchanged — the remote *agent* reaches the board's API over the existing tailnet/SSH-tunnel path, not a new exposed port. No new attack surface, but the docs must say the agent needs network reach to the board API (on a tailnet it already has it).
- **Side Effects:** The cap *raises* the ceiling above the 355 MB drift (corrected premise — see Resolved Assumptions), so shipping #1 alone no longer makes the box crash sooner; it helps. But the drift continues to consume the raised headroom, so the heap-drift dependency remains a prerequisite for *sustained* 1 GB operation, not for the cap being safe to ship.
- **Dependencies & Conflicts:** Hard dependency on `the-host-accumulates-heap-and-inotify-watches-over-a-days-use` (heap retention fix) before 1 GB is advertised and before #1 is safe. The repo-relative path change is independent of the heap work and can ship first.

## Dependencies

- `the-host-accumulates-heap-and-inotify-watches-over-a-days-use` — must land before 1 GB is advertised. The heap-drift plan fixes *retained* heap (reachable objects, 5× growth); Change #1 *raises* the V8 ceiling above the drift so the board-only host survives its own heap growth, but does not fix the retention. The dependency is a prerequisite for *sustained* 1 GB operation (the drift would otherwise consume the raised headroom over time), not for the cap being safe to ship.

## Adversarial Synthesis

Key risks: (1) the repo-relative path fix touching the shared `_readRows` absolutization and breaking every board consumer if done globally rather than additively; (2) the V8 heap ceiling mechanism — `v8.setFlagsFromString` is a silent no-op, so the knob MUST be a CLI flag in the node argv at both Go handoff sites (`HandoffStart` and `execNode`), never an in-script call (measured, research 2026-09-11); (3) the commit-before-dispatch guard having no "remote" signal to gate on, making "block remote dispatch" unimplementable without a new seat metadata flag; (4) the heap-ceiling premise was backwards — the cap *raises* the ceiling above the 355 MB drift (default ~342 MB on a 700 MB box is below the drift), it does not lower it for visibility — corrected via Superseded callout in Change #1. Mitigations: make the path fix additive (relative field beside the absolute, prompt template updated only); implement #1 as `--max-old-space-size=512` appended to the node argv in both `HandoffStart` and `execNode`, unconditional; default the guard to warn-on-all-uncommitted and reserve blocking for explicitly-remote seats.

## Proposed Changes

### 1. Set an explicit V8 heap ceiling on the Node host

- **Context:** The Node host (the process that grows to 355 MB heapUsed) is launched through one of two Go entry points, both of which `syscall.Exec` into node on Unix (process replacement):
  - **`switchboard-launcher`** — the static controller. `HandoffStart` (`internal/launcher/discovery.go:185`) execs `node <entry> local --workspace-root …`. This is the icon-launch / supervised path.
  - **`switchboard` CLI** — the Go front controller. When you type `switchboard` in a terminal, non-client verbs delegate via `delegateOrNoHost` → `execNode` (`cmd/switchboard/main.go:302`) → `syscall.Exec(node, all, os.Environ())`. This is the terminal-typed path.
  Both build `all := append([]string{node, entry}, args...)` and pass `os.Environ()`. No `--max-old-space-size` / `NODE_OPTIONS` / `MemAvailable` read exists anywhere in `src/standalone/bootstrap.ts` or the Go entry points today (verified).

  **Terminal runtime architecture (corrected):** the primary terminal runtime is the **Go pty-host** (`cmd/switchboard-pty-host/main.go`) — a standalone Go HTTP server that spawns real PTYs via `creack/pty`, binds loopback, and is supervised by the Node host's `PtyHostSupervisor` (`src/services/ptyHostSupervisor.ts:294`) over HTTP. The **Node tmux backend** (`src/standalone/tmuxBackend.ts`) is a *fallback bridge* for adopting external tmux panes the host does not own — it is wired as the second resolution rung (PTY first at every step, tmux only when no PTY matches) and never auto-creates panes by default. They coexist; PTY wins. The heap ceiling applies to the **Node host process only** — the Go pty-host is a separate Go process with no V8 heap.

> **Superseded:** node sizes its old-space against the machine. On a 1 GB box that default can exceed what is actually available, and the failure is an OOM rather than a GC. Provide a bounded ceiling so the failure is a visible V8 abort (logged) instead of a silent kernel OOM kill. Deliver via `NODE_OPTIONS` in the launcher / operator environment, OR a small shell launcher wrapper.
> **Reason:** Measured on Node v24.19.0 under cgroup-simulated 1 GB / 700 MB available (research return from analyst-1, 2026-09-11). The premise is backwards on two counts. (1) An uncapped Node process already dies with a loud V8 OOM abort — `FATAL ERROR: JavaScript heap out of memory`, full GC log, native stack trace, SIGABRT (rc=134). The "silent kernel OOM kill" the plan feared does not happen under the cgroup-constrained case V8 actually sizes against. The visibility problem the cap was meant to solve does not exist. (2) The real problem is the opposite: V8's auto-sized ceiling on a 700 MB-available box aborts at **~342 MB heapUsed** — *below* the host's measured **355 MB drift** figure. Uncapped, the host crashes during normal operation. The cap's job is to **raise** the ceiling to fit the workload, not lower it for visibility. On a real unconstrained 1 GB Pi (no cgroup), V8 sizes against 1 GB physical (~560 MB ceiling) and *can* grow past the ~700 MB actually free after the OS — that is the one path where a genuine kernel OOM is possible, and the cap closes it, but not by "making the failure visible." The "shell launcher wrapper" framing was also wrong — the Go launcher *is* that wrapper and already exists at `internal/launcher/discovery.go:185`.
> **Replaced with:** Raise the V8 old-space ceiling above the host's measured drift so the board-only host survives its own heap growth. The default ceiling is too low for this workload, not too high; the knob lifts it. Value **512** (measured: survived 400 MB heapUsed at 472 MB RSS on a 700 MB-available box, clearing the 355 MB drift with headroom). Append `--max-old-space-size=512` to the node argv in **both** Go handoff sites — `HandoffStart` (`internal/launcher/discovery.go:185`) and `execNode` (`cmd/switchboard/main.go:302`) — as an unconditional constant. Never `v8.setFlagsFromString` (silent no-op, measured) and never `NODE_OPTIONS` (leaks into every child process the host spawns, including the Go pty-host, which doesn't need it).

- **Implementation:**
  - **`internal/launcher/discovery.go:194`** — in `HandoffStart`, insert `--max-old-space-size=512` into the node argv *before* the entry script. Current: `args := []string{verb, "--workspace-root", workspaceRoot}`. The node invocation is `all := append([]string{node, entry}, args...)` then `syscall.Exec(node, all, os.Environ())`. The flag must go between `node` and `entry` in the `all` slice: `all := append([]string{node, "--max-old-space-size=512", entry}, args...)`. V8 parses it as a CLI flag before loading the entry script.
  - **`cmd/switchboard/main.go:307`** — in `execNode`, same pattern. Current: `all := append([]string{node, entry}, args...)`. Change to `all := append([]string{node, "--max-old-space-size=512", entry}, args...)`.
  - **Unconditional, not conditional.** Do NOT read `MemAvailable` and gate on a threshold. 512 is safe on every box the product targets: on a 1 GB box it clears the 355 MB drift with headroom; on a 4 GB box the workload stays at ~355 MB and never approaches the 512 cap, so the cap is inert (no regression). A conditional threshold (e.g. "only set when `MemAvailable < 2 GB`") collapses the two configurations the plan exists to distinguish back into one, misfires on a busy 4 GB box that reads as 1 GB free, and rots when hardware changes. The ceiling is a floor on the failure point, not a limit on usage — the host uses what the workload needs (~355 MB) and the cap only matters when it would exceed it.
  - **Single constant.** Define the value once (e.g. a `const maxOldSpaceFlag = "--max-old-space-size=512"` in a shared internal package, or duplicate the literal in both sites with a comment pointing to the other). Two sites, one value.
  - **Document** in `docs/LOW_MEMORY_HOSTS.md` (section 3 already covers the 4 GB case): the standalone host now sets `--max-old-space-size=512` unconditionally via the Go launcher and CLI, the rationale (raises the ceiling above the 355 MB drift), and the measured behavior. This is a *mitigation* (raises the ceiling past the drift), not a fix for the retention — the dependency plan fixes the retention. Standalone-host-only by nature (the extension host runs inside VS Code's node process, which VS Code owns); the board-only configuration is a standalone concept, so this is correct, not a parity divergence.
- **Verification gotcha:** `heap_size_limit` readback from `v8.getHeapStatistics()` is old-space **plus ~192 MB** of other spaces (new/semi, code, large-object). Measured mapping: requested 512 → reported 704, 256 → 448, 64 → 256. A test asserting `heap_size_limit === 512` will conclude the knob is broken and "fix" a working implementation. Assert the *behavior* (the host survives a 400 MB heap fill on a 700 MB box), not the readback equality.
- **Edge Cases:** The dependency ordering still holds, but the rationale shifts: the cap raises the ceiling past the drift, it does not bound a failure. Shipping #1 alone (without the heap-drift fix) is no longer a "crash sooner" regression — it raises the ceiling, which helps — but the drift continues to consume the headroom, so the dependency remains a prerequisite for *sustained* 1 GB operation, not for the cap being safe to ship. The flag in argv does NOT propagate to the Go pty-host (it's a separate Go process spawned by `PtyHostSupervisor` with its own env) — correct, since the pty-host has no V8 heap.

### 2. Hand over a repo-relative plan path

- **Context:** `GET /kanban/board` returns `planFile` absolute because `KanbanDatabase._readRows` (`KanbanDatabase.ts:14487`) calls `_resolveAbsolutePlanFile` on every read, even though the DB stores the path relative (invariant documented at `KanbanDatabase.ts:1177`: *"all plan_file values in DB are relative; absolute only in memory after _readRows()"*). Verified live: `GET /kanban/board` returns `/home/patrick/switchboard/.switchboard/plans/…`. The lead's dispatch template (`KanbanProvider.ts:5877`, `:5951`) embeds that absolute path in `Implement the plan at <path>`.
- **Logic:** the dispatch path and `GET /kanban/board` should give a repo-relative `planFile`, and the lead's template should state it is relative to the agent's repo root. Absolute board-host paths are the only thing that makes a remote seat fail today.
- **Implementation:** Make the change **additive**, not global. Do NOT alter `_readRows`'s absolutization (169+ consumers depend on the absolute form). Instead: (a) add a `planFileRelative` field to the `GET /kanban/board` response carrying the raw DB value, and (b) update the dispatch prompt template at `KanbanProvider.ts:5877` / `:5951` to emit the repo-relative path with the clause "relative to your repo root" (the relative value is already available as the raw `card.planFile` before `_resolvePlanFilePath` absolutizes it — see `buildDispatchPlans` at `KanbanProvider.ts:4725-4730`).
- **Guard:** refuse — or warn on — a dispatch whose plan file is uncommitted, since the agent's clone cannot have it. Failing at dispatch is far better than failing inside the agent. **Open issue:** the host has no "this seat is remote" signal (the startup command is an opaque shell string), so a remote-only block is not implementable today. Default to warn-on-all-uncommitted; reserve blocking for seats explicitly marked remote (requires a new seat metadata flag — see Outstanding Questions).

### 3. Document the remote-seat recipe

- One worked example: a startup command of the `ssh`/`mosh` form, the commit-before-dispatch rule, and the callback path (the remote agent must reach the board's API; on a tailnet it already can).
- **mosh note (research 2026-09-11):** mosh survives network drops and roaming where ssh would kill the session, but it does NOT give reattach — once the mosh client process dies, the session is gone ("You have a detached Mosh session on this server" with no rejoin). mosh also does not survive a server reboot. So the recipe must recommend **mosh over ssh for the transport, with tmux underneath for true session persistence** — mosh handles the transport, tmux handles the session. Neither interacts with the heap ceiling.
- Belongs in `docs/REMOTE_ACCESS.md` (exists, 231 lines, already covers tailnet/SSH-tunnel access and the agentic API path at "Agentic access through the same tunnel"). Add a "Remote agent seats" subsection.

### 4. Say both configurations on the site

- `SYSTEM REQUIREMENTS` currently reads *"Minimum: A 2 GB Raspberry Pi 4"*. Two lines instead:
  board-only at 1 GB, board-plus-agents at 2 GB with 4 GB recommended.
- **Scope note:** the "Minimum: A 2 GB Raspberry Pi 4" copy is NOT present in this repo (verified by search of all `.md`, webview HTML, and README). The marketing site source lives outside this repository, so an implementer working this repo cannot deliver Change #4 from here. Change #4 is an external task unless the site source is located in another repo; the docs/setup-flow changes (#3) are deliverable in-repo.

## Verification Plan

### Automated Tests
- *(skipped this run per session directive — checks remain written down)*
- A contract test that `GET /kanban/board` returns a `planFileRelative` field equal to the raw DB `plan_file` value (relative) while `planFile` stays absolute (no regression to existing consumers).
- A contract test that the dispatch prompt template (`KanbanProvider.ts:5877` / `:5951`) contains a repo-relative path and the phrase "relative to your repo root", not an absolute board-host path.
- The existing `board-read-endpoints-contract.test.js` and `workspace-root-write-path-contract.test.js` must stay green (they assert the absolute-path behavior that #2 must NOT break).

### Goal Invariants
- Assert `GET /kanban/board` response objects carry BOTH `planFile` (absolute, unchanged) AND `planFileRelative` (relative) for an active plan.
- Assert the dispatch prompt string at `KanbanProvider.ts:5877` contains no `/home/`-style absolute path literal for the plan location (it must be the relative form plus the "repo root" clause).
- Assert `docs/LOW_MEMORY_HOSTS.md` documents the `--max-old-space-size=512` flag set unconditionally by the Go launcher and CLI for the Node host (file exists, contains the flag and the 512 value).
- Assert `internal/launcher/discovery.go` `HandoffStart` builds the node argv with `--max-old-space-size=512` between `node` and the entry script.
- Assert `cmd/switchboard/main.go` `execNode` builds the node argv with `--max-old-space-size=512` between `node` and the entry script.
- Assert `docs/REMOTE_ACCESS.md` contains a "Remote agent seats" (or equivalently named) section referencing the commit-before-dispatch rule.

## Resolved Assumptions

Both external uncertainties from the initial improve pass were resolved by measurement on Node v24.19.0 under cgroup-simulated 1 GB / 700 MB available (research return from analyst-1, 2026-09-11). These are authoritative — do not re-open.

- **V8 flag timing for `--max-old-space-size` — RESOLVED.** `v8.setFlagsFromString('--max-old-space-size=N')` at the top of the entry script is a **silent no-op** (measured: `heap_size_limit` unchanged). The flag is fixed at V8 isolate creation, before the entry script runs. Change #1 MUST use a CLI flag in the node argv at the Go handoff sites (`HandoffStart` and `execNode`), never an in-script call. This is exactly the fallback-indistinguishable-from-a-real-value trap CLAUDE.md warns about — the call succeeds, the flag is inert. `NODE_OPTIONS` also works but is rejected because it leaks into every child process the host spawns (including the Go pty-host, which doesn't need it); the argv approach is scoped to the node process only.
- **V8 default old-space ceiling on a 1 GB Linux box — RESOLVED.** On a 700 MB-available box, V8's auto-sized ceiling aborts at **~342 MB heapUsed** — *below* the host's measured **355 MB drift**. Uncapped, the host crashes during normal operation. The cap's job is to **raise** the ceiling (value **512**, measured: survived 400 MB heapUsed at 472 MB RSS), not lower it for visibility. On a real unconstrained 1 GB Pi (no cgroup), V8 sizes against 1 GB physical (~560 MB ceiling) and can grow past the ~700 MB actually free — the one path where a genuine kernel OOM is possible, which the cap also closes. Verification gotcha: `heap_size_limit` readback = old-space + ~192 MB (other spaces); assert behavior, not `heap_size_limit === N`. Unconditional 512 (no `MemAvailable` threshold) — safe on both 1 GB and 4 GB boxes; the ceiling is a floor on the failure point, not a limit on usage.

## Outstanding Questions

- **[user]** Should a remote dispatch be blocked outright when the plan file is uncommitted, or only warned? A block is honest but stops work on a box where plans are routinely written and dispatched in the same breath — which is how this board is actually used (5 uncommitted plan files verified live this session). — proceeding on the assumption that the default is **warn-on-all-uncommitted**, and a hard **block** is reserved for seats explicitly marked remote via a new seat metadata flag (which this plan does not add; a follow-up plan would).
- **[user]** The "Minimum: A 2 GB Raspberry Pi 4" site copy (Change #4) is not in this repo. Where does the marketing site source live, and should #4 be split into a separate plan owned by whoever controls that repo? — proceeding on the assumption that #4 is recorded here as scope but delivered externally; the in-repo deliverables are #1, #2, #3.

## Implementation Summary

Implemented #1, #2, #3 in-repo (#4 is external scope, recorded only). Change #1 appends `--max-old-space-size=512` unconditionally to the node argv at both Go handoff sites (`internal/launcher/discovery.go` `HandoffStart` and `cmd/switchboard/main.go` `execNode`), between `node` and the entry script, with cross-referencing comments; it raises V8's old-space ceiling above the ~355 MB drift and is inert on a 4 GB box. Change #2 is additive: `KanbanPlanRecord.planFileRelative?` (optional, populated in `_readRows` from the raw DB `plan_file`) carries the repo-relative path on `GET /kanban/board` alongside the unchanged absolute `planFile`; `BatchPromptPlan.relativePath?` threads it through `buildDispatchPlans`/`expandFeatureSubtaskPlans`, and `buildPromptDispatchContext` plus the drive-mode staging templates and FEATURE FILE line now emit the relative path with a "relative to your repo root" clause (falling back to absolute only when no relative form is known). A warn-on-all-uncommitted guard (`_warnIfPlanFileUncommitted`, `git status --porcelain`) fires at dispatch without blocking. Change #3 adds a "Remote agent seats" section to `docs/REMOTE_ACCESS.md` (mosh+tmux recipe, commit-before-dispatch rule, callback path) and `docs/LOW_MEMORY_HOSTS.md` documents the unconditional heap flag. Both composition roots share `KanbanProvider.buildDispatchPlans`, so the relative-path and warn land on standalone and the extension with no divergence; the heap flag is standalone-only by nature (the extension host runs in VS Code's node). Compilation and tests skipped per session directive.

## Review Findings

Reviewed in place against commit `8300a014`; no source changes were needed for this subtask — the
fixes this pass applied land in the sibling budget subtask. All three in-repo deliverables verify:
`--max-old-space-size` is between `node` and the entry script at **both** Go handoff sites
(`cmd/switchboard/main.go` `execNode`, `internal/launcher/discovery.go` `HandoffStart`), unconditional
and env-overridable via `SWITCHBOARD_MAX_OLD_SPACE_MB`, never `v8.setFlagsFromString` and never
`NODE_OPTIONS`; the repo-relative path change is genuinely additive — `planFileRelative` is populated
from the raw DB `plan_file` beside an unchanged absolute `planFile`, confirmed live on
`GET /kanban/board`, with `_readRows`'s absolutization untouched — and the dispatch prompt now emits
the relative form plus the "relative to your repo root" clause, which this review's own dispatch
prompt demonstrates end to end; `docs/REMOTE_ACCESS.md` carries the "Remote agent seats" section and
`docs/LOW_MEMORY_HOSTS.md` documents the flag. Verification: `compile-tests` clean, Go vet/build
clean, eslint 0 errors, and the prompt suites (`reviewer-prompt`, `minimal-prompt`,
`unattended-batch`, `feature-drive-prompt`, `drive-mode-prompt-overhaul`, `coding-head-prompt`,
`batch-move-team-prompt`) all pass, so the relative-path switch regressed no prompt consumer.
Change #4 (site copy) remains external scope as the plan records, and the 512 MB value is still the
plan's own admitted placeholder pending the sibling subtask's forced-GC measurement.

## Deferred Findings

- MAJOR — `_warnIfPlanFileUncommitted` resolves `repoRoot` from `rec.repoScope` but passes `planFileRel`, which is relative to `workspaceRoot`; when a repo scope is set git is asked about a path that does not exist under that cwd, returns empty, and the silence is indistinguishable from "committed". The CLAUDE.md quiet-fallback shape, bounded only because the guard is warn-only. `src/services/KanbanProvider.ts` (`_warnIfPlanFileUncommitted`).
- NIT — the same guard spawns one fire-and-forget `git status` subprocess per plan per dispatch, on the device this feature is trying to fit inside 1 GB; a batch dispatch of N plans is N subprocesses. Worth batching into a single `git status --porcelain` over all plan paths. `src/services/KanbanProvider.ts` (`buildDispatchPlans`).
- NIT — the 512 MB `--max-old-space-size` default is a placeholder by the plan's own account; the measured live-at-peak value that should replace it depends on the forced-GC split recorded as deferred on the sibling subtask. `cmd/switchboard/main.go`, `internal/launcher/discovery.go`.
