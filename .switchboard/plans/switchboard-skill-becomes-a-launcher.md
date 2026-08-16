# `/switchboard` Becomes a Launcher — Two Steps, Not a Console

## Goal

`/switchboard` does two things:

1. Start `npx switchboard` if it is not already running.
2. Start the orchestration agent.

Everything else in the current 631-line skill is deleted.

### Why

**The skill was written before `npx switchboard` existed.** It is a *conversational* board console — read the board, print a menu, browse columns, move cards, list plans, resolve IDs, run oversight passes — built for a world where the only graphical surface was the VS Code webview and an agent in another host had no way to see the board.

That world is gone. `package.json` ships `bin: { "switchboard": "./dist/standalone/cli.js" }`. **The browser board is the console.** A 631-line skill that narrates the board in markdown is a worse version of a UI the user can open, and it has to be kept in sync with that UI forever.

**What is left once the board exists is a launcher.** The two things a chat surface can do that the board cannot are: start the board when it is not running, and start the agent that drives it. Both are one step.

**Its remaining sections have owners elsewhere.** Planning belongs to the planning mode. Feature grouping, plan improvement and card moves belong to the board and its skills. The oversight-pass protocol belongs with the automation work. Plan-ID resolution exists because a conversational console had to translate for a human who could not see the board — with the board open, the problem does not arise.

## What `/switchboard` does

**Step 1 — ensure a board is running.** Check for a reachable server (`.switchboard/api-server-port.txt` plus a health check). If one answers, use it: a running VS Code extension already serves the board, and a second instance must not be started. If nothing answers, launch `npx switchboard` and report the URL.

**Step 2 — start the orchestration agent.** Hand off to the pre-flight sequence in `orchestration-starts-as-a-conversation.md`: the agent reports what is missing, proposes a session goal, and waits for the user. This skill does not duplicate that sequence; it starts it.

That is the whole skill. It should be short enough to read in one screen.

## What is deleted

The entry protocol and its `awk` board-count pipeline. The five-item menu and every category section beneath it. Feature management prose. Plan-ID resolution. Guided setup and tour. The column-oversight pass protocol and the project-pipeline wrapper. The management-console persona and its hard rules about being a manager rather than a coder.

None of this is trimmed or relocated wholesale — the surfaces that own each concern already exist. Anything found to have no owner is a gap in the board, and the fix is in the board.

## Supersedes

`consolidate-switchboard-front-doors.md` decided `/switchboard` routes to the management console as the local hub. That plan predates `npx switchboard` in the same way this skill does, and its Decision 3 ("local mode's hub is the management console") no longer holds — the hub is the board. Its other decisions (one adaptive front door, `memo` standalone, Cowork served separately, workflow verbs reachable but not surfaced) are unaffected.

## Metadata

**Complexity:** 3
**Tags:** docs, refactor, cli

## Verification Plan

1. `/switchboard` with nothing running: `npx switchboard` starts, the URL is reported, the orchestration agent comes up in pre-flight.
2. `/switchboard` with the VS Code extension already running: no second server starts, and the existing one is used.
3. `/switchboard` twice in a row does not start two boards or two orchestrators.
4. The skill contains no board listing, no menu, no column narration, and no oversight-pass protocol.
5. The skill fits on one screen.
6. Nothing that used to be reachable only through the skill is now unreachable — each former capability is available on the board or through the skill that owns it.
