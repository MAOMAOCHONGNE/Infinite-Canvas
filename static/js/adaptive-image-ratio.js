(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.AdaptiveImageRatio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const SUPPORTED_RATIOS = Object.freeze([
        '1:1', '2:3', '3:2', '3:4', '4:3',
        '4:5', '5:4', '9:16', '16:9', '21:9'
    ]);
    const RES_LONG_SIDE = Object.freeze({ '1k':1536, '2k':2048, '4k':3840 });
    const RES_PIXEL_LIMIT = Object.freeze({ '1k':1572864, '2k':4194304, '4k':8294400 });

    function gcd(a, b){
        a = Math.abs(Math.round(Number(a) || 0));
        b = Math.abs(Math.round(Number(b) || 0));
        while(b){ const next = b; b = a % b; a = next; }
        return a || 1;
    }

    function ratioParts(value){
        const parts = String(value || '').trim().split(':');
        if(parts.length !== 2) return null;
        const width = Number(parts[0]);
        const height = Number(parts[1]);
        if(!(width > 0 && height > 0)) return null;
        const divisor = gcd(width, height);
        return {width:width / divisor, height:height / divisor};
    }

    function closestSupportedRatio(width, height, candidates=SUPPORTED_RATIOS){
        width = Number(width);
        height = Number(height);
        if(!(width > 0 && height > 0)) return '';
        let best = '';
        let bestScore = Infinity;
        const epsilon = 1e-9;
        for(const candidate of candidates){
            const parts = ratioParts(candidate);
            if(!parts) continue;
            // Compare the horizontal stretch needed while holding the source height.
            // Candidate order intentionally breaks exact ties (3:4 precedes 4:5).
            const score = Math.abs(width - height * parts.width / parts.height);
            if(score < bestScore - epsilon){
                best = candidate;
                bestScore = score;
            }
        }
        return best;
    }

    function closestSupportedRatioValue(value, candidates=SUPPORTED_RATIOS){
        const parts = ratioParts(value);
        return parts ? closestSupportedRatio(parts.width, parts.height, candidates) : '';
    }

    function stretchedDimensions(width, height, targetRatio){
        width = Math.max(1, Math.round(Number(width) || 0));
        height = Math.max(1, Math.round(Number(height) || 0));
        const parts = ratioParts(targetRatio);
        if(!parts) return {width, height};
        const scale = Math.max(1, Math.round(height / parts.height));
        return {width:parts.width * scale, height:parts.height * scale};
    }

    function pixelSizeForRatio(targetRatio, resolution='1k'){
        const parts = ratioParts(targetRatio);
        if(!parts) return '';
        const key = Object.prototype.hasOwnProperty.call(RES_LONG_SIDE, resolution) ? resolution : '1k';
        const longSide = RES_LONG_SIDE[key];
        const pixelLimit = RES_PIXEL_LIMIT[key];
        const scale = Math.min(
            longSide / Math.max(parts.width, parts.height),
            Math.sqrt(pixelLimit / (parts.width * parts.height))
        );
        const snappedScale = Math.max(16, Math.floor(scale / 16) * 16);
        return `${parts.width * snappedScale}x${parts.height * snappedScale}`;
    }

    return {
        SUPPORTED_RATIOS,
        ratioParts,
        closestSupportedRatio,
        closestSupportedRatioValue,
        stretchedDimensions,
        pixelSizeForRatio
    };
});
