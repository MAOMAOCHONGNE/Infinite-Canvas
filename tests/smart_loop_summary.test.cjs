const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SMART_PATH = path.join(ROOT, 'static', 'js', 'smart-canvas.js');
const CSS_PATH = path.join(ROOT, 'static', 'css', 'smart-canvas.css');
const I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'smart-canvas.js');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('smart loop window summary derives skipped, current, and next image ranges', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const block = sourceBlock(
        source,
        'function smartLoopImageStartForRound',
        'function smartLoopInputImages'
    );
    const helper = new Function(`${block}; return smartLoopWindowState;`)();

    assert.deepEqual(helper(7, 2, 2), {
        total: 7,
        skippedCount: 2,
        current: {start: 3, end: 4, count: 2},
        next: {start: 5, end: 6, count: 2},
    });
    assert.deepEqual(helper(7, 4, 2), {
        total: 7,
        skippedCount: 6,
        current: {start: 7, end: 7, count: 1},
        next: null,
    });
    assert.deepEqual(helper(7, 5, 2), {
        total: 7,
        skippedCount: 7,
        current: null,
        next: null,
    });
});

test('smart loop renders one compact summary instead of duplicate image and prompt hints', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const body = sourceBlock(source, 'function smartLoopBodyHtml', 'function smartGroupBodyHtml');

    assert.match(body, /class="loop-smart-summary"/);
    assert.match(body, /class="loop-smart-summary-row loop-smart-summary-images"/);
    assert.match(body, /class="loop-smart-summary-row loop-smart-summary-prompt"/);
    assert.match(body, /smartLoopWindowState/);
    assert.doesNotMatch(body, /canvas\.loopImageWillOutput/);
    assert.doesNotMatch(body, /loop-smart-upstream/);
    assert.doesNotMatch(body, /data-loop-token=/);
    assert.match(body, /label:tr\('smart\.loopTotalRounds'\)/);
    assert.match(i18n, /"smart\.loopTotalRounds"\s*:\s*\{\s*zh:\s*"总轮数"/);
});

test('smart loop dims only thumbnails skipped by the configured starting round', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const thumbs = sourceBlock(source, 'function smartNodeInputThumbsHtml', 'const PROMPT_LLM_INSTRUCTION_DEFAULT_H');
    const body = sourceBlock(source, 'function smartLoopBodyHtml', 'function smartGroupBodyHtml');
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    assert.match(thumbs, /opts\.skippedBefore/);
    assert.match(thumbs, /is-skipped/);
    assert.match(body, /skippedBefore\s*:\s*imageWindow\.skippedCount/);
    assert.match(css, /\.smart-node-input-thumb\.is-skipped\s*\{[^}]*opacity\s*:\s*\.3/s);
});

test('summary rows are bounded and localized, while legacy sequence tokens remain supported', () => {
    const source = fs.readFileSync(SMART_PATH, 'utf8');
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const i18n = fs.readFileSync(I18N_PATH, 'utf8');
    const variableBlock = sourceBlock(source, 'function smartLoopVariableHtml', 'function smartLoopEditorText');

    assert.match(css, /\.loop-smart-summary-row\s*\{[^}]*text-overflow\s*:\s*ellipsis[^}]*white-space\s*:\s*nowrap/s);
    assert.match(i18n, /"smart\.loopSummaryCurrentImages"/);
    assert.match(i18n, /"smart\.loopSummaryPrompt"/);
    assert.match(i18n, /"smart\.loopSummaryNoNextImages"/);
    assert.match(variableBlock, /《计数》/);
    assert.match(variableBlock, /\[计数\]/);
});
