// API Configuration
const API_BASE = '/api';

// Application State
const state = {
    currentView: 'upload', // upload, investor, legal, pm, partner, chat
    selectedRole: 'Legal', // Investor, Legal, PM, Partner, HR
    contracts: [],
    currentContract: null,
    currentAnalysis: null,
    chatMessages: [],
    isLoading: false,
    extractedText: '',
    extractedTextError: '',
    showExtractedText: false,
    isExtractedTextLoading: false,
    highlightQuote: null, // Phase 3: citation quote to highlight in the extracted-text panel
    // Tab states for each view
    investorTab: 'insights', // insights, financial
    legalTab: 'analysis', // analysis, versioning
    pmTab: 'operational', // operational, actionItems, contract
};

// Tab switching functions
function switchInvestorTab(tab) {
    state.investorTab = tab;
    render();
}

function switchLegalTab(tab) {
    state.legalTab = tab;
    render();
}

function switchPMTab(tab) {
    state.pmTab = tab;
    render();
}

// Phase 2: toggles a pre-rendered source-snippet row without a full re-render
// (safe with the innerHTML render model — no state change, just a class flip).
function toggleSourceRow(id) {
    const el = document.getElementById(`src-${id}`);
    if (el) el.classList.toggle('hidden');
}


// Utility Functions
function createElement(tag, className = '', innerHTML = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function resetExtractedTextState() {
    state.extractedText = '';
    state.extractedTextError = '';
    state.showExtractedText = false;
    state.isExtractedTextLoading = false;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Phase 2: additive `calculations` field is absent on pre-Phase-2 analyses —
// both helpers below render nothing in that case so old data still displays.
function renderGroundingBadge(analysisObj) {
    const grounding = analysisObj?.calculations?.grounding;
    if (!grounding || grounding.total === 0) return '';
    if (grounding.rate === 1) {
        return sealBadge(`All ${grounding.total} verified in source`);
    }
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#B45309]/10 text-[#B45309] whitespace-nowrap">${grounding.grounded} of ${grounding.total} verified · ${grounding.dropped} rejected</span>`;
}

function renderLgdBreakdownText(analysisObj) {
    const lgd = analysisObj?.calculations?.lgd;
    if (!lgd) return '';
    if (!lgd.totalAmountOwed) {
        return 'Not computable — no verified payment obligation found in the contract';
    }
    const lossStr = '$' + new Intl.NumberFormat().format(lgd.totalPotentialLoss);
    const owedStr = '$' + new Intl.NumberFormat().format(lgd.totalAmountOwed);
    const pctStr = Number.isFinite(lgd.rawPct) ? `${lgd.rawPct.toFixed(1)}%` : `${lgd.result}%`;
    return `${lossStr} ÷ ${owedStr} = ${pctStr}`;
}

// Phase 5: honest-display helpers — every value shown across the four views
// must be either a real computed/verified number or one of these explicit
// "we don't know" states, never a raw `undefined`/`NaN` or a silent fabricated
// default. All accept null/undefined/empty freely (old persisted analyses and
// LLM-omitted fields both hit this path constantly).
const EMPTY_FIELD_TEXT = 'Not mentioned in the contract';

function displayField(value, fallback = EMPTY_FIELD_TEXT) {
    if (value === null || value === undefined || value === '') return escapeHtml(fallback);
    if (typeof value === 'number' && !Number.isFinite(value)) return escapeHtml(fallback);
    return escapeHtml(String(value));
}

function displayMoney(amount) {
    if (!Number.isFinite(amount)) return 'Not computable';
    return '$' + new Intl.NumberFormat().format(amount);
}

function riskLevelClasses(level) {
    const normalized = String(level || '').toLowerCase();
    if (normalized === 'high') return 'text-[#B3362B]';
    if (normalized === 'medium') return 'text-[#B45309]';
    if (normalized === 'low') return 'text-[#1E7F5C]';
    return 'text-muted';
}

// → { text, cls } for a complianceScore that may be a real 0-100 number or
// null/undefined ("not determined" — the honest state when the Legal LLM
// didn't return one; there is no more 84/64 guessed fallback on the backend).
function complianceDisplay(analysis) {
    const score = Number(analysis?.complianceScore);
    if (!Number.isFinite(score)) {
        return { text: 'Not determined', cls: 'text-muted' };
    }
    const cls = score >= 70
        ? 'text-[#1E7F5C]'
        : (score >= 40 ? 'text-[#B45309]' : 'text-[#B3362B]');
    return { text: `${score}%`, cls };
}

// Phase 6: the one card recipe used across every view — a formal, quiet
// surface with a hairline border. `extra` appends layout classes (padding,
// gap, border accents) without duplicating the base recipe everywhere.
function card(inner, extra = '') {
    return `<div class="bg-surface border border-line rounded-lg shadow-sm ${extra}">${inner}</div>`;
}

// 11px uppercase letterspaced label used above every data point (stat
// figures, section headers within cards) — keeps the "ledger" register consistent.
function sectionLabel(text) {
    return `<p class="text-[11px] font-semibold uppercase tracking-wider text-muted">${escapeHtml(text)}</p>`;
}

// The grounding seal — apply ONLY where the backend actually verified
// something (verifyMonetaryItems totals, verifyQuote citations, passing
// compliance checks). Everything else stays unsealed so this reads as real.
function sealBadge(text = 'Verified') {
    return `<span class="seal"><span class="material-symbols-outlined">verified</span>${escapeHtml(text)}</span>`;
}

// Demo-fidelity ledger row: a single risk/obligation/rate line with an
// optional inline source quote and a right-aligned amount. `critical` tints
// the row red; `amountClass` colors the figure ('crit' | 'navy' | 'muted').
function riskLedgerRow(item, { critical = false, amountClass = 'navy' } = {}) {
    const dup = item.possibleDuplicate
        ? '<span class="sev-chip caution" style="text-transform:none;letter-spacing:0">possible dup</span>'
        : '';
    const sev = critical ? '<span class="sev-chip crit">Risk</span>' : '';
    const meta = item.reason ? `<div class="rr-meta">${escapeHtml(item.reason)}</div>` : '';
    const quote = item.sourceContext ? `<div class="quote-block">"${escapeHtml(item.sourceContext)}"</div>` : '';
    const amtCls = amountClass === 'muted' ? '' : amountClass;
    return `
        <div class="risk-row ${critical ? 'crit' : ''}">
            <div class="rr-body">
                <div class="rr-title">${escapeHtml(item.raw)} ${sev} ${dup}</div>
                ${meta}
                ${quote}
            </div>
            <div class="rr-amt ${amtCls} figures">${displayMoney(Number(item.amount))}</div>
        </div>`;
}

async function loadExtractedText() {
    if (!state.currentContract || state.isExtractedTextLoading) return;
    state.isExtractedTextLoading = true;
    state.extractedTextError = '';
    render();

    const { status, data } = await getContractText(state.currentContract.id);
    if (status === 202) {
        state.extractedText = '';
        state.extractedTextError = data.message || 'Text extraction in progress.';
    } else if (status >= 400) {
        state.extractedText = '';
        state.extractedTextError = data.error || 'Failed to load extracted text.';
    } else {
        state.extractedText = data.text || '';
        state.extractedTextError = '';
    }

    state.isExtractedTextLoading = false;
    render();
}

function toggleExtractedText() {
    state.showExtractedText = !state.showExtractedText;
    if (!state.showExtractedText) {
        state.highlightQuote = null;
    }
    if (state.showExtractedText && !state.extractedText && !state.isExtractedTextLoading) {
        loadExtractedText();
        return;
    }
    render();
}

// Phase 3: client-side mirror of the server's verifyQuote normalizer — must
// stay behaviorally identical (lowercase, curly->straight quotes, collapse
// whitespace) so a citation verified server-side is always findable here.
function normalizeForQuoteMatch(str) {
    return String(str || '')
        .toLowerCase()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function buildNormalizedOffsetMap(text) {
    let normalized = '';
    const offsetMap = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (normalized.length === 0 || normalized[normalized.length - 1] !== ' ') {
                normalized += ' ';
                offsetMap.push(i);
            }
            while (i < text.length && /\s/.test(text[i])) i++;
            continue;
        }
        let c = ch.toLowerCase();
        if (c === '“' || c === '”') c = '"';
        if (c === '‘' || c === '’') c = "'";
        normalized += c;
        offsetMap.push(i);
        i++;
    }
    return { normalized, offsetMap };
}

function findNormalizedOffset(quote, text) {
    const normalizedQuote = normalizeForQuoteMatch(quote);
    if (!normalizedQuote) return null;
    const { normalized, offsetMap } = buildNormalizedOffsetMap(text);
    const idx = normalized.indexOf(normalizedQuote);
    if (idx === -1) return null;
    return { start: offsetMap[idx], end: offsetMap[idx + normalizedQuote.length - 1] + 1 };
}

function findQuoteOffsetWithFallback(quote, text) {
    if (!quote || !text) return null;
    let result = findNormalizedOffset(quote, text);
    if (result) return result;
    const words = String(quote).trim().split(/\s+/).filter(Boolean);
    if (words.length >= 8) {
        result = findNormalizedOffset(words.slice(0, 8).join(' '), text);
        if (result) return result;
    }
    return null;
}

// Phase 3: reveals a chat citation in the document panel — opens the
// extracted-text panel (loading it if needed) and highlights the quote.
async function revealCitation(msgIndex, citIndex) {
    const msg = state.chatMessages[msgIndex];
    const citation = msg && Array.isArray(msg.citations) ? msg.citations[citIndex] : null;
    if (!citation) return;

    state.showExtractedText = true;
    state.highlightQuote = citation.quote;
    render();

    if (!state.extractedText && !state.isExtractedTextLoading) {
        await loadExtractedText();
    }

    render();
    document.getElementById('citation-highlight')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderExtractedTextPanel() {
    const hasText = Boolean(state.extractedText);
    const description = state.extractedTextError
        ? `<p class="text-xs text-[#B3362B]">${escapeHtml(state.extractedTextError)}</p>`
        : `<p class="text-xs text-muted">Use the extracted text to verify numeric figures and clause references.</p>`;

    let bodyHtml;
    if (!hasText) {
        bodyHtml = escapeHtml('No extracted text available.');
    } else {
        const offset = state.highlightQuote ? findQuoteOffsetWithFallback(state.highlightQuote, state.extractedText) : null;
        if (offset) {
            const before = state.extractedText.slice(0, offset.start);
            const match = state.extractedText.slice(offset.start, offset.end);
            const after = state.extractedText.slice(offset.end);
            bodyHtml = `${escapeHtml(before)}<mark id="citation-highlight">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
        } else {
            bodyHtml = escapeHtml(state.extractedText);
        }
    }

    return `
        <div class="w-full mt-6">
            ${card(`
                <div class="flex items-center justify-between px-4 py-3 border-b border-line">
                    ${sectionLabel('Extracted Text')}
                    <button class="text-xs font-semibold text-primary hover:underline" onclick="toggleExtractedText()">
                        ${state.showExtractedText ? 'Hide' : 'Show'}
                    </button>
                </div>
                <div class="px-4 py-3">
                    ${description}
                </div>
                ${state.showExtractedText ? `
                    <div class="border-t border-line">
                        ${state.isExtractedTextLoading ? `
                            <div class="p-4 flex items-center gap-3">
                                <div class="loading-spinner"></div>
                                <span class="text-xs text-muted">Loading extracted text...</span>
                            </div>
                        ` : `
                            <pre class="p-4 text-xs text-ink whitespace-pre-wrap max-h-[320px] overflow-y-auto custom-scrollbar">${bodyHtml}</pre>
                        `}
                    </div>
                ` : ''}
            `, 'overflow-hidden')}
        </div>
    `;
}

// API Functions
async function fetchContracts() {
    try {
        const response = await fetch(`${API_BASE}/contracts`);
        state.contracts = await response.json();
        return state.contracts;
    } catch (error) {
        console.error('Error fetching contracts:', error);
        return [];
    }
}

async function uploadContract(file, role) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('role', role || state.selectedRole);

    try {
        const response = await fetch(`${API_BASE}/contracts/upload`, {
            method: 'POST',
            body: formData
        });
        return await response.json();
    } catch (error) {
        console.error('Error uploading contract:', error);
        throw error;
    }
}

async function uploadNewVersionAPI(contractId, file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('role', state.selectedRole);

    try {
        const response = await fetch(`${API_BASE}/contracts/${contractId}/version`, {
            method: 'POST',
            body: formData
        });
        return await response.json();
    } catch (error) {
        console.error('Error uploading version:', error);
        throw error;
    }
}

async function getAnalysis(contractId) {
    try {
        const response = await fetch(`${API_BASE}/contracts/${contractId}/analysis`);
        const data = await response.json();
        if (data.status === 'analyzing') {
            return null;
        }
        if (data.status === 'error') {
            return { __failed: true, message: data.message };
        }
        return data;
    } catch (error) {
        console.error('Error fetching analysis:', error);
        return null;
    }
}

async function getContractText(contractId) {
    try {
        const response = await fetch(`${API_BASE}/contracts/${contractId}/text`);
        const data = await response.json();
        return { status: response.status, data };
    } catch (error) {
        console.error('Error fetching extracted text:', error);
        return { status: 500, data: { error: 'Failed to fetch extracted text' } };
    }
}

// Phase 4: loads the persisted chat history for a contract (last 50
// messages). Returns [] on any error so a fresh/failed fetch just means an
// empty conversation, not a crash.
async function getChatHistory(contractId) {
    try {
        const response = await fetch(`${API_BASE}/contracts/${contractId}/chat`);
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error('Error fetching chat history:', error);
        return [];
    }
}

async function updateContractRole(contractId, role) {
    try {
        const response = await fetch(`${API_BASE}/contracts/${contractId}/role`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role })
        });
        return await response.json();
    } catch (error) {
        console.error('Error updating role:', error);
        throw error;
    }
}

async function sendChatMessageAPI(contractId, message, role, history) {
    try {
        const response = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contractId, message, role: role || state.selectedRole, history })
        });
        return await response.json();
    } catch (error) {
        console.error('Error sending chat message:', error);
        throw error;
    }
}

// Phase 3: prior turns to send as conversation memory. Excludes the
// just-pushed current user message (call this BEFORE pushing it), any
// loading/streaming placeholder, and any assistant turn that reads as an
// error — a failed prior turn is not useful context and would only confuse
// follow-up retrieval/prompting. Truncated defensively; the server truncates
// again and never trusts this input either.
function buildChatHistoryPayload() {
    return state.chatMessages
        .filter((m) => !m.isLoading && !m.streaming)
        .filter((m) => !(m.role === 'assistant' && typeof m.content === 'string'
            && (m.content.startsWith('ERROR:') || m.content.startsWith('Sorry, I encountered an error'))))
        .slice(-8)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }));
}

// Phase 3: streams a chat answer over SSE via fetch+reader (EventSource is
// GET-only). Distinguishes two failure modes for the caller:
//  - throws: nothing streamed yet (network error, non-200, or a server
//    `error` event before any `token`) — caller should transparently fall
//    back to the non-streaming endpoint.
//  - returns { interrupted: true }: tokens already flowed and are already
//    reflected in `onToken` calls — caller must NOT fall back (that would
//    re-ask the question and confuse the partial answer already shown).
async function streamChatMessageAPI(contractId, message, role, history, { onToken } = {}) {
    const response = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractId, message, role: role || state.selectedRole, history })
    });

    if (!response.ok || !response.body) {
        throw new Error(`Stream request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalMessage = null;
    let gotAnyToken = false;

    const processLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return null;
        const payload = trimmed.slice(5).trim();
        if (!payload) return null;
        try {
            return JSON.parse(payload);
        } catch (e) {
            return null;
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const evt = processLine(line);
                if (!evt) continue;

                if (evt.type === 'token') {
                    gotAnyToken = true;
                    onToken(evt.text);
                } else if (evt.type === 'done') {
                    finalMessage = evt.message;
                } else if (evt.type === 'error') {
                    if (gotAnyToken) return { interrupted: true, errorMessage: evt.message };
                    throw new Error(evt.message || 'Stream error');
                }
            }
        }
    } catch (readError) {
        if (gotAnyToken) return { interrupted: true, errorMessage: 'Connection lost during response.' };
        throw readError;
    }

    if (finalMessage) return { message: finalMessage };
    if (gotAnyToken) return { interrupted: true, errorMessage: 'Response interrupted before completion.' };
    throw new Error('Stream ended without a response.');
}

// Poll for analysis completion
async function pollAnalysis(contractId, callback) {
    // 90 attempts x 2s = 3 minutes — sequential LLM calls on a free model can
    // routinely take longer than the old 30s budget.
    const maxAttempts = 90;
    let attempts = 0;

    const poll = async () => {
        if (attempts >= maxAttempts) {
            callback(null);
            return;
        }

        attempts++;
        const analysis = await getAnalysis(contractId);
        if (analysis && analysis.__failed) {
            callback(null);
        } else if (analysis) {
            callback(analysis);
        } else {
            setTimeout(poll, 2000);
        }
    };

    poll();
}

// View Renderers
function renderHeader() {
    const navLinks = {
        upload: { text: 'Upload', active: state.currentView === 'upload' },
        investor: { text: 'Investor View', active: state.currentView === 'investor' },
        legal: { text: 'Legal View', active: state.currentView === 'legal' },
        pm: { text: 'PM View', active: state.currentView === 'pm' },
        partner: { text: 'Partner View', active: state.currentView === 'partner' },
        chat: { text: 'AI Chat', active: state.currentView === 'chat' }
    };

    return `
        <header class="flex items-center whitespace-nowrap border-b border-line px-7 h-[60px] bg-surface sticky top-0 z-50">
            <div class="flex items-center gap-9">
                <div class="flex items-center gap-2.5 cursor-pointer" onclick="navigateTo('upload')">
                    <div class="brand-mark">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6l7-3z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"></path>
                            <path d="M9 11.5l2.2 2.2L15.5 9" stroke="#D9B364" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
                        </svg>
                    </div>
                    <h2 class="font-display text-ink text-[19px] font-bold leading-tight">Contract<span class="text-brass">AI</span></h2>
                </div>
                <!-- Generated Nav Links -->
                <nav class="hidden md:flex gap-1">
                    ${Object.entries(navLinks).map(([key, link]) => `
                        <a onclick="navigateTo('${key}')" class="nav-pill ${link.active ? 'on' : ''}">${link.text}</a>
                    `).join('')}
                </nav>
            </div>
            <div class="flex flex-1 justify-end items-center gap-3">
                ${state.currentContract ? `
                    <span class="file-pill">
                        <span class="live-dot"></span>
                        <span class="text-ink truncate max-w-[220px]">${escapeHtml(state.currentContract.name)}</span>
                    </span>
                ` : ''}
            </div>
        </header>
    `;
}

function renderUploadView() {
    return `
        <main class="flex-1 justify-center py-12 px-4 md:px-20 lg:px-40">
            <div class="layout-content-container flex flex-col max-w-[840px] flex-1 gap-8">
                <!-- Page Heading -->
                <div class="flex flex-col gap-3 text-center md:text-left">
                    <h1 class="font-display text-ink text-4xl md:text-5xl font-bold leading-tight tracking-[-0.01em]">Contract Analysis</h1>
                    <p class="text-muted text-lg font-normal leading-normal max-w-2xl">
                        Upload a contract to generate analysis across Investor, Legal, PM, Partner, and HR perspectives.
                    </p>
                </div>

                <!-- Enhanced Dropzone -->
                <div class="flex flex-col">
                    <input type="file" id="fileInput" accept=".pdf,.docx,.doc,.txt" style="display: none;">
                    <div id="dropzone" class="flex flex-col items-center gap-6 rounded-lg border border-line bg-surface px-6 py-16 hover:border-primary transition-colors cursor-pointer group" data-file-upload>
                        <div class="flex flex-col items-center gap-4">
                            <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary transition-transform">
                                <span class="material-symbols-outlined text-4xl">cloud_upload</span>
                            </div>
                            <div class="flex max-w-[480px] flex-col items-center gap-2">
                                <p class="font-display text-ink text-xl font-semibold leading-tight text-center">Drag and drop your contract here</p>
                                <p class="text-muted text-sm font-normal leading-normal text-center">Supports PDF, DOCX, DOC, and TXT (Max 50MB per file)</p>
                            </div>
                        </div>
                        <div class="flex gap-3">
                            <button class="flex min-w-[120px] cursor-pointer items-center justify-center overflow-hidden rounded h-11 px-5 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90 transition-all shadow-sm" data-file-upload>
                                <span class="truncate">Upload File</span>
                            </button>
                            <button class="flex min-w-[120px] cursor-pointer items-center justify-center overflow-hidden rounded h-11 px-5 bg-transparent border border-line text-ink text-sm font-bold leading-normal tracking-[0.015em] hover:bg-paper transition-all" data-file-upload>
                                <span class="truncate">Browse Local</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Recent Files List -->
                <div class="flex flex-col gap-4 mt-4">
                    <div class="flex justify-between items-center px-1">
                        ${sectionLabel('Recent Documents')}
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        ${state.contracts.length === 0 ? '<p class="text-muted text-sm">No documents uploaded yet.</p>' : state.contracts.map(contract => renderRecentFileCard(contract)).join('')}
                    </div>
                </div>
            </div>
        </main>
    `;
}

function renderRecentFileCard(contract) {
    const isPDF = contract.fileName.toLowerCase().endsWith('.pdf');
    const iconClass = isPDF ? 'picture_as_pdf' : 'description';

    return card(`
        <div class="flex items-center gap-4 p-4 cursor-pointer" onclick="openContract('${contract.id}')">
            <div class="size-10 flex items-center justify-center bg-paper text-primary rounded-lg">
                <span class="material-symbols-outlined">${iconClass}</span>
            </div>
            <div class="flex flex-col flex-1 min-w-0">
                <p class="text-sm font-bold text-ink truncate">${contract.name}</p>
                <p class="text-xs text-muted">${formatDate(contract.uploadDate)} • ${formatFileSize(contract.fileSize)}</p>
            </div>
        </div>
    `, 'hover:shadow-md transition-shadow');
}

function renderInvestorView() {
    if (!state.currentAnalysis) {
        return renderLoadingView();
    }

    const analysis = state.currentAnalysis;

    // Use analysis data directly
    const investorAnalysis = analysis;
    const flaggedClauses = Array.isArray(investorAnalysis.enforceabilityRisks) ? investorAnalysis.enforceabilityRisks.length : 0;
    const totalClauses = Number.isFinite(investorAnalysis.totalClauses) ? investorAnalysis.totalClauses : null;
    const lgdScore = Number.isFinite(investorAnalysis.lgdScore) ? investorAnalysis.lgdScore : null;
    const clauseItems = Array.isArray(investorAnalysis.enforceabilityRisks) && investorAnalysis.enforceabilityRisks.length > 0
        ? investorAnalysis.enforceabilityRisks
        : (Array.isArray(investorAnalysis.riskFactors) ? investorAnalysis.riskFactors : []);

    return `
        <main class="flex-1 flex flex-col max-w-[1800px] overflow-hidden mx-auto w-full px-4 sm:px-10 py-3 gap-3">
            <div class="flex flex-col shrink-0">
                <div class="flex items-center gap-2 text-xs text-muted">
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Investor View</a>
                    <span>/</span>
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Contract Analysis</a>
                    <span>/</span>
                    <span class="text-ink font-medium">${state.currentContract.name}</span>
                </div>
                <div class="flex flex-wrap items-baseline gap-2">
                    <h1 class="font-display text-xl font-bold tracking-[-0.01em] text-ink">${state.currentContract.name}</h1>
                    <p class="text-muted text-xs">— Last updated ${formatDate(state.currentContract.uploadDate)}</p>
                </div>
            </div>

            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Total Financial Exposure')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-ink text-xl font-bold figures">${displayField(investorAnalysis.financialExposure)}</p>
                        ${(investorAnalysis.calculations?.exposure?.items?.length || 0) > 0 ? sealBadge('Verified') : ''}
                    </div>
                    <p class="text-muted text-[11px] line-clamp-1">${(investorAnalysis.calculations?.exposure?.items?.length || 0) > 0 ? `Sum of ${investorAnalysis.calculations.exposure.items.length} amount(s) verified in contract text` : 'No verified risk amounts found in contract text'}</p>
                </div>
                `, 'stat-tile sev-critical')}
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Loss Given Default (LGD)')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-ink text-xl font-bold figures">${lgdScore !== null ? `${lgdScore}%` : 'Not computable'}</p>
                    </div>
                    ${lgdScore !== null ? `
                        <div class="w-full bg-line h-1.5 rounded-full">
                            <div class="bg-primary h-full rounded-full" style="width: ${lgdScore}%"></div>
                        </div>
                    ` : ''}
                    ${renderLgdBreakdownText(investorAnalysis) ? `<p class="text-muted text-[11px] figures line-clamp-1">${renderLgdBreakdownText(investorAnalysis)}</p>` : ''}
                </div>
                `, 'stat-tile sev-navy')}
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Ambiguous Clauses')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-ink text-xl font-bold figures">${flaggedClauses}</p>
                    </div>
                    <p class="text-muted text-[11px] line-clamp-1">${totalClauses !== null ? `Flagged out of ${totalClauses} ${investorAnalysis.clauseCountLevel === 'section' ? 'sections' : 'clauses'}` : 'Clause count not determined'}</p>
                </div>
                `, 'stat-tile sev-caution')}
            </div>

            <div class="flex-1 min-h-0 flex gap-6 overflow-hidden">
                <!-- Document Viewer -->
                <div class="flex-[3] flex flex-col min-h-0 bg-surface rounded-lg border border-line shadow-sm overflow-hidden">
                    <div class="flex items-center justify-between px-6 py-4 border-b border-line">
                        <div class="flex items-center gap-4">
                            <span class="text-sm font-bold text-ink">${state.currentContract.name}.pdf</span>
                        </div>
                    </div>
                    <div class="flex-1 min-h-0 overflow-y-auto p-12 custom-scrollbar bg-paper">
                        <div class="max-w-3xl mx-auto bg-surface shadow-sm p-16 min-h-full prose document-paper">
                            <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                        </div>
                        ${renderExtractedTextPanel()}
                    </div>
                </div>

                <!-- Risk Analysis Sidebar -->
                <div class="flex-[2] flex flex-col gap-4 overflow-hidden min-h-0 min-w-[350px]">
                    <div class="bg-surface rounded-lg border border-line overflow-hidden shrink-0">
                        <div class="flex border-b border-line">
                            <button class="flex-1 py-3 text-sm font-bold border-b-2 ${state.investorTab === 'insights' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-primary'}" onclick="switchInvestorTab('insights')">Investor Insights</button>
                            <button class="flex-1 py-3 text-sm font-bold border-b-2 ${state.investorTab === 'financial' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-primary'}" onclick="switchInvestorTab('financial')">Financial Exposure</button>
                        </div>
                        ${state.investorTab === 'insights' ? `
                            <div class="p-4 flex gap-2 overflow-x-auto no-scrollbar">
                                ${clauseItems.length > 0 ? clauseItems.map(item => `
                                    <span class="px-3 py-1 bg-paper border border-line text-ink text-xs font-semibold rounded-full whitespace-nowrap">${escapeHtml(item.title)}</span>
                                `).join('') : '<p class="text-xs text-muted italic">No verified risk items for this contract.</p>'}
                            </div>
                        ` : `
                            <div class="p-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                                <div class="flex items-center justify-between gap-2 mb-3">
                                    ${sectionLabel('Financial Breakdown')}
                                    ${renderGroundingBadge(analysis)}
                                </div>
                                <div>
                                    ${analysis.numericFigures.risks.length > 0 ? `
                                        <div class="risk-group">Identified Risks · verified</div>
                                        ${analysis.numericFigures.risks.map((r) => riskLedgerRow(r, { critical: true, amountClass: 'crit' })).join('')}
                                    ` : ''}

                                    ${analysis.numericFigures.obligations.length > 0 ? `
                                        <div class="risk-group">Obligations</div>
                                        ${analysis.numericFigures.obligations.map((o) => riskLedgerRow(o, { amountClass: 'navy' })).join('')}
                                    ` : ''}

                                    ${(analysis.numericFigures.rates || []).length > 0 ? `
                                        <div class="risk-group">Rates · per-unit, excluded from totals</div>
                                        ${analysis.numericFigures.rates.map((r) => riskLedgerRow(r, { amountClass: 'muted' })).join('')}
                                    ` : ''}

                                    ${(analysis.numericFigures.insuranceRequirements || []).length > 0 ? `
                                        <div class="risk-group">Insurance · excluded from exposure</div>
                                        ${analysis.numericFigures.insuranceRequirements.map((r) => riskLedgerRow(r, { amountClass: 'muted' })).join('')}
                                    ` : ''}

                                    <div class="mt-3 pt-3 border-t border-line space-y-2">
                                        <div class="flex justify-between items-center">
                                            <span class="text-xs font-bold text-muted">Total Potential Loss</span>
                                            <span class="text-sm font-black text-[#B3362B] figures">${displayMoney(analysis.numericFigures.totalPotentialLoss)}</span>
                                        </div>
                                        <div class="flex justify-between items-center">
                                            <span class="text-xs font-bold text-muted">Total Amount Owed</span>
                                            <span class="text-sm font-black text-primary figures">${displayMoney(analysis.numericFigures.totalAmountOwed)}</span>
                                        </div>
                                        <div class="flex justify-between items-center p-2.5 bg-ink rounded-lg">
                                            <span class="text-xs font-bold text-white/70">LGD Percentage</span>
                                            <span class="text-sm font-black text-white figures">${Number.isFinite(analysis.lgdScore) ? `${analysis.lgdScore}%` : 'Not computable'}</span>
                                        </div>
                                        ${renderLgdBreakdownText(analysis) ? `<p class="text-[10px] text-muted text-right figures">${renderLgdBreakdownText(analysis)}</p>` : ''}
                                    </div>
                                </div>
                            </div>
                        `}
                    </div>
                    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-4 pb-4">
                        ${clauseItems.length > 0 ? clauseItems.map(item => `
                            <div class="flex flex-col gap-3">
                                <h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted px-1">Clause ${displayField(item.section, '—')}: Summary</h4>
                                ${card(`
                                <div class="p-4 border-l-4 border-l-primary">
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-xs font-bold text-muted uppercase">Clause ${displayField(item.section, '—')}</span>
                                        ${item.source === 'keyword-scan' ? '<span class="text-[9px] font-bold uppercase text-muted bg-paper px-1.5 py-0.5 rounded">keyword scan</span>' : ''}
                                        ${item.financialImpact ? `<span class="text-xs font-semibold text-primary figures">Impact: ${escapeHtml(item.financialImpact)}</span>` : ''}
                                    </div>
                                    <h5 class="text-sm font-bold text-ink mb-1">${escapeHtml(item.title)}</h5>
                                    <p class="text-xs text-muted mb-3">${escapeHtml(item.description)}</p>
                                    ${item.financialImpact ? `
                                        <div class="flex items-center gap-1 mt-auto pt-3 border-t border-line">
                                            <span class="material-symbols-outlined text-xs text-primary">attach_money</span>
                                            <span class="text-xs font-bold text-ink figures">${escapeHtml(item.financialImpact)}</span>
                                        </div>
                                    ` : ''}
                                </div>
                                `, 'hover:shadow-md transition-shadow')}
                            </div>
                        `).join('') : '<p class="text-xs text-muted italic px-1">No verified risk items for this contract.</p>'}
                    </div>
                </div>
            </div>
        </main>
    `;
}

function renderPartnerView() {
    if (!state.currentAnalysis) {
        return renderLoadingView();
    }

    const analysis = state.currentAnalysis;
    const flaggedClauses = Array.isArray(analysis.enforceabilityRisks) ? analysis.enforceabilityRisks.length : 0;
    const totalClauses = Number.isFinite(analysis.totalClauses) ? analysis.totalClauses : null;
    const lgdScore = Number.isFinite(analysis.lgdScore) ? analysis.lgdScore : null;
    const compliance = complianceDisplay(analysis);
    const deliverableCount = Array.isArray(analysis.deliverables) ? analysis.deliverables.length : 0;
    const actionItemCount = Array.isArray(analysis.actionItems) ? analysis.actionItems.length : 0;
    const timelineCount = Array.isArray(analysis.timelines) ? analysis.timelines.length : 0;
    const clauseFlags = Array.isArray(analysis.enforceabilityRisks) ? analysis.enforceabilityRisks : [];
    const complianceChecks = Array.isArray(analysis.complianceChecks) ? analysis.complianceChecks : [];
    const compliancePassCount = complianceChecks.filter(check => check.status === 'pass').length;

    return `
        <main class="flex-1 flex flex-col max-w-[1800px] overflow-hidden mx-auto w-full px-4 sm:px-10 py-3 gap-3">
            <div class="flex flex-col shrink-0">
                <div class="flex items-center gap-2 text-xs text-muted">
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Partner View</a>
                    <span>/</span>
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Contract Overview</a>
                    <span>/</span>
                    <span class="text-ink font-medium">${state.currentContract.name}</span>
                </div>
                <div class="flex flex-wrap items-baseline gap-2">
                    <h1 class="font-display text-xl font-bold tracking-[-0.01em] text-ink">${state.currentContract.name}</h1>
                    <p class="text-muted text-xs">— Overview of financial, legal, and operational signals</p>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Total Financial Exposure')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-ink text-xl font-bold figures">${displayField(analysis.financialExposure)}</p>
                        ${(analysis.calculations?.exposure?.items?.length || 0) > 0 ? sealBadge('Verified') : ''}
                    </div>
                    <p class="text-muted text-[11px] line-clamp-1">${(analysis.calculations?.exposure?.items?.length || 0) > 0 ? `Sum of ${analysis.calculations.exposure.items.length} amount(s) verified in contract text` : 'No verified risk amounts found in contract text'}</p>
                </div>
                `, 'stat-tile sev-critical')}
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Compliance Score')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-xl font-bold figures ${compliance.cls}">${compliance.text}</p>
                    </div>
                    <p class="text-muted text-[11px] line-clamp-1">${Array.isArray(analysis.complianceChecks) && analysis.complianceChecks.length > 0 ? `${analysis.complianceChecks.length} check(s) evaluated` : 'Not determined'}</p>
                </div>
                `, 'stat-tile sev-clear')}
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Loss Given Default (LGD)')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-ink text-xl font-bold figures">${lgdScore !== null ? `${lgdScore}%` : 'Not computable'}</p>
                    </div>
                    ${lgdScore !== null ? `
                        <div class="w-full bg-line h-1.5 rounded-full">
                            <div class="bg-primary h-full rounded-full" style="width: ${lgdScore}%"></div>
                        </div>
                    ` : ''}
                </div>
                `, 'stat-tile sev-navy')}
                ${card(`
                <div class="flex flex-col gap-0.5 px-4 py-2.5">
                    ${sectionLabel('Ambiguous Clauses')}
                    <div class="flex items-baseline gap-2">
                        <p class="text-ink text-xl font-bold figures">${flaggedClauses}</p>
                    </div>
                    <p class="text-muted text-[11px] line-clamp-1">${totalClauses !== null ? `Flagged out of ${totalClauses} ${analysis.clauseCountLevel === 'section' ? 'sections' : 'clauses'}` : 'Clause count not determined'}</p>
                </div>
                `, 'stat-tile sev-caution')}
            </div>

            <div class="flex-1 min-h-0 flex gap-6 overflow-hidden">
                <div class="flex-[3] flex flex-col min-h-0 bg-surface rounded-lg border border-line shadow-sm overflow-hidden">
                    <div class="flex items-center justify-between px-6 py-4 border-b border-line">
                        <div class="flex items-center gap-4">
                            <span class="text-sm font-bold text-ink">${state.currentContract.name}.pdf</span>
                        </div>
                    </div>
                    <div class="flex-1 min-h-0 overflow-y-auto p-12 custom-scrollbar bg-paper">
                        <div class="max-w-3xl mx-auto bg-surface shadow-sm p-16 min-h-full prose document-paper">
                            <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                        </div>
                        ${renderExtractedTextPanel()}
                    </div>
                </div>

                <div class="flex-[2] flex flex-col gap-4 overflow-hidden min-h-0 min-w-[350px]">
                    <div class="bg-surface rounded-lg border border-line overflow-hidden shrink-0">
                        <div class="px-4 py-3 border-b border-line">
                            ${sectionLabel('Operational Snapshot')}
                        </div>
                        <div class="p-4 grid grid-cols-3 gap-3 text-center">
                            <div class="bg-paper rounded-lg p-3">
                                <p class="text-[10px] uppercase text-muted font-bold">Deliverables</p>
                                <p class="text-lg font-bold text-ink figures">${deliverableCount}</p>
                            </div>
                            <div class="bg-paper rounded-lg p-3">
                                <p class="text-[10px] uppercase text-muted font-bold">Action Items</p>
                                <p class="text-lg font-bold text-ink figures">${actionItemCount}</p>
                            </div>
                            <div class="bg-paper rounded-lg p-3">
                                <p class="text-[10px] uppercase text-muted font-bold">Milestones</p>
                                <p class="text-lg font-bold text-ink figures">${timelineCount}</p>
                            </div>
                        </div>
                    </div>

                    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-4 pb-4">
                        <div class="flex flex-col gap-3">
                            <h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted px-1">Clause Flags</h4>
                            ${clauseFlags.length === 0 ? card(`<p class="text-xs text-muted p-4">No clause flags detected.</p>`) : clauseFlags.map(flag => card(`
                                <div class="p-4">
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-[10px] uppercase text-muted font-bold">Clause ${displayField(flag.section, '—')}</span>
                                        <span class="material-symbols-outlined text-brass text-sm">flag</span>
                                    </div>
                                    <h5 class="text-sm font-bold text-ink mb-1">${escapeHtml(flag.title)}</h5>
                                    <p class="text-xs text-muted">${escapeHtml(flag.description)}</p>
                                </div>
                            `)).join('')}
                        </div>

                        <div class="flex flex-col gap-3">
                            <h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted px-1">Compliance Checks</h4>
                            ${card(`
                                <div class="p-4">
                                ${complianceChecks.length > 0 ? `
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="text-xs text-muted">Checks Passed</span>
                                        <span class="text-xs font-bold text-[#1E7F5C] figures">${compliancePassCount}/${complianceChecks.length}</span>
                                        ${compliancePassCount === complianceChecks.length ? sealBadge('All passed') : ''}
                                    </div>
                                    <div class="w-full bg-line h-2 rounded-full">
                                        <div class="bg-[#1E7F5C] h-full rounded-full" style="width: ${Math.round((compliancePassCount / complianceChecks.length) * 100)}%"></div>
                                    </div>
                                ` : `<p class="text-xs text-muted italic">No compliance checks verified</p>`}
                                </div>
                            `)}
                        </div>

                    </div>
                </div>
            </div>
        </main>
    `;
}

