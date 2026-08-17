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

function queueHarness(responses){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function runningHubQueueMaxedPayload', 'const runningHubRunStartedAt');
    const nodes = [
        {id:'rh-1', type:'rh', running:true, runStatus:'running', runError:''},
        {id:'rh-2', type:'rh', running:true, runStatus:'running', runError:''},
    ];
    const calls = [];
    const statuses = [];
    const fakeFetch = async (input, init={}) => {
        calls.push({input, init});
        const item = responses.shift();
        if(!item) throw new Error('unexpected fetch');
        return {
            ok:item.ok !== false,
            async json(){ return item.body; },
        };
    };
    const api = new Function(
        'nodes', 'fetch', 'cascadeFetch', 'apiErrorMessage', 'tr', 'langIsEn', 'refreshNodes', 'setStatus',
        'cascadeTargetIdFromOptions', 'ensureCascadeActive', 'isCascadeStopping',
        'cascadeAbortError', 'cascadeStopMessage', 'showErrorModal',
        `${block}\nreturn { runningHubQueueMaxedPayload, submitRunningHubWithFallback, runningHubQueuePositionForNode, runningHubQueueButtonLabel, cancelRunningHubQueuedNode, wakeRunningHubSubmitQueue, queue:runningHubSubmitQueue };`,
    )(
        nodes,
        fakeFetch,
        fakeFetch,
        data => data?.detail?.message || data?.detail || data?.message || 'RunningHub failed',
        key => ({
            'canvas.rhFailed':'RunningHub 任务失败',
            'canvas.rhQueued':'排队中',
            'canvas.rhQueuePosition':'排队中 · 第{position}位',
            'canvas.rhQueuedNotice':'RunningHub 当前繁忙，本任务已自动加入队列。',
        }[key] || key),
        () => false,
        () => {},
        message => statuses.push(message),
        options => String(options?.cascadeTargetId || ''),
        () => {},
        () => false,
        message => Object.assign(new Error(message), {isCascadeAbort:true}),
        () => '已停止一键运行',
        () => {},
    );
    return {api, nodes, calls, statuses};
}

function tick(){
    return new Promise(resolve => setImmediate(resolve));
}

test('queue-max detection recognizes only the explicit RunningHub capacity token', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function runningHubQueueMaxedPayload', 'function runningHubQueueCancelledError');
    const detect = new Function(`${block}\nreturn runningHubQueueMaxedPayload;`)();

    assert.equal(detect({detail:{message:'TASK_QUEUE_MAXED', raw:{msg:'queue full'}}}), true);
    assert.equal(detect({detail:{raw:{errorCode:'TASK_QUEUE_MAXED'}}}), true);
    assert.equal(detect({detail:{message:'余额不足'}}), false);
    assert.equal(detect({detail:{message:'NOT_TASK_QUEUE_MAXED_RETRY'}}), false);
});

test('accepted RunningHub submissions preserve provider concurrency and never enter the fallback queue', async () => {
    const {api, nodes, calls} = queueHarness([
        {body:{success:true, data:{taskId:'accepted-1'}}},
    ]);

    const result = await api.submitRunningHubWithFallback('/submit', {value:1}, {node:nodes[0]});

    assert.equal(result.taskId, 'accepted-1');
    assert.equal(calls.length, 1);
    assert.equal(api.queue.length, 0);
    assert.equal(nodes[0].runStatus, 'running');
});

test('TASK_QUEUE_MAXED becomes a neutral FIFO wait and retries after capacity wake-up', async () => {
    const {api, nodes, calls, statuses} = queueHarness([
        {ok:false, body:{detail:{message:'TASK_QUEUE_MAXED', raw:{msg:'TASK_QUEUE_MAXED'}}}},
        {body:{success:true, data:{taskId:'accepted-after-wait'}}},
    ]);

    const pending = api.submitRunningHubWithFallback('/submit', {value:2}, {node:nodes[0]});
    await tick();

    assert.equal(calls.length, 1);
    assert.equal(api.queue.length, 1);
    assert.equal(nodes[0].runStatus, 'queued');
    assert.equal(api.runningHubQueuePositionForNode(nodes[0].id), 1);
    assert.match(api.runningHubQueueButtonLabel(nodes[0]), /排队中/);
    assert.match(statuses.join('\n'), /自动加入队列/);
    assert.doesNotMatch(statuses.join('\n'), /升级|会员|Plus/i);

    api.wakeRunningHubSubmitQueue();
    const result = await pending;

    assert.equal(result.taskId, 'accepted-after-wait');
    assert.equal(calls.length, 2);
    assert.equal(api.queue.length, 0);
    assert.equal(nodes[0].runStatus, 'running');
});

test('deleting a queued node cancels its local wait without another provider submission', async () => {
    const {api, nodes, calls} = queueHarness([
        {ok:false, body:{detail:{message:'TASK_QUEUE_MAXED'}}},
    ]);

    const pending = api.submitRunningHubWithFallback('/submit', {value:3}, {node:nodes[1]});
    await tick();
    api.cancelRunningHubQueuedNode(nodes[1].id);

    await assert.rejects(pending, error => error?.runningHubQueueCancelled === true);
    assert.equal(calls.length, 1);
    assert.equal(api.queue.length, 0);
});

test('classic RunningHub UI and execution path use the fallback queue without upgrade copy', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const render = sourceBlock(source, 'function renderRhBody', 'function rhModelSettingsHtml');
    const run = sourceBlock(source, 'async function runRhNode', 'async function runRhModelNode');
    const stop = sourceBlock(source, 'function requestCascadeStop', 'function ensureCascadeActive');
    const deletion = sourceBlock(source, 'function deleteNode(id, event)', 'function clearNodeContentBeforeDelete');

    assert.match(render, /canvas\.rhCancel/);
    assert.match(render, /requestRunningHubNodeCancel\(node\.id\)/);
    assert.match(run, /submitRunningHubWithFallback\(endpoint, body/);
    assert.match(run, /node\.runStatus\s*=\s*'running'/);
    assert.match(run, /wakeRunningHubSubmitQueue\(\)/);
    assert.match(stop, /wakeRunningHubSubmitQueue\(\)/);
    assert.match(deletion, /cancelRunningHubQueuedNode\(id\)/);
    assert.doesNotMatch(source, /升级基础版|升级.*Plus|会员即可同时运行/);
});
