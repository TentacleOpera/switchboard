# Team Lead Does Redundant API Port and Terminal Name Checks Despite Both Being in Its Prompt

## Goal

The drive-mode team lead (head agent) wastes a round-trip on every dispatch checking the API port and its own terminal name, even though the enriched drive prefix already injects both. The port is on the `API:` line (e.g. `Port is 58312. BASE="http://127.0.0.1:58312"`), and the terminal name is referenced via `$SWITCHBOARD_TERMINAL`. The lead's own admission: "Habit — verify-before-trust instinct fired without checking that the data was already in my prompt. Wasted a round-trip. Should've just dispatched."

### Root Cause Analysis

Two layers combine to produce the redundancy, but this plan addresses only the prefix layer (Layer 2). The skill-file layer (Layer 1) is addressed by a separate, larger plan that deletes the skill file entirely — see Background below.

**Layer 1 — The skill file actively instructs the lead to discover what it already has (NOT addressed by this plan).**

The `terminal-coder-dispatch/SKILL.md` skill file — which the drive prefix points the lead to — contains §1 (port discovery from `.switchboard/api-server-port.txt`) and §2 (check your own terminal name via `echo $SWITCHBOARD_TERMINAL`). These sections are written for external agents connecting independently, but the drive-mode lead is an internal agent that received both pieces of information in its prompt. The existing plan `f2d76f7c` ("Make the Feature File the Lead's Single Source of Truth and Retire the Dispatch Skill") in PLAN REVIEWED proposes deleting this skill file entirely and inlining its 7 load-bearing rules into the prefix. Editing the skill file now would be dead work when that plan ships. This plan instead counteracts the skill's instructions from the prefix side — telling the lead to skip §1 and §2 — without editing the file.

**Layer 2 — The drive prefix invites the terminal-name check and is too vague about what "do not look up" means (addressed by this plan).**

The enriched drive prefix (`_buildDrivePrefix` in `KanbanProvider.ts`, lines 5596–5666) says:

```
You are driving this feature through your team seats. Everything you need is below — do not look anything up.
...
API: Port is 58312. BASE="http://127.0.0.1:58312" (also in .switchboard/api-server-port.txt)
Your terminal name is in $SWITCHBOARD_TERMINAL.
```

Three problems:

1. **"do not look anything up" is too vague.** It doesn't name the port file or the terminal name check specifically. A lead with a "verify-before-trust" habit reads "do not look anything up" as generic encouragement, not as a prohibition on the specific checks the skill file instructs.
2. **"Your terminal name is in $SWITCHBOARD_TERMINAL."** This line exists in the prefix but serves no purpose during normal drive-mode dispatch. The lead dispatches TO named seats (roster is above this line), standing orders are pre-installed (next line says so), and the feature watch is auto-armed (the prefix says "Armed by the system"). The terminal name is only needed for manual standing-order registration or manual `watchFeature` arming — both of which the prefix explicitly says are already handled. The line invites the lead to check it, creating the redundant round-trip.
3. **"(also in .switchboard/api-server-port.txt)"** on the API line points the lead at the file, implicitly suggesting it can/should be read. The parenthetical was added as a fallback reference but functionally serves as an invitation to verify.

### Background

The enriched drive prefix was introduced to prevent exactly this class of waste — the comment at line 5585 says "so the lead agent does not waste a turn re-discovering what the extension already knows." But the prefix under-specifies its own authority: it says "do not look anything up" without naming the specific checks to skip, and it includes a terminal-name line and a port-file parenthetical that re-introduce the discovery path the prefix was designed to eliminate.

A separate, broader plan exists (`f2d76f7c` — "Make the Feature File the Lead's Single Source of Truth and Retire the Dispatch Skill", PLAN REVIEWED, complexity 7) that proposes deleting the skill file entirely, enriching the feature file with dispatch metadata, and inlining 7 behavioral rules into the prefix. That plan would subsume this fix if implemented. This plan is the smaller, independently shippable intervention that stops the waste now — it fixes the prefix only, and tells the lead to skip the skill's §1/§2 from the prefix side without editing the skill file.

