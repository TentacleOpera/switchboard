# Mission Control Reads Its Protocols From a Directory Nothing Writes To

## Goal

Make Mission Control able to start. Today its kickoff builder looks for its protocols on a path the
protocol system never writes for those names, so on every machine it launches a terminal and tells
the agent its own instructions are missing.

### Problem analysis

**Reported as:** *"there were meant to be mission control skills and protocols."* There were, and
they are seeded. The reader looks in the wrong place.

**They are present in the control plane.** From the live board DB:

```
control_plane by kind:   protocol 33, skill 17, persona 8, script 6, workflow 4, doc 3, rule 3

switchboard-mission-control            materialize
switchboard-mission-control-external   materialize
switchboard-mission-control-http       materialize
switchboard-mission-control-internal   materialize
```

All four are seeded and all four are `delivery=materialize` — meant to become files.

**But `materialize` writes to a content-hash cache, not to `.agents/protocols/`.**
`ProtocolService.ts:110-118`:

```js
const cacheDir = stateFile("cache", "protocols", contentHash);
materializedPath = path.join(cacheDir, "SKILL.md");
// -> ~/.switchboard/cache/protocols/<contentHash>/SKILL.md
```

`.agents/protocols/<name>/SKILL.md` is populated for exactly **two hardcoded names**, checked ahead
of everything else as "committed survivor files" (`ProtocolService.ts:88`):

```js
if (workspaceRoot && (name === "improve-plan" || name === "improve-feature")) {
```

Which is why `.agents/protocols/` holds those two and nothing else — 2 of 31 bundled protocols —
and why both of them are `delivery=inline`, the mode that does not need a file at all. The
directory's contents are an artefact of a two-name special case, not of installation.

**And the Mission Control kickoff builder reads exactly that directory.**
`TaskViewerProvider.ts:12732-12736`:

```js
const sharedLogicPath = path.join(root, '.agents', 'protocols', 'switchboard-mission-control', 'SKILL.md');
const runsheetName = deliveryMode === 'self' ? 'switchboard-mission-control-external' : 'switchboard-mission-control-internal';
const runsheetPath = path.join(root, '.agents', 'protocols', runsheetName, 'SKILL.md');
…
await fs.promises.access(sharedLogicPath);
await fs.promises.access(runsheetPath);
```

It never calls `ProtocolService.resolveProtocol`. So the `access` calls throw, and the catch
(`:12810`) returns:

```js
return { mode: 'no-persona', prompt: `You are Switchboard Mission Control. Mission Control workflow is incomplete: the shared logic or required runtime runsheet is m…` };
```

**So starting Mission Control launches a terminal, boots the CLI, and injects a prompt telling the
agent its instructions are missing.** Not on this box specifically — on any box, since nothing
writes those two paths for those names. Confirmed live: the materialize cache holds 3 hash
directories and none contains a mission-control body, so these protocols have never been resolved
at all.

**This is the root cause of everything downstream in this thread.**

- Mission Control cannot start → no `.switchboard/mission-control/session.md` → `armed` is never
  true.
- The operator's *"I haven't even tested the controller that much"* is not under-use; it is a
  feature that cannot run.
- The host's turn-end mirror wrote **190 reports** into `mission-control/reports/` for a reader that
  could not exist in any configuration
  (`the-host-mirrors-every-turn-end-into-an-inbox-with-no-reader-and-no-listener`).
- 78 KB of prompt text (41% of all bundled protocol text) has never been delivered to anything.

**The failure is silent by construction.** A bare `catch` around two `fs.access` calls turns a
wiring defect into a plausible-looking runtime message. The agent is told the workflow is
incomplete, which reads like a setup problem the operator should fix, so the actual cause — a
hardcoded path — never surfaces.

## Metadata

**Complexity:** 2
**Tags:** bugfix, mission-control, protocols, both-hosts
**Dependencies:** blocks
`the-host-mirrors-every-turn-end-into-an-inbox-with-no-reader-and-no-listener` — decide this first,
since whether the mirror has a possible reader depends on Mission Control being able to start.

## User Review Required

**One decision, and it is the operator's:** is Mission Control wanted at all? It has never run, so
nothing depends on it today.

- **Fix it** — changes 1 to 4 below. Small.
- **Delete it** — then the four protocols, the 78 KB of prompt text, the kickoff builder, the
  turn-end mirror, the reports directory and the `missionControlArmed` state all go together, and
  the sibling plan collapses into that.

Do not leave it as-is. A feature that launches a terminal to tell an agent it has no instructions
is worse than either outcome.

## Proposed Changes

### 1. Resolve protocols through the protocol system

- Replace both hardcoded `.agents/protocols/<name>/SKILL.md` paths with
  `ProtocolService.resolveProtocol(name, root, db)`, and use the returned `body` for an `inline`
  result or `path` for a `materialize` one.
- That is the seam that already knows about the control plane, workspace overrides
  (`entry.overrideBody ?? entry.workspaceOverride`) and the materialize cache. The kickoff builder
  currently bypasses all three, so a workspace override of a Mission Control protocol is silently
  ignored even where the files do exist.

### 2. Fail loudly instead of injecting an apology

- If either protocol cannot resolve, do not build a prompt and do not launch a terminal. Return the
  failure to the caller (`startMissionControlFromKanban`) and surface it as an error naming the
  protocol that failed to resolve.
- The `no-persona` mode exists to describe a real state — a workspace that deliberately has no
  persona. It must not double as the reporting channel for a resolution bug.

### 3. Settle the two-name special case

- `ProtocolService.ts:88` hardcodes `improve-plan` and `improve-feature`. Either the
  committed-survivor convention is general — in which case it needs a rule, not two names — or
  those two should be resolved like everything else and the branch deleted.
- Both are `delivery=inline`, so the on-disk check is answering a question their delivery mode says
  should never be asked. Establish which is wrong before touching it.

### 4. Contract test

- Assert that `buildMissionControlKickoffPrompt` returns a real persona in a workspace with a seeded
  control plane and an empty `.agents/protocols/`. That is the exact condition every machine is in,
  and it is the state that would have failed from the day the path was hardcoded.
- Assert it does **not** return `mode: 'no-persona'` when the protocols are resolvable.

## Verification Plan

- With `.agents/protocols/` empty and the control plane seeded, starting Mission Control produces a
  kickoff prompt containing the runsheet and shared-logic text — not the "workflow is incomplete"
  string.
- `deliveryMode: 'self'` selects the external runsheet and `'host'` the internal one, both resolving.
- With a protocol deliberately removed from the control plane, the start fails with an error naming
  it, and no terminal is launched.
- A workspace override of `switchboard-mission-control` reaches the prompt.
- Both hosts behave identically — the extension path and `startMissionControlFromKanban`.
- After a successful start, `.switchboard/mission-control/session.md` exists, which is what makes
  the `armed` predicate in the sibling plan meaningful.

## Outstanding Questions

- How many other callers read `.agents/protocols/<name>/SKILL.md` directly instead of resolving?
  This one was found by accident. A grep for that path shape across `src/` belongs in change 1,
  since any other caller has the same bug and the same silent failure.
