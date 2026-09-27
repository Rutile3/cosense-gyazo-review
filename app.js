(function () {
    'use strict';

    const STATUS = Object.freeze({ unchecked: '未確認', completed: '完了', pending: '保留', excluded: '対象外' });
    const STORAGE_PREFIX = 'cosense-gyazo-review:v1:';
    const GYAZO_PATTERN = /https?:\/\/(?:i\.)?gyazo\.com\/([a-f0-9]{32})(?![a-f0-9])(?:\.[a-z0-9]+)?(?:[?#][^\s\]\[<>"']*)?/gi;
    const elements = {
        fileInput: document.getElementById('file-input'), dropZone: document.getElementById('drop-zone'),
        message: document.getElementById('message'), workspace: document.getElementById('workspace'),
        projectHeading: document.getElementById('project-heading'), imageList: document.getElementById('image-list'),
        emptyFilter: document.getElementById('empty-filter'), search: document.getElementById('search'),
        statusFilter: document.getElementById('status-filter'), pageSize: document.getElementById('page-size'),
        pagination: document.getElementById('pagination'), previousPage: document.getElementById('previous-page'),
        nextPage: document.getElementById('next-page'), pageInfo: document.getElementById('page-info'), openNext: document.getElementById('open-next'),
        exportCsv: document.getElementById('export-csv'), visibleCount: document.getElementById('visible-count'),
        counts: Object.fromEntries(['total', ...Object.keys(STATUS)].map(key => [key, document.getElementById(`count-${key}`)]))
    };
    let currentProject = null;
    let images = [];
    let progress = {};
    let currentPage = 1;

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
    function getStatus(id) { return progress[id] || 'unchecked'; }
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
    function createImageElement(image) {
        const article = document.createElement('article'); article.className = 'image-item';
        const details = document.createElement('div');
        const idLabel = document.createElement('div'); idLabel.className = 'image-id'; idLabel.textContent = image.id; details.append(idLabel);
        const heading = document.createElement('div'); heading.className = 'small fw-semibold mt-3'; heading.textContent = `掲載元 ${image.sources.length}件`; details.append(heading);
        const list = document.createElement('ul'); list.className = 'source-list'; image.sources.forEach(source => list.append(createSourceElement(source))); details.append(list);
        const actions = document.createElement('div'); actions.className = 'item-actions';
        const open = document.createElement('a'); open.className = 'btn btn-outline-primary'; open.href = image.url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Gyazoで開く'; actions.append(open);
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
    function renderList() {
        const filtered = getFilteredImages();
        const pageSize = elements.pageSize.value === 'all' ? Math.max(filtered.length, 1) : Number(elements.pageSize.value);
        const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
        currentPage = Math.min(currentPage, totalPages);
        const start = (currentPage - 1) * pageSize;
        const visible = filtered.slice(start, start + pageSize);
        const fragment = document.createDocumentFragment(); visible.forEach(image => fragment.append(createImageElement(image)));
        elements.imageList.replaceChildren(fragment);
        elements.emptyFilter.classList.toggle('d-none', filtered.length !== 0);
        elements.visibleCount.textContent = filtered.length === 0 ? `0 / ${images.length}件` : `${start + 1}〜${start + visible.length} / ${filtered.length}件`;
        elements.pagination.classList.toggle('d-none', filtered.length === 0 || elements.pageSize.value === 'all');
        elements.pageInfo.textContent = `${currentPage} / ${totalPages}ページ`;
        elements.previousPage.disabled = currentPage === 1;
        elements.nextPage.disabled = currentPage === totalPages;
    }
    function updateSummary() {
        const counts = { total: images.length, unchecked: 0, completed: 0, pending: 0, excluded: 0 };
        images.forEach(image => { counts[getStatus(image.id)] += 1; });
        Object.entries(counts).forEach(([key, value]) => { elements.counts[key].textContent = value; });
        elements.openNext.disabled = counts.unchecked === 0; elements.openNext.textContent = counts.unchecked === 0 ? '未確認はありません' : '次の未確認を開く';
    }
    function loadExport(data) {
        validateExport(data);
        const extracted = extractImages(data);
        if (extracted.length === 0) throw new Error('有効なGyazo画像URLが見つかりませんでした。32桁の画像IDを含むURLがあるか確認してください。');
        currentProject = data.name; images = extracted; progress = loadProgress(currentProject);
        currentPage = 1; elements.projectHeading.textContent = data.displayName || data.name; elements.search.value = ''; elements.statusFilter.value = 'all'; elements.workspace.classList.remove('d-none');
        updateSummary(); renderList(); showMessage(`${images.length}件のGyazo画像を読み込みました。`, 'success');
    }
    async function handleFile(file) {
        clearMessage(); elements.workspace.classList.add('d-none'); if (!file) return;
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
        const rows = images.map(image => [image.id, image.url, STATUS[getStatus(image.id)], Array.from(new Set(image.sources.map(source => source.pageTitle))).join(' / ')]);
        const csv = '\uFEFF' + [['画像ID', '確認用URL', '状況', '掲載元ページ'], ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
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
    elements.previousPage.addEventListener('click', () => { if (currentPage > 1) { currentPage -= 1; renderList(); } });
    elements.nextPage.addEventListener('click', () => { currentPage += 1; renderList(); });
    elements.openNext.addEventListener('click', () => { const next = images.find(image => getStatus(image.id) === 'unchecked'); if (next) window.open(next.url, '_blank', 'noopener,noreferrer'); });
    elements.exportCsv.addEventListener('click', exportCsv);
    window.CosenseGyazoReview = Object.freeze({ extractImages, validateExport, getCosensePageUrl, csvEscape });
}());
