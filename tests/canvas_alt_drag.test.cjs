const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DUPLICATION_MODULE = path.join(ROOT, 'static', 'js', 'canvas-duplication.js');
const { duplicateSelection } = require(DUPLICATION_MODULE);

function duplicateFixture({nodes, connections=[], selectedIds, anchorId, preserveExternalIncoming=false}){
    let nodeSequence = 0;
    let connectionSequence = 0;
    return duplicateSelection({
        nodes,
        connections,
        selectedIds,
        anchorId,
        preserveExternalIncoming,
        cloneNode:source => ({...JSON.parse(JSON.stringify(source)), id:`copy-${++nodeSequence}`, running:false}),
        createConnectionId:() => `connection-copy-${++connectionSequence}`
    });
}

test('Alt duplication copies every selected node and only their internal connections', () => {
    const nodes = [
        {id:'upload', type:'image', x:10, y:20},
        {id:'api', type:'generator', x:210, y:20},
        {id:'output', type:'output', x:410, y:20},
        {id:'outside', type:'prompt', x:10, y:200}
    ];
    const connections = [
        {id:'c1', from:'upload', to:'api'},
        {id:'c2', from:'api', to:'output'},
        {id:'c3', from:'outside', to:'api'}
    ];
    const result = duplicateFixture({
        nodes,
        connections,
        selectedIds:['upload', 'api', 'output'],
        anchorId:'api'
    });

    assert.equal(result.copies.length, 3);
    assert.equal(result.selectedCopyIds.length, 3);
    assert.equal(result.copiedConnections.length, 2);
    assert.equal(result.anchorCopy.type, 'generator');
    assert.deepEqual(result.copies.map(node => [node.x, node.y]), [[10, 20], [210, 20], [410, 20]]);
    assert.deepEqual(
        result.copiedConnections.map(connection => [connection.from, connection.to]),
        [
            [result.idMap.get('upload'), result.idMap.get('api')],
            [result.idMap.get('api'), result.idMap.get('output')]
        ]
    );
});

test('classic Alt duplication preserves external incoming links but not external outgoing links', () => {
    const nodes = [
        {id:'upstream', type:'output', x:10, y:20},
        {id:'runninghub', type:'runninghub', x:210, y:20},
        {id:'output', type:'output', x:410, y:20},
        {id:'downstream', type:'generator', x:610, y:20}
    ];
    const connections = [
        {id:'c1', from:'upstream', to:'runninghub'},
        {id:'c2', from:'runninghub', to:'output'},
        {id:'c3', from:'output', to:'downstream'}
    ];
    const result = duplicateFixture({
        nodes,
        connections,
        selectedIds:['runninghub', 'output'],
        anchorId:'runninghub',
        preserveExternalIncoming:true
    });

    assert.deepEqual(
        result.copiedConnections.map(connection => [connection.from, connection.to]),
        [
            ['upstream', result.idMap.get('runninghub')],
            [result.idMap.get('runninghub'), result.idMap.get('output')]
        ]
    );
    assert.equal(
        result.copiedConnections.some(connection => connection.to === 'downstream'),
        false
    );
});

test('Alt dragging an unselected node does not also duplicate an unrelated selection', () => {
    const nodes = [
        {id:'selected-a', type:'image', x:0, y:0},
        {id:'selected-b', type:'prompt', x:100, y:0},
        {id:'anchor', type:'output', x:200, y:0}
    ];
    const result = duplicateFixture({
        nodes,
        selectedIds:['selected-a', 'selected-b'],
        anchorId:'anchor'
    });

    assert.equal(result.copies.length, 1);
    assert.equal(result.anchorCopy.type, 'output');
    assert.deepEqual(result.selectedCopyIds, [result.anchorCopy.id]);
});

test('group members are copied once and group item ids are remapped', () => {
    const nodes = [
        {id:'group', type:'group', x:0, y:0, items:['child-a', 'child-b']},
        {id:'child-a', type:'image', x:20, y:40},
        {id:'child-b', type:'prompt', x:140, y:40}
    ];
    const result = duplicateFixture({
        nodes,
        selectedIds:['group', 'child-a'],
        anchorId:'group'
    });
    const groupCopy = result.copies.find(node => node.type === 'group');

    assert.equal(result.copies.length, 3);
    assert.deepEqual(groupCopy.items, [result.idMap.get('child-a'), result.idMap.get('child-b')]);
    assert.deepEqual(result.selectedCopyIds, [result.idMap.get('group'), result.idMap.get('child-a')]);
});

