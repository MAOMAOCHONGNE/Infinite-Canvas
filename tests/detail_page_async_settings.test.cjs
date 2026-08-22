const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static', 'api-settings.html'), 'utf8');
const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'api-settings.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');

test('provider settings expose opt-in OpenAI async image recovery without secrets', () => {
    assert.match(html, /id="imageAsyncEnabledInput"/);
    assert.match(html, /id="imageTaskEndpointInput"/);
    assert.match(html, /异步生图自动恢复/);
    assert.match(source, /image_async_enabled/);
    assert.match(source, /image_task_endpoint/);
    assert.match(main, /image_async_enabled/);
    assert.match(main, /image_task_endpoint/);
});

test('Comfly is automatically recognized while other relays stay opt-in', () => {
    assert.match(main, /ai\.comfly\.org/);
    assert.match(main, /detail_page_async_image_enabled/);
    assert.match(source, /ai\.comfly\.org/);
});
