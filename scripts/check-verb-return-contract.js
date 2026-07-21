#!/usr/bin/env node
'use strict';

/**
 * Verb Return-Contract Ratchet CI Gate
 *
 * Enforces monotonic reduction of `break;` statements inside each provider's `_handleMessage` switch.
 * Fails if any provider's break count exceeds the ceiling defined in `scripts/verb-return-contract-baseline.json`.
 */

const fs = require('fs');
const path = require('path');
const { REPO_ROOT, PROVIDERS, analyzeProviderSwitch } = require('./verb-switch-helper');

const BASELINE_PATH = path.join(__dirname, 'verb-return-contract-baseline.json');

function checkVerbReturnContract() {
    console.log('=== Verb Engine Return-Contract Ratchet Check ===\n');

    if (!fs.existsSync(BASELINE_PATH)) {
        console.error(`❌ Baseline file not found: ${BASELINE_PATH}`);
        process.exit(1);
    }

    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    let errors = 0;

    for (const p of PROVIDERS) {
        const res = analyzeProviderSwitch(p);
        if (!res) {
            console.error(`❌ ${p.name}: switch block not found in file ${p.file}`);
            errors++;
            continue;
        }

        const ceiling = baseline[p.name];
        if (ceiling === undefined) {
            console.error(`❌ ${p.name}: baseline ceiling missing in verb-return-contract-baseline.json`);
            errors++;
            continue;
        }

        const currentBreaks = res.breakCount;
        if (currentBreaks > ceiling) {
            console.error(`❌ ${p.name}: break count REGRESSION detected!`);
            console.error(`   Current breaks: ${currentBreaks} | Baseline ceiling: ${ceiling}`);
            console.error(`   Read arms with break: ${res.readArmsWithBreak} arms (out of ${res.readArms.length} read arms)`);
            errors++;
        } else if (currentBreaks < ceiling) {
            console.log(`✅ ${p.name}: ${currentBreaks} break(s) <= ceiling ${ceiling} (PROGRESS: ceiling can be lowered by ${ceiling - currentBreaks})`);
        } else {
            console.log(`✅ ${p.name}: ${currentBreaks} break(s) <= ceiling ${ceiling}`);
        }
    }

    console.log('\n=== Summary ===');
    if (errors > 0) {
        console.error(`❌ Verb return-contract ratchet check failed with ${errors} error(s).`);
        process.exit(1);
    } else {
        console.log('✅ All provider return contracts satisfied against baseline ceilings.');
        process.exit(0);
    }
}

checkVerbReturnContract();
