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
        let minimapRenderQueued = false;
        let minimapGeometryDirty = false;
        let linksRenderQueued = false;
        let viewportOverlayUpdateQueued = false;
        let minimapState = {
            bounds:options.bounds || {x:-10000, y:-10000, w:20000, h:20000}
        };
        const frameCallbacks = [];
        const requestAnimationFrame = callback => { frameCallbacks.push(callback); };
        const world = {style:{}};
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
        const scheduleViewportSave = () => { viewportSaves += 1; };
        ${viewportOverlaySchedulerSource()}
        ${applyViewportSource()}
        ${wheelHandlerSource()}
        deltaValues.forEach(deltaY => board.onwheel({
            deltaY,
            clientX:300,
            clientY:250,
            preventDefault:() => { prevented += 1; }
        }));
        const beforeFrame = {linkRenders, selectionContentRenders, selectionPositions, minimapFullRenders, minimapViewportUpdates};
        frameCallbacks.splice(0).forEach(callback => callback());
        return {
            viewport,
            prevented,
            linkRenders,
            selectionContentRenders,
            selectionPositions,
            minimapFullRenders,
            minimapViewportUpdates,
            viewportSaves,
            compositorHint:world.style.willChange || '',
            beforeFrame
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
        minimapViewportUpdates:0
    });
    assert.equal(result.linkRenders, 0);
    assert.equal(result.selectionContentRenders, 0);
    assert.equal(result.selectionPositions, 1);
    assert.equal(result.minimapFullRenders, 0);
    assert.equal(result.minimapViewportUpdates, 1);
    assert.equal(result.viewportSaves, 3);
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

test('classic canvas node movement still refreshes links and minimap geometry', () => {
    const run = new Function(`
        let linkSchedules = 0;
        let overlaySchedules = 0;
        let minimapSchedules = 0;
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
        const scheduleLinksRender = () => { linkSchedules += 1; };
        const scheduleViewportOverlayUpdate = () => { overlaySchedules += 1; };
        const scheduleMinimapRender = () => { minimapSchedules += 1; };
        const workflowTransferModal = null;
        const updateWorkflowTransferMeta = () => {};
        ${sourceBetween('function onNodeDrag(', 'function startNodeResize(',)}
        onNodeDrag({clientX:130, clientY:145});
        return {dragNode, element, linkSchedules, overlaySchedules, minimapSchedules, undoRecords};
    `);
    const result = run();

    assert.equal(result.dragNode.node.x, 40);
    assert.equal(result.dragNode.node.y, 65);
    assert.deepEqual(result.element.style, {left:'40px', top:'65px'});
    assert.equal(result.linkSchedules, 1);
    assert.equal(result.overlaySchedules, 1);
    assert.equal(result.minimapSchedules, 1);
    assert.equal(result.undoRecords, 1);
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
