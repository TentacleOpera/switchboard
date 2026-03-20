# Update complexity kanban detector language

## Goal
Update the `_getComplexityFromPlan` logic in the Kanban Provider to accurately parse agent-added contextual language (e.g., `Band B (Architectural): N/A.`). Additionally, fix a severe logical flaw introduced in a prior iteration where markdown bullet points (hyphens/dashes) were being falsely evaluated as empty markers, causing actual tasks to be incorrectly flagged as `Low` complexity.

## User Review Required
> [!NOTE] 
> This alters the internal parsing logic for Kanban cards. Plans that were previously showing as "High" complexity due to prefixes like `(Architectural):` will now correctly display as "Low".
> [!WARNING] 
> This also fixes a regression where real Band B tasks starting with a hyphen (e.g., `- Implement OAuth`) were being incorrectly categorized as `Low`. Some cards may shift from `Low` back to `High` upon refresh as the system correctly detects their contents again.

## Complexity Audit
### Band A — Routine
* Updating the string normalization logic and regex conditions in `src/services/KanbanProvider.ts`.

### Band B — Complex / Risky
* None. This is an isolated string-parsing adjustment.

## Edge-Case Audit
* **Race Conditions:** None.
* **Security:** None.
* **Side Effects:** The previous `isEmptyRegex` included `—|-` inside its capturing group, which matched the first hyphen of *any* bulleted list, triggering a false `Low`. Removing this ensures bulleted lists containing actual tasks evaluate to `High`.

## Adversarial Synthesis
### Grumpy Critique
Your "cleanContent" chain of string replacements is incredibly brittle! You are replacing `^\s*\([^)]+\)/i` which assumes the agent will perfectly balance its parentheses at the very start of the string. If the agent writes `Band B - (Complex) [Risky] : None`, your regex will miss the brackets entirely! Why don't you just use an LLM call to evaluate the complexity instead of trying to parse natural language with regex?

### Balanced Response
Grumpy's suggestion to use an LLM call is architecturally sound but practically flawed for this specific use case. The Kanban board must be able to instantly derive complexity for dozens of cards synchronously during a render cycle. Firing off 20 LLM calls just to read a markdown header would grind the UI to a halt and consume massive token budgets. The regex replacements, while theoretically brittle to extreme hallucinations, cover 99% of the observed agent outputs based on their current system prompts. If an agent outputs something wildly malformed, it defaults to "High" complexity, which is the safest fail-state.

## Proposed Changes

### Kanban Provider Backend
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `_getComplexityFromPlan` function incorrectly parses agent-injected prefixes and falsely matches standard hyphens as `none` markers.
- **Logic:** 
  1. Add a sanitization step (`cleanContent`) that strips `— Complex / Risky`, `(...)`, and trailing colons from the start of the `bandBContent`.
  2. Remove `—|-` from the `isEmptyRegex` word group so it only matches `none` or `n/a`.
  3. Add an `isJustDashes` fallback to catch truly empty lines containing only markdown formatting.
- **Implementation:** See Appendix.

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify syntax.

### Manual Testing
1. Create a plan file containing:
   ```markdown
   ### Band B — Complex / Risky
   - Update the database schemas
   ```
2. Open the Kanban board and verify the card correctly shows **Complexity: High** (Fixes the dash regression).
3. Change the plan file to:
   ```markdown
   ### Band B (Architectural): N/A.
   ```
4. Refresh the board and verify the card correctly shows **Complexity: Low**.
5. Change the plan file to:
   ```markdown
   ### Band B: None
   ```
6. Refresh the board and verify the card correctly shows **Complexity: Low**.

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
 
-        // Treat Band B as empty if it is completely blank or explicitly starts with a "None" marker
-        // (ignoring markdown list chars), even if explanatory text follows it.
-        const isEmptyRegex = /^[\*\-\`\s]*(none|n\/?a|—|-)($|[\s\.,;:!?]+)/i;
-        const isEmpty = bandBContent === '' || isEmptyRegex.test(bandBContent);
+        // Strip known boilerplate and inline prefixes from the start of the content
+        const cleanContent = bandBContent
+            .replace(/^\s*(?:—|-)\s*Complex\s*\/\s*Risky/i, '')
+            .replace(/^\s*\([^)]+\)/i, '')
+            .replace(/^\s*:/, '')
+            .trim();
+
+        // Treat Band B as empty if it is completely blank, just punctuation, or explicitly starts with a "None" marker.
+        const isEmptyRegex = /^[\*\-\`\s]*(none|n\/?a)($|[\s\.,;:!?]+)/i;
+        const isJustDashes = /^[\*\-\`\s]*$/.test(cleanContent);
+        const isEmpty = cleanContent === '' || isJustDashes || isEmptyRegex.test(cleanContent);
         
         return isEmpty ? 'Low' : 'High';
     } catch {
```