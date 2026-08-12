(function(root, factory){
    const api = factory();
    if(typeof module !== 'undefined' && module.exports) module.exports = api;
    if(root) root.CanvasMaskPreviewStyle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const DEFAULT_COLOR = '#ff3b30';
    const DEFAULT_OPACITY_PERCENT = 50;
    const MIN_OPACITY_PERCENT = 10;
    const MAX_OPACITY_PERCENT = 100;
    const DEFAULT_DRAW_ALPHA = 115;

    function normalizeColor(value, fallback=DEFAULT_COLOR){
        const text = String(value || '').trim().toLowerCase();
        if(/^#[0-9a-f]{6}$/.test(text)) return text;
        if(/^#[0-9a-f]{3}$/.test(text)){
            return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
        }
        return fallback === value ? DEFAULT_COLOR : normalizeColor(fallback, DEFAULT_COLOR);
    }

    function colorRgb(value){
        const color = normalizeColor(value);
        return {
            r:parseInt(color.slice(1, 3), 16),
            g:parseInt(color.slice(3, 5), 16),
            b:parseInt(color.slice(5, 7), 16)
        };
    }

    function normalizeOpacityPercent(value){
        const number = Number(value);
        const safe = Number.isFinite(number) ? number : DEFAULT_OPACITY_PERCENT;
        return Math.max(MIN_OPACITY_PERCENT, Math.min(MAX_OPACITY_PERCENT, safe));
    }

    function opacityAlpha(value){
        return Math.round(normalizeOpacityPercent(value) * 255 / 100);
    }

    function drawRgba(color, alpha=DEFAULT_DRAW_ALPHA){
        const rgb = colorRgb(color);
        const safeAlpha = Math.max(0, Math.min(255, Number(alpha) || 0));
        return `rgba(${rgb.r},${rgb.g},${rgb.b},${safeAlpha / 255})`;
    }

    function recolorImageData(imageData, options={}){
        const data = imageData?.data;
        const color = normalizeColor(options.color);
        const rgb = colorRgb(color);
        const opacityPercent = normalizeOpacityPercent(options.opacityPercent);
        const alpha = opacityAlpha(opacityPercent);
        const threshold = Math.max(0, Number(options.threshold) || 0);
        let changed = false;
        if(!data) return {changed, color, opacityPercent, alpha};
        for(let i = 0; i < data.length; i += 4){
            const currentAlpha = data[i + 3];
            if(currentAlpha <= 0) continue;
            if(data[i] !== rgb.r || data[i + 1] !== rgb.g || data[i + 2] !== rgb.b){
                data[i] = rgb.r;
                data[i + 1] = rgb.g;
                data[i + 2] = rgb.b;
                changed = true;
            }
            if(currentAlpha > threshold && currentAlpha !== alpha){
                data[i + 3] = alpha;
                changed = true;
            }
        }
        return {changed, color, opacityPercent, alpha};
    }

    return {
        DEFAULT_COLOR,
        DEFAULT_OPACITY_PERCENT,
        MIN_OPACITY_PERCENT,
        MAX_OPACITY_PERCENT,
        DEFAULT_DRAW_ALPHA,
        normalizeColor,
        colorRgb,
        normalizeOpacityPercent,
        opacityAlpha,
        drawRgba,
        recolorImageData
    };
});
