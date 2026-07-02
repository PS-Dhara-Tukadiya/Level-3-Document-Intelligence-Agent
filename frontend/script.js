const API_BASE = 'http://localhost:3000';
const API_KEY = 'dev-key-123'; // from your .env API_KEYS

let sessionId = 'session-' + Date.now(); // unique session per page load

// In-memory list of documents currently loaded on the server for this session.
// Each entry: { id, filename, charCount, selected }
let documents = [];

const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    'X-Session-Id': sessionId
};

// ── File handling ──────────────────────────────────────────────────────────

function handleDrop(e) {
    e.preventDefault();
    document.getElementById('uploadZone').classList.remove('drag');
    handleFiles(e.dataTransfer.files);
}

const ALLOWED_DOC_TYPES = ['application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const validDocs = [];
    const validImages = [];
    for (const file of files) {
        const isImage = ALLOWED_IMAGE_TYPES.includes(file.type) || file.name.match(/\.(png|jpe?g|webp|gif)$/i);
        const isDoc = ALLOWED_DOC_TYPES.includes(file.type) || file.name.match(/\.(txt|pdf|docx)$/i);

        if (isImage) {
            validImages.push(file);
        } else if (isDoc) {
            validDocs.push(file);
        } else {
            showUploadError(`Skipped "${file.name}": only PDF, DOCX, TXT, and pictures (PNG/JPG/WEBP/GIF) are supported.`);
        }
    }
    if (validDocs.length === 0 && validImages.length === 0) return;

    setUploadState('uploading');

    // Upload files one at a time so a single failure doesn't block the rest.
    let uploadedCount = 0;

    for (const file of validDocs) {
        try {
            const content = await readFileAsText(file);

            const res = await fetch(`${API_BASE}/api/documents`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ content, filename: file.name })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error?.message || 'Upload failed');

            documents.push({ id: data.document.id, filename: data.document.filename, type: 'text', charCount: data.document.charCount, selected: true });
            uploadedCount++;
        } catch (err) {
            showUploadError(`"${file.name}": ${err.message}`);
        }
    }

    for (const file of validImages) {
        try {
            const { base64, dataUrl } = await readFileAsBase64(file);

            const res = await fetch(`${API_BASE}/api/images`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ data: base64, mediaType: file.type || guessMediaType(file.name), filename: file.name })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error?.message || 'Upload failed');

            documents.push({ id: data.document.id, filename: data.document.filename, type: 'image', sizeBytes: data.document.sizeBytes, thumbnail: dataUrl, selected: true });
            uploadedCount++;
        } catch (err) {
            showUploadError(`"${file.name}": ${err.message}`);
        }
    }

    renderFileList();
    setUploadState(documents.length > 0 ? 'done' : 'idle');
    if (uploadedCount > 0) advanceStep(1);

    // Reset the input so selecting the same file again still fires onchange
    document.getElementById('fileInput').value = '';
}

function guessMediaType(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'image/png';
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result; // "data:image/png;base64,AAAA..."
            const base64 = String(dataUrl).split(',')[1] || '';
            resolve({ base64, dataUrl });
        };
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.readAsDataURL(file);
    });
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        // PDF: extract raw text (basic — works for text-based PDFs)
        if (file.type === 'application/pdf') {
            reader.onload = async (e) => {
                try {
                    // Load pdf.js from CDN
                    if (!window.pdfjsLib) {
                        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
                        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    }
                    const typedArray = new Uint8Array(e.target.result);
                    const pdf = await pdfjsLib.getDocument(typedArray).promise;
                    let text = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const content = await page.getTextContent();
                        text += content.items.map(item => item.str).join(' ') + '\n';
                    }
                    resolve(text);
                } catch (err) {
                    reject(new Error('Could not parse PDF: ' + err.message));
                }
            };
            reader.readAsArrayBuffer(file);

        } else {
            // TXT or DOCX (basic text read)
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        }
    });
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ── Document list UI ────────────────────────────────────────────────────────

function renderFileList() {
    const listEl = document.getElementById('fileList');
    listEl.innerHTML = '';

    documents.forEach(doc => {
        const pill = document.createElement('div');
        pill.className = 'file-pill-row' + (doc.selected ? ' selected' : '');

        const icon = doc.type === 'image'
            ? (doc.thumbnail
                ? `<img class="fp-thumb" src="${doc.thumbnail}" alt="">`
                : '<i class="ti ti-photo"></i>')
            : '<i class="ti ti-file-description"></i>';

        const meta = doc.type === 'image' ? formatBytes(doc.sizeBytes) : formatChars(doc.charCount);

        pill.innerHTML = `
            <input type="checkbox" class="fp-checkbox" ${doc.selected ? 'checked' : ''}
                onchange="toggleDocSelected('${doc.id}', this.checked)">
            ${icon}
            <span class="fp-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</span>
            <span class="fp-meta">${meta}</span>
            <span class="fp-remove" onclick="removeFile('${doc.id}')"><i class="ti ti-x"></i></span>
        `;
        listEl.appendChild(pill);
    });

    updateAskScope();
}

function toggleDocSelected(id, checked) {
    const doc = documents.find(d => d.id === id);
    if (doc) doc.selected = checked;
    document.querySelectorAll('.file-pill-row').forEach((el, i) => {
        el.classList.toggle('selected', documents[i]?.selected);
    });
    updateAskScope();
}

