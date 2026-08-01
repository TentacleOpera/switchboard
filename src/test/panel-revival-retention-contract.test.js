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
    assert.ok(
        !planningCode.includes('this._projectPanel = panel;'),
        'PlanningPanelProvider deserializeProjectPanel must not adopt restored panel directly'
    );

    // 3. No listeners are attached to the panel being discarded. Wiring onDidDispose to
    //    it would null out _panel / reset provider caches AFTER the replacement exists.
    const helperCode = fs.readFileSync(path.join(__dirname, '../utils/reviveWithRetention.ts'), 'utf8');
    ['onDidDispose', 'onDidReceiveMessage', 'onDidChangeViewState'].forEach(listener => {
        assert.ok(
            !new RegExp(`restoredPanel\\.${listener}`).test(helperCode),
            `reviveWithRetention must not register ${listener} on the discarded panel`
        );
    });
    assert.ok(
        /restoredPanel\.dispose\(\);[\s\S]*await openFn\(/.test(helperCode),
        'reviveWithRetention must dispose BEFORE delegating to the create path'
    );

    // 4. The persisted vscode.setState() payload must survive re-creation. A new webview
    //    boots with getState() === undefined, so without forwarding, revival silently
    //    resets every persisted preference on each window reload.
    assert.ok(
        /reviveWithRetention\([\s\S]{0,400}?\}, state\);/.test(kanbanCode),
        'KanbanProvider must forward the serialized state to reviveWithRetention'
    );
    const planningForwards = (planningCode.match(/\}, state\);/g) || []).length;
    assert.strictEqual(
        planningForwards, 2,
        'Both PlanningPanelProvider deserialize paths must forward the serialized state'
    );
    assert.ok(
        /reviveWithRetention\([\s\S]{0,400}?\}, state\);/.test(designCode),
        'DesignPanelProvider must forward the serialized state to reviveWithRetention'
    );
    [
        { name: 'KanbanProvider', code: kanbanCode },
        { name: 'PlanningPanelProvider', code: planningCode },
        { name: 'DesignPanelProvider', code: designCode }
    ].forEach(({ name, code }) => {
        assert.ok(
            code.includes('injectInitialWebviewState('),
            `${name} must inject the forwarded state into the initial HTML`
        );
    });

    // 5. The carrier must be a <meta> tag, not an inline <script>: KanbanProvider's CSP
    //    is `script-src 'nonce-...' <cspSource>` with NO 'unsafe-inline', and its nonce is
    //    stamped inside _getHtml — before injection runs. An injected script tag would be
    //    silently blocked there and the state would never arrive.
    assert.ok(
        /<meta name="\$\{INITIAL_STATE_META_NAME\}"/.test(helperCode),
        'injectInitialWebviewState must carry the payload in a <meta> tag'
    );
    const emittedTag = (helperCode.match(/const tag = `([^`]*)`/) || [])[1] || '';
    assert.ok(
        emittedTag && !emittedTag.includes('<script'),
        'injectInitialWebviewState must not emit an inline <script> (blocked by the KANBAN CSP)'
    );

    // 6. Every panel webview seeds the injected payload before its first getState() read.
    ['../webview/planning.js', '../webview/project.js', '../webview/design.js', '../webview/kanban.html']
        .forEach(rel => {
            const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
            const seedAt = src.indexOf("meta[name=\"sb-initial-state\"]");
            assert.ok(seedAt !== -1, `${rel} must read the sb-initial-state meta carrier`);
            assert.ok(
                src.slice(seedAt, seedAt + 400).includes('setState'),
                `${rel} must seed the forwarded payload into vscode.setState`
            );
            // The seed must precede every getState() consumer in the file.
            const firstRead = src.indexOf('getState()');
            assert.ok(
                firstRead !== -1 && firstRead < seedAt,
                `${rel} must seed at the acquire site, ahead of the persisted-state readers`
            );
        });

    // 7. preserveFocus is a REVIVAL affordance only — a user-invoked open must take
    //    focus. Hardcoding `preserveFocus: true` regresses every command-driven open.
    [
        { name: 'KanbanProvider', code: kanbanCode },
        { name: 'PlanningPanelProvider', code: planningCode },
        { name: 'DesignPanelProvider', code: designCode }
    ].forEach(({ name, code }) => {
        assert.ok(
            !/preserveFocus:\s*true/.test(code),
            `${name} must not hardcode preserveFocus: true — gate it on revival`
        );
        assert.ok(
            code.includes('const isRevival = column !== undefined;'),
            `${name} must derive the revival flag from the supplied view column`
        );
    });

    console.log('✔ All panel revival retention contracts verified successfully.');
}

testPanelRevivalRetentionContract();
