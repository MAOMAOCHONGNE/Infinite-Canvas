const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'static', 'js', 'classic-cascade-plan.js');
const CANVAS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const RUN_TYPES = ['generator', 'llm', 'video', 'rh'];

function loadPlanner(){
    assert.ok(fs.existsSync(HELPER_PATH), 'classic cascade planner must exist');
    delete require.cache[require.resolve(HELPER_PATH)];
    return require(HELPER_PATH);
}

function connection(from, to){
    return {from, to};
}

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('a direct generator chain remains one once-only stage when no loop is upstream', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'image', type:'image'},
        {id:'gen-1', type:'generator'},
        {id:'gen-2', type:'generator'},
    ];
    const connections = [
        connection('image', 'gen-1'),
        connection('gen-1', 'gen-2'),
    ];

    assert.deepEqual(planner.buildCascadePlan(nodes, connections, 'gen-2', RUN_TYPES), {
        targetId:'gen-2',
        loopId:'',
        onceOrder:['gen-1', 'gen-2'],
        loopOrder:[],
        loopStages:[],
        allOrder:['gen-1', 'gen-2'],
    });
});

test('a generator before the loop runs once and only downstream generators repeat', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'image', type:'image'},
        {id:'gen-1', type:'generator'},
        {id:'out-1', type:'output'},
        {id:'prompt', type:'prompt'},
        {id:'loop', type:'loop'},
        {id:'gen-2', type:'generator'},
        {id:'out-2', type:'output'},
    ];
    const connections = [
        connection('image', 'gen-1'),
        connection('gen-1', 'out-1'),
        connection('out-1', 'loop'),
        connection('prompt', 'loop'),
        connection('loop', 'gen-2'),
        connection('gen-2', 'out-2'),
    ];

    assert.deepEqual(planner.buildCascadePlan(nodes, connections, 'gen-2', RUN_TYPES, {loopId:'loop'}), {
        targetId:'gen-2',
        loopId:'loop',
        onceOrder:['gen-1'],
        loopOrder:['gen-2'],
        loopStages:[{loopId:'loop', order:['gen-2']}],
        allOrder:['gen-1', 'gen-2'],
    });
});

test('a fixed image branch is pre-loop even when it connects directly to the repeated generator', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'gen-1', type:'generator'},
        {id:'out-1', type:'output'},
        {id:'prompt', type:'prompt'},
        {id:'loop', type:'loop'},
        {id:'gen-2', type:'generator'},
    ];
    const connections = [
        connection('gen-1', 'out-1'),
        connection('out-1', 'gen-2'),
        connection('prompt', 'loop'),
        connection('loop', 'gen-2'),
    ];

    assert.deepEqual(planner.buildCascadePlan(nodes, connections, 'gen-2', RUN_TYPES, {loopId:'loop'}), {
        targetId:'gen-2',
        loopId:'loop',
        onceOrder:['gen-1'],
        loopOrder:['gen-2'],
        loopStages:[{loopId:'loop', order:['gen-2']}],
        allOrder:['gen-1', 'gen-2'],
    });
});

test('complete workflow schedules the pre-loop stage once while current-loop mode skips it', () => {
    const planner = loadPlanner();
    const plan = {
        targetId:'gen-2',
        loopId:'loop',
        onceOrder:['gen-1'],
        loopOrder:['gen-2'],
        loopStages:[{loopId:'loop', order:['gen-2']}],
        allOrder:['gen-1', 'gen-2'],
    };

    assert.deepEqual(planner.buildExecutionStages(plan, {scope:'complete', startRound:1, totalRounds:2}), {
        onceOrder:['gen-1'],
        stages:[{
            loopId:'loop',
            order:['gen-2'],
            rounds:[
                {index:1, order:['gen-2']},
                {index:2, order:['gen-2']},
            ],
        }],
        rounds:[
            {index:1, order:['gen-2']},
            {index:2, order:['gen-2']},
        ],
    });
    assert.deepEqual(planner.buildExecutionStages(plan, {scope:'loop', startRound:1, totalRounds:2}), {
        onceOrder:[],
        stages:[{
            loopId:'loop',
            order:['gen-2'],
            rounds:[
                {index:1, order:['gen-2']},
                {index:2, order:['gen-2']},
            ],
        }],
        rounds:[
            {index:1, order:['gen-2']},
            {index:2, order:['gen-2']},
        ],
    });
});

