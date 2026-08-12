const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('selected populated IMAGE node is the only unambiguous clipboard replacement target', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const helperBlock = sourceBlock(source, 'function classicSelectedImagePasteTarget', "window.addEventListener('paste'");
    const target = new Function(`${helperBlock}; return classicSelectedImagePasteTarget;`)();
    const nodes = [
        {id:'filled', type:'image', url:'/filled.png'},
        {id:'blank', type:'image', url:''},
        {id:'prompt', type:'prompt', text:'hello'},
    ];

    assert.equal(target(new Set(['filled']), nodes), nodes[0]);
    assert.equal(target(new Set(['blank']), nodes), nodes[1]);
    assert.equal(target(new Set(['prompt']), nodes), null);
    assert.equal(target(new Set(), nodes), null);
    assert.equal(target(new Set(['filled', 'blank']), nodes), null);
});

test('clipboard media replaces the selected IMAGE and otherwise keeps the create-new fallback', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const pasteBlock = sourceBlock(source, "window.addEventListener('paste'", "window.addEventListener('keydown'");

    assert.match(pasteBlock, /classicSelectedImagePasteTarget\(selected,\s*nodes\)/);
    assert.match(pasteBlock, /if\(target\)\s*fillImageNode\(target\.id,\s*files\)/);
    assert.doesNotMatch(pasteBlock, /n\?\.type\s*===\s*['"]image['"]\s*&&\s*!n\.url/);
    assert.match(pasteBlock, /else if\(files\.length\s*>\s*1\)\s*uploadImageGroup\(files\)/);
    assert.match(pasteBlock, /else\s*uploadImages\(files\)/);
});

test('LLM media auto-height grows only by its bounded footprint and removes only its own delta', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const planBlock = sourceBlock(source, 'function classicLLMMediaAutoHeightPlan', 'function scheduleRenderedLLMMediaAutoSize');
    const plan = new Function(`${planBlock}; return classicLLMMediaAutoHeightPlan;`)();

    const grown = plan({currentHeight:590, appliedHeight:0, hasMedia:true, mediaFootprint:90, clippedOverflow:70, defaultHeight:590, hadExplicitHeight:false});
    assert.deepEqual(grown, {height:662, appliedHeight:72, changed:true, clearExplicitHeight:false});

    const capped = plan({currentHeight:590, appliedHeight:0, hasMedia:true, mediaFootprint:90, clippedOverflow:300, defaultHeight:590, hadExplicitHeight:false});
    assert.deepEqual(capped, {height:680, appliedHeight:90, changed:true, clearExplicitHeight:false});

    const stable = plan({currentHeight:662, appliedHeight:72, hasMedia:true, mediaFootprint:90, clippedOverflow:0, defaultHeight:590, hadExplicitHeight:false});
    assert.deepEqual(stable, {height:662, appliedHeight:72, changed:false, clearExplicitHeight:false});

    const removed = plan({currentHeight:662, appliedHeight:72, hasMedia:false, mediaFootprint:0, clippedOverflow:0, defaultHeight:590, hadExplicitHeight:false});
    assert.deepEqual(removed, {height:590, appliedHeight:0, changed:true, clearExplicitHeight:true});

    const manualGrowthPreserved = plan({currentHeight:720, appliedHeight:72, hasMedia:false, mediaFootprint:0, clippedOverflow:0, defaultHeight:590, hadExplicitHeight:true});
    assert.deepEqual(manualGrowthPreserved, {height:648, appliedHeight:0, changed:true, clearExplicitHeight:false});
});

test('rendered ordinary LLM schedules media measurement from the active node pane', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const renderBlock = sourceBlock(source, 'function renderNode(node)', 'function setCanvasAssetSaveDragData');
    const scheduleBlock = sourceBlock(source, 'function scheduleRenderedLLMMediaAutoSize', 'function loopTokenChipHtml');

    assert.match(renderBlock, /scheduleRenderedLLMMediaAutoSize\(node,\s*el\)/);
    assert.match(scheduleBlock, /node\.type\s*!==\s*['"]llm['"]/);
    assert.match(scheduleBlock, /node\.mode\s*===\s*['"]chat['"]/);
    assert.match(scheduleBlock, /\.llm-node-pane/);
    assert.match(scheduleBlock, /scrollHeight\s*-\s*activePane\.clientHeight/);
    assert.match(scheduleBlock, /llmMediaAutoExpanded/);
    assert.match(scheduleBlock, /classicLLMMediaAutoHeightPlan/);
    assert.match(scheduleBlock, /\.llm-media-preview/);
});
