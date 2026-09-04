# Make standalone the first-class entry point: `/switchboard` launches or attaches instead of demanding an IDE

<!-- board-collapse-02 -->
> **RESCOPED 2026-09-04 (Board Collapse 02).** The Claude mirror generator is being deleted (*Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets*). Two consequences for this plan: (1) the rule "edit `.agents/workflows/switchboard.md`, the mirror source, never the generated `.claude/skills/switchboard/SKILL.md`" no longer holds — **edit both files**, they are both committed source; (2) `npm run mirror:check` will not exist. Replace it in the CI-gate list with the drift test that succeeds it.


## Goal

Invert the `/switchboard` entry protocol so its **first** action is to bring a Switchboard server up —
launching the standalone host when nothing is running, attaching to whatever is already running when
something is — instead of probing `.switchboard/api-server-port.txt` and, on a miss, telling the user to
go open the workspace in VS Code. An agent in Antigravity (or any host without the extension live)
should get a working board, not an instruction to change editors.

Delivering that needs a **resolvable launcher** (there is currently no runnable standalone binary
reachable from a generic workspace), a **version-skew guard** so an old CLI does not open a DB a newer
build has migrated, and the **skill protocol inversion** itself. Two further prerequisites — the CLI's
attach semantics and a stop path for a detached server — are the sibling plan
`standalone-cli-attach-and-lifecycle.md`, and a published launcher name is `b4-npx-distribution-publish.md`.
Both must land first; see Dependencies.

> **Superseded:** this plan previously also owned "attach semantics in the CLI (it presently hard-exits
> when a server is already up)" and "a way to stop a launched server", carrying the full `POST /session/token`
> minting design, the `api-server-token.txt` / `api-server-pid.txt` writes, the `switchboard stop`
> subcommand and the SIGHUP fix as its changes 1 and 3.
> **Reason:** those are server-side changes to `src/standalone/cli.ts`, `bootstrap.ts` and
> `LocalApiServer.ts` that ship, verify and deliver value entirely on their own — attach-and-stop is
> useful to a human typing `switchboard` in a terminal whether or not any agent protocol ever changes.
> Bundling them with the agent-protocol work produced one complexity-7 plan spanning seven changes, two
> disciplines (loopback auth design and markdown protocol authoring) and eleven verification steps, which
> the repo's plan-sizing rule ("2+ independently-shippable phases → split") exists to prevent. Keeping
> them here also hid a real ordering fact: the attach/lifecycle work does **not** depend on B4, only this
> plan does.
> **Replaced with:** extracted verbatim-in-intent into `standalone-cli-attach-and-lifecycle.md`, which
> this plan now takes as a hard dependency. Nothing was dropped — the mint design, the three-file atomic
> discovery set, the PID-recycling refusal and the SIGHUP fix all live there, plus a correction to the
> "equally circular" credential reasoning and a fourth edit site (`safeFiles`) that the original analysis
> missed.

### The observed failure

A user with the Antigravity app open types `/switchboard`. The agent runs the §1 entry protocol, finds
no port file, and per `.claude/skills/switchboard/SKILL.md:47-48` reports:

> If the port file is missing, tell the user to open the workspace in VS Code with the Switchboard
> extension active. Do not fall back to direct DB access.

So the console's front door is conditional on a *different application* being open. Standalone exists
precisely to remove that dependency, and the agent-facing protocol never reaches for it.

### Root cause 1 — there is no launcher to invoke *yet*, and B4 is what supplies one

The obvious command does not exist **today**. Verified on this machine (re-verified 2026-08-04):

- `which switchboard` → not found; `npm ls -g` → not installed.
- `npx switchboard` fetches the **wrong package**: per `b4-npx-distribution-publish.md`'s verified
  finding, `npm view switchboard` returns an unrelated composite-event-listener library
  (brynbellomy/jonschlinkert, `1.3.0`, last published ~2024), so publishing under that name 403s and a
  fresh machine running `npx switchboard` gets that library. `package.json` declares
  `bin: { switchboard: './dist/standalone/cli.js' }`, but nothing publishes it — and, as B4 established
  at HEAD, the package has no `files` allowlist either, so even an authorised `npm pack` today would omit
  the gitignored `dist/` the `bin` points at.