test('chained loops become ordered stages instead of treating the first loop as preprocessing', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'group', type:'group'},
        {id:'loop-1', type:'loop'},
        {id:'gen-1', type:'generator'},
        {id:'out-1', type:'output'},
        {id:'loop-2', type:'loop'},
        {id:'gen-2', type:'generator'},
    ];
    const connections = [
        connection('group', 'loop-1'),
        connection('loop-1', 'gen-1'),
        connection('gen-1', 'out-1'),
        connection('out-1', 'loop-2'),
        connection('loop-2', 'gen-2'),
    ];

    assert.deepEqual(planner.buildCascadePlan(nodes, connections, 'gen-2', RUN_TYPES), {
        targetId:'gen-2',
        loopId:'loop-2',
        onceOrder:[],
        loopOrder:['gen-2'],
        loopStages:[
            {loopId:'loop-1', order:['gen-1']},
            {loopId:'loop-2', order:['gen-2']},
        ],
        allOrder:['gen-1', 'gen-2'],
    });
});

test('multi-loop execution schedules every complete stage in order and isolates a requested current loop', () => {
    const planner = loadPlanner();
    const plan = {
        targetId:'gen-2',
        loopId:'loop-2',
        onceOrder:[],
        loopOrder:['gen-2'],
        loopStages:[
            {loopId:'loop-1', order:['gen-1']},
            {loopId:'loop-2', order:['gen-2']},
        ],
        allOrder:['gen-1', 'gen-2'],
    };
    const options = {
        scope:'complete',
        loopId:'loop-2',
        loopSettingsById:{
            'loop-1':{startRound:1, totalRounds:2},
            'loop-2':{startRound:3, totalRounds:2},
        },
    };
    const complete = planner.buildExecutionStages(plan, options);

    assert.deepEqual(complete.stages, [
        {
            loopId:'loop-1',
            order:['gen-1'],
            rounds:[{index:1, order:['gen-1']}, {index:2, order:['gen-1']}],
        },
        {
            loopId:'loop-2',
            order:['gen-2'],
            rounds:[{index:3, order:['gen-2']}, {index:4, order:['gen-2']}],
        },
    ]);

    const current = planner.buildExecutionStages(plan, {...options, scope:'loop', loopId:'loop-1'});
    assert.deepEqual(current.onceOrder, []);
    assert.deepEqual(current.stages, [complete.stages[0]]);
});

test('classic run-action tooltips explain current API and current-loop scope', () => {
    const planner = loadPlanner();

    assert.equal(planner.runActionTooltip('api'), '只运行当前 API 节点一次。');
    assert.equal(planner.runActionTooltip('loop'), '使用已有结果，只处理循环步骤，不重新运行前面的内容。');
});

test('current API preview targets one node and never lights a workflow edge', () => {
    const planner = loadPlanner();

    assert.deepEqual(planner.buildCurrentNodePreview('api-2'), {
        currentRunnableNodeIds:['api-2'],
        onceRunnableNodeIds:[],
        loopRunnableNodeIds:[],
        onceDataNodeIds:[],
        loopDataNodeIds:[],
        onceEdgeIds:[],
        loopEdgeIds:[],
    });
    assert.deepEqual(planner.buildCurrentNodePreview(''), {
        currentRunnableNodeIds:[],
        onceRunnableNodeIds:[],
        loopRunnableNodeIds:[],
        onceDataNodeIds:[],
        loopDataNodeIds:[],
        onceEdgeIds:[],
        loopEdgeIds:[],
    });
});

test('measured loop content grows a clipped card without shrinking a larger manual height', () => {
    const planner = loadPlanner();

    assert.equal(planner.growLoopNodeHeight({currentHeight:350, bodyScrollHeight:374, headerHeight:42}), 418);
    assert.equal(planner.growLoopNodeHeight({currentHeight:560, bodyScrollHeight:374, headerHeight:42}), 560);
    assert.equal(planner.growLoopNodeHeight({currentHeight:350, bodyScrollHeight:980, headerHeight:42, maxHeight:900}), 900);
});

