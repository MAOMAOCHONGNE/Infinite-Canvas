const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CANVAS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const PLAN_PATH = path.join(ROOT, 'static', 'js', 'classic-cascade-plan.js');
const ClassicCascadePlan = require(PLAN_PATH);

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function localPromptRenderers(){
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const start = source.indexOf('function classicApiLocalPromptEditorHtml');
    if(start < 0) return null;
    const end = source.indexOf('function renderGeneratorBody', start);
    assert.ok(end > start, 'missing local prompt renderer boundary');
    const block = source.slice(start, end);
    return new Function('escapeHtml', 'escapeAttr', 'tr', `${block}; return {
        editor:classicApiLocalPromptEditorHtml,
        section:typeof classicApiPromptSectionHtml === 'function' ? classicApiPromptSectionHtml : null,
    };`)(
        value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
        key => ({
            'canvas.apiLocalPrompt':'提示词',
            'canvas.apiLocalPromptPlaceholder':'输入提示词…',
            'canvas.apiAppendPrompt':'补充提示词（追加）',
            'canvas.apiAppendPromptPlaceholder':'可在这里追加补充要求…',
        })[key] || key,
    );
}

function runGeneratorHarness({localPrompt='', upstreamPrompts=[]}={}){
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const runBlock = sourceBlock(source, 'async function runGenerator(genId, opts={})', 'async function midjourneyRequest');
    const submitted = [];
    const alerts = [];
    const gen = {
        id:'gen-1',
        type:'generator',
        localPrompt,
        apiProvider:'provider-1',
        model:'gpt-image-2',
        resolution:'2k',
        quality:'auto',
        count:1,
        running:false,
    };
    const sources = upstreamPrompts.map((prompt, index) => ({id:`prompt-${index + 1}`, prompt, refs:[]}));
    const dependencies = {
        ClassicCascadePlan,
        nodes:[gen],
        cascadeTargetIdFromOptions:() => '',
        orderedSources:(_gen, values) => values,
        generatorSources:() => sources,
        imageRefsOnly:values => values,
        alert:message => alerts.push(message),
        tr:key => key,
        normalizeClassicApiCount:() => 1,
        outputForNode:() => null,
        runSnapshot:(_node, prompt, refs) => ({prompt, refs}),
        prepareGeneratorImageRequest:async () => ({size:'2048x2048', aspectRatio:'1:1', referenceImages:[]}),
        resolveImageProviderId:value => value,
        resolveImageModel:value => value,
        normalizedImageQuality:() => '',
        nowMs:() => 100,
        refreshRunNodes:() => {},
        createCanvasImageTask:async payload => { submitted.push(payload); return {task_id:'task-1'}; },
        waitCanvasImageTaskResult:async () => ({images:['result.png']}),
        requestMetaFromResult:() => ({}),
        mergeGeneratedOutputs:() => {},
        addGenerationLog:() => {},
        scheduleSave:() => {},
        uid:prefix => `${prefix}-1`,
        makePendingForRun:() => ({}),
        saveCanvas:async () => {},
        pollCanvasImageTask:async () => 'done',
        pendingById:() => null,
        collectRunMetas:() => [],
        isCascadeAbortError:() => false,
        cascadeAbortError:message => new Error(message),
        cascadeStopMessage:() => 'stopped',
        showErrorModal:() => {},
        setTimeout:() => 0,
    };
    const names = Object.keys(dependencies);
    const values = Object.values(dependencies);
    const runGenerator = new Function(...names, `${runBlock}; return runGenerator;`)(...values);
    return {gen, submitted, alerts, run:() => runGenerator(gen.id, {cascade:true})};
}

test('classic API prompt composition keeps upstream order and appends the nonblank local prompt last', () => {
    assert.equal(typeof ClassicCascadePlan.composeGeneratorPrompt, 'function');
    assert.equal(
        ClassicCascadePlan.composeGeneratorPrompt(['上游一', '  上游二  ', ''], '  固定要求  '),
        '上游一\n\n  上游二  \n\n  固定要求  ',
    );
    assert.equal(ClassicCascadePlan.composeGeneratorPrompt([], '   '), '');
});

test('classic API generation submits a local-only prompt without requiring an upstream Prompt node', async () => {
    const harness = runGeneratorHarness({localPrompt:'直接输入的提示词'});
    await harness.run();

    assert.deepEqual(harness.alerts, []);
    assert.equal(harness.submitted.length, 1);
    assert.equal(harness.submitted[0].prompt, '直接输入的提示词');
});

