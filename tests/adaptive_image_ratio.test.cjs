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

function loadModule(){
    delete require.cache[require.resolve(MODULE_PATH)];
    return require(MODULE_PATH);
}

test('adaptive matching is limited to the requested ten ratios', () => {
    const {SUPPORTED_RATIOS} = loadModule();
    assert.deepEqual(SUPPORTED_RATIOS, [
        '1:1', '2:3', '3:2', '3:4', '4:3',
        '4:5', '5:4', '9:16', '16:9', '21:9'
    ]);
});

test('310x400 tie resolves to 3:4 before 4:5', () => {
    const {closestSupportedRatio} = loadModule();
    assert.equal(closestSupportedRatio(310, 400), '3:4');
});

test('wide source ratios choose the nearest supported option', () => {
    const {closestSupportedRatio} = loadModule();
    assert.equal(closestSupportedRatio(2000, 1000), '16:9');
    assert.equal(closestSupportedRatio(4000, 1000), '21:9');
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
});

test('classic canvas loads the helper, exposes all supported preset ratios, and uses one request preparer', () => {
    const html = fs.readFileSync(CLASSIC_HTML_PATH, 'utf8');
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    assert.ok(html.indexOf('/static/js/adaptive-image-ratio.js') < html.indexOf('/static/js/canvas.js'));
    assert.match(source, /<option value="portrait45">4:5<\/option>/);
    assert.match(source, /<option value="landscape54">5:4<\/option>/);
    assert.match(source, /closestSupportedRatio\(dims\.width, dims\.height\)/);
    assert.equal((source.match(/await prepareGeneratorImageRequest\(/g) || []).length, 3);
});

test('classic canvas stretches references only for an active adaptive-ratio request', () => {
    const source = fs.readFileSync(CLASSIC_PATH, 'utf8');
    assert.match(source, /gen\?\.ratio !== 'source'/);
    assert.match(source, /\['auto','custom'\]\.includes\(String\(gen\.resolution \|\| ''\)\.toLowerCase\(\)\)/);
    assert.match(source, /adaptiveRatio \? \{\.\.\.ref, stretch_aspect_ratio:adaptiveRatio\} : ref/);
    assert.equal((source.match(/stretch_aspect_ratio/g) || []).length, 1);
});
