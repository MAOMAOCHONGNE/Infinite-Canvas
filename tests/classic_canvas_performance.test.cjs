const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const perf = require(path.join(ROOT, 'static/js/classic-canvas-performance.js'));
const canvasSource = fs.readFileSync(path.join(ROOT, 'static/js/canvas.js'), 'utf8');
const canvasHtml = fs.readFileSync(path.join(ROOT, 'static/canvas.html'), 'utf8');
const canvasCss = fs.readFileSync(path.join(ROOT, 'static/css/canvas.css'), 'utf8');

function imageNodes(count=500){
    return Array.from({length:count}, (_, index) => ({
        id:`image-${index}`,
        type:'image',
        url:`/assets/${index}.png`,
        x:(index % 25) * 300,
        y:Math.floor(index / 25) * 380,
        w:260,
        h:336,
    }));
}

test('spatial index limits normal viewport rendering for a 500 image canvas', () => {
    const nodes = imageNodes();
    const index = perf.createSpatialIndex(nodes, node => node);
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const viewRect = {x:0, y:0, w:1200, h:800};
    const tiers = perf.desiredImageTiers({
        index,
        nodesById,
        viewRect,
        bufferedRect:perf.expandRect(viewRect, 0.75, 0.75),
        liteMode:false,
        pinnedIds:new Set(),
        isEligible:node => node.type === 'image',
    });
    assert.ok(tiers.size > 0);
    assert.ok(tiers.size < 100, `expected fewer than 100 mounted images, received ${tiers.size}`);
    assert.ok([...tiers.values()].every(tier => tier === 'full'));
});

test('far zoom uses lightweight images while selected offscreen images stay full', () => {
    const nodes = imageNodes();
    const index = perf.createSpatialIndex(nodes, node => node);
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const pinned = new Set(['image-499']);
    const viewRect = {x:0, y:0, w:8000, h:8000};
    const tiers = perf.desiredImageTiers({
        index,
        nodesById,
        viewRect,
        bufferedRect:viewRect,
        liteMode:true,
        pinnedIds:pinned,
        isEligible:node => node.type === 'image',
    });
    assert.equal(tiers.get('image-0'), 'lite');
    assert.equal(tiers.get('image-499'), 'full');
    assert.ok([...tiers.values()].filter(tier => tier === 'full').length === 1);
});

test('adaptive tiers support every eligible node type without a hard full-node cap', () => {
    const nodes = [
        {id:'output-a', type:'output', x:0, y:0, w:460, h:700},
        {id:'generator-a', type:'generator', x:520, y:0, w:380, h:520},
        {id:'rh-a', type:'rh', x:960, y:0, w:430, h:520},
        {id:'llm-a', type:'llm', x:1450, y:0, w:420, h:590},
        {id:'unknown-a', type:'future-plugin', x:1950, y:0, w:300, h:300},
    ];
    const index = perf.createSpatialIndex(nodes, node => node);
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const tiers = perf.desiredNodeTiers({
        index,
        nodesById,
        viewRect:{x:-100, y:-100, w:2400, h:900},
        bufferedRect:{x:-100, y:-100, w:2400, h:900},
        liteMode:true,
        pinnedIds:new Set(['llm-a']),
        isEligible:node => node.type !== 'future-plugin',
    });
    assert.equal(tiers.get('output-a'), 'lite');
    assert.equal(tiers.get('generator-a'), 'lite');
    assert.equal(tiers.get('rh-a'), 'lite');
    assert.equal(tiers.get('llm-a'), 'full');
    assert.equal(tiers.has('unknown-a'), false);
});

test('connection plan batches overview links and keeps pinned links interactive', () => {
    const nodes = [
        {id:'a', x:0, y:0, w:100, h:100},
        {id:'b', x:300, y:0, w:100, h:100},
        {id:'c', x:8000, y:0, w:100, h:100},
        {id:'d', x:9000, y:1000, w:100, h:100},
        {id:'e', x:9400, y:1000, w:100, h:100},
    ];
    const index = perf.createSpatialIndex(nodes, node => node);
    const connections = [
        {id:'ab', from:'a', to:'b'},
        {id:'bc', from:'b', to:'c'},
        {id:'de', from:'d', to:'e'},
    ];
    const overview = perf.desiredConnectionTiers({
        connections,
        nodeRects:index.rects,
        bufferedRect:{x:-200, y:-200, w:9000, h:600},
        liteMode:true,
        pinnedIds:new Set(['bc']),
    });
    assert.equal(overview.get('ab'), 'batch');
    assert.equal(overview.get('bc'), 'interactive');

    const closeView = perf.desiredConnectionTiers({
        connections,
        nodeRects:index.rects,
        bufferedRect:{x:-100, y:-100, w:700, h:400},
        liteMode:false,
        pinnedIds:new Set(),
    });
    assert.equal(closeView.get('ab'), 'interactive');
    assert.equal(closeView.get('bc'), 'interactive', 'a link crossing the viewport must remain visible');
    assert.equal(closeView.has('de'), false);
});

