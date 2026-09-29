(function () {
    'use strict';

    // 画面状態、DOM更新、結果保存、一括実行、ファイル読み込み、イベント登録を担当する。

    if (!window.CosenseGyazoReviewCore) throw new Error('core.jsをapp.jsより先に読み込んでください。');
    const {
        DISPLAY_TEST_RESULT_CONFIG,
        DISPLAY_TEST_SUMMARY_KEYS,
        DISPLAY_TEST_OUTCOME_KEYS,
        validateExport,
        getCosensePageUrl,
        extractImages,
        filterImages,
        paginateImages,
        getDisplayTestResultDefinition,
        isStoredDisplayTestResult,
        createResultCounts,
        isValidDisplayTestResult,
        sanitizeCsvCell,
        csvEscape,
        createCsvRows,
        createCsvText
    } = window.CosenseGyazoReviewCore;
    if (!window.CosenseGyazoReviewDisplayTest) throw new Error('display-test.jsをapp.jsより先に読み込んでください。');
    const {
        getDisplayImageUrl,
        createMediaTest
    } = window.CosenseGyazoReviewDisplayTest;

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
     * @property {number} fileLoadSequence
     * @property {number} sessionVersion
     * @property {number} batchSequence
     * @property {BatchRun|null} batchRun
     * @property {Map<string, {requestId: number, runId: number|null, cancel: Function}>} activeTestRequests
     * @property {Set<string>} testingImageIds
     * @property {Set<string>} expandedSourceImageIds
     * @property {Set<string>} expandedDisplayTestImageIds
     */

    const TEST_STORAGE_PREFIX = 'cosense-gyazo-review:display-tests:v1:';
    const TEST_CONCURRENCY = 3;
    const SEARCH_DEBOUNCE_MS = 1000;
    const BATCH_UI_REFRESH_INTERVAL_MS = 300;
    const BATCH_SAVE_INTERVAL_MS = 1000;
    /** @type {number|null} */
    let searchRenderTimer = null;
    /** @type {number|null} */
    let batchUiRefreshTimer = null;
    /** @type {number|null} */
    let batchSaveTimer = null;
    let batchUiRefreshPending = false;
    let batchSavePending = false;
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
        resultTableContainer: getRequiredElement('result-table-container'),
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
        clearDisplayTestResults: getRequiredElement('clear-display-test-results'),
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
        fileLoadSequence: 0,
        // JSON切り替え時に加算し、古い非同期リクエストの結果を破棄する。
        sessionVersion: 0,
        batchSequence: 0,
        batchRun: null,
        activeTestRequests: new Map(),
        testingImageIds: new Set(),
        // 掲載元の開閉状態は現在のセッションだけで使い、localStorageには保存しない。
        expandedSourceImageIds: new Set(),
        // 表示テスト詳細の開閉状態も現在のセッションだけで使う。
        expandedDisplayTestImageIds: new Set()
    };

    /**
     * JSON読み込みごとの識別子を発行する。
     * @returns {number}
     */
    function beginFileLoad() {
        state.fileLoadSequence += 1;
        return state.fileLoadSequence;
    }

    /**
     * 指定したJSON読み込みが、現在も最新か判定する。
     * @param {number} loadId
     * @returns {boolean}
     */
    function isCurrentFileLoad(loadId) {
        return loadId === state.fileLoadSequence;
    }

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

    /** 表示テスト結果とセッション内のプレビューを未判定の状態へ戻す。 */
    function resetDisplayTestResults() {
        state.displayTestResults = {};
        state.displayPreviewUrls = {};
        state.expandedDisplayTestImageIds.clear();
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
        state.expandedSourceImageIds.clear();
        state.expandedDisplayTestImageIds.clear();
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
     * @param {string} projectName
     * @returns {string}
     */
    function getTestStorageKey(projectName) {
        return `${TEST_STORAGE_PREFIX}${encodeURIComponent(projectName)}`;
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
     * 判定名を見出しとして、検査日時とプレビューを折りたたむ要素を生成する。
     * @param {GyazoImage} image
     * @param {DisplayTestResult|undefined} result
     * @param {boolean} isTesting
     * @returns {HTMLDivElement}
     */
    function createDisplayTestResultElement(image, result, isTesting) {
        const resultBox = document.createElement('div');
        resultBox.className = 'display-test-result small';
        resultBox.dataset.result = isTesting ? 'testing' : (result ? result.result : 'untested');
        const resultLabel = document.createElement('strong');
        const formatLabel = result && result.result === 'available' && result.format ? `（${result.format.toUpperCase()}）` : '';
        const resultDefinition = getDisplayTestResultDefinition(result?.result) || DISPLAY_TEST_RESULT_CONFIG.untested;
        resultLabel.textContent = isTesting ? '判定中…' : `${resultDefinition.label}${formatLabel}`;
        if (!result) {
            resultBox.append(resultLabel);
            return resultBox;
        }
        const details = document.createElement('details');
        details.className = 'display-test-details';
        details.open = state.expandedDisplayTestImageIds.has(image.id);
        const summary = document.createElement('summary');
        summary.append(resultLabel);
        const content = document.createElement('div');
        content.className = 'display-test-details-content';
        const testedAt = document.createElement('time');
        testedAt.dateTime = result.testedAt;
        testedAt.textContent = `検査時点: ${formatTestedAt(result.testedAt)}`;
        content.append(testedAt);
        const preview = createDisplayTestPreview(image, result);
        if (preview) content.append(preview);
        details.append(summary, content);
        const detailsSession = state.sessionVersion;
        details.addEventListener('toggle', () => {
            if (detailsSession !== state.sessionVersion) return;
            if (details.open) state.expandedDisplayTestImageIds.add(image.id);
            else state.expandedDisplayTestImageIds.delete(image.id);
        });
        resultBox.append(details);
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
     * 画像1件の表示テストを開始するボタンを生成する。
     * @param {GyazoImage} image
     * @param {boolean} isTesting
     * @returns {HTMLButtonElement}
     */
    function createDisplayTestButton(image, isTesting) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-secondary';
        button.disabled = isTesting || Boolean(state.batchRun);
        button.textContent = isTesting ? 'テスト中…' : (state.batchRun ? '一括テスト中' : '表示テスト');
        button.addEventListener('click', () => runSingleDisplayTest(image));
        return button;
    }

    /**
     * 画像ID、掲載元、表示テスト結果、操作を含む表の1行を生成する。
     * @param {GyazoImage} image
     * @returns {HTMLTableRowElement}
     */
    function createImageElement(image) {
        const row = document.createElement('tr');
        row.className = 'image-item';
        row.dataset.imageId = image.id;

        const idCell = document.createElement('td');
        idCell.dataset.label = '画像ID';
        const idLabel = document.createElement('div');
        idLabel.className = 'image-id';
        idLabel.textContent = image.id;
        idCell.append(idLabel);

        const sourceCell = document.createElement('td');
        sourceCell.dataset.label = '掲載元';
        const sourceDetails = document.createElement('details');
        sourceDetails.className = 'source-details';
        sourceDetails.open = state.expandedSourceImageIds.has(image.id);
        const sourceSummary = document.createElement('summary');
        sourceSummary.textContent = `掲載元 ${image.sources.length}件`;
        const list = document.createElement('ul');
        list.className = 'source-list';
        image.sources.forEach(source => list.append(createSourceElement(source)));
        sourceDetails.append(sourceSummary, list);
        const sourceSession = state.sessionVersion;
        sourceDetails.addEventListener('toggle', () => {
            if (sourceSession !== state.sessionVersion) return;
            if (sourceDetails.open) state.expandedSourceImageIds.add(image.id);
            else state.expandedSourceImageIds.delete(image.id);
        });
        sourceCell.append(sourceDetails);

        const result = state.displayTestResults[image.id];
        const isTesting = state.testingImageIds.has(image.id);
        const resultCell = document.createElement('td');
        resultCell.dataset.label = '表示テスト結果';
        const resultBox = createDisplayTestResultElement(image, result, isTesting);
        resultCell.append(resultBox);

        const actionCell = document.createElement('td');
        actionCell.dataset.label = '操作';
        const actions = document.createElement('div');
        actions.className = 'item-actions';
        actions.append(createDisplayTestButton(image, isTesting));
        actionCell.append(actions);

        row.append(idCell, sourceCell, resultCell, actionCell);
        return row;
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
        elements.resultTableContainer.classList.toggle('d-none', view.filtered.length === 0);
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
        const storedResultCount = state.images.length - counts.untested;
        elements.clearDisplayTestResults.disabled = storedResultCount === 0
            || Boolean(state.batchRun)
            || state.activeTestRequests.size > 0;
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

    /** 一括テスト中に予約された画面更新を実行する。 */
    function flushScheduledBatchUiRefresh() {
        if (batchUiRefreshTimer !== null) clearTimeout(batchUiRefreshTimer);
        batchUiRefreshTimer = null;
        if (!batchUiRefreshPending) return;
        batchUiRefreshPending = false;
        updateDisplayTestSummary();
        renderList();
    }

    /** 一括テスト中の画面更新を一定間隔にまとめる。 */
    function scheduleBatchUiRefresh() {
        batchUiRefreshPending = true;
        if (batchUiRefreshTimer !== null) return;
        batchUiRefreshTimer = setTimeout(flushScheduledBatchUiRefresh, BATCH_UI_REFRESH_INTERVAL_MS);
    }

    /** 一括テスト中に予約された保存を実行する。 */
    function flushScheduledBatchSave() {
        if (batchSaveTimer !== null) clearTimeout(batchSaveTimer);
        batchSaveTimer = null;
        if (!batchSavePending) return;
        batchSavePending = false;
        saveDisplayTestResults();
    }

    /** 一括テスト中のlocalStorage保存を一定間隔にまとめる。 */
    function scheduleBatchSave() {
        batchSavePending = true;
        if (batchSaveTimer !== null) return;
        batchSaveTimer = setTimeout(flushScheduledBatchSave, BATCH_SAVE_INTERVAL_MS);
    }

    /**
     * 一括テストの保留中処理を確定し、必要なら現在の画面を更新する。
     * @param {{refreshUi?: boolean}} [options]
     */
    function flushPendingBatchUpdates({ refreshUi = true } = {}) {
        flushScheduledBatchSave();
        if (batchUiRefreshTimer !== null) clearTimeout(batchUiRefreshTimer);
        batchUiRefreshTimer = null;
        batchUiRefreshPending = false;
        if (refreshUi) {
            updateDisplayTestSummary();
            renderList();
        }
    }

    /**
     * 判定結果を現在のプロジェクトの画面状態へ反映する。
     * @param {string} imageId
     * @param {MediaTestOutcome} outcome
     */
    function recordDisplayTestOutcome(imageId, outcome) {
        if (!isStoredDisplayTestResult(outcome.result)) return;
        /** @type {DisplayTestResult} */
        const result = {
            result: /** @type {'available'|'unavailable'|'timeout'} */ (outcome.result),
            testedAt: new Date().toISOString()
        };
        if (outcome.format) result.format = outcome.format;
        setDisplayTestResult(imageId, result, outcome.previewUrl);
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
     * @param {number|null} runId
     * @param {MediaTestOutcome} outcome
     * @returns {'available'|'unavailable'|'timeout'|'cancelled'}
     */
    function applyDisplayTestOutcome(image, requestId, requestSession, runId, outcome) {
        clearDisplayTestRequest(image.id, requestId);
        const isCurrent = requestSession === state.sessionVersion && state.images.some(item => item.id === image.id);
        if (isCurrent && isStoredDisplayTestResult(outcome.result)) {
            recordDisplayTestOutcome(image.id, outcome);
            if (runId === null) saveDisplayTestResults();
            else scheduleBatchSave();
        }
        if (isCurrent) {
            if (runId === null) refreshDisplayTestUi(image.id);
            else scheduleBatchUiRefresh();
        }
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
        if (runId === null) refreshDisplayTestUi(image.id);
        else scheduleBatchUiRefresh();
        return mediaTest.promise.then(outcome => applyDisplayTestOutcome(image, mediaTest.requestId, requestSession, runId, outcome));
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
        if (isRunning) elements.clearDisplayTestResults.disabled = true;
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
        flushPendingBatchUpdates();
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
        flushPendingBatchUpdates();
        elements.testProgressText.textContent = `停止しました: ${run.completed} / ${run.total}件を完了`;
    }

    /**
     * 実行中のテストを無効化し、過去の非同期結果が現在の画面へ反映されないようにする。
     * JSONの切り替え前に必ず呼び出す。
     */
    function invalidateDisplayTests() {
        flushPendingBatchUpdates({ refreshUi: false });
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
        cancelPendingSearchRender();
        clearMessage();
        elements.workspace.classList.add('d-none');
        if (!file) return;
        const loadId = beginFileLoad();
        setInputCompact(false);
        invalidateDisplayTests();
        if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
            showMessage('JSONファイルを選択してください。', 'danger');
            return;
        }
        try {
            const text = await file.text();
            if (!isCurrentFileLoad(loadId)) return;
            let data;
            try {
                data = JSON.parse(text);
            } catch (error) {
                throw new Error('JSONを解析できませんでした。ファイルが壊れていないか確認してください。');
            }
            loadExport(data);
        } catch (error) {
            if (!isCurrentFileLoad(loadId)) return;
            showMessage(error instanceof Error ? error.message : 'ファイルの読み込みに失敗しました。', 'danger');
        } finally {
            if (isCurrentFileLoad(loadId)) elements.fileInput.value = '';
        }
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

    /** 現在のプロジェクトに保存された表示テスト結果を確認後に消去する。 */
    function clearStoredDisplayTestResults() {
        if (!state.currentProject || state.batchRun || state.activeTestRequests.size > 0) return;
        const storedResultCount = state.images.filter(image => {
            const result = state.displayTestResults[image.id];
            return result && isStoredDisplayTestResult(result.result);
        }).length;
        if (storedResultCount === 0) return;
        const confirmed = window.confirm(
            '現在読み込んでいるプロジェクトの保存済み表示テスト結果をすべて消去し、未判定に戻します。\n\n'
            + 'この操作は元に戻せません。よろしいですか？'
        );
        if (!confirmed) return;
        flushPendingBatchUpdates({ refreshUi: false });
        try {
            localStorage.removeItem(getTestStorageKey(state.currentProject));
        } catch (error) {
            showMessage('保存済みの表示テスト結果を消去できませんでした。ブラウザの保存設定を確認してください。', 'warning');
            return;
        }
        resetDisplayTestResults();
        updateDisplayTestSummary();
        renderList();
        showMessage('保存済みの表示テスト結果を消去し、すべて未判定に戻しました。', 'success');
    }

    /** 保留中の検索結果更新を取り消す。 */
    function cancelPendingSearchRender() {
        if (searchRenderTimer === null) return;
        clearTimeout(searchRenderTimer);
        searchRenderTimer = null;
    }

    /** 検索入力が落ち着いてから一覧を更新する。 */
    function scheduleSearchRender() {
        cancelPendingSearchRender();
        searchRenderTimer = setTimeout(() => {
            searchRenderTimer = null;
            resetPageAndRender();
        }, SEARCH_DEBOUNCE_MS);
    }

    function resetPageAndRender() {
        cancelPendingSearchRender();
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
        elements.search.addEventListener('input', scheduleSearchRender);
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
        elements.clearDisplayTestResults.addEventListener('click', clearStoredDisplayTestResults);
    }

    window.CosenseGyazoReview = Object.freeze({
        extractImages,
        validateExport,
        getCosensePageUrl,
        filterImages,
        paginateImages,
        sanitizeCsvCell,
        csvEscape,
        createCsvRows,
        createCsvText,
        isValidDisplayTestResult
    });
    bindEvents();
}());
