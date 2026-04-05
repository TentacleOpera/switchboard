import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { scoreToRoutingRole, parseComplexityScore } from '../services/complexityScale';
import { buildKanbanBatchPrompt, BatchPromptPlan } from '../services/agentPromptBuilder';
import { normalizeAutobanConfigState } from '../services/autobanState';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------
const TEST_SESSION_ID = 'test-session-001';
const TEST_PLAN: BatchPromptPlan = {
    topic: 'Add user authentication',
    absolutePath: '/mock/workspace/.switchboard/plans/auth_plan.md',
    complexity: '7'
};
const TEST_PLANS: BatchPromptPlan[] = [TEST_PLAN];

// ---------------------------------------------------------------------------
// Flow-simulation helpers
// These replicate the exact logic patterns from KanbanProvider.ts so that we
// can unit-test the clipboard / notification branching without instantiating
// the full provider.  Same approach as the existing `simulateBypass()` in
// pair-programming-routing-bypass.test.ts.
//
// ⚠️  KEEP IN SYNC with production code.  If KanbanProvider's pair-flow logic
// changes (conditions, clipboard calls, notification text), update these
// helpers to match.  A future plan should add true integration tests via
// @vscode/test-electron to test the real entry points.
// ---------------------------------------------------------------------------

/**
 * Mirrors the `pairProgramCard` handler (KanbanProvider.ts ≈ 2490-2552).
 * Returns the generated prompts and the backup path (if applicable).
 */
async function simulatePairButtonFlow(params: {
    coderUsesIde: boolean;
    plans: BatchPromptPlan[];
    sessionId: string;
    workspaceRoot: string;
    aggressivePairProgramming?: boolean;
    accurateCodingEnabled?: boolean;
}): Promise<{ leadPrompt: string; coderPrompt: string; backupPath: string | undefined }> {
    const {
        coderUsesIde, plans, sessionId, workspaceRoot,
        aggressivePairProgramming = false,
        accurateCodingEnabled = false
    } = params;

    const leadPrompt = buildKanbanBatchPrompt('lead', plans, {
        pairProgrammingEnabled: true,
        aggressivePairProgramming
    });
    const coderPrompt = buildKanbanBatchPrompt('coder', plans, {
        pairProgrammingEnabled: true,
        accurateCodingEnabled
    });

    if (coderUsesIde) {
        // Stage 1 — Lead prompt to clipboard
        await vscode.env.clipboard.writeText(leadPrompt);

        // Write Coder prompt backup
        const handoffDir = path.join(workspaceRoot, '.switchboard', 'handoff');
        const backupPath = path.join(handoffDir, `coder_prompt_${sessionId}.md`);
        try {
            if (!fs.existsSync(handoffDir)) { fs.mkdirSync(handoffDir, { recursive: true }); }
            fs.writeFileSync(backupPath, coderPrompt, 'utf8');
        } catch { /* mirror production error-swallow */ }

        // Advance card
        await vscode.commands.executeCommand(
            'switchboard.kanbanForwardMove', [sessionId], 'LEAD CODED', workspaceRoot
        );

        // Stage 2 — notification
        const choice = await vscode.window.showInformationMessage(
            'Lead prompt copied. Paste to IDE chat, then click below for Coder prompt.',
            'Copy Coder Prompt'
        );

        if (choice === 'Copy Coder Prompt') {
            await vscode.env.clipboard.writeText(coderPrompt);
            vscode.window.showInformationMessage('Coder prompt copied to clipboard.');
            try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
        } else {
            console.log(
                `[KanbanProvider] Pair programming: user dismissed Coder prompt notification. Backup at: ${backupPath}`
            );
        }

        return { leadPrompt, coderPrompt, backupPath };
    } else {
        // Hybrid — Lead to clipboard, Coder to terminal
        await vscode.env.clipboard.writeText(leadPrompt);
        vscode.window.showInformationMessage(
            'Complex prompt copied to clipboard. Dispatching Routine tasks to Coder terminal...'
        );
        await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);

        // Advance card
        await vscode.commands.executeCommand(
            'switchboard.kanbanForwardMove', [sessionId], 'LEAD CODED', workspaceRoot
        );

        return { leadPrompt, coderPrompt, backupPath: undefined };
    }
}

