const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLASSIC_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const SMART_PATH = path.join(ROOT, 'static', 'js', 'smart-canvas.js');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function exportedHelper(source, start, end, name){
    const block = sourceBlock(source, start, end);
    return new Function(`${block}; return ${name};`)();
}

test('classic image batches are derived from the round number', () => {
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    const helper = exportedHelper(
        source,
        'function loopImageStartForRound',
        'function loopInputImageRefs',
        'loopImageStartForRound'
    );
    const imageBlock = sourceBlock(source, 'function loopInputImageRefs', 'function videoRefsFromNode');
    const videoBlock = sourceBlock(source, 'function loopInputVideoRefs', 'function loopTokenLabel');

    assert.equal(helper(1, 2), 0);
    assert.equal(helper(3, 2), 4);
    assert.equal(helper(4, 2), 6);
    assert.match(imageBlock, /loopImageStartForRound\(currentRound,\s*batchSize\)/);
    assert.match(videoBlock, /loopImageStartForRound\(currentRound,\s*batchSize\)/);
});

test('smart image batches are derived from the round number', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const helper = exportedHelper(
        source,
        'function smartLoopImageStartForRound',
        'function smartLoopInputImages',
        'smartLoopImageStartForRound'
    );
    const imageBlock = sourceBlock(source, 'function smartLoopInputImages', 'function smartLoopPreviewImages');

    assert.equal(helper(1, 3), 0);
    assert.equal(helper(3, 2), 4);
    assert.equal(helper(4, 2), 6);
    assert.match(imageBlock, /smartLoopImageStartForRound\(currentRound,\s*batchSize\)/);
});

test('classic cascade advances prompts and counters one round at a time', () => {
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    const block = sourceBlock(source, 'async function runNodeCascadeSingleLoop(nodeId, options={})', 'async function runNodeCascade(nodeId, options={})');

    assert.match(block, /const endIdx\s*=\s*startIdx\s*\+\s*totalRounds\s*-\s*1/);
    assert.match(block, /schedule\.rounds/);
    assert.match(block, /const loopIndex\s*=\s*roundPlan\.index/);
    assert.match(block, /const loopCtx\s*=\s*\{index,\s*total:endIdx/);
    assert.doesNotMatch(block, /\(totalRounds\s*-\s*1\)\s*\*\s*loopBatchSize/);
    assert.doesNotMatch(block, /idx\s*\*\s*loopBatchSize/);
});

test('smart cascade advances prompts and counters one round at a time', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const block = sourceBlock(source, 'async function runSmartCascade(targetNode=null)', 'function runSmartCascadeFromLoop');

    assert.match(block, /const endIndex\s*=\s*startIndex\s*\+\s*totalRounds\s*-\s*1/);
    assert.match(block, /const loopIndex\s*=\s*startIndex\s*\+\s*round\b/);
    assert.match(block, /const loopIndex\s*=\s*startIndex\s*\+\s*slotOffset\b/);
    assert.match(block, /const slotIndex\s*=\s*Math\.max\(0,\s*loopIndex\s*-\s*startIndex\)/);
    assert.match(block, /startIndex\s*\+\s*round\b/);
    assert.doesNotMatch(block, /round\s*\*\s*batchSize/);
    assert.doesNotMatch(block, /slotOffset\s*\*\s*batchSize/);
});

test('loop controls use concise round terminology and one classic start control', () => {
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const renderBlock = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');
    const template = sourceBlock(renderBlock, 'wrap.innerHTML = `', 'const countInput = wrap.querySelector');
    const startControls = template.match(/class="loop-count-input loop-start-input"/g) || [];

    assert.equal(startControls.length, 1);
    assert.doesNotMatch(template, /loop-image-start-input/);
    assert.match(i18n, /"canvas\.loopCount"\s*:\s*\{\s*zh:\s*"轮数"/);
    assert.match(i18n, /"canvas\.loopStart"\s*:\s*\{\s*zh:\s*"起始轮"/);
    assert.match(i18n, /"canvas\.loopImageStart"\s*:\s*\{\s*zh:\s*"起始轮"/);
    assert.match(i18n, /"canvas\.loopBatchSize"\s*:\s*\{\s*zh:\s*"每轮图数"/);
    assert.match(i18n, /"canvas\.counterToken"\s*:\s*\{\s*zh:\s*"序号"/);
});
