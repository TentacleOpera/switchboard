'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const webviewSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'implementation.html'), 'utf8');

function expectRegex(source, regex, message) {
    assert.match(source, regex, message);
}

function run() {
    expectRegex(
        providerSource,
        /const\s+complexityFilter\s*=\s*this\._autobanState\.complexityFilter;/,
        'Expected PLAN REVIEWED autoban routing to read the configured complexity filter.'
    );
    expectRegex(
        providerSource,
        /const\s+routingMode\s*=\s*this\._autobanState\.routingMode;/,
        'Expected PLAN REVIEWED autoban routing to read the configured routing mode.'
    );
    expectRegex(
        providerSource,
        /if\s*\(!this\._autobanMatchesComplexityFilter\(complexity,\s*complexityFilter\)\)\s*\{\s*continue;\s*\}/s,
        'Expected PLAN REVIEWED autoban routing to filter cards before dispatch.'
    );
    expectRegex(
        providerSource,
        /const\s+targetRole\s*=\s*this\._autobanRoutePlanReviewedCard\(card\.complexity,\s*routingMode\);/,
        'Expected PLAN REVIEWED autoban routing to support configurable lead/coder targets.'
    );
    expectRegex(
        webviewSource,
        /let\s+autobanState\s*=\s*\{\s*enabled:\s*false,\s*batchSize:\s*3,\s*complexityFilter:\s*'all',\s*routingMode:\s*'dynamic'/s,
        'Expected the implementation webview to initialize autoban state with the new control defaults.'
    );
    expectRegex(
        webviewSource,
        /complexityLabel\.textContent\s*=\s*'COMPLEXITY:';/,
        'Expected the Autoban panel to show a complexity filter control.'
    );
    expectRegex(
        webviewSource,
        /routingLabel\.textContent\s*=\s*'ROUTING:';/,
        'Expected the Autoban panel to show a routing mode control.'
    );
    expectRegex(
        webviewSource,
        /AUTOBAN_BATCH_SIZE_OPTIONS\s*=\s*\[\s*1,\s*2,\s*3,\s*4,\s*5\s*\];[\s\S]*AUTOBAN_BATCH_SIZE_OPTIONS\.forEach\(val => \{/s,
        'Expected the Autoban batch-size selector to offer explicit values 1, 2, 3, 4, and 5.'
    );

    console.log('autoban controls regression test passed');
}

try {
    run();
} catch (error) {
    console.error('autoban controls regression test failed:', error);
    process.exit(1);
}
