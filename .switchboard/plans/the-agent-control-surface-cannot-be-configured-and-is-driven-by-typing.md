# The Agent Control Surface Cannot Be Configured, and Is Driven by Typing

## Goal

The dock's Agent tab is configured from the dock — endpoint and model chosen in the surface
itself — and is driven entirely by action buttons. No text box, no env var, no field borrowed
from somewhere else.

The same is true of the mobile command surface (`command.html`), which renders its own copy
of the agent control pane and is the surface the feature is meant to reach on a phone. The
"no text box, action buttons only" rule applies to **both** surfaces; the dock is not the
only pane that ships a free-text intent box today.

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

> **Superseded:** "the secrets CLI allowlist is `clickup|linear|notion|stitch|apiToken|key`, which does not include it. The only way to supply a key is to export `SWITCHBOARD_AGENT_API_KEY` before the board process starts."
> **Reason:** The standalone secrets CLI's `resolveSecretKey` (`src/standalone/cli.ts:151-154`) passes any fully-qualified dotted key through as an escape hatch, so `npx switchboard secrets set switchboard.agentControl.apiKey <value>` already writes the key the reader looks for. The "only way is an env var" claim is false on the standalone host. (The usage string's `|key` token is not a real `SECRET_ALIASES` entry — `SECRET_ALIASES` at `cli.ts:135-141` has five aliases, none named `key`.)
> **Replaced with:** The key is settable from the host's CLI via its dotted key, but not from the Agent tab itself, and not at all from a phone — the surface the feature is meant to reach. The defect stands; the framing narrows from "no setter anywhere" to "no setter in the surface that uses it." (The "four reads" count is also loose: of the four `switchboard.agentControl.apiKey` matches in `LocalApiServer.ts`, only `:10615` is a functional read — `:657` and `:10577` are doc comments, `:10634` is an error-message string. The substantive claim, that nothing writes the key, is correct and verified.)

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

The same free-text intent box is also present in the mobile command surface:
`command.html:1072` (`<input type="text" id="agent-control-input" placeholder="Type an intent...">`)
with a `btn-agent-send` Send button (`command.html:1073`), wired by `command.js:2245-2246` and
driven through `sendAgentControlMobile()` (`command.js:2299`). The dock is not the only pane that
violates the action-buttons-only rule.

### What already works and must not be disturbed

Six quick actions exist and are declared `needsModel: false`
(`LocalApiServer.ts:10658-10665`): dispatch starred, refresh board, list columns, advance a plan,
move a plan, star a plan. They resolve without a model call and stay available when the model is
broken — the plan's *"a control surface that goes blank is worse than a terminal"*. The buttons
are the right shape; there are simply not enough of them, and a text box sits where the rest
should be.

`modelConfigured` is also already honest: a configured-but-keyless endpoint reports `false` with
a reason rather than claiming health. That fix stays.

**How the six buttons actually fire today (load-bearing for this plan):** the quick-action
buttons do NOT call mechanical endpoints directly. `dock.js:266-271` stuffs the button's label
into `#agent-control-input.value` and calls `sendAgentControl()`, which POSTs the label as free
text to `/agent/control` (`dock.js:300-303`); the backend then keyword-parses it
(`LocalApiServer.ts:10917` `/\bdispatch\b/`, `:10944` `/\bmove\b/`, `:10981` `/\bstar\b/`).
`command.js:2285-2290` does the same on the mobile surface. The buttons and the text box are the
same code path — deleting the input without rewiring the buttons leaves six dead buttons.

### Non-goals

- **Reintroducing a terminal.** The Agent tab renders no emulator and must not start.
- **Routing mechanical actions through the model.** Moving a named card is a POST, and stays one.
- **A general settings panel.** Endpoint, key and model are configured in the surface that uses
  them, not in a new tab elsewhere.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, ui, ux, api, security, mobile

## User Review Required

