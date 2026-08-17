const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ONLINE_PATH = path.join(ROOT, 'static', 'online.html');
const CANVAS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('online RunningHub renders reference inputs from enabled image fields instead of fixed slots', () => {
    const source = fs.readFileSync(ONLINE_PATH, 'utf8');

    assert.match(source, /id="referenceGrid"/);
    assert.match(source, /function runningHubImageFields/);
    assert.match(source, /function referenceDescriptors/);
    assert.match(source, /function renderReferenceInputs/);
    assert.doesNotMatch(source, /id="drop-zone-3"/);
});

test('online reference state is entry scoped and submits only current visible slots', () => {
    const source = fs.readFileSync(ONLINE_PATH, 'utf8');
    const submit = sourceBlock(source, 'async function submitImage', 'function renderImageCard');

    assert.match(source, /referenceStatesByContext/);
    assert.match(source, /function referenceContextKey/);
    assert.match(source, /function currentReferencePayload/);
    assert.match(source, /uploadVersion/);
    assert.match(submit, /currentReferencePayload\(\)/);
    assert.doesNotMatch(submit, /Object\.values\(refs\)/);
});

test('online generation exposes upload and elapsed busy feedback with readable API errors', () => {
    const source = fs.readFileSync(ONLINE_PATH, 'utf8');
    const submit = sourceBlock(source, 'async function submitImage', 'function renderImageCard');

    assert.match(source, /function apiErrorMessage/);
    assert.match(source, /function responseErrorMessage/);
    assert.match(source, /function formatElapsed/);
    assert.match(source, /generationState\.running/);
    assert.match(source, /online\.alreadyGenerating/);
    assert.match(source, /online\.imagesUploading/);
    assert.match(submit, /setGenerationRunning\(true\)/);
    assert.match(submit, /setGenerationRunning\(false\)/);
    assert.doesNotMatch(submit, /btn\.disabled\s*=\s*true/);
    assert.doesNotMatch(submit, /new Error\(\(await r\.json\(\)\)\.detail/);
});

test('classic RunningHub repeat runs and structured failures are user-readable', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const queue = sourceBlock(source, 'function runningHubQueueMaxedPayload', 'const runningHubRunStartedAt');
    const run = sourceBlock(source, 'async function runRhNode', 'async function runRhModelNode');
    const modelRun = sourceBlock(source, 'async function runRhModelNode', 'function renderComfySettings');

    assert.match(run, /showRunningHubBusyNotice/);
    assert.match(modelRun, /showRunningHubBusyNotice/);
    assert.match(queue, /apiErrorMessage\(data,/);
    assert.match(run, /submitRunningHubWithFallback/);
    assert.match(run, /apiErrorMessage\(json,/);
    assert.doesNotMatch(run, /new Error\(data\.detail \|\| data\.error/);
    assert.doesNotMatch(run, /alert\(err\.message \|\| tr\('canvas\.rhFailed'\)\)/);
});
