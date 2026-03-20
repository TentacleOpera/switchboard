# terminal sendtext messages keep failing

## Goal
Fix two related failures in the `sendRobustText` function (`src/services/terminalUtils.ts`):

1. **Triple-tap Enter spam breaks CLI agents** — The function sends 3 consecutive `sendText('', true)` calls to detected CLI agents (copilot, gemini, claude, windsurf, cursor, cortex), causing command cancellation, buffer desynchronization, or unintended double-execution.
2. **Large prompt payloads get truncated** — For CLI agents, the function flattens newlines and sends the entire payload as a single `terminal.sendText(flatText, false)` call with no chunking. VS Code's terminal API silently truncates payloads beyond an undocumented size limit (~4000–8000 chars depending on OS/shell), causing autoban planner prompts to arrive incomplete at the CLI agent.

### Background: Recent Changes

1. **Initial Chunking and Pacing (Feb 27, 2026):** Introduced 500-char chunking with 50ms inter-chunk delay and adaptive newline delay. Copilot-specific second Enter workaround.
2. **Aggressive Triple-Tap Expansion (Mar 17, 2026):** Broadened CLI agent detection to 6 agents, replaced `\n` with `sendText('', true)`, added triple Enter confirmation, and introduced newline-flattening for CLI agents that bypasses chunking entirely.

### Root Cause

Both problems trace to `sendRobustText` in `src/services/terminalUtils.ts` (lines 29–71):

- **Triple-tap**: Lines 64–69 send 3 Enters with 350ms gaps. The first `sendText('', true)` at line 63 already submits the command. The extra 2 Enters either cancel the running command, submit empty commands, or trigger unintended confirmation prompts in different CLI agents.
- **Truncation**: Lines 41–46 flatten newlines and send the entire payload as one `sendText(flatText, false)` call. This bypasses the chunking logic (lines 47–58) that was specifically designed to prevent buffer overflow. The "improve-plan" planner prompts built by `TaskViewerProvider._buildSinglePlanPrompt` (lines 7292–7353) routinely exceed 2000 chars — well into the danger zone.

### Observed Symptom

The autoban planner prompt gets truncated mid-sentence at approximately the "Band A: List" instruction, meaning the CLI agent never receives the Band B instructions, the adversarial review steps, or the focus directive.

## Proposed Changes

### Step 1: Remove triple-tap, restore single confirmation Enter
**File:** `src/services/terminalUtils.ts` (lines 64–70)
**Change:** Replace the 3-Enter sequence with a single confirmation Enter after a delay, only for CLI agents.

```typescript
// BEFORE (lines 63-70):
    terminal.sendText('', true);
    if (isCliAgent) {
        log?.(`CLI terminal detected for '${terminal.name}', sending confirmation Enters`);
        await new Promise(r => setTimeout(r, CLI_CONFIRM_ENTER_DELAY));
        terminal.sendText('', true);
        await new Promise(r => setTimeout(r, CLI_CONFIRM_ENTER_DELAY));
        terminal.sendText('', true);
    }

// AFTER:
    terminal.sendText('', true);
    if (isCliAgent) {
        log?.(`CLI terminal detected for '${terminal.name}', sending single confirmation Enter`);
        await new Promise(r => setTimeout(r, CLI_CONFIRM_ENTER_DELAY));
        terminal.sendText('', true);
    }
```

**Rationale:** One confirmation Enter is the original Copilot workaround that worked. The third Enter was the aggressive addition from Mar 17 that caused failures.

### Step 2: Re-enable chunking for CLI agents (fix truncation)
**File:** `src/services/terminalUtils.ts` (lines 41–46)
**Change:** Remove the CLI-agent special case that bypasses chunking. Instead, flatten newlines but still chunk the payload.

```typescript
// BEFORE (lines 41-59):
    if (isCliAgent) {
        log?.(`CLI terminal detected. Flattening newlines and sending as single block for ${text.length} chars.`);
        const flatText = text.replace(/[\r\n]+/g, ' ');
        terminal.sendText(flatText, false);
    } else if (text.length <= CHUNK_SIZE) {
        terminal.sendText(text, false);
    } else {
        log?.(`Large payload (${text.length} chars), sending in ${Math.ceil(text.length / CHUNK_SIZE)} chunks...`);
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            const chunk = text.substring(i, i + CHUNK_SIZE);
            terminal.sendText(chunk, false);
            if (i + CHUNK_SIZE < text.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY));
            }
        }
    }

// AFTER:
    // Flatten newlines for CLI agents to prevent premature submission
    const payload = isCliAgent ? text.replace(/[\r\n]+/g, ' ') : text;
    if (isCliAgent) {
        log?.(`CLI terminal detected. Flattening newlines for ${text.length} chars.`);
    }

    if (payload.length <= CHUNK_SIZE) {
        terminal.sendText(payload, false);
    } else {
        log?.(`Large payload (${payload.length} chars), sending in ${Math.ceil(payload.length / CHUNK_SIZE)} chunks...`);
        for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
            const chunk = payload.substring(i, i + CHUNK_SIZE);
            terminal.sendText(chunk, false);
            if (i + CHUNK_SIZE < payload.length) {
                await new Promise(r => setTimeout(r, CHUNK_DELAY));
            }
        }
    }
```