test('zoom LOD hysteresis prevents repeated tier changes at the boundary', () => {
    assert.equal(perf.nextLiteMode(false, 0.39), true);
    assert.equal(perf.nextLiteMode(false, 0.40), true);
    assert.equal(perf.nextLiteMode(true, 0.49), true);
    assert.equal(perf.nextLiteMode(true, 0.50), false);
    assert.equal(perf.nextLiteMode(false, 0.49), false);
});

test('extreme overview mode uses independent 15%-22% hysteresis', () => {
    assert.equal(perf.nextRenderMode('full', 0.14), 'far');
    assert.equal(perf.nextRenderMode('full', 0.15), 'far');
    assert.equal(perf.nextRenderMode('far', 0.21), 'far');
    assert.equal(perf.nextRenderMode('far', 0.22), 'lite');
    assert.equal(perf.nextRenderMode('lite', 0.16), 'lite');
    assert.equal(perf.nextRenderMode('lite', 0.15), 'far');
    assert.equal(perf.nextRenderMode('lite', 0.50), 'full');
    assert.equal(perf.nextRenderMode('full', 0.45), 'full');
});

test('active wheel interaction may lower detail immediately but defers upgrades until idle', () => {
    assert.equal(perf.nextRenderModeDuringInteraction('full', 0.39), 'lite');
    assert.equal(perf.nextRenderModeDuringInteraction('full', 0.14), 'far');
    assert.equal(perf.nextRenderModeDuringInteraction('lite', 0.14), 'far');
    assert.equal(perf.nextRenderModeDuringInteraction('far', 0.25), 'far');
    assert.equal(perf.nextRenderModeDuringInteraction('lite', 0.55), 'lite');
});

test('extreme overview keeps pinned nodes full and turns other visible nodes into far shells', () => {
    const nodes = [
        {id:'output-a', type:'output', x:0, y:0, w:460, h:700},
        {id:'generator-a', type:'generator', x:520, y:0, w:380, h:520},
        {id:'running-a', type:'llm', x:960, y:0, w:420, h:590},
    ];
    const index = perf.createSpatialIndex(nodes, node => node);
    const tiers = perf.desiredNodeTiers({
        index,
        nodesById:new Map(nodes.map(node => [node.id, node])),
        viewRect:{x:-100, y:-100, w:1800, h:900},
        bufferedRect:{x:-100, y:-100, w:1800, h:900},
        renderMode:'far',
        pinnedIds:new Set(['running-a']),
        isEligible:() => true,
    });
    assert.deepEqual(Object.fromEntries(tiers), {
        'output-a':'far',
        'generator-a':'far',
        'running-a':'full',
    });
});

test('far output blueprint preserves every result and pending slot in source order', () => {
    const blueprint = perf.farNodeBlueprint({
        id:'out-1',
        type:'output',
        images:['/output/a.png', {url:'/output/b.png'}, {output_url:'/output/c.png'}],
        _pending:[{id:'pending-1'}, {id:'pending-2'}],
    });
    assert.equal(blueprint.family, 'output');
    assert.deepEqual(blueprint.ports, {input:true, output:true});
    assert.deepEqual(blueprint.mediaSlots, [
        {url:'/output/a.png', pending:false},
        {url:'/output/b.png', pending:false},
        {url:'/output/c.png', pending:false},
        {url:'', pending:true},
        {url:'', pending:true},
    ]);
});

test('an empty output blueprint stays empty instead of inventing a placeholder result slot', () => {
    const blueprint = perf.farNodeBlueprint({id:'out-empty', type:'output', images:[], _pending:[]});
    assert.equal(blueprint.mediaSlots.length, 0);
});