test('rendered loop sizing measures the inner loop content hidden by the sized card', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const block = sourceBlock(source, 'function scheduleRenderedLoopAutoSize', 'function loopTokenChipHtml');
    const scheduleRenderedLoopAutoSize = new Function(
        'ClassicCascadePlan',
        'requestAnimationFrame',
        'scheduleLinksRender',
        'scheduleMinimapRender',
        `${block}; return scheduleRenderedLoopAutoSize;`,
    )(loadPlanner(), callback => callback(), () => {}, () => {});
    const addedClasses = [];
    const node = {id:'loop-1', type:'loop', imageInput:true, showPrompt:false, h:350};
    const outerBody = {scrollHeight:350};
    const loopBody = {scrollHeight:374};
    const head = {offsetHeight:42};
    const el = {
        isConnected:true,
        offsetHeight:350,
        style:{},
        classList:{add:value => addedClasses.push(value)},
        querySelector:selector => ({
            '.node-body':outerBody,
            '.loop-body':loopBody,
            '.node-head':head,
        })[selector] || null,
    };

    scheduleRenderedLoopAutoSize(node, el);

    assert.equal(node.h, 418);
    assert.equal(el.style.height, '418px');
    assert.deepEqual(addedClasses, ['sized']);
});

test('a loop input reverse drag offers only compatible upstream quick-create types', () => {
    const planner = loadPlanner();

    assert.deepEqual(planner.inputQuickCreateTypes('loop'), ['image', 'prompt', 'group', 'llm']);
    assert.deepEqual(planner.inputQuickCreateTypes('image'), []);
});

test('group output and loop input quick-create menus offer each other', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const block = sourceBlock(source, 'function linkCreateOptions', 'function openLinkCreateMenu');
    const makeOptions = node => new Function(
        'nodes',
        'tr',
        'CANVAS_GENERATOR_TYPES',
        'ClassicCascadePlan',
        `${block}; return linkCreateOptions;`,
    )([node], key => key, ['generator'], loadPlanner());

    const groupOptions = makeOptions({id:'group-1', type:'group'})({originId:'group-1', originKind:'out'});
    const loopOptions = makeOptions({id:'loop-1', type:'loop'})({originId:'loop-1', originKind:'in'});

    assert.ok(groupOptions.some(option => option.type === 'loop'));
    assert.ok(loopOptions.some(option => option.type === 'group'));
});

test('loop image preflight rejects an empty later round without implicitly repeating images', () => {
    const planner = loadPlanner();

    assert.deepEqual(planner.checkLoopImageAvailability({
        enabled:true,
        available:1,
        startRound:1,
        totalRounds:2,
        batchSize:1,
    }), {
        ok:false,
        available:1,
        required:2,
        firstEmptyRound:2,
    });
    assert.deepEqual(planner.checkLoopImageAvailability({
        enabled:true,
        available:2,
        startRound:1,
        totalRounds:2,
        batchSize:1,
    }), {
        ok:true,
        available:2,
        required:2,
        firstEmptyRound:0,
    });
    assert.deepEqual(planner.checkLoopImageAvailability({
        enabled:true,
        available:2,
        startRound:1,
        totalRounds:2,
        batchSize:2,
    }), {
        ok:false,
        available:2,
        required:3,
        firstEmptyRound:2,
    });
    assert.deepEqual(planner.checkLoopImageAvailability({
        enabled:false,
        available:0,
        startRound:1,
        totalRounds:9,
        batchSize:4,
    }), {
        ok:true,
        available:0,
        required:0,
        firstEmptyRound:0,
    });
});