**This is not a permanent constraint — it is `b4-npx-distribution-publish.md`'s job.** Once B4 publishes
under a claimable name, `npx <name>` becomes the launcher and this plan's resolution logic collapses to
"prefer the published CLI." **Sequence B4 first** — see Dependencies.

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
Antigravity offers — which is precisely why the protocol inversion in change 3, not an extension-side
fix, is the deliverable.

Bundles measured across this machine's IDE install roots (all of these are *sources to copy a launcher
from*, reachable by reading the filesystem — none require an extension host in the IDE the agent is
running in). Re-measured 2026-08-04:

| Install root | Version | `dist/standalone/cli.js` |
|---|---|---|
| `~/.devin/extensions/turnzero.switchboard-1.7.13` | 1.7.13 | **present** (6.7 MB, plus 8 lazy chunks + `ptyHost.js`) |
| `~/.windsurf/extensions/turnzero.switchboard-1.7.3` | 1.7.3 | **absent — no `dist/standalone/` directory at all** |
| `~/.vscode`, `~/.cursor` | — | not installed |
| `~/.antigravity/…-1.5.9` | — | **not an install** — stale pre-fork residue, ignore |

So even after B4, the pre-upgrade population needs a fallback, and a plan that assumes "launch the
bundled binary from the host you're in" is broken for the host that prompted the request — not because
its bundle is missing, but because it has no extension at all. The launcher resolves a published CLI
first and falls back to scanning install roots on disk, picking a version deliberately and failing with
something actionable when nothing qualifies.

Two facts the resolver depends on, both now measured rather than assumed:

- **Windsurf 1.7.3 has no standalone bundle.** This was previously listed as an unchecked assumption; it
  is now a verified negative and the best possible test fixture. A resolver that enumerates install roots
  and assumes each holds a `cli.js` picks Windsurf's 1.7.3 over Devin's 1.7.13 on a naive "newest root"
  heuristic and then fails to execute anything.
- **The bundle is chunk-split.** `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/standalone/`
  contains `cli.js`, `ptyHost.js`, and eight lazy chunks (`1.cli.js`, `2.cli.js`, `3.cli.js`, `251.cli.js`,
  `438.cli.js`, `719.cli.js`, `2.js`, `3.js`, `438.js`, `719.js`). The launcher must **execute the file in
  place** (`node <root>/dist/standalone/cli.js`) and must never copy `cli.js` somewhere else to run it —
  it would boot and then die at the first lazy `require`.

Note also that the **launcher core already shipped** — `extract-standalone-npx-04-npx-distribution.md`
(`CODE REVIEWED`, in the *Standalone Headless Switchboard (npx)* feature) delivered the `bin` entry,
boot, `/health` gate, one-time-token handoff and browser-open. What it did **not** deliver is
attach-to-a-running-instance: its only "reuse" semantics are token single-use enforcement. That gap is
the sibling plan's, not this one's.

### Root cause 2 — the protocol treats the port file as a fact about the world

The entry protocol reads `api-server-port.txt` as "is Switchboard available", when it actually means
"did some host previously write a port here". Two consequences:

- **A miss is treated as terminal** rather than as "nothing is up yet — start it."
- **A hit is trusted structurally.** `findRunningInstance` (`cli.ts:110-117`) health-probes before
  believing it; the skill's §1 does not, it just `cat`s the file and calls `/health` on that port. A stale
  port file from a crashed host makes the agent report a port that answers nothing. (In practice `/health`
  failing is caught, but the protocol has no *recovery* step — and after this change, recovery is exactly
  "launch".)

Note the port file is host-agnostic: `cli.ts:111` and `bootstrap.ts:1462` write it for standalone, and
`TaskViewerProvider.ts:2397/2451/2483` write it for the extension (gated by the eligibility rule
`_filterPortFileEligibleRoots` at `:2572`, which only writes into roots where `.switchboard/` already
exists as a directory). So the file identifies *a* server, never *which kind*. Attach logic must not
assume either.

