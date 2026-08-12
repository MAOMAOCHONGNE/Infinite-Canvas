const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'static', 'js', 'output-compare-layout.js');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');

function loadHelper(){
    delete require.cache[require.resolve(HELPER_PATH)];
    return require(HELPER_PATH);
}

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('contain insets describe the original image visible rectangle', () => {
    const {containInsets} = loadHelper();
    assert.deepEqual(containInsets(1280, 960, 2000, 500), {
        top:320, right:0, bottom:320, left:0, renderedWidth:1280, renderedHeight:320
    });
    assert.deepEqual(containInsets(1280, 960, 500, 1000), {
        top:0, right:400, bottom:0, left:400, renderedWidth:480, renderedHeight:960
    });
});

test('contain padding is stable and invalid dimensions are ignored', () => {
    const {containInsets, paddingValue} = loadHelper();
    assert.equal(paddingValue(containInsets(1280, 960, 2000, 500)), '320px 0px 320px 0px');
    assert.equal(containInsets(0, 960, 2000, 500), null);
    assert.equal(paddingValue(null), '');
});

test('classic preview places both comparison buttons before copy prompt and loads the helper first', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const fill = html.indexOf('id="outputCompareFillBtn"');
    const normal = html.indexOf('id="outputCompareDefaultBtn"');
    const copy = html.indexOf('id="outputCopyPromptBtn"');
    assert.ok(fill >= 0 && fill < normal && normal < copy);
    assert.ok(html.indexOf('/static/js/output-compare-layout.js') < html.indexOf('/static/js/canvas.js'));
});

test('fill comparison changes only generated preview presentation', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function resetOutputCompareResultPresentation()', 'function outputResolutionText(');
    assert.match(block, /outputCompareResult\.style\.objectFit = 'fill'/);
    assert.match(block, /outputCompareResult\.style\.padding = padding/);
    assert.match(block, /!outputPreview\.classList\.contains\('compare-mode'\)/);
    assert.doesNotMatch(block, /outputCompareOriginal\.style\.(?:objectFit|padding|boxSizing)/);
    assert.doesNotMatch(block, /scheduleSave|fetch\(|downloadUrl\(/);
});

test('each image preview starts in default mode and original download binding remains unchanged', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const openBlock = sourceBlock(source, 'function openOutputLightbox(url, out)', 'function closeOutputLightbox()');
    assert.match(openBlock, /setOutputCompareDisplayMode\('default', false\)/);
    assert.match(openBlock, /setOutputCompareControlsAvailable\(!videoMode && !!currentOutputCompareUrl\)/);
    assert.match(openBlock, /downloadUrl\(url, outputDownloadName\(url\)\)/);
});

test('comparison mode hides the standalone image and leaves exactly the two comparison images', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const modeBlock = sourceBlock(source, 'function setOutputCompareMode(active)', 'outputCompareFillBtn?.addEventListener');
    const previewMarkup = sourceBlock(html, '<div id="outputCompareContainer"', '<video id="outputLightboxVideo"');
    assert.equal((previewMarkup.match(/<img\b/g) || []).length, 3);
    assert.match(modeBlock, /outputLightboxImg\.style\.display = \(enabled \|\| videoVisible\) \? 'none' : 'block'/);
    assert.match(css, /\.output-preview\.compare-mode > \.output-single-img \{ display:none !important; \}/);
    assert.match(html, /canvas\.js\?v=[^"'\s>]+/);
});
