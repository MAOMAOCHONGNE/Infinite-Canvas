const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const canvasSource = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');

function wheelHandlerSource(){
    const start = canvasSource.indexOf('board.onwheel = e => {');
    const end = canvasSource.indexOf("board.addEventListener('dragover'", start);
    assert.ok(start >= 0 && end > start, 'classic canvas wheel handler must exist');
    return canvasSource.slice(start, end);
}

function wheelSchedulerSource(){
    return sourceBetween('function scheduleCanvasWheelViewportApply(', 'function flushCanvasWheelViewportWork(')
        + sourceBetween('function flushCanvasWheelViewportWork(', 'function estimatedNodeRect(');
}

function sourceBetween(startMarker, endMarker){
    const start = canvasSource.indexOf(startMarker);
    const end = canvasSource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} must be complete`);
    return canvasSource.slice(start, end);
}

function applyViewportSource(){
    const start = canvasSource.indexOf('function applyViewport(){');
    const end = canvasSource.indexOf('function estimatedNodeRect(', start);
    assert.ok(start >= 0 && end > start, 'classic canvas viewport transform helper must exist');
    return canvasSource.slice(start, end);
}

function viewportOverlaySchedulerSource(){
    const start = canvasSource.indexOf('function viewportRectFitsMinimapBounds(');
    assert.ok(start >= 0, 'classic canvas must have a fast viewport overlay scheduler');
    const end = canvasSource.indexOf('function renderMinimap()', start);
    assert.ok(end > start, 'classic canvas viewport overlay scheduler must be complete');
    return canvasSource.slice(start, end);
}

function runWheelEvents(deltaValues, options={}){
    const run = new Function('deltaValues', 'options', `
        let canvas = {id:'canvas-1'};
        let viewport = {x:10, y:20, scale:1};
        let prevented = 0;
        let linkRenders = 0;
        let selectionContentRenders = 0;
        let selectionPositions = 0;
        let minimapFullRenders = 0;
        let minimapViewportUpdates = 0;
        let viewportSaves = 0;
        let viewportTransforms = 0;
        let minimapRenderQueued = false;
        let minimapGeometryDirty = false;
        let linksRenderQueued = false;
        let viewportOverlayUpdateQueued = false;
        let minimapState = {
            bounds:options.bounds || {x:-10000, y:-10000, w:20000, h:20000}
        };
        const frameCallbacks = new Map();
        let nextFrameId = 1;
        const requestAnimationFrame = callback => { const id = nextFrameId++; frameCallbacks.set(id, callback); return id; };
        const cancelAnimationFrame = id => frameCallbacks.delete(id);
        const timerCallbacks = new Map();
        let nextTimerId = 1;
        const setTimeout = (callback, delay) => { const id = nextTimerId++; timerCallbacks.set(id, {callback, delay}); return id; };
        const clearTimeout = id => timerCallbacks.delete(id);
        const worldStyle = {};
        Object.defineProperty(worldStyle, 'transform', {
            get:() => worldStyle._transform || '',
            set:value => { worldStyle._transform = value; viewportTransforms += 1; }
        });
        const world = {style:worldStyle};
        const nodesEl = {};
        const board = {
            onwheel:null,
            getBoundingClientRect:() => ({left:100, top:50, width:800, height:600})
        };
        const screenToWorld = (clientX, clientY) => ({
            x:(clientX - 100 - viewport.x) / viewport.scale,
            y:(clientY - 50 - viewport.y) / viewport.scale
        });
        const currentWorldViewRect = () => ({
            x:-viewport.x / viewport.scale,
            y:-viewport.y / viewport.scale,
            w:800 / viewport.scale,
            h:600 / viewport.scale
        });
        const safeViewportScale = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 1;
        const scheduleCanvasImageResolutionSync = () => {};
        const renderLinks = () => { linkRenders += 1; };
        const renderSelectionHub = () => { selectionContentRenders += 1; };
        const positionSelectionHub = () => { selectionPositions += 1; };
        const updateMinimapViewport = () => { minimapViewportUpdates += 1; };
        function renderMinimap(){
            minimapFullRenders += 1;
            minimapGeometryDirty = false;
            minimapState = {bounds:{...currentWorldViewRect()}};
        }
        const saveLocalViewport = () => { viewportSaves += 1; };
        let canvasWheelViewportFrame = 0;
        let canvasWheelViewportSaveTimer = 0;
        ${viewportOverlaySchedulerSource()}
        ${applyViewportSource()}
        ${wheelSchedulerSource()}
        ${wheelHandlerSource()}
        deltaValues.forEach(deltaY => board.onwheel({
            deltaY,
            clientX:300,
            clientY:250,
            preventDefault:() => { prevented += 1; }
        }));
        const beforeFrame = {linkRenders, selectionContentRenders, selectionPositions, minimapFullRenders, minimapViewportUpdates, viewportTransforms, viewportSaves};
        while(frameCallbacks.size){
            const currentFrame = [...frameCallbacks.values()];
            frameCallbacks.clear();
            currentFrame.forEach(callback => callback());
        }
        const afterFrame = {viewportTransforms, viewportSaves};
        [...timerCallbacks.values()].forEach(item => item.callback());
        timerCallbacks.clear();
        return {
            viewport,
            prevented,
            linkRenders,
            selectionContentRenders,
            selectionPositions,
            minimapFullRenders,
            minimapViewportUpdates,
            viewportSaves,
            viewportTransforms,
            compositorHint:world.style.willChange || '',
            beforeFrame,
            afterFrame
        };
    `);
    return run(deltaValues, options);
}

test('classic canvas wheel zoom honors the wheel delta and keeps the pointer anchored', () => {
    const result = runWheelEvents([-100]);

    assert.ok(Math.abs(result.viewport.scale - 1.1051709180756477) < 1e-12);
    assert.ok(Math.abs(result.viewport.x - (-9.982474434373074)) < 1e-9);
    assert.ok(Math.abs(result.viewport.y - 1.0692347463834153) < 1e-9);
    assert.equal(result.prevented, 1);
});

test('classic viewport changes do not keep the canvas rasterized as one compositor texture', () => {
    const result = runWheelEvents([-100]);

    assert.equal(result.compositorHint, '');
});

test('classic canvas wheel only updates viewport overlays once per animation frame', () => {
    const result = runWheelEvents([-20, -30, -50]);

    assert.deepEqual(result.beforeFrame, {
        linkRenders:0,
        selectionContentRenders:0,
        selectionPositions:0,
        minimapFullRenders:0,
        minimapViewportUpdates:0,
        viewportTransforms:0,
        viewportSaves:0
    });
    assert.equal(result.linkRenders, 0);
    assert.equal(result.selectionContentRenders, 0);
    assert.equal(result.selectionPositions, 1);
    assert.equal(result.minimapFullRenders, 0);
    assert.equal(result.minimapViewportUpdates, 1);
    assert.deepEqual(result.afterFrame, {viewportTransforms:1, viewportSaves:0});
    assert.equal(result.viewportSaves, 1);
    assert.equal(result.viewportTransforms, 1);
});

test('classic canvas rebuilds the minimap only after the viewport leaves cached bounds', () => {
    const result = runWheelEvents([20], {bounds:{x:0, y:0, w:10, h:10}});

    assert.equal(result.linkRenders, 0);
    assert.equal(result.selectionContentRenders, 0);
    assert.equal(result.selectionPositions, 1);
    assert.equal(result.minimapFullRenders, 1);
    assert.equal(result.minimapViewportUpdates, 0);
});

test('classic canvas minimap navigation moves only the viewport world', () => {
    const run = new Function(`
        let viewport = {x:0, y:0, scale:2};
        let viewportApplies = 0;
        let linkRenders = 0;
        let selectionContentRenders = 0;
        const board = {getBoundingClientRect:() => ({width:800, height:600})};
        const applyViewport = () => { viewportApplies += 1; };
        const renderLinks = () => { linkRenders += 1; };
        const renderSelectionHub = () => { selectionContentRenders += 1; };
        ${sourceBetween('function centerViewportOnWorldPoint(', 'function safeViewportScale(',)}
        centerViewportOnWorldPoint({x:150, y:75});
        return {viewport, viewportApplies, linkRenders, selectionContentRenders};
    `);
    const result = run();

    assert.deepEqual(result.viewport, {x:100, y:150, scale:2});
    assert.equal(result.viewportApplies, 1);
    assert.equal(result.linkRenders, 0);
    assert.equal(result.selectionContentRenders, 0);
});

test('classic canvas selection start clears stale connection hover once', () => {
    const run = new Function(`
        let selectDrag = null;
        let clearedHover = 0;
        let selectionUpdates = 0;
        const selectionBox = {style:{}};
        const window = {};
        const document = {
            activeElement:null,
            body:{classList:{add:() => {}}}
        };
        const setHoveredConnection = id => {
            if(id === '') clearedHover += 1;
        };
        const updateSelectionBox = () => { selectionUpdates += 1; };
        const finishSelection = () => {};
        ${sourceBetween('function startSelection(', 'function updateSelectionBox(')}
        const event = {
            clientX:120,
            clientY:160,
            preventDefault:() => {},
            stopPropagation:() => {}
        };
        startSelection(event);
        return {selectDrag, clearedHover, selectionUpdates, hasMove:typeof window.onmousemove === 'function', hasUp:typeof window.onmouseup === 'function'};
    `);
    const result = run();

    assert.deepEqual(result, {
        selectDrag:{sx:120, sy:160, x:120, y:160},
        clearedHover:1,
        selectionUpdates:1,
        hasMove:true,
        hasUp:true
    });
});

test('classic canvas skips connection hover work while marquee selection is active', () => {
    const handlerSource = sourceBetween("board.addEventListener('mousemove', e => {", "board.addEventListener('mouseleave'",);
    const run = new Function(`
        let selectDrag = {sx:10, sy:20};
        let canvas = {id:'canvas-1'};
        let knifeActive = false;
        let dragNode = null;
        let dragBoard = null;
        let resizeNode = null;
        let tempLink = null;
        let coordinateReads = 0;
        let hoverUpdates = 0;
        let knifeContinues = 0;
        let knifeClears = 0;
        let lastMouseBoard = null;
        const board = {addEventListener:(name, handler) => {
            if(name === 'mousemove') board.mousemove = handler;
        }};
        const screenToWorld = () => { coordinateReads += 1; return {x:4,y:5}; };
        const updateConnectionHoverFromMouse = () => { hoverUpdates += 1; };
        const isEditableTarget = () => false;
        const continueKnifeDrag = () => { knifeContinues += 1; };
        const setKnifeMode = () => { knifeClears += 1; };
        ${handlerSource}
        board.mousemove({target:{}, shiftKey:false});
        const duringSelection = {coordinateReads, hoverUpdates, knifeContinues, knifeClears, lastMouseBoard};
        selectDrag = null;
        board.mousemove({target:{}, shiftKey:false});
        return {duringSelection, afterSelection:{coordinateReads, hoverUpdates, knifeContinues, knifeClears, lastMouseBoard}};
    `);
    const result = run();

    assert.deepEqual(result.duringSelection, {
        coordinateReads:0,
        hoverUpdates:0,
        knifeContinues:0,
        knifeClears:0,
        lastMouseBoard:null
    });
    assert.deepEqual(result.afterSelection, {
        coordinateReads:1,
        hoverUpdates:1,
        knifeContinues:0,
        knifeClears:1,
        lastMouseBoard:{x:4,y:5}
    });
});

test('classic canvas selection finish refreshes only selection visuals', () => {
    const run = new Function(`
        let selectDrag = {sx:10, sy:10, x:160, y:160};
        let visualRefreshes = 0;
        let fullRenders = 0;
        const selected = new Set(['stale']);
        const elements = [
            {dataset:{id:'inside'}, getBoundingClientRect:() => ({left:20, top:20, right:80, bottom:80})},
            {dataset:{id:'overlap'}, getBoundingClientRect:() => ({left:140, top:140, right:220, bottom:220})},
            {dataset:{id:'outside'}, getBoundingClientRect:() => ({left:240, top:240, right:300, bottom:300})}
        ];
        const selectionBox = {
            style:{display:'block'},
            getBoundingClientRect:() => ({left:10, top:10, right:160, bottom:160})
        };
        const nodesEl = {querySelectorAll:selector => selector === '.canvas-frame-node' ? [] : elements};
        const nodes = elements.map(element => ({id:element.dataset.id, type:'image'}));
        const SpatialFrames = {collectMoveIds:() => []};
        const isCanvasFrameNode = node => node?.type === 'canvas-frame';
        const document = {body:{classList:{remove:() => {}}}};
        const window = {onmousemove:() => {}, onmouseup:() => {}};
        const refreshSelectionVisuals = () => { visualRefreshes += 1; };
        const render = () => { fullRenders += 1; };
        ${sourceBetween('function selectionRectFullyContains(', 'function renderSelectionHub(')}
        finishSelection();
        return {
            selected:[...selected],
            selectDrag,
            display:selectionBox.style.display,
            visualRefreshes,
            fullRenders,
            moveHandler:window.onmousemove,
            upHandler:window.onmouseup
        };
    `);
    const result = run();

    assert.deepEqual(result, {
        selected:['inside', 'overlap'],
        selectDrag:null,
        display:'none',
        visualRefreshes:1,
        fullRenders:0,
        moveHandler:null,
        upHandler:null
    });
});

test('classic canvas marquee visual stays aligned below the independent top bar', () => {
    const run = new Function(`
        let selectDrag = {sx:120, sy:90, x:120, y:90};
        const selectionBox = {style:{}};
        const board = {getBoundingClientRect:() => ({left:20, top:49})};
        ${sourceBetween('function updateSelectionBox(', 'function selectionRectFullyContains(')}
        updateSelectionBox(360, 290);
        return {selectDrag, style:selectionBox.style};
    `);

    assert.deepEqual(run(), {
        selectDrag:{sx:120, sy:90, x:360, y:290},
        style:{left:'100px', top:'41px', width:'240px', height:'200px'}
    });
});

test('classic canvas marquee selects only fully enclosed frames and removes their selected members', () => {
    const run = new Function(`
        let selectDrag = {sx:0, sy:0, x:300, y:300};
        const selected = new Set(['stale']);
        const ordinaryElements = [
            {dataset:{id:'frame-child'}, getBoundingClientRect:() => ({left:40, top:70, right:100, bottom:130})},
            {dataset:{id:'nested-child'}, getBoundingClientRect:() => ({left:110, top:70, right:170, bottom:130})},
            {dataset:{id:'outside-independent'}, getBoundingClientRect:() => ({left:280, top:80, right:340, bottom:140})}
        ];
        const frameElements = [
            {dataset:{id:'frame-full'}, getBoundingClientRect:() => ({left:20, top:20, right:220, bottom:220})},
            {dataset:{id:'frame-partial'}, getBoundingClientRect:() => ({left:260, top:30, right:360, bottom:180})}
        ];
        const nodesEl = {
            querySelectorAll:selector => selector === '.canvas-frame-node' ? frameElements : ordinaryElements
        };
        const nodes = [
            {id:'frame-full', type:'canvas-frame', items:['frame-child']},
            {id:'frame-partial', type:'canvas-frame', items:[]},
            {id:'frame-child', type:'group', items:['nested-child']},
            {id:'nested-child', type:'image'},
            {id:'outside-independent', type:'image'}
        ];
        const isCanvasFrameNode = node => node?.type === 'canvas-frame';
        const SpatialFrames = {
            collectMoveIds:(allNodes, rootIds) => {
                const lookup = new Map(allNodes.map(node => [node.id, node]));
                const seen = new Set();
                const collect = id => {
                    if(seen.has(id)) return;
                    const node = lookup.get(id);
                    if(!node) return;
                    seen.add(id);
                    if(node.type === 'canvas-frame' || node.type === 'group' || node.type === 'promptGroup'){
                        (node.items || []).forEach(collect);
                    }
                };
                rootIds.forEach(collect);
                return [...seen];
            }
        };
        const selectionBox = {
            style:{display:'block'},
            getBoundingClientRect:() => ({left:0, top:0, right:300, bottom:300})
        };
        const document = {body:{classList:{remove:() => {}}}};
        const window = {onmousemove:() => {}, onmouseup:() => {}};
        let visualRefreshes = 0;
        const refreshSelectionVisuals = () => { visualRefreshes += 1; };
        ${sourceBetween('function selectionRectFullyContains(', 'function renderSelectionHub(')}
        finishSelection();
        return {selected:[...selected], visualRefreshes};
    `);

    assert.deepEqual(run(), {
        selected:['outside-independent', 'frame-full'],
        visualRefreshes:1
    });
});

test('classic canvas marquee keeps multiple enclosed frames but removes both member closures', () => {
    const run = new Function(`
        let selectDrag = {sx:0, sy:0, x:500, y:400};
        const selected = new Set();
        const ordinaryElements = [
            {dataset:{id:'member-a'}, getBoundingClientRect:() => ({left:40, top:60, right:80, bottom:100})},
            {dataset:{id:'member-b'}, getBoundingClientRect:() => ({left:280, top:60, right:320, bottom:100})},
            {dataset:{id:'external'}, getBoundingClientRect:() => ({left:450, top:350, right:530, bottom:430})}
        ];
        const frameElements = [
            {dataset:{id:'frame-a'}, getBoundingClientRect:() => ({left:20, top:20, right:200, bottom:220})},
            {dataset:{id:'frame-b'}, getBoundingClientRect:() => ({left:250, top:20, right:430, bottom:220})}
        ];
        const nodesEl = {querySelectorAll:selector => selector === '.canvas-frame-node' ? frameElements : ordinaryElements};
        const nodes = [
            {id:'frame-a', type:'canvas-frame', items:['member-a']},
            {id:'frame-b', type:'canvas-frame', items:['member-b']},
            {id:'member-a', type:'image'},
            {id:'member-b', type:'image'},
            {id:'external', type:'image'}
        ];
        const isCanvasFrameNode = node => node?.type === 'canvas-frame';
        const SpatialFrames = {
            collectMoveIds:(allNodes, rootIds) => [...rootIds, ...rootIds.flatMap(id => allNodes.find(node => node.id === id)?.items || [])]
        };
        const selectionBox = {style:{display:'block'}, getBoundingClientRect:() => ({left:0, top:0, right:500, bottom:400})};
        const document = {body:{classList:{remove:() => {}}}};
        const window = {onmousemove:() => {}, onmouseup:() => {}};
        const refreshSelectionVisuals = () => {};
        ${sourceBetween('function selectionRectFullyContains(', 'function renderSelectionHub(')}
        finishSelection();
        return [...selected];
    `);

    assert.deepEqual(run(), ['external', 'frame-a', 'frame-b']);
});

test('classic canvas node movement schedules the incremental drag visuals instead of full geometry rebuilds', () => {
    const run = new Function(`
        let dragVisualSchedules = 0;
        let undoRecords = 0;
        const viewport = {scale:1};
        const element = {style:{}};
        let dragNode = {
            node:{id:'node-1', x:10, y:20},
            children:[],
            sx:100,
            sy:100,
            ox:10,
            oy:20,
            historyCaptured:false
        };
        const pushUndo = () => { undoRecords += 1; };
        const canvasNodeElement = () => element;
        const scheduleNodeDragVisualUpdate = () => { dragVisualSchedules += 1; };
        const workflowTransferModal = null;
        const updateWorkflowTransferMeta = () => {};
        ${sourceBetween('function onNodeDrag(', 'function startNodeResize(',)}
        onNodeDrag({clientX:130, clientY:145});
        return {dragNode, element, dragVisualSchedules, undoRecords};
    `);
    const result = run();

    assert.equal(result.dragNode.node.x, 40);
    assert.equal(result.dragNode.node.y, 65);
    assert.deepEqual(result.element.style, {left:'40px', top:'65px'});
    assert.equal(result.dragVisualSchedules, 1);
    assert.equal(result.undoRecords, 1);
});

test('classic canvas drag measures only affected connection ports and keeps existing controls', () => {
    const updateSource = sourceBetween('function updateNodeDragLinkEntries(', 'function updateNodeDragMinimapEntries(');
    const run = new Function(`
        const nodeDragElementIsCurrent = element => Boolean(element) && element.isConnected !== false;
        const updateLinkPathGeometry = (element, a, b) => { element.geometry = {a:{...a}, b:{...b}}; };
        const portCalls = [];
        const portPoint = (id, kind) => {
            portCalls.push(id + ':' + kind);
            return ({
                'moving:out':{x:40,y:35},
                'fixed:in':{x:100,y:40},
                'other:in':{x:70,y:10},
            })[id + ':' + kind];
        };
        ${updateSource}
        const makeElement = () => ({isConnected:true, style:{}});
        const first = {
            visible:makeElement(), hit:makeElement(), button:makeElement(),
            connection:{from:'moving', to:'fixed'}
        };
        const second = {
            visible:makeElement(), hit:makeElement(), button:makeElement(),
            connection:{from:'moving', to:'other'}
        };
        const updated = updateNodeDragLinkEntries([first, second]);
        return {updated, first, second, portCalls};
    `);
    const result = run();

    assert.equal(result.updated, true);
    assert.deepEqual(result.first.visible.geometry, {a:{x:40,y:35}, b:{x:100,y:40}});
    assert.deepEqual(result.first.hit.geometry, result.first.visible.geometry);
    assert.deepEqual(result.first.button.style, {left:'70px', top:'37.5px'});
    assert.deepEqual(result.second.visible.geometry, {a:{x:40,y:35}, b:{x:70,y:10}});
    assert.deepEqual(result.second.button.style, {left:'55px', top:'22.5px'});
    assert.deepEqual(result.portCalls, ['moving:out', 'fixed:in', 'other:in']);
});

test('classic canvas drag moves only cached minimap markers and requests a rebuild after leaving bounds', () => {
    const updateSource = sourceBetween('function updateNodeDragMinimapEntries(', 'function refreshNodeDragVisuals(');
    const run = new Function(`
        const nodeDragElementIsCurrent = element => Boolean(element) && element.isConnected !== false;
        const viewportRectFitsMinimapBounds = (rect, bounds) => rect.x >= bounds.x && rect.y >= bounds.y
            && rect.x + rect.w <= bounds.x + bounds.w && rect.y + rect.h <= bounds.y + bounds.h;
        let minimapState = {bounds:{x:0,y:0,w:500,h:400}, scale:0.2, ox:5, oy:7};
        ${updateSource}
        const marker = {isConnected:true, style:{}};
        const node = {x:100, y:80};
        const cache = {state:minimapState, entries:[{node, marker, w:200, h:100}]};
        const first = updateNodeDragMinimapEntries(cache);
        node.x = 450;
        const second = updateNodeDragMinimapEntries(cache);
        return {first, second, style:marker.style};
    `);
    const result = run();

    assert.equal(result.first, true);
    assert.equal(result.second, false);
    assert.deepEqual(result.style, {left:'25px', top:'23px', width:'40px', height:'20px'});
});

test('classic canvas coalesces repeated drag visual requests into one animation frame', () => {
    const scheduleSource = sourceBetween('function scheduleNodeDragVisualUpdate(', 'function finishNodeDragVisuals(');
    const run = new Function(`
        let nodeDragVisualFrame = 0;
        let dragNode = {id:'node-1'};
        let refreshes = 0;
        const callbacks = [];
        const requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
        const refreshNodeDragVisuals = () => { nodeDragVisualFrame = 0; refreshes += 1; };
        ${scheduleSource}
        scheduleNodeDragVisualUpdate();
        scheduleNodeDragVisualUpdate();
        scheduleNodeDragVisualUpdate();
        const queued = callbacks.length;
        callbacks.shift()();
        scheduleNodeDragVisualUpdate();
        return {queued, afterNextFrame:callbacks.length, refreshes};
    `);
    const result = run();

    assert.deepEqual(result, {queued:1, afterNextFrame:1, refreshes:1});
});

test('classic canvas minimap renders stable node ids for incremental marker updates', () => {
    const minimapSource = sourceBetween('function renderMinimap(){', 'function updateMinimapViewport(');

    assert.match(minimapSource, /data-node-id="\$\{escapeAttr\(n\.id\)\}"/);
});

test('ending a board pan does not force a full minimap rebuild', () => {
    const run = new Function(`
        let dragNode = null;
        let resizeNode = null;
        let llmPaneDrag = null;
        let promptSplitResize = null;
        let knifeChanged = false;
        let tempLink = null;
        let dragBoard = {moved:true};
        let minimapDrag = false;
        let knifeActive = false;
        let knifePoint = null;
        let knifeTrail = [];
        let knifeNeedsRender = false;
        let textSelectionGuard = null;
        let minimapSchedules = 0;
        let viewportSaves = 0;
        let contentSaves = 0;
        const clearClassicLinkTargetPreview = () => {};
        const setKnifeMode = () => {};
        const document = {body:{classList:{remove:() => {}}}};
        const window = {};
        const render = () => {};
        const scheduleMinimapRender = () => { minimapSchedules += 1; };
        const scheduleSave = () => { contentSaves += 1; };
        const scheduleViewportSave = () => { viewportSaves += 1; };
        ${sourceBetween('function endDrag(', 'function nodeRect(',)}
        endDrag({shiftKey:false});
        return {minimapSchedules, viewportSaves, contentSaves};
    `);
    const result = run();

    assert.deepEqual(result, {minimapSchedules:0, viewportSaves:1, contentSaves:0});
});

test('ending a node drag performs one full visual calibration and avoids a second minimap schedule', () => {
    const run = new Function(`
        let dragNode = {node:{id:'node-1', type:'image'}, children:[], rootIds:['node-1'], isFrameDrag:false};
        let resizeNode = null;
        let llmPaneDrag = null;
        let promptSplitResize = null;
        let knifeChanged = false;
        let tempLink = null;
        let dragBoard = null;
        let minimapDrag = false;
        let knifeActive = false;
        let knifePoint = null;
        let knifeTrail = [];
        let knifeNeedsRender = false;
        let textSelectionGuard = null;
        let visualFinishes = 0;
        let minimapSchedules = 0;
        let contentSaves = 0;
        const SpatialFrames = null;
        const updateGroupMembership = () => {};
        const finishNodeDragVisuals = () => { visualFinishes += 1; };
        const clearClassicLinkTargetPreview = () => {};
        const setKnifeMode = () => {};
        const document = {body:{classList:{remove:() => {}}}};
        const window = {};
        const render = () => {};
        const scheduleMinimapRender = () => { minimapSchedules += 1; };
        const scheduleSave = () => { contentSaves += 1; };
        const scheduleViewportSave = () => {};
        ${sourceBetween('function endDrag(', 'function nodeRect(',)}
        endDrag({shiftKey:false});
        return {dragNode, visualFinishes, minimapSchedules, contentSaves};
    `);
    const result = run();

    assert.deepEqual(result, {dragNode:null, visualFinishes:1, minimapSchedules:0, contentSaves:1});
});

test('inactive knife cleanup does not redraw links during ordinary pointer movement', () => {
    const run = new Function(`
        let canvas = {id:'canvas-1'};
        let knifeActive = false;
        let knifePoint = null;
        let knifeTrail = [];
        let knifeChanged = false;
        let knifeNeedsRender = false;
        let linkRenders = 0;
        const classes = new Set();
        const document = {body:{classList:{
            toggle:(name, active) => active ? classes.add(name) : classes.delete(name),
            contains:name => classes.has(name)
        }}};
        const renderLinks = () => { linkRenders += 1; };
        ${sourceBetween('function setKnifeMode(', 'function startKnifeDrag(',)}
        setKnifeMode(false);
        setKnifeMode(false);
        setKnifeMode(false);
        const idleRenders = linkRenders;
        setKnifeMode(true);
        knifeActive = true;
        setKnifeMode(false);
        setKnifeMode(false);
        return {idleRenders, linkRenders, active:knifeActive, hasClass:classes.has('canvas-knife')};
    `);
    const result = run();

    assert.deepEqual(result, {idleRenders:0, linkRenders:1, active:false, hasClass:false});
});