- **[user] Migration of the startup-command-as-endpoint overload.** This plan stops reading the
  model endpoint out of `agents.startupCommands['project_manager']` and deletes that fallback.
  Per the project migration rule, when unsure whether a behaviour shipped, assume it did and
  migrate. Proceeding on the assumption that the overload **did** ship in a released version, so
  the fallback is replaced by a one-time migration (see Proposed Change 2), not an outright
  silent deletion. If you can confirm from git history that the overload never reached a released
  build, the migration can be dropped for a clean break.

## Complexity Audit

### Routine
- Adding a config row (endpoint URL, model, write-only API key) to the dock Agent pane and the
  command surface agent pane.
- Deleting the free-text `<input>`/Send button markup and its CSS from `dock.html` and
  `command.html`.
- Adding a `model` field to the request body sent to the configured endpoint.

### Complex / Risky
- **Rewiring the six quick actions off the text-parsing path.** Today they stuff their label
  into the text input and POST it to `/agent/control` for keyword parsing. Removing the input
  without rewiring breaks all six — reachable but not usable. They must fire their mechanical
  endpoints directly.
- **Extending the `encryptedSecretsStore` composition-root seam to a writer, in BOTH roots.**
  The option (`LocalApiServer.ts:661`) exposes `get` only. The extension backs it with
  `context.secrets` (`TaskViewerProvider.ts:4691`); standalone backs it with the global encrypted
  store (`bootstrap.ts:5251`). Different stores, neither writable. Writing the key from the
  surface requires adding `store`/`delete` to the seam and wiring it in both roots — the exact
  divergence trap the project rules name, where "never wired" and "working" are the same value.
- **Migrating the startup-command endpoint overload** rather than silently deleting it.
- **Two surfaces, one change.** `dock.html`/`dock.js` and `command.html`/`command.js` both carry
  the agent control pane; both must lose the text box and gain the config row, or the mobile
  Goal invariant is violated.
- **Inverting the existing dock contract test** (`shell-agent-dock.test.js:299-300,369-371`)
  which currently asserts the text input, Send button, `sendAgentControl`, and the `/agent/control`
  call MUST exist.

## Edge-Case & Dependency Audit

- **Race Conditions:** the config-write endpoint writes endpoint/model (config file) and key
  (secrets store) in one request. A reader (`_resolveAgentControlModel`) that runs between the
  two writes could see a new endpoint with the old (empty) key and report
  `modelConfigured: false` with the keyless-error reason. Acceptable (transient, self-corrects on
  the next read) but the write order must be key-first, endpoint/model-second so the half-written
  state is "key set, old endpoint" rather than "new endpoint, no key" (the latter is the
  configured-but-keyless state the existing guard already flags as an error).
- **Security:** the API key field is write-only — it renders as set/unset and never echoes the
  stored value back to the client. The config-write endpoint must never include the key in its
  response body. `GET /agent/control/config` already omits the key (`modelKeySource` only); the
  new write endpoint must do the same. The endpoint must be auth-gated (`_checkAuth`) like the
  existing `/agent/control` routes.
- **Side Effects:** deleting the startup-command fallback changes the meaning of a URL left in a
  `project_manager` startup command — it goes back to being a CLI command. The migration step
  moves any such URL to the new config key first.
- **Dependencies & Conflicts:**
  - `shell-agent-dock.test.js:299-300` asserts `#agent-control-input` and `#agent-control-send`
    MUST exist; `:369-371` asserts `sendAgentControl` and the `/agent/control` call MUST exist.
    This plan inverts all four assertions. The test is a dependency, not a gate to ignore.
  - The `encryptedSecretsStore` seam is read-only today and is wired differently per host
    (extension: `context.secrets`; standalone: global encrypted store). Any write path must land
    in both `TaskViewerProvider.ts` and `bootstrap.ts` or the surface can set the key on one host
    and silently cannot on the other.
  - `POST /agent/control`'s text-parsing arm (`_resolveAgentPhrase` + the keyword dispatch in
    `_handleAgentControl`) becomes unreachable once the input is gone. If the model-backed fuzzy
    resolution arm is retained, it must move behind an explicit control (dropdown selection +
    Resolve button), not free text.

