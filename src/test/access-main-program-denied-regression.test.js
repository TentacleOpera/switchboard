'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const source = fs.readFileSync(implementationPath, 'utf8');

    assert.ok(
        source.includes('.secondary-btn:disabled {') &&
        source.includes('opacity: 0.3;'),
        'Expected the generic disabled secondary button styling to remain unchanged.'
    );

    assert.ok(
        source.includes('.secondary-btn.is-denied,') &&
        source.includes('.secondary-btn.is-denied:hover,') &&
        source.includes('.secondary-btn.is-denied:disabled {') &&
        source.includes('background: var(--accent-red);') &&
        source.includes('color: #ffffff;') &&
        source.includes('box-shadow: var(--glow-red);'),
        'Expected implementation.html to define a bright denied-state style using the existing red accent tokens.'
    );

    assert.ok(
        source.includes('.secondary-btn.is-denied:disabled {') &&
        source.includes('opacity: 1;') &&
        source.includes('cursor: not-allowed;'),
        'Expected the denied-state disabled override to prevent generic disabled dimming.'
    );

    assert.ok(
        source.includes("btnEasterEgg.textContent = 'DENIED';") &&
        source.includes("btnEasterEgg.classList.add('is-denied');") &&
        source.includes('btnEasterEgg.disabled = true;'),
        'Expected the denied-state handler to add the denied class and keep the button disabled during the animation.'
    );

    assert.ok(
        source.includes("btnEasterEgg.classList.remove('is-denied');") &&
        source.includes('btnEasterEgg.disabled = false;') &&
        source.includes("btnEasterEgg.textContent = labels[currentIndex];"),
        'Expected the denied-state handler to fully reset the class, text, and disabled state after the timeout.'
    );

    assert.ok(
        source.includes('<button id="btn-easter-egg" class="secondary-btn w-full" style="margin-top: 6px;">Access main program</button>'),
        'Expected the idle Access main program button to remain the neutral secondary button in markup.'
    );

    console.log('access main program denied regression test passed');
}

try {
    run();
} catch (error) {
    console.error('access main program denied regression test failed:', error);
    process.exit(1);
}
