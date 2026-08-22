const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildCanvasAgentContext,
    isAllowedCanvasAgentImageUrl,
    isCanvasAgentContextRequestEvent,
} = require('../static/js/classic-canvas-agent-context.js');

function fixture(overrides = {}){
    return {
        canvas: {id:'canvas-a', title:'测试画布', updated_at:1234},
        nodes: [
            {id:'up', type:'prompt', text:'上游提示词', x:0, y:0},
            {id:'selected', type:'generator', localPrompt:'选中节点提示词', model:'demo-model', x:100, y:0},
            {id:'down', type:'output', images:['/output/result.png'], x:200, y:0},
            {id:'member', type:'note', text:'容器成员', x:110, y:80},
            {id:'frame', type:'group', title:'镜头一', items:['selected', 'member'], x:80, y:-20, w:300, h:200},
        ],
        connections: [
            {id:'c1', from:'up', to:'selected'},
            {id:'c2', from:'selected', to:'down'},
        ],
        selectedIds: ['selected'],
        ...overrides,
    };
}

test('selected nodes are detailed before direct graph and container neighbours', () => {
    const context = buildCanvasAgentContext(fixture());
    assert.equal(context.schema_version, 1);
    assert.deepEqual(context.selection.node_ids, ['selected']);
    assert.deepEqual(context.details.map(item => item.id), ['selected', 'up', 'down', 'member', 'frame']);
    assert.deepEqual(context.connections.map(item => item.id), ['c1', 'c2']);
    assert.equal(context.summary.node_count, 5);
    assert.equal(context.summary.connection_count, 2);
});

test('no selection sends only a canvas summary and at most twenty node names', () => {
    const nodes = Array.from({length:30}, (_, index) => ({
        id:`n${index}`,
        type:'prompt',
        name:`节点 ${index}`,
        text:`不得发送的提示词 ${index}`,
    }));
    const context = buildCanvasAgentContext(fixture({nodes, connections:[], selectedIds:[]}));
    assert.equal(context.details.length, 0);
    assert.equal(context.summary.node_names.length, 20);
    assert.equal(JSON.stringify(context).includes('不得发送的提示词'), false);
    assert.equal(context.selection.requires_selection_for_details, true);
});

test('detail count and text budgets truncate explicitly without leaking private fields', () => {
    const nodes = Array.from({length:55}, (_, index) => ({
        id:`n${index}`,
        type:'prompt',
        text:'文'.repeat(index === 0 ? 13000 : 5000),
        apiKey:'secret-key',
        raw:{authorization:'temporary'},
        _cascadeWaiting:true,
        localPath:'C:\\Users\\secret\\image.png',
        netWssUrl:'wss://example.test/?token=secret',
    }));
    nodes[0].text = `C:\\Users\\secret\\prompt.txt wss://example.test/?token=inside-text ${nodes[0].text}`;
    const connections = nodes.slice(1).map((node, index) => ({id:`c${index}`, from:'n0', to:node.id}));
    const context = buildCanvasAgentContext(fixture({nodes, connections, selectedIds:['n0']}));
    const serialized = JSON.stringify(context);
    assert.equal(context.details.length, 40);
    assert.match(context.details[0].text, /\[已截断/);
    assert.ok(context.context_char_count <= 60000);
    assert.equal(context.truncated, true);
    for(const forbidden of ['secret-key', 'temporary', '_cascadeWaiting', 'C:\\\\Users', 'token=secret', 'token=inside-text']){
        assert.equal(serialized.includes(forbidden), false, `must not expose ${forbidden}`);
    }
});

test('only explicitly selected images are attached, deduplicated and capped at six', () => {
    const selectedImages = Array.from({length:8}, (_, index) => ({
        id:`img${index}`,
        type:'image',
        name:`图片 ${index}`,
        url:index === 7 ? '/output/0.png' : `/output/${index}.png`,
        natural_w:1024,
        natural_h:768,
    }));
    const neighbour = {id:'neighbour', type:'image', name:'相邻图片', url:'/output/neighbour.png'};
    const connections = [{id:'edge', from:'neighbour', to:'img0'}];
    const context = buildCanvasAgentContext(fixture({
        nodes:[...selectedImages, neighbour],
        connections,
        selectedIds:selectedImages.map(item => item.id),
    }));
    assert.equal(context.selected_images.length, 6);
    assert.deepEqual(context.selected_images.map(item => item.url), [
        '/output/0.png', '/output/1.png', '/output/2.png',
        '/output/3.png', '/output/4.png', '/output/5.png',
    ]);
    assert.equal(context.selected_images.some(item => item.url.includes('neighbour')), false);
    assert.equal(context.selection.selected_image_count, 7);
    assert.equal(context.selection.sent_image_count, 6);
});

test('canvas Agent image URL policy accepts controlled image sources only', () => {
    for(const allowed of [
        '/assets/input/a.png', '/output/a.webp', '/static/images/a.jpg',
        'https://images.example/a.png', 'http://localhost/a.png',
        'data:image/png;base64,iVBORw0KGgo=',
    ]) assert.equal(isAllowedCanvasAgentImageUrl(allowed), true, allowed);
    for(const denied of [
        'C:\\Users\\me\\a.png', 'file:///C:/a.png', '/api/config',
        'wss://example.test/?token=secret', 'data:text/plain;base64,QQ==',
        'javascript:alert(1)',
    ]) assert.equal(isAllowedCanvasAgentImageUrl(denied), false, denied);
});

test('context request bridge accepts only the expected origin, iframe and request id', () => {
    const frameWindow = {};
    const valid = {
        origin:'http://127.0.0.1:3000',
        source:frameWindow,
        data:{type:'canvas-agent-context-request', request_id:'req-123'},
    };
    assert.equal(isCanvasAgentContextRequestEvent(valid, valid.origin, frameWindow), true);
    assert.equal(isCanvasAgentContextRequestEvent({...valid, origin:'https://evil.test'}, valid.origin, frameWindow), false);
    assert.equal(isCanvasAgentContextRequestEvent({...valid, source:{}}, valid.origin, frameWindow), false);
    assert.equal(isCanvasAgentContextRequestEvent({...valid, data:{...valid.data, request_id:''}}, valid.origin, frameWindow), false);
    assert.equal(isCanvasAgentContextRequestEvent({...valid, data:{...valid.data, request_id:'x'.repeat(201)}}, valid.origin, frameWindow), false);
});
