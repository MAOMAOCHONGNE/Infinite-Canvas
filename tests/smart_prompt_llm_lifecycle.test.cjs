const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'smart-canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('smart canvas storage removes only prompt-LLM transient running state', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function canvasForStorage()', 'function apiErrorMessage');

    assert.match(block, /node\.type\s*===\s*['"]smart-prompt['"]/);
    assert.match(block, /clearSmartPromptLLMTransientState\(node\)/);
    assert.doesNotMatch(block, /clearSmartNodeTransientRunState\(node\)/);
});

test('smart canvas load restores server-owned prompt task state after clearing stale running', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'async function loadCanvas()', 'function scheduleSave');

    assert.match(block, /clearSmartPromptLLMTransientState\(n\)/);
    assert.match(block, /syncSmartPromptLLMTaskRuntimeState\(n/);
    assert.match(block, /task_runtime_id/);
});

test('smart merge accepts the server result for a completed prompt task', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function mergeSmartNode(local, remote)', 'function mergeSmartNodeLists');

    assert.match(block, /smart-prompt/);
    assert.match(block, /llmTask/);
    assert.match(block, /localTaskId[^\n]*!remoteTaskId/);
    assert.match(block, /return remote/);
});

test('smart prompt LLM submits a server-owned task instead of awaiting the direct endpoint', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'async function runPromptLLMNode', 'function comfyFieldKind');

    assert.match(block, /await submitSmartPromptLLMTask\(/);
    assert.match(block, /canvas_id\s*:\s*canvasId/);
    assert.match(block, /node_id\s*:\s*node\.id/);
    assert.match(block, /mode\s*:\s*['"]smart-prompt['"]/);
    assert.doesNotMatch(block, /requestSmartPromptLLM/);
    assert.doesNotMatch(block, /fetch\(['"]\/api\/canvas-llm['"]/);
});

test('smart prompt keeps pending task metadata and does not clear running in a success finally', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'async function runPromptLLMNode', 'function comfyFieldKind');
    const submitBlock = sourceBlock(source, 'async function submitSmartPromptLLMTask', 'function canvasForStorage');

    assert.match(submitBlock, /node\.llmTask\s*=\s*\{/);
    assert.match(submitBlock, /runtimeId/);
    assert.match(block, /node\.running\s*=\s*true/);
    assert.doesNotMatch(block, /finally\s*\{/);
    assert.doesNotMatch(block, /node\.text\s*=\s*\(result\.text/);
});

test('smart-canvas back navigation waits only for task registration', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'async function backToCanvasList()', 'function promptPlainText');

    assert.match(block, /await waitForSmartPromptLLMSubmissions\(\)/);
    assert.match(source, /beforeunload[^]*smartPromptLLMSubmissionPromises\.size/);
});

test('smart prompt split mode migrates the old default once and preserves later custom separators', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const separatorHelper = sourceBlock(source, 'function promptNodeSeparator', 'function promptNodePromptItems');
    const createBlock = sourceBlock(source, 'function createPromptNode', 'function createLoopNode');
    const promptNodeSeparator = new Function(`${separatorHelper}; return promptNodeSeparator;`)();

    assert.match(separatorHelper, /promptSeparator\s*\?\?\s*['"]----['"]/);
    assert.match(separatorHelper, /raw\s*===\s*['"]{2}\s*\?\s*['"]----['"]\s*:\s*raw/);
    assert.match(createBlock, /promptSeparator\s*:\s*['"]----['"]/);
    assert.match(createBlock, /promptSeparatorDefaultVersion\s*:\s*2/);
    assert.match(source, /placeholder=["']----["']/);
    assert.match(source, /e\.target\.value\s*\|\|\s*['"]----['"]/);
    const legacyDefault = {promptSeparator:';'};
    assert.equal(promptNodeSeparator(legacyDefault), '----');
    assert.equal(legacyDefault.promptSeparatorDefaultVersion, 2);
    assert.equal(promptNodeSeparator({promptSeparator:'||'}), '||');
    assert.equal(promptNodeSeparator({promptSeparator:';', promptSeparatorDefaultVersion:2}), ';');
});
