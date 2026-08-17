const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static', 'online.html'), 'utf8');

function sourceBlock(start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('online page loads shared capacity queue before its inline controller', () => {
    const queue = source.indexOf('/static/js/runninghub-capacity-queue.js');
    const controller = source.indexOf('const generationState');
    assert.ok(queue >= 0 && controller > queue);
});

test('online RunningHub entries use operation submit/query/cancel endpoints', () => {
    const submit = sourceBlock('async function submitImage', 'function renderImageCard');
    assert.match(source, /function isRunningHubEntryMode/);
    assert.match(source, /submitOnlineRunningHubOperation/);
    assert.match(source, /queryOnlineRunningHubOperation/);
    assert.match(source, /cancelOnlineRunningHubOperation/);
    assert.match(source, /\/api\/online-runninghub\/submit/);
    assert.match(source, /\/api\/online-runninghub\/query/);
    assert.match(source, /\/api\/online-runninghub\/cancel/);
    assert.match(submit, /isRunningHubEntryMode\(\)/);
});

test('online capacity rejection enters a neutral queue and retries the same operation id', () => {
    assert.match(source, /onlineRunningHubCapacityQueue\.submit/);
    assert.match(source, /operationId/);
    assert.match(source, /排队中/);
    assert.doesNotMatch(source, /升级基础版|升级.*Plus|会员即可同时运行/);
});

test('online Generate button becomes explicit cancellation while RunningHub is active', () => {
    const status = sourceBlock('function updateGenerationStatus', 'function setGenerationControlsLocked');
    const submit = sourceBlock('async function submitImage', 'function renderImageCard');
    assert.match(status, /取消任务/);
    assert.match(source, /generationState\.runningHubOperationId/);
    assert.match(submit, /cancelOnlineRunningHubOperation/);
    assert.match(source, /runningElapsed\(\)/);
});

test('online entry mode has no realtime percentage contract', () => {
    assert.doesNotMatch(source, /trackProgress|runningHubNodeProgress|rhProgress/);
});
