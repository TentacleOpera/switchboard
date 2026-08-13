# The Researcher Relationship Has No Return Path

## Goal

Give the `researcher` relationship a companion member-side standing order, so a researcher that is handed a question saves its findings and relays a summary back to the terminal that asked. Today the head-side order says *"fold its answer in when it comes back"* and nothing in the system makes it come back.

This is the prerequisite for retiring `/research/dispatch` (see `feature_plan_20260812170000_...`): that endpoint's one genuine contribution is the save-and-return instruction it appends host-side, and deleting it without replacing that instruction strands every answer.

### Problem analysis

Observed 2026-08-13. A planner (`planner-5`) handed a research question to `researcher-1` over `/terminals/relay`. Delivery succeeded — `{"success":true,"delivered":"researcher-1"}` — and then nothing came back. The researcher had:

- no instruction to save its findings anywhere, and
- no return address.

Its answer would have ended in its own scrollback and stayed there. It was only recovered because a **second** relay was sent by hand carrying both instructions; the researcher then saved a 24KB report and relayed a summary back, correctly, first attempt. The capability was never in doubt — the instruction was simply absent.

The stranding is total, not partial. The pty verb surface (`ptyListTerminals`, `ptyVisibleRoles`, `ptyCreateTerminal`, `ptySendPrompt`, `ptyWrite`, `ptyClear*`, `ptyClose*`, `ptyRename*`, `ptySendModel`, `ptyPasteImage`, `ptyCreateBatch`) exposes **no scrollback read**. Terminal output reaches the panel over `/ws/terminal` only. So an answer that is not written to a file or relayed back is not reachable by any caller — it is lost the moment it scrolls.

### Root cause

**`LINK_PRESETS` templates are single and one-directional, and `/terminals/relay` has no reply channel.**

The `researcher` template (`src/webview/terminals.js:7924-7930`) is one body, installed on one terminal:

> *"{child} is your researcher. When you hit a question that needs external sources, documentation or API details you do not already have, hand it to {child} with enough context to work standalone — it cannot see your conversation. Keep working on what you can while it runs, and **fold its answer in when it comes back**. Do not block on it."*

Every clause is addressed to the head. The child is never told it is a researcher, never told where to put findings, and never told who asked. "When it comes back" is an assumption the vocabulary does not fund.

`/terminals/relay` does not fund it either. It stamps provenance for the *reader* —

```
=== RELAYED MESSAGE FROM planner-5 ===
…
=== END RELAYED MESSAGE ===
```

— but that is a header, not a route. Replying requires the recipient to compose its own `POST /terminals/relay` with `to`/`from` inverted, which it has no standing instruction to do.

**Why this surfaces now.** The teams feature's subtask 4 (`feature_plan_20260812190005_team-member-scope-and-relationship.md`) makes `relationship` the wiring vocabulary: a member's `relationship` id resolves to a `LINK_PRESETS` template, and `direction` decides which terminal receives it (`:139`). That is exactly right for `reports-to-head`, `reviewer`, `tester` and `second-opinion`, where one order suffices. It is **not** sufficient for `researcher`, which is the one relationship whose whole value is a round trip. Under a `direction`-only model the researcher is spawned, named in the head's order, and told nothing.

Today the gap is masked: `/research/dispatch` appends the missing half host-side —

```ts
const fullPrompt = `${prompt}\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so the plan author can review them later.`;
```

(`src/services/TaskViewerProvider.ts:4704`). Retiring that endpoint removes the only thing currently closing the loop, which is why this plan lands first.

## Metadata

- **Complexity:** 4
- **Tags:** backend, ui, feature, reliability
- **Project:** Browser Switchboard

## User Review Required

- None. The paired-order shape, the save location, and excluding `custom` are all settled below.

## Complexity Audit

### Routine

- Adding an optional `memberTemplate` field to the preset shape in `src/services/linkPresets.ts` and its webview mirror.
- Installing the second order in the team-spawn path alongside the first.

### Complex / Risky

- **The preset shape is co-owned.** Teams subtask 4 creates `src/services/linkPresets.ts` as the canonical list, keeps the `terminals.js` literal as a declared mirror, and adds a contract test asserting *"ids, labels, templates and directions identical"* (`:120-122`, `:191`). A new field must be added to **both** sides and to that test in one change, or the test either fails or silently stops covering the new field.
- **Order budget.** `MAX_ORDERS = 20` and `MAX_BLOCK_CHARS = 4000` are shared across every order on one terminal (`standingOrders.ts:13-15`), and truncation is **silent**, landing mid-sentence (`:70-72`). A paired relationship doubles the orders a shared researcher accumulates: one shared researcher serving eight planners takes eight member-side orders if installed naively. See Edge-Case 2 — it must be installed once, not per asker.
- **The reply instruction must be executable, not aspirational.** "Report back to whoever asked" is the same class of instruction as "fold its answer in when it comes back" — it names an outcome and no mechanism. The member template must carry the actual `/terminals/relay` shape with `to`/`from`, or it reproduces this bug one level down.

