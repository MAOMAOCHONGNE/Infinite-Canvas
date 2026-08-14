const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const helperPath = path.resolve(__dirname, '..', 'static', 'js', 'classic-node-favorites.js');

function loadFavorites(){
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
}

function fakeClassList(){
    const values = new Set();
    return {
        add:(...names) => names.forEach(name => values.add(name)),
        remove:(...names) => names.forEach(name => values.delete(name)),
        toggle:(name, force) => force ? values.add(name) : values.delete(name),
        contains:name => values.has(name),
    };
}

function fakeDragRow(){
    return {
        classList:fakeClassList(),
        getBoundingClientRect:() => ({top:100, height:40}),
    };
}

test('default compact menu stays short while link-only group remains available to compatible drag menus', () => {
    const favorites = loadFavorites();
    const preference = favorites.normalizePreference();

    assert.deepEqual(favorites.menuTypes(preference, favorites.blankCanvasTypes()), [
        'image', 'prompt', 'note', 'loop', 'llm', 'generator', 'output',
    ]);
    assert.ok(favorites.menuTypes(preference, ['image', 'prompt', 'group', 'llm']).includes('group'));
});

test('one reordered favorite preference drives blank and compatible drag menus', () => {
    const favorites = loadFavorites();
    const preference = favorites.normalizePreference({
        favoriteTypes:['video', 'prompt', 'generator'],
        order:['video', 'prompt', 'generator'],
    });

    assert.deepEqual(favorites.menuTypes(preference, favorites.blankCanvasTypes()), [
        'video', 'prompt', 'generator',
    ]);
    assert.deepEqual(favorites.menuTypes(preference, ['image', 'prompt', 'generator', 'video']), [
        'video', 'prompt', 'generator',
    ]);
    assert.deepEqual(favorites.menuTypes(preference, ['image', 'prompt', 'generator']), [
        'prompt', 'generator',
    ]);
});

test('removing video from favorites hides it from every compact menu but not the compatible full menu', () => {
    const favorites = loadFavorites();
    const preference = favorites.setFavorite(favorites.normalizePreference(), 'video', false);
    const compatible = ['generator', 'video', 'llm'];

    assert.deepEqual(favorites.menuTypes(preference, compatible), ['llm', 'generator']);
    assert.deepEqual(favorites.menuTypes(preference, compatible, {showAll:true}), [
        'llm', 'generator', 'video',
    ]);
});

test('drag reordering is stable and affects only the requested insertion point', () => {
    const favorites = loadFavorites();
    const preference = favorites.normalizePreference();
    const moved = favorites.moveType(preference, 'output', 'prompt', 'before');

    assert.deepEqual(favorites.menuTypes(moved, favorites.blankCanvasTypes()), [
        'image', 'output', 'prompt', 'note', 'loop', 'llm', 'generator',
    ]);
    assert.equal(new Set(moved.order).size, favorites.catalog().length);
});

test('the grip owns native dragging and drops the source at the visible insertion edge', () => {
    const favorites = loadFavorites();
    let preference = favorites.normalizePreference();
    let draggedType = '';
    const sourceRow = fakeDragRow();
    const targetRow = fakeDragRow();
    const sourceGrip = {};
    const targetGrip = {};
    const rows = [sourceRow, targetRow];
    const options = type => ({
        type,
        getDraggedType:() => draggedType,
        setDraggedType:value => { draggedType = value; },
        clearIndicators:() => rows.forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after')),
        onMove:(sourceType, targetType, position) => {
            preference = favorites.moveType(preference, sourceType, targetType, position);
        },
    });

    favorites.bindReorderDrag(sourceRow, sourceGrip, options('output'));
    favorites.bindReorderDrag(targetRow, targetGrip, options('prompt'));

    const transferred = [];
    sourceGrip.ondragstart({
        dataTransfer:{
            setData:(format, value) => transferred.push([format, value]),
        },
    });
    let prevented = false;
    targetRow.ondragover({clientY:105, preventDefault:() => { prevented = true; }});
    targetRow.ondrop({clientY:105, preventDefault:() => { prevented = true; }});

    assert.equal(sourceGrip.draggable, true);
    assert.deepEqual(transferred, [['text/plain', 'output']]);
    assert.equal(prevented, true);
    assert.equal(draggedType, '');
    assert.equal(targetRow.classList.contains('drop-before'), false);
    assert.deepEqual(favorites.menuTypes(preference, favorites.blankCanvasTypes()), [
        'image', 'output', 'prompt', 'note', 'loop', 'llm', 'generator',
    ]);
});

test('releasing after a visible insertion preview commits even when the row misses drop', () => {
    const favorites = loadFavorites();
    let preference = favorites.normalizePreference();
    let draggedType = '';
    let pendingTarget = null;
    const sourceRow = fakeDragRow();
    const targetRow = fakeDragRow();
    const sourceGrip = {};
    const targetGrip = {};
    const rows = [sourceRow, targetRow];
    const options = type => ({
        type,
        getDraggedType:() => draggedType,
        setDraggedType:value => { draggedType = value; },
        getDropTarget:() => pendingTarget,
        setDropTarget:value => { pendingTarget = value; },
        clearIndicators:() => rows.forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after')),
        onMove:(sourceType, targetType, position) => {
            preference = favorites.moveType(preference, sourceType, targetType, position);
        },
    });

    favorites.bindReorderDrag(sourceRow, sourceGrip, options('llm'));
    favorites.bindReorderDrag(targetRow, targetGrip, options('output'));
    sourceGrip.ondragstart({dataTransfer:{setData:() => {}}});
    targetRow.ondragover({clientY:139, preventDefault:() => {}});
    sourceGrip.ondragend();

    assert.equal(draggedType, '');
    assert.equal(pendingTarget, null);
    assert.deepEqual(favorites.menuTypes(preference, favorites.blankCanvasTypes()), [
        'image', 'prompt', 'note', 'loop', 'generator', 'output', 'llm',
    ]);
});

test('modal wheel input scrolls its list without reaching the canvas zoom handler', () => {
    const favorites = loadFavorites();
    const list = {scrollTop:30};
    let stopped = false;
    let prevented = false;
    favorites.handleModalWheel({
        deltaY:90,
        target:{closest:() => null},
        stopPropagation:() => { stopped = true; },
        preventDefault:() => { prevented = true; },
    }, list);

    assert.equal(stopped, true);
    assert.equal(prevented, true);
    assert.equal(list.scrollTop, 120);

    prevented = false;
    favorites.handleModalWheel({
        deltaY:90,
        target:{closest:selector => selector === '.favorite-nodes-list'},
        stopPropagation:() => { stopped = true; },
        preventDefault:() => { prevented = true; },
    }, list);
    assert.equal(prevented, false);
    assert.equal(list.scrollTop, 120);
});

test('storage loading repairs malformed data and saving writes one shared preference', () => {
    const favorites = loadFavorites();
    const writes = [];
    const storage = {
        getItem:() => '{"favoriteTypes":["video","video","missing"],"order":["missing","video"]}',
        setItem:(key, value) => writes.push([key, JSON.parse(value)]),
    };
    const preference = favorites.loadPreference(storage);

    assert.deepEqual(preference.favoriteTypes, ['video']);
    assert.equal(preference.order[0], 'video');
    assert.equal(new Set(preference.order).size, favorites.catalog().length);

    favorites.savePreference(storage, preference);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], favorites.STORAGE_KEY);
    assert.deepEqual(writes[0][1], preference);
});
