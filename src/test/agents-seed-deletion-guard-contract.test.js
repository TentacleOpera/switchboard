'use strict';

/**
 * `.agents/` seed deletion-guard contract.
 *
 * The activation seed loop used to treat "destination absent" as "never seeded",
 * so any file a workspace deliberately deleted came back on the next restart —
 * the protocols migration was undone by a stale bundle every activation. The fix
 * makes the ledger the discriminator on the CREATION path as well as the deletion
 * path: in-ledger AND absent means the workspace removed it (skip); not-in-ledger
 * AND absent means genuinely new (copy).
 *
 * Every failure mode on that path is SILENT:
 *   - Inverting the condition freezes the control plane at its current contents;
 *     nothing throws, nothing logs, new bundle files simply never arrive.
 *   - Treating a missing ledger as "everything was deleted" starves a fresh
 *     workspace to an empty `.agents/`; activation still succeeds.
 *   - Building the ledger lookup key with native separators
 *     (`surface + '/' + relativePath`) misses every entry on Windows, so the
 *     guard no-ops and the resurrection continues — platform-conditional, and
 *     invisible to a CI that only runs on Linux. That one cannot be reached
 *     behaviourally from posix, so it is pinned as a source contract.
 *   - Setting `changed` on the skip branch regenerates the `.claude` mirror on
 *     every activation for which a deletion exists.
 *
 * None of these are reachable by compile, lint, or a verb/parity audit, so this
 * is the only gate on the guard.
 */

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

function installVsCodeMock() {
    const originalLoad = Module._load;
    const mock = {
        window: {
            withProgress: async (_options, task) => task({ report() { } }),
            showErrorMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
        },
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({
                get: (_key, fallback) => fallback,
                update: async () => undefined,
            }),
        },
        commands: { executeCommand: async () => true },
        Uri: {
            file(value) {
                const resolved = path.resolve(value);
                return { fsPath: resolved, path: resolved, toString: () => resolved };
            },
        },
        ProgressLocation: { Notification: 15 },
    };
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') return mock;
        return originalLoad.call(this, request, parent, isMain);
    };
    return { restore() { Module._load = originalLoad; } };
}

async function writeFile(filePath, content) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf8');
}

function exists(...segments) {
    return fs.existsSync(path.join(...segments));
}

/** Bundle fixture: two flat skills plus a nested one, so the key builder is exercised on a multi-segment path. */
async function buildBundle(bundleRoot) {
    await writeFile(path.join(bundleRoot, 'skills', 'kept', 'SKILL.md'), '# kept\n');
    await writeFile(path.join(bundleRoot, 'skills', 'deleted', 'SKILL.md'), '# deleted\n');
    await writeFile(path.join(bundleRoot, 'skills', 'brandnew', 'SKILL.md'), '# brandnew\n');
    await writeFile(path.join(bundleRoot, 'skills', 'nested', 'deep', 'helper.js'), '// helper\n');
    await writeFile(path.join(bundleRoot, 'workflows', 'switchboard.md'), '# door\n');
}

