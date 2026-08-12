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

test('a fresh classic loop always renders a neutral input port', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, "const canInput =", "const canOutput =");

    assert.match(block, /\|\|\s*node\.type\s*===\s*['"]loop['"]/);
    assert.doesNotMatch(block, /node\.imageInput\s*\|\|\s*node\.showPrompt/);
});

test('prompt dependency lookup includes direct and prompt-group classic loop links', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicLoopIdsForPromptNode', 'function refreshClassicLoopPromptView');
    const lookup = new Function(`${block}; return classicLoopIdsForPromptNode;`)();
    const allNodes = [
        {id:'prompt-1', type:'prompt'},
        {id:'prompt-2', type:'prompt'},
        {id:'prompt-group-1', type:'promptGroup', items:['prompt-2']},
        {id:'loop-direct', type:'loop'},
        {id:'loop-group', type:'loop'},
        {id:'generator-1', type:'generator'},
    ];
    const allConnections = [
        {from:'prompt-1', to:'loop-direct'},
        {from:'prompt-group-1', to:'loop-group'},
        {from:'prompt-1', to:'generator-1'},
    ];

    assert.deepEqual(lookup('prompt-1', allNodes, allConnections), ['loop-direct']);
    assert.deepEqual(lookup('prompt-2', allNodes, allConnections), ['loop-group']);
});

test('debounced prompt editing targets loop summary DOM without rebuilding loop nodes', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const schedule = sourceBlock(source, 'let generatorInputSyncTimer', 'function refreshGeneratorInputViews');
    const refresh = sourceBlock(source, 'function refreshClassicLoopPromptView', 'let generatorInputSyncTimer');
    const promptRender = sourceBlock(source, "if(node.type === 'prompt')", "if(node.type === 'loop')");

    assert.match(promptRender, /scheduleGeneratorInputSync\(node\.id\)/);
    assert.match(schedule, /pendingClassicLoopPromptSourceIds/);
    assert.match(schedule, /refreshClassicLoopPromptView/);
    assert.match(refresh, /\.loop-summary-prompt/);
    assert.doesNotMatch(refresh, /refreshNodes\s*\(/);
    assert.doesNotMatch(refresh, /\brender\s*\(/);
});