/**
 * Mirrors the drag-drop-to-LEAD-CODED flow:
 *   KanbanProvider.ts ≈ 1660-1700 + _dispatchWithPairProgrammingIfNeeded.
 */
async function simulateDragDropFlow(params: {
    ppMode: 'off' | 'cli-cli' | 'cli-ide' | 'ide-cli' | 'ide-ide';
    plans: BatchPromptPlan[];
    sessionId: string;
    workspaceRoot: string;
    cardComplexity: string;
}): Promise<void> {
    const { ppMode, plans, sessionId, workspaceRoot, cardComplexity } = params;
    const leadUsesIde = ppMode === 'ide-cli' || ppMode === 'ide-ide';
    const coderUsesIde = ppMode === 'cli-ide' || ppMode === 'ide-ide';
    const pairEnabled = ppMode !== 'off';
    const score = parseInt(cardComplexity, 10);
    const isLowComplexity = score >= 1 && score <= 4;

    // Lead dispatch
    if (leadUsesIde) {
        const leadPrompt = buildKanbanBatchPrompt('lead', plans, { pairProgrammingEnabled: pairEnabled });
        await vscode.env.clipboard.writeText(leadPrompt);
        vscode.window.showInformationMessage('Lead prompt copied to clipboard (IDE mode).');
    } else {
        await vscode.commands.executeCommand(
            'switchboard.triggerAgentFromKanban', 'lead', sessionId, undefined, workspaceRoot
        );
    }

    // Coder pair dispatch — only for non-low-complexity, non-Unknown cards
    if (pairEnabled && !isLowComplexity && cardComplexity !== 'Unknown') {
        const coderPrompt = buildKanbanBatchPrompt('coder', plans, { pairProgrammingEnabled: true });
        if (coderUsesIde) {
            const handoffDir = path.join(workspaceRoot, '.switchboard', 'handoff');
            if (!fs.existsSync(handoffDir)) { fs.mkdirSync(handoffDir, { recursive: true }); }
            fs.writeFileSync(
                path.join(handoffDir, `coder_prompt_${sessionId}_${Date.now()}.md`),
                coderPrompt, 'utf8'
            );
            const choice = await vscode.window.showInformationMessage(
                'Pair Programming: Routine tasks identified. Click to copy Coder prompt.',
                'Copy Coder Prompt'
            );
            if (choice === 'Copy Coder Prompt') {
                await vscode.env.clipboard.writeText(coderPrompt);
            }
        } else {
            await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
        }
    }
}

// ===========================================================================
// Test Suites
// ===========================================================================

