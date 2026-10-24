'use strict';
'require view';

return view.extend({
    handleSave: null,
    handleSaveApply: null,
    handleReset: null,
    render: function() {
        var address = 'http://' + window.location.hostname + ':3000/zh/config';
        return E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, [ 'InkSight 墨水屏' ]),
            E('div', { 'class': 'cbi-map-descr' }, [
                '配置屏幕内容、预览图片和管理设备。',
                E('a', { 'class': 'cbi-button cbi-button-action', 'href': address, 'target': '_blank', 'rel': 'noopener', 'style': 'margin-left:12px' }, [ '在新页面打开' ])
            ]),
            E('iframe', { 'src': address, 'title': 'InkSight', 'style': 'width:100%;height:calc(100vh - 240px);min-height:680px;border:1px solid #d8dee6;border-radius:8px;background:white' })
        ]);
    }
});
