#!/usr/bin/env node
'use strict';

/**
 * Host Seam-Parity Guard — Composition-Root Wiring.
 *
 * The standalone (npx) host and the VS Code extension host share the same
 * `PlanIngestionEngine`. The engine exposes a set of public `set<Name>(...)`
 * seams that each composition root wires with host-specific callbacks. A seam
 * wired in one root but not the other is a silent divergence: the engine treats
 * an unset seam as "no evidence" / "no callback", so the missing host degrades
 * quietly — no compile error, no test failure, just a feature that never fires.
 *
 * This is exactly how the four queue seams (`setQueueHeadResolver`,
 * `setQueuePacingResolver`, `setQueueTeamMembersResolver`,
 * `setQueueEscalationRecorder`) shipped in `extension.ts` only, a month after
 * standalone existed. Every gate stayed green because `bootstrap.ts`'s
 * `default:` arm delegates every unmatched verb to the provider, so
 * verb-reachability audits cannot fail — the seams are not verbs.
 *
 * This guard compares the two composition roots by the seams they WIRE, not the
 * verbs they answer. Any seam wired in one root and not the other is a failure
 * UNLESS it appears in the `ASYMMETRIC_SEAMS` allowlist below, each with a
 * one-line reason. The allowlist (not a ratcheted count, not a hard diff) is
 * the chosen shape: a count lets a new divergence hide behind a fixed one; a
 * hard diff is red on arrival and gets baselined into decoration; an allowlist
 * makes the default for any new seam "must be wired in both" and forces a
 * human sentence for each exception.
 *
 * TWO WIRING EXPRESSIONS, ONE MEANING. The extension reaches the engine two
 * ways: directly (`globalPlanWatcher.getEngine().setX(...)`) and through the
 * `GlobalPlanWatcherService` facade (`globalPlanWatcher.setX(...)`, whose body
 * is a one-line `this._engine.setX(fn)` forward). Both wire the same seam on
 * the same engine. A guard that recognised only the first would credit the
 * extension with 7 of 9 seams and report two phantom asymmetries — which is
 * precisely what an allowlist then freezes into permanent decoration. Facade
 * forwards are therefore resolved from GlobalPlanWatcherService's own source
 * and counted as real wiring, and any wiring expression the guard does NOT
 * recognise is a hard failure telling you to teach it the pattern rather than
 * silently mis-reporting parity.
 *
 * Deliberately NOT folded into check-standalone-push-parity.js: that guard is
 * scoped to the browser read-back path, and merging two unrelated surfaces
 * into one ratchet is how its scope became invisible in the first place.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const ENGINE_PATH = path.join(REPO_ROOT, 'src', 'services', 'PlanIngestionEngine.ts');
const WATCHER_PATH = path.join(REPO_ROOT, 'src', 'services', 'GlobalPlanWatcherService.ts');
const EXTENSION_PATH = path.join(REPO_ROOT, 'src', 'extension.ts');
const BOOTSTRAP_PATH = path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts');

// ─── Allowlist — genuine asymmetries, each with a reason ───────────────────
// A seam here is permitted to be wired in one root only. Adding an entry
// without a reason sentence defeats the purpose — the reason IS the artifact.
//
// EMPTY BY DESIGN, and that is the honest state: all nine engine seams are
// wired in both roots today. `setFeatureColumnRecomputer` and
// `setFeatureFileRegenerator` were seeded here as "standalone-only" — they are
// not. The extension wires both through the GlobalPlanWatcherService facade
// (extension.ts:881/:891), which forwards straight to the engine. Allowlisting
// them would have exempted two live seams from the guard forever.
const ASYMMETRIC_SEAMS = {
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function readSource(p) {
    return fs.readFileSync(p, 'utf8');
}

/**
 * Extract every `set<Name>(` setter DECLARED on PlanIngestionEngine.
 *
 * Anchored at exactly four spaces of indentation — class-member depth. This
 * deliberately does NOT require the `public` keyword: a member declared with
 * no modifier is public in TypeScript, and a guard that only sees `public`
 * setters goes blind the first time someone omits it. Statements inside method
 * bodies sit at eight or more spaces, so the anchor keeps `setTimeout(...)`
 * and friends out. Returns a Set of method names (e.g. `setQueueHeadResolver`).
 */
function extractSeamDeclarations(src) {
    const seams = new Set();
    const re = /^ {4}(?:(?:public|private|protected)\s+)?(?:async\s+)?(set[A-Z]\w*)\s*\(/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
        seams.add(m[1]);
    }
    return seams;
}

