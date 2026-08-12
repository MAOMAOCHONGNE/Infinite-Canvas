const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.py');
const INDEX_PATH = path.join(ROOT, 'static', 'index.html');
const COMMON_I18N_PATH = path.join(ROOT, 'static', 'js', 'i18n', 'common.js');

function read(relativePath){
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function sourceBlock(source, start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing source block ${start}`);
    return source.slice(from, to);
}

test('backend update metadata targets the qianse70 repository and my-custom branch', () => {
    const source = fs.readFileSync(MAIN_PATH, 'utf8');
    assert.match(source, /CUSTOM_MAINTAINER\s*=\s*"qianse70"/);
    assert.match(source, /CUSTOM_UPDATE_BRANCH\s*=\s*"my-custom"/);
    assert.match(source, /GITHUB_REPO_URL\s*=\s*"https:\/\/github\.com\/MAOMAOCHONGNE\/Infinite-Canvas"/);
    assert.match(source, /GITHUB_VERSION_URL\s*=\s*f"https:\/\/raw\.githubusercontent\.com\/MAOMAOCHONGNE\/Infinite-Canvas\/\{CUSTOM_UPDATE_BRANCH\}\/VERSION"/);
    assert.match(source, /GITHUB_TREE_URL\s*=\s*f"https:\/\/api\.github\.com\/repos\/MAOMAOCHONGNE\/Infinite-Canvas\/git\/trees\/\{CUSTOM_UPDATE_BRANCH\}\?recursive=1"/);
    assert.match(source, /GITHUB_RAW_ROOT\s*=\s*f"https:\/\/raw\.githubusercontent\.com\/MAOMAOCHONGNE\/Infinite-Canvas\/\{CUSTOM_UPDATE_BRANCH\}"/);
});

test('backend updater exposes and accepts only the custom GitHub channel', () => {
    const source = fs.readFileSync(MAIN_PATH, 'utf8');
    const appInfo = sourceBlock(source, 'def app_info():', 'def connectivity_probe(');
    const checkUpdate = sourceBlock(source, 'def check_update():', 'def update_allowed_file(');
    const requestModel = sourceBlock(source, 'class UpdateRequest(BaseModel):', 'def github_update_file_list(');
    const updateEndpoint = sourceBlock(source, 'def update_from_github(req:', '@app.get("/api/update-backups")');

    assert.doesNotMatch(appInfo, /"modelscope"\s*:/i);
    assert.doesNotMatch(checkUpdate, /MODELSCOPE_VERSION_URL|source"\s*:\s*"modelscope"/);
    assert.match(requestModel, /fallback:\s*bool\s*=\s*False/);
    assert.match(updateEndpoint, /source_order\s*=\s*\["github"\]/);
    assert.doesNotMatch(updateEndpoint, /source_order\.append|other\s*=\s*"modelscope"/);
});

test('main page identifies qianse70 while retaining a visible original-author credit', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    const i18n = fs.readFileSync(COMMON_I18N_PATH, 'utf8');
    assert.match(html, /<title>qianse70 · Infinite Canvas<\/title>/);
    assert.match(html, /const PROJECT_URL = 'https:\/\/github\.com\/MAOMAOCHONGNE\/Infinite-Canvas'/);
    assert.match(html, /<div class="author-name-lite">qianse70<\/div>/);
    assert.match(html, /class="author-credit-lite"[^]*href="https:\/\/github\.com\/hero8152\/Infinite-Canvas"[^]*原作者：wuli大雄/);
    assert.match(i18n, /"common\.project":\s*\{\s*zh:\s*"定制版主页",\s*en:\s*"Custom Project"\s*\}/);
    assert.doesNotMatch(html, /space\.bilibili\.com\/78652351|xiaohongshu\.com\/user\/profile\/6433c34c|youtube\.com\/@[^"']*dx|x\.com\/dx8152/);
});

test('browser update flow has no ModelScope selector or automatic fallback', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    const updateFlow = sourceBlock(html, 'function updateSourceLabel(', 'window.rollbackProjectUpdate = rollbackProjectUpdate;');
    const checkFlow = sourceBlock(html, 'async function checkForUpdates(', '</script>');
    assert.doesNotMatch(html, /data-update-source="modelscope"/);
    assert.match(updateFlow, /fallback:false/);
    assert.doesNotMatch(updateFlow, /fallback:true|bestUpdateSourceFromConnectivity|source === 'modelscope'/);
    assert.doesNotMatch(checkFlow, /source:'modelscope'|sources\.modelscope|GitHub or ModelScope|GitHub 或 ModelScope/);
    assert.match(html, /qianse70 GitHub 定制版更新源/);
});

test('custom version and update notes form one release identity', () => {
    const version = read('VERSION').trim();
    const notes = read(path.join('static', 'update-notes.json'));
    const main = fs.readFileSync(MAIN_PATH, 'utf8');
    assert.equal(version, '2026.08.09-custom.1');
    assert.match(notes, /"version"\s*:\s*"2026\.08\.09-custom\.1"/);
    assert.match(notes, /qianse70/);
    assert.match(main, /"edition":\s*CUSTOM_MAINTAINER/);
    assert.match(main, /"update_channel":\s*CUSTOM_UPDATE_BRANCH/);
    assert.match(main, /"upstream_repo_url":\s*UPSTREAM_REPO_URL/);
});

test('publication ignores local secrets, data, generated media, runtimes, and planning artifacts', () => {
    const ignore = read('.gitignore');
    for(const pattern of [
        'API/.env', 'data/', 'assets/', 'output/', 'python/', 'history.json',
        'task_plan.md', 'findings.md', 'progress.md', '.playwright-cli/'
    ]){
        assert.ok(ignore.split(/\r?\n/).includes(pattern), `missing .gitignore rule: ${pattern}`);
    }
});
