const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'static', 'js', 'canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'canvas.css');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

function settingsHarness(){
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const defaultBlock = sourceBlock(source, 'function isGptImageAutoSizeModel', 'function resolveChatModel');
    const normalizeBlock = sourceBlock(source, 'function normalizeApiNodeSizeChoice', 'async function generatorSizeForRun');
    const addBlock = sourceBlock(source, 'function addGeneratorNode', 'function addMidjourneyNode');

    return new Function(
        'resolveImageModel', 'addNode', 'defaultPoint', 'imageApiProviders', 'allImageModels', 'uid', 'escapeAttr',
        'imageResolutionRoutingEnabled', 'availableImageResolutions',
        `
            ${defaultBlock}
            ${normalizeBlock}
            ${addBlock}
            return {
                add:addGeneratorNode,
                normalizeSize:normalizeApiNodeSizeChoice,
                sharedDefault:defaultApiImageResolution,
                generatorDefault:typeof defaultClassicApiGeneratorResolution === 'function' ? defaultClassicApiGeneratorResolution : null,
                qualityHtml:typeof classicApiQualityOptionsHtml === 'function' ? classicApiQualityOptionsHtml : null,
                normalizeCount:typeof normalizeClassicApiCount === 'function' ? normalizeClassicApiCount : null,
                countHtml:typeof classicApiCountControlHtml === 'function' ? classicApiCountControlHtml : null,
            };
        `,
    )(
        value => value,
        node => node,
        () => ({x:120, y:240}),
        () => [{id:'provider-1'}],
        () => ['gpt-image-2'],
        prefix => `${prefix}-1`,
        value => String(value),
        () => false,
        () => [],
    );
}

test('new classic API generator defaults to 2K and automatic quality without rewriting saved 4K', () => {
    const settings = settingsHarness();
    assert.equal(settings.sharedDefault('gpt-image-2'), '4k');
    assert.equal(typeof settings.generatorDefault, 'function');
    assert.equal(settings.generatorDefault('gpt-image-2'), '2k');
    const node = settings.add();

    assert.equal(node.resolution, '2k');
    assert.equal(node.quality, 'auto');
    assert.equal(node.count, 1);
    assert.equal(node.localPrompt, '');

    const saved = {model:'gpt-image-2', resolution:'4k', quality:'high', count:9, _apiResolutionUserSet:true};
    settings.normalizeSize(saved);
    assert.deepEqual(saved, {model:'gpt-image-2', resolution:'4k', quality:'high', count:9, _apiResolutionUserSet:true});
});

test('classic API quality options use understandable Chinese labels while preserving parameter values', () => {
    const settings = settingsHarness();
    assert.equal(typeof settings.qualityHtml, 'function');

    const html = settings.qualityHtml();
    assert.match(html, /<option value="auto">自动<\/option>/);
    assert.match(html, /<option value="low">低<\/option>/);
    assert.match(html, /<option value="medium">中<\/option>/);
    assert.match(html, /<option value="high">高<\/option>/);
});

test('classic API count uses the shared select shell and a native four-preset popup while keeping manual 1-10 input', () => {
    const settings = settingsHarness();
    assert.equal(typeof settings.normalizeCount, 'function');
    assert.equal(typeof settings.countHtml, 'function');

    assert.equal(settings.normalizeCount(undefined), 1);
    assert.equal(settings.normalizeCount(0), 1);
    assert.equal(settings.normalizeCount(3.8), 3);
    assert.equal(settings.normalizeCount('9'), 9);
    assert.equal(settings.normalizeCount(10), 10);
    assert.equal(settings.normalizeCount(11), 10);

    const html = settings.countHtml({id:'gen-7', count:5});
    assert.match(html, /class="gen-count-row editable-count select-lite"/);
    assert.match(html, /class="gen-count-input" type="text"/);
    assert.match(html, /inputmode="numeric"/);
    assert.match(html, /class="gen-count-preset-select"/);
    assert.match(html, /aria-label="选择生成张数"/);
    assert.deepEqual(
        [...html.matchAll(/<option value="(\d+)">(\d+)张<\/option>/g)]
            .map(match => Number(match[1])),
        [1, 2, 4, 9],
    );
    assert.match(html, /value="5"/);
    assert.doesNotMatch(html, /type="number"/);
    assert.doesNotMatch(html, /gen-count-toggle/);
    assert.doesNotMatch(html, /gen-count-menu/);
    assert.doesNotMatch(html, /role="listbox"/);
    assert.doesNotMatch(html, /data-step=/);
});

test('classic ordinary generator uses the shared count control and the same 1-10 normalization when submitting', () => {
    const source = fs.readFileSync(JS_PATH, 'utf8');
    const body = sourceBlock(source, 'function renderGeneratorBody', 'function midjourneyModalHtml');
    const run = sourceBlock(source, 'async function runGenerator', 'async function runVideoNode');

    assert.match(body, /classicApiQualityOptionsHtml\(\)/);
    assert.match(body, /classicApiCountControlHtml\(node\)/);
    assert.match(body, /normalizeClassicApiCount\(e\.target\.value/);
    assert.match(body, /\.gen-count-preset-select/);
    assert.match(body, /countPresetSelect\.onchange/);
    assert.doesNotMatch(body, /\.gen-count-toggle/);
    assert.doesNotMatch(body, /\.gen-count-menu/);
    assert.ok((body.match(/defaultClassicApiGeneratorResolution\(node\.model(?:,\s*node\.apiProvider)?\)/g) || []).length >= 3);
    assert.equal((run.match(/const count = normalizeClassicApiCount\(gen\.count/g) || []).length, 2);
});

test('classic API count popup options use the same normal font weight as adjacent native select options', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const match = css.match(/\.gen-count-preset-select option\s*\{([^}]*)\}/);
    assert.ok(match, 'missing count preset option style');
    assert.match(match[1], /font-weight\s*:\s*400/);
    assert.doesNotMatch(match[1], /font\s*:\s*inherit/);
});
