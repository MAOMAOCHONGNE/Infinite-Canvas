const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HISTORY_MODULE = path.join(ROOT, 'static', 'js', 'canvas-history.js');

function loadHistoryModule() {
    if (!fs.existsSync(HISTORY_MODULE)) {
        assert.fail('canvas-history.js is missing; canvas-level redo is not implemented');
    }
    delete require.cache[require.resolve(HISTORY_MODULE)];
    return require(HISTORY_MODULE);
}

test('snapshot history restores an undone state and can redo it', () => {
    const { createSnapshotHistory } = loadHistoryModule();
    let state = { value: 0 };
    const history = createSnapshotHistory({
        limit: 4,
        capture: () => ({ ...state }),
        restore: snapshot => { state = { ...snapshot }; },
    });

    history.record();
    state.value = 1;

    assert.equal(history.undo(), true);
    assert.deepEqual(state, { value: 0 });
    assert.equal(history.redo(), true);
    assert.deepEqual(state, { value: 1 });
});

test('recording a new mutation clears the redo branch', () => {
    const { createSnapshotHistory } = loadHistoryModule();
    let state = { value: 0 };
    const history = createSnapshotHistory({
        capture: () => ({ ...state }),
        restore: snapshot => { state = { ...snapshot }; },
    });

    history.record();
    state.value = 1;
    history.undo();
    history.record();
    state.value = 2;

    assert.equal(history.redo(), false);
    assert.deepEqual(state, { value: 2 });
});

test('a pending snapshot can be committed without recapturing changed state', () => {
    const { createSnapshotHistory } = loadHistoryModule();
    let state = { value: 0 };
    const history = createSnapshotHistory({
        capture: () => ({ ...state }),
        restore: snapshot => { state = { ...snapshot }; },
    });
    const beforeDrag = { value: state.value };

    state.value = 7;
    history.record(beforeDrag);

    assert.equal(history.undo(), true);
    assert.deepEqual(state, { value: 0 });
    assert.equal(history.redo(), true);
    assert.deepEqual(state, { value: 7 });
});

test('history keyboard shortcuts distinguish undo from both redo forms', () => {
    const { historyShortcutAction } = loadHistoryModule();

    assert.equal(historyShortcutAction({ key: 'z', ctrlKey: true }), 'undo');
    assert.equal(historyShortcutAction({ key: 'Z', ctrlKey: true, shiftKey: true }), 'redo');
    assert.equal(historyShortcutAction({ key: 'y', ctrlKey: true }), 'redo');
    assert.equal(historyShortcutAction({ key: 'z', metaKey: true }), 'undo');
    assert.equal(historyShortcutAction({ key: 'z' }), '');
});

test('normal and smart canvases load and route through the shared history module', () => {
    const normalHtml = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
    const smartHtml = fs.readFileSync(path.join(ROOT, 'static', 'smart-canvas.html'), 'utf8');
    const normalJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const smartJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');

    assert.match(normalHtml, /canvas-history\.js[^\n]*\n[^]*canvas\.js/);
    assert.match(smartHtml, /canvas-history\.js[^\n]*\n[^]*smart-canvas\.js/);
    for (const source of [normalJs, smartJs]) {
        assert.match(source, /createSnapshotHistory/);
        assert.match(source, /historyShortcutAction/);
        assert.match(source, /performRedo/);
    }
});

test('normal canvas records history before adding a node', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const start = source.indexOf('function addNode(node)');
    const end = source.indexOf('function defaultPoint', start);
    const addNodeSource = source.slice(start, end);

    assert.notEqual(start, -1, 'addNode must exist');
    assert.match(addNodeSource, /pushUndo\(\);/);
    assert.ok(
        addNodeSource.indexOf('pushUndo();') < addNodeSource.indexOf('nodes.push(node)'),
        'history must be recorded before the node array changes',
    );
});

test('normal canvas records history before moving a node', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const start = source.indexOf('function onNodeDrag(e)');
    const end = source.indexOf('function startNodeResize', start);
    const moveSource = source.slice(start, end);

    assert.match(moveSource, /pushUndo\(\);/);
    assert.ok(moveSource.indexOf('pushUndo();') < moveSource.indexOf('dragNode.node.x ='));
});

test('normal canvas releases editor focus before dragging or resizing a node', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const dragStart = source.indexOf('function startNodeDrag(e, node)');
    const dragEnd = source.indexOf('function onNodeDrag(e)', dragStart);
    const resizeStart = source.indexOf('function startNodeResize(e, node)');
    const resizeEnd = source.indexOf('function onNodeResize(e)', resizeStart);
    const dragSource = source.slice(dragStart, dragEnd);
    const resizeSource = source.slice(resizeStart, resizeEnd);

    assert.match(dragSource, /document\.activeElement\.blur\(\)/);
    assert.match(resizeSource, /document\.activeElement\.blur\(\)/);
});

test('normal canvas records history before resizing a node', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const start = source.indexOf('function onNodeResize(e)');
    const end = source.indexOf('function startLink', start);
    const resizeSource = source.slice(start, end);

    assert.match(resizeSource, /pushUndo\(\);/);
    assert.ok(resizeSource.indexOf('pushUndo();') < resizeSource.indexOf('resizeNode.node.w ='));
});
