# A cloud agent fills the template and pushes it — the authoring side of board control

## Goal

Give a remote agent the skill and the template it needs to drive the board from a
cloud session: read the published board, decide what should change, write one
instruction file, push it to the control branch, and read the receipt to confirm
what happened.

### Problem Analysis

**Without this, the channel exists and nobody can use it.** The two sibling plans
build the format and the watcher on the *receiving* side. The sending side is an
agent in a cloud VM with a repo checkout, no extension, and no localhost access —
and no idea that any of this exists. This is the same gap the star endpoint had:
built, reachable, undocumented, therefore unused.

**A cloud agent cannot check its own work through the usual channel.** On a local
machine an agent reads the board over HTTP after acting. Here the write is
asynchronous — pushed to a branch, applied whenever the user's machine next polls,
which may be minutes away or never if the extension is closed. An agent that
treats a successful `git push` as a successful board change will report work it did
not do. The skill's central instruction is therefore about **not** claiming
success: a push means the instruction was filed, nothing more.

**And the agent already has the read side.** The board destination carries
`board.json` with every card's id, topic, column, feature, project, and complexity
(`BoardSnapshotPublisher.ts`, `BoardCardEntry`), plus receipts and `status.json`. A
cloud agent clones it and knows the whole board without the extension running —
which is what it needs to fill `target.planId` correctly instead of guessing a
name.

**One destination, not two.** Instructions, mirror content, receipts and status all
live at whatever `boardStateExport` resolves to — the control-plane repo, the wiki,
or the `switchboard/board` orphan ref. The skill must not invent a second location:
`storage-topology-one-choice-three-stores.md` exists to stop the proliferation of
placements, and `board-state-remote-mirror-channels.md` already rejected a
per-project companion repo in favour of the control plane.

**The agent's only write is filing an instruction.** Everything else at that
destination is written by the machine. An agent that assumes it may write mirror
content or a receipt will fail and report the failure as though its instruction
failed. It did not: filing is the write, reading the receipt is how it learns the
outcome.

### Non-goals

- **The file format and the allowlist** — `board-control-instruction-format-and-executor.md`.
- **Detection, polling, and receipt publishing from the user's machine** —
  `board-state-remote-mirror-channels.md` §3, whose `GitStateProvider` this rides.
- **Where board state is published** — `board-state-remote-mirror-channels.md` and
  `storage-topology-one-choice-three-stores.md`. Never a location this skill
  chooses.
- **A new tool, MCP server, or endpoint.** The agent has git; that is the channel.
- **Writing plans.** Plan files already flow over git on their own path. This is
  for actions on cards that exist.
- **Blind retries.** See the retry rule below.

## Metadata

**Complexity:** 3
**Tags:** docs, feature, cli
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

Blocked on both siblings — this documents their contract. Ship it in the same
release as the poller: a skill describing a channel that is not live yet would have
agents filing instructions nothing will read.

## Proposed Changes

### 1. `.agents/skills/board-control/SKILL.md` — the authoring skill

Sections, in the order an agent needs them:

**When this applies.** You are in a remote session with no
`.switchboard/api-server-port.txt` and no localhost API, and you need to change
board state rather than author a plan. If the API is reachable, use it instead —
it is synchronous and tells you the truth immediately. This channel is strictly
the fallback for having no machine access.

**Read the board first.**

```bash
git clone --depth 1 <boardDestinationUrl> /tmp/board   # or fetch the orphan ref
jq '.cards[] | {plan_id, topic, column}' /tmp/board/board.json
jq '.cards[] | {planId, state, idleSeconds}' /tmp/board/status.json   # if present
```

`status.json` (from `terminal-logs-are-archived-and-status-is-published.md`) is how
you tell whether a card is being worked on right now — `board.json` reports the
column, which only changes at the end of a stage.

Resolve the card to a `plan_id` from this file. **Prefer `planId` over
`planName` always** — the executor refuses an ambiguous name, and a name that
happens to be unique today may not be tomorrow, which turns a working script into
an intermittent one.

**Fill the template.** Copy `template.json` from the skill directory, set `id`,
`target.planId`, flip only the actions you want, and supply their params. Then:

- one instruction per file, named `instructions/<id>.json`;
- **`id` must be unique per intent, and stable per intent.** A fresh id for the
  same intent fires it twice; a reused id for a new intent is silently suppressed
  as a duplicate. Recommend `<date>-<slug>-<nn>`, and state plainly: if you are
  unsure whether your last push landed, **reuse the same id** — duplicate
  suppression is what makes that safe, and a new id is what makes it dangerous.