### Root cause 3 — the skill edit must be made in the mirror's *source*, not the mirror

> **Superseded:** "**Root cause 4 — the skill edit will not reach the running agent by itself.**
> `src/extension.ts:363`, `:408` and `:4106` all copy skill templates with
> `vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false })`. A workspace's skill copy is therefore
> frozen at first install: editing `.claude/skills/switchboard/SKILL.md` in this repo does not update an
> already-scaffolded workspace." — with a change 6 that had to choose between implementing a content-hash
> refresh and documenting a manual `rsync`.
> **Reason:** **the freeze is already fixed at HEAD.** All three cited `overwrite: false` calls are the
> *destination-absent* branch of a content-hash refresh loop, not a blanket guard.
> `refreshWorkspaceControlPlane` (`src/extension.ts:325-415`) hashes source against destination
> (`ControlPlaneMigrationService.hashFile`) and copies with `{ overwrite: true }` when they differ —
> once for `.agents/skills/**` (`:337-370`) and again for `.agents/workflows/**` (`:382-414`), with the
> same semantics repeated at `:4088-4110`. The installed Devin 1.7.13 bundle contains the refresh, so it
> is live, not merely committed. A change 6 that re-implements this would be duplicate work.
> **Replaced with:** propagation is already delivered; the residual risks are named below, and the real
> root cause in this area is a different one — the skill file this plan proposed to edit is a **generated
> artifact**.

`.claude/skills/switchboard/SKILL.md` is **not** an editable source file. It is generated by
`ClaudeCodeMirrorService.generateClaudeMirror` from `.agents/workflows/switchboard.md` — the
`MIRROR_ENTRIES` table declares `{ source: 'workflows/switchboard.md', name: 'switchboard',
invocation: 'default', allowedTools: 'Bash' }`. Drift between the two is a **CI failure**:
`npm run mirror:check` (`scripts/check-claude-mirror.js`) regenerates the mirror into a temp directory
and diffs it against the committed `.claude/skills/`, explicitly to backstop "the 'skill fixes don't
stick' bug this guard backstops". So editing `SKILL.md` directly both fails CI and gets overwritten on
the next scaffold.

Two residual propagation caveats remain, and they are notes rather than work:

- **Pre-refresh installs still freeze.** A workspace last scaffolded by an extension build older than the
  content-hash refresh keeps its stale copy until a refreshing build opens it once.
- **Antigravity never refreshes anything**, because it has no extension host. An agent there reads
  whatever copy some other host left in the workspace. So the updated protocol reaches an
  Antigravity-only workspace only when another IDE opens that same workspace at least once — which is the
  ordinary case for these workspaces, but should be stated in the release note rather than assumed.

## Metadata
- **Project:** Browser Switchboard
- **Feature:** b0f1f2cd-8591-4021-8b5f-51e5b6bcbb1f
- **Tags:** cli, dx, docs, reliability
- **Complexity:** 5

> **Superseded:** **Complexity:** 7 (itself a re-score from 6 "on adding change 3 (lifecycle)").
> **Reason:** the two changes that carried the risk — loopback session minting and process lifecycle —
> moved to `standalone-cli-attach-and-lifecycle.md`. What remains is a dependency-free Node resolution
> script, a semver comparison, and a markdown protocol rewrite in a mirrored source file. The residual
> risk is concentrated in one place (a launcher that must fail *actionably* rather than silently), which
> is a 5, not a 7.
> **Replaced with:** **Complexity:** 5

> **Superseded:** `**Repo:** switchboard` and `**Feature:** Standalone CLI Scaffolding`.
> **Reason:** the session is single-repo, so a `**Repo:**` line is meaningless here; and the feature name
> was stale — this plan is a subtask of *Standalone Distribution & First-Class Entry*
> (`b0f1f2cd-8591-4021-8b5f-51e5b6bcbb1f`), which is the value the importer actually reads.
> **Replaced with:** the `**Feature:**` UUID above; `**Repo:**` dropped.

