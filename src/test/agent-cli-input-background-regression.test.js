'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const source = fs.readFileSync(
        path.join(process.cwd(), 'src', 'webview', 'implementation.html'),
        'utf8'
    );

    assert.match(
        source,
        /\.startup-row input\[type="text"\] \{[\s\S]*background: #0a0a0a;[\s\S]*color: var\(--text-primary\);[\s\S]*border: 1px solid var\(--border-color\);[\s\S]*font-family: var\(--font-mono\);[\s\S]*font-size: 11px;[\s\S]*\}/m,
        'Expected CLI command text inputs to use the dark themed startup-row styling.'
    );

    assert.match(
        source,
        /\.startup-row input\[type="text"\]:focus,[\s\S]*\.startup-row input\[type="text"\]:hover \{[\s\S]*border-color: var\(--border-bright\);[\s\S]*outline: none;[\s\S]*\}/m,
        'Expected CLI command text inputs to keep the dark-theme hover and focus border states.'
    );

    console.log('agent CLI input background regression test passed');
}

try {
    run();
} catch (error) {
    console.error('agent CLI input background regression test failed:', error);
    process.exit(1);
}
