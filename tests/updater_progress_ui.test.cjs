const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const backend = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');

test('update dialog exposes file, byte, speed, elapsed, ETA, and current-file progress', () => {
    for (const id of [
        'project-update-progress-panel', 'project-update-progress-bar',
        'project-update-progress-files', 'project-update-progress-size',
        'project-update-progress-speed', 'project-update-progress-time',
        'project-update-progress-eta', 'project-update-progress-file',
    ]) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, /setInterval\(pollProjectUpdateProgress, 700\)/);
    assert.match(html, /fetch\('\/api\/update-progress', \{cache:'no-store'\}\)/);
    assert.match(html, /completed_files/);
});

test('backend streams updater downloads and publishes no-store progress phases', () => {
    assert.match(backend, /@app\.get\("\/api\/update-progress"\)/);
    assert.match(backend, /stream=True/);
    assert.match(backend, /iter_content\(chunk_size=64 \* 1024\)/);
    assert.match(backend, /"listing"/);
    for (const phase of ['downloading', 'validating', 'backing_up', 'replacing', 'restarting', 'cancelling', 'cancelled', 'complete', 'failed']) {
        assert.match(backend, new RegExp(`"${phase}"`));
    }
    assert.match(backend, /Cache-Control.*no-store/);
});

test('closing the dialog does not abort a server-owned update', () => {
    const start = html.indexOf('function closeProjectUpdateModal()');
    const end = html.indexOf("document.getElementById('project-update-modal')?.addEventListener", start);
    const block = html.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(block, /\.abort\(/);
    assert.match(block, /modal\.hidden = true/);
});
