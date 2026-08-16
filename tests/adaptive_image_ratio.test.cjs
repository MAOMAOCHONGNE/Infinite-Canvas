const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'adaptive-image-ratio.js');
const SMART_PATH = path.join(ROOT, 'static', 'js', 'smart-canvas.js');
const HTML_PATH = path.join(ROOT, 'static', 'smart-canvas.html');
const CLASSIC_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CLASSIC_HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');

const REQUESTED_RATIOS = [
    '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1',
    '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'
];

const REQUESTED_RATIO_KEYS = [
    'square', 'portrait14', 'portrait18', 'portrait', 'landscape', 'portrait43', 'landscape41',
    'landscape43', 'portrait45', 'landscape54', 'landscape81', 'story', 'wide', 'ultrawide'
];

function loadModule(){
    delete require.cache[require.resolve(MODULE_PATH)];
    return require(MODULE_PATH);
}

test('stretch-fit matching is limited to the requested fourteen ratios', () => {
    const {SUPPORTED_RATIOS} = loadModule();
    assert.deepEqual(SUPPORTED_RATIOS, REQUESTED_RATIOS);
});

test('canonical ratio parts preserve the whitelist label while arithmetic parts may reduce it', () => {
    const {SUPPORTED_RATIOS, canonicalRatioParts, ratioParts} = loadModule();
    for(const ratio of SUPPORTED_RATIOS){
        const [width, height] = ratio.split(':').map(Number);
        assert.deepEqual(canonicalRatioParts(ratio), {width, height});
    }
    assert.deepEqual(canonicalRatioParts('21:9'), {width:21, height:9});
    assert.deepEqual(ratioParts('21:9'), {width:7, height:3});
});

test('310x400 tie resolves to 3:4 before 4:5', () => {
    const {closestSupportedRatio} = loadModule();
    assert.equal(closestSupportedRatio(310, 400), '3:4');
});

test('wide source ratios choose the nearest supported option', () => {
    const {closestSupportedRatio} = loadModule();
    assert.equal(closestSupportedRatio(2000, 1000), '16:9');
    assert.equal(closestSupportedRatio(4000, 1000), '4:1');
    assert.equal(closestSupportedRatio(8000, 1000), '8:1');
    assert.equal(closestSupportedRatio(1000, 8000), '1:8');
});

test('true adaptive mode omits aspect ratio while all other modes keep their instruction', () => {
    const {aspectRatioForRequest} = loadModule();
    assert.equal(aspectRatioForRequest('adaptive', '4:1', '', ''), undefined);
    assert.equal(aspectRatioForRequest('landscape41', '4:1', '', ''), '4:1');
    assert.equal(aspectRatioForRequest('source', '', '', '8:1'), '8:1');
    assert.equal(aspectRatioForRequest('custom', '', '7:3', ''), '7:3');
});

test('temporary stretch keeps an exact integer target ratio', () => {
    const {stretchedDimensions} = loadModule();
    assert.deepEqual(stretchedDimensions(310, 400, '3:4'), {width:300, height:400});
    assert.deepEqual(stretchedDimensions(400, 310, '5:4'), {width:390, height:312});
});

test('adaptive output sizes obey edge, pixel, and multiple-of-16 limits', () => {
    const {SUPPORTED_RATIOS, pixelSizeForRatio} = loadModule();
    const limits = {
        '1k': {edge:1536, pixels:1572864},
        '2k': {edge:2048, pixels:4194304},
        '4k': {edge:3840, pixels:8294400},
    };
    for(const ratio of SUPPORTED_RATIOS){
        for(const [resolution, limit] of Object.entries(limits)){
            const match = pixelSizeForRatio(ratio, resolution).match(/^(\d+)x(\d+)$/);
            assert.ok(match, `${ratio} ${resolution} should produce a pixel size`);
            const width = Number(match[1]);
            const height = Number(match[2]);
            assert.equal(width % 16, 0);
            assert.equal(height % 16, 0);
            assert.ok(Math.max(width, height) <= limit.edge);
            assert.ok(width * height <= limit.pixels);
        }
    }
});

test('smart canvas loads the helper before use and marks only request references', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    assert.ok(html.indexOf('/static/js/adaptive-image-ratio.js') < html.indexOf('/static/js/smart-canvas.js'));
    assert.match(source, /stretch_aspect_ratio:adaptiveRatio/);
    assert.match(source, /adaptiveRatio \? \{\.\.\.ref, stretch_aspect_ratio:adaptiveRatio\} : ref/);
    assert.match(source, /aspectRatioForRequest\(/);
    assert.match(source, /if\(requestAspectRatio !== undefined\) payload\.aspect_ratio = requestAspectRatio/);
});

test('classic canvas loads the helper, exposes all supported preset ratios, and uses one request preparer', () => {
    const html = fs.readFileSync(CLASSIC_HTML_PATH, 'utf8');
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    assert.ok(html.indexOf('/static/js/adaptive-image-ratio.js') < html.indexOf('/static/js/canvas.js'));
    const start = source.indexOf('<select class="select-lite ratio compact-select" data-field="ratio">');
    const end = source.indexOf('</select>', start);
    const ratioSelect = source.slice(start, end);
    const optionValues = [...ratioSelect.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(optionValues, [...REQUESTED_RATIO_KEYS, 'source', 'adaptive', 'custom']);
    assert.match(source, /closestSupportedRatio\(dims\.width, dims\.height\)/);
    assert.match(source, /canonicalRatioParts\(matchedRatio\)/);
    assert.match(source, /aspectRatioForRequest\(/);
    assert.equal((source.match(/await prepareGeneratorImageRequest\(/g) || []).length, 3);
});

test('smart canvas exposes the same fourteen presets plus stretch-fit and true adaptive modes', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const start = source.indexOf('function renderSizePickerControl');
    const end = source.indexOf('const wKey', start);
    const picker = source.slice(start, end);
    for(const key of REQUESTED_RATIO_KEYS) assert.match(picker, new RegExp(`\\['${key}',`));
    assert.doesNotMatch(picker, /\['ultratall',/);
    assert.match(picker, /\['source',\s*tr\('canvas\.adaptiveRatio'\)/);
    assert.match(picker, /\['adaptive',\s*tr\('canvas\.autoRatio'\)/);
    assert.match(source, /canonicalRatioParts\(matched\)/);
    assert.match(source, /closestSupportedRatio\(size\.w, size\.h\)/);
});

test('ratio mode labels distinguish stretch-fit from true adaptive', () => {
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    assert.match(i18n, /"canvas\.adaptiveRatio": \{ zh: "拉伸适配", en: "Stretch Fit" \}/);
    assert.match(i18n, /"canvas\.autoRatio": \{ zh: "自适应", en: "Adaptive" \}/);
});

test('classic canvas stretches references only for an active stretch-fit request', () => {
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    assert.match(source, /gen\?\.ratio !== 'source'/);
    assert.match(source, /\['auto','custom'\]\.includes\(String\(gen\.resolution \|\| ''\)\.toLowerCase\(\)\)/);
    assert.match(source, /adaptiveRatio \? \{\.\.\.ref, stretch_aspect_ratio:adaptiveRatio\} : ref/);
    assert.equal((source.match(/stretch_aspect_ratio/g) || []).length, 1);
});
