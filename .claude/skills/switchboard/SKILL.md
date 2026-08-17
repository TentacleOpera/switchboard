---
name: switchboard
description: Start the Switchboard board and the orchestration agent — a two-step launcher
allowed-tools: Bash
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
  PORT=$(cat "$PORT_FILE")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
else
  HEALTH="000"
fi

if [ "$HEALTH" = "200" ]; then
  echo "Switchboard is already running (port $PORT). Using the existing board."
else
  echo "No board answering. Starting npx switchboard..."
  npx switchboard &
  # Wait for the server to come up (best-effort, bounded).
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if [ -f "$PORT_FILE" ]; then
      PORT=$(cat "$PORT_FILE")
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

- **No file, connection refused, non-200** → launch. A stale port file pointing at a
  dead port causes a launch, not an attach to a URL that 404s.
- **200** → use the existing board. A running VS Code extension already serves it;
  a second instance must not be started.

---

## Step 2 — start the orchestration agent

Hand off to the pre-flight sequence in the `switchboard-orchestrator` skill's
`## Pre-flight` section: the orchestrator terminal is seated, the agent runs a
pre-flight check (what is missing, what is in scope), proposes a session goal, and
**waits for the user to answer**. This skill does not duplicate that sequence; it
starts it.

```bash
PORT=$(cat "$ROOT/.switchboard/api-server-port.txt")
BASE="http://127.0.0.1:$PORT"

curl -s -X POST "$BASE/orchestration/start" -H "Content-Type: application/json" -d '{}'
```

`POST /orchestration/start` **does not arm** — it seats the orchestrator and delivers
the pre-flight. Arming is `POST /orchestration/confirm`, called by the agent after the
user answers the interview. See the `switchboard-orchestrator` skill's `## Pre-flight`
section for the full protocol.

---

## Everything else

- **Board** — open the browser board. It is the console.
- **HTTP surface** — the `switchboard-orchestration` skill documents every endpoint,
  verb, and payload field. Read it for the complete contract.
- **Behavior contracts** — the `switchboard-contracts` skill answers how the system
  behaves (cards move on coding start, completion = plan-file mtime advance, etc.).
- **Planning, features, plan improvement, card moves** — each has a skill that owns it.
