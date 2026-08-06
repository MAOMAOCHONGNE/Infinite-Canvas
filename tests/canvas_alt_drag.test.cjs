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

test('classic canvas loads duplication helper and records one undo before Alt cloning', () => {
    const html = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
    const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
    const start = source.indexOf('function startNodeDrag(e, node)');
    const end = source.indexOf('function onNodeDrag(e)', start);
    const dragSource = source.slice(start, end);

    assert.match(html, /canvas-duplication\.js[^\n]*\n[^]*canvas\.js/);
    assert.match(source, /selected\.has\(node\.id\) \? \[\.\.\.selected\] : \[node\.id\]/);
    assert.ok(dragSource.indexOf('pushUndo();') < dragSource.indexOf('duplicateNodesForAltDrag'));
    assert.match(dragSource, /duplicated\.selectedCopyIds\.forEach/);
    assert.match(dragSource, /historyCaptured:Boolean\(e\.altKey\)/);
});