function renderLegalView() {
    if (!state.currentAnalysis) {
        return renderLoadingView();
    }

    const analysis = state.currentAnalysis;

    // Use analysis data directly
    const legalAnalysis = analysis;

    return `
        <main class="flex-1 flex flex-row overflow-hidden">
            <!-- Left Pane: Document Viewer -->
            <div class="flex-1 flex flex-col bg-paper overflow-hidden relative border-r border-line">
                <div class="bg-surface border-b border-line px-6 py-3 flex justify-between items-center shrink-0">
                    <div class="flex items-center gap-3">
                        <nav class="flex items-center gap-2 text-xs font-medium text-muted uppercase tracking-wider">
                            <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Contracts</a>
                            <span>/</span>
                            <span class="text-ink">${state.currentContract ? state.currentContract.name : 'Document'}.pdf</span>
                        </nav>
                    </div>
                </div>
                <div class="flex-1 overflow-y-auto p-8 custom-scrollbar">
                    <div class="max-w-4xl mx-auto bg-surface p-16 document-paper min-h-[1100px] text-ink leading-relaxed shadow-sm rounded-sm">
                        <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[1000px]"></iframe>
                    </div>
                    ${renderExtractedTextPanel()}
                </div>
            </div>

            <!-- Right Pane: Intelligence Sidebar -->
            <aside class="w-[380px] lg:w-[420px] xl:w-[480px] bg-surface flex flex-col shrink-0 overflow-hidden border-l border-line">
                <div class="p-4 border-b border-line bg-paper">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="font-display font-bold text-ink flex items-center gap-2">
                            <span class="material-symbols-outlined text-primary">analytics</span>
                            Legal Insights
                        </h3>
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <div class="bg-surface p-2 rounded-lg border border-line text-center">
                            <p class="text-[10px] text-muted uppercase font-bold">Risk Level</p>
                            <p class="text-sm font-bold ${riskLevelClasses(legalAnalysis.overallRisk)}">${displayField(legalAnalysis.overallRisk, 'Not determined')}</p>
                        </div>
                        <div class="bg-surface p-2 rounded-lg border border-line text-center">
                            <p class="text-[10px] text-muted uppercase font-bold">Compliance</p>
                            <p class="text-sm font-bold figures ${complianceDisplay(legalAnalysis).cls}">${complianceDisplay(legalAnalysis).text}</p>
                        </div>
                        <div class="bg-surface p-2 rounded-lg border border-line text-center">
                            <p class="text-[10px] text-muted uppercase font-bold">Flagged / Clauses</p>
                            <p class="text-sm font-bold text-primary figures">${(legalAnalysis.enforceabilityRisks?.length ?? 0)}/${legalAnalysis.totalClauses ?? '—'}</p>
                        </div>
                    </div>
                </div>

                <div class="flex border-b border-line px-4 gap-6 shrink-0">
                    <button class="border-b-2 ${state.legalTab === 'analysis' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-ink'} py-3 text-xs font-bold" onclick="switchLegalTab('analysis')">ANALYSIS</button>
                    <button class="border-b-2 ${state.legalTab === 'versioning' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-ink'} py-3 text-xs font-bold" onclick="switchLegalTab('versioning')">VERSIONING</button>
                </div>

                <div class="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
                    ${state.legalTab === 'versioning' ? `
                        <div class="text-center py-6">
                            <div class="size-12 mx-auto mb-3 rounded-full bg-primary/10 flex items-center justify-center">
                                <span class="material-symbols-outlined text-2xl text-primary">history</span>
                            </div>
                            <h3 class="font-display text-md font-bold text-ink mb-2">Contract Version History</h3>
                            <button class="px-6 py-2 mb-4 bg-primary text-white text-xs font-bold rounded-lg shadow-sm hover:bg-primary/90 transition-all" onclick="document.getElementById('versionInput').click()">
                                Upload New Version
                            </button>
                            <input type="file" id="versionInput" class="hidden" accept=".pdf,.doc,.docx,.txt" onchange="handleVersionSelected(event)">

                            <div class="space-y-3 mt-4 text-left">
                                <!-- Current Active Version -->
                                <div class="flex items-center gap-4 p-4 bg-surface rounded-lg border border-line ring-1 ring-brass/30">
                                    <div class="size-10 rounded-full bg-ink text-white flex items-center justify-center text-xs font-bold">v${(state.currentContract.versions?.length || 0) + 1}</div>
                                    <div class="text-left flex-1 min-w-0">
                                        <p class="text-sm font-bold text-primary truncate">${escapeHtml(state.currentContract.originalName || state.currentContract.name)}</p>
                                        <p class="text-xs text-muted">Current active version • ${formatDate(state.currentContract.uploadDate || new Date().toISOString())}</p>
                                    </div>
                                </div>

                                <!-- Historical Versions -->
                                ${(state.currentContract.versions || []).slice().reverse().map(v => `
                                    <div class="flex items-center gap-4 p-4 bg-surface rounded-lg border border-line opacity-70 hover:opacity-100 transition-opacity">
                                        <div class="size-10 rounded-full bg-paper border border-line text-muted flex items-center justify-center text-xs font-bold">v${v.version}</div>
                                        <div class="text-left flex-1 min-w-0">
                                            <p class="text-sm font-bold truncate text-ink">${escapeHtml(v.originalName || v.name)}</p>
                                            <p class="text-xs text-muted">Superseded • ${formatDate(v.uploadDate)}</p>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : `
                        <!-- Compliance Checks -->
                        <div>
                            <h4 class="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">
                                Compliance Checks
                            </h4>
                            <div class="space-y-2">
                                ${legalAnalysis.complianceChecks.length > 0 ? legalAnalysis.complianceChecks.map(check => {
                                    const icon = check.status === 'pass' ? 'check_circle' : (check.status === 'unverified' ? 'help' : 'report_problem');
                                    const iconCls = check.status === 'pass' ? 'text-[#1E7F5C]' : (check.status === 'unverified' ? 'text-muted' : 'text-[#B45309]');
                                    return `
                                    <div class="flex items-start gap-3 p-3 rounded-lg border border-line bg-paper">
                                        <span class="material-symbols-outlined ${iconCls}">${icon}</span>
                                        <div>
                                            <p class="text-sm font-semibold text-ink flex items-center gap-1.5">${escapeHtml(check.name)} ${check.status === 'pass' ? sealBadge('Verified') : ''}</p>
                                            <p class="text-xs text-muted">${escapeHtml(check.note)}</p>
                                        </div>
                                    </div>
                                `; }).join('') : `<p class="text-xs text-muted italic">No compliance checks could be verified against the contract text.</p>`}
                            </div>
                        </div>

                        <!-- Enforceability Risks -->
                        <div>
                            <h4 class="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3 flex items-center justify-between">
                                Enforceability Risks
                                <span class="bg-[#B3362B]/10 text-[#B3362B] px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-normal">${legalAnalysis.enforceabilityRisks.length} ALERTS</span>
                            </h4>
                            <div class="space-y-3">
                                ${legalAnalysis.enforceabilityRisks.length > 0 ? legalAnalysis.enforceabilityRisks.map(risk => `
                                    <div class="p-3 rounded-lg border border-[#B3362B]/30 bg-[#B3362B]/5 ring-1 ring-[#B3362B]/20">
                                        <div class="flex justify-between items-start mb-2">
                                            <span class="bg-[#B3362B] text-white text-[9px] font-bold px-1.5 py-0.5 rounded">${escapeHtml(risk.risk || 'RISK')}</span>
                                        </div>
                                        <p class="text-sm font-bold text-[#B3362B] mb-1">${escapeHtml(risk.title)}</p>
                                        <p class="text-xs text-muted leading-relaxed mb-2">${escapeHtml(risk.description)}</p>
                                        ${risk.quote && risk.quote !== 'Not specified' ? `<div class="mt-2 mb-3 bg-surface p-2 border-l-2 border-[#B3362B] rounded shadow-sm text-[10px] text-ink italic">"${escapeHtml(risk.quote)}"</div>` : ''}
                                    </div>
                                `).join('') : `<p class="text-xs text-muted italic">No enforceability risks could be verified against the contract text.</p>`}
                            </div>
                        </div>

                        <!-- Jurisdiction Details -->
                        <div>
                            <h4 class="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">Jurisdiction Context</h4>
                            <div class="bg-paper p-4 rounded-lg border border-line">
                                <div class="flex items-center gap-3 mb-4">
                                    <div class="size-10 bg-surface rounded border border-line flex items-center justify-center">
                                        <span class="material-symbols-outlined text-primary">location_on</span>
                                    </div>
                                    <div>
                                        <p class="text-sm font-bold ${[EMPTY_FIELD_TEXT, 'Not determined'].includes(legalAnalysis.jurisdiction.location) ? 'text-muted italic' : 'text-ink'}">${displayField(legalAnalysis.jurisdiction.location, 'Not determined')}</p>
                                        <p class="text-xs text-muted">Governing Law (${displayField(legalAnalysis.jurisdiction.governingLaw, 'Not determined')})</p>
                                    </div>
                                </div>
                                <ul class="space-y-2">
                                    ${(legalAnalysis.jurisdiction.notes || []).map(note => `
                                        <li class="flex items-center gap-2 text-xs text-muted">
                                            <span class="size-1.5 bg-primary rounded-full"></span>
                                            ${escapeHtml(note)}
                                        </li>
                                    `).join('')}
                                </ul>
                            </div>
                        </div>
                    `}
                </div>
            </aside>
        </main>
    `;
}

function renderPMView() {
    if (!state.currentAnalysis) {
        return renderLoadingView();
    }

    const analysis = state.currentAnalysis;

    // Use analysis data directly
    const pmAnalysis = analysis;

    return `
        <div class="flex flex-1 overflow-hidden">
            <!-- Main Workspace -->
            <main class="flex-1 flex flex-col bg-paper overflow-hidden">
                <!-- Workspace Header -->
                <div class="px-6 py-4 flex items-center justify-between border-b border-line bg-surface">
                    <div class="flex flex-col">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs text-muted font-medium">Contracts</span>
                            <span class="text-xs text-muted font-medium">/</span>
                            <span class="text-xs text-ink font-bold">Operational Analysis View</span>
                        </div>
                        <h2 class="font-display text-2xl font-bold tracking-[-0.01em] text-ink">Operational Analysis</h2>
                    </div>
                </div>

                <!-- Tabs -->
                <div class="px-6 border-b border-line bg-surface">
                    <div class="flex gap-8">
                        <button class="py-4 text-sm font-bold border-b-2 ${state.pmTab === 'contract' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-ink'} transition-all" onclick="switchPMTab('contract')">Contract Text</button>
                        <button class="py-4 text-sm font-bold border-b-2 ${state.pmTab === 'operational' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-ink'} transition-all" onclick="switchPMTab('operational')">Operational Insights</button>
                        <button class="py-4 text-sm font-bold border-b-2 ${state.pmTab === 'actionItems' ? 'border-brass text-primary' : 'border-transparent text-muted hover:text-ink'} transition-all" onclick="switchPMTab('actionItems')">Action Items <span class="ml-1 bg-line px-1.5 py-0.5 rounded-full text-[10px] figures">${pmAnalysis.actionItems.length}</span></button>
                    </div>
                </div>

                <!-- Split Pane Workspace -->
                <div class="flex flex-1 overflow-hidden">
                    <!-- Left: Contract Viewer -->
                    <div class="flex-1 flex flex-col border-r border-line bg-surface overflow-hidden">
                        <div class="flex items-center justify-between px-6 py-3 border-b border-line">
                            ${sectionLabel('Contract Text')}
                        </div>
                        <div class="flex-1 p-8 overflow-y-auto custom-scrollbar leading-relaxed">
                            <div class="max-w-2xl mx-auto space-y-6">
                                <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                            </div>
                            ${renderExtractedTextPanel()}
                        </div>
                    </div>

                    <!-- Right: Operational Insights -->
                    <div class="w-[450px] xl:w-[500px] flex flex-col bg-paper overflow-y-auto custom-scrollbar p-6 space-y-6">
                        <!-- Section: Deliverables -->
                        <section>
                            <div class="flex items-center gap-2 mb-4">
                                <span class="material-symbols-outlined text-primary">inventory_2</span>
                                <h3 class="font-display font-semibold text-base text-ink">Key Deliverables</h3>
                            </div>
                            <div class="space-y-3">
                                ${pmAnalysis.deliverables.length > 0 ? pmAnalysis.deliverables.map((del, idx) => card(`
                                    <div class="p-4">
                                        <div class="flex justify-between items-start">
                                            <p class="text-sm font-bold text-ink">${escapeHtml(del.name)}</p>
                                            ${del.status ? `<span class="px-2 py-0.5 rounded-full bg-paper text-muted text-[10px] font-bold">${escapeHtml(del.status)}</span>` : ''}
                                        </div>
                                        <p class="text-xs text-muted mt-1">Due: ${displayField(del.due, 'Not specified')}</p>
                                        ${del.quote ? `
                                            <button class="text-[10px] text-muted hover:text-primary mt-2 flex items-center gap-1" onclick="toggleSourceRow('deliverable-${idx}')">
                                                <span class="material-symbols-outlined text-[12px]">visibility</span> Show source
                                            </button>
                                            <div id="src-deliverable-${idx}" class="hidden mt-1 px-2 py-1.5 bg-paper border border-line rounded text-[10px] text-muted italic">"${escapeHtml(del.quote)}"</div>
                                        ` : ''}
                                    </div>
                                `)).join('') : `<p class="text-xs text-muted italic">No deliverables are explicitly defined in the contract.</p>`}
                            </div>
                        </section>

                        <!-- Section: IP Usage Rights -->
                        <section>
                            <div class="flex items-center gap-2 mb-4">
                                <span class="material-symbols-outlined text-primary">verified_user</span>
                                <h3 class="font-display font-semibold text-base text-ink">IP Usage Rights</h3>
                            </div>
                            <div class="grid grid-cols-2 gap-3">
                                ${card(`
                                <div class="p-3">
                                    <p class="text-[10px] font-bold text-muted uppercase">Customer Data</p>
                                    <p class="text-sm font-bold text-ink">${displayField(pmAnalysis.ipRights.customerData, 'Not specified')}</p>
                                </div>
                                `)}
                                ${card(`
                                <div class="p-3">
                                    <p class="text-[10px] font-bold text-muted uppercase">SaaS Software</p>
                                    <p class="text-sm font-bold text-ink">${displayField(pmAnalysis.ipRights.saasSoftware, 'Not specified')}</p>
                                </div>
                                `)}
                                ${card(`
                                <div class="p-3">
                                    <p class="text-[10px] font-bold text-muted uppercase">Usage Restrictions</p>
                                    <p class="text-xs mt-1 text-ink">${displayField(pmAnalysis.ipRights.usageRestrictions, 'Not specified')}</p>
                                </div>
                                `, 'col-span-2')}
                            </div>
                        </section>

                        <!-- Section: Timelines -->
                        <section>
                            <div class="flex items-center gap-2 mb-4">
                                <span class="material-symbols-outlined text-primary">schedule</span>
                                <h3 class="font-display font-semibold text-base text-ink">Project Timelines</h3>
                            </div>
                            ${pmAnalysis.timelines.length > 0 ? `
                                <div class="relative pl-6 space-y-6 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-line">
                                    ${pmAnalysis.timelines.map((tl, i) => `
                                        <div class="relative">
                                            <div class="absolute -left-[19px] top-1 size-3 rounded-full bg-primary ring-4 ring-paper"></div>
                                            <p class="text-xs font-bold text-ink">${escapeHtml(tl.event)}</p>
                                            <p class="text-[11px] text-muted figures">${displayField(tl.date, 'Not specified')}</p>
                                            ${tl.quote ? `<p class="text-[10px] text-muted italic mt-1">"${escapeHtml(tl.quote)}"</p>` : ''}
                                        </div>
                                    `).join('')}
                                </div>
                            ` : `<p class="text-xs text-muted italic">No dates or milestones are specified in the contract.</p>`}
                        </section>

                        <!-- Section: Action Items -->
                        <section class="mt-4 pb-8">
                            <div class="flex items-center justify-between mb-4">
                                <div class="flex items-center gap-2">
                                    <span class="material-symbols-outlined text-primary">fact_check</span>
                                    <h3 class="font-display font-semibold text-base text-ink">Action Items</h3>
                                </div>
                            </div>
                            <div class="space-y-2">
                                ${pmAnalysis.actionItems.length > 0 ? pmAnalysis.actionItems.map(item => card(`
                                    <div class="flex items-center gap-3 p-3 group transition-colors">
                                        <div class="size-5 rounded border-2 border-line flex items-center justify-center text-transparent group-hover:text-primary transition-colors">
                                            <span class="material-symbols-outlined !text-[14px]">check</span>
                                        </div>
                                        <div class="flex-1">
                                            <p class="text-xs font-medium text-ink">${escapeHtml(item.task)}</p>
                                            <p class="text-[10px] text-muted">Assigned: ${displayField(item.assigned, 'Not specified')}</p>
                                        </div>
                                    </div>
                                `)).join('') : `<p class="text-xs text-muted italic">No action items are specified in the contract.</p>`}
                            </div>
                        </section>
                    </div>
                </div>
            </main>
        </div>
    `;
}

function renderChatView() {
    return `
        <main class="flex flex-1 overflow-hidden">
            <aside class="w-16 flex flex-col items-center py-6 gap-6 bg-surface border-r border-line">
                <div class="p-2 text-muted hover:text-primary cursor-pointer transition-colors" title="Home" onclick="navigateTo('upload')">
                    <span class="material-symbols-outlined text-2xl">home</span>
                </div>
                <div class="p-2 text-primary bg-primary/10 rounded-lg" title="Active Chat">
                    <span class="material-symbols-outlined text-2xl" style="font-variation-settings: 'FILL' 1;">chat_bubble</span>
                </div>
            </aside>

            <div class="flex-1 flex flex-col min-w-0">
                <div class="bg-surface border-b border-line px-6 py-3 flex flex-wrap justify-between items-center">
                    <div class="flex items-center gap-2 overflow-hidden">
                        <a class="text-muted hover:text-primary text-sm font-medium cursor-pointer" onclick="navigateTo('upload')">Contracts</a>
                        <span class="text-line">/</span>
                        <span class="text-ink text-sm font-bold truncate">${state.currentContract ? state.currentContract.name : 'Contract'}</span>
                    </div>
                </div>

                <div class="flex-1 flex overflow-hidden">
                    <section class="flex-[1.5] bg-paper overflow-y-auto p-8 border-r border-line flex flex-col">
                        <div class="bg-surface shadow-sm border border-line mx-auto max-w-4xl w-full p-12 text-ink leading-relaxed text-[15px] document-paper">
                                <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                        </div>
                        ${renderExtractedTextPanel()}
                    </section>

                    <section class="flex-1 bg-surface flex flex-col shadow-sm z-10">
                        <div class="px-6 py-4 border-b border-line flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div class="size-8 rounded-full bg-primary/20 text-primary flex items-center justify-center">
                                    <span class="material-symbols-outlined text-xl" style="font-variation-settings: 'FILL' 1;">smart_toy</span>
                                </div>
                                <div>
                                    <h3 class="font-display text-sm font-bold text-ink">AI Contract Specialist</h3>
                                    <div class="flex items-center gap-1.5">
                                        <span class="size-1.5 bg-[#1E7F5C] rounded-full"></span>
                                        <span class="text-[10px] text-muted font-medium uppercase tracking-tight">Contract Grounded</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="flex-1 overflow-y-auto p-6 space-y-6" id="chatMessages">
                            ${state.chatMessages.length === 0 ? `
                                <div class="text-center py-8">
                                    <div class="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                                        <span class="material-symbols-outlined text-4xl text-primary">smart_toy</span>
                                    </div>
                                    <h3 class="font-display text-lg font-bold text-ink mb-2">Ask about this contract</h3>
                                    <p class="text-sm text-muted">I can help you understand clauses, risks, and implications across this contract.</p>
                                </div>
                            ` : state.chatMessages.map((msg, index) => renderChatMessage(msg, index)).join('')}
                        </div>

                        <div class="p-6 border-t border-line">
                            <div class="flex flex-col gap-3">
                                <div class="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                                    <button class="whitespace-nowrap bg-transparent hover:bg-paper text-muted text-[11px] px-3 py-1.5 rounded-full border border-line transition-all" onclick="sendQuickQuestion('Explain termination rights')">
                                        Explain termination rights
                                    </button>
                                    <button class="whitespace-nowrap bg-transparent hover:bg-paper text-muted text-[11px] px-3 py-1.5 rounded-full border border-line transition-all" onclick="sendQuickQuestion('What are the financial risks?')">
                                        Risk of non-payment
                                    </button>
                                    <button class="whitespace-nowrap bg-transparent hover:bg-paper text-muted text-[11px] px-3 py-1.5 rounded-full border border-line transition-all" onclick="sendQuickQuestion('What about subcontractor terms?')">
                                        Subcontractor terms
                                    </button>
                                </div>
                                <div class="relative group">
                                    <textarea id="chatInput" class="w-full bg-paper border border-line rounded-xl py-3 pl-4 pr-12 text-sm text-ink placeholder:text-muted focus:ring-2 focus:ring-brass/40 focus:border-brass resize-none transition-all" placeholder="Ask a follow-up question..." rows="2" onkeydown="handleChatKeydown(event)"></textarea>
                                    <button class="absolute right-3 bottom-3 size-8 bg-primary text-white rounded-lg flex items-center justify-center shadow-sm hover:bg-primary/90 transition-all" onclick="handleSendChatMessage()">
                                        <span class="material-symbols-outlined text-xl">send</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </main>
    `;
}

function truncateForChip(str, maxLen = 60) {
    const s = String(str || '');
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

// Phase 3: all model/user content is escaped before interpolation (fixes a
// latent XSS/markup-break — this used to go straight into innerHTML), with
// newlines rendered as <br> after escaping so multi-line streamed answers
// display correctly.
function renderChatMessage(msg, index) {
    if (msg.role === 'user') {
        const contentHtml = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
        return `
            <div class="flex flex-col items-end">
                <div class="bg-primary text-white p-4 rounded-lg rounded-tr-none max-w-[85%] shadow-sm">
                    <p class="text-sm">${contentHtml}</p>
                </div>
                <span class="text-[10px] text-muted mt-1 mr-1">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        `;
    }

    // Streaming with no content yet: same "thinking" affordance the old
    // isLoading state used. Once the first token lands, content is
    // non-empty and falls through to the normal streaming render below.
    if ((msg.isLoading) || (msg.streaming && !msg.content)) {
        return `
            <div class="flex flex-col items-start">
                <div class="bg-surface border border-line p-5 rounded-lg rounded-tl-none max-w-[95%] shadow-sm">
                    <div class="flex items-center gap-3">
                        <div class="loading-spinner"></div>
                        <p class="text-sm text-muted">Preparing response...</p>
                    </div>
                </div>
            </div>
        `;
    }

    const contentHtml = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
    const citations = Array.isArray(msg.citations) ? msg.citations : [];
    const implications = Array.isArray(msg.implications) ? msg.implications : [];

    return `
        <div class="flex flex-col items-start">
            <div class="bg-surface border border-line p-5 rounded-lg rounded-tl-none max-w-[95%] shadow-sm">
                <p class="text-sm text-ink leading-relaxed mb-4"${msg.streaming ? ' id="streaming-msg-content"' : ''}>${contentHtml}${msg.streaming ? '<span class="inline-block w-1.5 h-4 bg-primary/60 ml-0.5 align-middle animate-pulse"></span>' : ''}</p>
                ${citations.length > 0 ? `
                    <div class="flex flex-wrap gap-1.5 mb-3">
                        ${citations.map((c, ci) => `
                            <button class="seal cursor-pointer hover:bg-brass/15 transition-colors" onclick="revealCitation(${index}, ${ci})" title="${escapeHtml(c.quote)}">
                                <span class="material-symbols-outlined">policy</span>${escapeHtml(truncateForChip(c.quote))}
                            </button>
                        `).join('')}
                    </div>
                ` : ''}
                ${implications.length > 0 ? `
                    <h4 class="text-xs font-bold text-ink uppercase mb-2">Key Implications:</h4>
                    <ul class="text-sm text-ink space-y-2 list-disc pl-4">
                        ${implications.map(imp => `<li>${escapeHtml(imp)}</li>`).join('')}
                    </ul>
                ` : ''}
                ${msg.interrupted ? `<p class="text-[11px] text-[#B45309] mt-2 italic">Response interrupted before completion.</p>` : ''}
            </div>
            ${!msg.streaming ? `
                <div class="mt-3 flex gap-2">
                    <button class="flex items-center gap-1 px-2.5 py-1 rounded border border-line hover:bg-paper text-[11px] text-muted transition-colors" onclick="copyChatMessage(${index})">
                        <span class="material-symbols-outlined text-sm">content_copy</span> Copy for Report
                    </button>
                </div>
            ` : ''}
        </div>
    `;
}

// Immune to quotes/newlines/apostrophes in the message content — replaces
// the old inline onclick="copyToClipboard('${content...}')" pattern, which
// broke on multi-line streamed answers and unescaped apostrophes.
function copyChatMessage(index) {
    const msg = state.chatMessages[index];
    if (!msg) return;
    copyToClipboard(msg.content || '');
}

function renderLoadingView() {
    return `
        <main class="flex-1 flex items-center justify-center">
            <div class="text-center">
                <div class="loading-spinner mx-auto mb-4"></div>
                <h2 class="font-display text-xl font-bold text-ink mb-2">Analyzing contract…</h2>
                <p class="text-muted text-sm mb-4">Our AI is reviewing your document and generating insights.</p>
                <ul class="text-xs text-muted space-y-1">
                    <li>Extracting document text</li>
                    <li>Indexing clauses for retrieval</li>
                    <li>Analyzing risk, compliance, and obligations</li>
                </ul>
            </div>
        </main>
    `;
}

function renderFooter() {
    return '';
}

// Helper function
function getRoleDescription(role) {
    const descriptions = {
        Investor: 'Financial exposure, ROI impact, and risk assessment',
        Legal: 'Compliance, liability, governing law, and clause nuance',
        PM: 'Deliverables, timelines, IP rights, and operational requirements',
        Partner: 'Executive overview across legal, financial, and operational signals',
        HR: 'Employment terms, confidentiality, and data privacy'
    };
    return descriptions[role] || 'Comprehensive contract analysis';
}

// Event Handlers
async function selectRole(role) {
    state.selectedRole = role;
    if (state.currentContract) {
        state.isLoading = true;
        render();
        try {
            await updateContractRole(state.currentContract.id, role);
            pollAnalysis(state.currentContract.id, (analysis) => {
                if (analysis) {
                    state.currentAnalysis = analysis;
                    state.isLoading = false;
                    switch (role) {
                        case 'Investor': state.currentView = 'investor'; break;
                        case 'Legal': state.currentView = 'legal'; break;
                        case 'PM': state.currentView = 'pm'; break;
                        case 'Partner': state.currentView = 'partner'; break;
                        default: state.currentView = 'chat'; break;
                    }
                    render();
                } else {
                    state.isLoading = false;
                    showToast('Analysis failed or timed out. Please try again.');
                    render();
                }
            });
        } catch (error) {
            console.error('Failed to switch role', error);
            state.isLoading = false;
            render();
        }
    } else {
        render();
    }
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        uploadFile(file);
    }
}

async function uploadFile(file) {
    try {
        state.isLoading = true;
        render();

        const result = await uploadContract(file, state.selectedRole);
        state.currentContract = result;
        state.contracts.unshift(result);
        resetExtractedTextState();
        state.chatMessages = []; // a brand-new contract always starts with an empty conversation
        state.highlightQuote = null;

        // Poll for analysis completion
        pollAnalysis(result.id, (analysis) => {
            if (analysis) {
                state.currentAnalysis = analysis;
                state.isLoading = false;

                // Navigate to chat view (everyone can use AI chat)
                state.currentView = 'chat';
                render();
            } else {
                state.isLoading = false;
                showToast('Analysis failed or timed out. Please try again.');
                render();
            }
        });

        render();
    } catch (error) {
        console.error('Upload failed:', error);
        alert('Failed to upload file. Please try again.');
        state.isLoading = false;
        render();
    }
}

async function handleVersionSelected(event) {
    const file = event.target.files[0];
    if (file && state.currentContract) {
        try {
            state.isLoading = true;
            render();
            const result = await uploadNewVersionAPI(state.currentContract.id, file);

            // update local state
            const contractIndex = state.contracts.findIndex(c => c.id === result.id);
            if (contractIndex !== -1) {
                state.contracts[contractIndex] = result;
            }
            state.currentContract = result;
            resetExtractedTextState();

            // Poll for new analysis
            pollAnalysis(result.id, (analysis) => {
                if (analysis) {
                    state.currentAnalysis = analysis;
                    state.isLoading = false;
                    render();
                    showToast('New version analyzed successfully!');
                } else {
                    state.isLoading = false;
                    showToast('Failed to analyze new version. Please try again.');
                    render();
                }
            });
        } catch (error) {
            console.error('Version upload failed:', error);
            showToast('Failed to upload new version.');
            state.isLoading = false;
            render();
        }
    }
}

async function openContract(contractId) {
    const contract = state.contracts.find(c => c.id === contractId);
    if (contract) {
        state.currentContract = contract;
        resetExtractedTextState();
        state.highlightQuote = null;
        if (contract.role) {
            state.selectedRole = contract.role;
        }

        // Phase 4: load this contract's persisted conversation instead of
        // always starting empty. Set before render() so the loading view
        // (if any) doesn't briefly flash the previous contract's messages.
        state.chatMessages = [];
        getChatHistory(contractId).then((messages) => {
            if (state.currentContract?.id === contractId) {
                state.chatMessages = messages;
                render();
            }
        });

        switch (state.selectedRole) {
            case 'Investor': state.currentView = 'investor'; break;
            case 'Legal': state.currentView = 'legal'; break;
            case 'PM': state.currentView = 'pm'; break;
            case 'Partner': state.currentView = 'partner'; break;
            default: state.currentView = 'chat'; break;
        }

        state.isLoading = true;
        render();

        pollAnalysis(contractId, (analysis) => {
            if (analysis) {
                state.currentAnalysis = analysis;
                state.isLoading = false;
                render();
            } else {
                state.isLoading = false;
                showToast('Analysis failed or timed out. Please try again.');
                render();
            }
        });
    }
}

function navigateTo(view) {
    state.currentView = view;
    render();
}

async function handleSendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();

    if (!message || !state.currentContract) return;

    // Captured BEFORE pushing the current user message, so it isn't
    // included in its own conversation history.
    const history = buildChatHistoryPayload();

    state.chatMessages.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    input.value = '';
    render();

    const loadingMessage = {
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        streaming: true
    };
    state.chatMessages.push(loadingMessage);
    render();

    try {
        const result = await streamChatMessageAPI(state.currentContract.id, message, state.selectedRole, history, {
            onToken: (text) => {
                loadingMessage.content += text;
                // Direct DOM write per token — no full render() per token.
                // If the node is missing (user navigated away mid-stream),
                // state still accumulates and the next render() catches up.
                const node = document.getElementById('streaming-msg-content');
                if (node) {
                    node.innerHTML = escapeHtml(loadingMessage.content).replace(/\n/g, '<br>');
                }
            }
        });

        if (result.message) {
            Object.assign(loadingMessage, result.message, { streaming: false });
        } else if (result.interrupted) {
            Object.assign(loadingMessage, {
                streaming: false,
                interrupted: true,
                citations: loadingMessage.citations || [],
                implications: loadingMessage.implications || []
            });
        }
        render();
        document.getElementById('chatInput')?.focus();
    } catch (streamError) {
        // Nothing streamed yet — transparently fall back to the
        // non-streaming endpoint rather than surfacing an error.
        console.warn('Streaming chat failed, falling back to non-streaming:', streamError);
        try {
            const response = await sendChatMessageAPI(state.currentContract.id, message, state.selectedRole, history);
            Object.assign(loadingMessage, response, { timestamp: new Date().toISOString(), streaming: false });
        } catch (fallbackError) {
            console.error('Chat error:', fallbackError);
            Object.assign(loadingMessage, {
                role: 'assistant',
                content: 'Sorry, I encountered an error. Please try again.',
                timestamp: new Date().toISOString(),
                streaming: false
            });
        }
        render();
    }
}

function sendQuickQuestion(question) {
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.value = question;
        handleSendChatMessage();
    }
}

function handleChatKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSendChatMessage();
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!');
    });
}

// Toast notification
function showToast(message) {
    // Remove existing toast
    const existingToast = document.getElementById('toast-notification');
    if (existingToast) {
        existingToast.remove();
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white px-6 py-3 rounded-lg shadow-xl text-sm font-medium animate-fade-in-up transition-all';
    toast.textContent = message;

    document.body.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%, 20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Drag and Drop Setup
function setupDragAndDrop() {
    const dropzone = document.getElementById('dropzone');
    if (!dropzone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => {
            dropzone.classList.add('border-primary', 'bg-primary/5');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => {
            dropzone.classList.remove('border-primary', 'bg-primary/5');
        }, false);
    });

    dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            uploadFile(files[0]);
        }
    }, false);
}

// Setup click handlers after render
function setupClickHandlers() {
    // Handle file input clicks
    document.querySelectorAll('[data-file-upload]').forEach(el => {
        el.addEventListener('click', () => {
            const fileInput = document.getElementById('fileInput');
            if (fileInput) {
                fileInput.click();
            }
        });
    });

    // Handle file input change
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }
}

// Main Render Function
function render() {
    const app = document.getElementById('app');

    let content = '';
    content += renderHeader();

    switch (state.currentView) {
        case 'upload':
            content += renderUploadView();
            break;
        case 'investor':
            content += renderInvestorView();
            break;
        case 'legal':
            content += renderLegalView();
            break;
        case 'pm':
            content += renderPMView();
            break;
        case 'partner':
            content += renderPartnerView();
            break;
        case 'chat':
            content += renderChatView();
            break;
        default:
            content += renderUploadView();
    }

    content += renderFooter();

    app.innerHTML = content;

    // Re-setup drag and drop if on upload view
    if (state.currentView === 'upload') {
        setupDragAndDrop();
        setupClickHandlers();
    }

    // Scroll chat to bottom
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

// Initialize
async function init() {
    await fetchContracts();
    render();
}

// Start app
document.addEventListener('DOMContentLoaded', init);
