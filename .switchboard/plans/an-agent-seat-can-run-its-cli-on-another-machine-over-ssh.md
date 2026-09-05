# An Agent Seat Can Run Its CLI on Another Machine, Over SSH

kanbanColumn: CREATED

## Goal

A per-agent host setting in the Agents tab. When it is set, that seat's CLI runs on the named machine over SSH instead of locally. The PTY, the board and the database stay where they are.

### Problem analysis

**The operator wants the board on a low-power always-on machine and the CLI work on a bigger one.** A Raspberry Pi cabled to the modem serves the board well — measured 0.28 ms to the tower over the direct link, against 48 ms and 26 ms jitter over wifi — but it is not where compilation and repo-wide work belong. The tower has the cores and the checkout, and can be off when nothing needs it.

**Nothing in the config expresses this.** `agents.startupCommands` holds a per-role command — `lead: claude`, `coder: agy`, `planner: devin --permission-mode bypass` — and a repo-wide search finds no host, user or remote field anywhere in agent config. The command is *"an arbitrary shell line the host executes in the user's tree"* (`ptyHost.ts:114-120`), typed into the seat's shell via `sendText`. So an SSH invocation already works if hand-written into the command; what is missing is a way to say it that is not a hand-written string.

**Why this is small.** Nothing about the architecture moves. The PTY still runs on the board host, the database is still local to it, only one host is live, and no shared store, sync lease or tier split is needed — those exist for two machines contending over one board, which this is not. The only thing that changes is where the process at the far end of the terminal lives.

**And it avoids the pty defect class on the far side.** A seat reached over SSH is still a terminal locally, so readiness and clear semantics still apply — but the remote CLI's own restarts, session boundaries and paste handling are the same as they are today. This does not make those problems worse; it just does not solve them.

## Metadata

- **Complexity:** 4
- **Tags:** agents, config, remote, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. A host field per agent in the Agents tab

Alongside the existing startup command: a target the seat runs on. Empty means local, which is every seat today and stays the default.

**A structured field, not a command prefix.** Let the operator name a host (and where needed a user, port and remote working directory); Switchboard composes the SSH invocation. A free-text prefix box would be quicker to build and would be a command-injection surface, a quoting minefield, and impossible to validate.

### 2. The remote working directory is explicit

The repository path on the target need not match the local one. The composed command changes directory before launching the CLI, using a value the operator sets rather than an assumption that both machines are laid out identically.

Default it to the same path as the local workspace, since that is the common case, but make it visible and editable — a silently assumed path that happens to exist on the target is the worst outcome.

### 3. An unreachable host fails loudly

If SSH cannot connect, the seat must report that and stop. It must not fall back to running the CLI locally.

A silent local fallback would run the agent on the wrong machine, against the wrong checkout, with everything appearing to work — the exact class of quiet wrong answer the repository's fallback rule exists to prevent. Where the seat is running is a fact the board must be able to state, not infer.

### 4. Say which machine a seat is on

The seat's identity now includes its host. Show it where seats are listed, so an operator looking at the fleet can tell local from remote without opening a terminal.

## Edge-Case & Dependency Audit

1. **CLI family detection will not classify a wrapped command.** A seat's family is derived once at spawn and frozen (`d8f86774`), and `ssh -tt … claude` is unlikely to read as Claude. Per the repository's own rule an unrecognised family must take the **longest** readiness ceiling, so the failure direction is slow dispatch rather than a dropped prompt — but confirm that is what happens rather than assuming it.
2. **Plan paths must resolve on the target.** Dispatch hands an agent an absolute path to a plan file that lives with the board. On a remote seat that path resolves to whatever is at the same location on the target — possibly a stale copy, possibly nothing, and neither errors. Decide how the plan reaches the agent: a mount of the plans directory, a shared checkout, or the dispatch carrying the plan body. **This is the part most likely to be discovered late and the reason the feature is not complete without it.**
3. **Authentication is the operator's.** Key-based SSH, configured outside Switchboard. Do not build a credential manager, do not prompt for passwords, and fail with a clear message when the key is not accepted.
4. **The remote CLI holds the agent's credentials**, not the board host. Worth stating in the setting's description so it is a deliberate choice.
5. **Both hosts** compose startup commands and must produce the same invocation.
6. **Waking the target is out of scope**, but adjacent: an always-on board host can wake a sleeping worker over Wake-on-LAN. Worth its own card if wanted; it is not needed for this to work.

## Verification Plan

1. A seat with a host set runs its CLI on that machine; the PTY, board and database stay local.
2. A seat with no host set behaves exactly as it does today.
3. An unreachable host reports the failure and does not start a local CLI.
4. A remote working directory different from the local one is honoured.
5. Prompt delivery, clear and completion reporting work against a remote seat.
6. The fleet shows which machine each seat is on.
7. A plan dispatched to a remote seat is readable by that seat, per the change decided in audit item 2.
8. Both hosts compose the same invocation for the same settings.
