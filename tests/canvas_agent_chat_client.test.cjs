const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createCanvasAgentContextRequester,
    createCanvasAgentWorkspaceState,
    createCreativeAgentWorkspaceState,
    resolveCreativeAgentReferences,
    shouldRequestCreativeCanvasContext,
    isCreativeAgentInsertEvent,
} = require('../static/js/canvas-agent-chat-client.js');

function fakeWindow(){
    const listeners = new Set();
    return {
        addEventListener(type, listener){ if(type === 'message') listeners.add(listener); },
        removeEventListener(type, listener){ if(type === 'message') listeners.delete(listener); },
        dispatch(event){ listeners.forEach(listener => listener(event)); },
    };
}

test('iframe context requester matches origin, parent window and request id', async () => {
    const windowRef = fakeWindow();
    const sent = [];
    const parentRef = {postMessage(message, origin){ sent.push({message, origin}); }};
    const requester = createCanvasAgentContextRequester({
        windowRef,
        parentRef,
        origin:'http://127.0.0.1:3000',
        timeoutMs:1000,
        idFactory:() => 'request-1',
    });
    const pending = requester.request();
    assert.deepEqual(sent, [{
        message:{type:'canvas-agent-context-request', request_id:'request-1'},
        origin:'http://127.0.0.1:3000',
    }]);
    windowRef.dispatch({origin:'https://evil.test', source:parentRef, data:{type:'canvas-agent-context-response', request_id:'request-1', context:{canvas:{id:'evil'}}}});
    windowRef.dispatch({origin:'http://127.0.0.1:3000', source:{}, data:{type:'canvas-agent-context-response', request_id:'request-1', context:{canvas:{id:'wrong-window'}}}});
    windowRef.dispatch({origin:'http://127.0.0.1:3000', source:parentRef, data:{type:'canvas-agent-context-response', request_id:'another', context:{canvas:{id:'wrong-id'}}}});
    windowRef.dispatch({origin:'http://127.0.0.1:3000', source:parentRef, data:{type:'canvas-agent-context-response', request_id:'request-1', context:{canvas:{id:'canvas-a'}}}});
    assert.equal((await pending).canvas.id, 'canvas-a');
    requester.dispose();
});

test('context requester times out and parent errors reject without fallback submission', async () => {
    const windowRef = fakeWindow();
    const parentRef = {postMessage(){}};
    const timeoutRequester = createCanvasAgentContextRequester({windowRef, parentRef, origin:'http://local', timeoutMs:5, idFactory:() => 'timeout'});
    await assert.rejects(timeoutRequester.request(), /超时/);
    timeoutRequester.dispose();

    const errorRequester = createCanvasAgentContextRequester({windowRef, parentRef, origin:'http://local', timeoutMs:1000, idFactory:() => 'error'});
    const pending = errorRequester.request();
    windowRef.dispatch({origin:'http://local', source:parentRef, data:{type:'canvas-agent-context-response', request_id:'error', error:'画布尚未加载'}});
    await assert.rejects(pending, /画布尚未加载/);
    errorRequester.dispose();
});

test('workspace defaults to normal, remembers in-page tab and locks switching while Agent runs', () => {
    const state = createCanvasAgentWorkspaceState();
    assert.equal(state.mode(), 'normal');
    assert.equal(state.switchTo('canvas-agent'), true);
    assert.equal(state.mode(), 'canvas-agent');
    state.setBusy(true);
    assert.equal(state.switchTo('normal'), false);
    assert.equal(state.mode(), 'canvas-agent');
    state.setBusy(false);
    assert.equal(state.switchTo('normal'), true);
    assert.equal(state.mode(), 'normal');
});

test('creative workspace defaults to Agent, keeps manual mode, and resets only for a new conversation', () => {
    assert.equal(typeof createCreativeAgentWorkspaceState, 'function');
    const state = createCreativeAgentWorkspaceState();
    assert.equal(state.mode(), 'agent');
    assert.equal(state.switchTo('image'), true);
    assert.equal(state.mode(), 'image');
    state.finishRequest();
    assert.equal(state.mode(), 'image');
    state.newConversation();
    assert.equal(state.mode(), 'agent');
});

test('creative references submit only mentioned images when the prompt contains image mentions', () => {
    assert.equal(typeof resolveCreativeAgentReferences, 'function');
    const refs = [
        {id:'a', url:'/assets/a.png', marker:'图片1'},
        {id:'b', url:'/assets/b.png', marker:'图片2'},
        {id:'duplicate', url:'/assets/a.png', marker:'图片3'},
    ];
    assert.deepEqual(
        resolveCreativeAgentReferences('让 @图片2 成为海报主体', refs).map(item => item.url),
        ['/assets/b.png'],
    );
    assert.deepEqual(
        resolveCreativeAgentReferences('制作一张海报', refs).map(item => item.url),
        ['/assets/a.png', '/assets/b.png'],
    );
    assert.deepEqual(resolveCreativeAgentReferences('使用 @图片9 制作海报', refs), []);
});

test('creative Agent requests canvas text only for explicit canvas-analysis questions', () => {
    assert.equal(typeof shouldRequestCreativeCanvasContext, 'function');
    assert.equal(shouldRequestCreativeCanvasContext('分析当前画布里的循环节点'), true);
    assert.equal(shouldRequestCreativeCanvasContext('检查选中提示词是否合理'), true);
    assert.equal(shouldRequestCreativeCanvasContext('生成一张夏日海报'), false);
    assert.equal(shouldRequestCreativeCanvasContext('今天星期几'), false);
});

test('canvas insertion accepts only the current iframe, origin, canvas, and request id', () => {
    assert.equal(typeof isCreativeAgentInsertEvent, 'function');
    const source = {};
    const event = {
        origin:'http://127.0.0.1:3000',
        source,
        data:{type:'canvas-creative-agent-insert-media', request_id:'insert-1', canvas_id:'canvas-a'},
    };
    assert.equal(isCreativeAgentInsertEvent(event, 'http://127.0.0.1:3000', source, 'canvas-a'), true);
    assert.equal(isCreativeAgentInsertEvent({...event, origin:'https://evil.test'}, 'http://127.0.0.1:3000', source, 'canvas-a'), false);
    assert.equal(isCreativeAgentInsertEvent({...event, source:{}}, 'http://127.0.0.1:3000', source, 'canvas-a'), false);
    assert.equal(isCreativeAgentInsertEvent({...event, data:{...event.data, canvas_id:'canvas-b'}}, 'http://127.0.0.1:3000', source, 'canvas-a'), false);
});
