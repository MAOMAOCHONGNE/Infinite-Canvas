const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const canvas = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'static', 'js', 'api-settings.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'static', 'api-settings.html'), 'utf8');

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('classic RunningHub submissions no longer request realtime progress', () => {
    const run = sourceBlock(canvas, 'async function runRhNode', 'async function runRhModelNode');
    const model = sourceBlock(canvas, 'async function runRhModelNode', 'function renderComfySettings');
    assert.doesNotMatch(run, /trackProgress/);
    assert.doesNotMatch(run, /updateRunningHubNodeProgress/);
    assert.doesNotMatch(run, /clearRunningHubNodeProgress/);
    assert.doesNotMatch(model, /trackProgress:true/);
});

test('classic RunningHub has no percentage cache or percentage badge', () => {
    assert.doesNotMatch(canvas, /runningHubNodeProgress/);
    assert.doesNotMatch(canvas, /runningHubProgressPercentForNode/);
    assert.doesNotMatch(canvas, /rhProgress/);
});

test('settings exposes two account cards with automatic and manual refresh', () => {
    for(const id of [
        'rhAccountRefreshBtn', 'rhCoinAccountState', 'rhCoinRemainCoins', 'rhCoinRemainMoney',
        'rhCoinTaskCount', 'rhCoinApiType', 'rhWalletAccountState', 'rhWalletRemainCoins',
        'rhWalletRemainMoney', 'rhWalletTaskCount', 'rhWalletApiType',
    ]) assert.match(settingsHtml, new RegExp(`id="${id}"`));

    assert.match(settings, /queueMicrotask\(\(\) => refreshRunningHubAccountStatus\(false\)\)/);
    assert.match(settings, /\/api\/runninghub\/account-status\?useWallet=/);
    assert.match(settings, /Promise\.all\(requests\.map\(loadOne\)\)/);
});