## User Review Required (decisions, with defaults)

1. **Which launcher wins when several exist?** Default: **highest semver across all IDE install roots**,
   preferring an exact match to the workspace's own `dist/standalone/cli.js` when the workspace *is* the
   switchboard repo (so developers test what they just built). Alternative: prefer a bundle belonging to
   the host the agent is running in — rejected outright, not merely deprioritised: Antigravity has no
   extension host, so "the host I'm in" supplies nothing at all there. Resolution must never be scoped to
   the current IDE.

2. **Should the launcher be a new CLI subcommand, a script, or skill-embedded shell?** Default: **a
   committed helper script** (`.agents/scripts/switchboard-up.js`) that the skill calls, so the resolution
   logic is testable, versioned, and fixable without editing prose in N workspace copies. Rejected:
   embedding a multi-step resolution heuristic in the workflow markdown, which cannot be tested.
   `.agents/scripts/` is an established convention — it already holds six dependency-free Node scripts
   (`check-webview-sync.js`, `copy.js`, `kanban-list.js`, `review-request-builder.js`,
   `stage-artifacts.js`, `verify_plan.js`).

3. **How much version skew is tolerable?** A 1.5.9 CLI opening a DB that a 1.7.13 extension has migrated
   is a real hazard — `KanbanDatabase` migrations are live and actively failing in one case (see the
   separate *V20 migration fails on every fresh DB* plan). Default: **launch the newest available and
   warn if it is older than any extension that has run against this workspace**; refuse only if the DB
   records a schema version the CLI does not know. Needs your call on whether refusing is too strict.

4. **Should `/switchboard` launch without asking?** Default: **yes, launch silently and report it** —
   this is the substance of the request. But it starts a background process the user did not explicitly
   ask for, which cuts against the skill's "no eager action on entry" rule (Hard Rule 3). Default
   resolves the tension by treating *bringing up the board* as reading state, not acting on it; nothing
   is dispatched, no card moves. Flagging because it is a genuine rule change, not an omission.

## Proposed Changes

### 1. Launcher resolution — new committed helper

Add `.agents/scripts/switchboard-up.js` (Node, no dependencies, mirroring the existing
`.agents/scripts/` convention). **With B4 landed, step 2 is the happy path and steps 3–4 exist only for
un-upgraded installs** — do not over-invest in the fallback. It resolves the first workable entry point
in order:

1. `$ROOT/dist/standalone/cli.js` — only when `$ROOT` is the switchboard repo itself (checked via
   `package.json` `name`), so a developer's build wins locally. **Check the `bin` entry rather than a
   hardcoded name string**, since B4 changes `name` and would silently break a name-equality check.
2. **The published CLI** — `<published-name>` on `PATH`, else `npx --yes <published-name>`. B4 fixes the
   name, so take the final name from B4 rather than hardcoding `switchboard`; a hardcoded `switchboard`
   would fetch the unrelated third-party library. If B4 has not landed, this step is a no-op.
3. The newest `dist/standalone/cli.js` found by scanning extension install roots on disk —
   `~/.{vscode,vscode-insiders,cursor,windsurf,devin}/extensions/turnzero.switchboard-*/`. This is a
   filesystem scan for a *file to execute*; it does not require an extension host in the IDE the agent is
   running in, which is what makes it usable from Antigravity at all. Sort by parsed semver from the
   directory name, not lexically (`1.7.13` must beat `1.5.9`, which a string sort gets wrong). **Skip
   candidates whose `dist/standalone/cli.js` is absent** — Windsurf 1.7.3 on this machine is exactly that
   case, so enumerating roots is provably not enough on its own. **Execute the resolved file in place;
   never copy it** — the bundle is chunk-split and a lone `cli.js` dies at its first lazy require.
   Scanning `~/.antigravity/extensions/` is harmless but pointless: it holds only stale pre-fork residue.
4. Nothing found → exit non-zero with a message naming what was tried and the real remedies (install the
   published CLI, or build the repo), never "open VS Code" and never "install the extension in this IDE"
   — that instruction is impossible in Antigravity.

