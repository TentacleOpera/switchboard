---
description: 'Command Switchboard From a Phone'
---

# Command Switchboard From a Phone

## Goal

Make five away-from-desk functions — dispatch a plan, build a mission, start a mission, write
and send a memo, and message a terminal and get the answer back — operable from a phone,
without weakening the loopback posture that keeps the board safe. The functions themselves
mostly exist already as HTTP routes on the board's own port; what is missing is a surface
narrow enough to drive them with a thumb, a return path for the one function that is currently
one-way, and a way for a phone to reach the host at all. Each of those is a separate,
independently shippable piece of work, which is why this is a feature rather than one plan.

## How the Subtasks Achieve This

- **A phone-shaped command route, because the sidebar already solved the layout and the board never serves it**: Adds a `/command` route to the standalone board's panel manifest, built in the idiom the VS Code sidebar already proved works at phone width — single column, tap-only, no drag-and-drop. This is the surface the other two subtasks exist to feed and to reach. It ships four of the five functions immediately, since `POST /kanban/dispatch`, the `/kanban/mission/*` routes, `/mission-control/start` + `/confirm`, and `/memo` are all existing endpoints on the port the board is already served from. Its control set is an explicit allowlist rather than a subtraction from the sidebar, which is what keeps the PAT entry, repo scaffolding and shell surfaces off a device that leaves the house.
- **A message sent to a terminal has no return path, so the one function a phone most needs is one-way**: Supplies the fifth function. `POST /terminals/relay` already delivers a message into a live terminal without resetting it, but returns only an ack — and terminal output has no HTTP path at all, only the `/ws/terminal` WebSocket. This subtask builds a durable, collect-later return path so the operator can ask a question, pocket the phone, and find the answer waiting, which is the only shape that survives a mobile connection. It reuses the file-inbox pattern the codebase already uses for agent-initiated reporting rather than inventing a transport.
- **A phone on the tailnet has nothing to connect to, and the docs promise a recipe that should not ship**: Makes the command route reachable. The board binds `127.0.0.1` unconditionally, so a phone on the tailnet gets connection refused — the Host-header guard never even runs. This subtask verifies `tailscale serve` as a first-party terminator, adds a configurable Host allowlist only if that verification proves one is needed, and restricts what the tailnet can reach to the command route alone. It also retires the contradiction currently shipped in `docs/REMOTE_ACCESS.md`, which promises a verified Host-rewrite proxy recipe that the project's own review pass concluded dismantles the protection it documents.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

There is a hard ordering constraint through all three.

1. **The command route goes first.** It is the only subtask that delivers value on its own —
   four of the five functions work over an SSH tunnel from a laptop browser the day it lands,
   and it is testable at 390px with no new access path at all.
2. **The answer-back plan is a soft dependency of the route**, not a blocker. The route ships
   the send half of "message a terminal" and gains the return half when this lands. Building
   it first would mean building a return path with no surface to collect from.
3. **The tailnet access plan must land last.** It is a hard prerequisite in reverse: its
   central security decision — expose only the command route, not the whole board — has no
   referent until that route exists. Landing it first would mean exposing a PTY-spawning,
   git-driving board to the tailnet, which is precisely the trade the decision exists to
   avoid.

The two guard-related subtasks are independent of each other and both are exposure-neutral
except where the third explicitly spends guard 2's protective effect against tailnet peers,
which is documented as a decision rather than a side effect.