## Edge-Case & Dependency Audit

1. **Hard dependency on teams subtask 4.** `src/services/linkPresets.ts`, the `direction` field and the mirror contract test are created there. This plan extends that shape and cannot land before it.
2. **A shared researcher must not accumulate one order per asker.** Subtask 4's `shared` scope has one researcher serve N heads (`:104-106`). The member-side order is about *how to answer anyone*, not about a specific head, so it is installed **once at spawn** and phrased to reply to whoever relayed — never once per head. Installing per-head would burn the 20-order budget at 20 planners and say the same thing 20 times.
3. **`custom` has no templates.** It is a UI sentinel with an empty body (`terminals.js:7985-7986`); subtask 4 already excludes it from the member relationship dropdown. `memberTemplate` is likewise absent for it. An unknown relationship id must fall back to `reports-to-head`, never to an empty instruction.
4. **Presets that need no return path keep none.** `reports-to-head` is already member-side; `reviewer`, `tester` and `second-opinion` are head-side and *do* expect a reply, but their replies are conversational rather than artefacts — deliberately out of scope here. `memberTemplate` is **optional**; only `researcher` defines one in this plan. Widening it to the others is a separate decision.
5. **The standing-order prefix.** `applyStandingOrders` renders each order as `- Regarding terminal "<child>": <instruction>` (`standingOrders.ts:66-68`). The member template must read correctly after that prefix — and for a shared researcher the "<child>" slot is the *head* it is registered against, so the body must not lean on that name to identify the asker. Use the relay's own `FROM` stamp instead.
6. **Save location.** `/research/dispatch` resolved `switchboard.research.localFolderPaths[0] || '.switchboard/docs/'` (`TaskViewerProvider.ts:4700-4702`). The member template must name the same default so retiring the endpoint does not silently move where findings land. The templates are static strings, so the configured override cannot be interpolated — name the default and let the operator's own instruction override it in practice.
7. **The relay port.** The member template needs a concrete URL. `/terminals/relay` is served by the same `LocalApiServer` the agent already reaches; the port is in `.switchboard/api-server-port.txt`. Instruct reading the port file rather than hardcoding a port — the port is not fixed across installs or restarts.
8. **Auth header.** Under the extension host `getAuthToken()` is empty and `_checkAuth` short-circuits to loopback trust; under standalone the header is required. The Link-up prompt already solves this by emitting `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally (`terminals.js:8244-8250` docblock) — reuse that exact idiom so the secret never enters scrollback.
9. **`from` must be the researcher's own name.** `/terminals/relay` validates both ends against the live fleet (`LocalApiServer.ts:2017-2032`) and 404s on a bad `from`. The member template must tell the researcher to use its own terminal name, which it can read from the relay stamp of the message it received or from `ptyListTerminals`.
10. **No blocking.** The head-side order already says "Do not block on it" — unchanged. The member-side order must not introduce an acknowledgement handshake; it is fire-and-forget in both directions.
11. **Race conditions.** A researcher answering two relayed questions concurrently must reply to each asker separately. Since the reply is composed from the incoming message's `FROM` stamp, this is naturally per-message; do not introduce a "last asker" variable.
12. **Security.** No new endpoint and no new input. `/terminals/relay` already validates both ends against the live fleet and hardcodes `clearBeforePrompt: false`, so a reply cannot wipe the asker's context.

## Dependencies

- `sess_none — no external session dependency.`
- **Hard: teams subtask 4** — `feature_plan_20260812190005_team-member-scope-and-relationship.md`. Creates `linkPresets.ts`, `direction`, the mirror and its contract test. This plan extends all four.
- **Hard: blocks the retirement plan** — `feature_plan_20260812170000_...` (retire `/research/dispatch`) must land **after** this one. That endpoint currently appends the save instruction that this plan replaces; retiring first leaves an interval where no path closes the loop.

## Adversarial Synthesis

Key risks: a member-side order that names an outcome instead of a mechanism, reproducing the exact stranding it exists to fix — closed by putting the concrete `/terminals/relay` call in the template; a shared researcher accumulating one identical order per head and silently truncating the block at 4000 chars — closed by installing the member order once at spawn, phrased to answer whoever asked; and a new preset field landing on one side of the `linkPresets.ts` ↔ `terminals.js` mirror — closed by extending the contract test in the same change. Sequencing is the other real risk: land this before the retirement plan or there is a window with no working return path at all.

## Proposed Changes

### 1. `src/services/linkPresets.ts` — an optional member-side companion template

**Context.** Created by teams subtask 4 as `{ id, label, direction, template }`.

**Logic.** Some relationships are a round trip. Add an optional second body installed on the member at spawn, independent of `direction` (which continues to place the primary order).

**Implementation.**

```ts
/** Optional companion order installed on the MEMBER at spawn, in addition to the
 *  primary order placed by `direction`. Present only for relationships whose value
 *  is a ROUND TRIP: the head-side body says "hand it questions and fold its answer
 *  in when it comes back", and nothing else in the system makes it come back —
 *  /terminals/relay stamps provenance for the reader but is not a reply channel.
 *  Installed ONCE at spawn, never per asker: a shared researcher serves N heads and
 *  N copies of an identical order would burn the 20-order budget and silently
 *  truncate the block at 4000 chars (standingOrders.ts:13-15, :70-72). */
