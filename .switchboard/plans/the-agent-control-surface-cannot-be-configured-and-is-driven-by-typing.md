# The Agent Control Surface Cannot Be Configured, and Is Driven by Typing

## Goal

The dock's Agent tab is configured from the dock — endpoint and model chosen in the surface
itself — and is driven entirely by action buttons. No text box, no env var, no field borrowed
from somewhere else.

### Problem analysis

The surface shipped and passed review as *"Implemented all six changes"*. It is unusable, for
three reasons that are all decisions rather than defects, which is why no gate caught them.

**1. The API key has no setter anywhere in the product.**

`switchboard.agentControl.apiKey` appears in the codebase only in **reads** — four of them, all
in `LocalApiServer.ts`. Nothing writes it. There is no field in any panel, and the secrets CLI
allowlist is `clickup|linear|notion|stitch|apiToken|key`, which does not include it. The only
way to supply a key is to export `SWITCHBOARD_AGENT_API_KEY` before the board process starts.

So a configuration surface shipped with no way to configure it, and from a phone — the surface's
own stated destination — it cannot be configured at all.

**2. The endpoint is configured by repurposing the startup-command field.**

`_resolveAgentControlModel` (`LocalApiServer.ts:10581`) reads
`getAgentStartupCommands()['project_manager']`, falls back to `['mission-control']`, and treats
the value as the model URL if it happens to begin with `http`. That was deliberate — change 2 of
`the-dock-agent-tab-is-a-control-surface-not-a-terminal` reads *"A role's backend is already a
setting… configured like any other seat."*

The field the operator must type into is labelled **Startup command**, with the placeholder
`devin --model claude-opus-4.6`. Nothing in the UI says it doubles as the agent-control endpoint,
and nothing validates that what is there is one. Reusing the field satisfied the plan's wording
while leaving the feature unconfigurable in practice.

**3. There is no model at all — only a URL.** No model name is stored, sent, or selectable.
An endpoint that serves several models cannot be pointed at one.

**4. The surface is driven by a text box, which is the opposite of the instruction.**

`dock.html:439` is `<input class="agent-control-input" placeholder="Type an intent (e.g.
'dispatch my starred cards')">` with a Send button beside it. The plan specified it: *"The
operator types an intent or picks an action."*

The instruction for this surface was **action buttons only**. Typing is also the interaction the
mobile command surface deliberately designed out, and this tab is meant to be reachable there
(change 5 of the same plan). A free-text box on a phone is the exact thing that surface exists to
avoid.

### What already works and must not be disturbed

Six quick actions exist and are declared `needsModel: false`
(`LocalApiServer.ts:10658-10665`): dispatch starred, refresh board, list columns, advance a plan,
move a plan, star a plan. They resolve without a model call and stay available when the model is
broken — the plan's *"a control surface that goes blank is worse than a terminal"*. The buttons
are the right shape; there are simply not enough of them, and a text box sits where the rest
should be.

`modelConfigured` is also already honest: a configured-but-keyless endpoint reports `false` with
a reason rather than claiming health. That fix stays.

### Non-goals

- **Reintroducing a terminal.** The Agent tab renders no emulator and must not start.
- **Routing mechanical actions through the model.** Moving a named card is a POST, and stays one.
- **A general settings panel.** Endpoint, key and model are configured in the surface that uses
  them, not in a new tab elsewhere.

## Metadata

- **Complexity:** 5
- **Tags:** dock, agent-control, config, ux

## User Review Required

None.

## Proposed Changes

### 1. Endpoint, key and model are set in the Agent tab

A config row in the surface itself: **endpoint URL**, **model**, **API key**. Written through a
dedicated verb to their own config keys — never to `agents.startupCommands`, which is a seat's
CLI command and must stop being overloaded.

The key writes to the encrypted secrets store under `switchboard.agentControl.apiKey`, which is
the key the reader already looks for, so nothing downstream changes. `SWITCHBOARD_AGENT_API_KEY`
stays as an override for a headless install, and the surface reports which source answered — the
tagged-read rule the resolver already follows for `keySource`.

The key field is write-only: it renders as set/unset and never echoes the stored value back.

### 2. Stop reading the model endpoint out of `agents.startupCommands`

`_resolveAgentControlModel` reads the new key. The startup-command fallback is deleted outright
rather than kept as a compatibility arm: it is what made an unconfigurable feature look
configured, and leaving it means a URL left in a `project_manager` startup command silently wins
over what the operator typed into the new field.

Teams have never shipped, so there is nothing to migrate. A URL sitting in that field today stops
being a model endpoint and goes back to being what the field says it is.

### 3. The model is named, and sent

Store a model identifier beside the URL and include it in the request body. An endpoint serving
several models is the ordinary case and cannot be addressed today.

Unset means unset: the surface says so rather than guessing a default, since a wrong model that
answers is worse than none.

### 4. Delete the text input; the buttons become the whole surface

Remove `#agent-control-input` and `#agent-control-send`. Every action is a button.

The six existing actions stay as they are. Three of them — advance, move, star — are labelled
"(by id)" and today rely on the operator typing the id somewhere; they become a card picker: a
dropdown of the cards already on the board, and for `move`, a second dropdown of enabled columns
from `GET /kanban/columns`. Taps and dropdowns, nothing typed.

An action that genuinely cannot be expressed as a button does not belong on this surface.

### 5. Say what is wrong, in the surface, with the fix next to it

When the model is unconfigured or unusable the tab already reports it. It should report it beside
the fields that fix it, so the operator is never told "no API key is set" by a surface that
cannot set one.

## Verification Plan

### Automated Tests

1. **New** `src/test/agent-control-config-contract.test.js`, wired as
   `test:contract:agent-control-config` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Asserts:
   the API key has a writer reachable from the surface; the key is never returned to the client;
   `modelConfigured` is false when the key is unset; the model identifier round-trips.
2. Assert `_resolveAgentControlModel` no longer reads `agents.startupCommands` — a grep-level
   pin, because that read is what made the feature look configured while being unconfigurable.
3. Assert `dock.html` contains no free-text input in the agent pane, and that every quick action
   resolves from a button or a dropdown. This is the assertion that keeps the surface from
   drifting back into a prompt box.
4. Assert the six existing `needsModel: false` actions still work with the model unconfigured —
   the "does not go blank" property, which this plan must not regress.

### Goal Invariants

- A fresh install can configure endpoint, model and key entirely from the Agent tab, with no env
  var and no edit to a startup command.
- The Agent tab contains no text input.
- Every action on the surface can be performed by tapping, including on a phone.
- With no model configured, the mechanical actions still work and the tab says what is missing
  next to the field that sets it.
- A URL left in a `project_manager` startup command has no effect on the agent controller.
