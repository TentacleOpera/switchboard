'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const reviewHtmlPath = path.join(process.cwd(), 'src', 'webview', 'review.html');
    const reviewHtml = await fs.promises.readFile(reviewHtmlPath, 'utf8');

    assert.ok(!reviewHtml.includes('id="topic-input"'), 'review ticket should not expose a redundant topic field in the metadata grid');
    assert.ok(reviewHtml.includes('id="header-title-input"'), 'review ticket should expose an editable title input in the header');
    assert.ok(reviewHtml.includes("topic: nextTopic"), 'savePlanText should post the edited title with the save request');
    assert.ok(reviewHtml.includes("headerTitleEl.classList.add('hidden')"), 'edit mode should swap from display title to header title input');
    assert.ok(reviewHtml.includes("headerTitleInputEl.classList.remove('hidden')"), 'edit mode should reveal the header title input');

    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const providerSource = await fs.promises.readFile(providerPath, 'utf8');

    assert.ok(providerSource.includes("const requestedTopic = String(request.topic || '').trim();"), 'savePlanText handler should read the requested title');
    assert.ok(providerSource.includes("const nextContent = requestedTopic"), 'savePlanText handler should derive content from the requested title');
    assert.ok(providerSource.includes("this._applyTopicToPlanContent(content, requestedTopic)"), 'savePlanText handler should stamp the requested title into markdown before saving');

    console.log('review ticket title regression test passed');
}

run().catch((error) => {
    console.error('review ticket title regression test failed:', error);
    process.exit(1);
});