memberTemplate?: string;
```

and on the `researcher` entry:

```ts
memberTemplate:
    'You are a researcher for this fleet. When another terminal relays you a question, ' +
    'research it, then do BOTH of these — findings you keep to yourself are lost, because ' +
    'nothing can read your terminal:\n' +
    '1. Save the full report to .switchboard/docs/ with your file-write tool.\n' +
    '2. Relay a standalone summary back to whoever asked, naming the saved file path. ' +
    'Take their name from the "RELAYED MESSAGE FROM <name>" stamp on their message, read ' +
    'the port from .switchboard/api-server-port.txt, and run:\n' +
    'curl -s -X POST "http://127.0.0.1:<port>/terminals/relay" ' +
    '-H "Content-Type: application/json" -H "Authorization: Bearer $SWITCHBOARD_API_TOKEN" ' +
    '-d \'{"to":"<who asked>","from":"<your own terminal name>","message":"<your summary>"}\'\n' +
    'They cannot see your terminal, so the summary must stand on its own.'
```

**Edge cases.** Static string — the configured `research.localFolderPaths` override cannot be interpolated, so the documented default is named (Edge-Case 6). Keep the body inside `MAX_INSTRUCTION_CHARS` (2000).

### 2. `src/webview/terminals.js` — mirror the field

**Context.** The `LINK_PRESETS` literal at `:7922-7967`, kept as a declared mirror by subtask 4.

**Implementation.** Add `memberTemplate` to the `researcher` entry, byte-identical to the TS source, under the existing keep-in-sync comment. **Do not reorder the array** — `LINK_PRESETS[0]` is the persisted default preset (`:1387-1388`, `:7970`).

### 3. Subtask 4's mirror contract test — cover the new field

**Implementation.** Extend the assertion from *"ids, labels, templates and directions identical"* to include `memberTemplate`. A field the test does not compare is a field that drifts.

### 4. The team-spawn wiring — install both orders

**Context.** The wiring function subtask 2 moves into the shared spawn path; subtask 4 makes it resolve `relationship` → template and apply `direction`.

**Logic.** After installing the primary order, install the companion on the member if the preset defines one.

**Implementation.** Guard on presence and on first-spawn only:

```
resolve preset for member.relationship
install primary order per preset.direction              (existing, subtask 4)
if (preset.memberTemplate && this spawn CREATED the member)
    install preset.memberTemplate on the member
```

**Edge cases.** The `CREATED` guard is what keeps a shared researcher at one companion order across N heads — a reused instance already has it (Edge-Case 2).

## Verification Plan

Manual, against a running fleet. Per session directive, no compilation step and no automated test run is part of this plan.

1. **Reproduce the stranding first.** On the pre-change build, relay a research question to a researcher with no extra instructions. Confirm nothing is written under `.switchboard/docs/` and nothing returns — the answer exists only in its scrollback.
2. **The round trip closes.** After the change, start a team with a `researcher` member and relay a question from the head. The researcher saves a report under `.switchboard/docs/` **and** relays a summary back naming the file path.
3. **Read the orders, do not infer them.** `GET /terminals/standing-orders` and confirm the head carries the `researcher` body about the member, and the member carries the companion body. A flipped or missing order is silent in behaviour.
4. **Shared researcher, one companion order.** Team with `1 × researcher, shared`; start eight heads. The researcher holds **one** companion order, not eight, and all eight heads hold an order naming it.
5. **Two askers, two replies.** Relay a question from head A and another from head B. Each gets its own reply; neither is answered to the wrong terminal.
6. **Reply survives the asker's other work.** The reply arrives without clearing the asker's context — `/terminals/relay` hardcodes `clearBeforePrompt: false`.
7. **Order budget.** With a researcher, a reviewer and three coders on one head, confirm the rendered block is under `MAX_BLOCK_CHARS` and no order is truncated mid-sentence.
8. **Other relationships unchanged.** A `reports-to-head` coder and a `reviewer` gain no companion order and behave exactly as before.
9. **`custom` stays inert and excluded.** Still absent from the member relationship dropdown; no companion order.
10. **Standalone host.** Repeat verification 2 under `npx switchboard`, where the `Authorization` header is genuinely required — the reply must still deliver.

### Automated Tests

None added, and none run in this pass (session directive). The one existing contract that must be extended rather than left behind is subtask 4's `linkPresets.ts` ↔ `terminals.js` mirror test — see Proposed Change 3.

## Recommendation

Complexity 4 → **Send to Coder.** Land after teams subtask 4, and before the `/research/dispatch` retirement.
