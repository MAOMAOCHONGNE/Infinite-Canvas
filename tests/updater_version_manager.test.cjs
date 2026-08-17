const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'static', 'index.html'), 'utf8');

function sourceBlock(start, end){
    const from = html.indexOf(start);
    const to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing block ${start}`);
    return html.slice(from, to);
}

test('version badge always opens the version manager instead of latest-version alerts', () => {
    assert.match(html, /id="project-version-badge"[^>]+onclick="openProjectVersionManager\(\)"/);
    const check = sourceBlock('async function checkForUpdates(', '</script>');
    assert.doesNotMatch(check, /已是最新版本|You are on the latest version/);
    assert.match(check, /refreshProjectVersionState/);
});

test('version manager exposes update and local restore-point tabs', () => {
    for(const id of [
        'project-update-tab-update', 'project-update-tab-restore',
        'project-update-pane-update', 'project-update-pane-restore',
        'project-update-backup-list', 'project-update-backup-empty',
    ]) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, /fetch\('\/api\/update-backups', \{cache:'no-store'\}\)/);
    assert.match(html, /restoreProjectUpdateBackup/);
    assert.match(html, /id="project-update-recheck-btn"[^>]+onclick="checkForUpdates\(true\)"/);
    const restore = sourceBlock('async function restoreProjectUpdateBackup(', 'window.rollbackProjectUpdate');
    assert.doesNotMatch(restore, /prompt\(/);
    assert.doesNotMatch(html, /async function rollbackProjectUpdate\(/);
});

test('running update distinguishes background hiding from explicit cancellation', () => {
    assert.match(html, /id="project-update-stop-btn"/);
    assert.match(html, /fetch\('\/api\/update-cancel'/);
    assert.match(html, /operation_id/);
    assert.match(html, /cancellable/);
    assert.match(html, /cancel_requested/);
    assert.match(html, /cancelling/);
    assert.match(html, /cancelled/);
    assert.match(html, /后台运行/);

    const close = sourceBlock('function closeProjectUpdateModal()', "document.getElementById('project-update-modal')?.addEventListener");
    assert.match(close, /modal\.hidden = true/);
    assert.doesNotMatch(close, /update-cancel|\.abort\(/);
});

test('opening or reopening synchronizes backend progress and restore points', () => {
    const open = sourceBlock('async function openProjectVersionManager()', 'function closeProjectUpdateModal()');
    assert.match(open, /pollProjectUpdateProgress/);
    assert.match(open, /loadProjectUpdateBackups/);
    assert.match(open, /checkForUpdates/);
    const badge = sourceBlock('function setProjectVersionBadge(', 'function refreshUpdateButtonText()');
    assert.match(badge, /更新中 \$\{percent\}%/);
    const actions = sourceBlock('function refreshProjectUpdateActions()', 'function refreshProjectVersionState()');
    assert.match(actions, /!projectUpdateReachable/);
    assert.match(actions, /暂时无法更新/);
    const progress = sourceBlock('function renderUpdateProgress(data)', 'async function pollProjectUpdateProgress()');
    assert.match(progress, /classList\.toggle\('is-updating', showProgress\)/);
});
