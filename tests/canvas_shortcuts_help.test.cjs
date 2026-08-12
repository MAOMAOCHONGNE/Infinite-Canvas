const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'static', 'js', 'canvas-shortcuts-help.js');
const CLASSIC_HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const SMART_HTML_PATH = path.join(ROOT, 'static', 'smart-canvas.html');

function loadHelper(){
    if(!fs.existsSync(HELPER_PATH)) {
        assert.fail('canvas-shortcuts-help.js is missing; shortcut help is not shared between canvases');
    }
    delete require.cache[require.resolve(HELPER_PATH)];
    return require(HELPER_PATH);
}

function fakeElement(){
    const classes = new Set();
    const attributes = new Map();
    return {
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, force){
                if(force === undefined) force = !classes.has(name);
                if(force) classes.add(name);
                else classes.delete(name);
                return force;
            },
        },
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: name => attributes.get(name),
    };
}

test('classic shortcut profile contains real classic actions and omits smart-only actions', () => {
    const {shortcutItems} = loadHelper();
    const ids = shortcutItems('classic').map(item => item.id);

    assert.deepEqual(ids, [
        'box-select', 'group', 'undo', 'redo-shift', 'redo-y', 'copy', 'paste',
        'alt-copy', 'alt-shift-copy', 'assets', 'overview', 'pan', 'zoom', 'delete',
    ]);
    assert.ok(!ids.includes('ungroup'));
    assert.ok(!ids.includes('create-menu'));
});

test('smart shortcut profile preserves every existing smart shortcut row', () => {
    const {shortcutItems} = loadHelper();
    const ids = shortcutItems('smart').map(item => item.id);

    assert.equal(ids.length, 16);
    assert.ok(ids.includes('ungroup'));
    assert.ok(ids.includes('assets'));
    assert.ok(ids.includes('create-menu'));
});

test('shortcut markup renders translated rows and the actual key combinations', () => {
    const {shortcutItemsHtml} = loadHelper();
    const html = shortcutItemsHtml('classic');

    assert.equal((html.match(/class="shortcut-item"/g) || []).length, 14);
    assert.match(html, /data-shortcut-id="assets"[^>]*><span class="shortcut-keys"><kbd>A<\/kbd>/);
    assert.match(html, /<kbd>Ctrl<\/kbd><kbd>Shift<\/kbd><kbd>Z<\/kbd>/);
    assert.match(html, /data-i18n="smart\.shortcutAltShiftCopy"/);
    assert.doesNotMatch(html, /smart\.shortcutUngroup/);
});

test('shortcut controller keeps modal visibility, button state, and accessibility state synchronized', () => {
    const {createShortcutController} = loadHelper();
    const modal = fakeElement();
    const toggle = fakeElement();
    let openCount = 0;
    const controller = createShortcutController({modal, toggle, onOpen:() => { openCount += 1; }});

    controller.open();
    assert.equal(modal.classList.contains('open'), true);
    assert.equal(toggle.classList.contains('active'), true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(openCount, 1);

    controller.close();
    assert.equal(modal.classList.contains('open'), false);
    assert.equal(toggle.classList.contains('active'), false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('classic upper-right controls place shortcuts between workflow and logs, with assets last', () => {
    const html = fs.readFileSync(CLASSIC_HTML_PATH, 'utf8');
    const workflow = html.indexOf('id="workflowTransferToggle"');
    const shortcuts = html.indexOf('id="canvasShortcutToggle"');
    const logs = html.indexOf('id="canvasLogToggle"');
    const assets = html.indexOf('id="canvasAssetToggle"');

    assert.ok(workflow >= 0 && workflow < shortcuts && shortcuts < logs && logs < assets);
    assert.match(html, /id="canvasShortcutModal"[^>]*data-shortcut-profile="classic"/);
});

test('both canvases load the shared shortcut helper before their page script', () => {
    const classic = fs.readFileSync(CLASSIC_HTML_PATH, 'utf8');
    const smart = fs.readFileSync(SMART_HTML_PATH, 'utf8');

    assert.ok(classic.indexOf('/static/js/canvas-shortcuts-help.js') < classic.indexOf('/static/js/canvas.js'));
    assert.ok(smart.indexOf('/static/js/canvas-shortcuts-help.js') < smart.indexOf('/static/js/smart-canvas.js'));
    assert.match(classic, /\/static\/css\/canvas-shortcuts-help\.css/);
    assert.match(smart, /\/static\/css\/canvas-shortcuts-help\.css/);
});
