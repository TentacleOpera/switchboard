# Enhance Terminal Send Robustness (Universal Double-Tap & Delay Tuning)

## Goal
Improve the reliability of sending payloads to CLI terminals by increasing the pacing delay (`NEWLINE_DELAY`) from 1000ms to 2000ms, and standardizing the "double-tap" (second enter) mechanism across all terminals. This prevents dropped execution commands caused by terminal buffer lag.

## User Review Required
> [!NOTE]
> This change will increase the time it takes for an agent's payload to officially execute in the terminal by roughly ~1-1.5 seconds. Users may notice a slight pause after the text is pasted before the command actually runs.

## Complexity Audit

### Band A — Routine
- Updating `NEWLINE_DELAY` constants to `2000`.
- Removing the terminal name regex checks (e.g., `isCliAgent`) in favor of an unconditional universal double-tap in both `src/extension.ts` and `src/services/terminalUtils.ts`.

### Band B — Complex / Risky
- None. This is a targeted tuning of timing constants and conditional logic.

## Edge-Case Audit
- **Race Conditions:** Delaying the execution might cause an impatient user to think the terminal is stuck and press enter themselves, causing a triple-tap.
- **Security:** None.
- **Side Effects:** Standard shells (like pure `bash` or `zsh` not actively running an AI CLI) will receive a second newline, resulting in an extra empty prompt line being printed. This is cosmetically messy but functionally harmless.

## Adversarial Synthesis

### Grumpy Critique
Increasing the delay to 2 seconds is annoying and makes the extension feel sluggish! And applying a double-tap to *every* terminal means standard bash shells will just print an extra empty prompt line. Plus, why are we updating two identical functions in `extension.ts` and `terminalUtils.ts`? The technical documentation explicitly calls out this duplication as tech debt! We should consolidate them!

### Balanced Response
Grumpy is right about the tech debt. There are indeed duplicate robust terminal send implementations. However, consolidating them requires a larger refactor of the extension's dependencies. To keep this implementation focused and safe, we will apply the fix to both files to ensure parity. The extra empty prompt in standard bash is a negligible side effect compared to the critical failure of dropped inputs in AI CLIs. The 2000ms delay is a necessary trade-off for stability since we cannot natively read the terminal buffer state.

## Proposed Changes

### `src/extension.ts`
#### [MODIFY] `src/extension.ts`
- **Context:** The current robust text sender tries to guess if a terminal needs a second enter based on its name (e.g., matching `copilot`, `gemini`, etc.).
- **Logic:** 
  1. Locate the `NEWLINE_DELAY` constant (usually around 1000) and change it to `2000`.
  2. Locate the `terminal.sendText('', true)` execution block. Remove the `isCliAgent` regex check entirely and make the `COPILOT_SECOND_ENTER_DELAY` and second `terminal.sendText('', true)` run for *all* terminals.
- **Implementation:** Remove the `if (isCliAgent || needsSecondEnter)` wrapper and just run the delay and second enter.

### `src/services/terminalUtils.ts`
#### [MODIFY] `src/services/terminalUtils.ts`
- **Context:** This is the duplicate implementation used by other parts of the system.
- **Logic:** Apply the exact same logic. Change `NEWLINE_DELAY` to `2000` and remove the `if (needsSecondEnter)` conditional, applying the double-tap universally.

## Verification Plan

### Automated Tests
- Run `npm run compile` to verify there are no syntax errors introduced.

### Manual Testing
1. Open a Switchboard workspace and trigger a heavy payload (e.g., an `enhance` prompt) into an Antigravity or Gemini CLI terminal.
2. Observe the terminal pacing. Verify the text pastes in chunks, followed by a 2-second pause, followed by an execution trigger.
3. Verify the agent begins processing without requiring a manual 'Enter' keypress.
4. Test sending a message to a standard bash/zsh terminal to verify it safely handles the double-tap (should just print a blank prompt line).

## Appendix: Implementation Patch
```diff
--- src/extension.ts
+++ src/extension.ts
@@ -... +... @@
- const NEWLINE_DELAY = 1000;
+ const NEWLINE_DELAY = 2000;
  const COPILOT_SECOND_ENTER_DELAY = 350;
@@ -... +... @@
  await new Promise(r => setTimeout(r, NEWLINE_DELAY));
  terminal.sendText('', true);
  
- const isCliAgent = /\b(copilot|gemini|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);
- if (isCliAgent || needsSecondEnter) {
-     await new Promise(r => setTimeout(r, COPILOT_SECOND_ENTER_DELAY));
-     terminal.sendText('', true);
- }
+ await new Promise(r => setTimeout(r, COPILOT_SECOND_ENTER_DELAY));
+ terminal.sendText('', true);

--- src/services/terminalUtils.ts
+++ src/services/terminalUtils.ts
@@ -... +... @@
- const NEWLINE_DELAY = 1000;
+ const NEWLINE_DELAY = 2000;
  const COPILOT_SECOND_ENTER_DELAY = 350;
@@ -... +... @@
  await new Promise(r => setTimeout(r, NEWLINE_DELAY));
- terminal.sendText('\n', false);
- if (needsSecondEnter) {
-     log?.(`Copilot terminal detected for '${terminal.name}', sending confirmation Enter`);
-     await new Promise(r => setTimeout(r, COPILOT_SECOND_ENTER_DELAY));
-     terminal.sendText('\n', false);
- }
+ terminal.sendText('', true);
+ await new Promise(r => setTimeout(r, COPILOT_SECOND_ENTER_DELAY));
+ terminal.sendText('', true);
```

## Review Feedback
- **Grumpy Review:** Why are we blindly changing delays to 2000ms everywhere?! Magic numbers are the devil's playthings! You admit there's technical debt with duplicate robust terminal send implementations, but instead of fixing it, you're just doubling down and changing the magic number in two places! And forcing a double-tap on *all* terminals? That's sloppy engineering. What if a command in a standard shell triggers something unintended with an extra newline? You're trading one race condition for a bunch of cosmetic, and potentially functional, side effects just because you're too lazy to refactor!
- **Balanced Synthesis:** Grumpy's frustration with magic numbers and technical debt is justified. Consolidating the duplicate implementations should absolutely be prioritized in a future technical debt sprint. However, the current issue of dropped payloads in AI CLIs is a critical user experience failure that needs immediate mitigation. The 2000ms delay and universal double-tap, while somewhat brute-force and introducing minor cosmetic side effects in standard shells, provide a highly reliable stopgap to stabilize the core product functionality without requiring a massive architectural refactor right now. The plan is an acceptable tactical fix.

Would you like me to dispatch this plan to the Lead Coder agent so they can implement and verify the changes?