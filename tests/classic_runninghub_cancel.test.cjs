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

function response(body, ok=true){
    return {ok, async json(){ return body; }};
}

function cancelHarness(fetchImpl, options={}){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function runningHubQueueMaxedPayload', 'const runningHubRunStartedAt');
    const nodes = options.nodes || [
        {id:'rh-1', type:'rh', running:true, runStatus:'running', runError:''},
        {id:'rh-2', type:'rh', running:true, runStatus:'running', runError:''},
    ];
    const notices = [];
    const stopping = new Set(options.stopping || []);
    const api = new Function(
        'nodes', 'fetch', 'apiErrorMessage', 'tr', 'langIsEn', 'refreshNodes', 'setStatus',
        'cascadeTargetIdFromOptions', 'ensureCascadeActive', 'isCascadeStopping',
        'cascadeAbortError', 'cascadeStopMessage', 'showErrorModal',
        `${block}\nreturn {
            submitRunningHubWithFallback, requestRunningHubNodeCancel,
            registerRunningHubActiveTask, unregisterRunningHubActiveTask,
            runningHubTasksForNode, runningHubTasksForCascade,
            cancelRunningHubTasksForNode, cancelRunningHubTasksForCascade,
            cancelRunningHubQueuedNode, cancelRunningHubQueuedCascade,
            wakeRunningHubSubmitQueue,
            runningHubNodeCancelRequests, runningHubActiveTasks, runningHubCancelPromises,
            isRunningHubTaskCancelledError, queue:runningHubSubmitQueue
        };`,
    )(
        nodes,
        fetchImpl,
        data => data?.detail?.message || data?.detail || data?.message || 'RunningHub failed',
        key => ({
            'canvas.rhFailed':'RunningHub 任务失败',
            'canvas.rhQueued':'排队中',
            'canvas.rhQueuePosition':'排队中 · 第{position}位',
            'canvas.rhQueuedNotice':'RunningHub 当前繁忙，本任务已自动加入队列。',
            'canvas.rhCancelFailed':'RunningHub 远程取消失败',
        }[key] || key),
        () => false,
        () => {},
        () => {},
        value => String(value?.cascadeTargetId || ''),
        targetId => {
            if(stopping.has(targetId)) throw Object.assign(new Error('stopped'), {isCascadeAbort:true});
        },
        targetId => stopping.has(targetId),
        message => Object.assign(new Error(message), {isCascadeAbort:true}),
        () => '已停止一键运行',
        (message, title) => notices.push({message, title}),
    );
    return {api, nodes, notices, stopping};
}

function tick(){
    return new Promise(resolve => setImmediate(resolve));
}

test('accepted direct task is registered and cancelled through the backend exactly once', async () => {
    const calls = [];
    const harness = cancelHarness(async (input, init={}) => {
        calls.push({input, init});
        if(input === '/submit') return response({success:true, data:{taskId:'remote-1'}});
        if(input === '/api/runninghub/cancel') return response({success:true, data:{status:'cancelled'}});
        throw new Error(`unexpected fetch ${input}`);
    });

    const submit = await harness.api.submitRunningHubWithFallback(
        '/submit',
        {useWallet:true},
        {node:harness.nodes[0], mode:'app', useWallet:true},
    );
    assert.equal(submit.taskId, 'remote-1');
    assert.equal(harness.api.runningHubTasksForNode('rh-1').length, 1);

    await harness.api.requestRunningHubNodeCancel('rh-1');
    await harness.api.cancelRunningHubTasksForNode('rh-1');

    const cancelCalls = calls.filter(call => call.input === '/api/runninghub/cancel');
    assert.equal(cancelCalls.length, 1);
    assert.deepEqual(JSON.parse(cancelCalls[0].init.body), {taskId:'remote-1', useWallet:true});
    assert.equal(harness.nodes[0].runStatus, 'stopping');
});

test('locally queued task is removed without calling the remote cancel endpoint', async () => {
    const calls = [];
    const harness = cancelHarness(async (input, init={}) => {
        calls.push({input, init});
        if(input === '/submit') return response({detail:{message:'TASK_QUEUE_MAXED'}}, false);
        if(input === '/api/runninghub/cancel') throw new Error('remote cancel must not run');
        throw new Error(`unexpected fetch ${input}`);
    });

    const pending = harness.api.submitRunningHubWithFallback('/submit', {}, {node:harness.nodes[0]});
    await tick();
    await harness.api.requestRunningHubNodeCancel('rh-1');

    await assert.rejects(pending, error => error?.runningHubQueueCancelled === true);
    assert.equal(harness.api.queue.length, 0);
    assert.equal(calls.filter(call => call.input === '/api/runninghub/cancel').length, 0);
});

test('cascade cancellation targets only tasks belonging to that cascade', async () => {
    const cancelled = [];
    const harness = cancelHarness(async (input, init={}) => {
        if(input !== '/api/runninghub/cancel') throw new Error(`unexpected fetch ${input}`);
        cancelled.push(JSON.parse(init.body).taskId);
        return response({success:true, data:{status:'cancelled'}});
    });
    harness.api.registerRunningHubActiveTask('task-a', {nodeId:'rh-1', cascadeTargetId:'flow-a'});
    harness.api.registerRunningHubActiveTask('task-b', {nodeId:'rh-2', cascadeTargetId:'flow-b'});

    await harness.api.cancelRunningHubTasksForCascade('flow-a');

    assert.deepEqual(cancelled, ['task-a']);
    assert.equal(harness.api.runningHubTasksForCascade('flow-b').length, 1);
});

