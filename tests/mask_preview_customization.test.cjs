const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'static', 'js', 'mask-preview-style.js');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');
const PAGES = [
    {
        name:'classic',
        html:path.join(ROOT, 'static', 'canvas.html'),
        source:path.join(ROOT, 'static', 'js', 'canvas.js'),
        controller:'/static/js/canvas.js'
    },
    {
        name:'smart',
        html:path.join(ROOT, 'static', 'smart-canvas.html'),
        source:path.join(ROOT, 'static', 'js', 'smart-canvas.js'),
        controller:'/static/js/smart-canvas.js'
    }
];

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('both mask toolbars expose color and bounded opacity controls', () => {
    for(const page of PAGES){
        const html = fs.readFileSync(page.html, 'utf8');
        const block = sourceBlock(html, 'id="imageMaskTools"', 'id="imageBrushTools"');
        assert.match(block, /id="maskPreviewColor"[^>]*type="color"[^>]*value="#ff3b30"/, `${page.name} color control`);
        assert.match(block, /id="maskPreviewOpacity"[^>]*type="range"[^>]*min="10"[^>]*max="100"[^>]*value="50"/, `${page.name} opacity control`);
        assert.match(block, /id="maskPreviewOpacityValue"[^>]*>50%<\//, `${page.name} opacity value`);
    }
});

test('shared preview helper recolors effective mask pixels without changing binary membership', () => {
    const helper = require(HELPER_PATH);
    const imageData = {
        data:new Uint8ClampedArray([
            255, 255, 255, 0,
            255, 255, 255, 5,
            255, 255, 255, 9,
            255, 255, 255, 115,
            255, 255, 255, 240
        ])
    };
    const before = [];
    for(let i = 3; i < imageData.data.length; i += 4) before.push(imageData.data[i] > 8);

    helper.recolorImageData(imageData, {color:'#336699', opacityPercent:50, threshold:8});

    const after = [];
    for(let i = 3; i < imageData.data.length; i += 4) after.push(imageData.data[i] > 8);
    assert.deepEqual(after, before);
    assert.deepEqual([...imageData.data.slice(4, 7)], [51, 102, 153]);
    assert.equal(imageData.data[7], 5);
    assert.equal(imageData.data[11], 128);
    assert.equal(imageData.data[15], 128);
    assert.equal(imageData.data[19], 128);
});

test('shared preview helper clamps opacity to the safe 10-100 percent range', () => {
    const helper = require(HELPER_PATH);
    assert.equal(helper.normalizeOpacityPercent(-20), 10);
    assert.equal(helper.normalizeOpacityPercent(54), 54);
    assert.equal(helper.normalizeOpacityPercent(500), 100);
    assert.equal(helper.opacityAlpha(50), 128);
    assert.equal(helper.drawRgba('#ff3b30'), 'rgba(255,59,48,0.45098039215686275)');
});

test('both controllers refresh existing strokes and normalize restored mask snapshots', () => {
    for(const page of PAGES){
        const html = fs.readFileSync(page.html, 'utf8');
        const source = fs.readFileSync(page.source, 'utf8');
        const helperAt = html.indexOf('/static/js/mask-preview-style.js');
        const controllerAt = html.indexOf(page.controller);
        const restoreBlock = sourceBlock(source, 'function restoreEditDrawSnapshot', 'function pushEditDrawHistory');

        assert.ok(helperAt >= 0 && controllerAt > helperAt, `${page.name} helper load order`);
        assert.match(source, /CanvasMaskPreviewStyle\.recolorImageData/);
        assert.match(source, /maskPreviewColor/);
        assert.match(source, /maskPreviewOpacity/);
        assert.match(source, /function refreshMaskPreviewStyle/);
        assert.match(restoreBlock, /normalizeMaskPreviewCanvas/);
    }
});

test('binary black-white mask export remains independent of preview settings', () => {
    for(const page of PAGES){
        const source = fs.readFileSync(page.source, 'utf8');
        const block = sourceBlock(source, 'function maskCanvasFromDrawCanvas', '\n}');
        assert.match(block, /const painted\s*=\s*srcData\.data\[i \+ 3\]\s*>\s*8/);
        assert.match(block, /const v\s*=\s*painted\s*\?\s*255\s*:\s*0/);
        assert.match(block, /out\.data\[i \+ 3\]\s*=\s*255/);
        assert.doesNotMatch(block, /maskPreviewColor|maskPreviewOpacity|CanvasMaskPreviewStyle/);
    }
});

test('mask labels describe preview color and opacity without promising a white mask', () => {
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    assert.match(i18n, /"canvas\.maskOpacity"\s*:/);
    assert.match(i18n, /"canvas\.maskHint"[^\n]+彩色区域/);
    assert.match(i18n, /"canvas\.maskHint2"[^\n]+涂抹/);
    assert.doesNotMatch(i18n, /"canvas\.maskHint"[^\n]+白色区域/);
    assert.doesNotMatch(i18n, /"canvas\.maskHint2"[^\n]+涂白/);
});
