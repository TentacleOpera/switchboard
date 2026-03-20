'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const implementationSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'implementation.html'),
    'utf8'
);

function expectRegex(source, regex, message) {
    assert.match(source, regex, message);
}

function run() {
    expectRegex(
        implementationSource,
        /\.secondary-btn\.is-denied,\s*\.secondary-btn\.is-denied:hover,\s*\.secondary-btn\.is-denied:disabled\s*\{[\s\S]*background:\s*var\(--accent-red\);[\s\S]*color:\s*#ffffff;[\s\S]*box-shadow:\s*var\(--glow-red\);[\s\S]*\}/s,
        'Expected the temporary DENIED state to use explicit bright red styling.'
    );

    expectRegex(
        implementationSource,
        /\.secondary-btn\.is-denied:disabled\s*\{[\s\S]*opacity:\s*1;[\s\S]*cursor:\s*not-allowed;[\s\S]*\}/s,
        'Expected the DENIED disabled state to override the shared disabled dimming.'
    );

    expectRegex(
        implementationSource,
        /btnEasterEgg\.textContent\s*=\s*'DENIED';[\s\S]*btnEasterEgg\.classList\.add\('is-denied'\);[\s\S]*btnEasterEgg\.disabled\s*=\s*true;[\s\S]*setTimeout\(\(\)\s*=>\s*\{[\s\S]*btnEasterEgg\.classList\.remove\('is-denied'\);[\s\S]*btnEasterEgg\.disabled\s*=\s*false;/s,
        'Expected the easter-egg flow to add and remove the denied class while keeping the button temporarily disabled.'
    );

    assert.ok(
        !implementationSource.includes("btnEasterEgg.style.background = 'var(--accent-red)'"),
        'Expected the DENIED styling to be class-based instead of inline.'
    );

    console.log('access main program denied style regression test passed');
}

try {
    run();
} catch (error) {
    console.error('access main program denied style regression test failed:', error);
    process.exit(1);
}