test('stop during submission waits for taskId and then remotely cancels it', async () => {
    let resolveSubmit;
    const calls = [];
    const harness = cancelHarness(async (input, init={}) => {
        calls.push({input, init});
        if(input === '/submit'){
            return new Promise(resolve => { resolveSubmit = resolve; });
        }
        if(input === '/api/runninghub/cancel') return response({success:true, data:{status:'cancelled'}});
        throw new Error(`unexpected fetch ${input}`);
    });

    const pending = harness.api.submitRunningHubWithFallback('/submit', {}, {node:harness.nodes[0], mode:'workflow'});
    await tick();
    await harness.api.requestRunningHubNodeCancel('rh-1');
    resolveSubmit(response({success:true, data:{taskId:'late-task'}}));

    await assert.rejects(pending, error => harness.api.isRunningHubTaskCancelledError(error));
    assert.equal(calls.filter(call => call.input === '/api/runninghub/cancel').length, 1);
    assert.equal(harness.api.runningHubActiveTasks.size, 0);
});

test('stop during queued retry preserves task ownership and does not remove the next queued task', async () => {
    let resolveRetry;
    const calls = [];
    const harness = cancelHarness(async (input, init={}) => {
        calls.push({input, init});
        if(input === '/submit-1' && calls.filter(call => call.input === input).length === 1){
            return response({detail:{message:'TASK_QUEUE_MAXED'}}, false);
        }
        if(input === '/submit-2') return response({detail:{message:'TASK_QUEUE_MAXED'}}, false);
        if(input === '/submit-1') return new Promise(resolve => { resolveRetry = resolve; });
        if(input === '/api/runninghub/cancel') return response({success:true, data:{status:'cancelled'}});
        throw new Error(`unexpected fetch ${input}`);
    });

    const first = harness.api.submitRunningHubWithFallback(
        '/submit-1',
        {useWallet:true},
        {node:harness.nodes[0], mode:'workflow', useWallet:true},
    ).catch(error => error);
    const second = harness.api.submitRunningHubWithFallback(
        '/submit-2',
        {},
        {node:harness.nodes[1], mode:'app'},
    ).catch(error => error);
    await tick();
    assert.equal(harness.api.queue.length, 2);

    harness.api.wakeRunningHubSubmitQueue();
    for(let i = 0; i < 4 && !resolveRetry; i++) await tick();
    assert.equal(typeof resolveRetry, 'function');

    await harness.api.requestRunningHubNodeCancel('rh-1');
    resolveRetry(response({success:true, data:{taskId:'queued-late-task'}}));
    const firstError = await first;
    for(let i = 0; i < 4; i++) await tick();

    assert.equal(firstError?.runningHubQueueCancelled, true);
    const cancelCalls = calls.filter(call => call.input === '/api/runninghub/cancel');
    assert.equal(cancelCalls.length, 1);
    assert.deepEqual(JSON.parse(cancelCalls[0].init.body), {taskId:'queued-late-task', useWallet:true});
    assert.equal(harness.api.queue.length, 1);
    assert.equal(harness.api.queue[0].nodeId, 'rh-2');

    harness.api.cancelRunningHubQueuedNode('rh-2');
    const secondError = await second;
    assert.equal(secondError?.runningHubQueueCancelled, true);
});

test('remote cancellation failure stops local state and shows one clear warning', async () => {
    const harness = cancelHarness(async input => {
        if(input === '/submit') return response({success:true, data:{taskId:'remote-fail'}});
        if(input === '/api/runninghub/cancel') return response({detail:{message:'CANCEL_NOT_ALLOWED'}}, false);
        throw new Error(`unexpected fetch ${input}`);
    });
    await harness.api.submitRunningHubWithFallback('/submit', {}, {node:harness.nodes[0]});

    const result = await harness.api.requestRunningHubNodeCancel('rh-1');

    assert.equal(result.failed, 1);
    assert.equal(harness.nodes[0].runStatus, 'stopping');
    assert.equal(harness.notices.length, 1);
    assert.match(harness.notices[0].message, /官网任务可能仍在运行/);
});

test('classic canvas wires direct, cascade, deletion and model-mode cancellation safely', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const render = sourceBlock(source, 'function renderRhBody', 'function rhModelSettingsHtml');
    const miniMax = sourceBlock(source, 'async function runMiniMaxNode', 'async function uploadCanvasUrlToComfy');
    const cascadeStop = sourceBlock(source, 'function requestCascadeStop', 'function ensureCascadeActive');
    const deletion = sourceBlock(source, 'function deleteNode(id, event)', 'function clearNodeContentBeforeDelete');

    assert.match(render, /mode !== 'model'/);
    assert.match(render, /requestRunningHubNodeCancel\(node\.id\)/);
    assert.equal((miniMax.match(/runningHubNodeCancelRequests\.delete\(node\.id\)/g) || []).length, 2);
    assert.match(cascadeStop, /cancelRunningHubQueuedCascade\(targetId\)/);
    assert.match(cascadeStop, /cancelRunningHubTasksForCascade\(targetId\)/);
    assert.match(deletion, /requestRunningHubNodeCancel\(id/);
});