Then: run the resolved launcher with `--workspace $ROOT`, wait for health using the same `waitForHealth`
contract as `cli.ts:134-141`, and print a single machine-readable line the skill can parse
(`SWITCHBOARD_PORT=<port>` plus `SWITCHBOARD_MODE=attached|launched`). Emitting the mode is what lets the
skill report honestly which happened. Pass `--no-open` explicitly — the CLI opens a browser by default
for both launch and attach (sibling plan, decision 1), and an agent tool call should not spawn a tab.

Detach the child (`spawn(..., { detached: true, stdio: 'ignore' }).unref()`, as `openBrowser` at
`cli.ts:119-132` already does) so the server outlives the agent's shell invocation — otherwise the
board dies with the tool call that started it, because an agent's tool-call shell exits the moment the
command returns. Log the child's stdout/stderr to `.switchboard/standalone-launch.log` so a failed boot
is diagnosable after detaching. **Detaching is why `standalone-cli-attach-and-lifecycle.md` is a hard
dependency** — a server with no controlling terminal and no shutdown affordance is unstoppable without
`lsof`.

**Guard on an existing workspace.** `.switchboard/` must already exist for the workspace to be
Switchboard-managed. The CLI itself creates it (`cli.ts:156-159`), which is right for a human typing the
command in a new project but wrong for an agent-initiated launch — check for an existing `.switchboard/`
or `kanban.db` **before** invoking the launcher, or `/switchboard` in a random folder silently scaffolds
one. This mirrors the extension's own `_filterPortFileEligibleRoots` rule (`TaskViewerProvider.ts:2572`),
which refuses to write a port file into a root that has no `.switchboard/` directory for exactly this
reason.

### 2. Version-skew guard — `.agents/scripts/switchboard-up.js` + `src/standalone/bootstrap.ts`

Per decision 3: after resolving a candidate, compare its version against the highest
`turnzero.switchboard-*` present on the machine and warn on stdout when launching an older CLI. Have
`bootstrap.ts` refuse to open a `kanban.db` whose recorded schema version exceeds the maximum migration
the running build knows, with an explicit message, rather than attempting a downgrade path that does not
exist.

### 3. Invert the entry protocol — `.agents/workflows/switchboard.md` (**not** the `.claude` mirror)

Rewrite §1 step 1 so **Command A becomes "bring it up"**:

- Resolve `$ROOT` as today (walk for `.switchboard/`, or take it from the dispatch prompt).
- Run `node .agents/scripts/switchboard-up.js --workspace "$ROOT"`, read `SWITCHBOARD_PORT` and
  `SWITCHBOARD_MODE` from its output, and set `BASE` from that. This **replaces** reading
  `api-server-port.txt` — the script owns discovery, including the health probe.
- Delete the "tell the user to open the workspace in VS Code" instruction. Replace it with the launcher's
  own failure output, which names concrete remedies.
- Keep Command B (the local `kanban-state-*.md` awk) exactly as-is — unchanged, and still the source of
  board counts.
- Report the mode in the entry snapshot: "Switchboard is live (port 60837)" when attached, "Started
  standalone Switchboard (port 61402)" when launched. The user must be able to see that a process was
  started on their behalf.
- Keep the cross-check that `$ROOT` appears in `health.roots`.
- Mention `switchboard stop` (sibling plan) as the counterpart to launching, so an agent that started a
  server can be asked to stop it.

**~~Then regenerate the mirror~~ **VOID 2026-09-04 (Board Collapse audit): the generator is being deleted.** Edit both files directly and commit both.** `.claude/skills/switchboard/SKILL.md` is generated from
this file; `npm run mirror:check` fails CI on drift. ~~Editing the mirror directly is the wrong door~~ — **inverted 2026-09-04.** With `.claude/skills/` committed as source, editing both trees in one commit is the *only* door.

- **Edge cases:** the workflow file is ~36 KB and the mirror wraps it with a preamble and frontmatter —
  do not hand-edit the generated header. The `allowedTools: 'Bash'` declaration in `MIRROR_ENTRIES`
  already permits the `node …/switchboard-up.js` call, so no mirror-table change is needed.

