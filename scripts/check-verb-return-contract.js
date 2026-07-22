#!/usr/bin/env node
'use strict';

/**
 * Verb Return-Contract Ratchet CI Gate
 *
 * Enforces monotonic reduction of `break;` statements inside each provider's
 * `_handleMessage` switch. Fails if any provider's break count EXCEEDS the
 * ceiling in `scripts/verb-return-contract-baseline.json` (the ratchet only
 * ever goes DOWN).
 *
 * Modes:
 *   (default)  CI gate — compare current vs committed baseline, exit non-zero on
 *              regression. NEVER writes.
 *   --write    Maintainer tool — regenerate the baseline from the true current
 *              counts, LOWERING ceilings where arms were converted. Refuses to
 *              raise a ceiling (that would launder a regression) — a genuine
 *              regression must be fixed, and a deliberately-added nested/loop
 *              break must be hand-edited with justification. This replaces the
 *              error-prone "hand-set the ceiling to 0" step that repeatedly red
 *              CI (a provider with a legitimate nested/loop break floors above 0).
 */

const fs = require('fs');
const path = require('path');
const { PROVIDERS, analyzeProviderSwitch, countAllowlistVerbs } = require('./verb-switch-helper');

const BASELINE_PATH = path.join(__dirname, 'verb-return-contract-baseline.json');

/**
 * Pure decision core (no I/O) so the safety guard is unit-testable.
 * @returns {{regressions: Array, missingSwitch: string[], newBaseline: object}}
 *   `newBaseline` sets each provider's ceiling to its true current break count.
 *   `regressions` lists providers whose current count EXCEEDS the committed
 *   ceiling — the write path refuses when this is non-empty, so the tool can
 *   never raise a ceiling to mask a regression.
 */
function computeBaselineUpdate(baseline, results) {
    const regressions = [];
    const missingSwitch = [];
    const unreliable = [];
    const newBaseline = {};
    for (const r of results) {
        if (!r.res) { missingSwitch.push(r.name); continue; }
        // Measurement-validity gate: a block whose case-count != the allowlist
        // was mis-bounded, so its break count is untrustworthy — never build a
        // ceiling from it. (Skipped when `allowlist` is absent, e.g. unit tests.)
        if (r.allowlist != null && r.res.casesCount !== r.allowlist) {
            unreliable.push({ name: r.name, cases: r.res.casesCount, allowlist: r.allowlist });
            continue;
        }
        const current = r.res.breakCount;
        const ceiling = baseline[r.name];
        if (ceiling !== undefined && current > ceiling) {
            regressions.push({ name: r.name, current, ceiling });
        }
        newBaseline[r.name] = current;
    }
    return { regressions, missingSwitch, unreliable, newBaseline };
}

function measureAll() {
    return PROVIDERS.map(p => ({ name: p.name, file: p.file, res: analyzeProviderSwitch(p), allowlist: countAllowlistVerbs(p.name) }));
}