async function run() {
    const vscodeMock = installVsCodeMock();
    const { ControlPlaneMigrationService } = require(path.join(process.cwd(), 'out', 'services', 'ControlPlaneMigrationService.js'));

    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-seed-guard-'));
    try {
        // ------------------------------------------------------------------
        // 1. All four ledger x presence combinations (plan Verification §2).
        // ------------------------------------------------------------------
        {
            const bundle = path.join(tempRoot, 'case1-bundle');
            const ws = path.join(tempRoot, 'case1-ws');
            await buildBundle(bundle);

            // in-ledger + present, content identical -> untouched, no change
            await writeFile(path.join(ws, '.agents', 'skills', 'kept', 'SKILL.md'), '# kept\n');
            // in-ledger + present, content differs -> overwritten (hash refresh preserved)
            await writeFile(path.join(ws, '.agents', 'skills', 'nested', 'deep', 'helper.js'), '// stale\n');
            // in-ledger + ABSENT -> the workspace deleted it -> must stay absent
            //   (skills/deleted/SKILL.md is deliberately not written)
            // not-in-ledger + absent -> genuinely new -> must be copied
            //   (skills/brandnew/SKILL.md is deliberately not written and not in the ledger)

            const ledger = new Set([
                'skills/kept/SKILL.md',
                'skills/deleted/SKILL.md',
                'skills/nested/deep/helper.js',
                'workflows/switchboard.md',
            ]);

            const skills = await ControlPlaneMigrationService.seedBundleSurface(
                'skills', path.join(bundle, 'skills'), ws, ledger);

            assert.strictEqual(
                exists(ws, '.agents', 'skills', 'deleted', 'SKILL.md'),
                false,
                'in-ledger + absent must be SKIPPED — a file the workspace deleted was resurrected by the seed loop.'
            );
            assert.strictEqual(
                exists(ws, '.agents', 'skills', 'brandnew', 'SKILL.md'),
                true,
                'not-in-ledger + absent must be COPIED — the condition is inverted and genuinely new bundle files never arrive.'
            );
            assert.strictEqual(
                fs.readFileSync(path.join(ws, '.agents', 'skills', 'nested', 'deep', 'helper.js'), 'utf8'),
                '// helper\n',
                'in-ledger + present with differing content must still take the content-hash overwrite path.'
            );
            assert.strictEqual(
                fs.readFileSync(path.join(ws, '.agents', 'skills', 'kept', 'SKILL.md'), 'utf8'),
                '# kept\n',
                'in-ledger + present with identical content must be left alone.'
            );
            assert.strictEqual(skills.changed, true, 'A real copy/overwrite must report changed.');
            assert.deepStrictEqual(
                skills.files.slice().sort(),
                [
                    path.join('brandnew', 'SKILL.md'),
                    path.join('deleted', 'SKILL.md'),
                    path.join('kept', 'SKILL.md'),
                    path.join('nested', 'deep', 'helper.js'),
                ].sort(),
                'seedBundleSurface must return the full BUNDLE crawl (skipped files included) — the caller builds currentBundlePaths from it, and dropping a skipped file would make the prune retire it and clear the guard.'
            );
        }

        // ------------------------------------------------------------------
        // 2. Skipping is not a change (plan Verification §12): a deliberate
        //    deletion must not set `changed`, or the `.claude` mirror scaffold
        //    regenerates on every single activation.
        // ------------------------------------------------------------------
        {
            const bundle = path.join(tempRoot, 'case2-bundle');
            const ws = path.join(tempRoot, 'case2-ws');
            await buildBundle(bundle);
            await writeFile(path.join(ws, '.agents', 'workflows', 'switchboard.md'), '# door\n');

            const ledger = new Set(['workflows/switchboard.md', 'workflows/switchboard-memo.md']);
            await writeFile(path.join(bundle, 'workflows', 'switchboard-memo.md'), '# memo door\n');
            // switchboard-memo.md: in-ledger, absent from the workspace -> skip.

            const result = await ControlPlaneMigrationService.seedBundleSurface(
                'workflows', path.join(bundle, 'workflows'), ws, ledger);

            assert.strictEqual(
                exists(ws, '.agents', 'workflows', 'switchboard-memo.md'),
                false,
                'The workflow surface must honour the deletion guard too, not just skills.'
            );
            assert.strictEqual(
                result.changed,
                false,
                'A skip is a no-op, not a change — setting `changed` regenerates the .claude mirror every activation a deletion exists.'
            );
        }

        // ------------------------------------------------------------------
        // 3. Fail-safe: no ledger (empty snapshot) seeds EVERYTHING. A fresh
        //    workspace must never be starved to an empty .agents/.
        // ------------------------------------------------------------------
        {
            const bundle = path.join(tempRoot, 'case3-bundle');
            const ws = path.join(tempRoot, 'case3-ws');
            await buildBundle(bundle);

            const result = await ControlPlaneMigrationService.seedBundleSurface(
                'skills', path.join(bundle, 'skills'), ws, new Set());

            for (const rel of result.files) {
                assert.strictEqual(
                    exists(ws, '.agents', 'skills', rel),
                    true,
                    `Fresh workspace starved: ${rel} was not seeded with an empty ledger snapshot.`
                );
            }
            assert.strictEqual(result.files.length, 4, 'Expected the whole bundled skills tree to be crawled.');
            assert.strictEqual(result.changed, true, 'A first-run seed must report changed so the scaffold runs.');
        }

        // ------------------------------------------------------------------
        // 4. readBundleLedger: the SHARED parser. Malformed/missing/unreadable
        //    all fail safe to null ("no prior knowledge"), which the seed turns
        //    into an empty snapshot (seed everything) and the prune turns into
        //    "delete nothing".
        // ------------------------------------------------------------------
        {
            const mk = async (name, body) => {
                const ws = path.join(tempRoot, name);
                await fs.promises.mkdir(path.join(ws, '.agents'), { recursive: true });
                if (body !== null) {
                    await fs.promises.writeFile(path.join(ws, '.agents', '.switchboard-bundled.json'), body, 'utf8');
                }
                return ws;
            };

            assert.strictEqual(
                ControlPlaneMigrationService.readBundleLedger(await mk('led-missing', null)),
                null,
                'A missing ledger must return null, not [].'
            );
            assert.strictEqual(
                ControlPlaneMigrationService.readBundleLedger(await mk('led-corrupt', '{ not json')),
                null,
                'A corrupt ledger must fail safe to null, not throw.'
            );
            assert.strictEqual(
                ControlPlaneMigrationService.readBundleLedger(await mk('led-nofiles', '{"generator":"x"}')),
                null,
                'A ledger with no files[] must fail safe to null.'
            );
            assert.strictEqual(
                ControlPlaneMigrationService.readBundleLedger(await mk('led-nonstring', '{"files":["a",7]}')),
                null,
                'A ledger whose files[] is not all strings must fail safe to null.'
            );
            assert.deepStrictEqual(
                ControlPlaneMigrationService.readBundleLedger(await mk('led-ok', '{"files":["skills/a/SKILL.md"]}')),
                ['skills/a/SKILL.md'],
                'A valid ledger must round-trip its files[].'
            );
        }

        // ------------------------------------------------------------------
        // 5. Source contracts. Two of the guard's failure modes cannot be
        //    reached from a posix CI runner, so they are pinned as text.
        // ------------------------------------------------------------------
        {
            const servicePath = path.join(process.cwd(), 'src', 'services', 'ControlPlaneMigrationService.ts');
            const serviceSrc = fs.readFileSync(servicePath, 'utf8');
            const seedBody = serviceSrc.slice(
                serviceSrc.indexOf('public static async seedBundleSurface'),
                serviceSrc.indexOf('public static async pruneRetiredBundleFiles')
            );
            assert.ok(seedBody.length > 0, 'Could not locate seedBundleSurface in the source.');

            // (a) Windows key normalisation (plan Verification §8). The ledger stores
            //     posix keys; the crawl returns path.sep-joined ones. Without the
            //     split/join the lookup misses every entry on Windows and the guard
            //     silently no-ops — the exact resurrection, platform-conditional.
            assert.ok(
                /surface\s*\+\s*'\/'\s*\+\s*relativePath\.split\(path\.sep\)\.join\('\/'\)/.test(seedBody),
                "The ledger lookup key must be built as `surface + '/' + relativePath.split(path.sep).join('/')`. A native-separator key misses every ledger entry on Windows and the guard no-ops silently."
            );

            // (b) One parser, not two. The prune must consult the shared helper, or
            //     its validation and fail-safe drift from the seed's.
            const pruneBody = serviceSrc.slice(serviceSrc.indexOf('public static async pruneRetiredBundleFiles'));
            assert.ok(
                /this\.readBundleLedger\(workspaceRoot\)/.test(pruneBody),
                'pruneRetiredBundleFiles must read the ledger through readBundleLedger — a second inline parser drifts from the seed guard.'
            );
            assert.ok(
                !/JSON\.parse\([\s\S]{0,120}BUNDLE_LEDGER/.test(pruneBody),
                'pruneRetiredBundleFiles must not parse the ledger itself.'
            );

            // (c) The extension composition root must read the ledger ONCE before the
            //     seed and hand the same snapshot to both surfaces, and must no longer
            //     carry an inline unconditional dest-absent copy.
            const extSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
            const refresh = extSrc.slice(
                extSrc.indexOf('async function refreshWorkspaceControlPlane'),
                extSrc.indexOf('// Terminal Registry: Store terminal references for input forwarding')
            );
            assert.ok(refresh.length > 0, 'Could not locate refreshWorkspaceControlPlane in the source.');
            assert.strictEqual(
                (refresh.match(/ControlPlaneMigrationService\.readBundleLedger\(/g) || []).length,
                1,
                'refreshWorkspaceControlPlane must read the ledger exactly once, before the seed loops — a lazy mid-loop read makes the guard order-dependent.'
            );
            assert.strictEqual(
                (refresh.match(/ControlPlaneMigrationService\.seedBundleSurface\(/g) || []).length,
                2,
                'Both surfaces (skills + workflows) must go through the shared seed function.'
            );
            assert.ok(
                !/overwrite:\s*false/.test(refresh),
                'The inline unconditional `dest absent -> copy` seed branch must not return to refreshWorkspaceControlPlane — that is the resurrection this guard exists to stop.'
            );
            assert.ok(
                refresh.indexOf('ControlPlaneMigrationService.readBundleLedger(')
                    < refresh.indexOf('ControlPlaneMigrationService.seedBundleSurface('),
                'The ledger snapshot must be taken BEFORE the seed loops run.'
            );
        }

        console.log('✅ .agents seed deletion-guard contract: all checks passed');
    } finally {
        vscodeMock.restore();
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

run().catch((err) => {
    console.error('.agents seed deletion-guard contract failed:', err);
    process.exit(1);
});
