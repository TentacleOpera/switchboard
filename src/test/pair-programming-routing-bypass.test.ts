import * as assert from 'assert';
import { scoreToRoutingRole } from '../services/complexityScale';

type RoutedRole = 'lead' | 'coder' | 'intern' | 'team-lead';

function simulateRoutedRole(score: number, teamLeadComplexityCutoff: number, isPairMode: boolean): RoutedRole {
    if (teamLeadComplexityCutoff > 0 && score >= teamLeadComplexityCutoff) {
        return 'team-lead';
    }

    let role: RoutedRole = scoreToRoutingRole(score);
    if (isPairMode && role === 'intern') {
        role = 'coder';
    }

    return role;
}

function run() {
    assert.strictEqual(simulateRoutedRole(4, 0, false), 'intern', 'cutoff 0 should preserve default intern routing');
    assert.strictEqual(simulateRoutedRole(5, 0, false), 'coder', 'cutoff 0 should preserve default coder routing');
    assert.strictEqual(simulateRoutedRole(7, 0, false), 'lead', 'cutoff 0 should preserve default lead routing');

    assert.strictEqual(simulateRoutedRole(4, 5, false), 'intern', 'cutoff 5 should leave lower scores on the standard routing map');
    assert.strictEqual(simulateRoutedRole(5, 5, false), 'team-lead', 'cutoff 5 should route medium scores to Team Lead');
    assert.strictEqual(simulateRoutedRole(10, 5, false), 'team-lead', 'cutoff 5 should route high scores to Team Lead');

    assert.strictEqual(simulateRoutedRole(6, 7, false), 'coder', 'cutoff 7 should not affect sub-high scores');
    assert.strictEqual(simulateRoutedRole(7, 7, false), 'team-lead', 'cutoff 7 should route high scores to Team Lead');
    assert.strictEqual(simulateRoutedRole(10, 7, false), 'team-lead', 'cutoff 7 should keep high scores on Team Lead');

    assert.strictEqual(simulateRoutedRole(1, 0, true), 'coder', 'pair mode should still elevate intern scores to coder');
    assert.strictEqual(simulateRoutedRole(4, 0, true), 'coder', 'pair mode should elevate all intern-range scores to coder');
    assert.strictEqual(simulateRoutedRole(5, 0, true), 'coder', 'pair mode should leave coder scores unchanged');
    assert.strictEqual(simulateRoutedRole(7, 0, true), 'lead', 'pair mode should leave lead scores unchanged');
    assert.strictEqual(simulateRoutedRole(7, 5, true), 'team-lead', 'pair mode must not demote Team Lead routes');
    assert.strictEqual(simulateRoutedRole(10, 1, true), 'team-lead', 'pair mode must preserve Team Lead when Team Lead routes all scores');

    console.log('pair programming routing bypass test passed');
}

try {
    run();
} catch (error) {
    console.error('pair programming routing bypass test failed:', error);
    process.exit(1);
}