function checkMode(baseline, results) {
    console.log('=== Verb Engine Return-Contract Ratchet Check ===\n');
    let errors = 0;
    for (const r of results) {
        if (!r.res) {
            console.error(`❌ ${r.name}: switch block not found in file ${r.file}`);
            errors++;
            continue;
        }
        if (r.allowlist != null && r.res.casesCount !== r.allowlist) {
            console.error(`❌ ${r.name}: measurement UNRELIABLE — extracted ${r.res.casesCount} case labels but the allowlist has ${r.allowlist}. The switch block is mis-bounded (brace-matcher truncation) or arms/allowlist drifted; the break count cannot be trusted. Fix before relying on the ratchet.`);
            errors++;
            continue;
        }
        const ceiling = baseline[r.name];
        if (ceiling === undefined) {
            console.error(`❌ ${r.name}: baseline ceiling missing in verb-return-contract-baseline.json`);
            errors++;
            continue;
        }
        const currentBreaks = r.res.breakCount;
        if (currentBreaks > ceiling) {
            console.error(`❌ ${r.name}: break count REGRESSION detected!`);
            console.error(`   Current breaks: ${currentBreaks} | Baseline ceiling: ${ceiling}`);
            console.error(`   Read arms with break: ${r.res.readArmsWithBreak} arms (out of ${r.res.readArms.length} read arms)`);
            console.error(`   If the new break is legitimate nested/loop control flow, hand-edit the baseline with justification; otherwise convert the arm to \`return\`.`);
            errors++;
        } else if (currentBreaks < ceiling) {
            console.log(`✅ ${r.name}: ${currentBreaks} break(s) <= ceiling ${ceiling} (PROGRESS: run \`npm run verb-returns:baseline\` to lower the ceiling by ${ceiling - currentBreaks})`);
        } else {
            console.log(`✅ ${r.name}: ${currentBreaks} break(s) <= ceiling ${ceiling}`);
        }
    }
    console.log('\n=== Summary ===');
    if (errors > 0) {
        console.error(`❌ Verb return-contract ratchet check failed with ${errors} error(s).`);
        process.exit(1);
    }
    console.log('✅ All provider return contracts satisfied against baseline ceilings.');
    process.exit(0);
}

function writeMode(baseline, results) {
    console.log('=== Verb Engine Return-Contract Baseline (regenerate, lower-only) ===\n');
    const { regressions, missingSwitch, unreliable, newBaseline } = computeBaselineUpdate(baseline, results);

    if (missingSwitch.length) {
        console.error(`❌ Refusing to write — switch block not found for: ${missingSwitch.join(', ')}. Fix the switch pattern first.`);
        process.exit(1);
    }
    if (unreliable.length) {
        console.error('❌ Refusing to write — measurement unreliable (block/allowlist case-count mismatch): ' +
            unreliable.map(u => `${u.name} (${u.cases} vs ${u.allowlist})`).join(', ') +
            '. The break count is untrustworthy; fix the switch bounds before regenerating the baseline.');
        process.exit(1);
    }
    if (regressions.length) {
        console.error('❌ Refusing to write: current break count EXCEEDS the committed ceiling (a regression). The baseline only ratchets DOWN — regenerating must never raise a ceiling.');
        for (const r of regressions) {
            console.error(`   ${r.name}: current ${r.current} > ceiling ${r.ceiling}`);
        }
        console.error('   Convert the offending arm to `return`, or — if it is legitimate nested/loop control flow — hand-edit the baseline with a justifying comment in the commit.');
        process.exit(1);
    }

    let lowered = 0;
    for (const name of Object.keys(newBaseline)) {
        const old = baseline[name];
        if (old === undefined) {
            console.log(`  ${name}: (new) → ${newBaseline[name]}`);
        } else if (newBaseline[name] < old) {
            console.log(`  ${name}: ${old} → ${newBaseline[name]} (lowered by ${old - newBaseline[name]})`);
            lowered++;
        } else {
            console.log(`  ${name}: ${newBaseline[name]} (unchanged)`);
        }
    }
    // Only touch disk when the canonical serialization actually differs, so a
    // no-op run never churns formatting/key-order into a spurious git diff.
    const nextContent = JSON.stringify(newBaseline, null, 2) + '\n';
    const currentContent = fs.readFileSync(BASELINE_PATH, 'utf8');
    if (nextContent === currentContent) {
        console.log('\n✅ Baseline already matches current counts — nothing written (idempotent).');
        process.exit(0);
    }
    fs.writeFileSync(BASELINE_PATH, nextContent, 'utf8');
    console.log(`\n✅ Baseline rewritten (${lowered} provider(s) lowered). Review the diff and commit.`);
    process.exit(0);
}

function main() {
    if (!fs.existsSync(BASELINE_PATH)) {
        console.error(`❌ Baseline file not found: ${BASELINE_PATH}`);
        process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const results = measureAll();
    if (process.argv.includes('--write')) {
        return writeMode(baseline, results);
    }
    return checkMode(baseline, results);
}

module.exports = { computeBaselineUpdate };

if (require.main === module) {
    main();
}
