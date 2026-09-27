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
     * @typedef {'png'|'jpg'|'gif'|'mp4'} DisplayTestFormat
     */

    /**
     * @typedef {Object} DisplayTestResult
     * @property {'available'|'unavailable'|'timeout'} result
     * @property {string} testedAt ISO 8601形式の検査日時
     * @property {DisplayTestFormat} [format] 表示できた形式
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
    const DISPLAY_RESULT = Object.freeze({ available: '表示できた', unavailable: '表示できない', timeout: '時間切れ' });
    /** @type {ReadonlyArray<DisplayTestFormat>} */
    const DISPLAY_FORMATS = Object.freeze(['png', 'jpg', 'gif', 'mp4']);
    const TEST_STORAGE_PREFIX = 'cosense-gyazo-review:display-tests:v1:';
    const TEST_TIMEOUT_MS = 12000;
    const TEST_CONCURRENCY = 3;
    const GYAZO_PATTERN = /https?:\/\/(?:i\.)?gyazo\.com\/([a-f0-9]{32})(?![a-f0-9])(?:\.[a-z0-9]+)?(?:[?#][^\s\]\[<>"']*)?/gi;

    // DOM参照を一か所に集約し、描画処理で同じ要素を再検索しない。
    const elements = {
        fileInput: document.getElementById('file-input'), dropZone: document.getElementById('drop-zone'),
        inputExpanded: document.getElementById('input-expanded'), inputCompact: document.getElementById('input-compact'),
        inputSummary: document.getElementById('input-summary'), chooseAnotherFile: document.getElementById('choose-another-file'),
        message: document.getElementById('message'), workspace: document.getElementById('workspace'),
        projectHeading: document.getElementById('project-heading'), imageList: document.getElementById('image-list'),
        emptyFilter: document.getElementById('empty-filter'), search: document.getElementById('search'),
        testResultFilter: document.getElementById('test-result-filter'), pageSize: document.getElementById('page-size'),
        topPagination: document.getElementById('top-pagination'), topFirstPage: document.getElementById('top-first-page'),
        topPreviousPage: document.getElementById('top-previous-page'), topNextPage: document.getElementById('top-next-page'),
        topLastPage: document.getElementById('top-last-page'), topPageInfo: document.getElementById('top-page-info'),
        bottomPagination: document.getElementById('bottom-pagination'), firstPage: document.getElementById('first-page'),
        previousPage: document.getElementById('previous-page'), nextPage: document.getElementById('next-page'),
        lastPage: document.getElementById('last-page'), pageInfo: document.getElementById('page-info'),
        exportCsv: document.getElementById('export-csv'), visibleCount: document.getElementById('visible-count'),
        testScope: document.getElementById('test-scope'), startDisplayTest: document.getElementById('start-display-test'),
        stopDisplayTest: document.getElementById('stop-display-test'), testProgress: document.getElementById('test-progress'),
        testProgressBar: document.getElementById('test-progress-bar'), testProgressText: document.getElementById('test-progress-text'),
        testCounts: Object.fromEntries(['untested', ...Object.keys(DISPLAY_RESULT)].map(key => [key, document.getElementById(`test-count-${key}`)])),
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
        if (data.pages.some(page => !page || typeof page.title !== 'string' || !Array.isArray(page.lines))) throw new Error('titleまたはlinesを持たないページがあります。エクスポート形式を確認してください。');
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
                imageMap.get(id).sources.push({ pageTitle: page.title, lineText, lineNumber: lineIndex + 1, pageUrl: getCosensePageUrl(data.name, page.title) });
            }
        }));
        return Array.from(imageMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * @param {string} projectName
     * @returns {string}
     */
    function getTestStorageKey(projectName) { return `${TEST_STORAGE_PREFIX}${encodeURIComponent(projectName)}`; }

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
            return Object.fromEntries(Object.entries(stored).filter(([id, value]) =>
                validImageIds.has(id) && value && DISPLAY_RESULT[value.result] && typeof value.testedAt === 'string' &&
                (value.format === undefined || DISPLAY_FORMATS.includes(value.format))
            ));
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
            if (value && DISPLAY_RESULT[value.result]) {
                minimal[image.id] = { result: value.result, testedAt: value.testedAt };
                if (value.format) minimal[image.id].format = value.format;
            }
        });
        try { localStorage.setItem(getTestStorageKey(state.currentProject), JSON.stringify(minimal)); }
        catch (error) { showMessage('表示テスト結果をブラウザに保存できませんでした。ブラウザの保存設定を確認してください。', 'warning'); }
    }

    /**
     * 表示テスト用のi.gyazo.com URLを生成する。
     * 再テスト時はキャッシュ回避用クエリを付けるが、画像ID自体は変更しない。
     * @param {string} id
     * @param {DisplayTestFormat} format
     * @param {boolean} cacheBust
     * @returns {string}
     */
    function getDisplayImageUrl(id, format, cacheBust) {
        const base = `https://i.gyazo.com/${id}.${format}`;
        return cacheBust ? `${base}?cosense_gyazo_review=${Date.now()}-${state.requestSequence}` : base;
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
        link.href = source.pageUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = source.pageTitle || '（無題のページ）';
        const line = document.createElement('span');
        line.className = 'source-line small'; line.textContent = `${source.lineNumber}行目: ${source.lineText}`;
        item.append(link, line);
        return item;
    }

    /**
     * 画像1件分の表示テスト結果、プレビュー、操作ボタンを生成する。
     * @param {GyazoImage} image
     * @returns {HTMLDivElement}
     */
    function createDisplayTestElement(image) {
        const container = document.createElement('div');
        const result = state.displayTestResults[image.id];
        const isTesting = state.testingImageIds.has(image.id);
        const resultBox = document.createElement('div');
        resultBox.className = 'display-test-result small';
        resultBox.dataset.result = isTesting ? 'testing' : (result ? result.result : 'untested');
        const resultLabel = document.createElement('strong');
        const formatLabel = result && result.result === 'available' && result.format ? `（${result.format.toUpperCase()}）` : '';
        resultLabel.textContent = isTesting ? '判定中…' : (result ? `${DISPLAY_RESULT[result.result]}${formatLabel}` : '未判定');
        resultBox.append(resultLabel);
        if (result) {
            const testedAt = document.createElement('time');
            testedAt.dateTime = result.testedAt;
            testedAt.textContent = `検査時点: ${formatTestedAt(result.testedAt)}`;
            resultBox.append(testedAt);
        }
        if (result && result.result === 'available') {
            const preview = document.createElement(result.format === 'mp4' ? 'video' : 'img');
            preview.className = 'image-preview';
            preview.src = state.displayPreviewUrls[image.id] || getDisplayImageUrl(image.id, result.format || 'png', false);
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
            resultBox.append(preview);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-secondary mt-2';
        button.disabled = isTesting || Boolean(state.batchRun);
        button.textContent = isTesting ? 'テスト中…' : (state.batchRun ? '一括テスト中' : (result ? '再テスト' : '表示をテスト'));
        button.addEventListener('click', () => runSingleDisplayTest(image));
        container.append(resultBox, button);
        return container;
    }

    /**
     * 掲載元と表示テスト操作を含む、一覧の画像1件分を生成する。
     * @param {GyazoImage} image
     * @returns {HTMLElement}
     */
    function createImageElement(image) {
        const article = document.createElement('article'); article.className = 'image-item'; article.dataset.imageId = image.id;
        const details = document.createElement('div');
        const idLabel = document.createElement('div'); idLabel.className = 'image-id'; idLabel.textContent = image.id; details.append(idLabel);
        const heading = document.createElement('div'); heading.className = 'small fw-semibold mt-3'; heading.textContent = `掲載元 ${image.sources.length}件`; details.append(heading);
        const list = document.createElement('ul'); list.className = 'source-list'; image.sources.forEach(source => list.append(createSourceElement(source))); details.append(list);
        const actions = document.createElement('div'); actions.className = 'item-actions';
        const open = document.createElement('a'); open.className = 'btn btn-outline-primary'; open.href = image.url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Gyazoで開く'; actions.append(open);
        actions.append(createDisplayTestElement(image));
        article.append(details, actions);
        return article;
    }

    /**
     * 検索語と表示テスト結果の条件に一致する画像を返す。
     * @returns {GyazoImage[]}
     */
    function getFilteredImages() {
        const query = elements.search.value.trim().toLocaleLowerCase('ja');
        const testResult = elements.testResultFilter.value;
        return state.images.filter(image => {
            const imageResult = state.displayTestResults[image.id]?.result || 'untested';
            if (testResult !== 'all' && imageResult !== testResult) return false;
            if (!query) return true;
            return [image.id, ...image.sources.flatMap(source => [source.pageTitle, source.lineText])].join('\n').toLocaleLowerCase('ja').includes(query);
        });
    }

    /**
     * 現在のページに表示する画像を返す。
     * @param {GyazoImage[]} [filteredImages] 計算済みの絞り込み結果
     * @returns {GyazoImage[]}
     */
    function getVisibleImages(filteredImages) {
        const filtered = filteredImages || getFilteredImages();
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filtered.length, 1) : Number(elements.pageSize.value);
        const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
        const page = Math.min(state.currentPage, totalPages);
        const start = (page - 1) * pageSize;
        return filtered.slice(start, start + pageSize);
    }

    /**
     * 一括テストの選択範囲に応じた対象画像を返す。
     * @returns {GyazoImage[]}
     */
    function getBatchTargets() {
        if (elements.testScope.value === 'all') return state.images.slice();
        const filtered = getFilteredImages();
        return elements.testScope.value === 'filtered' ? filtered : getVisibleImages(filtered);
    }
    function updateTestScopeButton() {
        if (state.batchRun) return;
        const count = getBatchTargets().length;
        elements.startDisplayTest.textContent = `対象${count}件を順次テスト`;
        elements.startDisplayTest.disabled = count === 0;
    }

    /** 一覧、件数表示、ページャー、絞り込み状態をまとめて再描画する。 */
    function renderList() {
        const filtered = getFilteredImages();
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filtered.length, 1) : Number(elements.pageSize.value);
        const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
        state.currentPage = Math.min(state.currentPage, totalPages);
        const start = (state.currentPage - 1) * pageSize;
        const visible = getVisibleImages(filtered);
        const fragment = document.createDocumentFragment(); visible.forEach(image => fragment.append(createImageElement(image)));
        elements.imageList.replaceChildren(fragment);
        elements.emptyFilter.classList.toggle('d-none', filtered.length !== 0);
        elements.visibleCount.textContent = filtered.length === 0 ? `0 / ${state.images.length}件` : `${start + 1}〜${start + visible.length} / ${filtered.length}件`;
        const hidePagination = filtered.length === 0 || elements.pageSize.value === 'all';
        [elements.topPagination, elements.bottomPagination].forEach(pagination => pagination.classList.toggle('d-none', hidePagination));
        [elements.topPageInfo, elements.pageInfo].forEach(info => { info.textContent = `${state.currentPage} / ${totalPages}ページ`; });
        [elements.topFirstPage, elements.firstPage, elements.topPreviousPage, elements.previousPage].forEach(button => { button.disabled = state.currentPage === 1; });
        [elements.topNextPage, elements.nextPage, elements.topLastPage, elements.lastPage].forEach(button => { button.disabled = state.currentPage === totalPages; });
        updateTestFilterButtons();
        updateTestScopeButton();
    }
    function updateDisplayTestSummary() {
        const counts = { untested: 0, available: 0, unavailable: 0, timeout: 0 };
        state.images.forEach(image => {
            const result = state.displayTestResults[image.id];
            counts[result && DISPLAY_RESULT[result.result] ? result.result : 'untested'] += 1;
        });
        Object.entries(counts).forEach(([key, value]) => { elements.testCounts[key].textContent = value; });
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
        if (elements.testResultFilter.value !== 'all' || getVisibleImages().some(image => image.id === imageId)) renderList();
        else updateTestScopeButton();
    }

    /**
     * PNG・JPG・GIF・MP4を並行して読み込み、最初に表示できた形式を採用する。
     * セッション番号を照合し、JSON切り替え前の結果が新しい一覧へ混入するのを防ぐ。
     * @param {GyazoImage} image
     * @param {number|null} runId 一括テストの識別子。個別テストの場合はnull
     * @returns {Promise<'available'|'unavailable'|'timeout'|'cancelled'>}
     */
    function performDisplayTest(image, runId) {
        const previous = state.activeTestRequests.get(image.id);
        if (previous) previous.cancel();
        const requestId = ++state.requestSequence;
        const requestSession = state.sessionVersion;
        state.testingImageIds.add(image.id);
        refreshDisplayTestUi(image.id);

        return new Promise(resolve => {
            const loaders = [];
            const testUrls = Object.fromEntries(DISPLAY_FORMATS.map(format => [format, getDisplayImageUrl(image.id, format, true)]));
            let errorCount = 0;
            let settled = false;
            let timer;
            const finish = (outcome, format, shouldSave) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                loaders.forEach(({ element, isVideo }) => {
                    element.onload = null;
                    element.onerror = null;
                    element.onloadedmetadata = null;
                    if (outcome === 'available' || outcome === 'cancelled' || outcome === 'timeout') {
                        if (isVideo) {
                            element.removeAttribute('src');
                            element.load();
                        } else {
                            element.src = '';
                        }
                    }
                });
                const active = state.activeTestRequests.get(image.id);
                if (active && active.requestId === requestId) {
                    state.activeTestRequests.delete(image.id);
                    state.testingImageIds.delete(image.id);
                }
                const isCurrent = requestSession === state.sessionVersion && state.images.some(item => item.id === image.id);
                if (shouldSave && isCurrent) {
                    state.displayTestResults[image.id] = { result: outcome, testedAt: new Date().toISOString() };
                    if (format) state.displayTestResults[image.id].format = format;
                    if (outcome === 'available') state.displayPreviewUrls[image.id] = testUrls[format];
                    else delete state.displayPreviewUrls[image.id];
                    saveDisplayTestResults();
                }
                if (isCurrent) refreshDisplayTestUi(image.id);
                resolve(outcome);
            };
            const cancel = () => {
                finish('cancelled', null, false);
            };
            state.activeTestRequests.set(image.id, { requestId, runId, cancel });
            DISPLAY_FORMATS.forEach(format => {
                const isVideo = format === 'mp4';
                const loader = isVideo ? document.createElement('video') : new Image();
                loaders.push({ element: loader, isVideo });
                if (isVideo) {
                    loader.preload = 'metadata';
                    loader.muted = true;
                    loader.playsInline = true;
                    loader.onloadedmetadata = () => finish('available', format, true);
                } else {
                    loader.onload = () => finish('available', format, true);
                }
                loader.onerror = () => {
                    errorCount += 1;
                    if (errorCount === DISPLAY_FORMATS.length) finish('unavailable', null, true);
                };
                loader.src = testUrls[format];
            });
            timer = setTimeout(() => finish('timeout', null, true), TEST_TIMEOUT_MS);
        });
    }
    function runSingleDisplayTest(image) {
        performDisplayTest(image, null);
    }
    function updateBatchProgress(run) {
        elements.testProgressBar.max = Math.max(run.total, 1);
        elements.testProgressBar.value = run.completed;
        elements.testProgressText.textContent = `${run.completed} / ${run.total}件（表示できた ${run.counts.available}、表示できない ${run.counts.unavailable}、時間切れ ${run.counts.timeout}）`;
    }
    function setBatchControls(isRunning) {
        elements.testScope.disabled = isRunning;
        elements.startDisplayTest.disabled = isRunning;
        elements.stopDisplayTest.disabled = !isRunning;
        elements.stopDisplayTest.classList.toggle('d-none', !isRunning);
        if (!isRunning) updateTestScopeButton();
    }

    /** 同時実行数を制限したワーカーで、選択範囲を順番に表示テストする。 */
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
            counts: { available: 0, unavailable: 0, timeout: 0 }
        };
        state.batchRun = run;
        elements.testProgress.classList.remove('d-none');
        setBatchControls(true);
        renderList();
        updateBatchProgress(run);
        const worker = async () => {
            while (!run.stopped && run.nextIndex < run.total) {
                const image = run.targets[run.nextIndex];
                run.nextIndex += 1;
                const outcome = await performDisplayTest(image, run.id);
                if (run.stopped) return;
                if (DISPLAY_RESULT[outcome]) {
                    run.completed += 1;
                    run.counts[outcome] += 1;
                    updateBatchProgress(run);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, run.total) }, () => worker()));
        if (state.batchRun !== run) return;
        state.batchRun = null;
        setBatchControls(false);
        renderList();
        elements.testProgressText.textContent = `完了: ${run.completed} / ${run.total}件（表示できた ${run.counts.available}、表示できない ${run.counts.unavailable}、時間切れ ${run.counts.timeout}）`;
    }
    function stopBatchDisplayTest() {
        const run = state.batchRun;
        if (!run) return;
        run.stopped = true;
        state.activeTestRequests.forEach(request => { if (request.runId === run.id) request.cancel(); });
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
        Object.assign(state, {
            currentProject: data.name,
            images: extracted,
            displayTestResults: loadDisplayTestResults(data.name, new Set(extracted.map(image => image.id))),
            displayPreviewUrls: {},
            currentPage: 1
        });
        elements.projectHeading.textContent = data.displayName || data.name; elements.search.value = ''; elements.testResultFilter.value = 'all'; elements.workspace.classList.remove('d-none');
        elements.inputSummary.textContent = `${state.images.length}件のGyazo画像を読み込み済み`;
        updateDisplayTestSummary(); renderList(); showMessage(`${state.images.length}件のGyazo画像を読み込みました。`, 'success'); setInputCompact(true);
    }

    /**
     * 選択されたJSONファイルをブラウザ内で読み込み、解析する。
     * @param {File|undefined} file
     * @returns {Promise<void>}
     */
    async function handleFile(file) {
        clearMessage(); elements.workspace.classList.add('d-none'); if (!file) return;
        setInputCompact(false);
        invalidateDisplayTests();
        if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') { showMessage('JSONファイルを選択してください。', 'danger'); return; }
        try {
            const text = await file.text(); let data;
            try { data = JSON.parse(text); } catch (error) { throw new Error('JSONを解析できませんでした。ファイルが壊れていないか確認してください。'); }
            loadExport(data);
        } catch (error) { showMessage(error instanceof Error ? error.message : 'ファイルの読み込みに失敗しました。', 'danger'); }
        finally { elements.fileInput.value = ''; }
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    function csvEscape(value) { return `"${String(value).replace(/"/g, '""')}"`; }

    /** 表示テスト結果をExcelで開きやすいBOM付きUTF-8のCSVとして保存する。 */
    function exportCsv() {
        const rows = state.images.map(image => {
            const testResult = state.displayTestResults[image.id];
            return [image.id, image.url, testResult ? DISPLAY_RESULT[testResult.result] : '未判定', testResult ? testResult.testedAt : '', Array.from(new Set(image.sources.map(source => source.pageTitle))).join(' / ')];
        });
        const csv = '\uFEFF' + [['画像ID', '確認用URL', '表示テスト結果', '検査日時', '掲載元ページ'], ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `gyazo-review-${state.currentProject.replace(/[\\/:*?"<>|]/g, '_')}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }
    elements.fileInput.addEventListener('change', event => handleFile(event.target.files[0]));
    elements.chooseAnotherFile.addEventListener('click', () => elements.fileInput.click());
    elements.dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); } });
    ['dragenter', 'dragover'].forEach(type => elements.dropZone.addEventListener(type, event => { event.preventDefault(); elements.dropZone.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach(type => elements.dropZone.addEventListener(type, event => { event.preventDefault(); elements.dropZone.classList.remove('is-dragging'); }));
    elements.dropZone.addEventListener('drop', event => handleFile(event.dataTransfer.files[0]));
    function resetPageAndRender() { state.currentPage = 1; renderList(); }
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
    function moveToFirstPage() { state.currentPage = 1; renderList(); }
    function moveToPreviousPage() { if (state.currentPage > 1) { state.currentPage -= 1; renderList(); } }
    function moveToNextPage() { state.currentPage += 1; renderList(); }
    function moveToLastPage() {
        const filteredCount = getFilteredImages().length;
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filteredCount, 1) : Number(elements.pageSize.value);
        state.currentPage = Math.max(Math.ceil(filteredCount / pageSize), 1);
        renderList();
    }
    [elements.topFirstPage, elements.firstPage].forEach(button => button.addEventListener('click', moveToFirstPage));
    [elements.topPreviousPage, elements.previousPage].forEach(button => button.addEventListener('click', moveToPreviousPage));
    [elements.topNextPage, elements.nextPage].forEach(button => button.addEventListener('click', moveToNextPage));
    [elements.topLastPage, elements.lastPage].forEach(button => button.addEventListener('click', moveToLastPage));
    elements.exportCsv.addEventListener('click', exportCsv);
    window.CosenseGyazoReview = Object.freeze({ extractImages, validateExport, getCosensePageUrl, csvEscape });
}());
