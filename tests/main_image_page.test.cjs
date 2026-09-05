const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static', 'main-image.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'main-image.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'static', 'js', 'main-image.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');

test('main-image page is independent and uses the approved defaults', () => {
    assert.match(index, /switchUI\(this, 'main-image'\)/);
    assert.match(index, /frame-main-image/);
    assert.match(html, /<title>一键主图<\/title>/);
    assert.match(html, /id="mainImageMode"/);
    assert.match(html, /value="continuous" selected/);
    assert.match(html, /id="screenCount"[\s\S]*?<option selected>4<\/option>/);
    assert.match(js, /mainImageMode:'continuous'/);
    assert.match(js, /ratio:'1:1'/);
    assert.match(js, /resolution:'2k'/);
    assert.match(js, /screenCount:'4'/);
    assert.doesNotMatch(html, /反转屏|购买目的/);
});

test('smart analysis is optional and only fills empty fields', () => {
    assert.match(html, /id="smartAnalyzeBtn"/);
    assert.match(html, /会调用所选视觉 LLM 并消耗 Token/);
    assert.match(js, /\/api\/main-image\/analyze/);
    assert.match(js, /if\(!String\(detailState\[key\] \|\| ''\)\.trim\(\) && value\)/);
    assert.match(js, /已有内容保持不变/);
    assert.match(css, /\.smart-analysis-dialog/);
});

test('main-image uses one customer-facing product features field', () => {
    assert.match(html, /<span>产品特点<\/span>[\s\S]*?id="productFacts"/);
    assert.doesNotMatch(html, /<span>产品事实<\/span>|<span>功能卖点<\/span>|id="sellingPoints"|id="smartSellingPoints"/);
    assert.match(js, /detailMergeFeatureText\(settings\.product_facts, settings\.selling_points\)/);
    assert.match(js, /selling_points:''/);
});

test('main-image history and generation use isolated endpoints without x4 control', () => {
    assert.match(js, /\/api\/main-image-tasks/);
    assert.doesNotMatch(js, /\/api\/detail-page-tasks/);
    assert.match(js, /main_image_preset_v1/);
    assert.match(js, /main-images-changed/);
    assert.doesNotMatch(html, />×4<|>x4</i);
});

test('result UI supports history, rename, prompt edit, reorder and downloads', () => {
    for(const marker of ['historySelect', 'renameTaskBtn', 'promptEditorModal', 'collageBtn', 'downloadAllBtn']){
        assert.match(html, new RegExp(`id="${marker}"`));
    }
    assert.match(js, /screens\/reorder/);
    assert.match(js, /optimize-prompt/);
    assert.match(js, /download\.zip/);
});

test('main-image group deletion is immediate and cleanup is tracked separately', () => {
    assert.match(js, /deletingTaskId/);
    assert.match(js, /cleanup_job_id/);
    assert.match(js, /图片正在后台清理/);
    assert.match(js, /void detailOpenHistoryTask\(nextId/);
    assert.match(js, /cached \|\| await detailFetchJson/);
    assert.match(js, /aria-busy/);
});