### 4. Tests

- Launcher resolution: given a fixture tree of install roots, picks the highest semver **that has a
  `cli.js`**; skips a bundle-less newer-rooted version in favour of an older one that has a bundle
  (the real Windsurf-1.7.3-vs-Devin-1.7.13 shape); prefers the repo build when `$ROOT` is the switchboard
  repo; exits non-zero with the roots listed when nothing matches. Assert **semver ordering, not string
  ordering** — `1.7.13` vs `1.5.9` is the discriminating pair.
- Workspace guard: the script refuses, with a clear message, in a directory that has no `.switchboard/`
  and no `kanban.db`, and creates nothing.
- Output contract: on both paths the script emits exactly one `SWITCHBOARD_PORT=` line and one
  `SWITCHBOARD_MODE=` line, parseable by the skill's shell.
- Workflow guard: assert `.agents/workflows/switchboard.md` no longer contains "open the workspace in
  VS Code" and does contain the launcher invocation — the same style of guard the tooltip and column
  plans use, so the instruction cannot silently regress.
- Mirror guard: `npm run mirror:check` passes after the workflow edit — i.e. the mirror was regenerated,
  not left stale.

## Complexity Audit

### Routine
- A dependency-free Node script under an established `.agents/scripts/` convention.
- A semver parse-and-compare over directory names.
- A markdown rewrite of one workflow section.

### Complex / Risky
- **Failing actionably.** The failure path is the deliverable's whole point: the plan exists because the
  current failure message is useless in the target host. A resolver that exits 1 with "could not find
  switchboard" reproduces the bug in a new voice. It must name every root it tried and every remedy that
  is actually available where the agent is running.
- **Detaching correctly.** `spawn(..., { detached: true, stdio: 'ignore' }).unref()` is three tokens and
  a whole class of bugs — a child that dies with the tool call, or one whose boot failure is invisible
  because stdio went to `/dev/null`. The launch log is the mitigation and it is not optional.
- **Resolution ordering against a moving name.** Step 2 consumes B4's chosen package name. Hardcoding
  `switchboard` anywhere in this script fetches an unrelated third-party library from npm.
- **Editing a generated file's source, not the file.** The obvious edit target is the wrong one and CI is
  what catches it.

## Edge-Case & Dependency Audit
- **Race Conditions:** launching while the extension is still *starting* (port file not yet written) can
  produce two writers. No bind lock exists anywhere in `src/` (verified by grep). This race is owned by
  the sibling attach plan — the launcher inherits whatever guarantee that plan lands with, and must not
  invent a second mechanism. **Check its resolution before implementing step 1.**
- **Security:** the script executes a binary resolved from a filesystem scan of the user's home directory.
  The candidate paths are fixed (`~/.<ide>/extensions/turnzero.switchboard-*/dist/standalone/cli.js`), so
  the surface is a user who already has a hostile file at an exact well-known path inside their own home —
  acceptable, but do not widen the glob. `npx --yes <name>` executes code fetched from the registry;
  that is the accepted premise of B4, not a new exposure here.
- **Side Effects:** a `/switchboard` invocation now starts a background process. The workspace guard is
  what keeps that from happening in an unrelated folder. The launch log accumulates in `.switchboard/`
  (already gitignored via `.switchboard/*`).
- **Dependencies & Conflicts:** shares no source file with B4 or the attach plan — this plan touches
  `.agents/scripts/`, `.agents/workflows/`, `.claude/skills/` (generated) and one guard in
  `bootstrap.ts`. The `bootstrap.ts` schema-version refusal is the only overlap with the attach plan's
  file set; land after it.

## Dependencies

**Hard: `b4-npx-distribution-publish.md`** (`PLAN REVIEWED`). **Land B4 first.** It resolves the naming
blocker and makes a published CLI fetchable, which is what turns change 1 from "scavenge bundles across
IDE install directories" into "invoke the published binary, with scavenging as a fallback for
un-upgraded installs". Landing this plan first means building resolution machinery that B4 largely
obsoletes, and shipping an agent protocol whose happy path is a fallback.

