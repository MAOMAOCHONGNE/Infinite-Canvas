const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'backup-manager.js');
const backup = require(MODULE_PATH);

function fixture(){
    return {
        projects:[
            {id:'project-a', name:'A项目', canvases:[{id:'a-1', title:'1画布'}, {id:'a-2', title:'2画布'}]},
            {id:'project-b', name:'B项目', canvases:[{id:'b-1', title:'1画布'}]},
        ],
        providers:[{id:'provider-a', name:'A平台'}, {id:'provider-b', name:'B平台'}],
        runninghub:{apps:[{id:'app-1', title:'应用1'}], workflows:[{id:'wf-1', title:'工作流1'}]},
        prompt_libraries:[{id:'system', name:'系统提示词库', item_count:3}],
    };
}

test('default export selection includes all visible content and referenced assets', () => {
    const state = backup.createBackupSelection(fixture());
    assert.deepEqual([...state.canvasIds].sort(), ['a-1','a-2','b-1']);
    assert.deepEqual([...state.providerIds].sort(), ['provider-a','provider-b']);
    assert.deepEqual([...state.runninghubAppIds], ['app-1']);
    assert.deepEqual([...state.runninghubWorkflowIds], ['wf-1']);
    assert.deepEqual([...state.promptLibraryIds], ['system']);
    assert.equal(state.includeAssets, true);
});

test('preference backup is selectable and included without exposing browser secrets', () => {
    const state = backup.createBackupSelection({...fixture(), preferences:{available:true}});
    assert.equal(state.includePreferences, true);
    const payload = backup.buildBackupExportRequest(state);
    assert.equal(payload.include_preferences, true);
    assert.deepEqual(payload.preferences, {theme:'light', scale_mode:'auto', favorites:{}});
    backup.setAllSelected(state, false);
    assert.equal(state.includePreferences, false);
    assert.equal(payload.preferences.favorites?.api_key, undefined);
});

test('project tri-state follows its selected canvases', () => {
    const state = backup.createBackupSelection(fixture());
    backup.setCanvasSelected(state, 'a-2', false);
    assert.equal(backup.projectSelectionState(state, 'project-a'), 'mixed');
    backup.setProjectSelected(state, 'project-a', false);
    assert.equal(backup.projectSelectionState(state, 'project-a'), 'unchecked');
    assert.equal(state.canvasIds.has('a-1'), false);
});

test('export request contains identifiers only and never configuration values', () => {
    const state = backup.createBackupSelection(fixture());
    const payload = backup.buildBackupExportRequest(state);
    const encoded = JSON.stringify(payload);

    assert.deepEqual(payload.canvas_ids.sort(), ['a-1','a-2','b-1']);
    assert.deepEqual(payload.provider_ids.sort(), ['provider-a','provider-b']);
    assert.equal(payload.include_assets, true);
    assert.doesNotMatch(encoded, /api[_-]?key|secret|password|base_url/i);
});

