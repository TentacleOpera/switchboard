import * as assert from 'assert';
import {
    buildKanbanBatchPrompt,
    columnToPromptRole,
    buildFeatureSubagentClause,
    buildCustomAgentPrompt,
    CODING_COMPLETION_REPORT_DIRECTIVE,
    COMPLETION_STEP_FULL,
    COMPLETION_STEP_COMPACT,
    DEFERRED_FINDINGS_SECTION_INSTRUCTION,
    MISSION_CONTROL_REPORT_DIRECTIVE,
    STAGGERED_IMPLEMENTATION_DIRECTIVE,
    SWITCHBOARD_LIVENESS_DIRECTIVE
} from '../agentPromptBuilder';
import { buildReconcilePrompt } from '../schedulerPresets';
import { DEFAULT_KANBAN_COLUMNS } from '../agentConfig';
import { AgentSkillExporter } from '../AgentSkillExporter';

suite('agentPromptBuilder', () => {
    const makePlans = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
            topic: `Test Plan ${i + 1}`,
            absolutePath: `/workspace/plan_${i + 1}.md`
        }));

    const makeFeaturePlans = () => [
        { topic: 'Test Feature', absolutePath: '/workspace/.switchboard/features/test-feature.md', isFeature: true, sessionId: 'feature-1' },
        { topic: 'Subtask A', absolutePath: '/workspace/.switchboard/plans/sub-a.md', isSubtask: true, featureTopic: 'Test Feature', featureId: 'feature-1', sessionId: 'st-1' },
        { topic: 'Subtask B', absolutePath: '/workspace/.switchboard/plans/sub-b.md', isSubtask: true, featureTopic: 'Test Feature', featureId: 'feature-1', sessionId: 'st-2' },
    ];

    suite('buildKanbanBatchPrompt — coder role', () => {
        test('accurateCodingEnabled: true injects Accuracy Mode instructions', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                accurateCodingEnabled: true
            });
            assert.ok(prompt.includes('Accuracy Mode'), 'Should include Accuracy Mode header');
            assert.ok(prompt.includes('.agents/protocols/accuracy/SKILL.md'), 'Should include reference to accuracy workflow');
        });

        test('accurateCodingEnabled: false omits Accuracy Mode instructions', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                accurateCodingEnabled: false
            });
            assert.ok(!prompt.includes('Accuracy Mode'), 'Should not include Accuracy Mode header');
        });

        test('omits source column label even when provided', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {
                sourceColumnLabel: 'Planned'
            });
            assert.ok(!prompt.includes('from the Planned column'), 'Should NOT include source column label');
            assert.ok(!prompt.includes('from the'), 'Should NOT contain "from the" at all');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have clean intro');
        });

        test('omits source column label when not provided', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(2), {});
            assert.ok(!prompt.includes('from the'), 'Should not include "from the" when no sourceColumnLabel');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have default intro');
        });

        test('omits complexity and source column for low-complexity coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                instruction: 'low-complexity',
                sourceColumnLabel: 'TEST'
            });
            assert.ok(!prompt.includes('from the TEST column'), 'Should NOT include source column label');
            assert.ok(!prompt.includes('low-complexity'), 'Should NOT include low-complexity text');
            assert.ok(prompt.includes('Please execute the plan below.'), 'Should have clean intro');
        });
    });

    suite('buildKanbanBatchPrompt — lead role', () => {
        test('omits source column label even when provided', () => {
            const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {
                sourceColumnLabel: 'Planned'
            });
            assert.ok(!prompt.includes('from the Planned column'), 'Should NOT include source column label');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have clean intro');
        });

        test('omits source column label when not provided', () => {
            const prompt = buildKanbanBatchPrompt('lead', makePlans(2), {});
            assert.ok(!prompt.includes('from the'), 'Should not include "from the" when no sourceColumnLabel');
            assert.ok(prompt.includes('Please execute the 2 plans below.'), 'Should have default intro');
        });
    });

    suite('buildKanbanBatchPrompt — overrides & context flags', () => {
        test('clearAntigravityContext: true injects antigravity block', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                clearAntigravityContext: true
            });
            assert.ok(prompt.includes('Ignore any previous checkpoint summaries'), 'Should include checkpoint summaries instruction');
            assert.ok(!prompt.includes('no historical context'), 'Should not include overly broad language');
        });

        test('clearAntigravityContext: false omits antigravity block', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                clearAntigravityContext: false
            });
            assert.ok(!prompt.includes('Ignore any previous checkpoint summaries'), 'Should omit checkpoint summaries instruction');
        });

        test('clearAntigravityContext: undefined omits antigravity block', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {});
            assert.ok(!prompt.includes('Ignore any previous checkpoint summaries'), 'Should omit checkpoint summaries instruction');
        });

        test('replace mode preserves role framing (intro, execution mode, plan list)', () => {
            const overrideText = 'Focus only on security vulnerabilities.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(2), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'replace' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('Execute a direct reviewer pass in-place for each plan'), 'Should preserve reviewer execution intro');
            assert.ok(prompt.includes(overrideText), 'Should include replace override text');
            assert.ok(prompt.includes('PLANS TO PROCESS'), 'Should preserve plan list header');
        });

        test('prepend mode adds override before base instructions', () => {
            const defaultBaseText = 'For each plan:';
            const overrideText = 'Prepend this.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'prepend' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            const prependIndex = prompt.indexOf(overrideText);
            const baseIndex = prompt.indexOf(defaultBaseText);
            assert.ok(prependIndex < baseIndex, 'Prepend text should appear before default base instructions');
        });

        test('append mode adds override after base instructions', () => {
            const defaultBaseText = 'For each plan:';
            const overrideText = 'Append this.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'append' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            const baseIndex = prompt.indexOf(defaultBaseText);
            const appendIndex = prompt.indexOf(overrideText);
            assert.ok(baseIndex < appendIndex, 'Append text should appear after default base instructions');
        });

        test('advanced reviewer add-on is injected with default base instructions', () => {
            const defaultBaseText = 'For each plan:';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                advancedReviewerEnabled: true,
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes(defaultBaseText), 'Should include default base instructions');
            assert.ok(prompt.includes('ADVANCED REGRESSION ANALYSIS'), 'Should include advanced reviewer directive');
        });

        test('noSeparateReviewArtifacts directive is injected by default for reviewer', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('NO SEPARATE REVIEW ARTIFACTS'), 'Should include noSeparateReviewArtifacts directive by default');
        });

        test('noSeparateReviewArtifactsEnabled: false omits noSeparateReviewArtifacts directive', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                noSeparateReviewArtifactsEnabled: false,
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(!prompt.includes('NO SEPARATE REVIEW ARTIFACTS'), 'Should omit noSeparateReviewArtifacts directive when disabled');
        });

        test('noSeparateReviewArtifacts directive survives replace mode prompt override', () => {
            const overrideText = 'Custom replace instructions.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'replace' } },
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('NO SEPARATE REVIEW ARTIFACTS'), 'Should include noSeparateReviewArtifacts directive even in replace mode');
        });

        test('noSeparateReviewArtifacts directive coexists with completion report directive', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('NO SEPARATE REVIEW ARTIFACTS'), 'Should include noSeparateReviewArtifacts directive');
            assert.ok(prompt.includes('COMPLETION REPORT:'), 'Should include completion report directive');
        });

        test('reviewerRisksToMemo directive is injected by default for reviewer', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('REMAINING RISKS TO MEMO'), 'Should include reviewerRisksToMemo directive by default');
        });

        test('reviewerRisksToMemoEnabled: false omits reviewerRisksToMemo directive', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                reviewerRisksToMemoEnabled: false,
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(!prompt.includes('REMAINING RISKS TO MEMO'), 'Should omit reviewerRisksToMemo directive when disabled');
        });

        test('reviewerRisksToMemo default does not leak into non-reviewer roles', () => {
            for (const role of ['coder', 'lead', 'intern', 'tester', 'planner']) {
                const prompt = buildKanbanBatchPrompt(role, makePlans(1), {
                    switchboardSafeguardsEnabled: false,
                    gitProhibitionEnabled: false
                });
                assert.ok(!prompt.includes('REMAINING RISKS TO MEMO'), `${role} prompt must not include reviewerRisksToMemo directive`);
            }
        });

        test('reviewerRisksToMemo renders an absolute MEMO FILE path from workspaceRoot', () => {
            // The reviewer prompt carries no WORKSPACE_ROOT= line, so the memo path has
            // to be rendered at build time or a reviewer in a worktree CWD writes its
            // risks into the worktree's .switchboard/, which cleanup discards.
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                workspaceRoot: '/tmp/ws-root',
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('MEMO FILE: /tmp/ws-root/.switchboard/memo.md'), 'Should render the absolute memo path');
            assert.ok(!prompt.includes('WORKSPACE_ROOT from the dispatch context'), 'Must not point at a WORKSPACE_ROOT line the reviewer prompt never emits');
        });

        test('reviewerRisksToMemo omits the MEMO FILE line when no workspaceRoot is supplied', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false
            });
            assert.ok(prompt.includes('REMAINING RISKS TO MEMO'), 'Directive still present');
            assert.ok(!prompt.includes('MEMO FILE:'), 'No dangling MEMO FILE line without a workspace root');
        });

        test('reviewerRisksToMemoEnabled flows through buildCustomAgentPrompt', () => {
            const on = buildCustomAgentPrompt(makePlans(1), 'Review things.', { reviewerRisksToMemoEnabled: true });
            assert.ok(on.includes('REMAINING RISKS TO MEMO'), 'Custom agent with the addon must carry the directive');

            const off = buildCustomAgentPrompt(makePlans(1), 'Review things.', {});
            assert.ok(!off.includes('REMAINING RISKS TO MEMO'), 'Custom agents stay explicit opt-in — no reviewer default inheritance');
        });

        test('AgentSkillExporter.normalizeBuiltinAddons role-gates the risks-to-memo default', () => {
            // The role gate is the riskiest line in this feature: normalizeBuiltinAddons
            // runs for EVERY built-in role, so a bare `?? true` would render a
            // "Risks to Memo" section into coder/tester/planner skill exports.
            const normalize = (AgentSkillExporter as any).normalizeBuiltinAddons.bind(AgentSkillExporter);

            assert.strictEqual(normalize({ switchboardSafeguards: true }, 'reviewer').reviewerRisksToMemoEnabled, true,
                'reviewer defaults ON when the key is absent');
            assert.strictEqual(normalize({ reviewerRisksToMemo: false }, 'reviewer').reviewerRisksToMemoEnabled, false,
                'explicit false is honoured for the reviewer');
            for (const role of ['coder', 'lead', 'intern', 'tester', 'planner', 'analyst']) {
                assert.strictEqual(normalize({ switchboardSafeguards: true }, role).reviewerRisksToMemoEnabled, false,
                    `${role} must not inherit the reviewer default`);
            }
        });

        test('cavemanOutputEnabled: true injects caveman directive', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                cavemanOutputEnabled: true
            });
            assert.ok(prompt.includes('CAVEMAN MODE'), 'Should include CAVEMAN MODE directive');
        });

        test('cavemanOutputEnabled: false omits caveman directive', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {
                cavemanOutputEnabled: false
            });
            assert.ok(!prompt.includes('CAVEMAN MODE'), 'Should NOT include CAVEMAN MODE directive');
        });

        test('cavemanOutputEnabled: undefined omits caveman directive', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {});
            assert.ok(!prompt.includes('CAVEMAN MODE'), 'Should NOT include CAVEMAN MODE directive');
        });
    });

    suite('buildKanbanBatchPrompt — reviewer role behaviour', () => {
        test('exactly one occurrence of COMPLETION REPORT: in default configuration', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {});
            const count = (prompt.match(/COMPLETION REPORT:/g) || []).length;
            assert.strictEqual(count, 1, `Expected exactly 1 COMPLETION REPORT: occurrence, found ${count}`);
        });

        test('exactly one occurrence of COMPLETION REPORT: with reviewerCompactPlanUpdateEnabled: true', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                reviewerCompactPlanUpdateEnabled: true
            });
            const count = (prompt.match(/COMPLETION REPORT:/g) || []).length;
            assert.strictEqual(count, 1, `Expected exactly 1 COMPLETION REPORT: occurrence, found ${count}`);
        });

        test('exactly one occurrence of COMPLETION REPORT: with replace-mode defaultPromptOverride', () => {
            const overrideText = 'Custom replace instructions without completion sentinel.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'replace' } }
            });
            const count = (prompt.match(/COMPLETION REPORT:/g) || []).length;
            assert.strictEqual(count, 1, `Expected exactly 1 COMPLETION REPORT: occurrence in replace override mode, found ${count}`);
        });

        // Discriminating assertions — the count-of-token tests above are invariant
        // across the bug (Defect A: sentinel miss) and the fix, so they cannot detect
        // the duplicate. Pre-fix the count was 1 (from the appended generic directive
        // alone); post-fix it is 1 (from the base step alone). These assertions check
        // WHICH body carries the sentinel, so the broken shape (generic directive
        // appended because the base step lost its prefix) fails here while the fixed
        // shape passes. Imported constants, not hardcoded sentences, so a future reword
        // cannot silently un-pin these.
        test('default config: base step carries sentinel, generic directive body absent', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {});
            assert.ok(prompt.includes(COMPLETION_STEP_FULL), 'Reviewer base step (COMPLETION_STEP_FULL) must carry the COMPLETION REPORT: sentinel in default config');
            assert.ok(!prompt.includes(CODING_COMPLETION_REPORT_DIRECTIVE), 'Generic CODING_COMPLETION_REPORT_DIRECTIVE must NOT be appended when the base step already carries the sentinel (would be the duplicate)');
        });

        test('reviewerCompactPlanUpdateEnabled: compact base step carries sentinel, generic directive body absent', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                reviewerCompactPlanUpdateEnabled: true
            });
            assert.ok(prompt.includes(COMPLETION_STEP_COMPACT), 'Reviewer compact base step (COMPLETION_STEP_COMPACT) must carry the COMPLETION REPORT: sentinel when compact mode is on');
            assert.ok(!prompt.includes(CODING_COMPLETION_REPORT_DIRECTIVE), 'Generic CODING_COMPLETION_REPORT_DIRECTIVE must NOT be appended when the compact base step already carries the sentinel (would be the duplicate)');
        });

        test('replace-mode defaultPromptOverride: generic directive appended, base step absent (override-proofing)', () => {
            const overrideText = 'Custom replace instructions without completion sentinel.';
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                defaultPromptOverrides: { reviewer: { text: overrideText, mode: 'replace' } }
            });
            assert.ok(prompt.includes(CODING_COMPLETION_REPORT_DIRECTIVE), 'Generic CODING_COMPLETION_REPORT_DIRECTIVE MUST be appended when a replace override wipes the base step (override-proofing direction)');
            assert.ok(!prompt.includes(COMPLETION_STEP_FULL), 'Base step (COMPLETION_STEP_FULL) must be absent after a replace override wipes the composed base');
            assert.ok(!prompt.includes(COMPLETION_STEP_COMPACT), 'Compact base step (COMPLETION_STEP_COMPACT) must be absent after a replace override wipes the composed base');
        });

        test('completion directives contain POST /kanban/queue/done and do NOT contain file watcher mtime phrasing', () => {
            for (const directive of [CODING_COMPLETION_REPORT_DIRECTIVE, COMPLETION_STEP_FULL, COMPLETION_STEP_COMPACT]) {
                assert.ok(directive.includes('POST /kanban/queue/done'), `Directive should reference POST /kanban/queue/done: ${directive}`);
                assert.ok(!directive.includes('the file watcher detects it'), `Directive should not reference file watcher: ${directive}`);
                assert.ok(directive.startsWith('COMPLETION REPORT:'), `Directive must keep sentinel: ${directive}`);
            }
            assert.ok(MISSION_CONTROL_REPORT_DIRECTIVE.includes('the completion POST'), 'MISSION_CONTROL_REPORT_DIRECTIVE should reference completion POST');
            assert.ok(!MISSION_CONTROL_REPORT_DIRECTIVE.includes('the plan-file completion report'), 'MISSION_CONTROL_REPORT_DIRECTIVE should not say the plan-file completion report');
            assert.ok(STAGGERED_IMPLEMENTATION_DIRECTIVE.includes('POST /kanban/queue/done'), 'STAGGERED_IMPLEMENTATION_DIRECTIVE should reference POST /kanban/queue/done');
            assert.ok(!STAGGERED_IMPLEMENTATION_DIRECTIVE.includes('the per-plan completion report (which still goes to each subtask\'s own plan file)'), 'STAGGERED_IMPLEMENTATION_DIRECTIVE should not reference per-plan completion report');
        });

        // Deferred-findings section — gives "what we chose not to fix" a
        // machine-readable home that survives the card's advance. Both
        // completion modes carry the section instruction; the empty case is
        // stated explicitly; the compact budget is scoped to prose only; the
        // sentinel survives; reconcile is left byte-identical.
        test('both completion steps carry the deferred-findings section instruction', () => {
            assert.ok(COMPLETION_STEP_FULL.includes(DEFERRED_FINDINGS_SECTION_INSTRUCTION),
                'COMPLETION_STEP_FULL must carry the deferred-findings section instruction');
            assert.ok(COMPLETION_STEP_COMPACT.includes(DEFERRED_FINDINGS_SECTION_INSTRUCTION),
                'COMPLETION_STEP_COMPACT must carry the deferred-findings section instruction — half of users get compact mode');
        });

        test('deferred-findings section instruction states the empty case explicitly', () => {
            assert.ok(DEFERRED_FINDINGS_SECTION_INSTRUCTION.toLowerCase().includes('none'),
                'Empty case must be stated explicitly ("None"), not omitted — absence means "not answered", never "nothing found"');
            assert.ok(DEFERRED_FINDINGS_SECTION_INSTRUCTION.includes('do not omit the section'),
                'Instruction must forbid omitting the section when nothing was deferred');
        });

        test('deferred-findings section instruction requires severity and file:line per item', () => {
            assert.ok(DEFERRED_FINDINGS_SECTION_INSTRUCTION.includes('CRITICAL/MAJOR/NIT'),
                'Each deferred finding must carry a Stage 1 severity (CRITICAL/MAJOR/NIT)');
            assert.ok(DEFERRED_FINDINGS_SECTION_INSTRUCTION.includes('file:line'),
                'Each deferred finding must carry a file:line reference');
        });

        test('compact mode sentence budget is scoped to the Review Findings prose only', () => {
            assert.ok(COMPLETION_STEP_COMPACT.includes('≤ 5 sentences'),
                'Compact mode must still state the ≤ 5 sentence budget for the prose summary');
            assert.ok(COMPLETION_STEP_COMPACT.includes('does NOT bound the deferred-findings list'),
                'Compact mode must explicitly scope the budget to the prose summary and NOT the deferred-findings list');
        });

        test('completion-step sentinels survive the deferred-findings addition', () => {
            for (const directive of [COMPLETION_STEP_FULL, COMPLETION_STEP_COMPACT]) {
                assert.ok(directive.startsWith('COMPLETION REPORT:'),
                    `Sentinel must remain at the start of the completion step: ${directive.slice(0, 40)}...`);
                assert.ok(directive.includes('POST /kanban/queue/done'),
                    'POST /kanban/queue/done handshake must survive the addition');
            }
            // ensureCompletionDirective recognises the composed text (sentinel
            // present) and does NOT double-append the generic directive.
            const fullPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {});
            assert.ok(!fullPrompt.includes(CODING_COMPLETION_REPORT_DIRECTIVE),
                'Generic CODING_COMPLETION_REPORT_DIRECTIVE must NOT be appended when the base step already carries the sentinel (would be the duplicate)');
            const compactPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), { reviewerCompactPlanUpdateEnabled: true });
            assert.ok(!compactPrompt.includes(CODING_COMPLETION_REPORT_DIRECTIVE),
                'Generic CODING_COMPLETION_REPORT_DIRECTIVE must NOT be appended in compact mode when the base step already carries the sentinel');
        });

        test('reviewer prompt surfaces the deferred-findings section in both modes', () => {
            const fullPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {});
            assert.ok(fullPrompt.includes('## Deferred Findings'),
                'Default (full) reviewer prompt must instruct appending a ## Deferred Findings section');
            const compactPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), { reviewerCompactPlanUpdateEnabled: true });
            assert.ok(compactPrompt.includes('## Deferred Findings'),
                'Compact reviewer prompt must instruct appending a ## Deferred Findings section');
        });

        test('tester step 5 records remaining requirement gaps in the deferred-findings section', () => {
            const prompt = buildKanbanBatchPrompt('tester', makePlans(1), {});
            assert.ok(prompt.includes('## Deferred Findings'),
                'Tester prompt must direct remaining requirement gaps to the ## Deferred Findings section (one concept, one vocabulary)');
            assert.ok(!prompt.includes('remaining requirement gaps'),
                'Tester must no longer use the now-moot "remaining requirement gaps" vocabulary');
        });

        test('reconcile preset is byte-identical — this change did not edit it', () => {
            const prompt = buildReconcilePrompt();
            // The reconcile preset scans for ## Completion Report / ## Review
            // Findings sections and advances cards. Its wording is load-bearing
            // and unchanged from the retired scheduler surface — this plan
            // leaves it untouched (consumption is the next plan's business).
            assert.ok(prompt.includes('## Completion Report') && prompt.includes('## Review Findings'),
                'reconcile must still scan for ## Completion Report / ## Review Findings sections');
            assert.ok(!prompt.includes('## Deferred Findings'),
                'reconcile must NOT reference ## Deferred Findings — this plan does not teach it to consume the new section');
            assert.ok(!prompt.includes('deferred'),
                'reconcile wording must be untouched by the deferred-findings change');
        });

        test('skip-tests disclosure absent with no skip flags; present with skipTests or skipCompilation', () => {
            const defaultPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {});
            assert.ok(!defaultPrompt.includes('Skip-tests disclosure:'), 'Skip-tests disclosure should be absent when no skip flags');
            assert.ok(!defaultPrompt.includes('Verification was static-only'), 'Static-only text should be absent when no skip flags');

            const skipTestsPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), { skipTests: true });
            assert.ok(skipTestsPrompt.includes('Skip-tests disclosure:'), 'Skip-tests disclosure should be present when skipTests is true');
            assert.ok(skipTestsPrompt.includes('Verification was static-only'), 'Static-only text should be present when skipTests is true');

            const skipCompPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), { skipCompilation: true });
            assert.ok(skipCompPrompt.includes('Skip-tests disclosure:'), 'Skip-tests disclosure should be present when skipCompilation is true');
            assert.ok(skipCompPrompt.includes('Verification was static-only'), 'Static-only text should be present when skipCompilation is true');
        });

        test('ANTI-LEAKAGE RULE present in all four skip-flag combinations', () => {
            const combos = [
                {},
                { skipTests: true },
                { skipCompilation: true },
                { skipTests: true, skipCompilation: true }
            ];
            for (const opts of combos) {
                const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), opts);
                assert.ok(prompt.includes('ANTI-LEAKAGE RULE'), `ANTI-LEAKAGE RULE must be present with options ${JSON.stringify(opts)}`);
            }
        });

        test('CAVEMAN directive absent when cavemanOutputEnabled and reviewerConciseModeEnabled; present when caveman on and concise off', () => {
            const concisePlusCaveman = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                cavemanOutputEnabled: true,
                reviewerConciseModeEnabled: true
            });
            assert.ok(!concisePlusCaveman.includes('CAVEMAN MODE'), 'CAVEMAN MODE directive should be absent when concise mode is also enabled');

            const cavemanOnly = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                cavemanOutputEnabled: true,
                reviewerConciseModeEnabled: false
            });
            assert.ok(cavemanOnly.includes('CAVEMAN MODE'), 'CAVEMAN MODE directive should be present when concise mode is off');
        });

        test('Explain why something is a problem is absent from composed prompt', () => {
            const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {
                reviewerConciseModeEnabled: true
            });
            assert.ok(!prompt.includes('Explain why something is a problem'), 'Phantom override text must not be present');
        });

        test('step numbering is contiguous 1..N with no gaps or repeats in default and skip configurations', () => {
            const checkNumbering = (prompt: string, expectedCount: number) => {
                for (let i = 1; i <= expectedCount; i++) {
                    assert.ok(prompt.includes(`\n${i}. `), `Expected step ${i}. in prompt`);
                }
                assert.ok(!prompt.includes(`\n${expectedCount + 1}. `), `Step ${expectedCount + 1}. should not exist`);
            };

            const defaultPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), {});
            checkNumbering(defaultPrompt, 9);

            const skipPrompt = buildKanbanBatchPrompt('reviewer', makePlans(1), { skipTests: true });
            checkNumbering(skipPrompt, 10);
        });

        test('Stage 1 and Stage 2 are present in every configuration', () => {
            const configs = [
                {},
                { reviewerConciseModeEnabled: true },
                { reviewerCompactPlanUpdateEnabled: true },
                { reviewerConciseModeEnabled: true, reviewerCompactPlanUpdateEnabled: true, cavemanOutputEnabled: true }
            ];
            for (const cfg of configs) {
                const prompt = buildKanbanBatchPrompt('reviewer', makePlans(1), cfg);
                assert.ok(prompt.includes('Stage 1 (Grumpy):'), `Stage 1 missing for ${JSON.stringify(cfg)}`);
                assert.ok(prompt.includes('Stage 2 (Balanced):'), `Stage 2 missing for ${JSON.stringify(cfg)}`);
                assert.ok(prompt.includes('CRITICAL: Do not stop after Stage 1.'), `CRITICAL missing for ${JSON.stringify(cfg)}`);
            }
        });
    });

    suite('adviseResearchIfUnsure option', () => {
        test('adviseResearchIfUnsure: true includes research directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { adviseResearchIfUnsure: true });
            assert.ok(prompt.includes('RESEARCH WHEN UNSURE:'), 'Should include research directive');
            assert.ok(prompt.includes('.agents/protocols/advise_research/SKILL.md'), 'Should include path to skill file');
        });

        test('adviseResearchIfUnsure: false omits research directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { adviseResearchIfUnsure: false });
            assert.ok(!prompt.includes('RESEARCH WHEN UNSURE:'), 'Should NOT include research directive');
        });

        test('adviseResearchIfUnsure: undefined includes research directive (default ON)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), {});
            assert.ok(prompt.includes('RESEARCH WHEN UNSURE:'), 'Should include research directive by default');
            assert.ok(prompt.includes('.agents/protocols/advise_research/SKILL.md'), 'Should include path to skill file');
        });
    });

    suite('writeFeatureDescriptionIfEmpty option', () => {
        test('writeFeatureDescriptionIfEmpty: true + featureMode includes feature description directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { writeFeatureDescriptionIfEmpty: true, featureMode: true });
            assert.ok(prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should include feature description directive');
            assert.ok(prompt.includes('## Goal'), 'Should reference Goal section');
            assert.ok(prompt.includes('## How the Subtasks Achieve This'), 'Should reference How the Subtasks Achieve This section');
            assert.ok(prompt.includes('## Dependencies & sequencing'), 'Should reference Dependencies & sequencing section');
        });

        test('writeFeatureDescriptionIfEmpty: false + featureMode omits feature description directive', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { writeFeatureDescriptionIfEmpty: false, featureMode: true });
            assert.ok(!prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should NOT include feature description directive');
        });

        test('writeFeatureDescriptionIfEmpty: true without featureMode omits directive (non-feature dispatch unaffected)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { writeFeatureDescriptionIfEmpty: true });
            assert.ok(!prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should NOT include feature description directive for non-feature dispatch');
        });

        test('writeFeatureDescriptionIfEmpty: undefined + featureMode includes feature description directive (default ON)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { featureMode: true });
            assert.ok(prompt.includes('FEATURE DESCRIPTION BACKFILL:'), 'Should include feature description directive by default in feature mode');
        });
    });

    suite('columnToPromptRole', () => {
        test('maps CREATED to planner', () => {
            assert.strictEqual(columnToPromptRole('CREATED'), 'planner');
        });

        test('maps PLAN REVIEWED to lead', () => {
            assert.strictEqual(columnToPromptRole('PLAN REVIEWED'), 'lead');
        });

        test('maps LEAD CODED to reviewer', () => {
            assert.strictEqual(columnToPromptRole('LEAD CODED'), 'reviewer');
        });

        test('maps CODER CODED to reviewer', () => {
            assert.strictEqual(columnToPromptRole('CODER CODED'), 'reviewer');
        });

        test('maps INTERN CODED to reviewer', () => {
            assert.strictEqual(columnToPromptRole('INTERN CODED'), 'reviewer');
        });

        test('maps CODE REVIEWED to tester', () => {
            assert.strictEqual(columnToPromptRole('CODE REVIEWED'), 'tester');
        });

        test('maps RESEARCHER to researcher', () => {
            assert.strictEqual(columnToPromptRole('RESEARCHER'), 'researcher');
        });

        test('maps TICKET UPDATER to ticket_updater', () => {
            assert.strictEqual(columnToPromptRole('TICKET UPDATER'), 'ticket_updater');
        });

        test('maps CODED to reviewer (legacy normalization)', () => {
            assert.strictEqual(columnToPromptRole('CODED'), 'reviewer');
        });

        test('returns custom_agent roles as-is', () => {
            assert.strictEqual(columnToPromptRole('custom_agent_devin'), 'custom_agent_devin');
        });

        test('returns null for unknown columns', () => {
            assert.strictEqual(columnToPromptRole('UNKNOWN_COLUMN'), null);
        });
    });

    suite('§9 regression — lean dispatch prompts', () => {


        test('no [SUBTASK] [SUBTASK] double-labelling in feature-mode planner prompt', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(!prompt.includes('[SUBTASK] [SUBTASK]'), 'Feature prompt must not contain double [SUBTASK] labelling');
        });

        test('no [SUBTASK] [SUBTASK] double-labelling in feature-mode coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(!prompt.includes('[SUBTASK] [SUBTASK]'), 'Feature coder prompt must not contain double [SUBTASK] labelling');
        });

        test('no batchExecutionRules in single-plan coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makePlans(1), {});
            assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS:'), 'Single-plan prompt must not include batch execution rules');
        });

        test('no batchExecutionRules in feature-mode coder prompt', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS:'), 'Feature-mode coder prompt must not include batch execution rules');
        });

        test('feature-mode coder prompt contains FEATURE FILE reference and no per-subtask plan lines', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(prompt.includes('FEATURE FILE:'), 'Feature-mode coder prompt should contain FEATURE FILE reference');
            assert.ok(!prompt.includes('Subtask A Plan File:'), 'Feature-mode coder prompt should not enumerate per-subtask plan lines');
            assert.ok(!prompt.includes('Subtask B Plan File:'), 'Feature-mode coder prompt should not enumerate per-subtask plan lines');
        });

        test('single worktree path appears exactly once in worktree dispatch', () => {
            const plans = [{ topic: 'Plan A', absolutePath: '/workspace/plan-a.md', worktreePath: '/workspace/wt-a' }];
            const prompt = buildKanbanBatchPrompt('coder', plans, { gitProhibitionEnabled: false });
            const occurrences = (prompt.match(/\/workspace\/wt-a/g) || []).length;
            assert.strictEqual(occurrences, 1, `Worktree path should appear exactly once, found ${occurrences}`);
        });
    });

    suite('feature-aware workflow routing', () => {
        test('feature-mode planner prompt uses improve-feature workflow path', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(prompt.includes('Read .agents/protocols/improve-feature/SKILL.md and follow it step-by-step'), 'Should route to improve-feature SKILL.md');
            assert.ok(!prompt.includes('improve-plan.md'), 'Should NOT include improve-plan.md');
        });

        test('isFeature on plan (no subtasks) uses improve-feature workflow path', () => {
            const prompt = buildKanbanBatchPrompt('planner', [{ topic: 'Lonely Feature', absolutePath: '/workspace/.switchboard/features/lonely.md', isFeature: true }], {});
            assert.ok(prompt.includes('Read .agents/protocols/improve-feature/SKILL.md and follow it step-by-step'), 'Should route to improve-feature SKILL.md');
        });

        test('feature-mode overrides custom plannerWorkflowPath', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, plannerWorkflowPath: '.custom/workflows/my-planner.md' });
            // Path is the skill, not the retired flat improve-feature.md (four-front-doors refactor).
            assert.ok(prompt.includes('.agents/protocols/improve-feature/SKILL.md'), 'Should use improve-feature SKILL.md');
            assert.ok(!prompt.includes('.custom/workflows/my-planner.md'), 'Should override custom plannerWorkflowPath');
        });

        test('non-feature planner prompt still uses configured workflow path (regression)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makePlans(1), { plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md' });
            assert.ok(prompt.includes('improve-plan/SKILL.md'), 'Should use default/configured plan workflow');
        });

        test('workflowFilePathEnabled: false emits no workflow path for feature-mode (regression)', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, workflowFilePathEnabled: false });
            assert.ok(!prompt.includes('improve-feature.md'), 'Should NOT include improve-feature.md when workflowFilePathEnabled is false');
            assert.ok(!prompt.includes('improve-plan.md'), 'Should NOT include improve-plan.md when workflowFilePathEnabled is false');
        });
    });

    suite('feature-mode directive role wording', () => {
        test('planner feature-mode prompt uses planning-coded directive verbs', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(prompt.includes('planning the feature'), 'Planner feature-mode prompt should use "planning the feature"');
            assert.ok(prompt.includes('Process the subtask plan files yourself'), 'Planner feature-mode prompt should use "Process the subtask plan files yourself"');
            assert.ok(!prompt.includes('implementing the feature'), 'Planner feature-mode prompt must NOT contain execution-coded "implementing the feature"');
            assert.ok(!prompt.includes('Do NOT create git worktrees for this dispatch.'), 'Planner feature-mode prompt must NOT contain coder worktree clause');
        });

        test('coder feature-mode prompt keeps execution-coded directive (regression)', () => {
            const prompt = buildKanbanBatchPrompt('coder', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2 });
            assert.ok(prompt.includes('EXECUTION MODE'), 'Coder feature-mode prompt should contain the "EXECUTION MODE" featureExecutionBlock');
            assert.ok(prompt.includes('Do NOT create git worktrees for this dispatch.'), 'Coder feature-mode prompt should contain worktree clause');
            assert.ok(!prompt.includes('subagent'), 'Coder feature-mode default prompt should contain no subagent wording');
            assert.ok(!prompt.includes('planning the feature'), 'Coder feature-mode prompt must NOT contain planner-coded "planning the feature"');
            assert.ok(!prompt.includes('Process the subtask plan files yourself'), 'Coder feature-mode prompt must NOT contain planner-coded "Process the subtask plan files yourself"');
        });

        test('planner feature-mode with featureNoSubagentsEnabled bypasses noSubagents clause', () => {
            const prompt = buildKanbanBatchPrompt('planner', makeFeaturePlans(), { featureMode: true, featureTopic: 'Test Feature', subtaskCount: 2, featureNoSubagentsEnabled: true });
            assert.ok(!prompt.includes('Handle all subtasks yourself'), 'Planner feature-mode prompt must NOT contain the noSubagents clause "Handle all subtasks yourself"');
            assert.ok(prompt.includes('Process the subtask plan files yourself'), 'Planner feature-mode prompt should use the fixed planner-coded subtask clause regardless of subagent policy');
        });

        test('feature subagent policy and worktree matrix decoupling', () => {
            // OFF + default policy
            const promptOffDefault = buildFeatureSubagentClause('default', undefined, false);
            assert.ok(promptOffDefault.includes('Do NOT create git worktrees for this dispatch.'));
            assert.ok(!promptOffDefault.includes('subagent'));

            // ON + default policy
            const promptOnDefault = buildFeatureSubagentClause('default', undefined, true);
            assert.ok(promptOnDefault.includes('Use a dedicated git worktree for each subtask to prevent file conflicts (worktree-per-plan isolation).'));
            assert.ok(!promptOnDefault.includes('subagent'));

            // OFF + useSubagents
            const promptOffUse = buildFeatureSubagentClause('useSubagents', undefined, false);
            assert.ok(promptOffUse.includes('Do NOT create git worktrees for this dispatch.'));
            assert.ok(promptOffUse.includes('Use your native subagent or orchestration capabilities'));
            assert.ok(!promptOffUse.includes('implement the subtasks directly'));

            // ON + noSubagents
            const promptOnNo = buildFeatureSubagentClause('noSubagents', undefined, true);
            assert.ok(promptOnNo.includes('Use a dedicated git worktree for each subtask to prevent file conflicts (worktree-per-plan isolation).'));
            assert.ok(promptOnNo.includes('You are strictly forbidden from spawning or invoking any subagents. Handle all subtasks yourself.'));

            // ON + customSubagent (named)
            const promptOnCustom = buildFeatureSubagentClause('customSubagent', 'worker-agent', true);
            assert.ok(promptOnCustom.includes('Use a dedicated git worktree for each subtask to prevent file conflicts (worktree-per-plan isolation).'));
            assert.ok(promptOnCustom.includes('You are authorized to use the "worker-agent" subagent for this task.'));

            // OFF + customSubagent (blank name)
            const promptOffCustomBlank = buildFeatureSubagentClause('customSubagent', '', false);
            assert.ok(promptOffCustomBlank.includes('Do NOT create git worktrees for this dispatch.'));
            assert.ok(promptOffCustomBlank.includes('Use your native subagent or orchestration capabilities to handle each subtask.'));
        });

        test('custom agent feature prompt emits neutral ordering line and respects policy matrix', () => {
            const plans = makeFeaturePlans();
            // isFeature is derived from the plans (makeFeaturePlans()[0].isFeature === true),
            // NOT from addons — CustomAgentAddons has no isFeature key.
            const customPrompt = buildCustomAgentPrompt(plans, 'custom-agent', {
                featureSubagentPolicy: 'default',
                useWorktreesPerPlan: false
            });
            assert.ok(customPrompt.includes('Do NOT create git worktrees for this dispatch.'));
            assert.ok(customPrompt.includes('Work through the subtasks in a sensible order.'));
            assert.ok(!customPrompt.includes('subagent'));
        });
    });

    suite('completion-testing stage — column, role and prompt', () => {
        const completionColumn = () => DEFAULT_KANBAN_COLUMNS.find(c => c.id === 'ACCEPTANCE TESTED');

        test('the column keeps its stored id while carrying the completion-testing label', () => {
            const col = completionColumn();
            assert.ok(col, 'ACCEPTANCE TESTED must remain the stored column id');
            // The id is in ~4,000 installs' card rows. Relabel and re-role freely;
            // renaming the id strands every card sitting in it.
            assert.strictEqual(col!.label, 'Completion Tested');
        });

        test('the column routes to the role that owns the completion-testing prompt', () => {
            // REGRESSION: the column was briefly re-roled to 'planner'. Every
            // column->role map fed 'planner' into the dispatch, which builds the
            // improve-plan PLANNER prompt — a plan rewriter, not a judge — while the
            // completion-testing prompt sat unreachable on the tester branch.
            // The role name is the prompt selector; it must name the branch that
            // actually renders this stage.
            assert.strictEqual(completionColumn()!.role, 'tester');
            // ...and the stage's entry point (the column before it) must hand off to
            // that same role.
            assert.strictEqual(columnToPromptRole('CODE REVIEWED'), 'tester');
            // Terminal by design: nothing auto-advances past completion testing.
            assert.strictEqual(columnToPromptRole('ACCEPTANCE TESTED'), null);
        });

        test('every provider column->role map agrees the stage is the tester', () => {
            // There are FOUR of these maps across two providers, and they are the
            // dispatch's actual role source — the column definition alone does not
            // settle it. A map left behind sends the stage to a different persona
            // with a different git policy, and no gate below this one can see it.
            const fs = require('fs');
            const path = require('path');
            const servicesDir = path.resolve(__dirname, '..', '..', '..', 'src', 'services');
            for (const file of ['KanbanProvider.ts', 'TaskViewerProvider.ts']) {
                const src = fs.readFileSync(path.join(servicesDir, file), 'utf8');
                const mappings = src.match(/'ACCEPTANCE TESTED':\s*(?:return\s*)?'(\w+)'|case 'ACCEPTANCE TESTED':\s*\n\s*return '(\w+)'/g) || [];
                assert.ok(mappings.length > 0, `${file} must map ACCEPTANCE TESTED to a role`);
                for (const m of mappings) {
                    assert.ok(
                        /'tester'/.test(m),
                        `${file}: ACCEPTANCE TESTED must map to 'tester', found: ${m}`
                    );
                }
            }
        });

        test('the Acceptance Tester stays OPTIONAL — it is not a core role', () => {
            // Decided, and reversed once already. The role ships unchecked under
            // <!-- OPTIONAL --> and `tester: false` in both defaults sources;
            // enabling it in Setup is what gives the pipeline this stage. Promoting
            // it to core makes an empty Completion Tested column appear on every
            // existing board, which is why it is not core. Do not re-promote it.
            const fs = require('fs');
            const path = require('path');
            const root = path.resolve(__dirname, '..', '..', '..');

            const shared = fs.readFileSync(path.join(root, 'src', 'webview', 'sharedDefaults.js'), 'utf8');
            assert.ok(/tester:\s*false/.test(shared), 'sharedDefaults.js must default tester to false');

            const global = fs.readFileSync(path.join(root, 'src', 'services', 'GlobalIntegrationConfigService.ts'), 'utf8');
            assert.ok(/tester:\s*false/.test(global), 'GlobalIntegrationConfigService must default tester to false');

            const html = fs.readFileSync(path.join(root, 'src', 'webview', 'kanban.html'), 'utf8');
            const optionalIdx = html.indexOf('<!-- OPTIONAL -->');
            const testerRowIdx = html.indexOf('data-role="tester"');
            assert.ok(optionalIdx > 0 && testerRowIdx > optionalIdx,
                'the Acceptance Tester row must sit under the Optional group, not Core');
            const row = html.slice(html.lastIndexOf('<div class="startup-row"', testerRowIdx), testerRowIdx);
            assert.ok(!/\bchecked\b/.test(row), 'the Acceptance Tester row must ship unchecked');
        });

        test('the Acceptance Tester is not offered as a team member', () => {
            // Its only home is the Completion Tested column. Intent checking inside a
            // review team is the LEAD's job (category 4 of its triage), so a
            // reviewer+tester team has nothing for the tester to do.
            const fs = require('fs');
            const path = require('path');
            const html = fs.readFileSync(
                path.resolve(__dirname, '..', '..', '..', 'src', 'webview', 'kanban.html'), 'utf8');
            const start = html.indexOf('const SHIPPED_TEAM_TYPES');
            const templates = html.slice(start, html.indexOf('\n        ];', start));
            assert.ok(start > 0 && templates.length > 0, 'SHIPPED_TEAM_TYPES must exist');
            assert.ok(!/role:\s*'tester'/.test(templates),
                'no team template may seat a tester — the stage is a column, not a team role');
        });

        test('the stage prompt states both acceptance criteria', () => {
            const prompt = buildKanbanBatchPrompt('tester', makePlans(1), {});
            assert.ok(prompt.includes('Completion Tester'), 'Should name the completion-testing persona');
            assert.ok(/deferred risks resolved/i.test(prompt), 'Should carry the deferred-risk criterion');
            assert.ok(/intent satisfied/i.test(prompt), 'Should carry the intent criterion');
        });

        test("the intent baseline is the plan's Goal, with the PRD optional", () => {
            // The incident this stage exists to catch had NO PRD entry — its intent
            // lived only in the plan's ## Goal. A PRD-primary baseline is blind to
            // exactly that class of failure.
            const prompt = buildKanbanBatchPrompt('tester', makePlans(1), {});
            assert.ok(
                prompt.includes("Treat the plan's ## Goal as the primary intent baseline"),
                'The plan Goal must be the primary intent baseline'
            );
            assert.ok(/PRD when present/i.test(prompt), 'The PRD must be optional, not required');
        });

        test('the stage distinguishes "no deferred record" from "no deferred findings"', () => {
            const prompt = buildKanbanBatchPrompt('tester', makePlans(1), {});
            assert.ok(prompt.includes('no deferred record'), 'Should report a missing record distinctly');
            assert.ok(
                /pre-existing plan written before the structured deferred-findings section existed/.test(prompt),
                'Should explain why a historical plan has no record rather than reading as clean'
            );
        });

        test('the stage may plan, but never edits code and never commits', () => {
            const prompt = buildKanbanBatchPrompt('tester', makePlans(1), { gitProhibitionEnabled: false });
            assert.ok(prompt.includes('Do NOT edit code'), 'Should withhold the code-editing remit');
            assert.ok(
                /follow-up plan file in \.switchboard\/plans\//.test(prompt),
                'Should grant the plan write'
            );
            assert.ok(
                /Do NOT plan net-new scope/.test(prompt),
                'Planning must be bounded to recorded findings and named intent gaps'
            );
            assert.ok(!/\bgit commit\b/i.test(prompt), 'The stage must not be told to commit');
        });
    });

    suite('SWITCHBOARD_LIVENESS_DIRECTIVE & apiPort injection', () => {
        const roles = ['planner', 'reviewer', 'tester', 'lead', 'coder', 'intern', 'analyst'] as const;

        test('SWITCHBOARD_LIVENESS_DIRECTIVE produces expected instruction string', () => {
            const directive = SWITCHBOARD_LIVENESS_DIRECTIVE(58312);
            assert.ok(directive.includes('SWITCHBOARD STATUS: Live (port 58312)'));
            assert.ok(directive.includes('http://127.0.0.1:58312'));
            assert.ok(directive.includes('Skip any port-discovery or health-check steps'));
        });

        test('liveness directive is injected for all 7 roles when apiPort > 0', () => {
            const plans = makePlans(1);
            for (const r of roles) {
                const prompt = buildKanbanBatchPrompt(r as any, plans, { apiPort: 58312 });
                assert.ok(
                    prompt.includes('SWITCHBOARD STATUS: Live (port 58312)'),
                    `role ${r} must receive liveness directive when apiPort > 0`
                );
                assert.ok(
                    prompt.includes('http://127.0.0.1:58312'),
                    `role ${r} must contain local api server url`
                );
            }
        });

        test('liveness directive is omitted for all 7 roles when apiPort is 0 or undefined', () => {
            const plans = makePlans(1);
            for (const r of roles) {
                const promptWithZero = buildKanbanBatchPrompt(r as any, plans, { apiPort: 0 });
                assert.ok(
                    !promptWithZero.includes('SWITCHBOARD STATUS: Live'),
                    `role ${r} must not receive liveness directive when apiPort is 0`
                );
                const promptWithUndef = buildKanbanBatchPrompt(r as any, plans, {});
                assert.ok(
                    !promptWithUndef.includes('SWITCHBOARD STATUS: Live'),
                    `role ${r} must not receive liveness directive when apiPort is undefined`
                );
            }
        });

        test('reviewer delegation uses injected port when apiPort > 0', () => {
            const plans = makePlans(1);
            const prompt = buildKanbanBatchPrompt('reviewer', plans, {
                apiPort: 58312,
                reviewerDelegationMode: true,
                reviewerCoderTerminal: 'Coding-coder-1',
                reviewerOriginLead: 'Coding-lead'
            });
            assert.ok(prompt.includes('against http://127.0.0.1:58312'), 'fixStep must use injected port');
            // Scoped to the DELEGATION fix-step, which is what the plan's Layer 3 covers.
            // A whole-prompt negative cannot hold: COMPLETION_STEP_*/CODING_COMPLETION_REPORT_
            // DIRECTIVE and the reviewer escalation line are shared constants that must keep
            // the file reference for the no-port (external / server-down) case. The liveness
            // directive is what supersedes them at read time — asserted below.
            const fixStepStart = prompt.indexOf('For valid CRITICAL/MAJOR findings');
            assert.ok(fixStepStart >= 0, 'delegation fix-step must be present');
            const fixStepEnd = prompt.indexOf('\n\n', fixStepStart);
            const fixStep = prompt.slice(fixStepStart, fixStepEnd < 0 ? undefined : fixStepEnd);
            assert.ok(
                !fixStep.includes('.switchboard/api-server-port.txt'),
                'fixStep must not reference port file when port is provided'
            );
            assert.ok(
                prompt.includes('use http://127.0.0.1:58312 and do NOT read that file'),
                'the liveness directive must supersede every remaining in-prompt port-file reference'
            );
        });

        test('reviewer delegation falls back to port file when apiPort is 0 or undefined', () => {
            const plans = makePlans(1);
            const prompt = buildKanbanBatchPrompt('reviewer', plans, {
                apiPort: 0,
                reviewerDelegationMode: true,
                reviewerCoderTerminal: 'Coding-coder-1',
                reviewerOriginLead: 'Coding-lead'
            });
            assert.ok(prompt.includes('against the port in .switchboard/api-server-port.txt'), 'fixStep must fall back to port file when apiPort is 0');
        });
    });
});
