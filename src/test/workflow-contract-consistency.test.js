/**
 * Regression tests for workflow contract parity between markdown specs and runtime FSM.
 * Run with: node src/test/workflow-contract-consistency.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { WORKFLOWS } = require('../mcp-server/workflows');

const WORKFLOW_DOC_DIR = path.join(process.cwd(), '.agent', 'workflows');
const IGNORED_DOCS = new Set(['DELEGATION_WORKFLOWS_README.md', 'wait-policy.md']);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}: ${e.message}`);
        failed++;
    }
}

function parseMarkdownContract(markdownText) {
    const phaseCalls = [...markdownText.matchAll(/complete_workflow_phase\([^\n)]*phase:\s*(\d+)/g)]
        .map(m => Number(m[1]));
    const terminalMatches = [...markdownText.matchAll(/Phase\s+(\d+)\s+is terminal/ig)]
        .map(m => Number(m[1]));
    const startWorkflowDeps = [...markdownText.matchAll(/start_workflow\(name:\s*"([^"]+)"/g)]
        .map(m => m[1]);

    return {
        maxPhase: phaseCalls.length ? Math.max(...phaseCalls) : null,
        terminalPhase: terminalMatches.length ? terminalMatches[0] : null,
        startWorkflowDeps
    };
}

function run() {
    console.log('\nRunning workflow contract consistency tests\n');

    const docs = fs.readdirSync(WORKFLOW_DOC_DIR)
        .filter(name => name.endsWith('.md'))
        .filter(name => !IGNORED_DOCS.has(name));

    const runtimeKeys = Object.keys(WORKFLOWS);
    const runtimeSet = new Set(runtimeKeys);

    test('every workflow markdown has a runtime workflow entry', () => {
        for (const doc of docs) {
            const id = doc.replace(/\.md$/, '');
            assert.ok(runtimeSet.has(id), `Missing runtime workflow '${id}' for '${doc}'`);
        }
    });

    test('every runtime workflow has a markdown contract', () => {
        const docsSet = new Set(docs.map(name => name.replace(/\.md$/, '')));
        for (const key of runtimeKeys) {
            assert.ok(docsSet.has(key), `Missing markdown contract for runtime workflow '${key}'`);
        }
    });

    test('markdown phase counts match runtime step counts', () => {
        for (const doc of docs) {
            const id = doc.replace(/\.md$/, '');
            const markdown = fs.readFileSync(path.join(WORKFLOW_DOC_DIR, doc), 'utf8');
            const { maxPhase } = parseMarkdownContract(markdown);
            if (maxPhase === null) continue;

            const runtimeSteps = WORKFLOWS[id]?.steps?.length || 0;
            assert.strictEqual(
                runtimeSteps,
                maxPhase,
                `Workflow '${id}' mismatch: markdown max phase ${maxPhase} vs runtime steps ${runtimeSteps}`
            );
        }
    });

    test('markdown terminal phase matches runtime step counts', () => {
        for (const doc of docs) {
            const id = doc.replace(/\.md$/, '');
            const markdown = fs.readFileSync(path.join(WORKFLOW_DOC_DIR, doc), 'utf8');
            const { terminalPhase } = parseMarkdownContract(markdown);
            if (terminalPhase === null) continue;

            const runtimeSteps = WORKFLOWS[id]?.steps?.length || 0;
            assert.strictEqual(
                runtimeSteps,
                terminalPhase,
                `Workflow '${id}' mismatch: markdown terminal phase ${terminalPhase} vs runtime steps ${runtimeSteps}`
            );
        }
    });

    test('markdown start_workflow dependencies are registered at runtime', () => {
        for (const doc of docs) {
            const id = doc.replace(/\.md$/, '');
            const markdown = fs.readFileSync(path.join(WORKFLOW_DOC_DIR, doc), 'utf8');
            const { startWorkflowDeps } = parseMarkdownContract(markdown);
            for (const dep of startWorkflowDeps) {
                assert.ok(
                    runtimeSet.has(dep),
                    `Workflow '${id}' references unregistered dependency '${dep}' in '${doc}'`
                );
            }
        }
    });

    test('runtime steps that instruct send_message/check_inbox declare requiredTools', () => {
        for (const [workflowId, workflow] of Object.entries(WORKFLOWS)) {
            const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
            for (const step of steps) {
                const instruction = String(step.instruction || '');
                const requiredTools = Array.isArray(step.requiredTools) ? step.requiredTools : [];

                if (/send_message/i.test(instruction)) {
                    assert.ok(
                        requiredTools.includes('send_message'),
                        `Workflow '${workflowId}' step '${step.id}' references send_message but missing requiredTools=['send_message']`
                    );
                }

                if (/check_inbox/i.test(instruction)) {
                    assert.ok(
                        requiredTools.includes('check_inbox'),
                        `Workflow '${workflowId}' step '${step.id}' references check_inbox but missing requiredTools=['check_inbox']`
                    );
                }
            }
        }
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run();
