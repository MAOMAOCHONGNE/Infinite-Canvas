const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static', 'canvas.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'canvas.css'), 'utf8');
const source = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'static', 'gpt-chat.html'), 'utf8');
const studio = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');

function cssBlock(selector){
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing CSS block ${selector}`);
    return match[1];
}

test('classic canvas uses a separate 49px header and starts the board below it', () => {
    assert.match(css, /--canvas-header-height:\s*49px/);
    assert.match(cssBlock('.topbar'), /height:\s*var\(--canvas-header-height\)/);
    assert.match(cssBlock('.topbar'), /border-bottom:\s*1px solid var\(--line\)/);
    assert.match(cssBlock('.board'), /top:\s*var\(--canvas-header-height\)/);
    assert.match(cssBlock('.board'), /bottom:\s*0/);
    assert.doesNotMatch(cssBlock('.board'), /inset:\s*0/);
    assert.doesNotMatch(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.topbar\s*\{[^}]*top:\s*14px/);
});

test('classic canvas header keeps only the four utilities and Chat', () => {
    const toolbar = html.slice(html.indexOf('id="quickToolbar"'), html.indexOf('</div>\n        </div>', html.indexOf('id="quickToolbar"')));
    assert.doesNotMatch(toolbar, /toolbar-toggle|toolbar-items|addImageNode|addGeneratorNode/);
    const ids = ['workflowTransferToggle', 'canvasShortcutToggle', 'canvasLogToggle', 'canvasAssetToggle', 'canvasChatToggle'];
    let previous = -1;
    for(const id of ids){
        const index = toolbar.indexOf(`id="${id}"`);
        assert.ok(index > previous, `${id} must be present in the expected order`);
        previous = index;
    }
});

test('minimap and selection arrange control live at the lower-left', () => {
    const minimap = cssBlock('.minimap');
    const arrange = cssBlock('.minimap-arrange-btn');
    assert.match(minimap, /left:\s*22px/);
    assert.match(minimap, /right:\s*auto/);
    assert.match(arrange, /left:\s*22px/);
    assert.match(arrange, /right:\s*auto/);
});

test('workflow, shortcuts, logs, and assets share one exclusive tool controller', () => {
    assert.match(source, /const EXCLUSIVE_CANVAS_TOOLS\s*=\s*\['workflow',\s*'shortcuts',\s*'logs',\s*'assets'\]/);
    assert.match(source, /function openExclusiveCanvasTool\(tool\s*=\s*''\)/);
    assert.match(source, /function closeExclusiveCanvasTools\(except\s*=\s*''\)/);
    assert.match(source, /toggleCanvasAssetLibrary\([^)]*\)[\s\S]*?openExclusiveCanvasTool\('assets'\)/);
    assert.match(source, /openCanvasLog\([^)]*\)[\s\S]*?openExclusiveCanvasTool\('logs'\)/);
    assert.match(source, /openWorkflowTransferModal\([^)]*\)[\s\S]*?openExclusiveCanvasTool\('workflow'\)/);
    assert.match(source, /onOpen:\(\)\s*=>\s*\{[\s\S]*?openExclusiveCanvasTool\('shortcuts'\)/);
});

test('every active canvas toolbar utility keeps readable contrast while hovered', () => {
    for(const className of ['toolbar-workflow', 'toolbar-shortcut', 'toolbar-log', 'canvas-asset-toggle', 'toolbar-chat']){
        const expectedSelector = `.toolbar .tool-btn.${className}.active:hover`;
        const matchingRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) =>
            selectors.split(',').some(selector => selector.trim() === expectedSelector)
        );
        assert.ok(matchingRule, `${className} should define an active hover rule`);
        assert.match(matchingRule[2], /background:\s*var\(--strong\)/);
        assert.match(matchingRule[2], /color:\s*var\(--strong-text\)/);
    }
});

test('embedded chat is lazy, resizable, and resets to 490px on every open', () => {
    assert.match(html, /id="canvasChatPanel"[^>]*aria-hidden="true"/);
    assert.match(html, /id="canvasChatFrame"[^>]*data-src="\/static\/gpt-chat\.html\?embed=canvas/);
    assert.match(html, /id="canvasChatResize"/);
    assert.match(css, /--canvas-chat-default-width:\s*490px/);
    assert.match(cssBlock('.canvas-chat-panel'), /width:\s*var\(--canvas-chat-default-width\)/);
    assert.match(source, /function resetCanvasChatWidth\(\)/);
    assert.match(source, /function openCanvasChat\(\)[\s\S]*?resetCanvasChatWidth\(\)/);
    assert.match(source, /canvasChatFrame\.src\s*=\s*canvasChatFrame\.dataset\.src/);
    assert.match(source, /Math\.min\(960,\s*window\.innerWidth\s*-\s*120\)/);
});

test('embedded chat toggles closed from the toolbar and keeps its active hover treatment', () => {
    assert.match(source, /function toggleCanvasChat\(\)[\s\S]*?classList\.contains\('open'\)[\s\S]*?closeCanvasChat\(\)[\s\S]*?openCanvasChat\(\)/);
    assert.match(source, /canvasChatToggle\?\.addEventListener\('click',\s*toggleCanvasChat\)/);
    assert.match(css, /\.toolbar \.tool-btn\.toolbar-chat\.active:hover\s*\{[^}]*background:\s*var\(--strong\)[^}]*color:\s*var\(--strong-text\)/);
});

test('canvas chat embed is flat white in light mode without panel or composer shadows', () => {
    assert.match(chat, /html\.canvas-chat-embed:not\(\.studio-theme-dark\):not\(\.theme-dark\)\s*\{[^}]*--chat-bg:\s*#fff/);
    assert.match(chat, /html\.canvas-chat-embed:not\(\.studio-theme-dark\):not\(\.theme-dark\) \.composer\s*\{[^}]*background:\s*#fff[^}]*border-color:\s*var\(--chat-line\)[^}]*box-shadow:\s*none/);
    assert.match(chat, /html\.canvas-chat-embed body \.composer\s*\{\s*box-shadow:\s*none\s*!important/);
    assert.match(cssBlock('.canvas-chat-panel'), /box-shadow:\s*none/);
});

test('host stage removes its rounded frame only for the classic canvas editor', () => {
    assert.match(studio, /\.stage\.canvas-editor-stage,[\s\S]*?body\.studio-scale-host \.stage\.canvas-editor-stage\s*\{[^}]*margin:\s*0[^}]*border:\s*0[^}]*border-radius:\s*0/);
    assert.match(studio, /function syncCanvasEditorStage\(\)[\s\S]*?frame-canvas[\s\S]*?pathname\.endsWith\('\/static\/canvas\.html'\)[\s\S]*?classList\.toggle\('canvas-editor-stage',\s*isClassicEditor\)/);
    assert.match(studio, /if\(f\.id === 'frame-canvas'\) syncCanvasEditorStage\(\)/);
});

test('canvas embed mode adds a dedicated collapse control and parent message', () => {
    assert.match(chat, /const isCanvasEmbed\s*=\s*new URLSearchParams\(location\.search\)\.get\('embed'\)\s*===\s*'canvas'/);
    assert.match(chat, /id="canvasEmbedCollapse"/);
    assert.match(chat, /function closeCanvasEmbed\(\)/);
    assert.match(chat, /parent\.postMessage\(\{type:'canvas-chat-close'\},\s*location\.origin\)/);
    assert.match(source, /event\.data\?\.type\s*===\s*'canvas-chat-close'/);
});

test('canvas embed exposes one creative Agent workspace with compact creation modes', () => {
    assert.doesNotMatch(chat, /id="canvasWorkspaceTabs"/);
    assert.match(chat, /id="chatTitle"/);
    assert.match(chat, /id="creativeModeButton"/);
    assert.match(chat, /data-creative-mode="agent"[^>]*>[\s\S]*?Agent<\/button>/);
    assert.match(chat, /data-creative-mode="image"[^>]*>[\s\S]*?图片生成<\/button>/);
    assert.match(chat, /data-creative-mode="video"[^>]*>[\s\S]*?视频生成<\/button>/);
    assert.match(chat, /id="creativeModelButton"/);
    assert.match(chat, /id="creativePreferencesButton"/);
    assert.match(chat, /id="creativeMentionButton"/);
    assert.match(chat, /\/api\/canvas-creative-agent\/conversations/);
    assert.match(chat, /\/api\/chat\/canvas-creative-agent\/stream/);
    assert.match(chat, /resolveCreativeAgentReferences/);
    assert.match(chat, /shouldRequestCreativeCanvasContext/);
    assert.match(chat, /canvas-creative-agent-insert-media/);
});

test('empty creative Agent conversations keep the composer in the final grid row', () => {
    assert.match(chat, /\.chat-main\s*\{[^}]*grid-template-areas:\s*"topbar"\s+"notice"\s+"messages"\s+"composer"/);
    assert.match(chat, /\.topbar\s*\{[^}]*grid-area:\s*topbar/);
    assert.match(chat, /\.canvas-agent-notice\s*\{[^}]*grid-area:\s*notice/);
    assert.match(chat, /\.messages\s*\{[^}]*grid-area:\s*messages/);
    assert.match(chat, /\.composer-wrap\s*\{[^}]*grid-area:\s*composer/);
});

test('490px embedded creative composer keeps every tool on one row', () => {
    assert.match(chat, /@media\s*\(max-width:900px\)[\s\S]*?html\.canvas-chat-embed \.inline-controls\s*\{[^}]*flex-direction:\s*row[^}]*flex-wrap:\s*nowrap/);
    assert.match(chat, /@media\s*\(max-width:900px\)[\s\S]*?html\.canvas-chat-embed \.left-tools\s*\{[^}]*flex-wrap:\s*nowrap/);
});

test('creative Agent media bridge validates, deduplicates and saves one canvas mutation', () => {
    assert.match(source, /type\s*===\s*'canvas-creative-agent-media-request'/);
    assert.match(source, /isCreativeAgentInsertEvent\?\.\(event,\s*location\.origin,\s*canvasChatFrame\?\.contentWindow,\s*canvas\?\.id/);
    assert.match(source, /const canvasCreativeInsertRequestIds\s*=\s*new Set\(\)/);
    const insertStart = source.indexOf("if(window.CanvasAgentChatClient?.isCreativeAgentInsertEvent");
    const insertEnd = source.indexOf("if(event.data?.type === 'studio-lang')", insertStart);
    const insertBlock = source.slice(insertStart, insertEnd);
    assert.equal((insertBlock.match(/pushUndo\(\)/g) || []).length, 1);
    assert.equal((insertBlock.match(/scheduleSave\(\)/g) || []).length, 1);
    assert.match(insertBlock, /canvasCreativeInsertRequestIds\.has\(requestId\)/);
    assert.match(insertBlock, /mediaKind:item\.kind === 'video' \? 'video' : 'image'/);
});

test('loaded chat receives theme, language, and interface-scale changes', () => {
    assert.match(source, /function syncCanvasChatContext\(\)[\s\S]*?type:'studio-theme'[\s\S]*?type:'studio-ui-scale'[\s\S]*?type:'studio-lang'/);
    assert.match(source, /addEventListener\('studio-lang-change',[\s\S]*?syncCanvasChatContext\(\)/);
    assert.match(source, /addEventListener\('studio-ui-scale-change',\s*syncCanvasChatContext\)/);
    assert.match(source, /addEventListener\('studio-theme-change',[\s\S]*?syncCanvasChatContext\(\)/);
});

test('narrow canvas chat overlays the board at full width without a resize handle', () => {
    assert.match(css, /@media\s*\(max-width:780px\)[\s\S]*?\.canvas-chat-panel\s*\{[\s\S]*?width:\s*100%/);
    assert.match(css, /@media\s*\(max-width:780px\)[\s\S]*?\.canvas-chat-resize\s*\{\s*display:\s*none/);
});

test('narrow header reserves a stable utility column and dark mode keeps the header opaque', () => {
    assert.match(css, /@media\s*\(max-width:780px\)[\s\S]*?\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    assert.match(css, /@media\s*\(max-width:780px\)[\s\S]*?\.toolbar\s*\{[^}]*max-width:\s*none/);
    assert.match(css, /\.shell:not\(\.no-canvas\)\s+\.topbar\s*\{[^}]*background:\s*var\(--card-solid\)\s*!important/);
});
