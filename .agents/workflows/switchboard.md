---
description: Start the Switchboard board and the orchestration agent — a two-step launcher
---

# Skill: Switchboard Launcher

`/switchboard` does two things:

1. **Start `npx switchboard` if it is not already running.**
2. **Start the orchestration agent.**

Everything else — browsing the board, moving cards, managing features, improving
plans, running passes — belongs to the **board** (open it in a browser) and the
**skills** that own each concern. This skill is a launcher, not a console.

---

## Step 1 — ensure a board is running

A port file is not liveness. The CLI checks `GET /health` and treats only a 200 as "a board is running". If a board is running, use it. Otherwise, launch `npx switchboard`.

```bash
if switchboard api GET /health >/dev/null 2>&1; then
  echo "Switchboard is already running (200). Using the existing board."
else
  echo "No board answering. Starting npx switchboard..."
  npx switchboard &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if switchboard api GET /health >/dev/null 2>&1; then
      echo "Switchboard is up (200)."
      break
    fi
  done
fi
```

- **Health check passes (200)** → use the existing board. A running VS Code extension or standalone host already serves it; a second instance must not be started.
- **Health check fails** → start `npx switchboard`.

---

## Step 2 — become the orchestrator

**You are the orchestrator. Not a terminal you start — this one.** Adopt the seat and
run the pre-flight here, in this conversation.

```bash
# SWITCHBOARD_TERMINAL is set for Switchboard-managed fleet seats. Unset elsewhere —
# send it empty rather than guessing a name.
switchboard api POST /mission-control/adopt "{\"terminalName\": \"${SWITCHBOARD_TERMINAL:-}\"}"
```

The response carries `prompt` — the pre-flight instruction. **Follow it in this
session**: read `.agents/protocols/switchboard-mission-control/SKILL.md`, run the pre-flight,
report what you find, propose a goal, and wait for the user to answer *here*.

`POST /mission-control/adopt` **does not arm** and seats no terminal. On the user's
confirmation, write `.switchboard/orchestrator/session.md` and call
`POST /orchestration/confirm` — that is the only call that arms.

If the response carries a `note`, relay it in one line: it means live turn-end notices
will arrive in `.switchboard/orchestrator/reports/` rather than as prompts in this
terminal. Read that directory on each pass.

Never call `POST /orchestration/start` from here — that door creates a *separate*
Orchestrator terminal, which is the opposite of what `/switchboard` is for.

## Messaging Seats

When asked to send a question, instruction, or relayed message to a team lead or seat:
Call `POST /terminals/verb/ptySendPrompt` with `"kind": "message"`. Relaying a message to a lead is a message, not a dispatch — setting `"kind": "message"` suppresses the standing-orders block, seat directive block, and dispatch directives, delivering a lean message.

```bash
# Send a question or message to a lead/seat (message kind delivers text alone)
switchboard api POST /terminals/verb/ptySendPrompt "{\"name\": \"<seat>\", \"data\": \"<message>\", \"clearBeforePrompt\": false, \"kind\": \"message\"}"
```

## Clearing Terminals

When asked to clear a terminal or team terminals (e.g. "clear the team's terminals"):
Call `POST /terminals/clear`. Do NOT send `"/clear"` via `ptySendPrompt` (bare slash commands cannot be sent as prompt data and will be rejected).

```bash
# Clear a team's terminals (excludes caller and lead automatically; defers busy seats)
switchboard api POST /terminals/clear "{\"team\": \"<head terminal name or teamId>\", \"from\": \"${SWITCHBOARD_TERMINAL:-console}\"}"

# Clear a single seat
switchboard api POST /terminals/clear "{\"name\": \"<seat>\", \"from\": \"${SWITCHBOARD_TERMINAL:-console}\"}"
```

---

## Everything else

- **Board** — open the browser board. It is the console.
- **HTTP surface** — the `switchboard-orchestration` skill documents every endpoint,
  verb, and payload field. Read it for the complete contract.
- **Behavior contracts** — the `switchboard-contracts` skill answers how the system
  behaves (cards move on coding start, completion = plan-file mtime advance, etc.).
- **Planning, features, plan improvement, card moves** — each has a skill that owns it.

