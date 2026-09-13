# A Seat Reports Done and Nothing Else

## Goal

`switchboard done`. No arguments. A finished seat signals that it is finished; it assembles
nothing, quotes nothing, and states no fact the host already holds.

### The bug

The host injects the seat's identity into the seat's own environment when it creates the pty
(`cmd/switchboard-pty-host/main.go:287`):

```go
env = append(env, "SWITCHBOARD_TERMINAL="+name, "SWITCHBOARD_AGENT_INSTANCE_ID="+agentID)
```

`grep SWITCHBOARD_TERMINAL src/standalone/cli.ts` returns **nothing**. The CLI never reads it, and
every completion instruction therefore makes the agent type it back:

```
switchboard done --from "<your terminal name>"
POST /kanban/task/complete {"from":"…","planId":"…","workspaceRoot":"…"}
```

Three fields, all of them things the host put there or already knows:

| Field | Where the host already has it |
| :--- | :--- |
| `from` | `SWITCHBOARD_TERMINAL`, injected into this seat at create |
| `planId` | the dispatch record — `dispatched_terminal` names this seat |
| `workspaceRoot` | the host's own root; the seat cannot be in another one |

### Why it matters more than it looks

Every field an agent must supply is a field it can get wrong, and a decision it has to stop and
make. The measured cost, from `Coding-intern`'s session log on 2026-09-13: the seat finished its
work correctly, then spent its remaining turns working out what to send — reading
`LocalApiServer.ts:4568-4657` and `:3690-3759`, grepping `./src/standalone` for
`done|--from|task/complete|queue/done`, assembling a 3389-byte body into a temp file, and asking
the operator which call was correct. It ended at 139k/200k context with the card released and not
completed.

None of that was about the work. It was about the shape of the report.

This is the same rule as no summaries, applied to the fields instead of the prose: **the
completion post carries nothing the agent has to assemble.** A summary is the obvious case. A
terminal name the host injected is the same mistake wearing a smaller hat.

### Non-goals

- **Removing the post.** Completion is asserted, never inferred from board position. The post
  stays; only its payload goes.
- **Guessing an identity.** If `SWITCHBOARD_TERMINAL` is absent the call fails loudly and says so
  — a completion attributed to the wrong seat clears the wrong terminal, and CLAUDE.md's rule on
  identity reads applies in full.
- **Reintroducing `outcome`.** No summaries, in any field.

## Metadata

- **Complexity:** 3
- **Tags:** cli, teams, completion, ux

## User Review Required

None.

## Proposed Changes

### 1. `switchboard done` takes no arguments

`--from` defaults to `SWITCHBOARD_TERMINAL`. When the variable is set, the flag is not needed and
not documented. When it is absent — a seat the host did not create — the command fails naming the
variable, rather than asking the operator to supply a name it cannot verify.

`--from` stays accepted for a human driving the CLI by hand from outside a seat.

### 2. The card resolves from the seat, not from the agent

The host resolves the planId from the dispatch record whose `dispatched_terminal` is the calling
seat. An agent never quotes a plan id back, which also removes the failure where it quotes the
feature's id instead of the subtask's — a mistake the head prompt currently has to warn about in
prose.

Where a seat genuinely holds more than one dispatched card, the call reports that and names them
rather than picking one.

### 3. `workspaceRoot` stops being an agent-supplied field

The host knows its own root. The field is dropped from every agent-facing instruction.

### 4. Every instruction becomes the bare command

The five payload templates and the 409 body at `LocalApiServer.ts:3740` reduce to
`switchboard done`. The 409's remedy text names the two doors — finished, or release — and no
fields at all.

### 5. The HTTP path matches

`POST /kanban/task/complete` accepts an empty body from a seat, resolving identity the same way.
An agent that cannot run the CLI still has one call with nothing to assemble.

## Verification Plan

### Automated Tests

1. **New** `src/test/bare-completion-contract.test.js`, wired as `test:contract:bare-completion`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not
   a gate. Asserts: `done` with no arguments completes the calling seat's card; with
   `SWITCHBOARD_TERMINAL` unset it fails naming the variable and completes nothing; an explicit
   `--from` still works.
2. Assert no agent-facing string — payload template, error body, skill file or prompt directive —
   instructs a seat to supply `from`, `planId` or `workspaceRoot`. This is the assertion that
   keeps the fields from creeping back one instruction at a time, which is how `outcome` survived
   five corrections and a contract test.
3. Assert a seat holding two dispatched cards is told so, and neither is completed.

### Goal Invariants

- A finished seat completes with `switchboard done` and no arguments.
- No agent reads source, or asks the operator, to discover what to send.
- A seat whose identity cannot be resolved completes nothing and says why.
- No completion instruction anywhere names a field.