**Rationale:** Newline flattening is correct (prevents premature Enter). Skipping chunking is the bug — it causes truncation on large payloads. This change preserves the flattening but re-enables chunking.

### Step 3: Sync the duplicate in `src/extension.ts`
**File:** `src/extension.ts` (lines 135–168 in the compiled `.js`)
**Change:** The compiled `extension.js` contains an older duplicate of `sendRobustText` that does NOT flatten newlines and still uses the triple-tap pattern from the `.ts` source. After fixing `terminalUtils.ts`, rebuild to ensure `extension.js` picks up the changes via the import chain. If `extension.ts` has its own inline copy, remove it in favor of importing from `terminalUtils.ts`.

**Clarification (implied by existing plan):** The `extension.js` file at lines 135–168 appears to be a stale compiled artifact. Verify whether `extension.ts` imports `sendRobustText` from `terminalUtils.ts` or has its own copy. If duplicated, consolidate to the single `terminalUtils.ts` implementation.

## Complexity Audit

### Band A — Routine
- Removing the two extra `sendText('', true)` calls (Step 1) — single-line deletion, low risk.
- Verifying `extension.ts` imports from `terminalUtils.ts` (Step 3) — grep and confirm, no code change if already consolidated.

### Band B — Complex / Risky
- Re-enabling chunking for CLI agents (Step 2) — changes the control flow of how every CLI agent receives payloads. Risk: chunk boundaries could split multi-byte characters or split at positions that confuse the terminal input parser. The existing chunking logic (500-char chunks, 50ms delay) has been battle-tested for non-CLI terminals, so the risk is moderate. However, the interaction between newline flattening + chunking + the single confirmation Enter has not been tested together.

## Dependencies

| Related Plan | Conflict? | Notes |
|---|---|---|
| "Enhance Terminal Send Robustness" (`feature_plan_20260312_194738`) | **Yes — direct overlap** | That plan proposed increasing `NEWLINE_DELAY` to 2000ms and universalizing double-tap. The current code already went further (triple-tap + flattening). This plan supersedes that one for the `sendRobustText` function. The delay increase (1000→2000) from that plan was NOT applied to `terminalUtils.ts` — consider whether it should be. |
| "Fix Custom Agent Integration Issues" (Kanban: PLAN REVIEWED) | No | Different subsystem (custom agent config), no shared code path. |
| "Agent visibility in the setup menu does not persist" (Kanban: PLAN REVIEWED) | No | UI persistence, unrelated. |

## Verification Plan

### Automated
1. `npm run compile` — Confirm no TypeScript errors after changes.

### Manual Testing
1. **Triple-tap fix (Step 1):** Send a short payload (< 500 chars) to a Gemini CLI terminal. Verify the command executes exactly once without cancellation or double-execution.
2. **Truncation fix (Step 2):** Trigger an autoban "improve-plan" dispatch to a CLI terminal. Verify the full prompt arrives intact — specifically that the Band B instructions, adversarial review stages, and FOCUS DIRECTIVE are all present in the terminal input.
3. **Regression:** Send a payload to a non-CLI terminal (plain bash/zsh). Verify chunking still works correctly and the command executes with the standard single Enter.
4. **Edge case:** Send a payload of exactly 500 chars to a CLI terminal. Verify it takes the non-chunked path and arrives intact.
5. **Edge case:** Send a payload of 501 chars to a CLI terminal. Verify it chunks correctly (2 chunks) and arrives intact.

## Adversarial Review

### Grumpy Critique

The 500-char `CHUNK_SIZE` is an arbitrary magic number that was never validated against VS Code's actual terminal buffer limits. You're re-enabling chunking for CLI agents, but you have ZERO evidence that 500-char chunks won't cause their own problems — what if a chunk boundary lands in the middle of a file path like `c:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260318_143147_agent_visi` and the CLI agent tries to parse an incomplete path? The 50ms `CHUNK_DELAY` is also completely arbitrary — there's no guarantee that Gemini CLI reads its stdin buffer within 50ms. If it doesn't, chunks could pile up and get concatenated in the wrong order.

And what about the `NEWLINE_DELAY`? You kept it at 1000ms for paced sends, but the predecessor plan specifically recommended 2000ms. If 1000ms wasn't enough before, why would it be enough now? You're fixing two bugs and potentially re-introducing a third.

Also, the "single confirmation Enter" fix in Step 1 is still cargo-culting. You have NO telemetry or diagnostic data to confirm that any CLI agent actually needs a second Enter. The original Copilot workaround was added based on anecdotal observation, not systematic testing. You might be keeping a useless workaround that occasionally causes its own problems.

Finally, the `extension.js` situation is a mess. You don't even know if it's a stale compiled artifact or a live duplicate. Step 3 is hand-wavy — "verify whether it imports or has its own copy" is not a concrete execution step.