test('far blueprints retain node-family landmarks without inventing ports', () => {
    const cases = [
        [{type:'image', url:'/assets/a.png'}, 'image', {input:false, output:true}, false],
        [{type:'generator', model:'gpt-image-1'}, 'generator', {input:true, output:true}, true],
        [{type:'llm', model:'gpt-5'}, 'llm', {input:true, output:true}, true],
        [{type:'loop'}, 'loop', {input:true, output:true}, true],
        [{type:'ltxDirector'}, 'generator', {input:true, output:true}, true],
        [{type:'prompt', text:'hello'}, 'text', {input:false, output:true}, false],
        [{type:'note', text:'memo'}, 'note', {input:false, output:false}, false],
    ];
    cases.forEach(([node, family, ports, action]) => {
        const blueprint = perf.farNodeBlueprint(node);
        assert.equal(blueprint.family, family, node.type);
        assert.deepEqual(blueprint.ports, ports, node.type);
        assert.equal(blueprint.showAction, action, node.type);
    });
});

test('extreme overview caches ordinary links while pinned links stay interactive', () => {
    const nodeRects = new Map([
        ['a', {x:0, y:0, w:100, h:100}],
        ['b', {x:300, y:0, w:100, h:100}],
        ['c', {x:600, y:0, w:100, h:100}],
    ]);
    const tiers = perf.desiredConnectionTiers({
        connections:[
            {id:'ab', from:'a', to:'b'},
            {id:'bc', from:'b', to:'c'},
        ],
        nodeRects,
        bufferedRect:{x:-100, y:-100, w:900, h:400},
        renderMode:'far',
        pinnedIds:new Set(['bc']),
    });
    assert.equal(tiers.get('ab'), 'cached');
    assert.equal(tiers.get('bc'), 'interactive');
});

test('far link cache raster follows visible zoom and stays below a safe texture cap', () => {
    assert.deepEqual(perf.farLinkRasterSize(12000, 10000, 0.08, 1), {width:960, height:800});
    assert.deepEqual(perf.farLinkRasterSize(24000, 18000, 0.15, 2), {width:2048, height:2048});
    assert.deepEqual(perf.farLinkRasterSize(0, 0, 0.08, 1), {width:1, height:1});
});

test('far output raster follows on-screen size and stays below a small memory cap', () => {
    assert.deepEqual(perf.farOutputRasterSize(460, 700, 0.10, 2), {width:92, height:140});
    assert.deepEqual(perf.farOutputRasterSize(12000, 9000, 0.15, 2), {width:512, height:384});
    assert.deepEqual(perf.farOutputRasterSize(0, 0, 0.10, 1), {width:1, height:1});
});

test('per-canvas geometry cache only restores entries with a matching node signature', () => {
    const values = new Map();
    const storage = {
        getItem:key => values.get(key) || null,
        setItem:(key, value) => values.set(key, value),
    };
    perf.writeNodeGeometryCache(storage, 'canvas-a', [
        ['node-a', {w:420, h:590, signature:'llm:v1'}],
        ['node-b', {w:460, h:700, signature:'output:v1'}],
    ]);
    const restored = perf.readNodeGeometryCache(storage, 'canvas-a', id => id === 'node-a' ? 'llm:v1' : 'changed');
    assert.deepEqual([...restored], [['node-a', {w:420, h:590, signature:'llm:v1', exact:true}]]);
    assert.equal(perf.readNodeGeometryCache(storage, 'canvas-b', () => '').size, 0);
});

test('model-space marquee selection includes virtual images and fully enclosed frames only', () => {
    const nodes = [
        {id:'image-a', type:'image', x:10, y:10, w:100, h:100},
        {id:'image-b', type:'image', x:180, y:180, w:100, h:100},
        {id:'frame-in', type:'canvas-frame', x:20, y:20, w:80, h:80},
        {id:'frame-cut', type:'canvas-frame', x:150, y:150, w:100, h:100},
    ];
    const index = perf.createSpatialIndex(nodes, node => node);
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const selected = perf.selectionFromWorldRect({
        index,
        nodesById,
        rect:{x:0, y:0, w:200, h:200},
        isFrame:node => node.type === 'canvas-frame',
    });
    assert.deepEqual(new Set(selected), new Set(['image-a', 'image-b', 'frame-in']));
});