test('classic API generation appends local text after all connected prompts', async () => {
    const harness = runGeneratorHarness({localPrompt:'固定画质要求', upstreamPrompts:['场景描述', '人物描述']});
    await harness.run();

    assert.deepEqual(harness.alerts, []);
    assert.equal(harness.submitted.length, 1);
    assert.equal(harness.submitted[0].prompt, '场景描述\n\n人物描述\n\n固定画质要求');
});

test('classic API generation still blocks when local prompt, upstream prompts, and images are all empty', async () => {
    const harness = runGeneratorHarness({localPrompt:'   '});
    await harness.run();

    assert.deepEqual(harness.alerts, ['canvas.needPromptOrImage']);
    assert.deepEqual(harness.submitted, []);
});

test('classic API local prompt UI is one simple labeled textarea without nested hint or counter chrome', () => {
    const {editor:renderEditor} = localPromptRenderers();
    assert.equal(typeof renderEditor, 'function');

    const html = renderEditor({localPrompt:'保留原来的字体'});
    assert.match(html, /提示词/);
    assert.match(html, /class="api-local-prompt-input"/);
    assert.match(html, />保留原来的字体<\/textarea>/);
    assert.doesNotMatch(html, /prompt-counter/);
    assert.doesNotMatch(html, /api-local-prompt-hint/);
});

test('classic API local prompt wording changes from direct prompt to appended supplement', () => {
    const {editor:renderEditor} = localPromptRenderers();
    const direct = renderEditor({localPrompt:''}, false);
    const appended = renderEditor({localPrompt:''}, true);

    assert.match(direct, />提示词</);
    assert.match(direct, /placeholder="输入提示词…"/);
    assert.match(appended, />补充提示词（追加）</);
    assert.match(appended, /placeholder="可在这里追加补充要求…"/);
});

test('classic API prompt section renders connected PROMPTS before the appended local field', () => {
    const {section:renderSection} = localPromptRenderers();
    assert.equal(typeof renderSection, 'function');

    const html = renderSection({localPrompt:'固定要求'}, true);
    assert.ok(html.indexOf('class="prompt-list') < html.indexOf('class="api-local-prompt-editor"'));
});

test('classic API local prompt header exposes the existing template library on the right', () => {
    const {editor:renderEditor} = localPromptRenderers();
    const html = renderEditor({id:'gen-1', localPrompt:''}, false);

    assert.match(html, /class="api-local-prompt-label"/);
    assert.match(html, /data-prompt-template-open/);
    assert.match(html, /data-prompt-template-node-id="gen-1"/);
    assert.ok(html.indexOf('api-local-prompt-label') < html.indexOf('data-prompt-template-open'));
});

test('classic template target reads and applies an API generator local prompt without changing prompt-node behavior', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const currentBlock = sourceBlock(source, 'function currentCanvasPromptTemplateNodeText', 'function syncCanvasPromptTemplateButtons');
    const applyBlock = sourceBlock(source, 'function applyPromptTemplateToPromptNode', 'function renderLoopBody');
    const apiNode = {id:'gen-1', type:'generator', localPrompt:'existing API prompt'};
    const promptNode = {id:'prompt-1', type:'prompt', text:'existing prompt'};
    const nodes = [apiNode, promptNode];
    const currentText = new Function('nodes', 'promptTemplateNodeId', `${currentBlock}; return currentCanvasPromptTemplateNodeText;`);

    assert.equal(currentText(nodes, apiNode.id)(), 'existing API prompt');
    assert.equal(currentText(nodes, promptNode.id)(), 'existing prompt');

    const apply = new Function(
        'canvasPromptTemplates',
        'promptTemplateSelectedId',
        'nodes',
        'promptTemplateNodeId',
        'canvasPromptTemplateText',
        'closePromptTemplateModal',
        'scheduleSave',
        'syncGeneratorInputs',
        'refreshGeneratorInputViews',
        'render',
        `${applyBlock}; return applyPromptTemplateToPromptNode;`,
    )(
        [{id:'tpl-1', positive:'template body'}],
        'tpl-1',
        nodes,
        apiNode.id,
        template => template.positive,
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
    );
    apply('positive');

    assert.equal(apiNode.localPrompt, 'template body');
    assert.equal(promptNode.text, 'existing prompt');
});

test('generator refresh updates only the API prompt label and preserves its template button', () => {
    const source = fs.readFileSync(CANVAS_PATH, 'utf8');
    const refreshBlock = sourceBlock(source, 'function refreshGeneratorInputViews', 'async function runGenerator');

    assert.match(refreshBlock, /querySelector\(['"]\.api-local-prompt-label['"]\)/);
    assert.doesNotMatch(refreshBlock, /localPromptHead\.textContent/);
});