Another plan (`eliminate-redundant-switchboard-connectivity-checks-in-dispatched-agent-prompts.md`, PLAN REVIEWED) proposes a `SWITCHBOARD_LIVENESS_DIRECTIVE` injected into `dispatchPrefixCore` for ALL roles. That plan is complementary but unimplemented and does not address the terminal-name check or the drive-prefix-specific issues described here.

## Metadata

**Complexity:** 2
**Tags:** backend, refactor, performance
**Project:** Browser Switchboard

## User Review Required

No user review required — the change is low-risk prompt-text editing in a single source file with contract test coverage. No data model, API surface, or control-flow changes.

## Complexity Audit

### Routine
- Editing the `_buildDrivePrefix` string array in `KanbanProvider.ts` — removing one line, rewording the opener with a conditional, removing a parenthetical. Pure string changes.
- Updating the contract test to assert the new directives are present and the terminal-name line is absent.

### Complex / Risky
- None. The change is additive to the prompt text. No control flow, no data model, no API surface changes.

## Edge-Case & Dependency Audit

- **Fallback to static `DRIVE_FEATURE_PREFIX`:** When no team roster resolves, `_buildDrivePrefix` returns `null` and the static `DRIVE_FEATURE_PREFIX` is used instead (line 5686: `prefix += driveBlock ?? DRIVE_FEATURE_PREFIX`). The static prefix is the one-line pointer to the skill file. In this fallback case, the skill's §1/§2 port-discovery and terminal-name checks ARE needed (the lead has no enriched context). This plan does not touch the static prefix or the skill file, so the fallback path is unaffected.
- **External-headed teams:** External team leads (Cursor/Zed/Antigravity) use the `external-team-lead/SKILL.md` protocol, not `terminal-coder-dispatch/SKILL.md`. They also don't receive the enriched drive prefix (they connect independently). The prefix changes do not affect them.
- **Manual standing-order registration:** If a lead needs to manually register a standing order (the prefix says "Do not re-register" but a coder might be missing one), it needs its own terminal name for the `child` field. The prefix line removal is safe because the `$SWITCHBOARD_TERMINAL` env var is always available in the terminal; the lead can still access it if needed, it just isn't told to check it upfront. The opener says "Skip §2 (terminal name) in the skill file" — if the lead genuinely needs the terminal name for a manual standing order, it can still read `$SWITCHBOARD_TERMINAL` from the environment.
- **Port-file parenthetical removal:** Removing "(also in .switchboard/api-server-port.txt)" from the API line means the lead has no fallback reference if the injected port is wrong. This is acceptable because: (a) the port is read from the same file at prompt-build time (lines 5603–5611), so it cannot be stale; (b) the `apiPort = 0` edge case (server not running) already falls back to the string "read .switchboard/api-server-port.txt" (line 5602), which is the correct behavior when the port is genuinely unknown.
- **Existing tests:** `drive-mode-prompt-overhaul-contract.test.js` (line 86) asserts the prefix contains specific strings (`YOUR TEAM:`, `Coding-coder-1 (coder) — active`, etc.) but does NOT assert on "Your terminal name is in $SWITCHBOARD_TERMINAL" or the port-file parenthetical. No test breakage from removing those strings. The test DOES assert `'Do NOT query kanban.db directly'` is present — the new "Do NOT" lines are additive and won't conflict.
- **`apiPort = 0` edge case:** When the port file doesn't exist or is unreadable, `portLine` stays as `'read .switchboard/api-server-port.txt'` (line 5602). In this case, the "Do NOT read the port file" directive must NOT be emitted — the lead genuinely needs to read it. The fix gates the "Do NOT" directive on the port being successfully resolved (same condition that produces the `Port is ${portRaw}` string).
- **Interaction with plan `f2d76f7c`:** When the bigger plan ships (deletes the skill file, simplifies the prefix, inlines 7 rules), the opener's "Skip §1 (port discovery) and §2 (terminal name) in the skill file" reference will be stale — the skill file won't exist. This is acceptable: the bigger plan rewrites the prefix opener anyway, and the "Do NOT" directives about port and terminal name will either be carried forward or become unnecessary (the skill file that instructed the checks is gone). No conflict — the bigger plan supersedes this one cleanly.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) all line-number references in the original plan were off by ~7 — corrected to actual line numbers in this revision; (2) the original test design would fail on first run because the test workspace `'/missing-workspace'` has no port file, so `portResolved` is false and the "Do NOT read" directive is never emitted — fixed by adding a temp directory with a port file for the resolved-port assertions; (3) three required sections were missing (`## User Review Required`, `## Dependencies`, `## Adversarial Synthesis`) — added. Mitigations: line numbers verified against current source, test fix uses a real temp dir with `os.tmpdir()`, and the `os` module import is noted. No fundamental design changes needed — the prefix-side counteraction approach is sound.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — Strengthen the drive prefix and remove the terminal-name invitation