test('performance opt-out is stored independently for each canvas', () => {
    const values = new Map();
    const storage = {
        getItem:key => values.get(key) || null,
        setItem:(key, value) => values.set(key, value),
    };
    perf.setCanvasDisabled(storage, 'canvas-a', true);
    assert.equal(perf.canvasDisabled(storage, 'canvas-a'), true);
    assert.equal(perf.canvasDisabled(storage, 'canvas-b'), false);
    perf.setCanvasDisabled(storage, 'canvas-a', false);
    assert.equal(perf.canvasDisabled(storage, 'canvas-a'), false);
});

test('classic canvas integrates the reversible performance path without changing saved nodes', () => {
    assert.match(canvasHtml, /id="canvasPerformanceToggle"/);
    assert.match(canvasHtml, /classic-canvas-performance\.js/);
    assert.match(canvasSource, /function canvasPerformanceIsAvailable\(\)[\s\S]*Boolean\(CanvasPerformance && canvas\?\.id\)/);
    assert.match(canvasSource, /CanvasPerformance\.setCanvasDisabled\(window\.localStorage, canvas\.id, disable\)/);
    assert.match(canvasSource, /document\.createDocumentFragment\(\)/);
    assert.match(canvasSource, /CanvasPerformance\.selectionFromWorldRect/);
    assert.match(canvasSource, /function dehydrateCanvasPerformanceNode/);
    assert.match(canvasSource, /function rehydrateCanvasPerformanceNode/);
    assert.match(canvasSource, /CanvasPerformance\.desiredNodeTiers/);
    assert.match(canvasSource, /CanvasPerformance\.desiredConnectionTiers/);
    assert.match(canvasSource, /canvas-perf-link-batch/);
    assert.match(canvasSource, /elementFromPoint[\s\S]*link-hit/);
    assert.match(canvasSource, /function isZoomPreviewIgnoredTarget[\s\S]*#canvasPerformanceToggle/);
    const viewportBlock = canvasSource.slice(canvasSource.indexOf('function applyViewport(){'), canvasSource.indexOf('function estimatedNodeRect'));
    assert.doesNotMatch(viewportBlock, /renderLinks\(/);
    assert.doesNotMatch(viewportBlock, /syncCanvasSelectedImageResolution\(/);
    assert.match(viewportBlock, /markCanvasViewportInteraction\(\)/);
});

test('lightweight nodes preserve the full renderer structure and only dehydrate media', () => {
    const performanceBlock = canvasSource.slice(
        canvasSource.indexOf('function dehydrateCanvasPerformanceNode'),
        canvasSource.indexOf('function scheduleCanvasPerformanceReconcile')
    );
    assert.match(performanceBlock, /const element = renderNode\(node\)/);
    assert.match(performanceBlock, /canvasMediaPreviewUrl\(original,\s*CANVAS_PERFORMANCE_LITE_MEDIA_WIDTH\)/);
    assert.match(performanceBlock, /data-canvas-performance-full-preview/);
    assert.match(performanceBlock, /current\.dataset\.canvasPerformanceTier === ['"]full['"][\s\S]*dehydrateCanvasPerformanceNode\(current, node\)/);
    assert.match(performanceBlock, /current\.dataset\.canvasPerformanceTier === ['"]lite['"][\s\S]*rehydrateCanvasPerformanceNode\(current, node\)/);
    assert.doesNotMatch(performanceBlock, /canvasPerformanceDirectMediaRefs/);
    assert.doesNotMatch(performanceBlock, /renderCanvasPerformanceLiteOutput/);
    assert.doesNotMatch(performanceBlock, /renderCanvasPerformanceLiteGenerator/);
    assert.match(canvasCss, /\.node\.canvas-perf-node-lite\s*>\s*\*/);
    assert.doesNotMatch(canvasCss, /canvas-perf-output-lite-grid/);
    assert.doesNotMatch(canvasCss, /\.node\.canvas-perf-node-lite\s*\{[^}]*contain\s*:/);
});

test('idle API nodes freeze expensive controls while active task states stay full', () => {
    const performanceBlock = canvasSource.slice(
        canvasSource.indexOf('const CANVAS_PERFORMANCE_ACTIVE_STATUSES'),
        canvasSource.indexOf('function scheduleCanvasPerformanceReconcile')
    );
    for(const status of ['queued','submitting','running','generating','recovering','stopping','cancelling']){
        assert.match(performanceBlock, new RegExp(`['"]${status}['"]`), `missing active state ${status}`);
    }
    assert.match(performanceBlock, /function freezeCanvasPerformanceGeneratorBody/);
    assert.match(performanceBlock, /cloneNode\(true\)/);
    assert.match(performanceBlock, /querySelectorAll\(['"]select['"]\)/);
    assert.match(performanceBlock, /querySelectorAll\(['"]textarea, input['"]\)/);
    assert.match(performanceBlock, /querySelectorAll\(['"]option['"]\)/);
    assert.match(performanceBlock, /canvas-perf-generator-frozen/);
    assert.match(performanceBlock, /node\?\.type !== ['"]generator['"]/);
    assert.match(canvasCss, /\.canvas-perf-static-control/);
    assert.match(canvasCss, /\.generator-node\.canvas-perf-generator-frozen/);
});

test('lightweight media width is 128 pixels and cache markers reference the updated assets', () => {
    assert.match(canvasSource, /const CANVAS_PERFORMANCE_LITE_MEDIA_WIDTH = 128/);
    assert.match(canvasHtml, /classic-canvas-performance\.js\?v=[^"']+/);
    assert.match(canvasHtml, /canvas\.js\?v=[^"']+/);
    assert.match(canvasHtml, /canvas\.css\?v=[^"']+/);
});

test('performance mode supports far shells for all eligible node families', () => {
    const typeBlock = canvasSource.slice(
        canvasSource.indexOf('const CANVAS_PERFORMANCE_NODE_TYPES'),
        canvasSource.indexOf('const CANVAS_PERFORMANCE_ACTIVE_STATUSES')
    );
    for(const type of ['image','prompt','note','loop','promptGroup','group','output','llm','generator','midjourney','msgen','video','minimax','rh','comfy','ltxDirector']){
        assert.match(typeBlock, new RegExp(`['"]${type}['"]`), `missing performance type ${type}`);
    }
    assert.match(canvasSource, /function renderCanvasPerformanceFarNode/);
    assert.match(canvasSource, /CanvasPerformance\.farNodeBlueprint\(node\)/);
    assert.match(canvasSource, /tier === ['"]far['"][\s\S]*renderCanvasPerformanceFarNode\(node\)/);
    assert.match(canvasSource, /canvas-perf-far-output/);
    assert.match(canvasCss, /\.node\.canvas-perf-node-far/);
    assert.match(canvasHtml, /id="canvasFarLinks"/);
    assert.match(canvasSource, /function renderCanvasPerformanceFarLinkCache/);
    assert.match(canvasSource, /tier === ['"]cached['"]/);
    assert.match(canvasSource, /function canvasPerformanceLiteImageDropTarget/);
    const cacheBlock = canvasSource.slice(
        canvasSource.indexOf('function cacheRenderedCanvasNodeSizes'),
        canvasSource.indexOf('function markCanvasGeometryDirty')
    );
    assert.doesNotMatch(cacheBlock, /classList\.contains\(['"]canvas-perf-node-lite['"]\)/);
    assert.match(cacheBlock, /classList\.contains\(['"]canvas-perf-node-far['"]\)/);
    assert.match(canvasSource, /CanvasPerformance\.nextRenderModeDuringInteraction/);
    assert.match(canvasSource, /CanvasPerformance\.readNodeGeometryCache/);
    assert.match(canvasSource, /function scheduleCanvasPerformanceFarOutputDraw/);
    assert.match(canvasSource, /canvasPerformanceFarPreviewImages/);
    assert.match(canvasSource, /querySelectorAll(?:\?\.)?\(['"]canvas\.canvas-perf-far-output['"]\)/);
    assert.doesNotMatch(canvasSource, /querySelectorAll(?:\?\.)?\(['"]\.canvas-perf-far-output['"]\)/);
    assert.match(canvasSource, /llmPromptWorkspaceState\?\.nodeId === node\.id/);
    const dragBlock = canvasSource.slice(
        canvasSource.indexOf('function startNodeDrag'),
        canvasSource.indexOf('function onNodeDrag')
    );
    assert.match(dragBlock, /reconcileCanvasPerformanceNodes\(true\)[\s\S]*prepareNodeDragVisualState/);
});
