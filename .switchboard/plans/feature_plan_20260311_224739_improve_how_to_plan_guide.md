# Maximize Detail and Prevent Truncation in AI Feature Plans

## Goal
Update the Airlock "How to Plan" template to enforce maximum context usage, strictly ban code truncation placeholders (like `// ... existing code ...`), and require deep logical breakdowns before code snippets. This prevents AI agents from generating "lazy" or incomplete implementation specs.

## User Review Required
> [!NOTE]
> This modifies the template generator in the backend extension code. You will need to rebuild the extension or manually update the compiled `.js` file to see the changes take effect in the live UI.

## Complexity Audit

### Band A — Routine
- Update the string array inside the `_handleAirlockExport` method in `TaskViewerProvider.ts` to replace the "Exhaustive Implementation Spec" and "Proposed Changes" sections with stricter, anti-truncation prompt constraints.

### Band B — Complex / Risky
- None. This is a static string template modification.

## Edge-Case Audit
- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** 
  - *Context Window Bloat:* If an agent is told NEVER to truncate, it might attempt to output an entire 2,000-line file instead of a focused patch. We mitigate this by specifically instructing the agent to use "Exact search/replace blocks or unified diffs" combined with "full function rewrites" rather than demanding the entire file.

## Adversarial Synthesis

### Grumpy Critique
Banning `// ... existing code` is dangerous! If we force the AI to rewrite a massive file just to change 2 lines, we'll blow out the token context, trigger output limits, and fail the completion protocol! Furthermore, adding all these mandatory bullet points (`Context`, `Logic`, `Implementation`) to every single file change is going to make the plans ridiculously long and annoying to read.

### Balanced Response
Grumpy raises a valid point about token limits. However, the prompt specifically requests "search/replace blocks or unified diffs". By banning truncation, we are specifically targeting the *functions* being modified, preventing the coder agent from copying a half-written function into the codebase. The added verbosity (Context, Logic, Implementation) is an intentional trade-off: forcing the LLM to write out its reasoning step-by-step *before* generating the code significantly reduces hallucinations and logical errors in the final output.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** The current template allows AI agents too much leeway to summarize code, resulting in incomplete handoffs.
- **Logic:** We will rewrite the string array defining the `how_to_plan.md` export. We will add explicit "**NO TRUNCATION**" directives to Step 5, and we will replace the generic bullet points under "Proposed Changes" with a strict structure (`Context`, `Logic`, `Implementation`, `Edge Cases Handled`).
- **Edge Cases Handled:** To prevent full-file dumps, the instructions explicitly keep the focus on diffs and function-level rewrites.

## Verification Plan

### Manual Testing
1. Apply the patch to `TaskViewerProvider.ts` (and `TaskViewerProvider.js` if running a live debug session).
2. Restart the extension host if necessary.
3. Open the Switchboard sidebar and navigate to the **Airlock** tab.
4. Click **BUNDLE CODE**.
5. Open the newly generated `.switchboard/handoff/how_to_plan.md` file.
6. Verify that the strict **NO TRUNCATION** rules appear in Step 5, and the new granular bullet points appear under the Proposed Changes template.

***

## Appendix: Implementation Patch

Apply the following patch to `src/services/TaskViewerProvider.ts` (inside the `_handleAirlockExport` method):

```diff
--- src/services/TaskViewerProvider.ts
+++ src/services/TaskViewerProvider.ts
@@ -... +... @@
- '## 5. Exhaustive Implementation Spec',
- 'Produce a complete, copy-paste-ready implementation spec. You must create plans in raw markdown formatting in a single block. Use your full context window. Include:',
- '- Exact search/replace blocks or unified diffs for every file change',
- '- New file contents in full where applicable',
- '- Inline comments explaining non-obvious logic',
- '- A short verification checklist (manual steps to confirm the change works)',
+ '## 5. Exhaustive Implementation Spec',
+ 'Produce a complete, copy-paste-ready implementation spec. You must maximize your context window to provide the highest level of detail possible. Include:',
+ '- Exact search/replace blocks or unified diffs for EVERY file change.',
+ '- **NO TRUNCATION:** You are strictly forbidden from using placeholders like `// ... existing code` or `// ... implement later`. Write out the exact, final state of the functions being modified.',
+ '- Deep logical breakdowns explaining the *Why* behind every architectural choice.',
+ '- Inline comments explaining non-obvious logic',
  '',
  '---',
  '',
  '## Plan Template',
@@ -... +... @@
  '',
  '## Proposed Changes',
+ '> [!IMPORTANT]',
+ '> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing the code.',
+ '',
  '### [Target File or Component 1]',
  '#### [MODIFY / CREATE / DELETE] `path/to/file.ext`',
- '- [Explicit, step-by-step instructions on what to change]',
- '- [Include how to handle the edge cases discovered above]',
+ '- **Context:** [Explain exactly why this file needs to be changed]',
+ '- **Logic:** [Provide a granular, step-by-step breakdown of the logical changes required]',
+ '- **Implementation:** [Provide the COMPLETE code block, unified diff, or full function rewrite without any truncation]',
+ '- **Edge Cases Handled:** [Explain how the code above mitigates the risks identified in the Edge-Case Audit]',
```

*(Note: Apply the exact same string changes to the compiled `src/services/TaskViewerProvider.js` file if you want to test it immediately without a build step).*