In `_buildDrivePrefix` (lines 5596–5666), make three changes to the `block` array and add a conditional opener:

**a) Replace the vague opener with an explicit, conditional one (line 5631):**

The current opener is a hardcoded string at line 5631. Replace it with a conditionally-built `opener` variable that gates the "Do NOT read the port file" directive on successful port resolution. Add the `portResolved`, `skipPortDirective`, and `opener` variables just before the `block` array definition (after the `planEntries` filter at line 5628):

```typescript
const portResolved = portLine.startsWith('Port is ');
const skipPortDirective = portResolved
    ? ' Do NOT read .switchboard/api-server-port.txt (the port is above).'
    : '';
const opener = `You are driving this feature through your team seats. Everything you need is below — the port, your team roster, and the subtask list are all in this prompt.${skipPortDirective} Do NOT check your own terminal name — you dispatch TO named seats (listed above), and standing orders handle callbacks. Skip §1 (port discovery) and §2 (terminal name) in the skill file; those are for external agents.`;
```

Then use `opener` as the first element of the `block` array instead of the hardcoded string:

```typescript
// Before:
const block = [
    'You are driving this feature through your team seats. Everything you need is below — do not look anything up.',

// After:
const block = [
    opener,
```

**b) Remove the port-file parenthetical from the API line (line 5608):**

```typescript
// Before:
portLine = `Port is ${portRaw}. BASE="http://127.0.0.1:${portRaw}" (also in .switchboard/api-server-port.txt)`;

// After:
portLine = `Port is ${portRaw}. BASE="http://127.0.0.1:${portRaw}"`;
```

**c) Remove the terminal-name line (line 5637):**

```typescript
// Before:
'Your terminal name is in $SWITCHBOARD_TERMINAL.',

// After:
// (deleted — the lead does not need its own terminal name during normal dispatch;
//  $SWITCHBOARD_TERMINAL remains available in the env if manual standing-order
//  registration is ever needed, but it is not surfaced as a prompt line)
```

### 2. `src/test/drive-mode-prompt-overhaul-contract.test.js` — Assert new directives with correct test workspace

> **Superseded:** The original test design added assertions to the existing `prefix` variable (from `'/missing-workspace'`) expecting `Do NOT read .switchboard/api-server-port.txt` to be present. It also added a redundant `_buildDrivePrefix` call for the fallback case.
> **Reason:** The test workspace `'/missing-workspace'` has no `.switchboard/api-server-port.txt`, so `portLine` stays as the fallback string `'read .switchboard/api-server-port.txt'`, `portResolved` is false, and the "Do NOT read" directive is never emitted. The assertion would fail on the first run. The fallback call was redundant with the existing `prefix` variable at line 85, which already uses `'/missing-workspace'`.
> **Replaced with:** A two-case test design — (1) a temp directory with a real port file for the resolved-port assertions, and (2) the existing `prefix` variable (from `'/missing-workspace'`) for the fallback assertions.

**Add `os` to the imports (line 5):**

```javascript
// Before:
const path = require('path');
const Module = require('module');

// After:
const path = require('path');
const os = require('os');
const Module = require('module');
```

**Add assertions after the existing required-strings loop and watchFeature assertion (after line 89):**

