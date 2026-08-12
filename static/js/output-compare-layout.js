(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.OutputCompareLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    function containInsets(containerWidth, containerHeight, imageWidth, imageHeight){
        const cw = Number(containerWidth);
        const ch = Number(containerHeight);
        const iw = Number(imageWidth);
        const ih = Number(imageHeight);
        if(!(cw > 0 && ch > 0 && iw > 0 && ih > 0)) return null;
        const scale = Math.min(cw / iw, ch / ih);
        const renderedWidth = iw * scale;
        const renderedHeight = ih * scale;
        const left = Math.max(0, (cw - renderedWidth) / 2);
        const top = Math.max(0, (ch - renderedHeight) / 2);
        return {
            top,
            right:left,
            bottom:top,
            left,
            renderedWidth,
            renderedHeight
        };
    }

    function paddingValue(insets){
        if(!insets) return '';
        const px = value => `${Math.round(Number(value || 0) * 1000) / 1000}px`;
        return `${px(insets.top)} ${px(insets.right)} ${px(insets.bottom)} ${px(insets.left)}`;
    }

    return {containInsets, paddingValue};
});
