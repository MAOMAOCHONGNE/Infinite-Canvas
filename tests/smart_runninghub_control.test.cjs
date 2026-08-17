const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'static', 'smart-canvas.html'), 'utf8');

function sourceBlock(start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('smart canvas loads the shared capacity queue before its controller', () => {
    const queueIndex = html.indexOf('/static/js/runninghub-capacity-queue.js');
    const canvasIndex = html.indexOf('/static/js/smart-canvas.js');
    assert.ok(queueIndex >= 0 && canvasIndex > queueIndex);
});

test('smart RunningHub submit path queues capacity errors and owns accepted tasks', () => {
    const run = sourceBlock('async function runRunningHubGeneration', 'async function runApiVideoGeneration');
    assert.match(run, /smartRunningHubCapacityQueue\.submit/);
    assert.match(run, /nodeId/);
    assert.match(run, /runKey/);
    assert.match(run, /registerSmartRunningHubTask/);
    assert.match(run, /smartRunningHubOwnerCancelled/);
    assert.match(run, /smartRunningHubTaskRegistry\.cancel/);
    assert.match(source, /async function cancelSmartRunningHubRemoteTask/);
    assert.match(run, /wakeSmartRunningHubQueue/);
});

test('smart complete-flow stop and node deletion cancel only their owned RunningHub work', () => {
    const stop = sourceBlock('function requestSmartCascadeStop', 'function smartCascadeParallelLimit');
    const deletion = sourceBlock('function deleteNode(id)', 'function clearNodeMediaBeforeDelete');
    assert.match(stop, /cancelSmartRunningHubRun\(runState\.runKey/);
    assert.match(deletion, /cancelSmartRunningHubNode\(id/);
});

test('smart direct/cascade/minimax calls propagate cancellation ownership', () => {
    const direct = sourceBlock('async function runGeneration()', 'async function runPromptLLMNode');
    const cascade = sourceBlock('async function generateUrlsForCurrentSettings', 'async function generateComfyUrlsWithSettings');
    const minimax = sourceBlock('async function runMinimaxRunningHub', 'async function runMinimaxNode');
    assert.match(direct, /runRunningHubGeneration\(prompt, refs, settings, \{nodeId:pendingNode\.id/);
    assert.match(cascade, /runRunningHubGeneration\(prompt, refs, activeSettings, runtime\)/);
    assert.match(minimax, /runRunningHubGeneration\(prompt, refs, runSettings, \{nodeId:node\.id/);
});

test('smart run button becomes cancellation action and duplicate attempts include elapsed time', () => {
    const button = sourceBlock('function syncRunButtonState', 'function mergeSmartNode');
    const run = sourceBlock('async function runGeneration()', 'async function runPromptLLMNode');
    assert.match(button, /smartRunningHubNodeHasWork/);
    assert.match(button, /square/);
    assert.match(source, /handleSmartRunButton/);
    assert.match(run, /showSmartRunningHubBusyNotice/);
    assert.match(source, /nodeRunElapsedMs/);
});

test('smart queue state participates in elapsed display without realtime percentage', () => {
    const timer = sourceBlock('function runTimePillHtml', 'function hideRunTimerForNode');
    assert.match(timer, /node\.queued/);
    assert.doesNotMatch(source, /trackProgress|runningHubNodeProgress|rhProgress/);
});
