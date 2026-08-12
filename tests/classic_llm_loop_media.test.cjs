const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('classic LLM image input includes the current loop image batch', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function llmInputImages', 'function llmInputVideos');

    assert.match(block, /n\.type\s*===\s*['"]loop['"]/);
    assert.match(block, /loopInputImageRefs\(n\)/);
    assert.match(block, /urls\.push\(ref\.url\)/);
});

test('classic LLM video input includes the current loop video batch', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function llmInputVideos', 'function renderGeneratorBody');

    assert.match(block, /n\.type\s*===\s*['"]loop['"]/);
    assert.match(block, /loopInputVideoRefs\(n\)/);
    assert.match(block, /urls\.push\(ref\.url\)/);
});

test('classic LLM submits the extracted media in both background and cascade paths', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const taskBlock = sourceBlock(source, 'async function submitCanvasLLMTask', 'function refreshOutputTimer');
    const directBlock = sourceBlock(source, 'async function callCanvasLLM', 'async function runLLMNode');

    for(const block of [taskBlock, directBlock]){
        assert.match(block, /images\s*:\s*llmInputImages\(node\)|const images\s*=\s*llmInputImages\(node\)/);
        assert.match(block, /videos\s*:\s*llmInputVideos\(node\)|const videos\s*=\s*llmInputVideos\(node\)/);
    }
});

test('classic LLM renders connected image and video thumbnails', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const helperBlock = sourceBlock(source, 'function llmConnectedMediaPreviewHtml', 'function renderLLMBody');
    const renderBlock = sourceBlock(source, 'function renderLLMBody', 'function renderLLMNodePane');

    assert.match(helperBlock, /class="llm-media-preview"/);
    assert.match(helperBlock, /class="llm-media-thumb/);
    assert.match(helperBlock, /canvasPreviewImgHtml\([^,]+,\s*160/);
    assert.match(helperBlock, /canvasVideoPreviewHtml\([^,]+,\s*160/);
    assert.match(renderBlock, /llmConnectedMediaPreviewHtml\(imgs, videos\)/);
});

test('classic LLM media previews have compact thumbnail styles and cache-busted assets', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    for(const selector of ['.llm-media-preview', '.llm-media-thumb', '.llm-media-thumb-badge']){
        assert.ok(css.includes(selector), `missing ${selector}`);
    }
    assert.match(html, /canvas\.css\?v=[^"']+/);
    assert.match(html, /canvas\.js\?v=[^"']+/);
});

test('classic loop input changes target only directly connected LLM previews', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicLLMOutputText', 'function renderGeneratorBody');

    assert.match(block, /function loopDownstreamLLMNodes/);
    assert.match(block, /connections\.filter\(c\s*=>\s*c\.from\s*===\s*loopNode\.id\)/);
    assert.match(block, /node\?\.type\s*===\s*['"]llm['"]/);
    assert.match(block, /const before\s*=\s*new Map/);
    assert.match(block, /classicLLMInputFingerprint/);
    assert.match(block, /refreshNodes\(changed\.map\(node\s*=>\s*node\.id\)\)/);
    assert.doesNotMatch(block, /runLLMNode\(|submitCanvasLLMTask\(|callCanvasLLM\(/);
});

test('classic loop start and batch controls refresh downstream LLMs immediately', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');
    const refreshCalls = block.match(/updateLoopDownstreamLLMViews\(node,\s*\(\)\s*=>/g) || [];

    assert.ok(refreshCalls.length >= 5, 'loop text/image changes should share the targeted LLM refresh helper');
    assert.match(block, /startInput\.oninput[\s\S]*?updateLoopDownstreamLLMViews/);
    assert.doesNotMatch(block, /imageStartInput\.oninput|loop-image-start-input/);
    assert.match(block, /batchInput\.oninput[\s\S]*?updateLoopDownstreamLLMViews/);
});

test('changed upstream input restores only the keyed LLM result for that input', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const helperBlock = sourceBlock(source, 'function classicLLMOutputText', 'function renderGeneratorBody');
    const renderBlock = sourceBlock(source, 'function renderLLMNodePane', 'function renderLLMChatPane');
    const loopConsumers = source.match(/classicLLMOutputItems\(n\)/g) || [];
    const normalizedConsumers = source.match(/classicLLMOutputPromptText\(n\)/g) || [];

    assert.match(helperBlock, /CanvasLLMResultMemory\??\.read/);
    assert.match(helperBlock, /classicLLMInputKey/);
    assert.doesNotMatch(helperBlock, /node\.outputText\s*=\s*['"]['"]/);
    assert.doesNotMatch(helperBlock, /node\.llmInputStale\s*=\s*true/);
    assert.ok(loopConsumers.length >= 1, 'loop readers should consume matching keyed output items');
    assert.ok(normalizedConsumers.length >= 2, 'LLM and generator readers should consume matching normalized keyed output');
    assert.match(renderBlock, /canvas\.llmNoResultForInput/);
    assert.match(renderBlock, /classicLLMOutputText\(node\)/);
    assert.match(i18n, /["']canvas\.llmNoResultForInput["']/);
});

test('running the classic LLM records the submitted input key without an automatic loop-triggered request', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'async function runLLMNode', 'function cascadeBtnHtml');
    const inputKey = block.indexOf('const inputKey = classicLLMInputKey(node)');
    const submit = block.indexOf('submitCanvasLLMTask(node');

    assert.ok(inputKey >= 0 && submit > inputKey, 'the current input key must be captured before submission');
    assert.match(block, /CanvasLLMResultMemory\??\.remember\(node,\s*inputKey/);
    assert.match(block, /scheduleSave\(\)/);
});
