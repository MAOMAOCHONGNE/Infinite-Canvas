const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SOURCE_PATH = path.resolve(__dirname, '..', 'static', 'js', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, Math.max(0, from));
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function bridgeHarness(initialNodes, initialConnections){
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicApiOutputBridgePosition', 'function canConnect');
    const nodes = structuredClone(initialNodes);
    const connections = structuredClone(initialConnections);
    let undoCount = 0;
    let id = 0;
    const synced = [];
    const connect = new Function(
        'nodes', 'connections', 'nodeRect', 'defaultNodeSize', 'uid', 'pushUndo', 'canConnect',
        'autoSizeLoopForPanels', 'syncLatestGeneratedOutputToConnection',
        `${block}; return connectClassicNodes;`,
    )(
        nodes,
        connections,
        node => ({
            x:Number(node.x) || 0,
            y:Number(node.y) || 0,
            w:Number(node.w) || (node.type === 'generator' ? 380 : 460),
            h:Number(node.h) || (node.type === 'generator' ? 380 : 260),
            cx:(Number(node.x) || 0) + (Number(node.w) || (node.type === 'generator' ? 380 : 460)) / 2,
            cy:(Number(node.y) || 0) + (Number(node.h) || (node.type === 'generator' ? 380 : 260)) / 2,
        }),
        type => type === 'output' ? {w:460, h:260} : {w:380, h:380},
        prefix => `${prefix}-${++id}`,
        () => { undoCount += 1; },
        () => true,
        () => {},
        (from, to) => { synced.push([from, to]); return true; },
    );
    return {connect, nodes, connections, synced, undoCount:() => undoCount};
}

test('new classic API-to-API link creates one Output and two visible connections atomically', () => {
    const harness = bridgeHarness([
        {id:'api-1', type:'generator', x:0, y:0, w:380, h:380},
        {id:'api-2', type:'generator', x:1100, y:0, w:380, h:380},
    ], []);

    assert.equal(harness.connect('api-1', 'api-2'), true);

    const output = harness.nodes.find(node => node.type === 'output');
    assert.ok(output, 'an Output node should be inserted');
    assert.deepEqual({x:output.x, y:output.y}, {x:510, y:60});
    assert.deepEqual(
        harness.connections.map(({from, to}) => [from, to]),
        [['api-1', output.id], [output.id, 'api-2']],
    );
    assert.equal(harness.connections.some(edge => edge.from === 'api-1' && edge.to === 'api-2'), false);
    assert.equal(harness.undoCount(), 1);
    assert.deepEqual(harness.synced, [['api-1', output.id]]);
});

test('API-to-API link reuses the nearest Output already owned by the upstream API', () => {
    const harness = bridgeHarness([
        {id:'api-1', type:'generator', x:0, y:0},
        {id:'out-near', type:'output', x:450, y:0},
        {id:'out-far', type:'output', x:450, y:900},
        {id:'api-2', type:'generator', x:1100, y:0},
    ], [
        {id:'existing-1', from:'api-1', to:'out-near'},
        {id:'existing-2', from:'api-1', to:'out-far'},
    ]);

    assert.equal(harness.connect('api-1', 'api-2'), true);

    assert.equal(harness.nodes.length, 4);
    assert.equal(harness.connections.some(edge => edge.from === 'out-near' && edge.to === 'api-2'), true);
    assert.equal(harness.connections.some(edge => edge.from === 'out-far' && edge.to === 'api-2'), false);
    assert.equal(harness.undoCount(), 1);
});

test('an existing API-to-Output-to-API route is not duplicated and creates no undo entry', () => {
    const harness = bridgeHarness([
        {id:'api-1', type:'generator', x:0, y:0},
        {id:'out-1', type:'output', x:450, y:0},
        {id:'api-2', type:'generator', x:1100, y:0},
    ], [
        {id:'existing-1', from:'api-1', to:'out-1'},
        {id:'existing-2', from:'out-1', to:'api-2'},
    ]);

    assert.equal(harness.connect('api-1', 'api-2'), false);
    assert.equal(harness.nodes.length, 3);
    assert.equal(harness.connections.length, 2);
    assert.equal(harness.undoCount(), 0);
});

test('non-API links keep their existing direct connection behavior', () => {
    const harness = bridgeHarness([
        {id:'prompt-1', type:'prompt', x:0, y:0},
        {id:'api-1', type:'generator', x:500, y:0},
        {id:'out-1', type:'output', x:1000, y:0},
    ], []);

    assert.equal(harness.connect('prompt-1', 'api-1'), true);
    assert.equal(harness.connect('api-1', 'out-1'), true);

    assert.equal(harness.nodes.filter(node => node.type === 'output').length, 1);
    assert.deepEqual(
        harness.connections.map(({from, to}) => [from, to]),
        [['prompt-1', 'api-1'], ['api-1', 'out-1']],
    );
    assert.equal(harness.undoCount(), 2);
});