test('available images shrink only empty tail rounds and allow a partial final batch', () => {
    const planner = loadPlanner();

    assert.deepEqual(planner.fitLoopRoundsToAvailableImages({
        enabled:true,
        available:9,
        startRound:1,
        totalRounds:10,
        batchSize:1,
    }), {
        enabled:true,
        available:9,
        startRound:1,
        configuredRounds:10,
        runnableRounds:9,
        skippedRounds:1,
        batchSize:1,
        lastBatchSize:1,
    });
    assert.deepEqual(planner.fitLoopRoundsToAvailableImages({
        enabled:true,
        available:9,
        startRound:1,
        totalRounds:5,
        batchSize:2,
    }), {
        enabled:true,
        available:9,
        startRound:1,
        configuredRounds:5,
        runnableRounds:5,
        skippedRounds:0,
        batchSize:2,
        lastBatchSize:1,
    });
    assert.deepEqual(planner.fitLoopRoundsToAvailableImages({
        enabled:true,
        available:9,
        startRound:3,
        totalRounds:5,
        batchSize:2,
    }), {
        enabled:true,
        available:9,
        startRound:3,
        configuredRounds:5,
        runnableRounds:3,
        skippedRounds:2,
        batchSize:2,
        lastBatchSize:1,
    });
    assert.equal(planner.fitLoopRoundsToAvailableImages({
        enabled:true,
        available:0,
        totalRounds:10,
        batchSize:1,
    }).runnableRounds, 0);
    assert.equal(planner.fitLoopRoundsToAvailableImages({
        enabled:false,
        available:0,
        totalRounds:10,
        batchSize:2,
    }).runnableRounds, 10);
});

test('available prompts shrink empty tail rounds without repeating earlier prompts', () => {
    const planner = loadPlanner();

    assert.deepEqual(planner.fitLoopRoundsToAvailablePrompts({
        enabled:true,
        available:9,
        startRound:1,
        totalRounds:10,
    }), {
        enabled:true,
        available:9,
        startRound:1,
        configuredRounds:10,
        runnableRounds:9,
        skippedRounds:1,
    });
    assert.deepEqual(planner.fitLoopRoundsToAvailablePrompts({
        enabled:true,
        available:4,
        startRound:3,
        totalRounds:4,
    }), {
        enabled:true,
        available:4,
        startRound:3,
        configuredRounds:4,
        runnableRounds:2,
        skippedRounds:2,
    });
    assert.equal(planner.fitLoopRoundsToAvailablePrompts({
        enabled:true,
        available:0,
        totalRounds:10,
    }).runnableRounds, 0);
    assert.equal(planner.fitLoopRoundsToAvailablePrompts({
        enabled:false,
        available:0,
        totalRounds:10,
    }).runnableRounds, 10);
});

test('tolerant round runner attempts every ordinary failure but still propagates cancellation', async () => {
    const planner = loadPlanner();
    const rounds = Array.from({length:10}, (_, offset) => ({index:offset + 1}));
    const attempted = [];
    const result = await planner.runTolerantLoopRounds(rounds, 3, async round => {
        attempted.push(round.index);
        if(round.index === 5) throw new Error('temporary provider failure');
    }, error => error?.name === 'CascadeAbortError');

    assert.deepEqual([...attempted].sort((a, b) => a - b), rounds.map(round => round.index));
    assert.equal(result.attemptedRounds, 10);
    assert.equal(result.successfulRounds, 9);
    assert.equal(result.failedRounds, 1);
    assert.equal(result.failures[0].round.index, 5);

    const stop = new Error('stopped');
    stop.name = 'CascadeAbortError';
    await assert.rejects(
        planner.runTolerantLoopRounds(rounds.slice(0, 2), 1, async round => {
            if(round.index === 1) throw stop;
        }, error => error?.name === 'CascadeAbortError'),
        error => error === stop,
    );
});

test('slot-aware loop selection preserves failed upstream positions for downstream stages', () => {
    const planner = loadPlanner();
    const rounds = [1, 2, 3, 4].map(index => ({index}));
    assert.deepEqual(planner.selectLoopRoundsBySlots(rounds, [
        {cascadeSlot:0},
        {cascadeSlot:2},
        {cascadeSlot:3},
    ], 1), {
        rounds:[{index:1}, {index:3}, {index:4}],
        skippedRounds:[{index:2}],
        hasSlots:true,
    });
    assert.deepEqual(planner.selectLoopRoundsBySlots(rounds, [{cascadeSlot:0}, {cascadeSlot:1}], 2), {
        rounds:[{index:1}],
        skippedRounds:[{index:2}, {index:3}, {index:4}],
        hasSlots:true,
    });
    assert.deepEqual(planner.selectLoopRoundsBySlots(rounds, [{url:'legacy'}], 1), {
        rounds,
        skippedRounds:[],
        hasSlots:false,
    });
});