```javascript
// --- Resolved-port case: temp workspace with a port file ---
// The existing prefix (line 85) uses '/missing-workspace' which has no port file,
// so portResolved is false and the "Do NOT read" directive is absent. To test the
// resolved-port case, create a temp directory with a real port file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-test-'));
fs.mkdirSync(path.join(tmpDir, '.switchboard'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, '.switchboard', 'api-server-port.txt'), '58312');
const resolvedPrefix = await teamProvider._buildDrivePrefix(tmpDir, [{ planId: 'feature-1' }, { planId: 'subtask-1' }]);
assert.ok(resolvedPrefix.includes('Do NOT read .switchboard/api-server-port.txt'), 'prefix must tell the lead not to re-read the port file when port is resolved');
assert.ok(resolvedPrefix.includes('Do NOT check your own terminal name'), 'prefix must tell the lead not to check its terminal name');
assert.ok(!resolvedPrefix.includes('Your terminal name is in $SWITCHBOARD_TERMINAL'), 'prefix must not surface the terminal-name line');
assert.ok(!resolvedPrefix.includes('(also in .switchboard/api-server-port.txt)'), 'prefix must not point at the port file');
fs.rmSync(tmpDir, { recursive: true, force: true });

// --- Fallback case: no port file (existing prefix from line 85 uses '/missing-workspace') ---
// The existing `prefix` variable already has no port file, so the "Do NOT read"
// directive must NOT be present.
assert.ok(!prefix.includes('Do NOT read .switchboard/api-server-port.txt'), 'prefix must not prohibit port-file reads when the port was not resolved');
```

## Verification Plan

### Automated Tests
- Run `node src/test/drive-mode-prompt-overhaul-contract.test.js` — the new assertions should pass and existing assertions should remain green.
- Run `npm test` — no other tests should break (no existing test asserts on the removed terminal-name line or port-file parenthetical).

### Manual Verification
- Dispatch a drive-mode lead with a team (AUTOMATION tab or board dispatch with Drive toggle on). Verify the terminal prompt:
  - Contains `Do NOT read .switchboard/api-server-port.txt` and `Do NOT check your own terminal name`
  - Does NOT contain `Your terminal name is in $SWITCHBOARD_TERMINAL`
  - Does NOT contain `(also in .switchboard/api-server-port.txt)`
  - The lead dispatches immediately without reading the port file or echoing `$SWITCHBOARD_TERMINAL`
- Test the fallback case (delete or rename `.switchboard/api-server-port.txt`, dispatch a drive-mode lead). Verify the prompt says `API: read .switchboard/api-server-port.txt` and does NOT contain the "Do NOT read" directive — the lead correctly falls back to file-based discovery.

---

**Recommendation:** Complexity 2 → Send to Intern

## Implementation Summary

Implemented the drive-mode prompt overhaul to eliminate redundant port and terminal name checks. Strengthened `_buildDrivePrefix` in `src/services/KanbanProvider.ts` by replacing the vague opener with an explicit conditional directive instructing the lead not to read `.switchboard/api-server-port.txt` when the port is resolved, and explicitly directing it to skip terminal name and skill port checks. Removed the unnecessary terminal name line and the port file parenthetical from the prompt block. Added contract test assertions in `src/test/drive-mode-prompt-overhaul-contract.test.js` covering both resolved-port and fallback scenarios.

## Review Findings

Two findings fixed, both in `_buildDrivePrefix`. The MAJOR one: the new opener says "Do NOT read .switchboard/api-server-port.txt (the port is above)" while the CLOSE OUT EVERY SUBTASK line two blocks later told the lead to POST "against the port in .switchboard/api-server-port.txt" — one prompt, two opposite instructions about the same file, which is exactly the round-trip this plan exists to remove. The close-out now interpolates a `closeOutTarget` gated on the same `portResolved` flag as the opener (`against $BASE` when resolved, the file reference only in the branch where the opener does not forbid it), so the two can never disagree. The second: the opener claimed seats were "listed above" when the roster prints below it — corrected to "see YOUR TEAM below", since a false locator in a prompt is what sends an agent looking. The existing test passed throughout because its negative assertion pins the exact string `(also in .switchboard/api-server-port.txt)`, which the close-out never used. Files changed: `src/services/KanbanProvider.ts`; `test:contract:drive-mode-prompt-overhaul` green (CI-wired), with no remaining risk beyond `$BASE` depending on the lead assigning it from the API line, which the STAGING curl template already requires.
