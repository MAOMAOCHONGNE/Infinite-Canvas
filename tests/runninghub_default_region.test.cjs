const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('fresh installations default RunningHub to the China endpoint', () => {
    const main = read('main.py');
    const settings = read('static', 'js', 'api-settings.js');
    const settingsHtml = read('static', 'api-settings.html');
    const bundledProviders = JSON.parse(read('static', 'runninghub', 'api_providers.json'));
    const runningHub = bundledProviders.find(item => item.id === 'runninghub');

    assert.match(main, /RUNNINGHUB_DEFAULT_BASE_URL = "https:\/\/www\.runninghub\.cn"/);
    assert.match(main, /RUNNINGHUB_OPENAPI_BASE_URL = "https:\/\/www\.runninghub\.cn\/openapi\/v2"/);
    assert.match(settings, /const RH_DEFAULT_BASE_URL = 'https:\/\/www\.runninghub\.cn'/);
    assert.match(settings, /primaryUrl:'https:\/\/www\.runninghub\.cn\/enterprise-api\/consumerApi/);
    assert.match(settingsHtml, /国内默认请求地址：[\s\S]*https:\/\/www\.runninghub\.cn/);
    assert.match(settingsHtml, /国外使用请求地址：[\s\S]*https:\/\/www\.runninghub\.ai/);
    assert.equal(runningHub?.base_url, 'https://www.runninghub.cn');
});
