(function () {
    'use strict';

    // Cosenseエクスポートの解析と、画像一覧の検索・ページ分割を担当する。

    /**
     * @typedef {Object} CosenseExport
     * @property {string} name URLに使われるプロジェクト名
     * @property {string} [displayName] 画面表示用のプロジェクト名
     * @property {Array<{title: string, lines: Array<string|{text: string}>}>} pages
     */

    /**
     * @typedef {Object} GyazoImage
     * @property {string} id 32桁のGyazo画像ID
     * @property {string} url 確認用のGyazoページURL
     * @property {Array<{pageTitle: string, lineText: string, lineNumber: number, pageUrl: string}>} sources
     */

    /**
     * @typedef {'all'|'untested'|'available'|'unavailable'|'timeout'} DisplayTestFilter
     */

    /**
     * @typedef {Object} DisplayTestResult
     * @property {'available'|'unavailable'|'timeout'} result
     * @property {string} testedAt
     * @property {'png'|'jpg'|'gif'|'mp4'} [format]
     */

    /**
     * @typedef {Object} PaginatedImages
     * @property {GyazoImage[]} items
     * @property {number} page
     * @property {number} pageSize
     * @property {number} totalPages
     * @property {number} start
     */

    const GYAZO_PATTERN = /https?:\/\/(?:i\.)?gyazo\.com\/([a-f0-9]{32})(?![a-f0-9])(?:\.[a-z0-9]+)?(?:[?#][^\s\]\[<>"']*)?/gi;

    /**
     * Cosenseエクスポートとして処理できる最小限の構造か検証する。
     * @param {unknown} data JSONから復元した値
     * @throws {Error} 必須項目が不足している場合
     */
    function validateExport(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSONの最上位がオブジェクトではありません。Cosenseのプロジェクトエクスポートを選択してください。');
        if (typeof data.name !== 'string' || data.name.trim() === '') throw new Error('プロジェクト名（name）が見つかりません。Cosenseの通常のエクスポート形式か確認してください。');
        if (!Array.isArray(data.pages)) throw new Error('pages配列が見つかりません。Cosenseの通常のエクスポート形式か確認してください。');
        if (
            data.pages.some(page => !page || typeof page.title !== 'string' || !Array.isArray(page.lines))
        ) throw new Error('titleまたはlinesを持たないページがあります。エクスポート形式を確認してください。');
        const invalidLine = data.pages.some(page => page.lines.some(line => typeof line !== 'string' && (!line || typeof line.text !== 'string')));
        if (invalidLine) throw new Error('文字列またはtextを持つオブジェクトではない行があります。エクスポート形式を確認してください。');
    }

    /**
     * プロジェクト名とページ名からCosenseの掲載元URLを生成する。
     * @param {string} projectName
     * @param {string} pageTitle
     * @returns {string}
     */
    function getCosensePageUrl(projectName, pageTitle) {
        return `https://scrapbox.io/${encodeURIComponent(projectName)}/${encodeURIComponent(pageTitle)}`;
    }

    /**
     * 全ページの行からGyazo画像IDを抽出し、画像ID単位で掲載元を集約する。
     * 同じ行に同一IDが複数回あっても、掲載元は1件として扱う。
     * @param {CosenseExport} data
     * @returns {GyazoImage[]}
     */
    function extractImages(data) {
        const imageMap = new Map();
        data.pages.forEach(page => page.lines.forEach((line, lineIndex) => {
            const lineText = typeof line === 'string' ? line : line.text;
            GYAZO_PATTERN.lastIndex = 0;
            let match;
            const idsOnLine = new Set();
            while ((match = GYAZO_PATTERN.exec(lineText)) !== null) {
                const id = match[1].toLowerCase();
                if (idsOnLine.has(id)) continue;
                idsOnLine.add(id);
                if (!imageMap.has(id)) imageMap.set(id, { id, url: `https://gyazo.com/${id}`, sources: [] });
                imageMap.get(id).sources.push({
                    pageTitle: page.title,
                    lineText,
                    lineNumber: lineIndex + 1,
                    pageUrl: getCosensePageUrl(data.name, page.title)
                });
            }
        }));
        return Array.from(imageMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * 検索語と表示テスト結果の条件に一致する画像を返す。
     * @param {GyazoImage[]} imageItems
     * @param {Record<string, DisplayTestResult>} testResults
     * @param {string} query
     * @param {DisplayTestFilter} testResultFilter
     * @returns {GyazoImage[]}
     */
    function filterImages(imageItems, testResults, query, testResultFilter) {
        const normalizedQuery = query.trim().toLocaleLowerCase('ja');
        return imageItems.filter(image => {
            const imageResult = testResults[image.id]?.result || 'untested';
            if (testResultFilter !== 'all' && imageResult !== testResultFilter) return false;
            if (!normalizedQuery) return true;
            return [image.id, ...image.sources.flatMap(source => [source.pageTitle, source.lineText])]
                .join('\n')
                .toLocaleLowerCase('ja')
                .includes(normalizedQuery);
        });
    }

    /**
     * 指定されたページ番号と表示件数に従って画像を分割する。
     * @param {GyazoImage[]} imageItems
     * @param {number|null} requestedPageSize nullの場合は全件表示
     * @param {number} requestedPage
     * @returns {PaginatedImages}
     */
    function paginateImages(imageItems, requestedPageSize, requestedPage) {
        const pageSize = requestedPageSize === null ? Math.max(imageItems.length, 1) : Math.max(requestedPageSize, 1);
        const totalPages = Math.max(Math.ceil(imageItems.length / pageSize), 1);
        const page = Math.min(Math.max(requestedPage, 1), totalPages);
        const start = (page - 1) * pageSize;
        return { items: imageItems.slice(start, start + pageSize), page, pageSize, totalPages, start };
    }

    window.CosenseGyazoReviewCore = Object.freeze({
        validateExport,
        getCosensePageUrl,
        extractImages,
        filterImages,
        paginateImages
    });
}());
