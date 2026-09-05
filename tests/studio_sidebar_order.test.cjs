const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'static', 'index.html');

function readStudioNav() {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    const start = html.indexOf('<nav>');
    const end = html.indexOf('</nav>', start);
    assert.ok(start >= 0 && end > start, 'studio navigation markup is missing');
    return html.slice(start, end);
}

test('studio sidebar keeps the requested top-level navigation order', () => {
    const nav = readStudioNav();
    const order = [
        "id=local-nav-toggle",
        "id=local-nav-group",
        "page=online",
        "page=gpt-chat",
        "page=main-image",
        "page=detail-page",
        "page=image-generation",
        "page=canvas"
    ];
    const markers = order.map(marker => {
        const needle = marker.startsWith('id=')
            ? `id="${marker.slice(3)}"`
            : `switchUI(this, '${marker.slice(5)}')`;
        const index = nav.indexOf(needle);
        assert.ok(index >= 0, `missing navigation marker: ${marker}`);
        return index;
    });

    for (let index = 1; index < markers.length; index += 1) {
        assert.ok(markers[index - 1] < markers[index], `${order[index - 1]} must precede ${order[index]}`);
    }
});

test('studio sidebar keeps basic tools grouped and canvas label unchanged', () => {
    const nav = readStudioNav();
    assert.match(nav, /id="local-nav-toggle"[\s\S]*data-i18n="nav\.basicTools">基础功能/);
    assert.match(nav, /id="local-nav-group"[\s\S]*data-i18n="nav\.textToImage">文生图[\s\S]*data-i18n="nav\.enhance">细节增强[\s\S]*data-i18n="nav\.imageEdit">图片编辑[\s\S]*data-i18n="nav\.angle">角度控制[\s\S]*switchUI\(this, 'online'\)[\s\S]*data-i18n="nav\.online">在线生图[\s\S]*switchUI\(this, 'gpt-chat'\)[\s\S]*data-i18n="nav\.gpt">GPT 对话/);
    assert.match(nav, /data-i18n="nav\.gpt">GPT 对话[\s\S]*<!-- 分隔线 -->[\s\S]*switchUI\(this, 'main-image'\)/);
    assert.equal((nav.match(/switchUI\(this, 'online'\)/g) || []).length, 1);
    assert.equal((nav.match(/switchUI\(this, 'gpt-chat'\)/g) || []).length, 1);
    assert.match(nav, /switchUI\(this, 'canvas'\)[\s\S]*data-i18n="nav\.canvas">无限画布/);
});

test('studio sidebar places one global backup entry directly above more settings', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    const footerStart = html.indexOf('<div class="sidebar-footer">');
    const footerEnd = html.indexOf('</div>\n        </aside>', footerStart);
    assert.ok(footerStart >= 0 && footerEnd > footerStart, 'sidebar footer markup is missing');
    const footer = html.slice(footerStart, footerEnd);
    const backupIndex = footer.indexOf('id="global-backup-btn"');
    const settingsIndex = footer.indexOf('id="settings-popover-toggle"');
    assert.ok(backupIndex >= 0, 'global backup entry is missing');
    assert.ok(settingsIndex > backupIndex, 'backup entry must precede more settings');
    assert.match(footer, /id="global-backup-btn"[\s\S]*data-i18n="nav\.backupRestore">备份与恢复/);

    const popover = html.slice(html.indexOf('id="global-backup-popover"'), html.indexOf('</div>\n        <script>', html.indexOf('id="global-backup-popover"')));
    assert.match(popover, /data-backup-action="export"/);
    assert.match(popover, /data-backup-action="import"/);
    assert.match(html, /id="backupModal"/);
    assert.match(html, /InfiniteCanvasBackup\?\.openBackupAction\?\./);
    assert.doesNotMatch(html, /pendingGlobalBackupAction|flushPendingBackupAction/);

    const canvasList = fs.readFileSync(path.join(ROOT, 'static', 'canvas-list.html'), 'utf8');
    assert.doesNotMatch(canvasList, /data-backup-action="export"/);
    assert.doesNotMatch(canvasList, /data-backup-action="import"/);
});
