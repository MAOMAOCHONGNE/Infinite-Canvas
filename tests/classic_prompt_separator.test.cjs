const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const HTML_PATH = path.join(ROOT, 'static', 'canvas.html');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('classic prompt nodes default to the four-hyphen separator', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const createBlock = sourceBlock(source, 'function addPromptNode', 'function addLoopNode');

    assert.match(createBlock, /promptSplitEnabled\s*:\s*false/);
    assert.match(createBlock, /promptSeparator\s*:\s*['"]----['"]/);
    assert.match(createBlock, /promptSplitPreviewHeight\s*:\s*70/);
});

test('classic prompt split helper removes the editing separator from downstream text', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const helperBlock = sourceBlock(source, 'const CLASSIC_PROMPT_SEPARATOR_DEFAULT', 'function promptCounterHtml');

    assert.match(helperBlock, /CLASSIC_PROMPT_SEPARATOR_DEFAULT\s*=\s*['"]----['"]/);
    assert.match(helperBlock, /text\.split\(separator\)/);
    assert.match(helperBlock, /\.join\(['"]\\n\\n['"]\)/);
    assert.match(helperBlock, /promptSplitEnabled\s*!==\s*true/);

    const exports = new Function(`${helperBlock}; return {classicPromptItems, classicPromptText};`)();
    const enabled = {text:'我爱你\n----\n你是谁', promptSplitEnabled:true, promptSeparator:'----'};
    assert.deepEqual(exports.classicPromptItems(enabled), ['我爱你', '你是谁']);
    assert.equal(exports.classicPromptText(enabled), '我爱你\n\n你是谁');
    assert.equal(exports.classicPromptText({...enabled, promptSplitEnabled:false}), enabled.text);
});

test('classic prompt UI mirrors the smart separator layout without adding LLM controls', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const promptBlock = sourceBlock(source, "if(node.type === 'prompt')", "if(node.type === 'loop')");

    assert.ok(promptBlock.indexOf('<textarea') < promptBlock.indexOf('classic-prompt-tools'), 'textarea should appear before the tools row');
    assert.match(promptBlock, /data-prompt-template-open/);
    assert.match(promptBlock, /data-prompt-split-toggle/);
    assert.match(promptBlock, /classic-prompt-split-row/);
    assert.match(promptBlock, /classic-prompt-split-count/);
    assert.match(promptBlock, /classic-prompt-segments/);
    assert.match(promptBlock, /classic-prompt-segment/);
    assert.match(promptBlock, /startPromptSplitPreviewResize/);
    assert.doesNotMatch(promptBlock, /data-prompt-llm|runPromptLLM|>LLM</);
});

test('classic prompt separator edits refresh preview, persist, and resync generator inputs', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const promptBlock = sourceBlock(source, "if(node.type === 'prompt')", "if(node.type === 'loop')");

    assert.match(promptBlock, /node\.promptSplitEnabled\s*=\s*!node\.promptSplitEnabled/);
    assert.match(promptBlock, /node\.promptSeparator\s*=\s*e\.target\.value\s*\|\|\s*CLASSIC_PROMPT_SEPARATOR_DEFAULT/);
    assert.match(promptBlock, /refreshClassicPromptSegmentsUi\(body, node\)/);
    assert.match(promptBlock, /scheduleSave\(\)/);
    assert.match(promptBlock, /scheduleGeneratorInputSync\(node\.id\)/);
});

test('classic loops consume split items while API and LLM readers keep one normalized prompt', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const loopBlock = sourceBlock(source, 'function loopInputPromptItems', 'function loopInputImageRefs');
    const llmBlock = sourceBlock(source, 'function llmInputText', 'function llmInputImages');
    const generatorBlock = sourceBlock(source, 'function generatorSources', 'function orderedSources');

    assert.match(loopBlock, /classicPromptItems\(n\)/);
    assert.match(loopBlock, /flatMap\(p => classicPromptItems\(p\)\)/);
    assert.doesNotMatch(loopBlock, /classicPromptText\(/);
    assert.match(llmBlock, /classicPromptText\(n\)/);
    assert.match(llmBlock, /classicPromptText\(p\)/);
    assert.match(generatorBlock, /classicPromptText\(p\)/);
    assert.match(generatorBlock, /classicPromptText\(n\)/);
    assert.doesNotMatch(loopBlock, /p\.text\s*\|\|\s*['"]/);
    assert.doesNotMatch(llmBlock, /p\.text\s*\|\|\s*['"]/);
    assert.doesNotMatch(generatorBlock, /p\.text\s*\|\|\s*['"]/);
});

test('classic generator prompt previews prefer the current loop prompt over its generic label', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const previewBlock = sourceBlock(source, 'function renderPromptPreview', 'function renderImageInputList');

    assert.match(previewBlock, /escapeHtml\(src\.prompt\s*\|\|\s*src\.label\)/);
});

test('classic generators preview loop prompts even when the same source also carries images', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const hiddenCompositePromptFilter = /filter\(src => src\.prompt && !src\.refs\?\.length\)/g;
    const visiblePromptFilters = source.match(/filter\(src => src\.prompt\)/g) || [];

    assert.doesNotMatch(source, hiddenCompositePromptFilter);
    assert.ok(visiblePromptFilters.length >= 8, 'every classic generator preview path should include composite loop prompts');
});

test('classic prompt split controls have matching styles and cache-busted assets', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    for(const selector of [
        '.classic-prompt-tools',
        '.classic-prompt-split-row',
        '.classic-prompt-split-control',
        '.classic-prompt-split-count',
        '.classic-prompt-segments',
        '.classic-prompt-segment',
        '.classic-prompt-split-resize'
    ]) assert.ok(css.includes(selector), `missing ${selector}`);
    assert.match(html, /canvas\.css\?v=[^"']+/);
    assert.match(html, /canvas\.js\?v=[^"']+/);
});
