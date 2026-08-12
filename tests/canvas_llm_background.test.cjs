const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');
const CLASSIC = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
const SMART = fs.readFileSync(path.join(ROOT, 'static', 'js', 'smart-canvas.js'), 'utf8');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('backend exposes a server-owned canvas LLM task route', () => {
    assert.match(MAIN, /class CanvasLLMTaskRequest\(CanvasLLMRequest\)/);
    assert.match(MAIN, /@app\.post\(["']\/api\/canvas-llm-tasks["']\)/);
    assert.match(MAIN, /asyncio\.create_task\(run_canvas_llm_task\(/);
    assert.match(MAIN, /CANVAS_LLM_BACKGROUND_TASKS\.add\(background_task\)/);
    assert.match(MAIN, /background_task\.add_done_callback\(CANVAS_LLM_BACKGROUND_TASKS\.discard\)/);
    assert.match(MAIN, /CANVAS_TASK_RUNTIME_ID/);
});

test('backend task completion performs guarded targeted node persistence and broadcasts', () => {
    const block = sourceBlock(MAIN, 'def update_canvas_llm_task_node(', 'async def run_canvas_llm_task');
    assert.match(block, /CANVAS_LOCK/);
    assert.match(block, /current_task_id/);
    assert.match(block, /current_task_id\s*!=\s*task_id/);
    assert.match(block, /node\["outputText"\]/);
    assert.match(block, /node\["text"\]/);
    assert.match(block, /assistant/);

    const runner = sourceBlock(MAIN, 'async def run_canvas_llm_task', '@app.post("/api/canvas-llm-tasks")');
    assert.match(runner, /await execute_canvas_llm\(/);
    assert.match(runner, /broadcast_canvas_updated/);
});

test('classic manual node runs queue a task while cascade runs stay synchronous', () => {
    const block = sourceBlock(CLASSIC, 'async function runLLMNode', 'function isTerminalGenerator');
    assert.match(block, /opts\.cascade/);
    assert.match(block, /await callCanvasLLM\(/);
    assert.match(block, /await submitCanvasLLMTask\(/);
    assert.match(block, /submitCanvasLLMTask\(node,\s*input,\s*\[\],\s*['"]node['"]\)/);
});

test('classic chat runs queue a recoverable task', () => {
    const block = sourceBlock(CLASSIC, 'async function runLLMChat', 'function deleteNode');
    assert.match(block, /await submitCanvasLLMTask\(/);
    assert.match(block, /submitCanvasLLMTask\(node,\s*message,\s*history,\s*['"]chat['"]\)/);
    assert.match(CLASSIC, /async function submitCanvasLLMTask[^]*node\.llmTask\s*=\s*\{/);
    assert.doesNotMatch(block, /await callCanvasLLM\(/);
});

test('classic load and remote sync derive running state from persisted task metadata', () => {
    const load = sourceBlock(CLASSIC, 'async function openCanvas', 'function applyRemoteCanvasData');
    const remote = sourceBlock(CLASSIC, 'function applyRemoteCanvasData', 'function resetTransientRunState');
    assert.match(load, /syncCanvasLLMTaskRuntimeStates\(/);
    assert.match(load, /task_runtime_id/);
    assert.match(remote, /syncCanvasLLMTaskRuntimeStates\(/);
});

test('classic return waits for local task registration before navigation', () => {
    const binding = sourceBlock(CLASSIC, "backToManagerBtn?.addEventListener('click'", 'let localCanvasDirty');
    assert.match(binding, /async/);
    assert.match(binding, /await waitForCanvasLLMSubmissions\(\)/);
    assert.match(CLASSIC, /beforeunload[^]*canvasLLMSubmissionPromises\.size/);
});

test('existing canvas metadata polling is reused without a new LLM interval', () => {
    const classicHelper = sourceBlock(CLASSIC, 'function canvasLLMTaskIsPending', 'function refreshOutputTimer');
    const smartHelper = sourceBlock(SMART, 'function smartPromptLLMTaskIsPending', 'function apiErrorMessage');
    assert.doesNotMatch(classicHelper, /setInterval\(/);
    assert.doesNotMatch(smartHelper, /setInterval\(/);
    assert.match(MAIN, /task_runtime_id/);
});
