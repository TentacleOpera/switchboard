# Make Kanban Complexity Detector More Lenient

## Goal
Update the `_getComplexityFromPlan` method in the Kanban provider to correctly classify a plan as "Low" complexity when the "Band B" section starts with "None" (or equivalents like "N/A"), even if explanatory text follows it (e.g., "None. This is an isolated presentation-layer update.").

## User Review Required
> [!NOTE] 
> This alters the internal parsing logic for Kanban cards. Plans that were previously showing as "High" complexity due to extra text after "None" will now correctly display as "Low".

## Complexity Audit
### Band A — Routine
* Updating the string normalization logic in `src/services/KanbanProvider.ts` to use a more permissive, start-anchored Regular Expression rather than an absolute strict-equality string match.

### Band B — Complex / Risky
* None. This is an isolated string-parsing adjustment.

## Edge-Case Audit
* **Race Conditions:** None.
* **Security:** None.
* **Side Effects:** If the regex is too loose (e.g., just checking `startsWith('none')`), a plan that starts with "Nonetheless, this requires a major database migration..." might accidentally get flagged as "Low" complexity. The regex must enforce a word boundary or punctuation after the target word.

## Adversarial Synthesis
### Grumpy Critique
You are switching from a basic string match to a complex regex that checks for boundary punctuation. But what if the agent writes `None - this is easy`? Your regex `($|[\s\.,;:!?]+)` allows white space, but will it match the hyphen as punctuation? Wait, you put `—|-` in the capture group instead of the boundary! That means `None-` won't match correctly! Regex is notoriously hard to get right on the first try, you should just write a robust tokenizing function instead!

### Balanced Response
Grumpy is right to be paranoid about regex edge cases, but writing a full custom tokenizer for a single markdown section is over-engineering. The proposed regex `^[\*\-\`\s]*(none|n\/?a|—|-)($|[\s\.,;:!?]+)/i` explicitly includes hyphens in the *capture group* to handle cases where the section is entirely empty save for a dash. However, if the text is `None - easy`, the space after `None` matches the `[\s]` boundary condition perfectly, so the regex will successfully trigger. We will thoroughly verify these exact string permutations in the manual testing phase to ensure the logic holds.

## Proposed Changes

### Kanban Provider Backend
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `_getComplexityFromPlan` function determines Band B complexity by fully stripping all punctuation/spaces and checking for a strict string match to `none`, `na`, etc.
- **Logic:** Replace the `normalizedBandB` absolute equality check with a start-anchored Regex test (`/^[\*\-\`\s]*(none|n\/?a|—|-)($|[\s\.,;:!?]+)/i`) that allows trailing explanations while strictly enforcing the boundary of the keyword.
- **Implementation:** See Appendix.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify syntax.

### Manual Testing
1. Create a plan file containing:
   ```markdown
   ### Band B — Complex / Risky
   - None. This is a simple UI change.
   ```
2. Open the Kanban board and verify the card accurately shows **Complexity: Low**.
3. Change the plan file to:
   ```markdown
   ### Band B — Complex / Risky
   - Nonetheless, we must update the state engine.
   ```
4. Refresh the board and verify the card accurately shows **Complexity: High**.

---

## Appendix: Implementation Patch

Apply the following patch to `src/services/KanbanProvider.ts`:

```diff
--- src/services/KanbanProvider.ts
+++ src/services/KanbanProvider.ts
@@ -... +... @@
         const bandBContent = nextSection
             ? afterBandB.slice(0, nextSection.index).trim()
             : afterBandB.trim();
 
-        // Treat Band B as empty only when the entire section collapses to a known empty marker.
-        const normalizedBandB = bandBContent.replace(/[\*\-\`\s\.]/g, '').toLowerCase();
-        const isEmpty = normalizedBandB === ''
-            || normalizedBandB === 'none'
-            || normalizedBandB === 'na'
-            || normalizedBandB === '—'
-            || normalizedBandB === '-';
+        // Treat Band B as empty if it is completely blank or explicitly starts with a "None" marker
+        // (ignoring markdown list chars), even if explanatory text follows it.
+        const isEmptyRegex = /^[\*\-\`\s]*(none|n\/?a|—|-)($|[\s\.,;:!?]+)/i;
+        const isEmpty = bandBContent === '' || isEmptyRegex.test(bandBContent);
         
         return isEmpty ? 'Low' : 'High';
     } catch {
```

***

Would you like me to dispatch this plan to the Lead Coder agent so they can implement these changes?