## Dependencies

None — single plan, no prior session dependencies.

## Adversarial Synthesis

Key risks: (1) the six "working" buttons are the text box — deleting the input without rewiring
to direct mechanical endpoints leaves the surface dead while passing a "buttons exist" check;
(2) the `encryptedSecretsStore` seam is read-only and wired to *different stores* per host, so a
surface-written key silently no-ops on whichever root doesn't wire the writer; (3) the mobile
command surface (`command.html`) carries the same text box and is missed by a dock-only change.
Mitigations: rewire quick actions to fire `kanbanVerb`/`moveCard`/`_setPlanPriority` directly;
extend the seam to `store`/`delete` and wire it in both composition roots with a parity test;
apply the text-box removal and config row to both `dock.*` and `command.*`.

## Proposed Changes

### 1. Endpoint, key and model are set in the Agent tab (and the command surface)

A config row in the surface itself: **endpoint URL**, **model**, **API key**. Written through a
dedicated write endpoint to their own config keys — never to `agents.startupCommands`, which is a
seat's CLI command and must stop being overloaded.

**Write endpoint:** add `POST /agent/control/config` (write), auth-gated via `_checkAuth`,
mirroring the existing `GET /agent/control/config` route registration at
`LocalApiServer.ts:13137-13140`. Body: `{ endpoint?: string, model?: string, apiKey?: string }`.
Write order is **key-first, endpoint/model-second** (see Edge-Case Audit). Response omits the key
entirely (returns only `{ success, keySet: boolean }` for the key field, never the value).

**Storage:**
- `endpoint` and `model` → `GlobalIntegrationConfigService.setAgentConfig('agentControlEndpoint', ...)`
  and `setAgentConfig('agentControlModel', ...)` (the same service that already holds
  `startupCommands`; new keys, no overload).
- `apiKey` → the secrets store via the `encryptedSecretsStore` seam (see Change 6 below for the
  seam extension). This is the key the reader already looks for
  (`switchboard.agentControl.apiKey`), so the read path is unchanged once the writer is wired.
  `SWITCHBOARD_AGENT_API_KEY` stays as an override for a headless install, and the surface
  reports which source answered — the tagged-read rule the resolver already follows for
  `keySource`.

The key field is write-only: it renders as set/unset and never echoes the stored value back.
`GET /agent/control/config` is extended to return `endpoint`, `model`, and `keySet: boolean`
(never the key) so the row can render current state without leaking the secret.

