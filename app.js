(function () {
    'use strict';

    const STATUS = Object.freeze({ unchecked: '未確認', completed: '完了', pending: '保留', excluded: '対象外' });
    const DISPLAY_RESULT = Object.freeze({ available: '表示できた', unavailable: '表示できない', timeout: '時間切れ' });
    const STORAGE_PREFIX = 'cosense-gyazo-review:v1:';
    const TEST_STORAGE_PREFIX = 'cosense-gyazo-review:display-tests:v1:';
    const TEST_TIMEOUT_MS = 12000;
    const TEST_CONCURRENCY = 3;
    const GYAZO_PATTERN = /https?:\/\/(?:i\.)?gyazo\.com\/([a-f0-9]{32})(?![a-f0-9])(?:\.[a-z0-9]+)?(?:[?#][^\s\]\[<>"']*)?/gi;
    const elements = {
        fileInput: document.getElementById('file-input'), dropZone: document.getElementById('drop-zone'),
        message: document.getElementById('message'), workspace: document.getElementById('workspace'),
        projectHeading: document.getElementById('project-heading'), imageList: document.getElementById('image-list'),
        emptyFilter: document.getElementById('empty-filter'), search: document.getElementById('search'),
        statusFilter: document.getElementById('status-filter'), pageSize: document.getElementById('page-size'),
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
        counts: Object.fromEntries(['total', ...Object.keys(STATUS)].map(key => [key, document.getElementById(`count-${key}`)]))
    };
    let currentProject = null;
    let images = [];
    let progress = {};
    let displayTestResults = {};
    let displayPreviewUrls = {};
    let currentPage = 1;
    let sessionVersion = 0;
    let requestSequence = 0;
    let batchSequence = 0;
    let batchRun = null;
    const activeTestRequests = new Map();
    const testingImageIds = new Set();

    function showMessage(text, type) {
        elements.message.textContent = text;
        elements.message.className = `alert alert-${type} mt-3 mb-0`;
    }
    function clearMessage() {
        elements.message.textContent = '';
        elements.message.className = 'alert mt-3 mb-0 d-none';
    }
    function validateExport(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSONの最上位がオブジェクトではありません。Cosenseのプロジェクトエクスポートを選択してください。');
        if (typeof data.name !== 'string' || data.name.trim() === '') throw new Error('プロジェクト名（name）が見つかりません。Cosenseの通常のエクスポート形式か確認してください。');
        if (!Array.isArray(data.pages)) throw new Error('pages配列が見つかりません。Cosenseの通常のエクスポート形式か確認してください。');
        if (data.pages.some(page => !page || typeof page.title !== 'string' || !Array.isArray(page.lines))) throw new Error('titleまたはlinesを持たないページがあります。エクスポート形式を確認してください。');
        const invalidLine = data.pages.some(page => page.lines.some(line => typeof line !== 'string' && (!line || typeof line.text !== 'string')));
        if (invalidLine) throw new Error('文字列またはtextを持つオブジェクトではない行があります。エクスポート形式を確認してください。');
    }
    function getCosensePageUrl(projectName, pageTitle) {
        return `https://scrapbox.io/${encodeURIComponent(projectName)}/${encodeURIComponent(pageTitle)}`;
    }
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
    function getStorageKey(projectName) { return `${STORAGE_PREFIX}${encodeURIComponent(projectName)}`; }
    function getTestStorageKey(projectName) { return `${TEST_STORAGE_PREFIX}${encodeURIComponent(projectName)}`; }
    function loadProgress(projectName) {
        try {
            const stored = JSON.parse(localStorage.getItem(getStorageKey(projectName)) || '{}');
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
            return Object.fromEntries(Object.entries(stored).filter(([id, status]) => /^[a-f0-9]{32}$/.test(id) && STATUS[status]));
        } catch (error) {
            showMessage('保存済みの進捗を読み込めなかったため、未確認の状態で表示します。', 'warning');
            return {};
        }
    }
    function saveProgress() {
        const minimal = {};
        images.forEach(image => { if (progress[image.id] && progress[image.id] !== 'unchecked') minimal[image.id] = progress[image.id]; });
        try { localStorage.setItem(getStorageKey(currentProject), JSON.stringify(minimal)); }
        catch (error) { showMessage('進捗をブラウザに保存できませんでした。ブラウザの保存設定を確認してください。', 'warning'); }
    }
    function loadDisplayTestResults(projectName, validImageIds) {
        try {
            const stored = JSON.parse(localStorage.getItem(getTestStorageKey(projectName)) || '{}');
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
            return Object.fromEntries(Object.entries(stored).filter(([id, value]) =>
                validImageIds.has(id) && value && DISPLAY_RESULT[value.result] && typeof value.testedAt === 'string' &&
                (value.format === undefined || value.format === 'png' || value.format === 'jpg')
            ));
        } catch (error) {
            showMessage('保存済みの表示テスト結果を読み込めませんでした。表示結果は未判定として扱います。', 'warning');
            return {};
        }
    }
    function saveDisplayTestResults() {
        const minimal = {};
        images.forEach(image => {
            const value = displayTestResults[image.id];
            if (value && DISPLAY_RESULT[value.result]) {
                minimal[image.id] = { result: value.result, testedAt: value.testedAt };
                if (value.format) minimal[image.id].format = value.format;
            }
        });
        try { localStorage.setItem(getTestStorageKey(currentProject), JSON.stringify(minimal)); }
        catch (error) { showMessage('表示テスト結果をブラウザに保存できませんでした。ブラウザの保存設定を確認してください。', 'warning'); }
    }
    function getStatus(id) { return progress[id] || 'unchecked'; }
    function getDisplayImageUrl(id, format, cacheBust) {
        const base = `https://i.gyazo.com/${id}.${format}`;
        return cacheBust ? `${base}?cosense_gyazo_review=${Date.now()}-${requestSequence}` : base;
    }
    function formatTestedAt(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP');
    }
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
    function createDisplayTestElement(image) {
        const container = document.createElement('div');
        const result = displayTestResults[image.id];
        const isTesting = testingImageIds.has(image.id);
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
            const preview = document.createElement('img');
            preview.className = 'image-preview';
            preview.src = displayPreviewUrls[image.id] || getDisplayImageUrl(image.id, result.format || 'png', false);
            preview.alt = `${image.id} の表示テスト時点のプレビュー`;
            preview.loading = 'lazy';
            preview.decoding = 'async';
            preview.addEventListener('error', () => preview.remove());
            resultBox.append(preview);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-secondary mt-2';
        button.disabled = isTesting || Boolean(batchRun);
        button.textContent = isTesting ? 'テスト中…' : (batchRun ? '一括テスト中' : (result ? '再テスト' : '表示をテスト'));
        button.addEventListener('click', () => runSingleDisplayTest(image));
        container.append(resultBox, button);
        return container;
    }
    function createImageElement(image) {
        const article = document.createElement('article'); article.className = 'image-item'; article.dataset.imageId = image.id;
        const details = document.createElement('div');
        const idLabel = document.createElement('div'); idLabel.className = 'image-id'; idLabel.textContent = image.id; details.append(idLabel);
        const heading = document.createElement('div'); heading.className = 'small fw-semibold mt-3'; heading.textContent = `掲載元 ${image.sources.length}件`; details.append(heading);
        const list = document.createElement('ul'); list.className = 'source-list'; image.sources.forEach(source => list.append(createSourceElement(source))); details.append(list);
        const actions = document.createElement('div'); actions.className = 'item-actions';
        const open = document.createElement('a'); open.className = 'btn btn-outline-primary'; open.href = image.url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Gyazoで開く'; actions.append(open);
        actions.append(createDisplayTestElement(image));
        const label = document.createElement('label'); label.className = 'small fw-semibold'; label.textContent = '作業状況';
        const select = document.createElement('select'); select.className = 'form-select status-select mt-1'; select.dataset.status = getStatus(image.id); select.setAttribute('aria-label', `${image.id} の作業状況`);
        Object.entries(STATUS).forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === getStatus(image.id); select.append(option); });
        select.addEventListener('change', () => { progress[image.id] = select.value; select.dataset.status = select.value; saveProgress(); updateSummary(); if (elements.statusFilter.value !== 'all') renderList(); });
        label.append(select); actions.append(label); article.append(details, actions);
        return article;
    }
    function getFilteredImages() {
        const query = elements.search.value.trim().toLocaleLowerCase('ja');
        const status = elements.statusFilter.value;
        return images.filter(image => {
            if (status !== 'all' && getStatus(image.id) !== status) return false;
            if (!query) return true;
            return [image.id, ...image.sources.flatMap(source => [source.pageTitle, source.lineText])].join('\n').toLocaleLowerCase('ja').includes(query);
        });
    }
    function getVisibleImages(filteredImages) {
        const filtered = filteredImages || getFilteredImages();
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filtered.length, 1) : Number(elements.pageSize.value);
        const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
        const page = Math.min(currentPage, totalPages);
        const start = (page - 1) * pageSize;
        return filtered.slice(start, start + pageSize);
    }
    function getBatchTargets() {
        if (elements.testScope.value === 'all') return images.slice();
        const filtered = getFilteredImages();
        return elements.testScope.value === 'filtered' ? filtered : getVisibleImages(filtered);
    }
    function updateTestScopeButton() {
        if (batchRun) return;
        const count = getBatchTargets().length;
        elements.startDisplayTest.textContent = `対象${count}件を順次テスト`;
        elements.startDisplayTest.disabled = count === 0;
    }
    function renderList() {
        const filtered = getFilteredImages();
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filtered.length, 1) : Number(elements.pageSize.value);
        const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
        currentPage = Math.min(currentPage, totalPages);
        const start = (currentPage - 1) * pageSize;
        const visible = getVisibleImages(filtered);
        const fragment = document.createDocumentFragment(); visible.forEach(image => fragment.append(createImageElement(image)));
        elements.imageList.replaceChildren(fragment);
        elements.emptyFilter.classList.toggle('d-none', filtered.length !== 0);
        elements.visibleCount.textContent = filtered.length === 0 ? `0 / ${images.length}件` : `${start + 1}〜${start + visible.length} / ${filtered.length}件`;
        const hidePagination = filtered.length === 0 || elements.pageSize.value === 'all';
        [elements.topPagination, elements.bottomPagination].forEach(pagination => pagination.classList.toggle('d-none', hidePagination));
        [elements.topPageInfo, elements.pageInfo].forEach(info => { info.textContent = `${currentPage} / ${totalPages}ページ`; });
        [elements.topFirstPage, elements.firstPage, elements.topPreviousPage, elements.previousPage].forEach(button => { button.disabled = currentPage === 1; });
        [elements.topNextPage, elements.nextPage, elements.topLastPage, elements.lastPage].forEach(button => { button.disabled = currentPage === totalPages; });
        updateTestScopeButton();
    }
    function updateSummary() {
        const counts = { total: images.length, unchecked: 0, completed: 0, pending: 0, excluded: 0 };
        images.forEach(image => { counts[getStatus(image.id)] += 1; });
        Object.entries(counts).forEach(([key, value]) => { elements.counts[key].textContent = value; });
    }
    function updateDisplayTestSummary() {
        const counts = { untested: 0, available: 0, unavailable: 0, timeout: 0 };
        images.forEach(image => {
            const result = displayTestResults[image.id];
            counts[result && DISPLAY_RESULT[result.result] ? result.result : 'untested'] += 1;
        });
        Object.entries(counts).forEach(([key, value]) => { elements.testCounts[key].textContent = value; });
    }
    function refreshDisplayTestUi(imageId) {
        updateDisplayTestSummary();
        if (getVisibleImages().some(image => image.id === imageId)) renderList();
        else updateTestScopeButton();
    }
    function performDisplayTest(image, runId) {
        const previous = activeTestRequests.get(image.id);
        if (previous) previous.cancel();
        const requestId = ++requestSequence;
        const requestSession = sessionVersion;
        testingImageIds.add(image.id);
        refreshDisplayTestUi(image.id);

        return new Promise(resolve => {
            const formats = ['png', 'jpg'];
            const loaders = [];
            const testUrls = Object.fromEntries(formats.map(format => [format, getDisplayImageUrl(image.id, format, true)]));
            let errorCount = 0;
            let settled = false;
            let timer;
            const finish = (outcome, format, shouldSave) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                loaders.forEach(loader => {
                    loader.onload = null;
                    loader.onerror = null;
                    if (outcome === 'available' || outcome === 'cancelled') loader.src = '';
                });
                const active = activeTestRequests.get(image.id);
                if (active && active.requestId === requestId) {
                    activeTestRequests.delete(image.id);
                    testingImageIds.delete(image.id);
                }
                const isCurrent = requestSession === sessionVersion && images.some(item => item.id === image.id);
                if (shouldSave && isCurrent) {
                    displayTestResults[image.id] = { result: outcome, testedAt: new Date().toISOString() };
                    if (format) displayTestResults[image.id].format = format;
                    if (outcome === 'available') displayPreviewUrls[image.id] = testUrls[format];
                    else delete displayPreviewUrls[image.id];
                    saveDisplayTestResults();
                }
                if (isCurrent) refreshDisplayTestUi(image.id);
                resolve(outcome);
            };
            const cancel = () => {
                finish('cancelled', null, false);
            };
            activeTestRequests.set(image.id, { requestId, runId, cancel });
            formats.forEach(format => {
                const loader = new Image();
                loaders.push(loader);
                loader.onload = () => finish('available', format, true);
                loader.onerror = () => {
                    errorCount += 1;
                    if (errorCount === formats.length) finish('unavailable', null, true);
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
        if (!isRunning) updateTestScopeButton();
    }
    async function startBatchDisplayTest() {
        if (batchRun) return;
        const targets = getBatchTargets();
        if (targets.length === 0) return;
        const run = {
            id: ++batchSequence,
            targets,
            total: targets.length,
            nextIndex: 0,
            completed: 0,
            stopped: false,
            counts: { available: 0, unavailable: 0, timeout: 0 }
        };
        batchRun = run;
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
        if (batchRun !== run) return;
        batchRun = null;
        setBatchControls(false);
        renderList();
        elements.testProgressText.textContent = `完了: ${run.completed} / ${run.total}件（表示できた ${run.counts.available}、表示できない ${run.counts.unavailable}、時間切れ ${run.counts.timeout}）`;
    }
    function stopBatchDisplayTest() {
        const run = batchRun;
        if (!run) return;
        run.stopped = true;
        activeTestRequests.forEach(request => { if (request.runId === run.id) request.cancel(); });
        batchRun = null;
        setBatchControls(false);
        renderList();
        elements.testProgressText.textContent = `停止しました: ${run.completed} / ${run.total}件を完了`;
    }
    function invalidateDisplayTests() {
        sessionVersion += 1;
        if (batchRun) batchRun.stopped = true;
        activeTestRequests.forEach(request => request.cancel());
        activeTestRequests.clear();
        testingImageIds.clear();
        batchRun = null;
        elements.testProgress.classList.add('d-none');
        setBatchControls(false);
    }
    function loadExport(data) {
        validateExport(data);
        const extracted = extractImages(data);
        if (extracted.length === 0) throw new Error('有効なGyazo画像URLが見つかりませんでした。32桁の画像IDを含むURLがあるか確認してください。');
        currentProject = data.name; images = extracted; progress = loadProgress(currentProject);
        displayTestResults = loadDisplayTestResults(currentProject, new Set(images.map(image => image.id)));
        displayPreviewUrls = {};
        currentPage = 1; elements.projectHeading.textContent = data.displayName || data.name; elements.search.value = ''; elements.statusFilter.value = 'all'; elements.workspace.classList.remove('d-none');
        updateSummary(); updateDisplayTestSummary(); renderList(); showMessage(`${images.length}件のGyazo画像を読み込みました。`, 'success');
    }
    async function handleFile(file) {
        clearMessage(); elements.workspace.classList.add('d-none'); if (!file) return;
        invalidateDisplayTests();
        if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') { showMessage('JSONファイルを選択してください。', 'danger'); return; }
        try {
            const text = await file.text(); let data;
            try { data = JSON.parse(text); } catch (error) { throw new Error('JSONを解析できませんでした。ファイルが壊れていないか確認してください。'); }
            loadExport(data);
        } catch (error) { showMessage(error instanceof Error ? error.message : 'ファイルの読み込みに失敗しました。', 'danger'); }
        finally { elements.fileInput.value = ''; }
    }
    function csvEscape(value) { return `"${String(value).replace(/"/g, '""')}"`; }
    function exportCsv() {
        const rows = images.map(image => {
            const testResult = displayTestResults[image.id];
            return [image.id, image.url, STATUS[getStatus(image.id)], testResult ? DISPLAY_RESULT[testResult.result] : '未判定', testResult ? testResult.testedAt : '', Array.from(new Set(image.sources.map(source => source.pageTitle))).join(' / ')];
        });
        const csv = '\uFEFF' + [['画像ID', '確認用URL', '作業状況', '表示テスト結果', '検査日時', '掲載元ページ'], ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `gyazo-review-${currentProject.replace(/[\\/:*?"<>|]/g, '_')}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }
    elements.fileInput.addEventListener('change', event => handleFile(event.target.files[0]));
    elements.dropZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); } });
    ['dragenter', 'dragover'].forEach(type => elements.dropZone.addEventListener(type, event => { event.preventDefault(); elements.dropZone.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach(type => elements.dropZone.addEventListener(type, event => { event.preventDefault(); elements.dropZone.classList.remove('is-dragging'); }));
    elements.dropZone.addEventListener('drop', event => handleFile(event.dataTransfer.files[0]));
    function resetPageAndRender() { currentPage = 1; renderList(); }
    elements.search.addEventListener('input', resetPageAndRender);
    elements.statusFilter.addEventListener('change', resetPageAndRender);
    elements.pageSize.addEventListener('change', resetPageAndRender);
    elements.testScope.addEventListener('change', updateTestScopeButton);
    elements.startDisplayTest.addEventListener('click', startBatchDisplayTest);
    elements.stopDisplayTest.addEventListener('click', stopBatchDisplayTest);
    function moveToFirstPage() { currentPage = 1; renderList(); }
    function moveToPreviousPage() { if (currentPage > 1) { currentPage -= 1; renderList(); } }
    function moveToNextPage() { currentPage += 1; renderList(); }
    function moveToLastPage() {
        const filteredCount = getFilteredImages().length;
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filteredCount, 1) : Number(elements.pageSize.value);
        currentPage = Math.max(Math.ceil(filteredCount / pageSize), 1);
        renderList();
    }
    [elements.topFirstPage, elements.firstPage].forEach(button => button.addEventListener('click', moveToFirstPage));
    [elements.topPreviousPage, elements.previousPage].forEach(button => button.addEventListener('click', moveToPreviousPage));
    [elements.topNextPage, elements.nextPage].forEach(button => button.addEventListener('click', moveToNextPage));
    [elements.topLastPage, elements.lastPage].forEach(button => button.addEventListener('click', moveToLastPage));
    elements.exportCsv.addEventListener('click', exportCsv);
    window.CosenseGyazoReview = Object.freeze({ extractImages, validateExport, getCosensePageUrl, csvEscape });
}());
