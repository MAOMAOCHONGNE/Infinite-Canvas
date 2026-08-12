const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function promptModel(){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function classicLoopPromptFieldValues', 'function imageRefsFromNode');
    return new Function('loopContext', 'loopCount', 'loopInputPromptItems', 'loopInputPrompt', 'tr', `
        ${block}
        return {
            values:classicLoopPromptFieldValues,
            set:setClassicLoopPromptFieldValues,
            add:addClassicLoopPromptField,
            remove:removeClassicLoopPromptField,
            selected:classicLoopSelectedLocalPrompt,
            capacity:classicLoopPromptCapacity,
            render:renderLoopPrompt,
        };
    `)(
        {},
        node => Math.max(1, Number(node?.count || 1) || 1),
        node => Array.isArray(node.upstreamItems) ? node.upstreamItems.filter(Boolean) : [],
        (node, ctx) => typeof node.upstream === 'function' ? node.upstream(ctx) : String(node.upstream || ''),
        key => ({'canvas.counterToken':'序号', 'canvas.totalToken':'总数', 'canvas.progressToken':'进度'}[key] || key),
    );
}

test('legacy classic local prompt remains one whole first row', () => {
    const model = promptModel();
    const legacy = {type:'loop', variablePrompt:'first line\nsecond line'};

    assert.deepEqual(model.values(legacy), ['first line\nsecond line']);
    model.add(legacy);
    assert.deepEqual(legacy.variablePrompts, ['first line\nsecond line', '']);
    assert.equal(legacy.variablePrompt, 'first line\nsecond line');
});

test('classic local prompt row mutations keep at least one ordered row', () => {
    const model = promptModel();
    const node = {type:'loop'};

    model.set(node, [' first ', ' second ']);
    assert.deepEqual(node.variablePrompts, ['first', 'second']);
    assert.equal(node.variablePrompt, 'first\nsecond');

    model.remove(node, 0);
    assert.deepEqual(node.variablePrompts, ['second']);
    model.remove(node, 0);
    assert.deepEqual(node.variablePrompts, ['second']);
});

test('classic local prompt selection advances once per round, skips blank rows, and never repeats', () => {
    const model = promptModel();
    const node = {type:'loop', loopStart:1, variablePrompts:['A', '', 'B']};

    assert.equal(model.selected(node, {index:1}), 'A');
    assert.equal(model.selected(node, {index:2}), 'B');
    assert.equal(model.selected(node, {index:3}), '');
});

test('classic loop prompt capacity uses the longer non-empty upstream or local sequence', () => {
    const model = promptModel();

    assert.equal(model.capacity({type:'loop', showPrompt:false, upstreamItems:['A'], variablePrompts:['B']}), 0);
    assert.equal(model.capacity({type:'loop', showPrompt:true, upstreamItems:['A', 'B'], variablePrompts:['LOCAL']}), 2);
    assert.equal(model.capacity({type:'loop', showPrompt:true, upstreamItems:['A'], variablePrompts:['ONE', '', 'THREE']}), 2);
    assert.equal(model.capacity({type:'loop', showPrompt:true, upstreamItems:[], variablePrompts:['', '']}), 0);
});

test('classic loop combines current upstream and local rows before replacing variables', () => {
    const model = promptModel();
    const node = {
        type:'loop',
        showPrompt:true,
        count:3,
        loopStart:1,
        upstream:ctx => `UP ${ctx.index} 《计数》`,
        variablePrompts:['LOCAL ONE', 'LOCAL 《进度》'],
    };

    assert.equal(model.render(node, {index:2, total:3}), 'UP 2 2\n\nLOCAL 2/3');
    node.upstream = '';
    assert.equal(model.render(node, {index:1, total:3}), 'LOCAL ONE');
    node.variablePrompts = [''];
    node.upstream = 'UP ONLY';
    assert.equal(model.render(node, {index:1, total:3}), 'UP ONLY');
});

test('classic loop renders editable indexed rows with add and delete controls', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const rowsBlock = sourceBlock(source, 'function classicLoopPromptRowsHtml', 'const CLASSIC_PROMPT_SEPARATOR_DEFAULT');
    const rowsHtml = new Function(
        'classicLoopPromptFieldValues', 'loopVariableHtml', 'escapeAttr', 'escapeHtml', 'tr',
        `${rowsBlock}; return classicLoopPromptRowsHtml;`,
    )(
        () => ['alpha', 'beta'],
        value => String(value),
        value => String(value),
        value => String(value),
        key => ({'common.delete':'Delete', 'canvas.loopAddPrompt':'Add prompt', 'canvas.loopVariablePlaceholder':'Prompt'}[key] || key),
    );
    const html = rowsHtml({type:'loop'});

    assert.equal((html.match(/data-loop-prompt-index=/g) || []).length, 2);
    assert.match(html, /data-loop-prompt-index="0"[^>]*contenteditable="true"/);
    assert.match(html, /data-loop-prompt-index="1"[^>]*contenteditable="true"/);
    assert.equal((html.match(/data-loop-prompt-delete=/g) || []).length, 2);
    assert.match(html, /data-loop-prompt-add/);
    assert.doesNotMatch(html, /is-disabled|contenteditable="false"/);
});

test('classic loop multi-row controls are integrated and grow by row count', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const body = sourceBlock(source, 'function renderLoopBody', 'function llmConnectedMediaPreviewHtml');
    const sizing = sourceBlock(source, 'function autoSizeLoopForPanels', 'function loopTokenChipHtml');

    assert.match(body, /classicLoopPromptRowsHtml\(node\)/);
    assert.match(body, /\[data-loop-prompt-add\]/);
    assert.match(body, /\[data-loop-prompt-delete\]/);
    assert.match(body, /setClassicLoopPromptFieldValues/);
    assert.match(body, /tr\('canvas\.loopPromptHelp'\)/);
    assert.match(body, /tr\('canvas\.loopImageHelp'\)/);
    assert.doesNotMatch(body, /hasUpstreamPrompt\s*\?\s*'false'\s*:\s*'true'/);
    assert.match(sizing, /classicLoopPromptFieldValues\(node\)\.length/);
    assert.match(css, /\.loop-prompt-item\s*\{/);
    assert.match(css, /\.loop-prompt-add\s*\{/);
    assert.match(i18n, /"canvas\.loopAddPrompt"/);
    assert.match(i18n, /"canvas\.loopPromptHelp"\s*:\s*\{\s*zh:\s*"每轮依次使用1条提示词；用完后，剩余轮次自动跳过。"/);
    assert.match(i18n, /"canvas\.loopImageHelp"\s*:\s*\{\s*zh:\s*"每轮依次使用设定数量的图片；最后不足一批时仍会运行，用完后自动跳过剩余轮次。"/);
    assert.match(i18n, /"canvas\.loopVariablePlaceholder"\s*:\s*\{\s*zh:\s*"输入这一轮使用的提示词…"/);
});

test('classic upstream prompt selection does not wrap after the final item', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const block = sourceBlock(source, 'function loopInputPrompt(node', 'function classicLoopPromptFieldValues');

    assert.match(block, /items\[currentIndex\s*-\s*1\]\s*\|\|\s*''/);
    assert.doesNotMatch(block, /%\s*items\.length/);
});
