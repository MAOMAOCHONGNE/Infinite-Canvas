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
    assert.match(source, /MODELSCOPE_REPO_URL\s*=\s*"https:\/\/modelscope\.cn\/studios\/qisese70\/Infinite-Canvas"/);
    assert.match(source, /MODELSCOPE_FILE_API_ROOT\s*=\s*"https:\/\/www\.modelscope\.cn\/api\/v1\/studio\/qisese70\/Infinite-Canvas\/repo\?Revision=master&FilePath="/);
    assert.doesNotMatch(source, /modelscope\.(?:cn|ai)\/studios\/daniel8152\/Infinite-Canvas/i);
});

test('backend updater exposes only the user-owned GitHub and ModelScope channels', () => {
    const source = fs.readFileSync(MAIN_PATH, 'utf8');
    const appInfo = sourceBlock(source, 'def app_info():', 'def connectivity_probe(');
    const checkUpdate = sourceBlock(source, 'def check_update():', 'def update_allowed_file(');
    const requestModel = sourceBlock(source, 'class UpdateRequest(BaseModel):', 'def github_update_file_list(');
    const updateEndpoint = sourceBlock(source, 'def update_from_github(req:', '@app.get("/api/update-backups")');

    assert.match(appInfo, /"modelscope"\s*:\s*\{/i);
    assert.match(appInfo, /"label"\s*:\s*"qisese70 ModelScope"/);
    assert.match(checkUpdate, /MODELSCOPE_VERSION_URL/);
    assert.match(checkUpdate, /"source"\s*:\s*"modelscope"/);
    assert.match(requestModel, /fallback:\s*bool\s*=\s*True/);
    assert.match(updateEndpoint, /source_order\s*=\s*\[requested_source\]/);
    assert.match(updateEndpoint, /other\s*=\s*"modelscope"\s*if\s*requested_source\s*==\s*"github"\s*else\s*"github"/);
    assert.match(updateEndpoint, /source_order\.append\(other\)/);
});

test('main page identifies qianse70 and keeps the upstream project link', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    const i18n = fs.readFileSync(COMMON_I18N_PATH, 'utf8');
    assert.match(html, /<title>qianse70 · Infinite Canvas<\/title>/);
    assert.match(html, /const PROJECT_URL = 'https:\/\/github\.com\/MAOMAOCHONGNE\/Infinite-Canvas'/);
    assert.match(html, /<div class="author-name-lite">qianse70<\/div>/);
    assert.match(html, /class="author-credit-lite"[^]*href="https:\/\/github\.com\/hero8152\/Infinite-Canvas"[^]*>基于 Infinite Canvas<\/a>/);
    assert.doesNotMatch(html, /原作者：wuli大雄/);
    assert.match(i18n, /"common\.project":\s*\{\s*zh:\s*"浅色主页",\s*en:\s*"Qianse Home"\s*\}/);
    assert.doesNotMatch(html, /space\.bilibili\.com\/78652351|xiaohongshu\.com\/user\/profile\/6433c34c|youtube\.com\/@[^"']*dx|x\.com\/dx8152/);
});

test('Infinite Canvas navigation keeps its four-square shape with a vivid gradient', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    assert.match(html, /class="nav-item canvas-nav-item"[^]*?<linearGradient id="canvas-nav-gradient"/);
    assert.match(html, /stop-color="#ec00ff"[^]*stop-color="#7c00ff"[^]*stop-color="#0057ff"/);
    assert.equal((html.match(/<rect x="(?:3|14)" y="(?:3|14)" width="7" height="7"><\/rect>/g) || []).length, 4);
});

test('browser update flow offers the user-owned ModelScope mirror and automatic fallback', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    const updateFlow = sourceBlock(html, 'function updateSourceLabel(', 'async function checkForUpdates(');
    const checkFlow = sourceBlock(html, 'async function checkForUpdates(', '</script>');
    const sourceState = sourceBlock(html, 'const savedUpdateSource', 'function setSidebarPinned(');
    assert.match(html, /data-update-source="modelscope"/);
    assert.match(html, /qisese70 ModelScope 国内镜像/);
    assert.match(html, /data-update-source="github"[^>]*onclick="setUpdateSource\('github'\)"/);
    assert.match(html, /data-update-source="modelscope"[^>]*onclick="setUpdateSource\('modelscope'\)"/);
    assert.match(sourceState, /savedUpdateSource[^]*?\['github', 'modelscope'\]\.includes\(savedUpdateSource\)/);
    assert.match(updateFlow, /fallback:true/);
    assert.match(updateFlow, /source === 'modelscope'/);
    assert.match(checkFlow, /sources\.modelscope|GitHub or ModelScope|GitHub 或 ModelScope/);
    assert.match(html, /qianse70 GitHub 定制版更新源/);
});

test('custom version and update notes form one release identity', () => {
    const version = read('VERSION').trim();
    const notes = JSON.parse(read(path.join('static', 'update-notes.json')));
    const main = fs.readFileSync(MAIN_PATH, 'utf8');
    assert.match(version, /^\d{4}\.\d{2}\.\d{2}-custom\.\d+$/);
    assert.equal(notes.version, version);
    assert.deepEqual(notes.items, [
        { type: 'fix', text: '完善 RunningHub 跨页面排队、远程取消与任务状态控制' },
        { type: 'fix', text: '完善版本管理、备份导入刷新及 Windows 启停脚本' }
    ]);
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
