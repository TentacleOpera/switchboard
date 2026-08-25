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

A port file is not liveness. `.switchboard/api-server-port.txt` survives a crashed
extension, and **every workspace's port file holds the same port**, so its presence
proves nothing about *this* workspace. Read the port, call `GET /health`, and treat
**only a 200** as "a board is running".

```bash
ROOT="$PWD"
PORT_FILE="$ROOT/.switchboard/api-server-port.txt"

if [ -f "$PORT_FILE" ]; then
  PORT=$(tr -d '[:space:]' < "$PORT_FILE")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
else
  HEALTH="000"
  PORT=""
fi

if [ "$HEALTH" = "200" ]; then
  echo "Switchboard is already running (port $PORT). Using the existing board."
elif [ -n "$PORT" ]; then
  # curl could not confirm liveness (returned $HEALTH), but a port file
  # exists — the board may be running but unreachable from this sandbox
  # (loopback blocked), or the port file may be stale (board crashed).
  # FAIL SAFE: do NOT spawn a second server. Spawning overwrites the port
  # file and hijacks the active session if the board IS alive. The cost of
  # not spawning when the board is actually dead is recoverable (delete the
  # port file and re-run); the cost of spawning when the board is alive is
  # destructive (session hijack).
  echo "Health check returned $HEALTH for port $PORT, but a port file exists."
  echo "The board may be running but unreachable from this sandbox (loopback blocked),"
  echo "or the port file may be stale (board crashed without cleanup)."
  echo "Using the existing port. If the board is NOT running, delete"
  echo "  $PORT_FILE"
  echo "and re-run /switchboard."
else
  # No port file — no board was ever started (or was cleaned up). Launch.
  echo "No board answering. Starting npx switchboard..."
  npx switchboard &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if [ -f "$PORT_FILE" ]; then
      PORT=$(tr -d '[:space:]' < "$PORT_FILE")
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
      if [ "$HEALTH" = "200" ]; then
        echo "Switchboard is up (port $PORT). Board URL: http://127.0.0.1:$PORT"
        break
      fi
    fi
  done
  if [ "$HEALTH" != "200" ]; then
    echo "Switchboard did not come up within 10s. Check npx output above."
  fi
fi
```

- **No file** → launch (no board was ever started, or was cleaned up on shutdown).
- **Non-200 with port file** → fail safe: do not launch (sandbox may block loopback curl, or port file is stale). Use existing port and warn user.
- **200** → use the existing board. A running VS Code extension already serves it;
  a second instance must not be started.

---

## Step 2 — become the orchestrator

**You are the orchestrator. Not a terminal you start — this one.** Adopt the seat and
run the pre-flight here, in this conversation.

```bash
PORT=$(cat "$ROOT/.switchboard/api-server-port.txt")
BASE="http://127.0.0.1:$PORT"

# SWITCHBOARD_TERMINAL is set for Switchboard-managed fleet seats. Unset elsewhere —
# send it empty rather than guessing a name.
curl -s -X POST "$BASE/orchestration/adopt" -H "Content-Type: application/json" \
  -d "{\"terminalName\": \"${SWITCHBOARD_TERMINAL:-}\"}"
```

The response carries `prompt` — the pre-flight instruction. **Follow it in this
session**: read `.agents/skills/switchboard-orchestrator/SKILL.md`, run the pre-flight,
report what you find, propose a goal, and wait for the user to answer *here*.

`POST /orchestration/adopt` **does not arm** and seats no terminal. On the user's
confirmation, write `.switchboard/orchestrator/session.md` and call
`POST /orchestration/confirm` — that is the only call that arms.

If the response carries a `note`, relay it in one line: it means live turn-end notices
will arrive in `.switchboard/orchestrator/reports/` rather than as prompts in this
terminal. Read that directory on each pass.

Never call `POST /orchestration/start` from here — that door creates a *separate*
Orchestrator terminal, which is the opposite of what `/switchboard` is for.

---

## Everything else

- **Board** — open the browser board. It is the console.
- **HTTP surface** — the `switchboard-orchestration` skill documents every endpoint,
  verb, and payload field. Read it for the complete contract.
- **Behavior contracts** — the `switchboard-contracts` skill answers how the system
  behaves (cards move on coding start, completion = plan-file mtime advance, etc.).
- **Planning, features, plan improvement, card moves** — each has a skill that owns it.
