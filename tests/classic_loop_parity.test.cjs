const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('classic loop derives skipped, current, and next image windows from rounds', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function loopImageStartForRound', 'function loopInputImageRefs');
    const helper = new Function(`${block}; return classicLoopWindowState;`)();

    assert.deepEqual(helper(7, 2, 2), {
        total: 7,
        skippedCount: 2,
        current: {start: 3, end: 4, count: 2},
        next: {start: 5, end: 6, count: 2},
    });
    assert.deepEqual(helper(7, 4, 2), {
        total: 7,
        skippedCount: 6,
        current: {start: 7, end: 7, count: 1},
        next: null,
    });
    assert.deepEqual(helper(7, 5, 2), {
        total: 7,
        skippedCount: 7,
        current: null,
        next: null,
    });
});

test('classic loop renders bounded thumbnails and one compact two-row summary', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const body = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');

    assert.match(body, /loopPreviewImageRefs\(node\)/);
    assert.match(body, /class="loop-input-thumbs"/);
    assert.match(body, /class="loop-input-thumb[^"`]*\$\{[^}]*is-skipped/);
    assert.match(body, /class="loop-summary"/);
    assert.match(body, /class="loop-summary-row loop-summary-images"/);
    assert.match(body, /class="loop-summary-row loop-summary-prompt"/);
    assert.match(body, /classicLoopWindowState/);
    assert.doesNotMatch(body, /canvas\.loopImageWillOutput/);
    assert.doesNotMatch(body, /class="loop-prompt-hint"/);
    assert.doesNotMatch(body, /data-loop-token=/);
});

test('classic loop parity styling dims skipped thumbnails without changing media data', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    assert.match(css, /\.loop-input-thumb\.is-skipped\s*\{[^}]*opacity\s*:\s*\.3/s);
    assert.match(css, /\.loop-summary-row\s*\{[^}]*text-overflow\s*:\s*ellipsis[^}]*white-space\s*:\s*nowrap/s);
    assert.match(css, /\.loop-input-thumbs\s*\{[^}]*overflow-x\s*:\s*auto/s);
});

test('classic loop connection kinds distinguish image and prompt inputs', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicLoopConnectionKinds', 'function connectClassicNodes');
    const classify = new Function(`${block}; return classicLoopConnectionKinds;`)();
    const loop = {type:'loop'};

    assert.deepEqual(classify({type:'image'}, loop), {image:true, prompt:false});
    assert.deepEqual(classify({type:'group'}, loop), {image:true, prompt:false});
    assert.deepEqual(classify({type:'output'}, loop), {image:true, prompt:false});
    assert.deepEqual(classify({type:'prompt'}, loop), {image:false, prompt:true});
    assert.deepEqual(classify({type:'promptGroup'}, loop), {image:false, prompt:true});
    assert.deepEqual(classify({type:'llm'}, loop), {image:false, prompt:true});
    assert.deepEqual(classify({type:'generator'}, loop), {image:false, prompt:false});
    assert.deepEqual(classify({type:'image'}, {type:'llm'}), {image:false, prompt:false});
});

test('successful classic links atomically enable compatible loop switches', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const commit = sourceBlock(source, 'function connectClassicNodes', 'function canConnect');
    const drag = sourceBlock(source, 'function startLink', 'function nearestPort');
    const create = sourceBlock(source, 'function createLinkedNode', 'function createNodeByType');

    assert.match(commit, /connections\.some\([^)]*c\.from\s*===\s*fromId[^)]*c\.to\s*===\s*toId/);
    assert.match(commit, /if\(!options\.historyCaptured\)\s*pushUndo\(\)/);
    assert.match(commit, /to\.imageInput\s*=\s*true/);
    assert.match(commit, /to\.showPrompt\s*=\s*true/);
    assert.match(commit, /autoSizeLoopForPanels\(to\)/);
    assert.match(commit, /connections\.push\(\{id:uid\('c'\),\s*from:fromId,\s*to:toId\}\)/);
    assert.match(drag, /connectClassicNodes\(fromId,\s*toId\)/);
    assert.match(create, /connectClassicNodes\(fromId,\s*toId,\s*\{historyCaptured:true\}\)/);
});

test('classic loop connection commit leaves invalid and duplicate attempts unchanged', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicLoopConnectionKinds', 'function canConnect');
    const makeHarness = new Function('initialNodes', 'initialConnections', `
        let nodes = initialNodes;
        let connections = initialConnections;
        let undoCount = 0;
        let syncCount = 0;
        const pushUndo = () => { undoCount += 1; };
        const uid = () => 'new-connection';
        const syncLatestGeneratedOutputToConnection = () => { syncCount += 1; };
        const autoSizeLoopForPanels = node => { node.paritySized = true; };
        const canConnect = (fromId, toId) => Boolean(nodes.find(n => n.id === fromId) && nodes.find(n => n.id === toId));
        ${block}
        return {
            connect:connectClassicNodes,
            state:() => ({connections, undoCount, syncCount}),
        };
    `);
    const image = {id:'image-1', type:'image'};
    const loop = {id:'loop-1', type:'loop', imageInput:false, showPrompt:false, loopStart:1, imageBatchSize:2};
    const harness = makeHarness([image, loop], []);

    assert.equal(harness.connect(image.id, loop.id), true);
    assert.equal(loop.imageInput, true);
    assert.equal(loop.showPrompt, false);
    assert.equal(loop.paritySized, true);
    assert.deepEqual(harness.state(), {connections:[{id:'new-connection', from:'image-1', to:'loop-1'}], undoCount:1, syncCount:1});

    assert.equal(harness.connect(image.id, loop.id), false);
    assert.deepEqual(harness.state(), {connections:[{id:'new-connection', from:'image-1', to:'loop-1'}], undoCount:1, syncCount:1});

    const invalidLoop = {id:'loop-2', type:'loop', imageInput:false, showPrompt:false};
    const generator = {id:'generator-1', type:'generator'};
    const invalidHarness = makeHarness([generator, invalidLoop], []);
    assert.equal(invalidHarness.connect(generator.id, invalidLoop.id), false);
    assert.equal(invalidLoop.imageInput, false);
    assert.equal(invalidLoop.showPrompt, false);
    assert.deepEqual(invalidHarness.state(), {connections:[], undoCount:0, syncCount:0});

    const prompt = {id:'prompt-1', type:'prompt'};
    const promptLoop = {id:'loop-3', type:'loop', imageInput:false, showPrompt:false};
    const capturedHarness = makeHarness([prompt, promptLoop], []);
    assert.equal(capturedHarness.connect(prompt.id, promptLoop.id, {historyCaptured:true}), true);
    assert.equal(promptLoop.showPrompt, true);
    assert.equal(capturedHarness.state().undoCount, 0);
});

test('strict canConnect and switch-off cleanup remain intact', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const canConnect = sourceBlock(source, 'function canConnect', 'function sanitizeConnections');
    const body = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    assert.match(canConnect, /Boolean\(to\.imageInput\)/);
    assert.match(canConnect, /Boolean\(to\.showPrompt\)/);
    assert.match(body, /connections\s*=\s*connections\.filter\(c\s*=>\s*c\.to\s*!==\s*node\.id\s*\|\|\s*canConnect\(c\.from,\s*node\.id\)\)/);
    assert.match(body, /tr\('canvas\.loopTotalRounds'\)/);
    assert.match(i18n, /"canvas\.loopTotalRounds"/);
    assert.match(i18n, /"canvas\.loopSummaryCurrentImages"/);
    assert.match(i18n, /"canvas\.loopSummaryPrompt"/);
    assert.match(html, /canvas\.css\?v=[^"']+/);
    assert.match(html, /canvas\.js\?v=[^"']+/);
});
