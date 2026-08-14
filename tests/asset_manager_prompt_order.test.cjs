const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'asset-manager.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'asset-manager.css'), 'utf8');

test('prompt library rows expose guarded drag sorting and category drop targets', () => {
    assert.match(source, /function promptReorderEnabled\(\)/);
    assert.match(source, /function promptMoveEnabled\(\)/);
    assert.match(source, /return Boolean\(lib && !lib\.readonly && !promptQuery\.trim\(\)\)/);
    assert.match(source, /data-prompt-drop-category/);
    assert.match(source, /data-prompt-category-order-id/);
    assert.match(source, /\/api\/prompt-libraries\/categories\/reorder/);
    assert.match(source, /reorderPromptCategories/);
    assert.match(source, /data-prompt-item-drag/);
    assert.match(source, /draggable="true" role="button"/);
    assert.match(source, /data-prompt-row=.*draggable=/);
    assert.match(source, /String\(categoryId\) === 'all'/);
    assert.match(source, /activeCategory === 'all'/);
    assert.match(source, /const sameVisibleList = activeCategory === 'all'/);
    assert.match(source, /\/api\/prompt-libraries\/items\/reorder/);
    assert.match(source, /movePromptToCategory/);
    assert.match(source, /dataTransfer\.effectAllowed = 'move'/);
});

test('prompt library drag states provide visible insertion and category feedback', () => {
    assert.match(css, /\.prompt-row\.is-order-before/);
    assert.match(css, /\.prompt-row\.is-order-after/);
    assert.match(css, /\.prompt-list\.is-order-end/);
    assert.match(css, /\.prompt-row-grip/);
    assert.match(css, /\.prompt-row\[draggable="true"\]/);
    assert.match(css, /\.tree-row\.prompt-drop-target/);
    assert.match(css, /\.tree-row\.is-order-before/);
    assert.match(css, /\.tree-row\.is-order-after/);
    assert.match(css, /content:'➜'/);
    assert.match(css, /content:'放入此分类'/);
});