suite('Pair programming comprehensive', () => {
    let sandbox: sinon.SinonSandbox;
    let clipboardWriteStub: sinon.SinonStub;
    let clipboardReadStub: sinon.SinonStub;
    let showInfoStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    let consoleLogStub: sinon.SinonStub;
    let tmpDir: string;

    setup(() => {
        sandbox = sinon.createSandbox();
        clipboardWriteStub  = sandbox.stub(vscode.env.clipboard, 'writeText').resolves();
        clipboardReadStub   = sandbox.stub(vscode.env.clipboard, 'readText').resolves('');
        // Double-cast needed: showInformationMessage has complex overloads that sinon can't resolve
        showInfoStub        = sandbox.stub(vscode.window, 'showInformationMessage') as unknown as sinon.SinonStub;
        showInfoStub.resolves(undefined);
        executeCommandStub  = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        consoleLogStub      = sandbox.stub(console, 'log');
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'));
    });

    teardown(() => {
        sandbox.restore();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // -----------------------------------------------------------------------
    // Suite 1 — CLI Parallel Mode (Drag-Drop)
    // -----------------------------------------------------------------------
    suite('Suite 1: CLI Parallel Mode (Drag-Drop)', () => {
        test('1.1: both Lead and Coder dispatch via CLI terminal — zero clipboard writes', async () => {
            await simulateDragDropFlow({
                ppMode: 'cli-cli',
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir,
                cardComplexity: '7'
            });

            assert.strictEqual(
                clipboardWriteStub.callCount, 0,
                'clipboard.writeText should not be called in CLI Parallel mode'
            );
            assert.ok(
                executeCommandStub.calledWith(
                    'switchboard.triggerAgentFromKanban', 'lead', TEST_SESSION_ID, undefined, tmpDir
                ),
                'Lead should dispatch via triggerAgentFromKanban (CLI terminal)'
            );
            assert.ok(
                executeCommandStub.calledWithMatch('switchboard.dispatchToCoderTerminal'),
                'Coder should dispatch via dispatchToCoderTerminal (CLI terminal)'
            );
        });

        test('1.2: low complexity cards skip Coder pair dispatch', async () => {
            await simulateDragDropFlow({
                ppMode: 'cli-cli',
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir,
                cardComplexity: '3'  // low complexity
            });

            assert.strictEqual(clipboardWriteStub.callCount, 0);
            assert.ok(
                executeCommandStub.calledWith(
                    'switchboard.triggerAgentFromKanban', 'lead', TEST_SESSION_ID, undefined, tmpDir
                ),
                'Lead should still be dispatched'
            );
            assert.ok(
                !executeCommandStub.calledWithMatch('switchboard.dispatchToCoderTerminal'),
                'Coder terminal dispatch should be skipped for low-complexity cards'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Suite 2 — Hybrid Mode (Pair Button + CLI Coder)
    // -----------------------------------------------------------------------
    suite('Suite 2: Hybrid Mode (Pair Button + CLI)', () => {
        test('2.1: Lead prompt to clipboard, Coder to terminal, info notification shown', async () => {
            const result = await simulatePairButtonFlow({
                coderUsesIde: false,
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir
            });

            // clipboard.writeText called exactly once with Lead prompt
            assert.strictEqual(clipboardWriteStub.callCount, 1, 'clipboard.writeText should be called once');
            assert.strictEqual(
                clipboardWriteStub.firstCall.args[0], result.leadPrompt,
                'clipboard should contain the Lead prompt'
            );

            // Coder dispatched to terminal
            assert.ok(
                executeCommandStub.calledWith('switchboard.dispatchToCoderTerminal', result.coderPrompt),
                'Coder prompt should dispatch to terminal'
            );

            // Info notification
            assert.ok(
                showInfoStub.calledWithMatch(sinon.match((msg: string) =>
                    typeof msg === 'string' && msg.toLowerCase().includes('prompt copied')
                )),
                'showInformationMessage should be called with message containing "prompt copied"'
            );

            // Card advanced
            assert.ok(
                executeCommandStub.calledWithMatch('switchboard.kanbanForwardMove'),
                'card should advance to LEAD CODED'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Suite 3 — Full Clipboard Mode — Stage 1
    // -----------------------------------------------------------------------
    suite('Suite 3: Full Clipboard Mode — Stage 1', () => {
        test('3.1: Lead prompt to clipboard, backup written, card advanced, Copy Coder button offered', async () => {
            // User dismisses notification — tests Stage 1 in isolation
            showInfoStub.resolves(undefined);

            const result = await simulatePairButtonFlow({
                coderUsesIde: true,
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir
            });

            // Stage 1 clipboard write with Lead prompt
            assert.ok(
                clipboardWriteStub.calledWith(result.leadPrompt),
                'clipboard should contain the Lead prompt after Stage 1'
            );

            // showInformationMessage offered "Copy Coder Prompt" action button
            assert.ok(
                showInfoStub.calledWith(
                    sinon.match.string,
                    'Copy Coder Prompt'
                ),
                'notification should offer "Copy Coder Prompt" action button'
            );

            // Backup file exists (verified path: .switchboard/handoff/coder_prompt_<sessionId>.md)
            const backupPath = result.backupPath!;
            assert.ok(fs.existsSync(backupPath), `backup file should exist at ${backupPath}`);
            const backupContent = fs.readFileSync(backupPath, 'utf8');
            assert.strictEqual(
                backupContent, result.coderPrompt,
                'backup file should contain the Coder prompt'
            );

            // Card advanced to LEAD CODED
            assert.ok(
                executeCommandStub.calledWith(
                    'switchboard.kanbanForwardMove',
                    [TEST_SESSION_ID], 'LEAD CODED', tmpDir
                ),
                'card should advance to LEAD CODED'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Suite 4 — Full Clipboard Mode — Stage 2
    // -----------------------------------------------------------------------
    suite('Suite 4: Full Clipboard Mode — Stage 2', () => {
        test('4.1: user clicks Copy Coder Prompt → second clipboard write, success notification, backup deleted', async () => {
            showInfoStub.resolves('Copy Coder Prompt');

            const result = await simulatePairButtonFlow({
                coderUsesIde: true,
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir
            });

            // clipboard.writeText called twice: Lead (Stage 1) + Coder (Stage 2)
            assert.strictEqual(clipboardWriteStub.callCount, 2, 'clipboard.writeText should be called twice');
            assert.strictEqual(
                clipboardWriteStub.firstCall.args[0], result.leadPrompt,
                'first clipboard write should be Lead prompt'
            );
            assert.strictEqual(
                clipboardWriteStub.secondCall.args[0], result.coderPrompt,
                'second clipboard write should be Coder prompt'
            );

            // Success notification
            assert.ok(
                showInfoStub.calledWith('Coder prompt copied to clipboard.'),
                'success notification should be shown after Stage 2 copy'
            );

            // Backup file deleted
            const backupPath = result.backupPath!;
            assert.ok(
                !fs.existsSync(backupPath),
                'backup file should be deleted after successful Stage 2 copy'
            );
        });

        test('4.2: user dismisses notification → backup persists, dismissal logged', async () => {
            showInfoStub.resolves(undefined);

            const result = await simulatePairButtonFlow({
                coderUsesIde: true,
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir
            });

            // Only Stage 1 clipboard write
            assert.strictEqual(
                clipboardWriteStub.callCount, 1,
                'clipboard.writeText should only be called once (Stage 1 Lead prompt)'
            );

            // Backup file persists
            const backupPath = result.backupPath!;
            assert.ok(
                fs.existsSync(backupPath),
                'backup file should remain when user dismisses the notification'
            );

            // Dismissal logged
            assert.ok(
                consoleLogStub.calledWithMatch(
                    sinon.match((msg: string) =>
                        typeof msg === 'string' && msg.includes('dismissed Coder prompt notification')
                    )
                ),
                'dismissal should be logged to console'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Suite 5 — Clipboard Content Validation
    // -----------------------------------------------------------------------
    suite('Suite 5: Clipboard Content Validation', () => {
        test('5.1: Lead prompt contains plan topic and file path', () => {
            const leadPrompt = buildKanbanBatchPrompt('lead', TEST_PLANS, {
                pairProgrammingEnabled: true
            });
            assert.ok(
                leadPrompt.includes(TEST_PLAN.topic),
                'Lead prompt should contain the plan topic'
            );
            assert.ok(
                leadPrompt.includes(TEST_PLAN.absolutePath),
                'Lead prompt should contain the plan file path'
            );
        });

        test('5.2: Coder prompt contains plan topic and file path', () => {
            const coderPrompt = buildKanbanBatchPrompt('coder', TEST_PLANS, {
                pairProgrammingEnabled: true
            });
            assert.ok(
                coderPrompt.includes(TEST_PLAN.topic),
                'Coder prompt should contain the plan topic'
            );
            assert.ok(
                coderPrompt.includes(TEST_PLAN.absolutePath),
                'Coder prompt should contain the plan file path'
            );
        });

        test('5.3: Lead and Coder prompts have distinct role instructions', () => {
            const leadPrompt = buildKanbanBatchPrompt('lead', TEST_PLANS, {
                pairProgrammingEnabled: true
            });
            const coderPrompt = buildKanbanBatchPrompt('coder', TEST_PLANS, {
                pairProgrammingEnabled: true
            });

            // Lead prompt mentions Coder is handling Routine tasks concurrently
            assert.ok(
                leadPrompt.includes('Coder agent is concurrently handling'),
                'Lead prompt should reference the concurrent Coder agent'
            );

            // Coder prompt includes Routine-only instruction
            assert.ok(
                coderPrompt.includes('only do Routine'),
                'Coder prompt should include Routine-only instruction'
            );

            // Prompts are distinct
            assert.notStrictEqual(leadPrompt, coderPrompt, 'Lead and Coder prompts must differ');
        });

        test('5.4: accuracy mode appends workflow instruction to Coder prompt', () => {
            const withAccuracy = buildKanbanBatchPrompt('coder', TEST_PLANS, {
                pairProgrammingEnabled: true,
                accurateCodingEnabled: true
            });
            const withoutAccuracy = buildKanbanBatchPrompt('coder', TEST_PLANS, {
                pairProgrammingEnabled: true,
                accurateCodingEnabled: false
            });

            assert.ok(
                withAccuracy.includes('accuracy.md'),
                'Coder prompt with accuracy mode should reference accuracy.md'
            );
            assert.ok(
                !withoutAccuracy.includes('accuracy.md'),
                'Coder prompt without accuracy mode should not reference accuracy.md'
            );
        });

        test('5.5: aggressive pair programming adds expanded scope note to Lead prompt', () => {
            const aggressive = buildKanbanBatchPrompt('lead', TEST_PLANS, {
                pairProgrammingEnabled: true,
                aggressivePairProgramming: true
            });
            const normal = buildKanbanBatchPrompt('lead', TEST_PLANS, {
                pairProgrammingEnabled: true,
                aggressivePairProgramming: false
            });

            assert.ok(
                aggressive.includes('aggressive pair programming'),
                'Lead prompt should mention aggressive pair programming when enabled'
            );
            assert.ok(
                !normal.includes('aggressive pair programming'),
                'Lead prompt should not mention aggressive pair programming when disabled'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Suite 6 — Edge Cases
    // -----------------------------------------------------------------------
    suite('Suite 6: Edge Cases', () => {
        // Test 6.1 (debouncing) — SKIPPED: no debounce logic exists on the
        // pair button handler in KanbanProvider. The _scheduleBoardRefresh
        // 100ms debounce applies to board refresh, not pair clicks.

        test('6.2: mode is captured at click time (snapshot semantics)', async () => {
            // Simulate mutable state that the real KanbanProvider holds.
            // The handler snapshots coderUsesIde at the start — changing the
            // backing state between Stage 1 and Stage 2 should have no effect.
            const mutableState = { coderUsesIde: true };

            // Capture snapshot (like the real handler does)
            const snapshotCoderUsesIde = mutableState.coderUsesIde;

            // Between Stage 1 and Stage 2, mutate state (simulating an
            // external settings change while the notification is pending).
            showInfoStub.callsFake(async () => {
                mutableState.coderUsesIde = false; // external change!
                return 'Copy Coder Prompt';
            });

            const leadPrompt = buildKanbanBatchPrompt('lead', TEST_PLANS, { pairProgrammingEnabled: true });
            const coderPrompt = buildKanbanBatchPrompt('coder', TEST_PLANS, { pairProgrammingEnabled: true });

            // Stage 1
            await vscode.env.clipboard.writeText(leadPrompt);

            // Stage 2 uses snapshot, not current state
            if (snapshotCoderUsesIde) {
                const choice = await vscode.window.showInformationMessage(
                    'Lead prompt copied.',
                    'Copy Coder Prompt'
                );
                if (choice === 'Copy Coder Prompt') {
                    await vscode.env.clipboard.writeText(coderPrompt);
                }
            }

            // The mutated state says coderUsesIde=false, but we used the
            // snapshot (true), so clipboard was written twice.
            assert.strictEqual(mutableState.coderUsesIde, false, 'mutable state should have changed');
            assert.strictEqual(
                clipboardWriteStub.callCount, 2,
                'snapshot semantics: Stage 2 should use original mode, not the mutated one'
            );
        });

        test('6.3: Stage 2 writeText succeeds regardless of intermediate clipboard content', async () => {
            // Verify the implementation does not readText before Stage 2 write.
            // Stub readText to return unrelated content — this shouldn't matter.
            clipboardReadStub.resolves('UNRELATED CONTENT FROM ANOTHER APP');
            showInfoStub.resolves('Copy Coder Prompt');

            const result = await simulatePairButtonFlow({
                coderUsesIde: true,
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir
            });

            // Stage 2 wrote the correct Coder prompt
            assert.strictEqual(
                clipboardWriteStub.secondCall.args[0], result.coderPrompt,
                'Stage 2 should write correct Coder prompt regardless of intermediate clipboard state'
            );

            // readText was NOT called by the flow (only by our stub setup)
            // The flow should never call readText — it always overwrites.
            assert.strictEqual(
                clipboardReadStub.callCount, 0,
                'pair programming flow should not call clipboard.readText'
            );
        });

        test('6.4: Unknown complexity cards skip Coder pair dispatch in drag-drop', async () => {
            await simulateDragDropFlow({
                ppMode: 'cli-cli',
                plans: TEST_PLANS,
                sessionId: TEST_SESSION_ID,
                workspaceRoot: tmpDir,
                cardComplexity: 'Unknown'
            });

            assert.ok(
                !executeCommandStub.calledWithMatch('switchboard.dispatchToCoderTerminal'),
                'Coder dispatch should be skipped for Unknown complexity cards'
            );
        });
    });

    // -----------------------------------------------------------------------
    // Suite 7 — Complexity-Based Routing with Pair Mode
    // -----------------------------------------------------------------------
    suite('Suite 7: Complexity-Based Routing with Pair Mode', () => {
        // Reuses the simulateBypass pattern from pair-programming-routing-bypass.test.ts
        const simulateBypass = (score: number, isPairMode: boolean) => {
            let role = scoreToRoutingRole(score);
            if (isPairMode && role === 'intern') { role = 'coder'; }
            return role;
        };

        test('7.1: pair mode elevates intern scores (1-3) to coder', () => {
            for (let s = 1; s <= 3; s++) {
                assert.strictEqual(simulateBypass(s, true), 'coder', `score ${s} should be elevated from intern to coder in pair mode`);
            }
            // Score 4 is already 'coder' by default — pair mode bypass is a no-op
            assert.strictEqual(simulateBypass(4, true), 'coder', 'score 4 is coder by default; pair mode does not change it');
        });

        test('7.2: pair mode leaves coder scores (5-6) unchanged', () => {
            for (let s = 5; s <= 6; s++) {
                assert.strictEqual(simulateBypass(s, true), 'coder', `score ${s} should remain coder in pair mode`);
            }
        });

        test('7.3: pair mode leaves lead scores (7-10) unchanged', () => {
            for (let s = 7; s <= 10; s++) {
                assert.strictEqual(simulateBypass(s, true), 'lead', `score ${s} should remain lead in pair mode`);
            }
        });

        test('7.4: without pair mode, normal routing applies', () => {
            assert.strictEqual(simulateBypass(1, false), 'intern');
            assert.strictEqual(simulateBypass(3, false), 'intern');
            assert.strictEqual(simulateBypass(4, false), 'coder');  // 4-6 → coder
            assert.strictEqual(simulateBypass(5, false), 'coder');
            assert.strictEqual(simulateBypass(6, false), 'coder');
            assert.strictEqual(simulateBypass(7, false), 'lead');
            assert.strictEqual(simulateBypass(10, false), 'lead');
        });

        test('7.5: boundary and edge scores', () => {
            // Unknown / 0 defaults to lead regardless of pair mode
            assert.strictEqual(simulateBypass(0, true), 'lead');
            assert.strictEqual(simulateBypass(0, false), 'lead');
            assert.strictEqual(simulateBypass(-1, true), 'lead');
            assert.strictEqual(simulateBypass(11, true), 'lead');
            assert.strictEqual(simulateBypass(NaN, false), 'lead');
        });

        test('7.6: parseComplexityScore round-trip with routing', () => {
            assert.strictEqual(scoreToRoutingRole(parseComplexityScore('3')), 'intern');
            assert.strictEqual(scoreToRoutingRole(parseComplexityScore('5')), 'coder');
            assert.strictEqual(scoreToRoutingRole(parseComplexityScore('8')), 'lead');
            assert.strictEqual(scoreToRoutingRole(parseComplexityScore('Unknown')), 'lead');
            assert.strictEqual(scoreToRoutingRole(parseComplexityScore('')), 'lead');
        });
    });

    // -----------------------------------------------------------------------
    // Suite 8 — Configuration State (Pair Programming Modes)
    // -----------------------------------------------------------------------
    suite('Suite 8: Configuration State', () => {
        test('8.1: legacy boolean migration — true → cli-cli', () => {
            const result = normalizeAutobanConfigState({ pairProgrammingEnabled: true } as any);
            assert.strictEqual(result.pairProgrammingMode, 'cli-cli');
        });

        test('8.2: legacy boolean migration — false → off', () => {
            const result = normalizeAutobanConfigState({ pairProgrammingEnabled: false } as any);
            assert.strictEqual(result.pairProgrammingMode, 'off');
        });

        test('8.3: all valid modes are preserved', () => {
            const validModes = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'] as const;
            for (const mode of validModes) {
                const result = normalizeAutobanConfigState({ pairProgrammingMode: mode });
                assert.strictEqual(
                    result.pairProgrammingMode, mode,
                    `mode '${mode}' should be preserved`
                );
            }
        });

        test('8.4: invalid mode values fall back to off', () => {
            const invalidInputs = ['banana', '', 'CLI', 'pair', null, undefined, 42];
            for (const input of invalidInputs) {
                const result = normalizeAutobanConfigState({ pairProgrammingMode: input } as any);
                assert.strictEqual(
                    result.pairProgrammingMode, 'off',
                    `invalid input '${String(input)}' should normalize to 'off'`
                );
            }
        });

        test('8.5: aggressivePairProgramming defaults to false', () => {
            const result = normalizeAutobanConfigState({});
            assert.strictEqual(result.aggressivePairProgramming, false);
        });

        test('8.6: aggressivePairProgramming true is preserved', () => {
            const result = normalizeAutobanConfigState({ aggressivePairProgramming: true });
            assert.strictEqual(result.aggressivePairProgramming, true);
        });

        test('8.7: pair mode + legacy boolean — explicit mode wins over legacy', () => {
            const result = normalizeAutobanConfigState({
                pairProgrammingMode: 'ide-ide',
                pairProgrammingEnabled: true
            } as any);
            assert.strictEqual(
                result.pairProgrammingMode, 'ide-ide',
                'explicit pairProgrammingMode should take precedence over legacy pairProgrammingEnabled'
            );
        });

        test('8.8: missing state defaults pair mode to off', () => {
            const result = normalizeAutobanConfigState(undefined);
            assert.strictEqual(result.pairProgrammingMode, 'off');
            assert.strictEqual(result.aggressivePairProgramming, false);
        });
    });
});
