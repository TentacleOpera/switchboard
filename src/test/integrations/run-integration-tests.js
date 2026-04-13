'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const suites = {
    notion: [
        'src/test/integrations/notion/notion-url-parsing.test.js',
        'src/test/integrations/notion/notion-markdown-conversion.test.js',
        'src/test/integrations/notion/notion-fetch-service.test.js',
        'src/test/integrations/notion/notion-regression.test.js'
    ],
    clickup: [
        'src/test/integrations/clickup/clickup-sync-service.test.js',
        'src/test/integrations/clickup/clickup-import-flow.test.js',
        'src/test/integrations/clickup/clickup-rate-limiting.test.js',
        'src/test/integrations/clickup/clickup-regression.test.js'
    ],
    linear: [
        'src/test/integrations/linear/linear-graphql-client.test.js',
        'src/test/integrations/linear/linear-sync-service.test.js',
        'src/test/integrations/linear/linear-import-flow.test.js',
        'src/test/integrations/linear/linear-automation-service.test.js',
        'src/test/integrations/linear/linear-regression.test.js'
    ],
    shared: [
        'src/test/integrations/shared/integration-auto-pull-service.test.js'
    ],
    e2e: [
        'src/test/integrations/e2e/integration-workflow.test.js'
    ]
};

const group = process.argv[2] || 'all';
const files = group === 'all'
    ? [...suites.shared, ...suites.notion, ...suites.clickup, ...suites.linear, ...suites.e2e]
    : suites[group];

if (!files) {
    console.error(`Unknown integration suite '${group}'. Expected one of: ${['all', ...Object.keys(suites)].join(', ')}`);
    process.exit(1);
}

for (const relativePath of files) {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), relativePath)], {
        cwd: process.cwd(),
        stdio: 'inherit'
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

console.log(`integration suite '${group}' passed`);
