const assert = require('node:assert/strict');
const test = require('node:test');

const {
    RunningHubCapacityQueue,
    RunningHubQueueCancelledError,
    RunningHubTaskRegistry,
    isRunningHubQueueMaxed,
} = require('../static/js/runninghub-capacity-queue.js');

function tick(){
    return new Promise(resolve => setImmediate(resolve));
}

test('shared queue recognizes only the exact nested capacity token', () => {
    assert.equal(isRunningHubQueueMaxed({detail:{raw:{errorCode:'TASK_QUEUE_MAXED'}}}), true);
    assert.equal(isRunningHubQueueMaxed(new Error('RunningHub: TASK_QUEUE_MAXED')), true);
    assert.equal(isRunningHubQueueMaxed({message:'NOT_TASK_QUEUE_MAXED_RETRY'}), false);
    assert.equal(isRunningHubQueueMaxed({message:'余额不足'}), false);
});

test('accepted submissions keep provider concurrency and bypass local waiting', async () => {
    const states = [];
    const queue = new RunningHubCapacityQueue({retryDelay:60_000});
    const first = await queue.submit(async () => ({taskId:'one'}), {onState:state => states.push(state)});
    const second = await queue.submit(async () => ({taskId:'two'}), {onState:state => states.push(state)});

    assert.equal(first.taskId, 'one');
    assert.equal(second.taskId, 'two');
    assert.equal(queue.size, 0);
    assert.deepEqual(states, ['submitting', 'accepted', 'submitting', 'accepted']);
});

test('capacity rejection enters FIFO and retries only the head on wake', async () => {
    const attempts = [];
    const queue = new RunningHubCapacityQueue({retryDelay:60_000});
    let firstAttempt = 0;
    let secondAttempt = 0;
    const first = queue.submit(async () => {
        attempts.push('first');
        if(firstAttempt++ === 0) throw Object.assign(new Error('capacity'), {payload:{code:'TASK_QUEUE_MAXED'}});
        return {taskId:'first-ok'};
    }, {id:'first'});
    const second = queue.submit(async () => {
        attempts.push('second');
        if(secondAttempt++ === 0) throw Object.assign(new Error('capacity'), {payload:{message:'TASK_QUEUE_MAXED'}});
        return {taskId:'second-ok'};
    }, {id:'second'});
    await tick();

    assert.equal(queue.size, 2);
    assert.equal(queue.position(entry => entry.id === 'first'), 1);
    assert.equal(queue.position(entry => entry.id === 'second'), 2);

    queue.wake();
    assert.equal((await first).taskId, 'first-ok');
    assert.equal(queue.size, 1);
    assert.deepEqual(attempts, ['first', 'second', 'first']);

    queue.wake();
    assert.equal((await second).taskId, 'second-ok');
    assert.equal(queue.size, 0);
});

test('queued cancellation never submits again and rejects with a typed error', async () => {
    let attempts = 0;
    const queue = new RunningHubCapacityQueue({retryDelay:60_000});
    const pending = queue.submit(async () => {
        attempts += 1;
        throw Object.assign(new Error('capacity'), {payload:{message:'TASK_QUEUE_MAXED'}});
    }, {id:'cancel-me'});
    await tick();

    assert.equal(queue.cancel(entry => entry.id === 'cancel-me'), 1);
    await assert.rejects(pending, error => error instanceof RunningHubQueueCancelledError);
    queue.wake();
    await tick();
    assert.equal(attempts, 1);
});

test('timer callbacks are invoked as plain functions for browser native compatibility', async () => {
    let scheduled = 0;
    const strictSetTimeout = function(){
        'use strict';
        assert.equal(this, undefined);
        scheduled += 1;
        return {unref(){}};
    };
    const queue = new RunningHubCapacityQueue({setTimeoutFn:strictSetTimeout, clearTimeoutFn:()=>{}});
    const pending = queue.submit(async () => {
        throw Object.assign(new Error('capacity'), {payload:{message:'TASK_QUEUE_MAXED'}});
    }, {id:'browser-timer'});
    await tick();

    assert.equal(scheduled, 1);
    queue.cancel(entry => entry.id === 'browser-timer');
    await assert.rejects(pending, error => error instanceof RunningHubQueueCancelledError);
});

test('task registry cancels only the requested owner and deduplicates remote cancellation', async () => {
    const remote = [];
    const registry = new RunningHubTaskRegistry(async task => {
        remote.push(task.taskId);
        await tick();
        return {success:true};
    });
    registry.register('flow-a-1', {nodeId:'node-a', runKey:'flow-a'});
    registry.register('flow-a-2', {nodeId:'node-b', runKey:'flow-a'});
    registry.register('flow-b-1', {nodeId:'node-c', runKey:'flow-b'});

    const first = registry.cancel(task => task.runKey === 'flow-a');
    const second = registry.cancel(task => task.nodeId === 'node-a');
    const [flowResult, nodeResult] = await Promise.all([first, second]);

    assert.equal(flowResult.attempted, 2);
    assert.equal(nodeResult.attempted, 1);
    assert.deepEqual(remote.sort(), ['flow-a-1', 'flow-a-2']);
    assert.equal(registry.list(task => task.runKey === 'flow-b').length, 1);
});
