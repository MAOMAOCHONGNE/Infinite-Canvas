const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'static', 'index.html'), 'utf8');

function cssBlock(selector){
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = html.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing CSS block ${selector}`);
    return match[1];
}

test('studio sidebar centralizes its collapsed and expanded dimensions', () => {
    assert.match(html, /--studio-sidebar-collapsed-width:\s*80px/);
    assert.match(html, /--studio-sidebar-expanded-width:\s*180px/);
    assert.match(html, /--studio-settings-popover-width:\s*156px/);
    assert.match(html, /--studio-sidebar-nav-expanded-width:\s*160px/);
    assert.match(html, /--studio-sidebar-footer-expanded-width:\s*156px/);

    assert.match(cssBlock('.sidebar'), /width:\s*var\(--studio-sidebar-collapsed-width\)/);
    assert.match(cssBlock('.sidebar'), /min-width:\s*var\(--studio-sidebar-collapsed-width\)/);
    assert.match(cssBlock('.sidebar:hover'), /width:\s*var\(--studio-sidebar-expanded-width\)/);
    assert.match(cssBlock('.sidebar.is-pinned'), /width:\s*var\(--studio-sidebar-expanded-width\)/);
    assert.match(cssBlock('.sidebar.is-collapsing:hover'), /width:\s*var\(--studio-sidebar-collapsed-width\)/);
});

test('expanded navigation and footer controls follow the compact sidebar dimensions', () => {
    assert.match(cssBlock('.sidebar:hover .nav-item'), /width:\s*var\(--studio-sidebar-nav-expanded-width\)/);
    assert.match(cssBlock('.sidebar:hover .nav-fold-toggle'), /width:\s*var\(--studio-sidebar-nav-expanded-width\)/);
    assert.match(cssBlock('.sidebar:hover .side-pill'), /width:\s*var\(--studio-sidebar-footer-expanded-width\)/);
    assert.match(cssBlock('.sidebar:hover .project-version-badge'), /width:\s*var\(--studio-sidebar-footer-expanded-width\)/);
    assert.match(cssBlock('.sidebar:hover .update-now-btn'), /width:\s*var\(--studio-sidebar-footer-expanded-width\)/);
    assert.match(html, /\.sidebar\.is-pinned \.nav-item,[\s\S]*?width:\s*var\(--studio-sidebar-nav-expanded-width\)/);
    assert.match(html, /\.sidebar\.is-pinned \.project-version-badge,[\s\S]*?width:\s*var\(--studio-sidebar-footer-expanded-width\)/);
});

test('footer icons keep one visual baseline throughout hover and collapse transitions', () => {
    const pill = cssBlock('.side-pill');
    assert.match(pill, /justify-content:\s*flex-start/);
    assert.match(pill, /padding:\s*0 0 0 12px/);
    assert.match(pill, /transition:\s*width 0\.5s var\(--fluid-ease\) 0\.5s/);
    assert.match(cssBlock('.settings-popover-anchor'), /transition:\s*width 0\.5s var\(--fluid-ease\) 0\.5s/);

    for(const selector of [
        '.sidebar:hover .side-pill',
        '.sidebar.is-pinned .side-pill',
        '.sidebar.has-settings-popover .side-pill',
        '.sidebar.is-collapsing:hover .side-pill'
    ]){
        const state = cssBlock(selector);
        assert.doesNotMatch(state, /justify-content/);
        assert.doesNotMatch(state, /padding(?:-left)?\s*:/);
    }
});

test('author branding keeps its original centered desktop position', () => {
    const author = cssBlock('.author-box');
    assert.match(author, /height:\s*60px/);
    assert.match(author, /flex:\s*0 0 60px/);
    assert.match(author, /align-items:\s*center/);
    assert.doesNotMatch(author, /padding-bottom/);
});

test('long expanded labels truncate without changing sidebar persistence behavior', () => {
    assert.match(cssBlock('.nav-text'), /text-overflow:\s*ellipsis/);
    assert.match(cssBlock('.side-pill-text'), /text-overflow:\s*ellipsis/);
    assert.match(html, /const SIDEBAR_PINNED_KEY = 'studio_sidebar_pinned'/);
    assert.match(html, /localStorage\.setItem\(SIDEBAR_PINNED_KEY, pinned \? '1' : '0'\)/);
    assert.match(html, /sidebar\.classList\.toggle\('is-pinned', pinned\)/);
});

test('primary navigation scrolls independently above a fixed utility footer', () => {
    assert.match(cssBlock('.sidebar nav'), /flex:\s*1 1 auto/);
    assert.match(cssBlock('.sidebar nav'), /min-height:\s*0/);
    assert.match(cssBlock('.sidebar nav'), /overflow-y:\s*auto/);
    assert.match(cssBlock('.sidebar-footer'), /flex:\s*0 0 auto/);
    assert.match(cssBlock('.sidebar-footer'), /border-top:\s*1px solid var\(--border\)/);

    const navEnd = html.indexOf('</nav>');
    const footerStart = html.indexOf('<div class="sidebar-footer">');
    assert.ok(navEnd >= 0 && footerStart > navEnd, 'utility footer must be separate from the scrolling nav');
    assert.match(html.slice(footerStart), /class="author-box"/);
});

test('Assets is a fixed footer action with a recognizable gallery icon', () => {
    const navStart = html.indexOf('<nav>');
    const navEnd = html.indexOf('</nav>', navStart);
    const footerStart = html.indexOf('<div class="sidebar-footer">', navEnd);
    const footerEnd = html.indexOf('<div class="settings-popover"', footerStart);
    const navMarkup = html.slice(navStart, navEnd);
    const footerMarkup = html.slice(footerStart, footerEnd);

    assert.doesNotMatch(navMarkup, /switchUI\(this, 'asset-manager'\)/);
    assert.match(footerMarkup, /class="side-pill asset-library-pill"[^>]+switchUI\(this, 'asset-manager'\)/);
    assert.match(footerMarkup, /<rect x="4" y="2" width="18" height="18" rx="2"><\/rect>/);
    assert.match(footerMarkup, /<circle cx="9" cy="7" r="2"><\/circle>/);
});

test('More Settings keeps the primary sidebar expanded and opens a floating card', () => {
    assert.match(cssBlock('.settings-popover-anchor'), /width:\s*44px/);
    const settingsState = cssBlock('.sidebar.has-settings-popover');
    assert.match(settingsState, /width:\s*var\(--studio-sidebar-expanded-width\)/);
    assert.match(settingsState, /min-width:\s*var\(--studio-sidebar-expanded-width\)/);
    assert.doesNotMatch(html, /--studio-sidebar-settings-total-width/);
    assert.doesNotMatch(html, /--studio-sidebar-settings-panel-width/);
    assert.match(cssBlock('.settings-popover-anchor .side-pill'), /flex-basis:\s*auto/);
    assert.match(html, /\.sidebar\.has-settings-popover \.nav-item,[\s\S]*?\.sidebar\.has-settings-popover \.nav-fold-toggle\s*\{[\s\S]*?width:\s*var\(--studio-sidebar-nav-expanded-width\)/);
    assert.match(cssBlock('.sidebar.has-settings-popover .nav-text'), /opacity:\s*1/);
    assert.match(cssBlock('.sidebar.has-settings-popover .nav-text'), /max-width:\s*var\(--studio-sidebar-text-expanded-width\)/);
    assert.match(cssBlock('.sidebar.has-settings-popover .author-content-wrap'), /opacity:\s*1/);
    assert.match(cssBlock('.sidebar.has-settings-popover .author-content-wrap'), /pointer-events:\s*auto/);
    assert.match(cssBlock('.sidebar.has-settings-popover .side-pill'), /width:\s*var\(--studio-sidebar-footer-expanded-width\)/);
    assert.match(html, /\.sidebar\.has-settings-popover \.project-version-compact,[\s\S]*?display:\s*none/);
    assert.match(html, /\.sidebar\.has-settings-popover \.project-version-full,[\s\S]*?display:\s*inline/);
    const panel = cssBlock('.settings-popover');
    assert.match(panel, /position:\s*fixed/);
    assert.match(panel, /left:\s*calc\(var\(--studio-sidebar-expanded-width\) \+ 8px\)/);
    assert.match(panel, /width:\s*var\(--studio-settings-popover-width\)/);
    assert.match(panel, /max-height:\s*calc\(100vh - 16px\)/);
    assert.match(panel, /box-sizing:\s*border-box/);
    assert.match(panel, /border-radius:\s*8px/);
    assert.match(panel, /overflow-y:\s*auto/);
    assert.match(panel, /background:\s*var\(--settings-popover-bg\)/);
    assert.match(panel, /box-shadow:\s*var\(--settings-popover-shadow\)/);
    assert.match(html, /id="settings-popover-toggle"[\s\S]*?aria-controls="settings-popover"/);
    assert.match(html, /id="settings-popover"[^>]+role="menu"[^>]+hidden/);
    assert.ok(html.indexOf('</aside>') < html.indexOf('id="settings-popover"'), 'floating card must not participate in sidebar layout');
    assert.match(html, /class="settings-popover-header"/);
    assert.match(html, /class="settings-popover-close"/);
    assert.match(html, /class="settings-popover-scrim"[^>]+id="settings-popover-scrim"[^>]+hidden/);
    assert.match(cssBlock('.settings-popover-scrim'), /position:\s*fixed/);
    assert.match(cssBlock('.settings-popover-scrim'), /inset:\s*0/);
    assert.match(cssBlock('.settings-popover-scrim'), /background:\s*transparent/);
    assert.match(html, /if\(scrim\) scrim\.hidden = !open/);
    assert.match(html, /function setSidebarSettingsOpen\(open, options = \{\}\)/);
    assert.match(html, /sidebar\.classList\.remove\('is-collapsing'\)/);
    assert.match(html, /event\.key !== 'Escape'/);
    assert.doesNotMatch(html, /settings-fold-group/);
});

test('floating settings card aligns its final action with the trigger and stays in the viewport', () => {
    assert.match(html, /function positionSidebarSettingsPanel\(\)/);
    assert.match(html, /const lastAction = document\.getElementById\('github-entry-btn'\)/);
    assert.match(html, /const lastActionCenterOffset = lastActionRect\.top \+ lastActionRect\.height \/ 2 - panelRect\.top/);
    assert.match(html, /const desiredTop = toggleRect\.top \+ toggleRect\.height \/ 2 - lastActionCenterOffset/);
    assert.match(html, /window\.innerHeight - panelRect\.height - viewportPadding/);
    assert.match(html, /sidebarRect\.right \+ gap/);
    assert.match(html, /window\.addEventListener\('resize',[\s\S]*?positionSidebarSettingsPanel/);
    assert.match(html, /window\.addEventListener\('studio-ui-scale-change',[\s\S]*?positionSidebarSettingsPanel/);
});

test('secondary sidebar actions close after applying their setting', () => {
    assert.match(html, /onclick="toggleTheme\(\); closeSidebarSettings\(\);"/);
    assert.match(html, /onclick="toggleLanguage\(\); closeSidebarSettings\(\);"/);
    assert.match(html, /switchUI\(this, 'comfyui-settings'\); closeSidebarSettings\(\);/);
    assert.match(html, /openProjectPage\(\); closeSidebarSettings\(\);/);
    assert.match(html, /panel\.querySelector\('\.settings-popover-action'\)/);
});

test('opening More Settings preserves the current page highlight and uses a subtle trigger state', () => {
    assert.match(cssBlock('.side-pill.active'), /background:\s*var\(--text\)/);
    assert.doesNotMatch(html, /\.sidebar\.has-settings-popover \.side-pill\.active:not\(\.settings-popover-toggle\)/);
    assert.match(html, /\.sidebar\.has-settings-popover \.settings-popover-toggle\s*\{[\s\S]*?background:\s*var\(--settings-popover-open-bg\)/);
    assert.match(html, /\.sidebar\.has-settings-popover \.settings-popover-toggle\s*\{[\s\S]*?color:\s*var\(--text\)/);
    const actionActive = cssBlock('.settings-popover-action.active');
    assert.match(actionActive, /background:\s*var\(--nav-hover-bg\)/);
    assert.match(actionActive, /box-shadow:\s*inset 2px 0 0 var\(--text\)/);
    assert.doesNotMatch(actionActive, /background:\s*var\(--text\)/);
});
