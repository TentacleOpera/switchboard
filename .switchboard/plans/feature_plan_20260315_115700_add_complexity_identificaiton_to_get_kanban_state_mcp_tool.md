# Add complexity identification to get_kanban_state MCP tool

## Notebook Plan

the mcp tool get_kanban_state needs to identify plans by complexity, since a request may be 'code all the low complexity plans'

## Goal
- Add a `complexity` field to each plan item returned by the `get_kanban_state` MCP tool.
- Enable agents to filter plans by complexity (e.g., "code all low complexity plans").

## Source Code Verification (2026-03-15)

### Current `get_kanban_state` output — `src/mcp-server/register-tools.js:1963-1967`
```javascript
columns[col].push({
    topic: sheet.topic || sheet.planFile || 'Untitled',
    sessionId: sheet.sessionId,
    createdAt: sheet.createdAt
});
```
No `complexity` field is included.

### Complexity source of truth — `src/services/KanbanProvider.ts:406-441`
`getComplexityFromPlan()` determines complexity by parsing the plan markdown file:
- Looks for a `## Complexity Audit` section.
- If `Band B` is empty/None → `'Low'`. If Band B has content → `'High'`. No audit section → `'Unknown'`.
- This method reads the plan file from disk and parses it. It is **async** and involves file I/O.

### Key finding: Complexity is NOT in session JSON
Session JSON files (`sess_*.json`) do not contain a `complexity` field. Complexity is derived **on-the-fly** from the plan markdown by `getComplexityFromPlan()`. There is no pre-extracted structured data source.

### Performance consideration
The MCP `get_kanban_state` tool currently uses **synchronous** `fs.readFileSync` for session files (line 1948). Adding async plan file reads for complexity would require either:
- (A) Making the tool async-aware and reading plan files during the loop, or
- (B) Pre-caching complexity in the session JSON when the plan is reviewed.

## Proposed Changes

### Step 1 — Add synchronous complexity parsing to `get_kanban_state` (Complex)
- **File:** `src/mcp-server/register-tools.js`
- **Lines 1945-1968:** Inside the session file loop, after reading the `sheet` object:
  1. Resolve the plan file path from `sheet.planFile`.
  2. Read the plan file content with `fs.readFileSync` (already synchronous pattern in this function).
  3. Apply the same complexity detection logic as `KanbanProvider.getComplexityFromPlan`:
     ```javascript
     function getComplexityFromContent(content) {
         if (!content) return 'unknown';
         const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
         if (!auditMatch) return 'unknown';
         const afterAudit = content.slice(auditMatch.index + auditMatch[0].length);
         const bandBMatch = afterAudit.match(/\bBand\s+B\b/i);
         if (!bandBMatch) return 'low';
         const bandBStart = bandBMatch.index + bandBMatch[0].length;
         const afterBandB = afterAudit.slice(bandBStart);
         const nextSection = afterBandB.match(/^#{1,4}\s|\bBand\s+[C-Z]\b/im);
         const bandBContent = nextSection
             ? afterBandB.slice(0, nextSection.index).trim()
             : afterBandB.trim();
         const isEmptyRegex = /^[\*\-\`\s]*(none|n\/?a|\u2014|-)($|[\s\.,;:!?]+)/i;
         return (bandBContent === '' || isEmptyRegex.test(bandBContent)) ? 'low' : 'high';
     }
     ```
  4. Call it inside the loop:
     ```javascript
     let complexity = 'unknown';
     try {
         if (sheet.planFile) {
             const planPath = path.resolve(workspaceRoot, sheet.planFile);
             if (fs.existsSync(planPath)) {
                 const planContent = fs.readFileSync(planPath, 'utf8');
                 complexity = getComplexityFromContent(planContent);
             }
         }
     } catch (e) { /* non-fatal */ }
     ```
  5. Add it to the output:
     ```javascript
     columns[col].push({
         topic: sheet.topic || sheet.planFile || 'Untitled',
         sessionId: sheet.sessionId,
         createdAt: sheet.createdAt,
         complexity   // <-- NEW
     });
     ```

### Step 2 — Place the helper function at the top of `register-tools.js` (Routine)
- **File:** `src/mcp-server/register-tools.js`
- Define `getComplexityFromContent(content)` as a module-level helper function (near line 530, after `coercePositiveInt`).
- This avoids code duplication inside the tool handler.

### No changes needed to:
- `KanbanProvider.ts` — the existing `getComplexityFromPlan()` stays for VS Code extension use.
- Session JSON files — no schema change needed; complexity is derived at query time.
- Plan creation workflows — no upstream changes required.

### Performance Note
Reading plan markdown files synchronously inside `get_kanban_state` adds I/O overhead proportional to the number of active plans. For a typical workspace with <50 plans, this adds <100ms. If performance becomes an issue in the future, consider caching complexity in session JSON during plan review events.

## Verification Plan
1. Run `node test-mcp.js` or invoke `get_kanban_state` via an MCP client.
2. Verify each plan item includes a `complexity` field with value `'low'`, `'high'`, or `'unknown'`.
3. Create a plan with a `## Complexity Audit` section containing `Band B: None` → verify `complexity: 'low'`.
4. Create a plan with `Band B:` followed by content → verify `complexity: 'high'`.
5. Create a plan with no Complexity Audit section → verify `complexity: 'unknown'`.
6. Verify older plans without audit sections default to `'unknown'` (backward compat).

## Open Questions
- **Resolved:** Complexity is derived from plan markdown at query time, not stored in session JSON. This is consistent with how KanbanProvider already works.
- **Resolved:** The planner agent already adds Complexity Audit sections as part of the improve-plan workflow. No upstream workflow changes needed.

---

## Adversarial Review

### Grumpy-style Critique
"You're reading markdown files inside an MCP tool call? Every single plan file on every single `get_kanban_state` invocation? That's going to be slow for workspaces with 100+ plans. And you're duplicating the regex logic from KanbanProvider instead of sharing it. If someone changes the complexity detection heuristic, they'll have to update it in two places."

### Balanced Synthesis
- **Valid concern (duplication):** The regex logic is duplicated between `KanbanProvider.ts` (TypeScript, async) and `register-tools.js` (JavaScript, sync). A shared utility would be ideal but requires refactoring the module boundary. For now, the duplication is acceptable since the regex is stable and well-documented. A `TODO` comment should reference the canonical source.
- **Valid concern (performance):** For <50 active plans, sync file reads add negligible latency. For 100+ plans, a caching strategy (writing complexity to session JSON during plan review) should be implemented. This is a known follow-up, not a blocker.
- **Rejected concern (over-engineering):** The alternative — requiring upstream workflow changes to pre-populate complexity in session JSON — is more fragile (what if a plan is edited outside the workflow?) and adds more moving parts. Deriving at query time is more robust.

**Recommendation:** This plan has moderate complexity (regex duplication, file I/O in MCP tool). Send it to the **Lead Coder**.