const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'static', 'js', 'llm-result-memory.js');
const CLASSIC = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
const SMART = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');
const CLASSIC_HTML = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
const SMART_HTML = fs.readFileSync(path.join(ROOT, 'static', 'smart-canvas.html'), 'utf8');
const CLASSIC_I18N = fs.readFileSync(path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js'), 'utf8');
const SMART_I18N = fs.readFileSync(path.join(ROOT, 'static', 'js', 'i18n', 'smart-canvas.js'), 'utf8');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function memoryHelper(){
    assert.ok(fs.existsSync(HELPER_PATH), 'shared LLM result-memory helper is missing');
    delete require.cache[require.resolve(HELPER_PATH)];
    return require(HELPER_PATH);
}

test('shared memory creates deterministic compact keys without retaining media binaries', () => {
    const memory = memoryHelper();
    const hugeDataUrl = `data:image/png;base64,${'A'.repeat(50000)}${'B'.repeat(50000)}`;
    const identity = memory.mediaIdentity(hugeDataUrl);
    const first = memory.keyFor({text:'hello', images:[identity], provider:'p'});
    const reordered = memory.keyFor({provider:'p', images:[identity], text:'hello'});

    assert.equal(first, reordered);
    assert.notEqual(first, memory.keyFor({text:'goodbye', images:[identity], provider:'p'}));
    assert.ok(first.length <= 80);
    assert.ok(identity.length <= 160);
    assert.ok(!identity.includes('A'.repeat(1000)));
});

test('shared memory restores by key and enforces entry plus total-character limits', () => {
    const memory = memoryHelper();
    const node = {};
    memory.remember(node, 'one', '1111', 1, {maxEntries:3, maxChars:10});
    memory.remember(node, 'two', '2222', 2, {maxEntries:3, maxChars:10});
    memory.remember(node, 'three', '3333', 3, {maxEntries:3, maxChars:10});
    memory.remember(node, 'four', '44', 4, {maxEntries:3, maxChars:10});

    assert.equal(memory.read(node, 'four'), '44');
    assert.equal(memory.read(node, 'one'), '');
    assert.ok(node.llmResultMemory.length <= 3);
    assert.ok(node.llmResultMemory.reduce((sum, entry) => sum + entry.text.length, 0) <= 10);
    assert.deepEqual(Object.keys(node.llmResultMemory[0]).sort(), ['key', 'text', 'updatedAt']);
});

test('classic LLM reads the result matching its current effective input and submits that key', () => {
    const helper = sourceBlock(CLASSIC, 'function classicLLMInputKey', 'function renderGeneratorBody');
    const submit = sourceBlock(CLASSIC, 'async function submitCanvasLLMTask', 'function refreshOutputTimer');
    const run = sourceBlock(CLASSIC, 'async function runLLMNode', 'function cascadeBtnHtml');

    assert.match(helper, /CanvasLLMResultMemory\.keyFor/);
    assert.match(helper, /CanvasLLMResultMemory\??\.read/);
    assert.match(helper, /function classicLLMOutputText/);
    assert.doesNotMatch(helper, /node\.outputText\s*=\s*['"]['"]/);
    assert.doesNotMatch(helper, /llmInputStale/);
    assert.match(submit, /input_key\s*:\s*inputKey/);
    assert.match(run, /CanvasLLMResultMemory\??\.remember\(node,\s*inputKey/);
});

test('smart prompt renders and propagates the result matching its current effective input', () => {
    const identity = sourceBlock(SMART, 'function smartPromptLLMInputKey', 'function promptNodeExpandedHeight');
    const render = sourceBlock(SMART, 'function promptNodeBodyHtml', 'function refreshPromptNodeSegmentsUi');
    const run = sourceBlock(SMART, 'async function runPromptLLMNode', 'function comfyFieldKind');

    assert.match(identity, /CanvasLLMResultMemory\.keyFor/);
    assert.match(identity, /CanvasLLMResultMemory\??\.read/);
    assert.match(identity, /function smartPromptLLMResultText/);
    assert.match(render, /smartPromptLLMResultText\(node\)/);
    assert.match(run, /input_key\s*:\s*inputKey/);
});

test('backend persists the submitted input key and prunes text-only result memory', () => {
    assert.match(MAIN, /LLM_RESULT_MEMORY_MAX_ENTRIES\s*=\s*20/);
    assert.match(MAIN, /LLM_RESULT_MEMORY_MAX_CHARS\s*=\s*120000/);
    assert.match(MAIN, /input_key:\s*str/);
    assert.match(MAIN, /def remember_canvas_llm_result/);
    assert.match(MAIN, /node\["llmResultMemory"\]/);
    assert.match(MAIN, /"inputKey":\s*input_key/);
    assert.match(MAIN, /input_key=payload\.input_key/);
});

test('both pages load the shared helper before their controllers and expose unseen-input text', () => {
    const classicHelper = CLASSIC_HTML.indexOf('/static/js/llm-result-memory.js');
    const classicController = CLASSIC_HTML.indexOf('/static/js/canvas.js');
    const smartHelper = SMART_HTML.indexOf('/static/js/llm-result-memory.js');
    const smartController = SMART_HTML.indexOf('/static/js/smart-canvas.js');

    assert.ok(classicHelper >= 0 && classicHelper < classicController);
    assert.ok(smartHelper >= 0 && smartHelper < smartController);
    assert.match(CLASSIC_I18N, /canvas\.llmNoResultForInput/);
    assert.match(SMART_I18N, /smart\.promptLlmNoResultForInput/);
});
