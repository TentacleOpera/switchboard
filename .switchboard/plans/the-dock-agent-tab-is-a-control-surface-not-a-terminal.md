# The Dock's Agent Tab Becomes an API-Backed Control Surface, Not a Terminal

kanbanColumn: PLAN REVIEWED

## Goal

The dock's Agent tab is a control surface: you say what you want, it resolves and acts, and it reports what it did. It is not a pty running someone else's CLI.

### Problem analysis

**The controller is a terminal you type into, and it looks like one.** The Agent tab is an iframe at `/terminals?solo=<name>&dock=1` — a live pty seat. In controller mode it is meant to be driven by automated prompts, but what the operator sees is a CLI's own interface: its banner, its input chrome, its thinking, its scrollback. None of that is a control surface; it is another program's terminal, rendered in a panel that exists to control the board.

**The three-tab plan removes the reason it has to be one.** `c2502571` restructures the dock to Agent / CLI / Fleet and adds a dedicated **CLI** tab — a pty seat running the `switchboard` front door. It keeps the Agent tab *"unchanged"*.

That leaves two terminals in a three-tab dock, one of which is a terminal only because the controller has never had another way to be driven. Everything a pty gives the operator — scrollback, typing at the agent directly, raw output — is one tab across. The Agent tab does not need to duplicate it.

**A non-terminal seat skips an entire class of defect.** Every failure investigated on 2026-09-04/05 is a property of driving an agent through a pty: clear readiness, the `/clear` session-restart toll, a startup orientation racing a clear, bracketed paste landing in an open command picker, prompt delivery that lands but never submits. A seat reached over HTTP has none of them — there is no terminal to be ready, nothing to clear, no paste to mistime.

**And the model needed is small.** The controller resolves phrases to plan ids and fires API calls: *"dispatch my starred cards"*, *"find the plans about the clear bug"*. That is resolution and reporting, not code generation. It does not need a frontier model or a CLI harness, and running it on one is why the dock feels heavyweight for what it does.

**Timing.** `c2502571`'s fourth sibling rewrites the container — *"The dock becomes its own document — one `/dock` page, three tabs"*. Changing what one tab contains is cheapest while that rewrite is still Planned.

## Metadata

- **Complexity:** 6
- **Feature:** The dock
- **Tags:** dock, ui, agents, api

## User Review Required

Change 4 carries one decision: whether the terminal-backed controller is retained as an option or removed.

## Proposed Changes

### 1. The Agent tab renders a control surface, not a pty

Board state, the actions available on it, and a record of what was done. No terminal emulator, no scrollback of a CLI's internal monologue.

The operator types an intent or picks an action; the tab shows what it resolved to and what it did.

### 2. Its backend is an HTTP model endpoint, configured like any other seat

A role's backend is already a setting — `agents.startupCommands` gives `planner: devin --permission-mode bypass`, `lead: claude`, `coder: agy`. An API endpoint plus a key is another value of the same setting, not a parallel system.

The prompt is unchanged: `agentPromptBuilder` produces text independent of transport. What differs is delivery — posted rather than typed.

### 3. Show what it resolved to, before it acts

*"My cards"* and *"these plans"* are the part that can be wrong, and a misresolution dispatches the wrong work. Name the cards in the reply.

Not a confirmation dialog — this codebase does not have those and must not gain one. The resolution is displayed as part of doing the thing, so a wrong one is visible immediately rather than discovered later.

### 4. Decide whether the pty controller survives **[decision]**

With CLI on its own tab, a terminal-backed Agent tab has no distinct job. Either remove it, or keep it as a backend option for an operator who wants the agent's full output.

Recommend removing it. Two backends for one tab means both are maintained, both are tested, and the terminal one drags in every pty concern this change exists to escape.

### 5. The context lives in the request

A pty seat carries its conversation in the terminal. An API seat has no such place, so the controller must hold its own history between turns and decide how much to send.

Small for a controller taking short commands, but it has no equivalent on the CLI path and is the piece most likely to be discovered late.

## Edge-Case & Dependency Audit

1. **The model will be unavailable.** A free tier exhausts, a key expires, an endpoint times out. The tab must say so plainly and keep whatever direct actions do not need the model — a control surface that goes blank is worse than a terminal.
2. **Do not route mechanical actions through the model.** Moving a named card is a POST. The model earns its place on resolution and on multi-step operations; everything else should be a direct call, so a model outage costs fuzzy search rather than the whole tab.
3. **This is a desktop surface.** The mobile command surface deliberately designed the keyboard out — taps and dropdowns, a fixed set of functions. Nothing here reopens that.
4. **Depends on `c2502571`** for the CLI tab. Without it, removing the pty from Agent leaves no terminal in the dock at all.
5. **Not a coding seat.** The controller drives the board. Code generation stays on CLI seats, where the capability and the review path already are.
6. **Both hosts** render the dock.

## Verification Plan

1. The Agent tab renders no terminal emulator.
2. A phrase like "dispatch my starred cards" resolves, names the cards it resolved to, and dispatches them.
3. A mechanical action reaches the API without a model call.
4. With the model unavailable, the tab says so and its direct actions still work.
5. The controller's history survives across turns.
6. The CLI tab still provides a full pty seat.
7. Per change 4, either the pty controller is gone or its retention is recorded with a reason.