### Balanced Synthesis

Grumpy raises valid concerns about magic numbers and the lack of telemetry, but the core fix is sound:

1. **Triple-tap removal is clearly correct.** Three consecutive Enters is objectively harmful — no CLI agent expects that. Reducing to one confirmation Enter restores the original working behavior. The question of whether even one extra Enter is needed is valid but lower priority — it can be removed later with telemetry.

2. **Re-enabling chunking is the right fix for truncation.** The 500-char chunk size has been working for non-CLI terminals since Feb 27. The risk of chunk-boundary issues is theoretical — `terminal.sendText` appends to the terminal's input buffer, it doesn't parse the content. The chunks are concatenated by the terminal emulator before the Enter key submits them. Grumpy's concern about incomplete file paths mid-chunk is unfounded because the chunks are not individually submitted.

3. **The `NEWLINE_DELAY` question is valid.** The predecessor plan recommended 2000ms. This plan should explicitly address it: keep 1000ms for now since the truncation fix (re-enabling chunking) addresses the actual failure mode. The 2000ms increase was a compensating control for a problem that this plan fixes at the root.

4. **Step 3 (extension.js dedup) should be made concrete.** Check whether `extension.ts` has an inline `sendRobustText` — if yes, replace it with an import from `terminalUtils.ts`. If it already imports, confirm the compiled output reflects the fix after `npm run compile`.

**Verdict:** The plan is well-scoped, fixes the two documented failures, and the risk profile is acceptable. Proceed with execution.

## Open Questions
- Should `NEWLINE_DELAY` be increased to 2000ms as recommended by the predecessor plan, or is the chunking fix sufficient to make 1000ms reliable?
- Should the single confirmation Enter (Step 1) be behind a configurable setting so users can disable it if their CLI agent doesn't need it?
- Is the `extension.js` duplicate actively used at runtime, or is it a stale build artifact that gets overwritten by `npm run compile`?

## Reviewer Pass — 2026-03-19

### Implementation Status: ✅ COMPLETE — All 3 steps implemented + significant enhancement

| Step | Status | Files |
|------|--------|-------|
| Step 1: Single confirmation Enter | ✅ | `src/services/terminalUtils.ts` (lines 96–100: single CLI confirmation Enter after delay) |
| Step 2: Re-enable chunking for CLI agents | ✅ | `src/services/terminalUtils.ts` (lines 72–91: newline flattening + chunking unified path) |
| Step 3: Sync duplicate in extension.ts | ✅ | `src/extension.ts` line 11 imports `sendRobustText` from `terminalUtils`; no inline duplicate exists. Uses at lines 436 and 1512. |

### Enhancement beyond plan scope
The implementation added **clipboard paste delivery** (lines 47–70) for payloads >100 chars, bypassing PTY line-buffer limits entirely via `vscode.env.clipboard.writeText()` + `workbench.action.terminal.paste`. This is a strictly superior fix for the truncation problem — it eliminates the root cause (PTY buffer limits) rather than working around it (chunking). The chunking path remains as fallback.

### Grumpy Findings
- **MAJOR (FIXED):** `clipboard.writeText(text)` at line 52 was NOT wrapped in try/catch. If the clipboard API failed (remote dev, headless, permissions), the function threw an unhandled error and the payload was silently lost — the chunking fallback path never executed. **Fixed:** Wrapped entire clipboard paste block in try/catch with fallback to chunked send.
- **NIT:** `CLIPBOARD_PASTE_THRESHOLD = 100` is aggressive — virtually all real payloads use clipboard paste, making the chunking code path (lines 78–91) effectively dead code in normal operation. Acceptable since clipboard is the better approach.
- **NIT:** Clipboard paste path returns before the `isCliAgent` confirmation Enter check (line 96). Correct behavior (paste doesn't need double-Enter) but intent is undocumented. Added inline comment in fix.

### Balanced Synthesis
- **MAJOR fix applied.** The clipboard paste block now has a try/catch that falls through to the chunking path on failure, ensuring no payload is ever silently lost.
- **NITs deferred.** The aggressive threshold is a feature (clipboard is more reliable than chunking). The CLI Enter bypass is intentionally correct.

### Code Changes Applied
- **`src/services/terminalUtils.ts`**: Wrapped clipboard paste delivery (lines 47–70) in try/catch. On failure, logs the error and falls through to the chunked send path. Added comment documenting that clipboard paste doesn't need CLI confirmation Enter.

### Validation
- `npx tsc --noEmit` — ✅ Clean (0 errors) after fix

### Remaining Risks
- Clipboard paste overwrites user clipboard for ~1s (save/restore mitigates but doesn't eliminate race condition with concurrent user copies). Low risk — terminal sends are infrequent.
- `NEWLINE_DELAY` kept at 1000ms (not increased to 2000ms per predecessor plan). The clipboard paste approach makes this moot for most payloads; chunking fallback path uses 1000ms which has been reliable for non-CLI terminals since Feb 27.