/**
 * Extract the GlobalPlanWatcherService methods that are pure forwards onto the
 * engine — `public setX(...) { this._engine.setX(fn); }`. Calling one of these
 * from a composition root wires the engine seam just as surely as calling
 * `.getEngine().setX(...)` does, so they count as real wiring.
 *
 * The forward is verified against the facade's own source rather than assumed:
 * a facade method that does something OTHER than hand the callback to the
 * engine must not earn a composition root parity credit.
 */
function extractFacadeForwarders(watcherSrc) {
    const forwarders = new Set();
    const re = /^ {4}(?:(?:public|private|protected)\s+)?(?:async\s+)?(set[A-Z]\w*)\s*\(/gm;
    let m;
    while ((m = re.exec(watcherSrc)) !== null) {
        const name = m[1];
        // Body runs from the declaration to the next member declaration (or EOF).
        const bodyStart = re.lastIndex;
        const nextMember = watcherSrc.slice(bodyStart).search(/^ {4}(?:public|private|protected|\/\*\*)/m);
        const body = nextMember === -1 ? watcherSrc.slice(bodyStart) : watcherSrc.slice(bodyStart, bodyStart + nextMember);
        if (new RegExp(`this\\._engine\\.${name}\\s*\\(`).test(body)) {
            forwarders.add(name);
        }
    }
    return forwarders;
}

/**
 * Extract which engine seams the extension composition root CALLS, across both
 * recognised expressions: `.getEngine().setX(` (direct) and
 * `globalPlanWatcher.setX(` (through the verified facade forwards).
 */
function extractExtensionCalls(extensionSrc, facadeForwarders) {
    const calls = new Set();
    const direct = /\.getEngine\(\)\.(set\w+)\s*\(/g;
    let m;
    while ((m = direct.exec(extensionSrc)) !== null) {
        calls.add(m[1]);
    }
    const viaFacade = /\bglobalPlanWatcher\.(set\w+)\s*\(/g;
    while ((m = viaFacade.exec(extensionSrc)) !== null) {
        if (facadeForwarders.has(m[1])) { calls.add(m[1]); }
    }
    return calls;
}

/**
 * Extract which engine seams the standalone composition root CALLS.
 * Standalone owns the engine instance directly as `ingestionEngine`, so the
 * call pattern is `ingestionEngine.setFoo(`. Returns a Set.
 */
function extractBootstrapCalls(bootstrapSrc) {
    const calls = new Set();
    const re = /ingestionEngine\.(set\w+)\s*\(/g;
    let m;
    while ((m = re.exec(bootstrapSrc)) !== null) {
        calls.add(m[1]);
    }
    return calls;
}

/**
 * Any `.setX(` in a composition root whose name IS a declared engine seam but
 * which no recognised wiring expression captured. That is a wiring expression
 * the guard cannot read — the guard must say so loudly rather than quietly
 * report the seam as unwired, which is how a parity report becomes fiction.
 */
function findUnrecognisedWiring(src, declaredSeams, recognised, label) {
    const failures = [];
    const re = /\.(set[A-Z]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = m[1];
        if (!declaredSeams.has(name) || recognised.has(name)) { continue; }
        const line = src.slice(0, m.index).split('\n').length;
        failures.push(
            `FAIL: ${label}:${line} calls .${name}(...) — a declared engine seam — through a wiring expression this guard does not recognise. Teach the guard the pattern (see extractExtensionCalls/extractBootstrapCalls); do not allowlist it.`
        );
    }
    return failures;
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main() {
    const engineSrc = readSource(ENGINE_PATH);
    const watcherSrc = readSource(WATCHER_PATH);
    const extensionSrc = readSource(EXTENSION_PATH);
    const bootstrapSrc = readSource(BOOTSTRAP_PATH);

    const declaredSeams = extractSeamDeclarations(engineSrc);
    const facadeForwarders = extractFacadeForwarders(watcherSrc);
    const extensionCalls = extractExtensionCalls(extensionSrc, facadeForwarders);
    const bootstrapCalls = extractBootstrapCalls(bootstrapSrc);

    const failures = [];

    // 0. Sanity: the extraction must find seams at all. A regex that silently
    //    matches nothing after a refactor is a guard that cannot fail.
    if (declaredSeams.size === 0) {
        failures.push('FAIL: no set<Name>(...) seams extracted from PlanIngestionEngine.ts — the declaration pattern has drifted and this guard is inert.');
    }

    // 1. Every seam the engine DECLARES must be wired in at least one root,
    //    OR appear in the allowlist. A declared seam wired in neither root is
    //    a dead seam — the engine accepts it but nobody provides it.
    for (const seam of declaredSeams) {
        const inExt = extensionCalls.has(seam);
        const inBoot = bootstrapCalls.has(seam);
        const allowed = Object.prototype.hasOwnProperty.call(ASYMMETRIC_SEAMS, seam);
        if (!inExt && !inBoot && !allowed) {
            failures.push(
                `FAIL: engine declares ${seam}(...) but NEITHER composition root wires it, and it is not in ASYMMETRIC_SEAMS.`
            );
        }
    }

    // 2. Any seam wired in one root but not the other is a divergence, unless
    //    allowlisted. This is the core parity check.
    for (const seam of declaredSeams) {
        const inExt = extensionCalls.has(seam);
        const inBoot = bootstrapCalls.has(seam);
        if (inExt === inBoot) { continue; } // symmetric (both or neither)
        if (Object.prototype.hasOwnProperty.call(ASYMMETRIC_SEAMS, seam)) { continue; }
        const missing = inExt ? 'bootstrap.ts (standalone)' : 'extension.ts';
        failures.push(
            `FAIL: ${seam}(...) is wired in ${inExt ? 'extension.ts' : 'bootstrap.ts'} but NOT in ${missing}, and is not in ASYMMETRIC_SEAMS.`
        );
    }

    // 3. Any allowlisted seam that is now wired in BOTH roots is a stale
    //    allowlist entry — the divergence was fixed and the entry should be
    //    removed. A stale allowlist is how a guard silently becomes decoration.
    for (const seam of Object.keys(ASYMMETRIC_SEAMS)) {
        if (!declaredSeams.has(seam)) {
            failures.push(
                `FAIL: ASYMMETRIC_SEAMS lists ${seam} but the engine no longer declares it — remove the stale entry.`
            );
            continue;
        }
        if (extensionCalls.has(seam) && bootstrapCalls.has(seam)) {
            failures.push(
                `FAIL: ASYMMETRIC_SEAMS lists ${seam} but it is now wired in BOTH roots — remove the stale allowlist entry.`
            );
        }
        // An allowlisted seam must still be wired in at least one root.
        if (!extensionCalls.has(seam) && !bootstrapCalls.has(seam)) {
            failures.push(
                `FAIL: ASYMMETRIC_SEAMS lists ${seam} but it is wired in NEITHER root — either wire it or remove the entry.`
            );
        }
        // Every entry must carry a reason sentence — the reason IS the artifact.
        const reason = ASYMMETRIC_SEAMS[seam];
        if (typeof reason !== 'string' || reason.trim().length < 20) {
            failures.push(
                `FAIL: ASYMMETRIC_SEAMS entry ${seam} has no substantive reason — a bare exemption is how this guard becomes decoration.`
            );
        }
    }

    // 4. Any call in a composition root that is NOT a declared engine seam is
    //    a phantom call — either a typo or a seam that was renamed/removed
    //    from the engine without updating the composition root.
    for (const seam of extensionCalls) {
        if (!declaredSeams.has(seam)) {
            failures.push(
                `FAIL: extension.ts wires ${seam}(...) but the engine does not declare ${seam} — phantom call or stale rename.`
            );
        }
    }
    for (const seam of bootstrapCalls) {
        if (!declaredSeams.has(seam)) {
            failures.push(
                `FAIL: bootstrap.ts calls ingestionEngine.${seam}(...) but the engine does not declare ${seam} — phantom call or stale rename.`
            );
        }
    }

    // 5. Wiring expressions the guard cannot read.
    failures.push(...findUnrecognisedWiring(extensionSrc, declaredSeams, extensionCalls, 'src/extension.ts'));
    failures.push(...findUnrecognisedWiring(bootstrapSrc, declaredSeams, bootstrapCalls, 'src/standalone/bootstrap.ts'));

    // ─── Report ────────────────────────────────────────────────────────────
    console.log('host-seam-parity guard');
    console.log(`  engine seams declared:   ${declaredSeams.size}`);
    console.log(`  facade forwards:         ${facadeForwarders.size} (${[...facadeForwarders].join(', ') || 'none'})`);
    console.log(`  extension.ts wires:      ${extensionCalls.size}`);
    console.log(`  bootstrap.ts wires:      ${bootstrapCalls.size}`);
    console.log(`  allowlisted asymmetries: ${Object.keys(ASYMMETRIC_SEAMS).length}`);
    for (const [seam, reason] of Object.entries(ASYMMETRIC_SEAMS)) {
        console.log(`    ${seam}: ${reason}`);
    }

    if (failures.length > 0) {
        console.error('');
        console.error(`${failures.length} seam-parity failure(s):`);
        for (const f of failures) {
            console.error(`  ${f}`);
        }
        process.exit(1);
    }
    console.log('\nhost-seam-parity guard passed');
}

main();