This row lands in **both** `dock.html` (the dock Agent pane) and `command.html` (the mobile
command surface's agent pane), wired by `dock.js` and `command.js` respectively.

### 2. Stop reading the model endpoint out of `agents.startupCommands` — with a migration

`_resolveAgentControlModel` reads the new keys (`agentControlEndpoint`, `agentControlModel`).
The startup-command fallback is removed, but **not as a silent deletion**:

> **Superseded:** "The startup-command fallback is deleted outright rather than kept as a compatibility arm… Teams have never shipped, so there is nothing to migrate. A URL sitting in that field today stops being a model endpoint and goes back to being what the field says it is."
> **Reason:** The project migration rule says: when unsure whether a behaviour shipped, assume it did and migrate. The overload was a deliberate, plan-documented behaviour (change 2 of the prior plan), so an operator may have set a URL in `agents.startupCommands['project_manager']` expecting it to be the model endpoint. Deleting the fallback outright silently breaks that install — the endpoint disappears with no message, which is the loud-failure-turned-quiet the rules forbid.
> **Replaced with:** A one-time migration on first read of the new `agentControlEndpoint` key: if the new key is empty AND `agents.startupCommands['project_manager']` (or `mission-control`) starts with `http`, copy that URL into `agentControlEndpoint` via `setAgentConfig`, log that the migration ran and which source answered, and leave the startup command untouched (it reverts to being a CLI command; if it was only ever a URL, it is now an empty CLI command, which is the operator's to fix). After migration, the fallback read is removed. This is a no-op migration cost when nothing was set, and a data-preserving one when something was.

### 3. The model is named, and sent

Store a model identifier beside the URL (`agentControlModel`) and include it in the request body
sent to the configured endpoint. An endpoint serving several models is the ordinary case and
cannot be addressed today.

Unset means unset: the surface says so rather than guessing a default, since a wrong model that
answers is worse than none. `_resolveAgentControlModel` returns `null` (unconfigured) when the
endpoint is absent, and `{ error }` when the endpoint is set but the model is not — so the surface
can distinguish "nothing configured" from "half-configured".

### 4. Delete the text input; the buttons become the whole surface — and are rewired

> **Superseded:** "Remove `#agent-control-input` and `#agent-control-send`. Every action is a button. The six existing actions stay as they are."
> **Reason:** The six quick-action buttons do not fire actions directly. `dock.js:266-271` (and `command.js:2285-2290`) stuff the button's label into `#agent-control-input.value` and call `sendAgentControl()` / `sendAgentControlMobile()`, which POST the label as free text to `/agent/control`; the backend keyword-parses it (`LocalApiServer.ts:10917` `/\bdispatch\b/`, `:10944` `/\bmove\b/`, `:10981` `/\bstar\b/`). The buttons ARE the text input. Deleting the input without rewiring leaves six dead buttons — reachable but not usable, which is exactly the goal-vs-appearance failure this plan exists to prevent.
> **Replaced with:** (a) Remove `#agent-control-input` and `#agent-control-send` from `dock.html`, and `#agent-control-input` / `#btn-agent-send` from `command.html`, plus their CSS and the `sendAgentControl` / `sendAgentControlMobile` functions and their event wiring in `dock.js` / `command.js`. (b) Rewire the six quick actions to fire their mechanical endpoints directly — `dispatch-starred` → POST `/kanban/dispatch` (the `kanbanVerb('promptSelected', ...)` path at `LocalApiServer.ts:10932`), `move-plan` → the `moveCard` seam (`:10962`), `advance-plan` → the advance path, `star-plan` → `_setPlanPriority` (`:10987`), `refresh-board` / `list-columns` → their existing read endpoints — not through the text parser. (c) `POST /agent/control`'s text-parsing arm (`_resolveAgentPhrase` + the keyword dispatch in `_handleAgentControl`) is removed; if model-backed fuzzy resolution is retained, it moves behind an explicit "Resolve" action that takes a dropdown selection, not typed text.

The three "by id" actions — advance, move, star — become a card picker: a dropdown of the cards
already on the board (from the board read the surface already does), and for `move`, a second
dropdown of enabled columns from `GET /kanban/columns`. Taps and dropdowns, nothing typed.

An action that genuinely cannot be expressed as a button does not belong on this surface.

### 5. Say what is wrong, in the surface, with the fix next to it

When the model is unconfigured or unusable the tab already reports it. It should report it beside
the fields that fix it (the new config row from Change 1), so the operator is never told "no API
key is set" by a surface that cannot set one. The `modelError` string from
`GET /agent/control/config` is rendered inline next to the offending field.

### 6. Extend the `encryptedSecretsStore` seam to a writer — in BOTH composition roots

The `encryptedSecretsStore` option (`LocalApiServer.ts:661`) declares only
`get(key): Promise<string | undefined>`. To write the API key from the surface (Change 1), extend
the option type to:

```ts
encryptedSecretsStore?: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
} | null;
```

and wire the new methods in **both** roots — this is the composition-root seam the project rules
name as the largest source of silent divergence:

- **Extension** (`TaskViewerProvider.ts:4691`): the seam is backed by `context.secrets`. Add
  `store: async (k, v) => await this._context.secrets.store(k, v)` and
  `delete: async (k) => await this._context.secrets.delete(k)`.
- **Standalone** (`bootstrap.ts:5251`): the seam is backed by the global encrypted store
  (`createStandaloneHostSecrets`, which already exposes `store`/`delete` —
  `encryptedSecretsStore.ts:9-13` `HostSecrets` interface). Add
  `store: (k, v) => secrets.store(k, v)` and `delete: (k) => secrets.delete(k)`.

Note the two roots write to *different* stores (`context.secrets` vs `secrets.enc`). That is the
existing read divergence and is preserved — the point is that the writer is wired in both, so the
surface can set the key on either host. A parity test (see Verification) pins both wirings.

## Verification Plan

### Automated Tests

1. **New** `src/test/agent-control-config-contract.test.js`, wired as
   `test:contract:agent-control-config` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Asserts:
   the API key has a writer reachable from the surface (`POST /agent/control/config` writes and
   `GET /agent/control/config` reports `keySet: true` without returning the value); the key is
   never returned to the client (response body contains no `apiKey` field and no key value);
   `modelConfigured` is false when the key is unset; the model identifier round-trips
   (`endpoint` + `model` written, read back).
2. **New parity assertion** in the same suite: both composition roots wire the `store`/`delete`
   methods on `encryptedSecretsStore`. Assert `TaskViewerProvider.ts` and `bootstrap.ts` each
   pass an `encryptedSecretsStore` whose option object includes `store` and `delete` (grep-level
   pin on the options object, the same technique `standalone-parity`-style suites use) — the
   "never wired and working are the same value" trap, pinned.
3. Assert `_resolveAgentControlModel` no longer reads `agents.startupCommands` — a grep-level
   pin, because that read is what made the feature look configured while being unconfigurable.
   Paired positive: assert it reads `agentControlEndpoint` / `agentControlModel`.
4. Assert the **migration** runs once: with `agentControlEndpoint` unset and a URL in
   `agents.startupCommands['project_manager']`, the first config read migrates the URL into
   `agentControlEndpoint` and the startup command is no longer consulted on subsequent reads.
5. **Invert** `src/test/shell-agent-dock.test.js:299-300` to assert `#agent-control-input` and
   `#agent-control-send` are **absent** from `dock.html`; invert `:369-371` to assert
   `sendAgentControl` is absent and that the quick actions no longer POST to `/agent/control`
   (they fire their mechanical endpoints instead). Add the paired negative for `command.html`:
   assert `#agent-control-input` and `#btn-agent-send` are absent.
6. Assert `dock.html` and `command.html` contain no free-text input in the agent pane, and that
   every quick action resolves from a button or a dropdown. This is the assertion that keeps both
   surfaces from drifting back into a prompt box.
7. Assert the six existing `needsModel: false` actions still work with the model unconfigured —
   the "does not go blank" property, which this plan must not regress.

### Goal Invariants

- A fresh install can configure endpoint, model and key entirely from the Agent tab, with no env
  var and no edit to a startup command.
- The Agent tab **and the mobile command surface** contain no text input.
- Every action on the surface can be performed by tapping, including on a phone.
- With no model configured, the mechanical actions still work and the tab says what is missing
  next to the field that sets it.
- A URL left in a `project_manager` startup command is migrated to `agentControlEndpoint` (not
  silently dropped), and afterwards has no effect on the agent controller.
- `POST /agent/control/config` never returns the API key value in any response field.
- Both `TaskViewerProvider.ts` and `bootstrap.ts` wire `store` and `delete` on the
  `encryptedSecretsStore` seam.

## Outstanding Questions

- **[user] Did the startup-command-as-endpoint overload ship in a released version?** —
  proceeding on the assumption that it did, so Change 2 migrates rather than silently deletes.
  If you can confirm it never shipped, the migration in Change 2 can be dropped for a clean break.