test('removing loop connections closes only the final image input and preserves prompt mode', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'image-1', type:'image'},
        {id:'image-2', type:'image'},
        {id:'prompt', type:'prompt'},
        {id:'loop', type:'loop', imageInput:true, showPrompt:true},
        {id:'gen', type:'generator'},
    ];
    const connections = [
        {id:'image-edge-1', from:'image-1', to:'loop'},
        {id:'image-edge-2', from:'image-2', to:'loop'},
        {id:'prompt-edge', from:'prompt', to:'loop'},
        {id:'loop-edge', from:'loop', to:'gen'},
    ];

    const first = planner.removeConnectionsAndReconcileLoops(
        nodes,
        connections,
        edge => edge.id === 'image-edge-1'
    );
    assert.equal(nodes.find(node => node.id === 'loop').imageInput, true);
    assert.equal(nodes.find(node => node.id === 'loop').showPrompt, true);
    assert.deepEqual(first.changedLoopIds, []);

    const second = planner.removeConnectionsAndReconcileLoops(
        nodes,
        first.connections,
        edge => edge.id === 'image-edge-2'
    );
    assert.equal(nodes.find(node => node.id === 'loop').imageInput, false);
    assert.equal(nodes.find(node => node.id === 'loop').showPrompt, true);
    assert.deepEqual(second.changedLoopIds, ['loop']);
    assert.deepEqual(second.connections.map(edge => edge.id), ['prompt-edge', 'loop-edge']);
});

test('complete workflow preview separates once-only and repeated data paths', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'image', type:'image'},
        {id:'gen-1', type:'generator'},
        {id:'out-1', type:'output'},
        {id:'prompt', type:'prompt'},
        {id:'loop', type:'loop'},
        {id:'gen-2', type:'generator'},
        {id:'out-2', type:'output'},
    ];
    const connections = [
        {id:'image-to-gen-1', from:'image', to:'gen-1'},
        {id:'gen-1-to-out-1', from:'gen-1', to:'out-1'},
        {id:'out-1-to-loop', from:'out-1', to:'loop'},
        {id:'prompt-to-loop', from:'prompt', to:'loop'},
        {id:'loop-to-gen-2', from:'loop', to:'gen-2'},
        {id:'gen-2-to-out-2', from:'gen-2', to:'out-2'},
    ];

    assert.deepEqual(planner.buildCascadePreview(nodes, connections, 'gen-2', RUN_TYPES, {
        scope:'complete',
        loopId:'loop',
    }), {
        onceRunnableNodeIds:['gen-1'],
        loopRunnableNodeIds:['gen-2'],
        onceDataNodeIds:['image', 'out-1'],
        loopDataNodeIds:['out-1', 'loop', 'prompt', 'out-2'],
        onceEdgeIds:['image-to-gen-1', 'gen-1-to-out-1'],
        loopEdgeIds:['out-1-to-loop', 'prompt-to-loop', 'loop-to-gen-2', 'gen-2-to-out-2'],
    });
});

test('current-loop preview omits the preprocessing generator but keeps consumed inputs and results', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'gen-1', type:'generator'},
        {id:'out-1', type:'output'},
        {id:'prompt', type:'prompt'},
        {id:'loop', type:'loop'},
        {id:'gen-2', type:'generator'},
        {id:'out-2', type:'output'},
    ];
    const connections = [
        {id:'gen-1-to-out-1', from:'gen-1', to:'out-1'},
        {id:'fixed-output-to-gen-2', from:'out-1', to:'gen-2'},
        {id:'prompt-to-loop', from:'prompt', to:'loop'},
        {id:'loop-to-gen-2', from:'loop', to:'gen-2'},
        {id:'gen-2-to-out-2', from:'gen-2', to:'out-2'},
    ];

    assert.deepEqual(planner.buildCascadePreview(nodes, connections, 'gen-2', RUN_TYPES, {
        scope:'loop',
        loopId:'loop',
    }), {
        onceRunnableNodeIds:[],
        loopRunnableNodeIds:['gen-2'],
        onceDataNodeIds:[],
        loopDataNodeIds:['out-1', 'prompt', 'loop', 'out-2'],
        onceEdgeIds:[],
        loopEdgeIds:['fixed-output-to-gen-2', 'prompt-to-loop', 'loop-to-gen-2', 'gen-2-to-out-2'],
    });
});