test('classic canvas Alt-drag preserves incoming links while clipboard copy remains internal-only', () => {
    const html = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const start = source.indexOf('function startNodeDrag(e, node)');
    const end = source.indexOf('function onNodeDrag(e)', start);
    const dragSource = source.slice(start, end);

    assert.match(html, /canvas-duplication\.js[^\n]*\n[^]*canvas\.js/);
    assert.match(source, /selected\.has\(node\.id\) \? \[\.\.\.selected\] : \[node\.id\]/);
    assert.ok(dragSource.indexOf('pushUndo();') < dragSource.indexOf('duplicateNodesForAltDrag'));
    assert.match(dragSource, /duplicateNodesForAltDrag\(node, true\)/);
    assert.match(dragSource, /\(duplicated\.rootCopyIds \|\| duplicated\.selectedCopyIds\)\.forEach/);
    assert.match(dragSource, /historyCaptured:Boolean\(e\.altKey && !bypassGridSnap\)/);
    assert.match(dragSource, /const bypassGridSnap = Boolean\(e\.altKey/);
    assert.match(source, /connections \|\| \[\]\)\.filter\(c => ids\.has\(c\.from\) && ids\.has\(c\.to\)\)/);
});

test('smart canvas keeps every Alt-drag copy selected so the whole copy set moves', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');
    const start = source.indexOf('function duplicateForAltDrag(node, preserveConnections=false)');
    const end = source.indexOf('function shellPoint(event)', start);
    const duplicateSource = source.slice(start, end);
    const runFixture = new Function(`
        let selectedId = '';
        let selectedIds = ['a', 'b', 'c', 'd', 'e'];
        let selectedImage = {nodeId:'', index:-1};
        const nodes = selectedIds.map((id, index) => ({id, x:index * 100, y:index * 20}));
        const canvas = {connections:[]};
        const SpatialFrames = {
            copyClosureIds:(allNodes, rootIds) => rootIds.slice(),
            remapFrameItems:(items, idMap) => items.map(id => idMap.get(id)).filter(Boolean)
        };
        const isNodeSelected = id => selectedId === id || selectedIds.includes(id);
        const selectedNodeIds = () => selectedIds.length ? selectedIds.slice() : (selectedId ? [selectedId] : []);
        const pushUndo = () => {};
        const cloneSmartNode = node => ({...node, id:'copy-' + node.id});
        const render = () => {};
        const scheduleSave = () => {};
        ${duplicateSource}
        const anchor = duplicateForAltDrag(nodes[2]);
        const dragIds = selectedIds.includes(anchor.id) ? selectedIds.slice() : [anchor.id];
        const group = dragIds.map(id => nodes.find(node => node.id === id));
        group.forEach(node => { node.x += 75; node.y += 40; });
        return {anchorId:anchor.id, selectedId, selectedIds, groupIds:group.map(node => node.id), copies:nodes.slice(5)};
    `);
    const result = runFixture();

    assert.equal(result.selectedId, '');
    assert.equal(result.selectedIds.length, 5);
    assert.deepEqual(result.groupIds, result.selectedIds);
    assert.ok(result.selectedIds.includes(result.anchorId));
    assert.deepEqual(result.copies.map(node => [node.x, node.y]), [
        [75, 40], [175, 60], [275, 80], [375, 100], [475, 120]
    ]);
});

test('smart Alt-drag records duplication and movement as one undo gesture', () => {
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');
    const bindStart = source.indexOf('const beginNodeDrag = e =>');
    const bindEnd = source.indexOf("el.querySelectorAll('.node-port')", bindStart);
    const dragStartSource = source.slice(bindStart, bindEnd);
    const mouseUpStart = source.indexOf('window.onmouseup = e =>');
    const mouseUpEnd = source.indexOf("shell.addEventListener('wheel'", mouseUpStart);
    const mouseUpSource = source.slice(mouseUpStart, mouseUpEnd);

    assert.match(dragStartSource, /historyCaptured = node\.id !== sourceId/);
    assert.match(dragStartSource, /if\(!historyCaptured\) capturePendingUndo\(\)/);
    assert.match(mouseUpSource, /if\(stateChanged && !dragState\.historyCaptured\) commitPendingUndo\(\)/);
});
