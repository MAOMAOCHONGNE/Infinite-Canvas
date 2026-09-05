const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const classic = fs.readFileSync(path.join(ROOT, 'static/js/canvas.js'), 'utf8');
const smart = fs.readFileSync(path.join(ROOT, 'static/js/smart-canvas.js'), 'utf8');
const classicHtml = fs.readFileSync(path.join(ROOT, 'static/canvas.html'), 'utf8');
const smartHtml = fs.readFileSync(path.join(ROOT, 'static/smart-canvas.html'), 'utf8');
const releaseVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

function escapedRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('both canvases identify fixed Banana suffixes while leaving the base model dynamic', () => {
    for (const source of [classic, smart]) {
        assert.match(source, /normalized\.match\(\/\(\?:\^\|\-\)\(1k\|2k\|4k\)\$\//);
        assert.match(source, /function bananaModelResolutionTitle\(model[^)]*\)\{[\s\S]*?effective(?:Smart)?FixedImageResolution/);
        assert.match(source, /function effective(?:Smart)?FixedImageResolution\([^)]*\)\{[\s\S]*?ResolutionRoutingEnabled[\s\S]*?bananaModelFixedResolution/);
    }
});

test('classic canvas normalizes and disables non-authoritative fixed Banana choices', () => {
    assert.match(classic, /function normalizeApiNodeSizeChoice\(node\)\{[\s\S]*?node\.resolution = fixedBananaResolution;/);
    assert.match(classic, /const isFixedOption = Boolean\(fixedBananaResolution\) && option\.value !== fixedBananaResolution;/);
    assert.match(classic, /resolutionSelect\.disabled = Boolean\(fixedBananaResolution\) \|\| \(routingEnabled && availableResolutions\.length <= 1\)/);
});

test('smart canvas renders a fixed-only picker and guards stale size events', () => {
    assert.match(smart, /const options = routingEnabled[\s\S]*?smartAvailableImageResolutions[\s\S]*?: fixedBananaResolution[\s\S]*?\? \[fixedBananaResolution\]/);
    assert.match(smart, /固定参数/);
    assert.match(smart, /if\(routingEnabled && lockedSizeKey\.has\(key\)/);
    assert.match(smart, /if\(routingEnabled \|\| fixedBananaResolution\) return;/);
});

test('both pages load the cache-busted controllers after the fixed-resolution change', () => {
    assert.match(classicHtml, new RegExp(`canvas\\.js\\?v=${escapedRegex(releaseVersion)}\\.\\d+`));
    assert.match(smartHtml, new RegExp(`smart-canvas\\.js\\?v=${escapedRegex(releaseVersion)}\\.\\d+`));
});