**Hard: `standalone-cli-attach-and-lifecycle.md`.** This plan detaches the launched server and reports
`SWITCHBOARD_MODE=attached`; neither is possible until the CLI attaches instead of exiting 1, and
detaching without `switchboard stop` ships a board nothing can shut down. The skill text also references
`switchboard stop`, which must exist first.

Also worth knowing, not blocking:

- **`extract-standalone-npx-04-npx-distribution.md`** (`CODE REVIEWED`) already shipped the launcher
  core — `bin` entry, boot, `/health` gate, token handoff, browser-open.
- **`Standalone: GET /catalog 404s`** (in *Headless Host Correctness*) affects the *quality* of the
  attached session, not attaching. Independent.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) the launcher's *failure* path is the deliverable — an unhelpful exit
message reproduces the exact bug in a new voice, so it must enumerate the roots tried and only remedies
available in the host the agent is actually running in, never "open VS Code"; (2) resolution by
enumerating install roots is provably insufficient — Windsurf 1.7.3 on this machine has no
`dist/standalone/` at all — and the bundle is chunk-split, so the resolver must skip bundle-less
candidates, sort by parsed semver rather than string, and execute in place rather than copy; (3) the
skill file the plan targets is a **generated mirror** of `.agents/workflows/switchboard.md`, guarded by
`npm run mirror:check` in CI, so editing it directly both fails CI and gets overwritten. Mitigations:
a fixture-driven resolution test built on the real Windsurf/Devin shape, a workspace guard mirroring
`_filterPortFileEligibleRoots` so `/switchboard` never scaffolds a stray `.switchboard/`, and a mirror
regeneration step in the same change.

## Verification Plan

> Per session directives: no project compilation step and no automated test run is part of this
> verification plan. The checks below are behavioural.

1. **Reproduce.** With no server running, in a workspace with `.switchboard/`, run the current §1 entry
   protocol: port file missing → the protocol's only outcome is "open VS Code". Confirm
   `which switchboard` is empty and `npx switchboard` does not resolve to this package.
2. **Launch from cold.** Nothing running: `node .agents/scripts/switchboard-up.js --workspace "$ROOT"`
   → resolves a launcher, boots, prints `SWITCHBOARD_MODE=launched` and a port, `/health` answers with
   `$ROOT` in `roots`. Confirm the server **survives** the invoking shell exiting.
3. **Attach to a live extension.** With VS Code/Devin running the extension, run the same command →
   `SWITCHBOARD_MODE=attached`, the port equals the extension's, and **no second process** appears
   (`lsof -i` shows one listener; the DB has one writer). This is the single-writer regression test.
4. **Attach to a live standalone.** Launch standalone, run the script again → attaches to itself, does
   not double-bind, exits 0.
5. **Resolution from a host with no extension.** Run the script from Antigravity — which has no extension
   host, so nothing local supplies a launcher — and confirm it still finds the published CLI, or failing
   that the 1.7.13 Devin bundle by filesystem scan. Assert it **skips** the Windsurf 1.7.3 root (no
   `dist/standalone/`) rather than selecting and failing on it, and ignores `~/.antigravity/extensions/`
   residue rather than treating 1.5.9 as a candidate. Then make no bundle resolvable and confirm the
   failure message names what was tried and says neither "open VS Code" nor "install the extension in
   this IDE".
6. **Stale port file.** Write a bogus port into `api-server-port.txt`, kill nothing, run the script →
   treats it as a miss and launches; the file ends up holding the new port.
7. **Version skew.** Force-resolve the older CLI against a DB migrated by a newer build → warning
   emitted; if the DB's schema version exceeds the CLI's known maximum, it refuses with a clear message
   instead of attempting a migration.
8. **`/switchboard` end-to-end in Antigravity — the acceptance test.** Close every IDE running the
   extension, open Antigravity, type `/switchboard`. The agent must launch standalone, print the snapshot,
   say it *started* standalone, and never mention opening or installing anything in another editor. This
   is the normal path in Antigravity, not an edge case. Then, with a *different* IDE's extension running
   against the same workspace, repeat from Antigravity and confirm it *attaches* to that server (says
   *live*, not *started*) and starts no second writer.
