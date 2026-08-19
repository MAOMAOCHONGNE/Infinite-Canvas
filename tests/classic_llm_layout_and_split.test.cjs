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

test('new classic LLM nodes default to LLM mode with output splitting disabled', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function addLLMNode', 'function addGeneratorNode');

    assert.match(block, /mode\s*:\s*['"]node['"]/);
    assert.match(block, /llmOutputSplitEnabled\s*:\s*false/);
    assert.match(block, /llmOutputSeparator\s*:\s*['"]----['"]/);
    assert.match(block, /llmOutputHeight\s*:\s*110/);
});

test('classic LLM output split helpers preserve raw output and normalize downstream text', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const helperBlock = sourceBlock(source, 'const CLASSIC_LLM_OUTPUT_SEPARATOR_DEFAULT', 'function classicLLMHasAnyResult');

    assert.match(helperBlock, /classicLLMOutputText\(node\)/);
    assert.match(helperBlock, /text\.split\(separator\)/);
    assert.match(helperBlock, /llmOutputSplitEnabled\s*!==\s*true/);
    assert.match(helperBlock, /\.join\(['"]\\n\\n['"]\)/);

    const helpers = new Function('classicLLMOutputText', `${helperBlock}; return {classicLLMOutputItems, classicLLMOutputPromptText};`)(node => node.outputText || '');
    const node = {outputText:'第一段\n----\n第二段\n----\n', llmOutputSplitEnabled:true, llmOutputSeparator:'----'};
    assert.deepEqual(helpers.classicLLMOutputItems(node), ['第一段', '第二段']);
    assert.equal(helpers.classicLLMOutputPromptText(node), '第一段\n\n第二段');
    assert.deepEqual(helpers.classicLLMOutputItems({...node, llmOutputSplitEnabled:false}), [node.outputText]);
});

test('classic LLM template library maps templates to the local LLM input', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const currentBlock = sourceBlock(source, 'function currentCanvasPromptTemplateNodeText', 'function syncCanvasPromptTemplateButtons');
    const applyBlock = sourceBlock(source, 'function applyPromptTemplateToPromptNode', 'function renderLoopBody');

    assert.match(currentBlock, /['"]llm['"]/);
    assert.match(currentBlock, /node\.userInput/);
    assert.match(applyBlock, /['"]llm['"]/);
    assert.match(applyBlock, /node\.userInput\s*=\s*templateText/);
});

test('classic LLM layout follows mode, input, output, split, model, and action order', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const bodyBlock = sourceBlock(source, 'function renderLLMBody', 'function renderLLMNodePane');
    const nodeBlock = sourceBlock(source, 'function renderLLMNodePane', 'function renderLLMChatPane');

    assert.match(bodyBlock, /data-lucide="sparkles"/);
    assert.match(bodyBlock, /data-lucide="messages-square"/);
    assert.ok(bodyBlock.indexOf('llm-mode') < bodyBlock.indexOf('llmConnectedMediaPreviewHtml'), 'mode tabs should stay above connected media');

    const input = nodeBlock.indexOf('llm-input-head');
    const output = nodeBlock.indexOf('llm-output-head');
    const split = nodeBlock.indexOf('llm-output-split-tools');
    const models = nodeBlock.indexOf('llm-model-row');
    const actions = nodeBlock.indexOf('llm-bottom-actions');
    assert.ok(input >= 0 && input < output && output < split && split < models && models < actions, 'classic LLM controls should follow the approved visual order');
    assert.match(nodeBlock, /data-prompt-template-open/);
    assert.match(nodeBlock, /data-lucide="library"/);
    assert.match(nodeBlock, /data-lucide="copy"/);
    assert.match(nodeBlock, /data-llm-expand="input"/);
    assert.match(nodeBlock, /data-llm-expand="output"/);
    assert.match(nodeBlock, /data-llm-expand="segments"/);
    assert.match(nodeBlock, /data-llm-expand="system"/);
    assert.match(nodeBlock, /data-lucide="maximize-2"/);
    assert.match(nodeBlock, /data-lucide="split"/);
    assert.match(nodeBlock, /data-lucide="\$\{node\.showSystem \? 'toggle-right' : 'toggle-left'\}"/);
    assert.match(nodeBlock, /data-lucide="play"/);
});

test('classic LLM count lives only in the expanded separator row and pane drag is removed', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const block = sourceBlock(source, 'function renderLLMNodePane', 'function renderLLMChatPane');
    const outputHead = sourceBlock(block, '<div class="llm-pane-label-row llm-output-head">', '<div class="llm-output-wrap"');
    const splitAt = block.indexOf('llm-output-split-tools');
    const countAt = block.indexOf('llm-output-segment-count');

    assert.doesNotMatch(outputHead, /llm-output-segment-count/);
    assert.ok(splitAt >= 0 && countAt > splitAt, 'segment count should be after the split tools marker');
    assert.match(block, /splitEnabled\s*\?[\s\S]*?llm-output-segment-count/);
    assert.doesNotMatch(block, /llm-pane-resizer|startLLMPaneResize/);
    assert.doesNotMatch(css, /\.llm-pane-resizer/);
});

test('classic LLM system toggle auto-sizes once and uses smart-canvas toggle icons', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const body = sourceBlock(source, 'function renderLLMBody', 'function renderLLMNodePane');
    const helper = sourceBlock(source, 'const CLASSIC_LLM_SYSTEM_PROMPT_HEIGHT_DELTA', 'function renderLLMBody');
    const nodeBlock = sourceBlock(source, 'function renderLLMNodePane', 'function renderLLMChatPane');
    const chatBlock = sourceBlock(source, 'function renderLLMChatPane', 'function bindScrollableText');

    assert.match(helper, /setClassicLLMSystemPromptEnabled/);
    assert.match(helper, /node\.h\s*=\s*currentHeight\s*\+\s*CLASSIC_LLM_SYSTEM_PROMPT_HEIGHT_DELTA/);
    assert.match(helper, /currentHeight\s*-\s*CLASSIC_LLM_SYSTEM_PROMPT_HEIGHT_DELTA/);
    assert.match(helper, /llmSystemAutoExpanded/);
    assert.match(body, /setClassicLLMSystemPromptEnabled\(node,\s*!node\.showSystem\)/);
    for(const block of [nodeBlock, chatBlock]){
        assert.match(block, /toggle-right/);
        assert.match(block, /toggle-left/);
        assert.match(block, /canvas\.llmSystemDisable/);
        assert.match(block, /canvas\.llmSystemEnable/);
    }
});

test('classic Chat remote completion never overwrites keyed LLM output', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const mergeBlock = sourceBlock(source, 'function mergeRemoteCanvasLLMTaskResults', 'async function waitForCanvasLLMSubmissions');
    const helperBlock = sourceBlock(source, 'function classicLLMOutputLooksLikeChatReply', 'function classicLLMOutputText');
    const outputBlock = sourceBlock(source, 'function classicLLMOutputText', 'const CLASSIC_LLM_OUTPUT_SEPARATOR_DEFAULT');

    assert.match(mergeBlock, /completedMode/);
    assert.match(mergeBlock, /completedMode\s*!==\s*['"]chat['"]/);
    assert.match(mergeBlock, /local\.messages/);
    assert.match(outputBlock, /classicLLMOutputLooksLikeChatReply\(node,\s*current\)/);

    const looksLikeChat = new Function(`${helperBlock}; return classicLLMOutputLooksLikeChatReply;`)();
    assert.equal(looksLikeChat({messages:[{role:'assistant', content:'chat answer'}]}, 'chat answer'), true);
    assert.equal(looksLikeChat({llmResultKey:'key', messages:[{role:'assistant', content:'chat answer'}]}, 'chat answer'), false);
    assert.equal(looksLikeChat({messages:[{role:'assistant', content:'different'}]}, 'real llm result'), false);
});

test('classic LLM split settings refresh downstream views without running a provider', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function renderLLMNodePane', 'function renderLLMChatPane');

    assert.match(block, /node\.llmOutputSplitEnabled\s*=\s*!node\.llmOutputSplitEnabled/);
    assert.match(block, /node\.llmOutputSeparator\s*=\s*e\.target\.value\s*\|\|\s*CLASSIC_LLM_OUTPUT_SEPARATOR_DEFAULT/);
    assert.match(block, /refreshClassicLLMOutputSegmentsUi/);
    assert.match(block, /scheduleSave\(\)/);
    assert.match(block, /syncGeneratorInputs\(\)/);
    assert.match(block, /refreshGeneratorInputViews\(\)/);
    assert.doesNotMatch(block, /runLLMNode\(node\.id\)[\s\S]*llmOutputSeparator/);
});

test('loop, LLM, and API generator consume split-aware LLM output', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const loopBlock = sourceBlock(source, 'function loopInputPromptItems', 'function loopInputImageRefs');
    const llmBlock = sourceBlock(source, 'function classicPromptMentionPart', 'function llmInputImages');
    const generatorBlock = sourceBlock(source, 'function generatorSources', 'function orderedSources');

    assert.match(loopBlock, /classicLLMOutputItems\(n\)/);
    assert.match(llmBlock, /classicLLMOutputPromptText\(n\)/);
    assert.match(generatorBlock, /classicLLMOutputPromptText\(n\)/);
});

test('classic chat mode keeps multi-turn history, send, copy, and settings controls', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const block = sourceBlock(source, 'function renderLLMChatPane', 'function bindScrollableText');

    assert.match(block, /node\.messages/);
    assert.match(block, /llm-chat-log/);
    assert.match(block, /data-lucide="send"/);
    assert.match(block, /data-lucide="copy"/);
    assert.match(block, /llm-model-row/);
    assert.match(block, /llm-sys-toggle/);
    assert.match(block, /runLLMChat\(node\.id\)/);
});

test('classic LLM redesign has scoped styles, localized labels, and cache busts', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');

    for(const selector of [
        '.llm-mode', '.llm-input-head', '.llm-output-head', '.llm-output-split-tools',
        '.llm-output-segments', '.llm-model-row', '.llm-bottom-actions', '.llm-template-btn'
    ]) assert.ok(css.includes(selector), `missing ${selector}`);
    for(const key of [
        'canvas.llmMode', 'canvas.chatMode', 'canvas.llmInputLabel', 'canvas.llmOutputLabel',
        'canvas.llmRun', 'canvas.llmSystemEnable', 'canvas.llmSystemDisable', 'canvas.llmOutputSegments'
    ]) assert.ok(i18n.includes(`"${key}"`), `missing ${key}`);
    assert.match(i18n, /"canvas\.llmRun"\s*:\s*\{\s*zh:\s*"运行"/);
    assert.match(css, /\.llm-model-row\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/s);
    assert.match(css, /\.llm-bottom-actions\s*\{[^}]*display:flex[^}]*justify-content:space-between/s);
    assert.match(css, /\.llm-bottom-actions \.llm-run\s*\{[^}]*width:auto/s);
    assert.match(html, /canvas\.css\?v=[^"']+/);
    assert.match(html, /canvas\.js\?v=[^"']+/);
});

test('classic LLM prompt workspace has a large editor, remembered sizing, and split-aware node growth', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const block = sourceBlock(source, 'const CLASSIC_LLM_PROMPT_WORKSPACE_SIZE_KEY', 'function renderLLMBody');

    assert.match(html, /id="llmPromptWorkspaceModal"/);
    assert.match(html, /id="llmPromptWorkspaceEditor"/);
    assert.match(html, /id="llmPromptWorkspaceSegments"/);
    assert.match(css, /\.llm-prompt-workspace-panel\s*\{[^}]*width:700px;[^}]*height:700px;/s);
    assert.match(css, /\.llm-prompt-workspace-editor/);
    assert.match(css, /\.llm-prompt-workspace-segment-index/);
    assert.match(css, /\.node\.sized\.llm-node \.llm-output-wrap\s*\{[^}]*min-height:0;/s);
    assert.match(css, /\.llm-expand-btn/);
    assert.match(block, /classic_llm_prompt_workspace_size_v1/);
    assert.match(block, /classic_llm_prompt_workspace_font_v1/);
    assert.match(block, /CLASSIC_LLM_PROMPT_WORKSPACE_FONTS/);
    assert.match(block, /\{id:'segments', label:'分段结果'\}/);
    assert.match(block, /openLLMPromptWorkspace/);
    assert.match(block, /closeLLMPromptWorkspace/);
    assert.match(block, /classicLLMNodePaneHeights/);
    assert.match(block, /rawOutputHeight && rawOutputHeight !== 150 \? rawOutputHeight : 110/);
    assert.match(block, /outputHeight:splitEnabled \? outputBase : outputBase \+ userExtraHeight/);
    assert.match(block, /segmentsHeight:splitEnabled \? segmentsBase \+ userExtraHeight : segmentsBase/);
    assert.match(block, /classicLLMPromptWorkspaceSegmentsHtml/);
    assert.match(block, /llmInputText\(node\)[\s\S]*readonly:Boolean\(connectedInput\)/);
    assert.match(source, /syncClassicLLMNodePaneHeights\(resizeNode\.node,\s*el\)/);
});