test('complete workflow preview includes every chained loop stage and stops current-loop preview at its boundary', () => {
    const planner = loadPlanner();
    const nodes = [
        {id:'group', type:'group'},
        {id:'loop-1', type:'loop'},
        {id:'gen-1', type:'generator'},
        {id:'out-1', type:'output'},
        {id:'loop-2', type:'loop'},
        {id:'gen-2', type:'generator'},
        {id:'out-2', type:'output'},
    ];
    const connections = [
        {id:'group-to-loop-1', from:'group', to:'loop-1'},
        {id:'loop-1-to-gen-1', from:'loop-1', to:'gen-1'},
        {id:'gen-1-to-out-1', from:'gen-1', to:'out-1'},
        {id:'out-1-to-loop-2', from:'out-1', to:'loop-2'},
        {id:'loop-2-to-gen-2', from:'loop-2', to:'gen-2'},
        {id:'gen-2-to-out-2', from:'gen-2', to:'out-2'},
    ];

    assert.deepEqual(planner.buildCascadePreview(nodes, connections, 'gen-2', RUN_TYPES, {
        scope:'complete',
    }), {
        onceRunnableNodeIds:[],
        loopRunnableNodeIds:['gen-1', 'gen-2'],
        onceDataNodeIds:[],
        loopDataNodeIds:['group', 'loop-1', 'out-1', 'loop-2', 'out-2'],
        onceEdgeIds:[],
        loopEdgeIds:connections.map(connection => connection.id),
    });

    assert.deepEqual(planner.buildCascadePreview(nodes, connections, 'gen-2', RUN_TYPES, {
        scope:'loop',
        loopId:'loop-1',
    }), {
        onceRunnableNodeIds:[],
        loopRunnableNodeIds:['gen-1'],
        onceDataNodeIds:[],
        loopDataNodeIds:['group', 'loop-1', 'out-1'],
        onceEdgeIds:[],
        loopEdgeIds:['group-to-loop-1', 'loop-1-to-gen-1', 'gen-1-to-out-1'],
    });
});

test('classic canvas loads the cascade planner before its controller', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const helper = html.indexOf('/static/js/classic-cascade-plan.js');
    const controller = html.indexOf('/static/js/canvas.js');

    assert.ok(helper >= 0, 'classic canvas must load the cascade planner');
    assert.ok(controller > helper, 'cascade planner must load before canvas.js');
});

