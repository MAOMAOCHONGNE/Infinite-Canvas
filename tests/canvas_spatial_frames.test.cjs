const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'static', 'js', 'canvas-spatial-frames.js');
const Frames = require(MODULE);

function rect(node){
    return {
        x:Number(node.x) || 0,
        y:Number(node.y) || 0,
        w:Number(node.w) || 0,
        h:Number(node.h) || 0,
    };
}

test('createFrameAroundSelection encloses mixed top-level nodes and collapses selected semantic-group members', () => {
    const nodes = [
        {id:'image-1', type:'image', x:100, y:200, w:100, h:80},
        {id:'prompt-1', type:'prompt', x:300, y:100, w:120, h:60},
        {id:'group-1', type:'group', x:80, y:80, w:380, h:240, items:['image-1']},
    ];

    const frame = Frames.createFrameAroundSelection(nodes, ['group-1', 'image-1', 'prompt-1'], rect, {
        id:'frame-1',
        padding:36,
        headerHeight:56,
    });

    assert.deepEqual(frame.items, ['group-1', 'prompt-1']);
    assert.deepEqual(
        {x:frame.x, y:frame.y, w:frame.w, h:frame.h},
        {x:44, y:-12, w:452, h:368},
    );
    assert.equal(frame.type, Frames.FRAME_TYPE);
    assert.equal(frame.titleSize, 32);
    assert.equal(frame.color, '#94a3b8');
});

test('createFrameAroundSelection refuses frame nesting', () => {
    const nodes = [
        {id:'frame-1', type:Frames.FRAME_TYPE, x:0, y:0, w:400, h:300, items:[]},
        {id:'image-1', type:'image', x:80, y:80, w:120, h:120},
    ];
    assert.equal(Frames.createFrameAroundSelection(nodes, ['frame-1', 'image-1'], rect), null);
});

test('collectMoveIds expands frame and semantic-group descendants exactly once', () => {
    const nodes = [
        {id:'frame-1', type:Frames.FRAME_TYPE, items:['group-1', 'prompt-1']},
        {id:'group-1', type:'group', items:['image-1']},
        {id:'image-1', type:'image'},
        {id:'prompt-1', type:'prompt'},
    ];
    assert.deepEqual(
        Frames.collectMoveIds(nodes, ['frame-1'], {groupTypes:['group', 'promptGroup', 'smart-group']}).sort(),
        ['frame-1', 'group-1', 'image-1', 'prompt-1'],
    );
});

test('updateMembershipAfterDrop adds contained roots, removes escaped roots, and never nests frames', () => {
    const nodes = [
        {id:'frame-1', type:Frames.FRAME_TYPE, x:0, y:0, w:400, h:300, items:['outside']},
        {id:'inside', type:'image', x:70, y:80, w:100, h:80},
        {id:'outside', type:'prompt', x:500, y:500, w:100, h:80},
        {id:'frame-2', type:Frames.FRAME_TYPE, x:450, y:450, w:300, h:260, items:[]},
    ];

    const changed = Frames.updateMembershipAfterDrop(nodes, ['inside', 'outside', 'frame-2'], rect);

    assert.equal(changed, true);
    assert.deepEqual(nodes[0].items, ['inside']);
    assert.deepEqual(nodes[3].items, ['outside']);
});

test('copy closure and remapping keep frame members internal to the copied payload', () => {
    const nodes = [
        {id:'frame-1', type:Frames.FRAME_TYPE, items:['group-1', 'prompt-1']},
        {id:'group-1', type:'group', items:['image-1']},
        {id:'image-1', type:'image'},
        {id:'prompt-1', type:'prompt'},
        {id:'external', type:'image'},
    ];

    assert.deepEqual(
        Frames.copyClosureIds(nodes, ['frame-1'], {groupTypes:['group', 'promptGroup', 'smart-group']}).sort(),
        ['frame-1', 'group-1', 'image-1', 'prompt-1'],
    );
    assert.deepEqual(
        Frames.remapFrameItems(['group-1', 'prompt-1'], new Map([['group-1', 'group-copy'], ['prompt-1', 'prompt-copy']])),
        ['group-copy', 'prompt-copy'],
    );
});

test('collectMediaItems recursively gathers selected media once and preserves video/audio kinds', () => {
    const nodes = [
        {id:'image-1', type:'image', url:'/assets/a.png', name:'A'},
        {id:'output-1', type:'output', images:[
            {url:'/assets/b.mp4', name:'clip.mp4'},
            {url:'/assets/c.wav', name:'sound.wav'},
            '/assets/a.png',
        ]},
        {id:'group-1', type:'group', items:['image-1', 'output-1']},
    ];

    assert.deepEqual(Frames.collectMediaItems(nodes, ['group-1']), [
        {url:'/assets/a.png', name:'A.png', kind:'image'},
        {url:'/assets/b.mp4', name:'clip.mp4', kind:'video'},
        {url:'/assets/c.wav', name:'sound.wav', kind:'audio'},
    ]);
});
