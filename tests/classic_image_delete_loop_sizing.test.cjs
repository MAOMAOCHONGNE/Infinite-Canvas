const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function deletionHarness(initialNodes, initialConnections, selectedIds=[]){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function removeClassicConnections(shouldRemove)', 'function deleteConnection');
    return new Function('initialNodes', 'initialConnections', 'selectedIds', `
        let nodes = structuredClone(initialNodes);
        let connections = structuredClone(initialConnections);
        const selected = new Set(selectedIds);
        let undoCount = 0;
        let renderCount = 0;
        let refreshCount = 0;
        let saveCount = 0;
        const pushUndo = () => { undoCount += 1; };
        const destroyLTXEditor = () => {};
        const isCanvasFrameNode = node => node?.type === 'canvas-frame';
        const render = () => { renderCount += 1; };
        const refreshNodes = () => { refreshCount += 1; };
        const scheduleSave = () => { saveCount += 1; };
        const tr = key => key;
        const window = {ClassicCascadePlan:null};
        ${block}
        return {
            close:id => deleteNodeFromButton(id, {preventDefault(){}, stopPropagation(){}}),
            state:() => ({nodes, connections, selected:[...selected], undoCount, renderCount, refreshCount, saveCount}),
        };
    `)(initialNodes, initialConnections, selectedIds);
}

test('ordinary IMAGE header close removes the complete node and its connections', () => {
    const harness = deletionHarness([
        {id:'image-1', type:'image', url:'/assets/example.png', name:'example.png'},
        {id:'generator-1', type:'generator'},
        {id:'frame-1', type:'canvas-frame', items:['image-1', 'generator-1']},
    ], [
        {id:'connection-1', from:'image-1', to:'generator-1'},
    ], ['image-1']);

    harness.close('image-1');
    const state = harness.state();

    assert.deepEqual(state.nodes.map(node => node.id), ['generator-1', 'frame-1']);
    assert.deepEqual(state.nodes.find(node => node.id === 'frame-1').items, ['generator-1']);
    assert.deepEqual(state.connections, []);
    assert.deepEqual(state.selected, []);
    assert.equal(state.undoCount, 1);
    assert.equal(state.renderCount, 1);
    assert.equal(state.refreshCount, 0);
    assert.equal(state.saveCount, 1);
});

test('Output header close keeps its node while clearing generated results', () => {
    const harness = deletionHarness([
        {id:'output-1', type:'output', images:['a.png'], _pending:[{id:'pending-1'}], imageComparisons:{'a.png':{originalUrl:'source.png'}}},
        {id:'generator-1', type:'generator'},
    ], [
        {id:'connection-1', from:'generator-1', to:'output-1'},
    ], ['output-1']);

    harness.close('output-1');
    const state = harness.state();
    const output = state.nodes.find(node => node.id === 'output-1');

    assert.ok(output);
    assert.deepEqual(output.images, []);
    assert.deepEqual(output._pending, []);
    assert.deepEqual(output.imageComparisons, {});
    assert.equal(state.connections.length, 1);
    assert.deepEqual(state.selected, ['output-1']);
    assert.equal(state.undoCount, 1);
    assert.equal(state.renderCount, 0);
    assert.equal(state.refreshCount, 1);
    assert.equal(state.saveCount, 1);
});

test('classic loop auto-sizing raises undersized cards without shrinking larger manual sizes', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function autoSizeLoopForPanels(node)', 'function loopTokenChipHtml');
    const autoSize = new Function('classicLoopPromptFieldValues', `${block}; return autoSizeLoopForPanels;`)(
        node => Array.from({length:node.promptRows || 1}, (_, index) => `prompt-${index + 1}`),
    );

    const promptOnly = {showPrompt:true, imageInput:false, promptRows:1, h:360};
    autoSize(promptOnly);
    assert.equal(promptOnly.h, 410);

    const threePrompts = {showPrompt:true, imageInput:false, promptRows:3, h:380};
    autoSize(threePrompts);
    assert.equal(threePrompts.h, 526);

    const manuallyEnlarged = {showPrompt:true, imageInput:false, promptRows:1, h:680};
    autoSize(manuallyEnlarged);
    assert.equal(manuallyEnlarged.h, 680);

    const imagesAndPrompt = {showPrompt:true, imageInput:true, promptRows:1, h:500};
    autoSize(imagesAndPrompt);
    assert.equal(imagesAndPrompt.h, 530);

    const manyPrompts = {showPrompt:true, imageInput:true, promptRows:20, h:500};
    autoSize(manyPrompts);
    assert.equal(manyPrompts.h, 720);

    const closed = {showPrompt:false, imageInput:false, h:530};
    autoSize(closed);
    assert.equal(Object.hasOwn(closed, 'h'), false);
});

test('restored open loop is normalized before renderNode reads its fixed height', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const renderStart = sourceBlock(source, 'function renderNode(node)', 'el.className =');
    const normalizeAt = renderStart.indexOf('autoSizeLoopForPanels(node)');
    const fixedSizeAt = renderStart.indexOf('const hasFixedSize');

    assert.ok(normalizeAt >= 0, 'open loop layout must be normalized during render');
    assert.ok(normalizeAt < fixedSizeAt, 'loop minimum height must be applied before fixed-size layout is read');
});
