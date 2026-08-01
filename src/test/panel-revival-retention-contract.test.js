const fs = require('fs');
const path = require('path');
const assert = require('assert');

function testPanelRevivalRetentionContract() {
    const kanbanProviderPath = path.join(__dirname, '../services/KanbanProvider.ts');
    const planningProviderPath = path.join(__dirname, '../services/PlanningPanelProvider.ts');
    const designProviderPath = path.join(__dirname, '../services/DesignPanelProvider.ts');

    const kanbanCode = fs.readFileSync(kanbanProviderPath, 'utf8');
    const planningCode = fs.readFileSync(planningProviderPath, 'utf8');
    const designCode = fs.readFileSync(designProviderPath, 'utf8');

    // 1. Every createWebviewPanel passes retainContextWhenHidden: true
    [
        { name: 'KanbanProvider', code: kanbanCode },
        { name: 'PlanningPanelProvider', code: planningCode },
        { name: 'DesignPanelProvider', code: designCode }
    ].forEach(({ name, code }) => {
        const matches = code.match(/createWebviewPanel\(/g) || [];
        assert.ok(matches.length > 0, `${name} must contain createWebviewPanel`);
        assert.ok(
            code.includes('retainContextWhenHidden: true'),
            `${name} must pass retainContextWhenHidden: true`
        );
    });

    // 2. Deserialize methods use reviveWithRetention and do NOT adopt restored panel directly
    assert.ok(
        kanbanCode.includes('reviveWithRetention(panel'),
        'KanbanProvider deserializeWebviewPanel must use reviveWithRetention'
    );
    assert.ok(
        !kanbanCode.includes('this._panel = panel;'),
        'KanbanProvider deserializeWebviewPanel must not adopt restored panel directly'
    );

    assert.ok(
        planningCode.includes('reviveWithRetention(panel'),
        'PlanningPanelProvider deserialize methods must use reviveWithRetention'
    );
    assert.ok(
        !planningCode.includes('this._panel = panel;'),
        'PlanningPanelProvider deserializeWebviewPanel must not adopt restored panel directly'
    );

    assert.ok(
        designCode.includes('reviveWithRetention(panel'),
        'DesignPanelProvider deserializeWebviewPanel must use reviveWithRetention'
    );
    assert.ok(
        !designCode.includes('this._panel = panel;'),
        'DesignPanelProvider deserializeWebviewPanel must not adopt restored panel directly'
    );

    console.log('✔ All panel revival retention contracts verified successfully.');
}

testPanelRevivalRetentionContract();
