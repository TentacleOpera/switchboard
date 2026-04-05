import * as assert from 'assert';
import { scoreToRoutingRole } from '../services/complexityScale';

suite('Pair programming routing bypass', () => {
    // Note: Full integration tests for _resolveComplexityRoutedRole and
    // _autobanRoutePlanReviewedCard require mocking KanbanProvider/TaskViewerProvider
    // internals. These unit tests verify the bypass logic pattern in isolation.

    test('intern results should be elevated to coder in pair mode', () => {
        // Simulate the bypass pattern used in callers:
        // let role = scoreToRoutingRole(score);
        // if (isPairMode && role === 'intern') role = 'coder';
        const simulateBypass = (score: number, isPairMode: boolean) => {
            let role = scoreToRoutingRole(score);
            if (isPairMode && role === 'intern') { role = 'coder'; }
            return role;
        };

        // Pair mode ON: intern scores (1-4) elevated to coder
        assert.strictEqual(simulateBypass(1, true), 'coder');
        assert.strictEqual(simulateBypass(2, true), 'coder');
        assert.strictEqual(simulateBypass(3, true), 'coder');
        assert.strictEqual(simulateBypass(4, true), 'coder');

        // Pair mode ON: coder scores (5-6) unchanged
        assert.strictEqual(simulateBypass(5, true), 'coder');
        assert.strictEqual(simulateBypass(6, true), 'coder');

        // Pair mode ON: lead scores (7-10) unchanged
        assert.strictEqual(simulateBypass(7, true), 'lead');
        assert.strictEqual(simulateBypass(10, true), 'lead');

        // Pair mode OFF: normal routing
        assert.strictEqual(simulateBypass(4, false), 'intern');
        assert.strictEqual(simulateBypass(5, false), 'coder');
        assert.strictEqual(simulateBypass(7, false), 'lead');

        // Unknown defaults to lead regardless of pair mode
        assert.strictEqual(simulateBypass(0, true), 'lead');
        assert.strictEqual(simulateBypass(0, false), 'lead');
    });

    test('custom routing map should override default thresholds', () => {
        // Simulate resolveRoutedRole logic with a custom routing map
        const customMap = { lead: [7, 8, 9, 10], coder: [3, 4, 5, 6], intern: [1, 2] };
        const resolveWithMap = (score: number, map: typeof customMap | null, isPairMode: boolean) => {
            let role: 'lead' | 'coder' | 'intern';
            if (map) {
                if (map.intern.includes(score)) { role = 'intern'; }
                else if (map.coder.includes(score)) { role = 'coder'; }
                else { role = 'lead'; }
            } else {
                role = scoreToRoutingRole(score);
            }
            if (isPairMode && role === 'intern') { role = 'coder'; }
            return role;
        };

        // Score 3: default → intern, custom map → coder
        assert.strictEqual(scoreToRoutingRole(3), 'intern', 'default: score 3 → intern');
        assert.strictEqual(resolveWithMap(3, customMap, false), 'coder', 'custom map: score 3 → coder');

        // Score 1: custom map → intern, pair mode → elevated to coder
        assert.strictEqual(resolveWithMap(1, customMap, false), 'intern', 'custom map: score 1 → intern');
        assert.strictEqual(resolveWithMap(1, customMap, true), 'coder', 'custom map + pair mode: score 1 → coder');

        // Score 7: custom map → lead, pair mode doesn't affect lead
        assert.strictEqual(resolveWithMap(7, customMap, true), 'lead', 'custom map + pair mode: score 7 → lead');

        // No custom map: default behavior preserved
        assert.strictEqual(resolveWithMap(3, null, false), 'intern', 'no custom map: score 3 → intern (default)');
        assert.strictEqual(resolveWithMap(5, null, false), 'coder', 'no custom map: score 5 → coder (default)');
    });
});