test('loop and terminal actions expose distinct current-loop and complete-workflow meanings', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const loopBlock = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');
    const terminalBlock = sourceBlock(source, 'function cascadeBtnHtml', 'function retryBarHtml');

    assert.match(loopBlock, /运行本循环/);
    assert.match(loopBlock, /runNodeCascade\(btn\.dataset\.loopCascade,\s*\{scope:\s*['"]loop['"],\s*loopId:node\.id\}\)/);
    assert.match(terminalBlock, /运行完整流程/);
    assert.match(terminalBlock, /onceOrder\.length/);
    assert.match(terminalBlock, /loopStages\.length/);
});

test('classic API and loop buttons consume the shared scope tooltips', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const generatorBlock = sourceBlock(source, 'function renderGeneratorBody', 'function renderMidjourneyBody');
    const loopBlock = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');

    assert.match(generatorBlock, /ClassicCascadePlan\.runActionTooltip\(['"]api['"]\)/);
    assert.match(loopBlock, /ClassicCascadePlan\.runActionTooltip\(['"]loop['"]\)/);
});

test('classic controller wires current-node hover, measured loop growth, and loop reverse discovery', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const generatorBlock = sourceBlock(source, 'function renderGeneratorBody', 'function renderMidjourneyBody');
    const nodeBlock = sourceBlock(source, 'function renderNode(node)', 'function defaultNodeSize');
    const menuBlock = sourceBlock(source, 'function linkCreateOptions', 'function openLinkCreateMenu');
    const dragBlock = sourceBlock(source, 'function startLink', 'function wouldCreateGeneratorCycle');

    assert.match(generatorBlock, /onmouseenter\s*=\s*\(\)\s*=>\s*setClassicCurrentNodePreview\(node\.id\)/);
    assert.match(generatorBlock, /onmouseleave\s*=\s*\(\)\s*=>\s*clearClassicCurrentNodePreview\(\)/);
    assert.match(nodeBlock, /scheduleRenderedLoopAutoSize\(node,\s*el\)/);
    assert.match(menuBlock, /ClassicCascadePlan\.inputQuickCreateTypes\(node\.type\)/);
    assert.match(dragBlock, /setClassicLinkTargetPreview\(originId,\s*originKind\)/);
    assert.match(dragBlock, /clearClassicLinkTargetPreview\(\)/);
    assert.match(dragBlock, /candidate\.id\s*===\s*origin\.id/);
    assert.match(dragBlock, /connection\.from\s*===\s*candidate\.id\s*&&\s*connection\.to\s*===\s*origin\.id/);
    assert.match(css, /workflow-preview-current-run/);
    assert.match(css, /link-target-compatible/);
});

test('classic controller runs preprocessing once and then awaits every loop stage with fresh outputs', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const planBlock = sourceBlock(source, 'function classicCascadePlan', 'function cascadeUiNodeIds');
    const stageBlock = sourceBlock(source, 'async function runClassicCascadeLoopStage', 'async function runNodeCascade');
    const runBlock = sourceBlock(source, 'async function runNodeCascade(nodeId, options={})', 'async function runOneCascadePass');

    assert.match(planBlock, /ClassicCascadePlan\.buildCascadePlan/);
    assert.match(runBlock, /ClassicCascadePlan\.buildExecutionStages/);
    assert.match(runBlock, /await runOneCascadePass\(schedule\.onceOrder/);
    assert.match(runBlock, /for\s*\(const stage of schedule\.stages\)/);
    assert.match(runBlock, /cascadeFreshSourceRefsByNode\(completedOrder\)/);
    assert.match(runBlock, /fitLoopRoundsToAvailableImages/);
    assert.match(runBlock, /await runClassicCascadeLoopStage/);
    assert.match(runBlock, /completedOrder\.push\(\.\.\.stage\.order\)/);
    assert.match(stageBlock, /stage\.rounds/);
    assert.match(stageBlock, /runTolerantLoopRounds/);
    assert.match(stageBlock, /await runCascadeNodeWithLoopContext/);
    assert.ok(runBlock.indexOf('await runOneCascadePass(schedule.onceOrder') < runBlock.indexOf('for(const stage of schedule.stages)'));
    assert.ok(runBlock.indexOf('cascadeFreshSourceRefsByNode(completedOrder)') < runBlock.indexOf('fitLoopRoundsToAvailableImages'));
    assert.ok(runBlock.indexOf('fitLoopRoundsToAvailableImages') < runBlock.indexOf('await runClassicCascadeLoopStage'));
});

test('classic controller tolerates failed loop rounds and trims only unavailable downstream rounds', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const stageBlock = sourceBlock(source, 'async function runClassicCascadeLoopStage', 'async function runNodeCascade');
    const runBlock = sourceBlock(source, 'async function runNodeCascade(nodeId, options={})', 'async function runOneCascadePass');
    const renderBlock = sourceBlock(source, 'function renderNode(node){', 'function renderLoopBody');

    assert.match(stageBlock, /ClassicCascadePlan\.runTolerantLoopRounds/);
    assert.match(stageBlock, /isCascadeAbortError/);
    assert.match(stageBlock, /successfulRounds/);
    assert.match(stageBlock, /failedRounds/);
    assert.match(runBlock, /fitLoopRoundsToAvailableImages/);
    assert.match(runBlock, /fitLoopRoundsToAvailablePrompts/);
    assert.match(runBlock, /classicLoopPromptCapacity/);
    assert.match(runBlock, /selectLoopRoundsBySlots/);
    assert.match(runBlock, /_cascadeProcessedRoundIndexes/);
    assert.match(runBlock, /等待上游/);
    assert.match(runBlock, /Math\.min\(imageFit\.runnableRounds,\s*promptFit\.runnableRounds\)/);
    assert.match(runBlock, /stage\.rounds\.slice\(0,\s*fallbackRunnableRounds\)/);
    assert.match(runBlock, /totalRounds\s*-\s*runnableRounds/);
    assert.match(runBlock, /finalizeCascade\(nodeId,\s*'partial'/);
    assert.match(renderBlock, /partial\s*:\s*'部分完成'/);
    assert.match(css, /\.node-run-status\.partial/);
    assert.match(source, /function loopRetryBarHtml/);
    assert.match(source, /async function retryFailedLoopRounds/);
    assert.match(source, /data-loop-retry/);
});

test('zero usable loop prompts skip the stage before any downstream submission', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const runBlock = sourceBlock(source, 'async function runNodeCascade(nodeId, options={})', 'async function runOneCascadePass');

    assert.match(runBlock, /promptFit\.enabled\s*&&\s*promptFit\.runnableRounds\s*===\s*0/);
    assert.match(runBlock, /无可用提示词/);
    assert.ok(runBlock.indexOf('promptFit.enabled && promptFit.runnableRounds === 0') < runBlock.indexOf('await runClassicCascadeLoopStage'));
});

test('complete workflow snapshots fresh pre-loop outputs for loop and fixed-output inputs', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const imageBlock = sourceBlock(source, 'function imageRefsFromNode', 'function loopImageStartForRound');
    const generatorBlock = sourceBlock(source, 'function generatorSources', 'function orderedSources');
    const cascadeBlock = sourceBlock(source, 'function cascadeFreshSourceRefsByNode', 'function checkClassicCascadeLoopImages');

    assert.match(imageBlock, /cascadeSourceRefsFromNode/);
    assert.match(generatorBlock, /cascadeSourceRefsFromNode/);
    assert.match(cascadeBlock, /generatedImageRefs/);
    assert.match(cascadeBlock, /sourceRefsByNode/);
});

test('zero usable images still show an actionable message and stop before downstream submission', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const runBlock = sourceBlock(source, 'async function runNodeCascade(nodeId, options={})', 'async function runOneCascadePass');

    assert.match(runBlock, /imageFit\.enabled\s*&&\s*imageFit\.runnableRounds\s*===\s*0/);
    assert.match(runBlock, /图片数量不足/);
    assert.match(runBlock, /finalizeCascade\(nodeId,\s*'stopped'/);
    assert.ok(runBlock.indexOf('fit.runnableRounds === 0') < runBlock.indexOf('await runClassicCascadeLoopStage'));
});

test('classic removal paths share loop-image reconciliation instead of leaving a stale switch', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const deleteBlock = sourceBlock(source, 'function deleteNode(id, event)', 'function outputDownloadName');
    const knifeBlock = sourceBlock(source, 'function applyKnifeCut', 'function setKnifeMode');
    const selectedBlock = sourceBlock(source, 'function deleteSelectedNodes()', 'function hasImageFiles');

    assert.match(deleteBlock, /removeClassicConnections/);
    assert.match(knifeBlock, /removeClassicConnections/);
    assert.match(selectedBlock, /removeClassicConnections/);
});

test('run-button hover wires the real cascade preview to animated stage-aware links and nodes', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const loopBlock = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');
    const terminalBlock = sourceBlock(source, 'function bindCascadeButtons', 'function runCascadeNodeByType');
    const linkBlock = sourceBlock(source, 'function renderLinks()', 'function renderKnifeTrail');

    assert.match(source, /ClassicCascadePlan\.buildCascadePreview/);
    assert.match(loopBlock, /onmouseenter[\s\S]*scope:\s*['"]loop['"]/);
    assert.match(loopBlock, /onmouseleave[\s\S]*clearClassicCascadePreview/);
    assert.match(terminalBlock, /onmouseenter[\s\S]*scope:\s*['"]complete['"]/);
    assert.match(terminalBlock, /onmouseleave[\s\S]*clearClassicCascadePreview/);
    assert.match(linkBlock, /dataset\.connectionId/);
    assert.match(css, /workflow-preview-once/);
    assert.match(css, /workflow-preview-loop/);
    assert.match(css, /@keyframes\s+classic-workflow-flow/);
});
