(function () {
    'use strict';

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
     * @typedef {'untested'|'available'|'unavailable'|'timeout'} DisplayTestResultName
     */

    /**
     * @typedef {'all'|DisplayTestResultName} DisplayTestFilter
     */

    /**
     * @typedef {Object} DisplayTestResultDefinition
     * @property {string} label
     * @property {boolean} stored
     * @property {boolean} includeInSummary
     */

    /**
     * @typedef {Object} PaginatedImages
     * @property {GyazoImage[]} items
     * @property {number} page
     * @property {number} pageSize
     * @property {number} totalPages
     * @property {number} start
     */

    /**
     * @typedef {'png'|'jpg'|'gif'|'mp4'} DisplayTestFormat
     */

    /**
     * @typedef {Object} DisplayTestResult
     * @property {'available'|'unavailable'|'timeout'} result
     * @property {string} testedAt ISO 8601形式の検査日時
     * @property {DisplayTestFormat} [format] 表示できた形式
     */

    /**
     * @typedef {Object} MediaTestOutcome
     * @property {'available'|'unavailable'|'timeout'|'cancelled'} result
     * @property {DisplayTestFormat} [format]
     * @property {string} [previewUrl]
     */

    /**
     * @typedef {Object} BatchRun
     * @property {number} id
     * @property {GyazoImage[]} targets
     * @property {number} total
     * @property {number} nextIndex
     * @property {number} completed
     * @property {boolean} stopped
     * @property {{available: number, unavailable: number, timeout: number}} counts
     */

    /**
     * @typedef {Object} AppState
     * @property {string|null} currentProject
     * @property {GyazoImage[]} images
     * @property {Record<string, DisplayTestResult>} displayTestResults
     * @property {Record<string, string>} displayPreviewUrls
     * @property {number} currentPage
     * @property {number} sessionVersion
     * @property {number} requestSequence
     * @property {number} batchSequence
     * @property {BatchRun|null} batchRun
     * @property {Map<string, {requestId: number, runId: number|null, cancel: Function}>} activeTestRequests
     * @property {Set<string>} testingImageIds
     */

    // 表示テストはHTTPステータスではなく、ブラウザのメディア読込イベントで判定する。
    /** @type {Readonly<Record<DisplayTestResultName, Readonly<DisplayTestResultDefinition>>>} */
    const DISPLAY_TEST_RESULT_CONFIG = Object.freeze({
        untested: Object.freeze({ label: '未判定', stored: false, includeInSummary: true }),
        available: Object.freeze({ label: '表示できた', stored: true, includeInSummary: true }),
        unavailable: Object.freeze({ label: '表示できない', stored: true, includeInSummary: true }),
        timeout: Object.freeze({ label: '時間切れ', stored: true, includeInSummary: true })
    });
    const DISPLAY_TEST_SUMMARY_KEYS = Object.freeze(
        Object.keys(DISPLAY_TEST_RESULT_CONFIG).filter(key => DISPLAY_TEST_RESULT_CONFIG[key].includeInSummary)
    );
    const DISPLAY_TEST_OUTCOME_KEYS = Object.freeze(
        Object.keys(DISPLAY_TEST_RESULT_CONFIG).filter(key => DISPLAY_TEST_RESULT_CONFIG[key].stored)
    );
    /** @type {ReadonlyArray<DisplayTestFormat>} */
    const DISPLAY_FORMATS = Object.freeze(['png', 'jpg', 'gif', 'mp4']);
    const TEST_STORAGE_PREFIX = 'cosense-gyazo-review:display-tests:v1:';
    const TEST_TIMEOUT_MS = 12000;
    const TEST_CONCURRENCY = 3;
    const CSV_HEADER = Object.freeze(['画像ID', '確認用URL', '表示テスト結果', '検査日時', '掲載元ページ']);
    const GYAZO_PATTERN = /https?:\/\/(?:i\.)?gyazo\.com\/([a-f0-9]{32})(?![a-f0-9])(?:\.[a-z0-9]+)?(?:[?#][^\s\]\[<>"']*)?/gi;

    /**
     * 必須のDOM要素をIDで取得し、HTMLとの不整合を初期化時に検出する。
     * @param {string} id
     * @returns {HTMLElement}
     */
    function getRequiredElement(id) {
        const element = document.getElementById(id);
        if (!element) throw new Error(`必要な画面要素（#${id}）が見つかりません。index.htmlとapp.jsのIDを確認してください。`);
        return element;
    }

    // DOM参照を一か所に集約し、描画処理で同じ要素を再検索しない。
    const elements = {
        fileInput: getRequiredElement('file-input'),
        dropZone: getRequiredElement('drop-zone'),
        inputExpanded: getRequiredElement('input-expanded'),
        inputCompact: getRequiredElement('input-compact'),
        inputSummary: getRequiredElement('input-summary'),
        chooseAnotherFile: getRequiredElement('choose-another-file'),
        message: getRequiredElement('message'),
        workspace: getRequiredElement('workspace'),
        projectHeading: getRequiredElement('project-heading'),
        imageList: getRequiredElement('image-list'),
        emptyFilter: getRequiredElement('empty-filter'),
        search: getRequiredElement('search'),
        testResultFilter: getRequiredElement('test-result-filter'),
        pageSize: getRequiredElement('page-size'),
        paginationControls: [
            {
                container: getRequiredElement('top-pagination'),
                first: getRequiredElement('top-first-page'),
                previous: getRequiredElement('top-previous-page'),
                next: getRequiredElement('top-next-page'),
                last: getRequiredElement('top-last-page'),
                info: getRequiredElement('top-page-info')
            },
            {
                container: getRequiredElement('bottom-pagination'),
                first: getRequiredElement('first-page'),
                previous: getRequiredElement('previous-page'),
                next: getRequiredElement('next-page'),
                last: getRequiredElement('last-page'),
                info: getRequiredElement('page-info')
            }
        ],
        exportCsv: getRequiredElement('export-csv'),
        visibleCount: getRequiredElement('visible-count'),
        testScope: getRequiredElement('test-scope'),
        startDisplayTest: getRequiredElement('start-display-test'),
        stopDisplayTest: getRequiredElement('stop-display-test'),
        testProgress: getRequiredElement('test-progress'),
        testProgressBar: getRequiredElement('test-progress-bar'),
        testProgressText: getRequiredElement('test-progress-text'),
        testCounts: Object.fromEntries(
            DISPLAY_TEST_SUMMARY_KEYS.map(key => [key, getRequiredElement(`test-count-${key}`)])
        ),
        testFilterButtons: Array.from(document.querySelectorAll('[data-test-filter]'))
    };
    /** @type {AppState} */
    const state = {
        currentProject: null,
        images: [],
        displayTestResults: {},
        // プレビューURLは現在のセッションだけで使い、localStorageには保存しない。
        displayPreviewUrls: {},
        currentPage: 1,
        // JSON切り替え時に加算し、古い非同期リクエストの結果を破棄する。
        sessionVersion: 0,
        requestSequence: 0,
        batchSequence: 0,
        batchRun: null,
        activeTestRequests: new Map(),
        testingImageIds: new Set()
    };

    /**
     * 現在のページ番号を正の整数へ正規化して更新する。
     * @param {number} page
     */
    function setCurrentPage(page) {
        const normalizedPage = Number.isFinite(page) ? Math.trunc(page) : 1;
        state.currentPage = Math.max(normalizedPage, 1);
    }

    /**
     * 表示テスト結果と、現在のセッションだけで使うプレビューURLを同時に更新する。
     * @param {string} imageId
     * @param {DisplayTestResult} result
     * @param {string|undefined} previewUrl
     */
    function setDisplayTestResult(imageId, result, previewUrl) {
        state.displayTestResults[imageId] = result;
        if (result.result === 'available' && previewUrl) {
            state.displayPreviewUrls[imageId] = previewUrl;
        } else {
            delete state.displayPreviewUrls[imageId];
        }
    }

    /**
     * 読み込んだプロジェクトに合わせて、一覧と表示テスト状態を初期化する。
     * @param {string} projectName
     * @param {GyazoImage[]} images
     */
    function initializeProjectState(projectName, images) {
        state.currentProject = projectName;
        state.images = images;
        state.displayTestResults = loadDisplayTestResults(
            projectName,
            new Set(images.map(image => image.id))
        );
        state.displayPreviewUrls = {};
        setCurrentPage(1);
    }

    function showMessage(text, type) {
        elements.message.textContent = text;
        elements.message.className = `alert alert-${type} mt-3 mb-0`;
    }
    function clearMessage() {
        elements.message.textContent = '';
        elements.message.className = 'alert mt-3 mb-0 d-none';
    }
    function setInputCompact(compact) {
        elements.inputExpanded.classList.toggle('d-none', compact);
        elements.inputCompact.classList.toggle('d-none', !compact);
    }

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
     * @param {string} projectName
     * @returns {string}
     */
    function getTestStorageKey(projectName) {
        return `${TEST_STORAGE_PREFIX}${encodeURIComponent(projectName)}`;
    }

    /**
     * 表示テスト結果名に対応する定義を返す。
     * @param {unknown} result
     * @returns {DisplayTestResultDefinition|null}
     */
    function getDisplayTestResultDefinition(result) {
        if (typeof result !== 'string') return null;
        if (!Object.prototype.hasOwnProperty.call(DISPLAY_TEST_RESULT_CONFIG, result)) return null;
        return DISPLAY_TEST_RESULT_CONFIG[/** @type {DisplayTestResultName} */ (result)];
    }

    /**
     * @param {unknown} result
     * @returns {boolean}
     */
    function isStoredDisplayTestResult(result) {
        return getDisplayTestResultDefinition(result)?.stored === true;
    }

    /**
     * @param {readonly string[]} keys
     * @returns {Record<string, number>}
     */
    function createResultCounts(keys) {
        return Object.fromEntries(keys.map(key => [key, 0]));
    }

    /**
     * @param {Record<string, number>} counts
     * @returns {string}
     */
    function formatBatchResultCounts(counts) {
        return DISPLAY_TEST_OUTCOME_KEYS
            .map(key => `${DISPLAY_TEST_RESULT_CONFIG[key].label} ${counts[key]}`)
            .join('、');
    }

    /**
     * localStorageから読み込んだ値が表示テスト結果として有効か検証する。
     * @param {unknown} value
     * @returns {value is DisplayTestResult}
     */
    function isValidDisplayTestResult(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const candidate = /** @type {Partial<DisplayTestResult>} */ (value);
        const hasValidFormat = candidate.format === undefined || DISPLAY_FORMATS.includes(candidate.format);
        return isStoredDisplayTestResult(candidate.result) && typeof candidate.testedAt === 'string' && hasValidFormat;
    }

    /**
     * 現在のJSONに含まれる画像だけを対象に、保存済みの表示テスト結果を復元する。
     * @param {string} projectName
     * @param {Set<string>} validImageIds
     * @returns {Record<string, DisplayTestResult>}
     */
    function loadDisplayTestResults(projectName, validImageIds) {
        try {
            const stored = JSON.parse(localStorage.getItem(getTestStorageKey(projectName)) || '{}');
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
            return Object.fromEntries(
                Object.entries(stored).filter(([id, value]) => validImageIds.has(id) && isValidDisplayTestResult(value))
            );
        } catch (error) {
            showMessage('保存済みの表示テスト結果を読み込めませんでした。表示結果は未判定として扱います。', 'warning');
            return {};
        }
    }

    /**
     * 表示テスト結果だけを保存し、ページ名や行本文、画像データは保存しない。
     * @returns {void}
     */
    function saveDisplayTestResults() {
        const minimal = {};
        state.images.forEach(image => {
            const value = state.displayTestResults[image.id];
            if (value && isStoredDisplayTestResult(value.result)) {
                minimal[image.id] = { result: value.result, testedAt: value.testedAt };
                if (value.format) minimal[image.id].format = value.format;
            }
        });
        try {
            localStorage.setItem(getTestStorageKey(state.currentProject), JSON.stringify(minimal));
        } catch (error) {
            showMessage('表示テスト結果をブラウザに保存できませんでした。ブラウザの保存設定を確認してください。', 'warning');
        }
    }

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
    function formatTestedAt(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP');
    }

    /**
     * 掲載元ページと該当行を、安全なDOM操作だけで組み立てる。
     * @param {{pageTitle: string, lineText: string, lineNumber: number, pageUrl: string}} source
     * @returns {HTMLLIElement}
     */
    function createSourceElement(source) {
        const item = document.createElement('li');
        item.className = 'source-item';
        const link = document.createElement('a');
        link.href = source.pageUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.pageTitle || '（無題のページ）';
        const line = document.createElement('span');
        line.className = 'source-line small';
        line.textContent = `${source.lineNumber}行目: ${source.lineText}`;
        item.append(link, line);
        return item;
    }

    /**
     * 判定名と検査日時を表示する要素を生成する。
     * @param {DisplayTestResult|undefined} result
     * @param {boolean} isTesting
     * @returns {HTMLDivElement}
     */
    function createDisplayTestResultElement(result, isTesting) {
        const resultBox = document.createElement('div');
        resultBox.className = 'display-test-result small';
        resultBox.dataset.result = isTesting ? 'testing' : (result ? result.result : 'untested');
        const resultLabel = document.createElement('strong');
        const formatLabel = result && result.result === 'available' && result.format ? `（${result.format.toUpperCase()}）` : '';
        const resultDefinition = getDisplayTestResultDefinition(result?.result) || DISPLAY_TEST_RESULT_CONFIG.untested;
        resultLabel.textContent = isTesting ? '判定中…' : `${resultDefinition.label}${formatLabel}`;
        resultBox.append(resultLabel);
        if (result) {
            const testedAt = document.createElement('time');
            testedAt.dateTime = result.testedAt;
            testedAt.textContent = `検査時点: ${formatTestedAt(result.testedAt)}`;
            resultBox.append(testedAt);
        }
        return resultBox;
    }

    /**
     * 表示できた画像または動画のプレビューを生成する。
     * @param {GyazoImage} image
     * @param {DisplayTestResult|undefined} result
     * @returns {HTMLImageElement|HTMLVideoElement|null}
     */
    function createDisplayTestPreview(image, result) {
        if (!result || result.result !== 'available') return null;
        const preview = document.createElement(result.format === 'mp4' ? 'video' : 'img');
        preview.className = 'image-preview';
        preview.src = state.displayPreviewUrls[image.id] || getDisplayImageUrl(image.id, result.format || 'png', null);
        if (result.format === 'mp4') {
            preview.controls = true;
            preview.muted = true;
            preview.preload = 'metadata';
            preview.setAttribute('aria-label', `${image.id} の表示テスト時点の動画プレビュー`);
        } else {
            preview.alt = `${image.id} の表示テスト時点のプレビュー`;
            preview.loading = 'lazy';
            preview.decoding = 'async';
        }
        preview.addEventListener('error', () => preview.remove());
        return preview;
    }

    /**
     * 画像1件の表示テストまたは再テストを開始するボタンを生成する。
     * @param {GyazoImage} image
     * @param {DisplayTestResult|undefined} result
     * @param {boolean} isTesting
     * @returns {HTMLButtonElement}
     */
    function createDisplayTestButton(image, result, isTesting) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-secondary mt-2';
        button.disabled = isTesting || Boolean(state.batchRun);
        button.textContent = isTesting ? 'テスト中…' : (state.batchRun ? '一括テスト中' : (result ? '再テスト' : '表示をテスト'));
        button.addEventListener('click', () => runSingleDisplayTest(image));
        return button;
    }

    /**
     * 画像1件分の表示テスト結果、プレビュー、操作ボタンを組み立てる。
     * @param {GyazoImage} image
     * @returns {HTMLDivElement}
     */
    function createDisplayTestElement(image) {
        const container = document.createElement('div');
        const result = state.displayTestResults[image.id];
        const isTesting = state.testingImageIds.has(image.id);
        const resultBox = createDisplayTestResultElement(result, isTesting);
        const preview = createDisplayTestPreview(image, result);
        if (preview) resultBox.append(preview);
        container.append(resultBox, createDisplayTestButton(image, result, isTesting));
        return container;
    }

    /**
     * 掲載元と表示テスト操作を含む、一覧の画像1件分を生成する。
     * @param {GyazoImage} image
     * @returns {HTMLElement}
     */
    function createImageElement(image) {
        const article = document.createElement('article');
        article.className = 'image-item';
        article.dataset.imageId = image.id;
        const details = document.createElement('div');
        const idLabel = document.createElement('div');
        idLabel.className = 'image-id';
        idLabel.textContent = image.id;
        details.append(idLabel);
        const heading = document.createElement('div');
        heading.className = 'small fw-semibold mt-3';
        heading.textContent = `掲載元 ${image.sources.length}件`;
        details.append(heading);
        const list = document.createElement('ul');
        list.className = 'source-list';
        image.sources.forEach(source => list.append(createSourceElement(source)));
        details.append(list);
        const actions = document.createElement('div');
        actions.className = 'item-actions';
        const open = document.createElement('a');
        open.className = 'btn btn-outline-primary';
        open.href = image.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.textContent = 'Gyazoで開く';
        actions.append(open);
        actions.append(createDisplayTestElement(image));
        article.append(details, actions);
        return article;
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

    /** DOMの入力値を純粋な一覧計算へ渡し、現在の表示内容を返す。 */
    function getCurrentListView() {
        const filtered = filterImages(state.images, state.displayTestResults, elements.search.value, elements.testResultFilter.value);
        const requestedPageSize = elements.pageSize.value === 'all' ? null : Number(elements.pageSize.value);
        return { filtered, ...paginateImages(filtered, requestedPageSize, state.currentPage) };
    }

    /**
     * 一括テストの選択範囲に応じた対象画像を返す。
     * @returns {GyazoImage[]}
     */
    function getBatchTargets() {
        if (elements.testScope.value === 'all') return state.images.slice();
        const view = getCurrentListView();
        return elements.testScope.value === 'filtered' ? view.filtered : view.items;
    }
    function updateTestScopeButton() {
        if (state.batchRun) return;
        const count = getBatchTargets().length;
        elements.startDisplayTest.textContent = `対象${count}件を順次テスト`;
        elements.startDisplayTest.disabled = count === 0;
    }

    /** 一覧、件数表示、ページャー、絞り込み状態をまとめて再描画する。 */
    function renderList() {
        const view = getCurrentListView();
        setCurrentPage(view.page);
        const fragment = document.createDocumentFragment();
        view.items.forEach(image => fragment.append(createImageElement(image)));
        elements.imageList.replaceChildren(fragment);
        elements.emptyFilter.classList.toggle('d-none', view.filtered.length !== 0);
        elements.visibleCount.textContent = view.filtered.length === 0
            ? `0 / ${state.images.length}件`
            : `${view.start + 1}〜${view.start + view.items.length} / ${view.filtered.length}件`;
        const hidePagination = view.filtered.length === 0 || elements.pageSize.value === 'all';
        elements.paginationControls.forEach(controls => {
            controls.container.classList.toggle('d-none', hidePagination);
            controls.info.textContent = `${view.page} / ${view.totalPages}ページ`;
            controls.first.disabled = state.currentPage === 1;
            controls.previous.disabled = state.currentPage === 1;
            controls.next.disabled = state.currentPage === view.totalPages;
            controls.last.disabled = state.currentPage === view.totalPages;
        });
        updateTestFilterButtons();
        updateTestScopeButton();
    }
    function updateDisplayTestSummary() {
        const counts = createResultCounts(DISPLAY_TEST_SUMMARY_KEYS);
        state.images.forEach(image => {
            const result = state.displayTestResults[image.id];
            const key = result && isStoredDisplayTestResult(result.result) ? result.result : 'untested';
            counts[key] += 1;
        });
        Object.entries(counts).forEach(([key, value]) => {
            elements.testCounts[key].textContent = value;
        });
    }
    function updateTestFilterButtons() {
        elements.testFilterButtons.forEach(button => {
            const isActive = elements.testResultFilter.value === button.dataset.testFilter;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }
    function refreshDisplayTestUi(imageId) {
        updateDisplayTestSummary();
        if (elements.testResultFilter.value !== 'all' || getCurrentListView().items.some(image => image.id === imageId)) renderList();
        else updateTestScopeButton();
    }

    /**
     * PNG・JPG・GIF・MP4を並行して読み込み、ブラウザのイベントだけで表示可否を判定する。
     * 状態の保存や画面更新は行わず、判定結果とキャンセル関数を返す。
     * @param {string} imageId
     * @returns {{requestId: number, promise: Promise<MediaTestOutcome>, cancel: Function}}
     */
    function createMediaTest(imageId) {
        const requestId = ++state.requestSequence;
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

    /**
     * 判定結果を現在のプロジェクトへ保存する。
     * @param {string} imageId
     * @param {MediaTestOutcome} outcome
     */
    function saveDisplayTestOutcome(imageId, outcome) {
        if (!isStoredDisplayTestResult(outcome.result)) return;
        /** @type {DisplayTestResult} */
        const result = {
            result: /** @type {'available'|'unavailable'|'timeout'} */ (outcome.result),
            testedAt: new Date().toISOString()
        };
        if (outcome.format) result.format = outcome.format;
        setDisplayTestResult(imageId, result, outcome.previewUrl);
        saveDisplayTestResults();
    }

    /** 実行中のリクエストと判定中表示を、同じリクエストIDの場合だけ解除する。 */
    function clearDisplayTestRequest(imageId, requestId) {
        const active = state.activeTestRequests.get(imageId);
        if (!active || active.requestId !== requestId) return;
        state.activeTestRequests.delete(imageId);
        state.testingImageIds.delete(imageId);
    }

    /**
     * 判定結果を保存して画面へ反映し、呼び出し元には結果名だけを返す。
     * 古いJSONに対する結果は保存も描画もしない。
     * @param {GyazoImage} image
     * @param {number} requestId
     * @param {number} requestSession
     * @param {MediaTestOutcome} outcome
     * @returns {'available'|'unavailable'|'timeout'|'cancelled'}
     */
    function applyDisplayTestOutcome(image, requestId, requestSession, outcome) {
        clearDisplayTestRequest(image.id, requestId);
        const isCurrent = requestSession === state.sessionVersion && state.images.some(item => item.id === image.id);
        if (isCurrent && isStoredDisplayTestResult(outcome.result)) saveDisplayTestOutcome(image.id, outcome);
        if (isCurrent) refreshDisplayTestUi(image.id);
        return outcome.result;
    }

    /**
     * 画像1件の判定開始、キャンセル管理、結果反映を調整する。
     * @param {GyazoImage} image
     * @param {number|null} runId 一括テストの識別子。個別テストの場合はnull
     * @returns {Promise<'available'|'unavailable'|'timeout'|'cancelled'>}
     */
    function performDisplayTest(image, runId) {
        const previous = state.activeTestRequests.get(image.id);
        if (previous) previous.cancel();
        const requestSession = state.sessionVersion;
        const mediaTest = createMediaTest(image.id);
        const cancel = () => {
            mediaTest.cancel();
            clearDisplayTestRequest(image.id, mediaTest.requestId);
        };
        state.activeTestRequests.set(image.id, { requestId: mediaTest.requestId, runId, cancel });
        state.testingImageIds.add(image.id);
        refreshDisplayTestUi(image.id);
        return mediaTest.promise.then(outcome => applyDisplayTestOutcome(image, mediaTest.requestId, requestSession, outcome));
    }
    function runSingleDisplayTest(image) {
        performDisplayTest(image, null);
    }
    function updateBatchProgress(run) {
        elements.testProgressBar.max = Math.max(run.total, 1);
        elements.testProgressBar.value = run.completed;
        elements.testProgressText.textContent = `${run.completed} / ${run.total}件（${formatBatchResultCounts(run.counts)}）`;
    }
    function setBatchControls(isRunning) {
        elements.testScope.disabled = isRunning;
        elements.startDisplayTest.disabled = isRunning;
        elements.stopDisplayTest.disabled = !isRunning;
        elements.stopDisplayTest.classList.toggle('d-none', !isRunning);
        if (!isRunning) updateTestScopeButton();
    }

    /**
     * 一括テストの次の対象を取得し、停止されるまで順番に処理する。
     * @param {BatchRun} run
     * @returns {Promise<void>}
     */
    async function runBatchWorker(run) {
        while (!run.stopped && run.nextIndex < run.total) {
            const image = run.targets[run.nextIndex];
            run.nextIndex += 1;
            const outcome = await performDisplayTest(image, run.id);
            if (run.stopped) return;
            if (isStoredDisplayTestResult(outcome)) {
                run.completed += 1;
                run.counts[outcome] += 1;
                updateBatchProgress(run);
            }
        }
    }

    /** 選択範囲と同時実行数を決定し、一括テストの開始から完了までを管理する。 */
    async function startBatchDisplayTest() {
        if (state.batchRun) return;
        const targets = getBatchTargets();
        if (targets.length === 0) return;
        const run = {
            id: ++state.batchSequence,
            targets,
            total: targets.length,
            nextIndex: 0,
            completed: 0,
            stopped: false,
            counts: createResultCounts(DISPLAY_TEST_OUTCOME_KEYS)
        };
        state.batchRun = run;
        elements.testProgress.classList.remove('d-none');
        setBatchControls(true);
        renderList();
        updateBatchProgress(run);
        const workerCount = Math.min(TEST_CONCURRENCY, run.total);
        await Promise.all(Array.from({ length: workerCount }, () => runBatchWorker(run)));
        if (state.batchRun !== run) return;
        state.batchRun = null;
        setBatchControls(false);
        renderList();
        elements.testProgressText.textContent = `完了: ${run.completed} / ${run.total}件（${formatBatchResultCounts(run.counts)}）`;
    }
    function stopBatchDisplayTest() {
        const run = state.batchRun;
        if (!run) return;
        run.stopped = true;
        state.activeTestRequests.forEach(request => {
            if (request.runId === run.id) request.cancel();
        });
        state.batchRun = null;
        setBatchControls(false);
        renderList();
        elements.testProgressText.textContent = `停止しました: ${run.completed} / ${run.total}件を完了`;
    }

    /**
     * 実行中のテストを無効化し、過去の非同期結果が現在の画面へ反映されないようにする。
     * JSONの切り替え前に必ず呼び出す。
     */
    function invalidateDisplayTests() {
        state.sessionVersion += 1;
        if (state.batchRun) state.batchRun.stopped = true;
        state.activeTestRequests.forEach(request => request.cancel());
        state.activeTestRequests.clear();
        state.testingImageIds.clear();
        state.batchRun = null;
        elements.testProgress.classList.add('d-none');
        setBatchControls(false);
    }

    /**
     * 検証済みエクスポートを画面状態へ反映する。
     * @param {CosenseExport} data
     */
    function loadExport(data) {
        validateExport(data);
        const extracted = extractImages(data);
        if (extracted.length === 0) throw new Error('有効なGyazo画像URLが見つかりませんでした。32桁の画像IDを含むURLがあるか確認してください。');
        initializeProjectState(data.name, extracted);
        elements.projectHeading.textContent = data.displayName || data.name;
        elements.search.value = '';
        elements.testResultFilter.value = 'all';
        elements.workspace.classList.remove('d-none');
        elements.inputSummary.textContent = `${state.images.length}件のGyazo画像を読み込み済み`;
        updateDisplayTestSummary();
        renderList();
        showMessage(`${state.images.length}件のGyazo画像を読み込みました。`, 'success');
        setInputCompact(true);
    }

    /**
     * 選択されたJSONファイルをブラウザ内で読み込み、解析する。
     * @param {File|undefined} file
     * @returns {Promise<void>}
     */
    async function handleFile(file) {
        clearMessage();
        elements.workspace.classList.add('d-none');
        if (!file) return;
        setInputCompact(false);
        invalidateDisplayTests();
        if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
            showMessage('JSONファイルを選択してください。', 'danger');
            return;
        }
        try {
            const text = await file.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (error) {
                throw new Error('JSONを解析できませんでした。ファイルが壊れていないか確認してください。');
            }
            loadExport(data);
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'ファイルの読み込みに失敗しました。', 'danger');
        } finally {
            elements.fileInput.value = '';
        }
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    function csvEscape(value) {
        return `"${String(value).replace(/"/g, '""')}"`;
    }

    /**
     * 画像一覧と表示テスト結果からCSVのデータ行を生成する。
     * @param {GyazoImage[]} imageItems
     * @param {Record<string, DisplayTestResult>} testResults
     * @returns {string[][]}
     */
    function createCsvRows(imageItems, testResults) {
        return imageItems.map(image => {
            const testResult = testResults[image.id];
            const resultDefinition = getDisplayTestResultDefinition(testResult?.result) || DISPLAY_TEST_RESULT_CONFIG.untested;
            return [
                image.id,
                image.url,
                resultDefinition.label,
                testResult ? testResult.testedAt : '',
                Array.from(new Set(image.sources.map(source => source.pageTitle))).join(' / ')
            ];
        });
    }

    /**
     * CSVのデータ行を、Excelで開きやすいBOM付きUTF-8の文字列へ変換する。
     * @param {string[][]} rows
     * @returns {string}
     */
    function createCsvText(rows) {
        return '\uFEFF' + [
            CSV_HEADER,
            ...rows
        ].map(row => row.map(csvEscape).join(',')).join('\r\n');
    }

    /**
     * CSV文字列をBlobへ変換し、指定したファイル名でダウンロードする。
     * @param {string} csvText
     * @param {string} fileName
     */
    function downloadCsv(csvText, fileName) {
        const url = URL.createObjectURL(new Blob([csvText], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    /** 表示テスト結果のCSV生成とダウンロードを調整する。 */
    function exportCsv() {
        const rows = createCsvRows(state.images, state.displayTestResults);
        const csvText = createCsvText(rows);
        const fileName = `gyazo-review-${state.currentProject.replace(/[\\/:*?"<>|]/g, '_')}.csv`;
        downloadCsv(csvText, fileName);
    }

    function resetPageAndRender() {
        setCurrentPage(1);
        renderList();
    }
    function moveToFirstPage() {
        setCurrentPage(1);
        renderList();
    }
    function moveToPreviousPage() {
        if (state.currentPage > 1) {
            setCurrentPage(state.currentPage - 1);
            renderList();
        }
    }
    function moveToNextPage() {
        setCurrentPage(state.currentPage + 1);
        renderList();
    }
    function moveToLastPage() {
        setCurrentPage(getCurrentListView().totalPages);
        renderList();
    }

    /** 画面上の操作要素へイベントを登録する。初期化時に1回だけ呼び出す。 */
    function bindEvents() {
        elements.fileInput.addEventListener('change', event => handleFile(event.target.files[0]));
        elements.chooseAnotherFile.addEventListener('click', () => elements.fileInput.click());
        elements.dropZone.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                elements.fileInput.click();
            }
        });
        ['dragenter', 'dragover'].forEach(type => elements.dropZone.addEventListener(type, event => {
            event.preventDefault();
            elements.dropZone.classList.add('is-dragging');
        }));
        ['dragleave', 'drop'].forEach(type => elements.dropZone.addEventListener(type, event => {
            event.preventDefault();
            elements.dropZone.classList.remove('is-dragging');
        }));
        elements.dropZone.addEventListener('drop', event => handleFile(event.dataTransfer.files[0]));
        elements.search.addEventListener('input', resetPageAndRender);
        elements.testResultFilter.addEventListener('change', resetPageAndRender);
        elements.testFilterButtons.forEach(button => button.addEventListener('click', () => {
            elements.testResultFilter.value = elements.testResultFilter.value === button.dataset.testFilter ? 'all' : button.dataset.testFilter;
            resetPageAndRender();
        }));
        elements.pageSize.addEventListener('change', resetPageAndRender);
        elements.testScope.addEventListener('change', updateTestScopeButton);
        elements.startDisplayTest.addEventListener('click', startBatchDisplayTest);
        elements.stopDisplayTest.addEventListener('click', stopBatchDisplayTest);
        elements.paginationControls.forEach(controls => {
            controls.first.addEventListener('click', moveToFirstPage);
            controls.previous.addEventListener('click', moveToPreviousPage);
            controls.next.addEventListener('click', moveToNextPage);
            controls.last.addEventListener('click', moveToLastPage);
        });
        elements.exportCsv.addEventListener('click', exportCsv);
    }

    window.CosenseGyazoReview = Object.freeze({
        extractImages,
        validateExport,
        getCosensePageUrl,
        filterImages,
        paginateImages,
        csvEscape,
        createCsvRows,
        createCsvText,
        isValidDisplayTestResult
    });
    bindEvents();
}());
