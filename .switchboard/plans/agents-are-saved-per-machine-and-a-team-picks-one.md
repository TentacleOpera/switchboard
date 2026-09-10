# Agents Are Saved Per Machine, and a Team Picks One

## Goal

A machine selector at the top of the Agents tab. Agents are saved **per machine**. The machine carries
its own `ssh`/`mosh` prefix, applied to every agent in that set. A team picks **one** machine — never
split across two.

That makes "a coding team on the Mac and a coding team on the tower" two team definitions that differ
by one dropdown, with each role's CLI entered once per machine and the transport entered once per
machine.

### Problem analysis

**Startup commands live in two places, and one is the wrong surface.**

| where | holds | should it |
|---|---|---|
| `agents.startupCommands` — `Record<string,string>`, per role | one CLI per role, globally | yes, but it has no machine |
| per-member `startupCommand` in a team definition (`a3ae9de3`) | free-text command per member row | **no** |

`a3ae9de3` added *"two inputs per member row: label (70px) and command (flex:1)"* to the TEAMS tab,
turning a selector into an editor. Because the field is free text it also became the only way to say
which machine a seat runs on, so one field now means two unrelated things: *this seat runs a different
CLI*, and *this seat runs elsewhere*.

**What that costs today.** To run a coding team on the tower you duplicate the definition and type
`ssh tower 'agy --dangerously-skip-permissions'` into every member row. Then the transport is retyped
per member per team; renaming the tower means editing every member of every definition; a member's
command no longer tells you which CLI it runs; and **the head is not covered at all** — `headRole`
resolves from `startupCommands[role]`, so the team still spawns its lead locally.

**One machine per team removes most of the design.** No per-agent host, no per-seat host, no head
special case: the team's machine covers every seat in it. The cases it forbids — a lead here and
coders there — are the cases that would need remote plan-path resolution to differ per seat anyway.

## Metadata

**Complexity:** 5
**Tags:** agents, teams, infrastructure, ux
**Dependencies:** `mapping-state-stops-leaking-one-machine's-folders-into-every-other` — a remote seat
is handed its plan path from the board response, which is still absolute. Lands first.
`agent-control-becomes-its-own-panel` is where the Agents tab lives.

## User Review Required

None.

## Proposed Changes

### 1. A machine selector at the top of the Agents tab

- Add and choose machines. `local` exists by default and cannot be deleted.
- Per machine: a **transport prefix** — blank for `local`, otherwise `ssh user@host` or
  `mosh user@host` — entered once and **applied to every agent in that machine's set**.
- Offer `mosh` explicitly: a long-lived seat over plain `ssh` dies with the first network drop and
  takes the agent with it.

### 2. Agents are stored per machine

- `agents.startupCommands` becomes machine-scoped. The existing global set migrates to `local`
  unchanged, so nothing an operator has today moves or breaks.
- A role's CLI is entered once per machine — the CLI only, never the transport. The spawn is
  `<machine prefix> <cli>`, generated.

### 3. The Teams tab picks a machine, and stops accepting commands

- One dropdown per team: which machine. Every seat in the team, head included, resolves against that
  machine's set.
- **Remove the per-member `startupCommand` and label inputs.** The Teams tab selects; it does not
  author agents.
- **No migration needed.** Checked on 2026-09-10: **zero** members carry a `startupCommand`, in either
  `terminals.agentGroups` or the live `terminals.groups`. `a3ae9de3` shipped the inputs on 2026-09-09
  at 18:22 and nobody has typed into them. Delete the field. If a value appears before this lands,
  the machine it implies is whatever prefix the operator typed — read it, register that machine, move
  on; it does not need designing in advance.

### 4. Refuse a split team rather than half-support it

- A team is one machine. If a definition somehow carries seats implying two, fail at save with the
  reason, not at dispatch.

### 5. Check the machine when it is registered

- Verify the transport reaches the machine at registration and when a team selects it — not at
  dispatch, when a card is already moving.

## Verification Plan

- A team on `local` spawns exactly what it does today, byte-identical.
- Two coding teams differing only by machine run at once; every seat including each head runs on its
  team's machine.
- The Teams tab contains no free-text command input.
- Changing a machine's transport prefix updates every team on that machine, with no per-seat edits.
- The `startupCommands` global set is readable as the `local` machine's set after migration, with the
  same values it has today.

## Outstanding Questions

- Does a machine need a working-directory field? A tower clone may sit at a different path, and that is
  the assumption the absolute-path leak currently hides. If it does, it belongs next to the transport —
  one more field on the machine, not on the agent.
