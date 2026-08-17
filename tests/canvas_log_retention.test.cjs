const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLASSIC_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const SMART_PATH = path.join(ROOT, 'static', 'js', 'smart-canvas.js');
const MAIN_PATH = path.join(ROOT, 'main.py');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function classicLogHarness(){
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    const block = sourceBlock(source, 'function addGenerationLog', 'function renderCanvasLog');
    const state = {canvas:{logs:[]}, nextId:0, completionSounds:0};
    const addLog = new Function(
        'state', 'outputUrlValue', 'playGenerationCompleteSound', 'runPlatformLabel', 'runTaskLabel',
        `let canvas = state.canvas;
         const uid = () => 'log-' + (++state.nextId);
         ${block}
         return addGenerationLog;`,
    )(
        state,
        item => typeof item === 'string' ? item : item?.url || '',
        () => { state.completionSounds += 1; },
        () => 'API',
        () => 'model',
    );
    return {state, addLog};
}

function smartLogHarness(){
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const block = sourceBlock(source, 'function addSmartGenerationLog', 'const SMART_LOG_PREVIEW_NODE_ID');
    const state = {canvas:{logs:[]}, nextId:0, completionSounds:0, saves:0};
    const addLog = new Function(
        'state', 'resultMediaUrls', 'copyMediaSizeFields', 'playGenerationCompleteSound',
        'smartRunPlatformLabel', 'smartRunTaskLabel', 'smartRunRequestMeta',
        'recoverStuckLoopOutputsFromLogs', 'render', 'scheduleSave',
        `let canvas = state.canvas;
         const uid = () => 'smart-log-' + (++state.nextId);
         ${block}
         return addSmartGenerationLog;`,
    )(
        state,
        outputs => outputs,
        (_source, target) => target,
        () => { state.completionSounds += 1; },
        () => 'API',
        () => 'model',
        () => ({}),
        () => false,
        () => {},
        () => { state.saves += 1; },
    );
    return {state, addLog};
}

function addMixedLogs(addLog, count){
    for(let index = 1; index <= count; index++){
        const failed = index % 2 === 0;
        addLog({
            run:{prompt:`prompt-${index}`},
            outputs:failed ? [] : [`/output/${index}.png`],
            runMs:index,
            error:failed ? `failed-${index}` : '',
        });
    }
}

test('classic canvas keeps the newest 500 successful and failed generation logs', () => {
    const {state, addLog} = classicLogHarness();
    addMixedLogs(addLog, 501);

    assert.equal(state.canvas.logs.length, 500);
    assert.equal(state.canvas.logs[0].id, 'log-501');
    assert.equal(state.canvas.logs.at(-1).id, 'log-2');
    assert.equal(state.canvas.logs.some(log => log.id === 'log-1'), false);
    assert.deepEqual(new Set(state.canvas.logs.map(log => log.status)), new Set(['success', 'failed']));
});

test('smart canvas keeps the newest 500 successful and failed generation logs', () => {
    const {state, addLog} = smartLogHarness();
    addMixedLogs(addLog, 501);

    assert.equal(state.canvas.logs.length, 500);
    assert.equal(state.canvas.logs[0].id, 'smart-log-501');
    assert.equal(state.canvas.logs.at(-1).id, 'smart-log-2');
    assert.equal(state.canvas.logs.some(log => log.id === 'smart-log-1'), false);
    assert.deepEqual(new Set(state.canvas.logs.map(log => log.status)), new Set(['success', 'failed']));
    assert.equal(state.saves, 501);
});

test('generation log interfaces remain read-only and expose no media deletion contract', () => {
    const classic = fs.readFileSync(CLASSIC_PATH, 'utf8');
    const smart = fs.readFileSync(SMART_PATH, 'utf8');
    const backend = fs.readFileSync(MAIN_PATH, 'utf8');
    const classicRender = sourceBlock(classic, 'function renderCanvasLog', 'async function importWorkflowAssetUrl');
    const smartRender = sourceBlock(smart, 'function renderSmartCanvasLog', 'function openSmartCanvasLog');

    assert.doesNotMatch(classicRender, /data-log-delete|deleteCanvasLogEntry|logs\/delete/);
    assert.doesNotMatch(smartRender, /data-log-delete|deleteSmartCanvasLogEntry|logs\/delete/);
    assert.doesNotMatch(backend, /DeleteCanvasLogRequest|\/logs\/delete/);
});