function updateAskScope() {
    const scopeEl = document.getElementById('askScope');
    const total = documents.length;
    const selected = documents.filter(d => d.selected).length;
    if (total === 0) {
        scopeEl.textContent = '';
    } else if (selected === total) {
        scopeEl.textContent = `(across all ${total} document${total > 1 ? 's' : ''})`;
    } else {
        scopeEl.textContent = `(across ${selected} of ${total} documents)`;
    }
}

async function removeFile(id) {
    try {
        const res = await fetch(`${API_BASE}/api/documents/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to remove document');
    } catch (err) {
        showUploadError(err.message);
    }

    documents = documents.filter(d => d.id !== id);
    renderFileList();

    if (documents.length === 0) {
        setUploadState('idle');
        resetSteps();
    }
}

function formatChars(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
    return `${n} chars`;
}

function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Ask question ───────────────────────────────────────────────────────────

async function askQuestion() {
    const q = document.getElementById('question').value.trim();
    if (!q) return;

    if (documents.length === 0) {
        showUploadError('Please upload at least one document or picture first.');
        return;
    }

    const selectedIds = documents.filter(d => d.selected).map(d => d.id);
    if (selectedIds.length === 0) {
        showUploadError('Select at least one document to ask about.');
        return;
    }

    const btn = document.getElementById('askBtn');
    btn.classList.add('loading');
    btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> Thinking...';
    btn.disabled = true;

    const card = document.getElementById('resultCard');
    const res  = document.getElementById('result');
    card.style.display = 'block';
    res.innerHTML = '<div class="dot-loader"><span></span><span></span><span></span></div>';

    advanceStep(2);

    try {
        const response = await fetch(`${API_BASE}/api/ask`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ question: q, documentIds: selectedIds })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'Request failed');
        }

        res.textContent = data.answer;
        advanceStep(3);

    } catch (err) {
        res.textContent = '⚠️ Error: ' + err.message;
    } finally {
        btn.classList.remove('loading');
        btn.innerHTML = '<i class="ti ti-sparkles"></i> Ask AI';
        btn.disabled = false;
    }
}

// ── Utility ────────────────────────────────────────────────────────────────

function updateChar() {
    const len = document.getElementById('question').value.length;
    document.getElementById('charCount').textContent = len + ' / 500';
}

function setChip(text) {
    document.getElementById('question').value = text;
    updateChar();
    document.getElementById('question').focus();
}

function showUploadError(msg) {
    const el = document.getElementById('uploadError');
    el.textContent = '⚠️ ' + msg;
    el.style.display = 'block';
}

function setUploadState(state) {
    const zone = document.getElementById('uploadZone');
    const label = document.getElementById('uzLabel');
    const hint = document.getElementById('uzHint');
    const icon = document.getElementById('uzIcon');

    if (state === 'uploading') {
        zone.style.opacity = '0.7';
        icon.className = 'ti ti-loader-2 spin';
        label.textContent = 'Reading document(s) / picture(s)...';
        hint.textContent = 'Please wait';
    } else if (state === 'done') {
        zone.style.opacity = '1';
        icon.className = 'ti ti-circle-check';
        icon.style.color = '#22c55e';
        label.textContent = 'Drop more files here or click to add another';
        hint.textContent = `${documents.length} item${documents.length > 1 ? 's' : ''} loaded — ready to answer questions`;
    } else {
        zone.style.opacity = '1';
        icon.className = 'ti ti-cloud-upload';
        icon.style.color = '';
        label.textContent = 'Drop files here or click to browse';
        hint.textContent = 'PDF, DOCX, TXT, or pictures (PNG/JPG/WEBP/GIF) — multiple files supported';
    }
}

// ── Step indicators ────────────────────────────────────────────────────────

function advanceStep(step) {
    if (step >= 1) {
        const sd1 = document.getElementById('sd1');
        sd1.textContent = '✓';
        sd1.classList.remove('active');
        sd1.classList.add('done');
        document.getElementById('sl1').style.color = '#818cf8';
        document.getElementById('sl-1').classList.add('done');
        document.getElementById('sd2').classList.add('active');
        document.getElementById('sl2').classList.add('active');
    }
    if (step >= 2) {
        const sd2 = document.getElementById('sd2');
        sd2.textContent = '✓';
        sd2.classList.remove('active');
        sd2.classList.add('done');
        document.getElementById('sl2').style.color = '#818cf8';
        document.getElementById('sl-2').classList.add('done');
        document.getElementById('sd3').classList.add('active');
        document.getElementById('sl3').classList.add('active');
    }
    if (step >= 3) {
        const sd3 = document.getElementById('sd3');
        sd3.textContent = '✓';
        sd3.classList.remove('active');
        sd3.classList.add('done');
        document.getElementById('sl3').style.color = '#818cf8';
        document.getElementById('sl3').classList.remove('active');
    }
}

function resetSteps() {
    ['sd1','sd2','sd3'].forEach((id, i) => {
        const el = document.getElementById(id);
        el.textContent = i + 1;
        el.classList.remove('done','active');
    });
    document.getElementById('sd1').classList.add('active');
    document.getElementById('sl1').style.color = '';
    document.getElementById('sl2').style.color = '';
    document.getElementById('sl3').style.color = '';
    ['sl-1','sl-2'].forEach(id => document.getElementById(id).classList.remove('done'));
    ['sl2','sl3'].forEach(id => {
        document.getElementById(id).classList.remove('active');
        document.getElementById(id).style.color = '';
    });
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('uploadError').style.display = 'none';
}