9. **Not a scaffolder.** Run `/switchboard` in a directory with no `.switchboard/` → refuses rather than
   creating one. Confirm no `.switchboard/` appears afterwards.
10. **Mirror integrity.** `npm run mirror:check` passes after the workflow edit, and
    `.claude/skills/switchboard/SKILL.md` contains the launcher invocation — proving the regeneration ran
    rather than the source drifting alone.
11. **Propagation reality-check.** In a workspace scaffolded before this change, open it once in an
    IDE running the new extension build and confirm the refreshed workflow + skill land (the content-hash
    refresh at `extension.ts:337-414` does this automatically). In an Antigravity-only workspace, confirm
    the copy is whatever the last refreshing host left — and that this is stated in the release note
    rather than silently assumed.
12. `npm run lint` green.

## Uncertain Assumptions

The following are external and cannot be settled by reading this repository. A research pass run
2026-08-04 covered the sibling plans' npm-packaging and file-permission questions and **did not address
either item below** — both remain genuinely open:

- **That detaching survives the target agent harness.** Some harnesses reap the whole process group on
  tool-call exit, which would kill a detached child regardless of `detached: true` / `.unref()`. This is a
  property of Antigravity's tool-execution model, not of this repo, and no amount of documentation
  research substitutes for running the experiment in the host. If it does not hold, the entire
  launch-and-detach design needs a different vehicle, so **verify it empirically before implementing
  change 1** — spawn a detached `sleep 60` from an Antigravity tool call and check whether it is still
  alive afterwards. That five-minute test gates the plan's central mechanism.
- **That Antigravity 2 offers no extension mechanism at all** (previously confirmed against
  antigravity.google: it extends via *skills*, and its product material describes no extension
  marketplace). Worth a re-check because it is load-bearing for the "launch is the normal path there"
  framing — though if a future build gains one, the design does not break: resolution already scans roots
  generically.

Code-answerable items are recorded as code-investigation TODOs rather than research: **the
extension-still-starting bind race** (resolved, or not, by the sibling attach plan — read its outcome
rather than re-deriving) and **whether anything consumes `/health` positionally** before the sibling plan
adds a `host` field.

## Out of Scope

- Publishing to npm or renaming the package. That is `b4-npx-distribution-publish.md`'s deliverable and a
  hard dependency of this plan, not an exclusion — this plan *consumes* the published name rather than
  choosing it.
- Attach semantics, session minting, the pid file, `switchboard stop`, and the SIGHUP fix. All moved to
  `standalone-cli-attach-and-lifecycle.md` and taken here as a hard dependency (see the Goal callout).
- A skill-propagation mechanism. Already delivered at HEAD by the content-hash refresh in
  `extension.ts:325-415` and `:4088-4110`; see the root-cause-3 callout. Only the release-note caveats
  remain.
- Removing the single-writer constraint or allowing two servers per workspace.
- Making the extension defer to a running standalone (the reverse direction).
- Auto-installing or auto-updating an extension bundle when none is found.
- Any change to how the board, panels or dispatch behave once a server is up — this plan only changes how
  one comes to exist.
- Auto-stopping the server on idle, on workspace close, or after N minutes. A launched server outlives
  the session **deliberately** — that is what makes a second `/switchboard` an attach.

## Recommendation
Complexity 5 → **Send to Coder.** Once attach and `stop` exist, what is left here is a dependency-free
resolution script, a semver comparison, and a workflow rewrite — but two details decide whether it works:
resolve by *parsed semver over roots that actually contain a `cli.js`* (Windsurf 1.7.3 on this machine
proves enumeration alone is not enough) and edit `.agents/workflows/switchboard.md`, not the generated
`.claude` mirror. The discriminating check is verification step 8: `/switchboard` in Antigravity, with
every extension host closed, producing a working board and never naming another editor.

**Stage Complete:** PLAN REVIEWED
