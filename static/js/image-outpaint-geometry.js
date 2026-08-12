(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.ImageOutpaintGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const DEFAULT_BACKGROUND = '#808080';
    const SUPPORTED_RATIOS = Object.freeze([
        '1:1', '2:3', '3:2', '3:4', '4:3', '4:5',
        '5:4', '9:16', '16:9', '21:9', '9:21'
    ]);

    function positive(value, fallback=1){
        value = Number(value);
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    function gcd(a, b){
        a = Math.abs(Math.round(Number(a) || 0));
        b = Math.abs(Math.round(Number(b) || 0));
        while(b){ const next = b; b = a % b; a = next; }
        return a || 1;
    }

    function ratioParts(preset){
        if(!preset || preset === 'free' || preset === 'source') return null;
        const values = String(preset).split(':').map(Number);
        if(values.length !== 2 || !(values[0] > 0 && values[1] > 0)) return null;
        const divisor = gcd(values[0], values[1]);
        return {width:values[0] / divisor, height:values[1] / divisor};
    }

    function ratioValue(preset){
        const parts = ratioParts(preset);
        return parts ? parts.width / parts.height : null;
    }

    function minimumCanvasForSource(sourceW, sourceH, preset='free'){
        sourceW = positive(sourceW);
        sourceH = positive(sourceH);
        const ratio = ratioValue(preset);
        if(!ratio) return {x:0, y:0, w:sourceW, h:sourceH};

        let w = sourceW;
        let h = sourceH;
        if(w / h > ratio) h = w / ratio;
        else w = h * ratio;
        return {x:(w - sourceW) / 2, y:(h - sourceH) / 2, w, h};
    }

    function clampSourcePosition(value, canvasSize, sourceSize){
        return Math.min(Math.max(0, value), Math.max(0, canvasSize - sourceSize));
    }

    function resizeCanvasAroundSource(start, sourceW, sourceH, handle, dx=0, dy=0, preset='free'){
        sourceW = positive(sourceW);
        sourceH = positive(sourceH);
        start = {
            x:Number(start?.x) || 0,
            y:Number(start?.y) || 0,
            w:positive(start?.w, sourceW),
            h:positive(start?.h, sourceH)
        };
        handle = String(handle || 'corner');
        dx = Number(dx) || 0;
        dy = Number(dy) || 0;
        let growX = handle === 'left' ? -dx : handle === 'right' || handle === 'corner' ? dx : 0;
        let growY = handle === 'top' ? -dy : handle === 'bottom' || handle === 'corner' ? dy : 0;
        const minimum = minimumCanvasForSource(sourceW, sourceH, preset);
        const ratio = ratioValue(preset);
        let w;
        let h;

        if(!ratio){
            w = Math.max(sourceW, start.w + growX * 2);
            h = Math.max(sourceH, start.h + growY * 2);
        } else if(handle === 'left' || handle === 'right'){
            w = Math.max(minimum.w, start.w + growX * 2);
            h = w / ratio;
        } else if(handle === 'top' || handle === 'bottom'){
            h = Math.max(minimum.h, start.h + growY * 2);
            w = h * ratio;
        } else {
            const scaleX = (start.w + growX * 2) / start.w;
            const scaleY = (start.h + growY * 2) / start.h;
            const scale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
            w = Math.max(minimum.w, start.w * scale);
            h = w / ratio;
        }

        if(ratio && (w < minimum.w || h < minimum.h)){
            const scale = Math.max(minimum.w / w, minimum.h / h);
            w *= scale;
            h *= scale;
        }
        const x = clampSourcePosition(start.x + (w - start.w) / 2, w, sourceW);
        const y = clampSourcePosition(start.y + (h - start.h) / 2, h, sourceH);
        return {x, y, w, h};
    }

    function outputGeometry(options={}){
        const sourceDisplayW = positive(options.sourceDisplayW);
        const sourceDisplayH = positive(options.sourceDisplayH);
        const naturalW = Math.max(1, Math.round(positive(options.naturalW)));
        const naturalH = Math.max(1, Math.round(positive(options.naturalH)));
        const canvasW = Math.max(sourceDisplayW, positive(options.canvasW, sourceDisplayW));
        const canvasH = Math.max(sourceDisplayH, positive(options.canvasH, sourceDisplayH));
        const scaleX = naturalW / sourceDisplayW;
        const scaleY = naturalH / sourceDisplayH;
        const rawW = Math.max(naturalW, canvasW * scaleX);
        const rawH = Math.max(naturalH, canvasH * scaleY);
        const parts = ratioParts(options.preset);
        let w;
        let h;

        if(parts){
            const units = Math.max(1, Math.ceil(Math.max(rawW / parts.width, rawH / parts.height)));
            w = parts.width * units;
            h = parts.height * units;
        } else {
            w = Math.max(naturalW, Math.round(rawW));
            h = Math.max(naturalH, Math.round(rawH));
        }

        const dx = Math.round((Number(options.sourceX) || 0) * scaleX + (w - rawW) / 2);
        const dy = Math.round((Number(options.sourceY) || 0) * scaleY + (h - rawH) / 2);
        return {
            w,
            h,
            dx:clampSourcePosition(dx, w, naturalW),
            dy:clampSourcePosition(dy, h, naturalH)
        };
    }

    function normalizeColor(value, fallback=DEFAULT_BACKGROUND){
        const text = String(value || '').trim().toLowerCase();
        if(/^#[0-9a-f]{6}$/.test(text)) return text;
        if(/^#[0-9a-f]{3}$/.test(text)) return `#${text.slice(1).split('').map(ch => ch + ch).join('')}`;
        return /^#[0-9a-f]{6}$/.test(String(fallback || '').trim().toLowerCase())
            ? String(fallback).trim().toLowerCase()
            : DEFAULT_BACKGROUND;
    }

    return {
        DEFAULT_BACKGROUND,
        SUPPORTED_RATIOS,
        ratioParts,
        ratioValue,
        minimumCanvasForSource,
        resizeCanvasAroundSource,
        outputGeometry,
        normalizeColor
    };
});