**File the instruction** in the destination's own clone, never in your working
repo:

```bash
cp instruction.json /tmp/board/instructions/<id>.json
git -C /tmp/board add instructions/<id>.json
git -C /tmp/board commit -m "board control: <id>"
git -C /tmp/board push origin HEAD:<branch>      # the orphan ref, where that is the destination
```

A separate clone is the whole recipe — no worktrees in your own repo, no
force-push. The skill states the rule directly: never `checkout`, `switch`,
`commit`, or push in the repo you are working on, and never add a remote to it.

**A rejected push means the machine pushed mirror content while you were
working** — expected, not an error. Fetch, replay your file onto the new tip, push
again. Do **not** force-push: that destination carries board state and receipts
written by the machine, and under `git-carried-shared-board-state.md` a
non-fast-forward rejection is a lost-write detector the board itself relies on.

**Then read the receipt — do not assume.**

```bash
git -C /tmp/board fetch --depth 1 origin && git -C /tmp/board reset --hard FETCH_HEAD
cat /tmp/board/receipts/<id>.json
```

The receipt is the machine's word about what happened, not yours. Never write one
— a fabricated receipt is worse than no receipt, because the next reader believes
it.

`status` is `applied`, `partial`, `refused`, or `duplicate`. Only `applied` means
every action you asked for happened. Report `partial` and `refused` to the user
with the `results` array verbatim — the error strings name the exact param or
target problem, and paraphrasing them loses the fix.

**If no receipt appears**, the user's machine has not polled yet: the extension may
be closed, or the feature may not be enabled. Say that, and say what you filed.
Never retry with a new id to "make it work" — that is how one requested move
becomes three.

**The honesty rule, stated as its own section** because everything else in the
skill depends on it:

> A successful `git push` means your instruction was filed. It does not mean the
> board changed. Never tell the user a card moved until you have read a receipt
> saying `applied`. If you have not read one, say the instruction is filed and
> waiting.

### 2. `.agents/skills/board-control/template.json`

The blank template, every action present and `false`, with a comment block above
each param naming which action requires it. Shipped as a file so an agent copies
rather than reconstructs a schema from prose — a hand-rebuilt schema is where a
misspelled action key comes from, and a misspelled key is silently ignored.

### 3. Cross-references

- `.agents/skills/switchboard-orchestration/SKILL.md` §16 documents the file-based
  fallback for when HTTP is unavailable. Add board control there as the fallback
  for *actions*, alongside plan files as the fallback for *content*, so an agent
  that reaches for the fallback section finds both halves.
- `.agents/workflows/switchboard-cloud.md` is the cloud planning brake. Add one
  line: in a cloud session, board actions go through board control, and a push is
  not a board change.

### Migration

Documentation and one template file. No code, no state.

## Verification Plan

1. **End to end, as the agent would** — with no extension: read `board.json` from
   the destination clone, file an instruction, then run a `GitStateProvider` poll
   cycle and assert the card moved and the receipt is readable from the same
   destination.
2. **Rejected push is handled, not forced** — simulate the machine pushing mirror
   content mid-flight; assert the documented recovery fetches and replays, and that
   no documented command uses `--force`.
3. **Status is read for status** — assert the skill directs the agent to
   `status.json` rather than inferring progress from a card's column.
4. **The template is valid** — feed the shipped `template.json` to the executor's
   validator unmodified; assert it parses and requests nothing (every action
   `false`). A shipped template that fails validation is the worst possible first
   experience.
5. **Every documented command runs** — execute each snippet against scratch
   repos, including the first-push case where `instructions/` does not yet exist in
   a freshly created empty repo. Snippets that were never run are how a fallback
   path rots.
6. **Working tree safety** — follow the skill's recipe with the agent's own repo
   dirty on a feature branch; assert its branch, index, files, and remote list are
   untouched.
7. **Duplicate advice is correct** — follow the "reuse the id if unsure" path:
   push the same id twice, assert one application and a `duplicate` status.
8. **Refusal is legible** — push an instruction with an ambiguous `planName` and
   assert the receipt names both candidate cards, so the documented "report it
   verbatim" instruction is actually actionable.

### Goal Invariants

- A remote agent can change board state with nothing but a git checkout.
- The card is always identified by id, never by a guessed name.
- An agent never reports a board change it has not seen a receipt for.
- Re-running the documented recovery path cannot double-apply an action.
- The shipped template validates as-is.
