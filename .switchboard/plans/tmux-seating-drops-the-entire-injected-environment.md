# tmux Seating Drops the Entire Injected Environment

## Goal

An agent runs with the environment the host gave its seat, whether that seat is a plain pty or a
tmux window. The host's injection is either present or the seat fails loudly — never silently
empty.

### Measured, 2026-09-14

Two live seats, reading the agent process's own `/proc/<pid>/environ`:

| seat | `SWITCHBOARD_API_TOKEN` | `SWITCHBOARD_AGENT_INSTANCE_ID` | `SWITCHBOARD_TERMINAL` |
| :--- | :---: | :---: | :---: |
| `Coding-coder-2` | **0** | **0** | **0** |
| `Coding-intern` | **0** | **0** | **0** |

None of the three arrive. The tmux server's own environment carries no `SWITCHBOARD` variable
either.

### Why

`cmd/switchboard-pty-host/main.go:287` injects the seat's identity into the pty it creates:

```go
env = append(env, "SWITCHBOARD_TERMINAL="+name, "SWITCHBOARD_AGENT_INSTANCE_ID="+agentID)
if token := strField(payload, "apiToken"); token != "" {
    env = append(env, "SWITCHBOARD_API_TOKEN="+token)
}
```

That is correct, and under a plain pty it works. Under tmux seating it reaches the wrong process.

The seat's pty runs the seating chain, which ends `exec tmux -u attach -t <view>`. So the process
holding the injected environment is the **tmux client**. The agent runs somewhere else entirely —
in a window the **tmux server** created:

```
goPtyFleetProjection.ts:383  tmux new-session -d -P -F '#{window_id}' -s ${session} -n ${win} ${inner}
goPtyFleetProjection.ts:385  tmux new-window  -d -P -F '#{window_id}' -t ${session} -n ${win} ${inner}
```

A process spawned by the tmux server inherits the **server's** environment — the environment that
existed when the server first started, which on this host is an operator's `tmux -u new -A -s main`
from the previous day. An attaching client does not change it. tmux forwards only the fixed
`update-environment` allowlist (`DISPLAY`, `SSH_AUTH_SOCK` and similar); a custom variable is not
on it and never will be.

So the injection lands on a client that does nothing with it, and the agent never sees it.

### What it costs

**The terminal name — already observed.** `Coding-coder-2` probed for its own identity:

```
echo "$SWITCHBOARD_TERMINAL $HOSTNAME"; hostname
```

got an empty string, fell back to `$HOSTNAME`, and ran `switchboard done --from patrickremotedev`.
That names no seat, so nothing resolved, nothing cleared, and the lead never learned the subtask
had finished. The agent did the right thing with the only value available to it — an empty
variable is indistinguishable from an unset one, and it silently substituted a plausible wrong
answer.

**The API token — latent and worse.** `SWITCHBOARD_API_TOKEN` is absent from every seated agent.
This is invisible today only because `_checkAuth` returns true when no durable token is configured,
and separately trusts the tailnet listener. Configure a token and every tmux-seated agent begins
401-ing on every board call at once, with a cause that will read as an auth defect rather than an
environment one.

This also explains why the agent-auth plans keep landing awkwardly — *Out-of-process agents cannot
authenticate to the standalone API* and *No shipped Switchboard client sends an Authorization
header* both assume an injection path that does not reach a seated agent.

**The instance id.** `SWITCHBOARD_AGENT_INSTANCE_ID` is gone too, so anything keying attribution
off it is keying off nothing.

### Non-goals

- **Making agents read their own identity.** Nothing here argues an agent should quote its own
  name back to the board; the host resolves the caller. This plan is about the host's own
  injection contract being honoured, and the token in particular, which the agent must hold.
- **`update-environment`.** Adding variables to tmux's allowlist affects new windows in a session
  that the operator also owns, and is a global tmux setting reaching beyond Switchboard's seats.
- **Abandoning tmux seating.** Separate decision.

## Metadata

- **Complexity:** 3
- **Tags:** pty-host, tmux, environment, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Set the environment on the window, not on the client

`tmux new-session` and `tmux new-window` both take `-e KEY=VALUE`, repeatable, which sets the
environment for the pane being created rather than for the session or the server. The seating
chain builds both commands and passes neither.

Pass every variable the host injects, on both branches, so a seated agent's environment matches a
plain-pty agent's exactly. Values are shell-quoted at construction — a token is opaque and must
survive the chain verbatim.

### 2. The reuse branch has to carry it too

The chain's third branch reuses an existing window and runs neither command, so a re-seated agent
keeps whatever environment the window was born with — including a token that has since rotated.
Either the window is recreated when the injected set has changed, or the reuse path refuses and
says why. A silently stale token is the same defect one layer along.

### 3. A seat whose environment did not arrive fails loudly

The agent cannot tell empty from unset, so the host must. After seating, verify the variables are
present in the window and surface a seat that came up without them, rather than leaving an agent
to substitute `$HOSTNAME` and report to nobody.

## Verification Plan

### Automated Tests

1. **New** `src/test/seat-environment-contract.test.js`, wired as
   `test:contract:seat-environment` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Spawns a
   tmux-seated seat and a plain-pty seat against a real host, reads the agent process's own
   `/proc/<pid>/environ` for both, and asserts the injected set is identical. Reading the agent's
   environ rather than the pty's is the whole point: the pty has always had these values.
2. Assert both creation branches carry `-e` for every injected variable, and that a reuse whose
   injected set differs does not silently keep the old one.
3. Assert a seat that comes up without the variables is reported, not left running.

### Goal Invariants

- A tmux-seated agent and a plain-pty agent have the same Switchboard environment.
- A seated agent holds a usable `SWITCHBOARD_API_TOKEN`, verified by making an authenticated call
  against a host with a durable token configured — the case that is silently broken today.
- No agent ever substitutes a hostname, a guess, or an empty string for a value the host was
  supposed to provide.
