# Replace keyword-matching consent probe with generic echo-detection signal

## Goal

The consent probe (`scripts/probe-cli-consent.js`) detects blocking surfaces by keyword-matching prompt wording (line 227–235):

```javascript
const hasTrustOrConsentPrompt =
    /trust this (folder|directory|workspace)/i.test(rawBuffer) ||
    /do you trust/i.test(rawBuffer) ||
    /terms of service/i.test(rawBuffer) ||
    /1\.\s*Yes[\s\S]{0,240}?\d\.\s*No\b/i.test(rawBuffer) ||
    /remember this folder/i.test(rawBuffer) ||
    /Enter to select/i.test(rawBuffer);
```

This approach missed claude's first-run theme picker (`1. Auto / 2. Dark mode / 3. Light mode …`), which blocks a seat exactly as hard as a trust menu but uses none of the keywords. Enumerating prompt wording will keep missing new modals — every new CLI or version can introduce a new blocking surface with different wording.

A generic "typed input did not echo within N seconds ⇒ seat is blocked" signal would be sounder. This is the same signal the sibling detection plan needs: a seat is ready when typed input echoes, and blocked when it does not. The probe already captures `typedEchoed` (line 224) and uses it in the verdict (line 256: `typedEchoed ? 'CLEAR' : 'NO_PROMPT_NO_ECHO'`), but the `PROMPT_BLOCKED` verdict is still gated on keyword matching.

**Root cause:** The probe has two independent signals — keyword matching (fragile, enumerates wording) and echo detection (robust, generic). The verdict logic combines them as `hasTrustOrConsentPrompt ? 'PROMPT_BLOCKED' : (typedEchoed ? 'CLEAR' : 'NO_PROMPT_NO_ECHO')`. This means:
- If keywords match but input echoes: `PROMPT_BLOCKED` (wrong — the seat is ready).
- If keywords don't match and input doesn't echo: `NO_PROMPT_NO_ECHO` (correct but mislabeled — the seat IS blocked, just not by a recognized prompt).
- If keywords don't match and input echoes: `CLEAR` (correct).

The fix: make echo detection the primary signal. A seat is blocked if typed input does not echo within N seconds, regardless of what text the CLI rendered. The keyword matching becomes a secondary diagnostic (reported in the output but not gating the verdict).

## Metadata

**Complexity:** 5
**Tags:** cli, refactor, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Change the verdict logic to use echo detection as the primary signal.
- Keep keyword matching as a diagnostic field (reported but not gating).
- Update the docs table to reflect the new verdict semantics.

**Complex/Risky:**
- The `NO_PROMPT_NO_ECHO` verdict currently means "no recognized prompt, but input didn't echo." Under the new logic, this becomes `BLOCKED` (or `SEAT_BLOCKED`) — a stronger and more accurate verdict. Must update the docs table and any consumers that branch on the verdict string.
- The `INCONCLUSIVE` verdict (no output or no typed input) must remain separate — it means the probe didn't measure anything, not that the seat is blocked.
- The echo detection has a timing dependency: the probe types characters after a settle period (default 2500ms) or after a readiness marker (`>`, `❭`, `?`). If the CLI renders a modal that doesn't include these markers, the probe falls back to the settle timer. This is already handled but should be verified.
- Some CLIs may not echo typed input even when ready (e.g., password prompts). The probe types `abcdefgh` (printable chars), so this should not be an issue for the trust/consent use case.

## Edge-Case & Dependency Audit

- **`scripts/probe-cli-consent.js` verdict logic (line 254–256):** The current logic:
  ```javascript
  verdict: inconclusive ? 'INCONCLUSIVE' : (hasTrustOrConsentPrompt ? 'PROMPT_BLOCKED' : (typedEchoed ? 'CLEAR' : 'NO_PROMPT_NO_ECHO'))
  ```
  New logic:
  ```javascript
  verdict: inconclusive ? 'INCONCLUSIVE' : (typedEchoed ? 'CLEAR' : 'BLOCKED')
  ```
  The `hasTrustOrConsentPrompt` field remains in the report as a diagnostic.
- **`docs/AGENT_CLI_CONSENT_FLAGS.md`:** The table uses verdict labels like `PROMPT_BLOCKED`, `CLEAR`, `NO_PROMPT_NO_ECHO`. Under the new logic, `PROMPT_BLOCKED` and `NO_PROMPT_NO_ECHO` both become `BLOCKED`. The table must be updated.
- **Sibling detection plan:** The echo-detection signal is the same signal needed for sibling terminal detection. This change aligns the probe with that plan's approach.
- **`--settle` and `--timeout` options:** The probe window (default 15s) and settle delay (default 2500ms) affect whether the echo check runs. If the CLI renders slowly, the probe may type before the CLI is ready, and the input won't echo. The `--settle` and `--timeout` flags allow tuning this. Issue 12 addresses the probe window being too short for some CLIs.

## Proposed Changes

### 1. `scripts/probe-cli-consent.js` — make echo detection the primary signal

Change the verdict logic (line 254–256):

```javascript
const report = {
    cli: cliBinary,
    args: options.cliArgs,
    configType: options.configType || null,
    configWritten,
    strippedEnv,
    durationMs: elapsedMs(),
    statusReason,
    verdict: inconclusive
        ? 'INCONCLUSIVE'
        : (typedEchoed ? 'CLEAR' : 'BLOCKED'),
    inconclusiveReason,
    hasTrustOrConsentPrompt,  // kept as diagnostic, no longer gating
    promptKeywordsMatched: hasTrustOrConsentPrompt,  // renamed for clarity
    typedSent,
    typedEchoed,
    bufferHead: escapeCtl(rawBuffer.slice(0, 1200)),
    bufferTail: rawBuffer.length > 1200 ? escapeCtl(rawBuffer.slice(-1200)) : '',
};
```

### 2. Update the keyword matching to be diagnostic-only

Keep the keyword matching (line 227–235) but rename the variable and add it to the report as `promptKeywordsMatched` — a diagnostic field that tells the operator WHAT blocked the seat, not WHETHER it is blocked.

### 3. `docs/AGENT_CLI_CONSENT_FLAGS.md` — update verdict labels

Update the table and prose to use the new verdict semantics:
- `CLEAR` = typed input echoed (seat is ready).
- `BLOCKED` = typed input did not echo (seat is blocked by any modal — trust, ToS, theme picker, auth, etc.).
- `INCONCLUSIVE` = probe did not measure (no output or no typed input).

The `NO_PROMPT_NO_ECHO` and `PROMPT_BLOCKED` labels are replaced by `BLOCKED`.

## Verification Plan

1. Run `node scripts/probe-cli-consent.js gemini` — assert verdict is `BLOCKED` (gemini blocks on trust dialog, input doesn't echo).
2. Run `node scripts/probe-cli-consent.js gemini --cli-args "--skip-trust"` — assert verdict is `BLOCKED` (trust gate cleared but auth picker blocks, input doesn't echo) or `CLEAR` (if auth is pre-configured).
3. Run `node scripts/probe-cli-consent.js claude` — assert verdict is `BLOCKED` (theme picker blocks, input doesn't echo). Verify `promptKeywordsMatched` is `false` (the theme picker doesn't match any keywords — this is the bug that was fixed).
4. Run `node scripts/probe-cli-consent.js droid --settle 6000 --timeout 40000` — assert verdict is `CLEAR` (droid echoes input after settling).
5. Verify the docs table is updated with the new verdict labels.
6. Run the probe on all CLIs in the table and verify the verdicts are consistent with the updated docs.
