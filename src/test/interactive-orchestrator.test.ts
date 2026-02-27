import * as assert from 'assert';
import { InteractiveOrchestrator } from '../services/InteractiveOrchestrator.ts';

/**
 * Helper to wait for a condition with timeout
 */
async function waitFor(condition: () => boolean, timeoutMs: number = 3000, pollIntervalMs: number = 50): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
}

/**
 * Helper to wait for next tick (for setImmediate/setTimeout callbacks)
 */
async function nextTick(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function run() {
    console.log('Running InteractiveOrchestrator Tests...\n');

    // Test Case 1: start() triggers the first stage immediately (after tick)
    console.log('Test 1: start() triggers the first stage after initialization');
    {
        let dispatchCalled = false;
        let dispatchedRole: string | undefined;
        
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async (role, sessionId, instruction) => {
                dispatchCalled = true;
                dispatchedRole = role;
            }
        );
        
        orchestrator.start('test-session-1');
        
        // Wait for setImmediate callback to execute
        await nextTick();
        
        assert.strictEqual(dispatchCalled, true, 'Dispatch callback should be called after start');
        assert.strictEqual(dispatchedRole, 'planner', 'First stage should be planner');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 2: advance() correctly transitions to the next defined stage
    console.log('Test 2: advance() correctly transitions to the next stage');
    {
        const dispatchedRoles: string[] = [];
        
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async (role) => {
                dispatchedRoles.push(role);
            }
        );
        
        orchestrator.start('test-session-2');
        await nextTick();
        
        // First stage (planner) should have been dispatched
        assert.strictEqual(dispatchedRoles.length, 1, 'Should have dispatched first stage');
        assert.strictEqual(dispatchedRoles[0], 'planner', 'First stage should be planner');
        
        // Manually advance to next stage
        await orchestrator.advance();
        
        // Second stage (lead) should have been dispatched
        assert.strictEqual(dispatchedRoles.length, 2, 'Should have dispatched second stage');
        assert.strictEqual(dispatchedRoles[1], 'lead', 'Second stage should be lead');
        
        // Verify state
        const state = orchestrator.getState();
        assert.strictEqual(state.currentStageIndex, 2, 'Should be at index 2 (reviewer)');
        assert.strictEqual(state.running, true, 'Should still be running');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 3: advance() stops execution when no next stage is available
    console.log('Test 3: advance() stops execution when workflow is complete');
    {
        const dispatchedRoles: string[] = [];
        
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async (role) => {
                dispatchedRoles.push(role);
            }
        );
        
        orchestrator.start('test-session-3');
        await nextTick();
        
        // Dispatch all 3 stages (planner, lead, reviewer)
        assert.strictEqual(dispatchedRoles.length, 1, 'Should have dispatched first stage');
        
        await orchestrator.advance(); // lead
        assert.strictEqual(dispatchedRoles.length, 2, 'Should have dispatched second stage');
        
        await orchestrator.advance(); // reviewer
        assert.strictEqual(dispatchedRoles.length, 3, 'Should have dispatched third stage');
        
        // After reviewer, workflow should be complete
        const state = orchestrator.getState();
        assert.strictEqual(state.running, false, 'Should stop running after last stage');
        assert.strictEqual(state.secondsRemaining, 0, 'Timer should be reset to 0');
        assert.strictEqual(state.currentStageIndex, 3, 'Should be at index 3 (past last stage)');
        
        // Further advances should not dispatch
        const beforeCount = dispatchedRoles.length;
        await orchestrator.advance();
        assert.strictEqual(dispatchedRoles.length, beforeCount, 'Should not dispatch after workflow complete');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 4: Timer respects the configured interval
    console.log('Test 4: Timer respects the configured interval');
    {
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {}
        );
        
        const customInterval = 600; // 10 minutes
        orchestrator.start('test-session-4', customInterval);
        
        const state = orchestrator.getState();
        assert.strictEqual(state.intervalSeconds, customInterval, 'Should use custom interval');
        assert.strictEqual(state.secondsRemaining, customInterval, 'Should start with full interval');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 5: Default interval uses DEFAULT_STAGE_TIMEOUT_SECONDS (420)
    console.log('Test 5: Default interval is 420 seconds (7 minutes)');
    {
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {}
        );
        
        orchestrator.start('test-session-5');
        
        const state = orchestrator.getState();
        assert.strictEqual(state.intervalSeconds, 420, 'Default interval should be 420 seconds');
        assert.strictEqual(state.secondsRemaining, 420, 'Should start with 420 seconds');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 6: stop() halts execution and resets state
    console.log('Test 6: stop() halts execution and resets state');
    {
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {}
        );
        
        orchestrator.start('test-session-6');
        await nextTick();
        
        assert.strictEqual(orchestrator.getState().running, true, 'Should be running after start');
        
        orchestrator.stop();
        
        const state = orchestrator.getState();
        assert.strictEqual(state.running, false, 'Should not be running after stop');
        assert.strictEqual(state.secondsRemaining, 0, 'Timer should be 0 after stop');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 7: Interval normalization respects min/max bounds
    console.log('Test 7: Interval normalization respects min/max bounds');
    {
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {}
        );
        
        // Test below minimum
        orchestrator.setInterval(5);
        assert.strictEqual(orchestrator.getState().intervalSeconds, 10, 'Should clamp to minimum 10');
        
        // Test above maximum
        orchestrator.setInterval(5000);
        assert.strictEqual(orchestrator.getState().intervalSeconds, 3600, 'Should clamp to maximum 3600');
        
        // Test valid range
        orchestrator.setInterval(300);
        assert.strictEqual(orchestrator.getState().intervalSeconds, 300, 'Should accept valid interval');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 8: setSession() while stopped resets stage index; while running is no-op
    console.log('Test 8: setSession() behavior — stopped vs running');
    {
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {}
        );
        
        // 8a: While stopped — should reset stage + update sessionId
        orchestrator.start('test-session-8');
        await nextTick();
        orchestrator.stop();
        
        orchestrator.setSession('new-session-8a');
        let state = orchestrator.getState();
        assert.strictEqual(state.sessionId, 'new-session-8a', '8a: Session ID should be updated when stopped');
        assert.strictEqual(state.currentStageIndex, 0, '8a: Stage index should be reset to 0');
        assert.strictEqual(state.running, false, '8a: Should not be running');
        
        // 8b: While running — should be no-op
        orchestrator.start('test-session-8b');
        await nextTick();
        
        assert.strictEqual(orchestrator.getState().running, true, '8b: Should be running after start');
        assert.strictEqual(orchestrator.getState().sessionId, 'test-session-8b', '8b: Session should be test-session-8b');
        
        orchestrator.setSession('other-session');
        state = orchestrator.getState();
        assert.strictEqual(state.sessionId, 'test-session-8b', '8b: Session ID should NOT change while running');
        assert.strictEqual(state.running, true, '8b: Should still be running');
        assert.strictEqual(state.currentStageIndex, 1, '8b: Stage index should be unchanged');
        
        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 9: stop() before initialization tick prevents first dispatch
    console.log('Test 9: stop() before initialization tick prevents dispatch');
    {
        let dispatchCount = 0;
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {
                dispatchCount++;
            }
        );

        orchestrator.start('test-session-9');
        orchestrator.stop();
        await nextTick();

        assert.strictEqual(dispatchCount, 0, 'Dispatch should not occur after immediate stop');
        assert.strictEqual(orchestrator.getState().running, false, 'Orchestrator should remain stopped');

        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 10: stop() works while running (regression guard)
    console.log('Test 10: stop() halts a running orchestration');
    {
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async () => {}
        );

        orchestrator.start('test-session-10');
        await nextTick();

        assert.strictEqual(orchestrator.getState().running, true, 'Should be running after start');

        orchestrator.stop();

        const state = orchestrator.getState();
        assert.strictEqual(state.running, false, 'Should not be running after stop');
        assert.strictEqual(state.secondsRemaining, 0, 'Timer should be 0');

        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    // Test Case 11: restore() resumes from saved state
    console.log('Test 11: restore() resumes orchestration from saved state');
    {
        let dispatchedRole: string | undefined;
        const orchestrator = new InteractiveOrchestrator(
            undefined,
            async (role) => { dispatchedRole = role; }
        );

        orchestrator.restore('restored-session', 150, 1);

        const state = orchestrator.getState();
        assert.strictEqual(state.running, true, 'Should be running after restore');
        assert.strictEqual(state.sessionId, 'restored-session', 'Session should match');
        assert.strictEqual(state.secondsRemaining, 150, 'Seconds remaining should be 150');
        assert.strictEqual(state.currentStageIndex, 1, 'Stage index should be 1');

        // Advance should dispatch the stage at index 1 (lead)
        await orchestrator.advance();
        assert.strictEqual(dispatchedRole, 'lead', 'Should dispatch lead (stage index 1)');

        orchestrator.dispose();
        console.log('✓ Passed\n');
    }

    console.log('All tests passed! ✓');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
