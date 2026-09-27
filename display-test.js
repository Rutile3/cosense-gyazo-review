(function () {
    'use strict';

    // i.gyazo.comのメディア読込イベントによる表示判定を担当する。HTTPステータスは取得しない。

    if (!window.CosenseGyazoReviewCore) throw new Error('core.jsをdisplay-test.jsより先に読み込んでください。');
    const { DISPLAY_FORMATS } = window.CosenseGyazoReviewCore;

    /**
     * @typedef {'png'|'jpg'|'gif'|'mp4'} DisplayTestFormat
     */

    /**
     * @typedef {Object} MediaTestOutcome
     * @property {'available'|'unavailable'|'timeout'|'cancelled'} result
     * @property {DisplayTestFormat} [format]
     * @property {string} [previewUrl]
     */

    const TEST_TIMEOUT_MS = 12000;
    let requestSequence = 0;

    /**
     * 表示テスト用のi.gyazo.com URLを生成する。
     * 再テスト時はキャッシュ回避用クエリを付けるが、画像ID自体は変更しない。
     * @param {string} id
     * @param {DisplayTestFormat} format
     * @param {number|null} cacheBustToken nullの場合は検査用クエリを付けない
     * @returns {string}
     */
    function getDisplayImageUrl(id, format, cacheBustToken) {
        const base = `https://i.gyazo.com/${id}.${format}`;
        return cacheBustToken === null ? base : `${base}?cosense_gyazo_review=${Date.now()}-${cacheBustToken}`;
    }

    /**
     * PNG・JPG・GIF・MP4を並行して読み込み、ブラウザのイベントだけで表示可否を判定する。
     * 状態の保存や画面更新は行わず、判定結果とキャンセル関数を返す。
     * @param {string} imageId
     * @returns {{requestId: number, promise: Promise<MediaTestOutcome>, cancel: Function}}
     */
    function createMediaTest(imageId) {
        const requestId = ++requestSequence;
        const loaders = [];
        const testUrls = Object.fromEntries(DISPLAY_FORMATS.map(format => [format, getDisplayImageUrl(imageId, format, requestId)]));
        let cancel = () => {};
        const promise = new Promise(resolve => {
            let errorCount = 0;
            let settled = false;
            let timer;
            const finish = (result, format) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                loaders.forEach(({ element, isVideo }) => {
                    element.onload = null;
                    element.onerror = null;
                    element.onloadedmetadata = null;
                    if (result === 'available' || result === 'cancelled' || result === 'timeout') {
                        if (isVideo) {
                            element.removeAttribute('src');
                            element.load();
                        } else {
                            element.src = '';
                        }
                    }
                });
                /** @type {MediaTestOutcome} */
                const outcome = { result };
                if (format) {
                    outcome.format = format;
                    outcome.previewUrl = testUrls[format];
                }
                resolve(outcome);
            };
            cancel = () => finish('cancelled');
            DISPLAY_FORMATS.forEach(format => {
                const isVideo = format === 'mp4';
                const loader = isVideo ? document.createElement('video') : new Image();
                loaders.push({ element: loader, isVideo });
                if (isVideo) {
                    loader.preload = 'metadata';
                    loader.muted = true;
                    loader.playsInline = true;
                    loader.onloadedmetadata = () => finish('available', format);
                } else {
                    loader.onload = () => finish('available', format);
                }
                loader.onerror = () => {
                    errorCount += 1;
                    if (errorCount === DISPLAY_FORMATS.length) finish('unavailable');
                };
                loader.src = testUrls[format];
            });
            timer = setTimeout(() => finish('timeout'), TEST_TIMEOUT_MS);
        });
        return { requestId, promise, cancel: () => cancel() };
    }

    window.CosenseGyazoReviewDisplayTest = Object.freeze({
        getDisplayImageUrl,
        createMediaTest
    });
}());