test('studio shell owns the backup modal and opens it without changing the active page', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
    const canvasHtml = fs.readFileSync(path.join(ROOT, 'static', 'canvas-list.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'backup-manager.css'), 'utf8');
    const backend = fs.readFileSync(path.join(ROOT, 'main.py'), 'utf8');
    const manager = fs.readFileSync(MODULE_PATH, 'utf8');

    assert.doesNotMatch(canvasHtml, /id="backupMenuBtn"/);
    assert.doesNotMatch(canvasHtml, /class="backup-menu-wrap"/);
    assert.match(shell, /id="backupModal"/);
    assert.match(shell, /backup-manager\.css/);
    assert.match(shell, /backup-manager\.js/);
    assert.match(shell, /InfiniteCanvasBackup\?\.openBackupAction\?\./);
    const handler = shell.match(/function handleGlobalBackupAction\(action\)\s*\{[\s\S]*?\n\s*\}/)?.[0] || '';
    assert.doesNotMatch(handler, /switchUI\(/);
    assert.doesNotMatch(shell, /pendingGlobalBackupAction|flushPendingBackupAction/);
    assert.match(manager, /function openBackupAction\(/);
    assert.match(manager, /returnFocusTarget/);
    assert.match(manager, /studio-backup-action/);
    assert.match(manager, /event\.source !== window\.parent/);
    assert.match(manager, /event\.origin !== location\.origin/);
    assert.match(css, /\.backup-modal-overlay/);
    assert.match(css, /\.backup-tree/);
    assert.match(backend, /@app\.get\("\/api\/backups\/options"\)/);
    assert.match(backend, /@app\.post\("\/api\/backups\/export"\)/);
    assert.match(backend, /@app\.post\("\/api\/backups\/inspect"\)/);
    assert.match(backend, /@app\.post\("\/api\/backups\/import"\)/);
});

test('backup UI explains endpoint changes and secret-preserving provider conflicts', () => {
    const manager = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(manager, /采用备份的平台和模型设置（保留本机密钥）/);
    assert.match(manager, /RunningHub 请求地址将切换为/);
    assert.match(manager, /界面与使用偏好/);
    assert.match(manager, /RunningHub 应用 \$\{result\.runninghub_apps_imported\}/);
    assert.match(manager, /RunningHub 工作流 \$\{result\.runninghub_workflows_imported\}/);
});

test('backup import defaults to backup policies, reports skips, and refreshes after acknowledgement', () => {
    const manager = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(manager, /provider_conflict:'backup', runninghub_conflict:'backup'/);
    assert.match(manager, /采用备份的平台和模型设置（保留本机密钥）（推荐）/);
    assert.match(manager, /采用备份应用\/工作流（推荐）/);
    assert.match(manager, /result\.providers_skipped/);
    assert.match(manager, /result\.runninghub_apps_skipped/);
    assert.match(manager, /result\.runninghub_workflows_skipped/);
    assert.match(manager, /result\.prompt_libraries_skipped/);
    assert.match(manager, /window\.loadAll\(\)/);
    assert.match(manager, /backup-imported/);
    const canvasList = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas-list.js'), 'utf8');
    assert.match(canvasList, /window\.loadAll\s*=\s*loadAll/);
    assert.match(manager, /const importMessage = zh/);
    assert.doesNotMatch(manager, /alert\(zh\(`导入完成/);
    assert.match(manager, /_backup_refresh/);
});

test('backup modal gives its middle content a definite scrollable viewport', () => {
    const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'backup-manager.css'), 'utf8');
    const modalRule = css.match(/\.backup-modal\s*\{[^}]+\}/)?.[0] || '';
    const bodyRule = css.match(/\.backup-modal-body\s*\{[^}]+\}/)?.[0] || '';

    assert.match(modalRule, /height\s*:\s*min\(/);
    assert.match(bodyRule, /min-height\s*:\s*0/);
    assert.match(bodyRule, /overflow-y\s*:\s*auto/);
    assert.match(css, /\.backup-modal-body\s*>\s*\*\s*\{\s*flex\s*:\s*0 0 auto/);
});

test('backup tree keeps selection separate from collapsible section and group controls', () => {
    const manager = fs.readFileSync(MODULE_PATH, 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'backup-manager.css'), 'utf8');

    assert.match(manager, /const collapsedGroups\s*=\s*new Set\(\)/);
    assert.match(manager, /data-backup-collapse=/);
    assert.match(manager, /aria-expanded=/);
    assert.match(manager, /section:projects/);
    assert.match(manager, /section:assets/);
    assert.match(manager, /section:config/);
    assert.match(manager, /group:runninghub-workflows/);
    assert.match(manager, /project:\$\{projectId\}/);
    assert.match(css, /\.backup-collapsible-head/);
    assert.match(css, /\.backup-collapse-trigger/);
    assert.match(css, /\.backup-section-head\.backup-collapse-trigger/);
});
