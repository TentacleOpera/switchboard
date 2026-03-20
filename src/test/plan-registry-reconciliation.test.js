'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const extensionPath = path.join(__dirname, '..', 'extension.ts');
const readmePath = path.join(__dirname, '..', '..', '.switchboard', 'README.md');

const providerSource = fs.readFileSync(providerPath, 'utf8');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');
const readmeSource = fs.readFileSync(readmePath, 'utf8');

describe('plan registry reconciliation regressions', () => {
    it('refresh path reconciles missing local registry entries from run sheets', () => {
        assert.match(
            providerSource,
            /private async _reconcileLocalPlansFromRunSheets\(workspaceRoot: string\)[\s\S]*sheet\.planFile[\s\S]*sourceType: 'local'[\s\S]*status: 'active'/,
            'Expected TaskViewerProvider to reconcile active local plans from run sheets into the registry.'
        );
        assert.match(
            providerSource,
            /_refreshRunSheets\(\)[\s\S]*_reconcileLocalPlansFromRunSheets\(workspaceRoot\)/,
            'Expected _refreshRunSheets to invoke local plan reconciliation before filtering visible sheets.'
        );
    });

    it('plan registry writes are serialized', () => {
        assert.match(
            providerSource,
            /private _planRegistryWriteTail: Promise<void> = Promise\.resolve\(\);/,
            'Expected TaskViewerProvider to keep a serialized write tail for plan_registry.json.'
        );
        assert.match(
            providerSource,
            /const nextWrite = this\._planRegistryWriteTail\.then\(writeOperation\);[\s\S]*this\._planRegistryWriteTail = nextWrite\.catch\(\(\) => \{ \}\);[\s\S]*await nextWrite;/,
            'Expected _savePlanRegistry to serialize registry writes through the write tail.'
        );
    });

    it('legacy plan migration recursively flattens legacy subdirectories', () => {
        assert.match(
            extensionSource,
            /const collectLegacyFiles = async \(dir: string\): Promise<string\[]> => \{[\s\S]*entry\.isDirectory\(\)[\s\S]*collectLegacyFiles\(fullPath\)/,
            'Expected migrateLegacyPlans to recursively collect files from legacy plan subdirectories.'
        );
        assert.match(
            extensionSource,
            /fs\.promises\.rm\(legacyDir, \{ recursive: true, force: true \}\)/,
            'Expected migrateLegacyPlans to remove legacy directories after flattening.'
        );
    });

    it('switchboard README documents flat plans directory', () => {
        assert.match(
            readmeSource,
            /\| `plans\/` \| Flat plan directory tracked by the sidebar; legacy subfolders are not used \|/,
            'Expected .switchboard README to describe a flat plans directory.'
        );
        assert.doesNotMatch(
            readmeSource,
            /plans\/features\//,
            'Expected .switchboard README not to mention plans/features/.'
        );
    });
});
