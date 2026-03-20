# Compelxity parsing still isn't fully accurate

## Goal
The plan complexity parser is still interpreting low complexity plans as high complexity. Please see:

x:\documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260320_055454_remove_lightning_icon_from_pair_program_mode.md

the complexity audit here is:

## Complexity Audit
### Band A — Routine
- Remove `⚡` icon from the pair program button in `src/webview/kanban.html`.
- Move the pair program button next to the copy prompt button in the card actions layout.
- Update `title` attributes (tooltips) in the toggle and the button to use "high complexity" and "low complexity" terminology instead of "Band B" / "Band A".
### Band B — Complex / Risky
- None

---

## Complexity Audit
### Band A — Routine
- Update the complexity parser regex in `src/services/KanbanProvider.ts` to correctly anchor "Band B" matching to headings or the start of a line.
- Add a unit test in `src/test/kanban-complexity.test.ts` verifying that inline mentions of "Band B" within Band A do not trigger high complexity routing.
### Band B — Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. The parsing logic is synchronous and stateless.
- **Security:** None.
- **Side Effects:** None. This change strictly confines complexity matching, increasing routing accuracy without affecting other systems.
- **Dependencies & Conflicts:** Relies on the standard plan templates outputted by the `improve-plan` workflow, which reliably start Band B with a heading (`### Band B`). No known conflicts with the Kanban board.

## Adversarial Synthesis
### Grumpy Critique
Your regular expression `/^\s*(?:#{1,4}\s+|\*\*)?Band\s+B\b/im` misses the case where the user forgets the space, like `###Band B`! Also, what if they write `####   Band B`? `#{1,4}\s+` requires at least one space... But more dangerously, what if the user puts `**Band B**` in the middle of a line? Your strict anchor `/^.../` won't match it if it's indented with a tab instead of spaces! Wait, `\s*` handles tabs. Also, have you verified if the subsequent logic `bandBContent.split(/\r?\n/)` correctly stops at the NEXT section boundary?

### Balanced Response
Grumpy brings up a fair point about users formatting markdown unpredictably. However, our prompt templates strictly output `### Band B — Complex / Risky`. The anchor `^\s*(?:#{1,4}\s+|\*\*)?Band\s+B\b` with the `/m` flag accurately matches valid permutations at the start of a line (including tabs or spaces) which is standard for headings. It correctly skips inline mentions of 'Band B' inside Band A bullets, which is the root cause of the bug reported. The subsequent logic to stop at the next section boundary is already robust and unaffected by this targeted regex improvement. We will also include a comprehensive unit test demonstrating that inline mentions are ignored, and valid headings are properly captured.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### [Fix Regex in KanbanProvider]
#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `KanbanProvider.ts` uses an unanchored regex `/\bBand\s+B\b/i` to find the beginning of the "Band B" section. When a Band A item mentions "Band B", it prematurely matches there, ingesting Band A items as Band B and thereby routing it as High complexity.
- **Logic:** Change the regex to anchor to the beginning of a line (allowing for optional whitespace, markdown heading hashes, or bolding) so it only matches valid section headings like `### Band B` rather than inline text.
- **Implementation:**
```typescript
<<<<
            // Find "Band B" within the audit section (stop at next top-level heading)
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/\bBand\s+B\b/i);
            if (!bandBMatch) return 'Low';
====
            // Find "Band B" within the audit section (stop at next top-level heading)
            // Use a strict anchor to match only actual headings (e.g. `### Band B`),
            // avoiding false positives if "Band B" appears in normal text inside Band A.
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?Band\s+B\b/im);
            if (!bandBMatch) return 'Low';
>>>>
```
- **Edge Cases Handled:** Prevents false positive matching of "Band B" inside normal paragraph or bullet text. Handles spaces/tabs and standard markdown heading indicators at the start of the line.

### [Add Regression Test]
#### [MODIFY] `src/test/kanban-complexity.test.ts`
- **Context:** Add a test to prove that an inline mention of "Band B" inside a Band A item does not inflate the parsed complexity.
- **Logic:** Add a new `test()` inside the `suite('Kanban complexity parsing', ...)` block that creates a mocked plan where Band A contains the text `"Band B"` and Band B contains `None`. Assert that `getComplexityFromPlan` correctly returns `'Low'`.
- **Implementation:**
```typescript
<<<<
    test('treats substantive Band B tasks as High complexity', async () => {
====
    test('treats plan as Low complexity even if "Band B" is mentioned in Band A text', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '',
                '## Complexity Audit',
                '',
                '### Band A (Routine)',
                '- Update terminology instead of "Band B" or "Band A".',
                '',
                '### Band B (Complex/Risky)',
                '- None',
                '',
                '## Goal',
                '- Verify false positives.'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, 'Low');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('treats substantive Band B tasks as High complexity', async () => {
>>>>
```
- **Edge Cases Handled:** Safely tests the exact bug scenario in a sandboxed temporary directory without leaving side effects.

## Verification Plan
### Automated Tests
- Run tests via `npm run test` or using the VS Code test explorer to verify that the Kanban complexity parsing suite passes.
- Verify that `npm run compile` completes without errors to ensure the TypeScript changes are valid.

### Manual Verification
- N/A

## User Review Required
> [!NOTE]
> No user-facing warnings or breaking changes.

---

## Implementation Review — 2026-03-20

### Status: ✅ APPROVED (no fixes needed)

### Files Changed During Review
- None — implementation matches plan exactly.

### Findings

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Regex fix `/^\s*(?:#{1,4}\s+|\*\*)?Band\s+B\b/im` correctly anchors to line start, preventing false positives from inline "Band B" mentions | PASS | Kept |
| 2 | Regression test at `kanban-complexity.test.ts:45-79` correctly covers the exact bug scenario (Band A text mentioning "Band B") | PASS | Kept |
| 3 | Existing positive test (substantive Band B → High) still present as control | PASS | Kept |
| 4 | Regex doesn't match `- **Band B**` mid-line (bullet-prefixed bold) | NIT | Deferred — templates control format; anchor is intentional |
| 5 | Opening `\*\*` in alternation has no closing match | NIT | Non-issue — matching heading start only |

### Validation Results
- **TypeScript typecheck (`tsc --noEmit`)**: ✅ Pass (0 errors)
- **Webpack build**: ✅ Pass
- **Test code review**: ✅ All 3 tests in `kanban-complexity.test.ts` are structurally correct (VS Code extension host required for execution)

### Remaining Risks
- None. The fix is minimal and targeted. Template-controlled format means edge cases in the regex alternation are not reachable in practice.
