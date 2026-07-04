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
    if (state.showExtractedText && !state.extractedText && !state.isExtractedTextLoading) {
        loadExtractedText();
        return;
    }
    render();
}

function renderExtractedTextPanel() {
    const hasText = Boolean(state.extractedText);
    const description = state.extractedTextError
        ? `<p class="text-xs text-red-600">${escapeHtml(state.extractedTextError)}</p>`
        : `<p class="text-xs text-slate-500">Use the extracted text to verify numeric figures and clause references.</p>`;

    return `
        <div class="w-full mt-6">
            <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                    <h4 class="text-xs font-bold uppercase text-slate-400 tracking-widest">Extracted Text</h4>
                    <button class="text-xs font-semibold text-primary hover:underline" onclick="toggleExtractedText()">
                        ${state.showExtractedText ? 'Hide' : 'Show'}
                    </button>
                </div>
                <div class="px-4 py-3">
                    ${description}
                </div>
                ${state.showExtractedText ? `
                    <div class="border-t border-slate-200 dark:border-slate-800">
                        ${state.isExtractedTextLoading ? `
                            <div class="p-4 flex items-center gap-3">
                                <div class="loading-spinner"></div>
                                <span class="text-xs text-slate-500">Loading extracted text...</span>
                            </div>
                        ` : `
                            <pre class="p-4 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-[320px] overflow-y-auto custom-scrollbar">${escapeHtml(hasText ? state.extractedText : 'No extracted text available.')}</pre>
                        `}
                    </div>
                ` : ''}
            </div>
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

async function sendChatMessageAPI(contractId, message, role) {
    try {
        const response = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contractId, message, role: role || state.selectedRole })
        });
        return await response.json();
    } catch (error) {
        console.error('Error sending chat message:', error);
        throw error;
    }
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
        <header class="flex items-center justify-between whitespace-nowrap border-b border-solid border-[#e7edf3] dark:border-slate-800 px-10 py-3 bg-white dark:bg-[#1a242f] sticky top-0 z-50">
            <div class="flex items-center gap-8">
                <div class="flex items-center gap-4 text-primary cursor-pointer" onclick="navigateTo('upload')">
                    <div class="size-6">
                        <svg fill="none" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                            <path d="M24 45.8096C19.6865 45.8096 15.4698 44.5305 11.8832 42.134C8.29667 39.7376 5.50128 36.3314 3.85056 32.3462C2.19985 28.361 1.76794 23.9758 2.60947 19.7452C3.451 15.5145 5.52816 11.6284 8.57829 8.5783C11.6284 5.52817 15.5145 3.45101 19.7452 2.60948C23.9758 1.76795 28.361 2.19986 32.3462 3.85057C36.3314 5.50129 39.7376 8.29668 42.134 11.8833C44.5305 15.4698 45.8096 19.6865 45.8096 24L24 24L24 45.8096Z" fill="currentColor"></path>
                        </svg>
                    </div>
                    <h2 class="text-[#0d141b] dark:text-slate-50 text-xl font-bold leading-tight tracking-[-0.015em]">Contract Analysis</h2>
                </div>
                <!-- Generated Nav Links -->
                <nav class="hidden md:flex gap-6">
                    ${Object.entries(navLinks).map(([key, link]) => `
                        <a onclick="navigateTo('${key}')" class="text-sm font-medium ${link.active ? 'text-primary' : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-300'} cursor-pointer transition-colors">
                            ${link.text}
                        </a>
                    `).join('')}
                </nav>
            </div>
            <div class="flex flex-1 justify-end gap-8">
                <div class="flex items-center gap-4">
                    ${state.currentContract ? `
                        <div class="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-lg">
                            <span class="material-symbols-outlined text-primary text-sm">description</span>
                            <span class="text-sm font-medium text-primary truncate max-w-[200px]">${state.currentContract.name}</span>
                        </div>
                    ` : ''}
                </div>
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
                    <h1 class="text-[#0d141b] dark:text-slate-50 text-4xl md:text-5xl font-black leading-tight tracking-[-0.033em]">Contract Analysis</h1>
                    <p class="text-[#4c739a] dark:text-slate-400 text-lg font-normal leading-normal max-w-2xl">
                        Upload a contract to generate analysis across Investor, Legal, PM, Partner, and HR perspectives.
                    </p>
                </div>

                <!-- Enhanced Dropzone -->
                <div class="flex flex-col">
                    <input type="file" id="fileInput" accept=".pdf,.docx,.doc,.txt" style="display: none;">
                    <div id="dropzone" class="flex flex-col items-center gap-6 rounded-xl border-2 border-dashed border-[#cfdbe7] dark:border-slate-700 bg-white dark:bg-[#1a242f] px-6 py-16 hover:border-primary transition-colors cursor-pointer group" data-file-upload>
                        <div class="flex flex-col items-center gap-4">
                            <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                                <span class="material-symbols-outlined text-4xl">cloud_upload</span>
                            </div>
                            <div class="flex max-w-[480px] flex-col items-center gap-2">
                                <p class="text-[#0d141b] dark:text-slate-50 text-xl font-bold leading-tight tracking-[-0.015em] text-center">Drag and drop your contract here</p>
                                <p class="text-[#4c739a] dark:text-slate-400 text-sm font-normal leading-normal text-center">Supports PDF, DOCX, DOC, and TXT (Max 50MB per file)</p>
                            </div>
                        </div>
                        <div class="flex gap-3">
                            <button class="flex min-w-[120px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-11 px-5 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90 transition-all shadow-lg shadow-primary/20" data-file-upload>
                                <span class="truncate">Upload File</span>
                            </button>
                            <button class="flex min-w-[120px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-11 px-5 bg-[#e7edf3] dark:bg-slate-800 text-[#0d141b] dark:text-slate-50 text-sm font-bold leading-normal tracking-[0.015em] hover:bg-[#d1dae5] dark:hover:bg-slate-700 transition-all" data-file-upload>
                                <span class="truncate">Browse Local</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Recent Files List -->
                <div class="flex flex-col gap-4 mt-4">
                    <div class="flex justify-between items-center px-1">
                        <h3 class="text-[#0d141b] dark:text-slate-50 text-lg font-bold">Recent Documents</h3>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        ${state.contracts.length === 0 ? '<p class="text-[#4c739a] dark:text-slate-500 text-sm">No documents uploaded yet.</p>' : state.contracts.map(contract => renderRecentFileCard(contract)).join('')}
                    </div>
                </div>
            </div>
        </main>
    `;
}

function renderRecentFileCard(contract) {
    const isPDF = contract.fileName.toLowerCase().endsWith('.pdf');
    const iconClass = isPDF ? 'picture_as_pdf' : 'description';
    const bgClass = isPDF ? 'bg-red-100 dark:bg-red-900/30 text-red-600' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600';

    return `
        <div class="flex items-center gap-4 p-4 rounded-xl bg-white dark:bg-[#1a242f] border border-[#e7edf3] dark:border-slate-800 hover:shadow-md transition-shadow cursor-pointer" onclick="openContract('${contract.id}')">
            <div class="size-10 flex items-center justify-center ${bgClass} rounded-lg">
                <span class="material-symbols-outlined">${iconClass}</span>
            </div>
            <div class="flex flex-col flex-1 min-w-0">
                <p class="text-sm font-bold text-[#0d141b] dark:text-slate-50 truncate">${contract.name}</p>
                <p class="text-xs text-[#4c739a] dark:text-slate-400">${formatDate(contract.uploadDate)} • ${formatFileSize(contract.fileSize)}</p>
            </div>
        </div>
    `;
}

function renderInvestorView() {
    if (!state.currentAnalysis) {
        return renderLoadingView();
    }

    const analysis = state.currentAnalysis;

    // Use analysis data directly
    const investorAnalysis = analysis;
    const flaggedClauses = Array.isArray(investorAnalysis.enforceabilityRisks) ? investorAnalysis.enforceabilityRisks.length : 0;
    const totalClauses = investorAnalysis.totalClauses || investorAnalysis.clauses || 0;
    const lgdScore = Number(investorAnalysis.lgdScore) || 0;
    const complianceScore = typeof investorAnalysis.complianceScore === 'number'
        ? `${investorAnalysis.complianceScore}%`
        : (investorAnalysis.investorCompliance || 'N/A');
    const clauseItems = Array.isArray(investorAnalysis.enforceabilityRisks) && investorAnalysis.enforceabilityRisks.length > 0
        ? investorAnalysis.enforceabilityRisks
        : (Array.isArray(investorAnalysis.riskFactors) ? investorAnalysis.riskFactors : []);

    return `
        <main class="flex-1 flex flex-col max-w-[1800px] overflow-hidden mx-auto w-full px-4 sm:px-10 py-6 gap-6">
            <div class="flex flex-col gap-1 shrink-0">
                <div class="flex items-center gap-2 text-sm text-[#4c739a]">
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Investor View</a>
                    <span>/</span>
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Contract Analysis</a>
                    <span>/</span>
                    <span class="text-[#0d141b] dark:text-white font-medium">${state.currentContract.name}</span>
                </div>
                <div class="flex flex-wrap justify-between items-end gap-4 mt-2">
                    <div class="flex flex-col gap-1">
                        <h1 class="text-3xl font-black tracking-tight text-[#0d141b] dark:text-white">${state.currentContract.name}</h1>
                        <p class="text-[#4c739a] text-sm">Last updated ${formatDate(state.currentContract.uploadDate)}</p>
                    </div>
                </div>
            </div>

            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm border-l-4 border-l-red-500">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Total Financial Exposure</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${investorAnalysis.financialExposure}</p>
                    </div>
                    <p class="text-[#4c739a] text-xs">${investorAnalysis.riskExplanation || 'Relevant monetary sum (LLM-selected)'}</p>
                </div>
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Loss Given Default (LGD)</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${lgdScore}%</p>
                    </div>
                    <div class="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full mt-1">
                        <div class="bg-primary h-full rounded-full" style="width: ${lgdScore}%"></div>
                    </div>
                    ${investorAnalysis.llmComments ? `<p class="text-[10px] text-amber-600 dark:text-amber-400 mt-2 font-medium italic">${investorAnalysis.llmComments}</p>` : ''}
                </div>
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Ambiguous Clauses</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${flaggedClauses}</p>
                    </div>
                    <p class="text-[#4c739a] text-xs">Flagged out of ${totalClauses || 'N/A'} clauses</p>
                </div>
            </div>

            <div class="flex-1 flex gap-6 min-h-[600px] overflow-hidden">
                <!-- Document Viewer -->
                <div class="flex-[3] flex flex-col bg-white dark:bg-slate-900 rounded-xl border border-[#cfdbe7] dark:border-slate-800 shadow-sm overflow-hidden">
                    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                        <div class="flex items-center gap-4">
                            <span class="text-sm font-bold">${state.currentContract.name}.pdf</span>
                        </div>
                    </div>
                    <div class="flex-1 overflow-y-auto p-12 custom-scrollbar bg-slate-50 dark:bg-slate-950/50">
                        <div class="max-w-3xl mx-auto bg-white dark:bg-slate-900 shadow-2xl p-16 min-h-full prose dark:prose-invert">
                            <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                        </div>
                        ${renderExtractedTextPanel()}
                    </div>
                </div>

                <!-- Risk Analysis Sidebar -->
                <div class="flex-[2] flex flex-col gap-4 overflow-hidden min-w-[350px]">
                    <div class="bg-white dark:bg-slate-900 rounded-xl border border-[#cfdbe7] dark:border-slate-800 overflow-hidden shrink-0">
                        <div class="flex border-b border-slate-100 dark:border-slate-800">
                            <button class="flex-1 py-3 text-sm font-bold border-b-2 ${state.investorTab === 'insights' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-primary'}" onclick="switchInvestorTab('insights')">Investor Insights</button>
                            <button class="flex-1 py-3 text-sm font-bold border-b-2 ${state.investorTab === 'financial' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-primary'}" onclick="switchInvestorTab('financial')">Financial Exposure</button>
                        </div>
                        ${state.investorTab === 'insights' ? `
                            <div class="p-4 flex gap-2 overflow-x-auto no-scrollbar">
                                ${clauseItems.map(item => `
                                    <span class="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold rounded-full whitespace-nowrap">${item.title}</span>
                                `).join('')}
                            </div>
                        ` : `
                            <div class="p-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                                <h4 class="text-xs font-bold uppercase text-slate-400 tracking-widest mb-3">Financial Breakdown</h4>
                                <div class="space-y-4">
                                    ${analysis.numericFigures.risks.length > 0 ? `
                                        <div>
                                            <p class="text-[10px] font-bold text-red-500 uppercase mb-2">Identified Risks</p>
                                            <div class="space-y-2">
                                                ${analysis.numericFigures.risks.map(r => `
                                                    <div class="flex justify-between items-start p-2 bg-red-50 dark:bg-red-950/20 rounded border border-red-100 dark:border-red-900/30">
                                                        <div class="min-w-0 pr-2">
                                                            <p class="text-[11px] font-bold text-slate-900 dark:text-slate-100 truncate">${r.raw}</p>
                                                            <p class="text-[10px] text-slate-500 line-clamp-1">${r.reason}</p>
                                                        </div>
                                                        <span class="text-[11px] font-black text-red-600 whitespace-nowrap">$${new Intl.NumberFormat().format(r.amount)}</span>
                                                    </div>
                                                `).join('')}
                                            </div>
                                        </div>
                                    ` : ''}

                                    ${analysis.numericFigures.obligations.length > 0 ? `
                                        <div>
                                            <p class="text-[10px] font-bold text-primary uppercase mb-2">Obligations</p>
                                            <div class="space-y-2">
                                                ${analysis.numericFigures.obligations.map(o => `
                                                    <div class="flex justify-between items-start p-2 bg-slate-50 dark:bg-slate-800 rounded border border-slate-100 dark:border-slate-700">
                                                        <div class="min-w-0 pr-2">
                                                            <p class="text-[11px] font-bold text-slate-900 dark:text-slate-100 truncate">${o.raw}</p>
                                                            <p class="text-[10px] text-slate-500 line-clamp-1">${o.reason}</p>
                                                        </div>
                                                        <span class="text-[11px] font-black text-primary whitespace-nowrap">$${new Intl.NumberFormat().format(o.amount)}</span>
                                                    </div>
                                                `).join('')}
                                            </div>
                                        </div>
                                    ` : ''}

                                    <div class="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-2">
                                        <div class="flex justify-between items-center">
                                            <span class="text-xs font-bold text-slate-500">Total Potential Loss</span>
                                            <span class="text-sm font-black text-red-600">$${new Intl.NumberFormat().format(analysis.numericFigures.totalPotentialLoss)}</span>
                                        </div>
                                        <div class="flex justify-between items-center">
                                            <span class="text-xs font-bold text-slate-500">Total Amount Owed</span>
                                            <span class="text-sm font-black text-primary">$${new Intl.NumberFormat().format(analysis.numericFigures.totalAmountOwed)}</span>
                                        </div>
                                        <div class="flex justify-between items-center p-2 bg-slate-900 dark:bg-white rounded-lg">
                                            <span class="text-xs font-bold text-slate-300 dark:text-slate-600">LGD Percentage</span>
                                            <span class="text-sm font-black text-white dark:text-slate-900">${analysis.lgdScore}%</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `}
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4 pb-4">
                                                    ${clauseItems.map(item => `
                            <div class="flex flex-col gap-3">
                                <h4 class="text-xs font-bold uppercase text-slate-400 tracking-widest px-1">Clause ${item.section || '—'}: Summary</h4>
                                <div class="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm border-l-4 border-l-primary hover:shadow-md transition-shadow">
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-xs font-bold text-slate-500 uppercase">Clause ${item.section || '—'}</span>
                                        ${item.financialImpact ? `<span class="text-xs font-semibold text-primary">Impact: ${item.financialImpact}</span>` : ''}
                                    </div>
                                    <h5 class="text-sm font-bold mb-1">${item.title}</h5>
                                    <p class="text-xs text-slate-600 dark:text-slate-400 mb-3">${item.description}</p>
                                    <div class="flex items-center gap-1 mt-auto pt-3 border-t border-slate-50 dark:border-slate-800">
                                        <span class="material-symbols-outlined text-xs text-primary">attach_money</span>
                                        <span class="text-xs font-bold">${item.financialImpact || '—'}</span>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
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
    const totalClauses = analysis.totalClauses || analysis.clauses || 0;
    const lgdScore = Number(analysis.lgdScore) || 0;
    const complianceScore = typeof analysis.complianceScore === 'number'
        ? `${analysis.complianceScore}%`
        : (analysis.investorCompliance || 'N/A');
    const deliverableCount = Array.isArray(analysis.deliverables) ? analysis.deliverables.length : 0;
    const actionItemCount = Array.isArray(analysis.actionItems) ? analysis.actionItems.length : 0;
    const timelineCount = Array.isArray(analysis.timelines) ? analysis.timelines.length : 0;
    const clauseFlags = Array.isArray(analysis.enforceabilityRisks) ? analysis.enforceabilityRisks : [];
    const complianceChecks = Array.isArray(analysis.complianceChecks) ? analysis.complianceChecks : [];
    const compliancePassCount = complianceChecks.filter(check => check.status === 'pass').length;

    return `
        <main class="flex-1 flex flex-col max-w-[1800px] overflow-hidden mx-auto w-full px-4 sm:px-10 py-6 gap-6">
            <div class="flex flex-col gap-1 shrink-0">
                <div class="flex items-center gap-2 text-sm text-[#4c739a]">
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Partner View</a>
                    <span>/</span>
                    <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Contract Overview</a>
                    <span>/</span>
                    <span class="text-[#0d141b] dark:text-white font-medium">${state.currentContract.name}</span>
                </div>
                <div class="flex flex-wrap justify-between items-end gap-4 mt-2">
                    <div class="flex flex-col gap-1">
                        <h1 class="text-3xl font-black tracking-tight text-[#0d141b] dark:text-white">${state.currentContract.name}</h1>
                        <p class="text-[#4c739a] text-sm">Overview of financial, legal, and operational signals</p>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm border-l-4 border-l-red-500">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Total Financial Exposure</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${analysis.financialExposure}</p>
                    </div>
                    <p class="text-[#4c739a] text-xs">${analysis.riskExplanation || 'Relevant monetary sum (LLM-selected)'}</p>
                </div>
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Compliance Score</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${complianceScore}</p>
                    </div>
                    <p class="text-[#4c739a] text-xs">Policy coverage across key areas</p>
                </div>
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Loss Given Default (LGD)</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${lgdScore}%</p>
                    </div>
                    <div class="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full mt-1">
                        <div class="bg-primary h-full rounded-full" style="width: ${lgdScore}%"></div>
                    </div>
                    ${analysis.llmComments ? `<p class="text-[10px] text-amber-600 dark:text-amber-400 mt-2 font-medium italic">${analysis.llmComments}</p>` : ''}
                </div>
                <div class="flex flex-col gap-2 rounded-xl p-5 bg-white dark:bg-slate-900 border border-[#cfdbe7] dark:border-slate-800 shadow-sm">
                    <p class="text-[#4c739a] text-xs font-semibold uppercase tracking-wider">Ambiguous Clauses</p>
                    <div class="flex items-baseline gap-2">
                        <p class="text-[#0d141b] dark:text-white text-3xl font-bold">${flaggedClauses}</p>
                    </div>
                    <p class="text-[#4c739a] text-xs">Flagged out of ${totalClauses || 'N/A'} clauses</p>
                </div>
            </div>

            <div class="flex-1 flex gap-6 min-h-[600px] overflow-hidden">
                <div class="flex-[3] flex flex-col bg-white dark:bg-slate-900 rounded-xl border border-[#cfdbe7] dark:border-slate-800 shadow-sm overflow-hidden">
                    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                        <div class="flex items-center gap-4">
                            <span class="text-sm font-bold">${state.currentContract.name}.pdf</span>
                        </div>
                    </div>
                    <div class="flex-1 overflow-y-auto p-12 custom-scrollbar bg-slate-50 dark:bg-slate-950/50">
                        <div class="max-w-3xl mx-auto bg-white dark:bg-slate-900 shadow-2xl p-16 min-h-full prose dark:prose-invert">
                            <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                        </div>
                        ${renderExtractedTextPanel()}
                    </div>
                </div>

                <div class="flex-[2] flex flex-col gap-4 overflow-hidden min-w-[350px]">
                    <div class="bg-white dark:bg-slate-900 rounded-xl border border-[#cfdbe7] dark:border-slate-800 overflow-hidden shrink-0">
                        <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
                            <h4 class="text-xs font-bold uppercase text-slate-400 tracking-widest">Operational Snapshot</h4>
                        </div>
                        <div class="p-4 grid grid-cols-3 gap-3 text-center">
                            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                                <p class="text-[10px] uppercase text-slate-400 font-bold">Deliverables</p>
                                <p class="text-lg font-bold text-slate-900 dark:text-white">${deliverableCount}</p>
                            </div>
                            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                                <p class="text-[10px] uppercase text-slate-400 font-bold">Action Items</p>
                                <p class="text-lg font-bold text-slate-900 dark:text-white">${actionItemCount}</p>
                            </div>
                            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                                <p class="text-[10px] uppercase text-slate-400 font-bold">Milestones</p>
                                <p class="text-lg font-bold text-slate-900 dark:text-white">${timelineCount}</p>
                            </div>
                        </div>
                    </div>

                    <div class="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4 pb-4">
                        <div class="flex flex-col gap-3">
                            <h4 class="text-xs font-bold uppercase text-slate-400 tracking-widest px-1">Clause Flags</h4>
                            ${clauseFlags.length === 0 ? `
                                <div class="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                                    <p class="text-xs text-slate-500">No clause flags detected.</p>
                                </div>
                            ` : clauseFlags.map(flag => `
                                <div class="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
                                    <div class="flex justify-between items-start mb-2">
                                        <span class="text-[10px] uppercase text-slate-400 font-bold">Clause ${flag.section || '—'}</span>
                                        <span class="material-symbols-outlined text-slate-300 text-sm">flag</span>
                                    </div>
                                    <h5 class="text-sm font-bold mb-1">${flag.title}</h5>
                                    <p class="text-xs text-slate-600 dark:text-slate-400">${flag.description}</p>
                                </div>
                            `).join('')}
                        </div>

                        <div class="flex flex-col gap-3">
                            <h4 class="text-xs font-bold uppercase text-slate-400 tracking-widest px-1">Compliance Checks</h4>
                            <div class="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                                <div class="flex items-center justify-between mb-2">
                                    <span class="text-xs text-slate-500">Checks Passed</span>
                                    <span class="text-xs font-bold text-emerald-600">${compliancePassCount}/${complianceChecks.length || 0}</span>
                                </div>
                                <div class="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full">
                                    <div class="bg-emerald-500 h-full rounded-full" style="width: ${complianceChecks.length ? Math.round((compliancePassCount / complianceChecks.length) * 100) : 0}%"></div>
                                </div>
                            </div>
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
            <div class="flex-1 flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden relative border-r border-slate-200 dark:border-slate-800">
                <div class="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex justify-between items-center shrink-0">
                    <div class="flex items-center gap-3">
                        <nav class="flex items-center gap-2 text-xs font-medium text-slate-500 uppercase tracking-wider">
                            <a class="hover:text-primary cursor-pointer" onclick="navigateTo('upload')">Contracts</a>
                            <span>/</span>
                            <span class="text-slate-900 dark:text-slate-200">${state.currentContract ? state.currentContract.name : 'Document'}.pdf</span>
                        </nav>
                    </div>
                </div>
                <div class="flex-1 overflow-y-auto p-8 custom-scrollbar">
                    <div class="max-w-4xl mx-auto bg-white dark:bg-slate-900 p-16 document-paper min-h-[1100px] text-slate-800 dark:text-slate-200 leading-relaxed shadow-sm rounded-sm">
                        <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[1000px]"></iframe>
                    </div>
                    ${renderExtractedTextPanel()}
                </div>
            </div>

            <!-- Right Pane: Intelligence Sidebar -->
            <aside class="w-[380px] lg:w-[420px] xl:w-[480px] bg-white dark:bg-slate-900 flex flex-col shrink-0 overflow-hidden border-l border-slate-200 dark:border-slate-800">
                <div class="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            <span class="material-symbols-outlined text-primary">analytics</span>
                            Legal Insights
                        </h3>
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <div class="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-center">
                            <p class="text-[10px] text-slate-500 uppercase font-bold">Risk Level</p>
                            <p class="text-sm font-bold text-amber-500">${legalAnalysis.overallRisk}</p>
                        </div>
                        <div class="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-center">
                            <p class="text-[10px] text-slate-500 uppercase font-bold">Compliance</p>
                            <p class="text-sm font-bold text-emerald-500">${legalAnalysis.complianceScore}%</p>
                        </div>
                        <div class="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-center">
                            <p class="text-[10px] text-slate-500 uppercase font-bold">Clauses</p>
                            <p class="text-sm font-bold text-primary">${legalAnalysis.clauses}/${legalAnalysis.totalClauses}</p>
                        </div>
                    </div>
                </div>

                <div class="flex border-b border-slate-200 dark:border-slate-800 px-4 gap-6 shrink-0">
                    <button class="border-b-2 ${state.legalTab === 'analysis' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'} py-3 text-xs font-bold" onclick="switchLegalTab('analysis')">ANALYSIS</button>
                    <button class="border-b-2 ${state.legalTab === 'versioning' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'} py-3 text-xs font-bold" onclick="switchLegalTab('versioning')">VERSIONING</button>
                </div>

                <div class="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
                    ${state.legalTab === 'versioning' ? `
                        <div class="text-center py-6">
                            <div class="size-12 mx-auto mb-3 rounded-full bg-primary/10 flex items-center justify-center">
                                <span class="material-symbols-outlined text-2xl text-primary">history</span>
                            </div>
                            <h3 class="text-md font-bold text-slate-900 dark:text-white mb-2">Contract Version History</h3>
                            <button class="px-6 py-2 mb-4 bg-primary text-white text-xs font-bold rounded-lg shadow-sm hover:bg-primary/90 transition-all" onclick="document.getElementById('versionInput').click()">
                                Upload New Version
                            </button>
                            <input type="file" id="versionInput" class="hidden" accept=".pdf,.doc,.docx,.txt" onchange="handleVersionSelected(event)">
                            
                            <div class="space-y-3 mt-4 text-left">
                                <!-- Current Active Version -->
                                <div class="flex items-center gap-4 p-4 bg-white dark:bg-slate-900 rounded-xl border border-primary/30 ring-1 ring-primary/10">
                                    <div class="size-10 rounded-full bg-primary text-white flex items-center justify-center text-xs font-bold">v${(state.currentContract.versions?.length || 0) + 1}</div>
                                    <div class="text-left flex-1 min-w-0">
                                        <p class="text-sm font-bold text-primary truncate">${state.currentContract.originalName || state.currentContract.name}</p>
                                        <p class="text-xs text-slate-500">Current active version • ${formatDate(state.currentContract.uploadDate || new Date().toISOString())}</p>
                                    </div>
                                </div>
                                
                                <!-- Historical Versions -->
                                ${(state.currentContract.versions || []).slice().reverse().map(v => `
                                    <div class="flex items-center gap-4 p-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 opacity-70 hover:opacity-100 transition-opacity">
                                        <div class="size-10 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center text-xs font-bold">v${v.version}</div>
                                        <div class="text-left flex-1 min-w-0">
                                            <p class="text-sm font-bold truncate text-slate-700 dark:text-slate-300">${v.originalName || v.name}</p>
                                            <p class="text-xs text-slate-500">Superseded • ${formatDate(v.uploadDate)}</p>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : `
                        <!-- Compliance Checks -->
                        <div>
                            <h4 class="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">
                                Compliance Checks
                            </h4>
                            <div class="space-y-2">
                                ${legalAnalysis.complianceChecks.map(check => `
                                    <div class="flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30">
                                        <span class="material-symbols-outlined ${check.status === 'pass' ? 'text-emerald-500' : 'text-amber-500'}">${check.status === 'pass' ? 'check_circle' : 'report_problem'}</span>
                                        <div>
                                            <p class="text-sm font-semibold">${check.name}</p>
                                            <p class="text-xs text-slate-500">${check.note}</p>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>

                        <!-- Enforceability Risks -->
                        <div>
                            <h4 class="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                Enforceability Risks
                                <span class="bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-normal">${legalAnalysis.enforceabilityRisks.length} ALERTS</span>
                            </h4>
                            <div class="space-y-3">
                                ${legalAnalysis.enforceabilityRisks.map(risk => `
                                    <div class="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 ring-1 ring-red-200 dark:ring-red-900">
                                        <div class="flex justify-between items-start mb-2">
                                            <span class="bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">${risk.risk || 'RISK'}</span>
                                        </div>
                                        <p class="text-sm font-bold text-red-900 dark:text-red-400 mb-1">${risk.title}</p>
                                        <p class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-2">${risk.description}</p>
                                        ${risk.quote && risk.quote !== 'Not specified' ? `<div class="mt-2 mb-3 bg-white dark:bg-slate-900 p-2 border-l-2 border-red-500 rounded shadow-sm text-[10px] text-slate-700 dark:text-slate-300 italic">"${risk.quote}"</div>` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </div>

                        <!-- Jurisdiction Details -->
                        <div>
                            <h4 class="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Jurisdiction Context</h4>
                            <div class="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-lg border border-slate-200 dark:border-slate-800">
                                <div class="flex items-center gap-3 mb-4">
                                    <div class="size-10 bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-700 flex items-center justify-center">
                                        <span class="material-symbols-outlined text-primary">location_on</span>
                                    </div>
                                    <div>
                                        <p class="text-sm font-bold">${legalAnalysis.jurisdiction.location}</p>
                                        <p class="text-xs text-slate-500">Governing Law (${legalAnalysis.jurisdiction.governingLaw})</p>
                                    </div>
                                </div>
                                <ul class="space-y-2">
                                    ${legalAnalysis.jurisdiction.notes.map(note => `
                                        <li class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                                            <span class="size-1.5 bg-primary rounded-full"></span>
                                            ${note}
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
            <main class="flex-1 flex flex-col bg-slate-50 dark:bg-background-dark overflow-hidden">
                <!-- Workspace Header -->
                <div class="px-6 py-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#1a2530]">
                    <div class="flex flex-col">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs text-[#4c739a] font-medium">Contracts</span>
                            <span class="text-xs text-[#4c739a] font-medium">/</span>
                            <span class="text-xs text-[#0d141b] dark:text-slate-200 font-bold">Operational Analysis View</span>
                        </div>
                        <h2 class="text-2xl font-black tracking-tight">Operational Analysis</h2>
                    </div>
                </div>

                <!-- Tabs -->
                <div class="px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#1a2530]">
                    <div class="flex gap-8">
                        <button class="py-4 text-sm font-bold border-b-2 ${state.pmTab === 'contract' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'} transition-all" onclick="switchPMTab('contract')">Contract Text</button>
                        <button class="py-4 text-sm font-bold border-b-2 ${state.pmTab === 'operational' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'} transition-all" onclick="switchPMTab('operational')">Operational Insights</button>
                        <button class="py-4 text-sm font-bold border-b-2 ${state.pmTab === 'actionItems' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'} transition-all" onclick="switchPMTab('actionItems')">Action Items <span class="ml-1 bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 rounded-full text-[10px]">${pmAnalysis.actionItems.length}</span></button>
                    </div>
                </div>

                <!-- Split Pane Workspace -->
                <div class="flex flex-1 overflow-hidden">
                    <!-- Left: Contract Viewer -->
                    <div class="flex-1 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#151e28] overflow-hidden">
                        <div class="flex items-center justify-between px-6 py-3 border-b border-slate-100 dark:border-slate-800">
                            <span class="text-xs font-bold uppercase text-slate-400">Contract Text</span>
                        </div>
                        <div class="flex-1 p-8 overflow-y-auto custom-scrollbar leading-relaxed">
                            <div class="max-w-2xl mx-auto space-y-6">
                                <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                            </div>
                            ${renderExtractedTextPanel()}
                        </div>
                    </div>

                    <!-- Right: Operational Insights -->
                    <div class="w-[450px] xl:w-[500px] flex flex-col bg-slate-50 dark:bg-background-dark overflow-y-auto custom-scrollbar p-6 space-y-6">
                        <!-- Section: Deliverables -->
                        <section>
                            <div class="flex items-center gap-2 mb-4">
                                <span class="material-symbols-outlined text-primary">inventory_2</span>
                                <h3 class="font-bold text-base">Key Deliverables</h3>
                            </div>
                            <div class="space-y-3">
                                ${pmAnalysis.deliverables.map(del => `
                                    <div class="bg-white dark:bg-[#1a2530] p-4 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800">
                                        <div class="flex justify-between items-start">
                                            <p class="text-sm font-bold">${del.name}</p>
                                            <span class="px-2 py-0.5 rounded-full ${del.status === 'IN PROGRESS' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'} text-[10px] font-bold">${del.status}</span>
                                        </div>
                                        <p class="text-xs text-slate-500 mt-1">Due: ${del.due}</p>
                                        ${del.progress > 0 ? `
                                            <div class="mt-3 flex items-center gap-2">
                                                <div class="h-1.5 flex-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                                    <div class="h-full bg-primary" style="width: ${del.progress}%"></div>
                                                </div>
                                                <span class="text-[10px] font-medium text-slate-500">${del.progress}%</span>
                                            </div>
                                        ` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </section>

                        <!-- Section: IP Usage Rights -->
                        <section>
                            <div class="flex items-center gap-2 mb-4">
                                <span class="material-symbols-outlined text-primary">verified_user</span>
                                <h3 class="font-bold text-base">IP Usage Rights</h3>
                            </div>
                            <div class="grid grid-cols-2 gap-3">
                                <div class="bg-white dark:bg-[#1a2530] p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                                    <p class="text-[10px] font-bold text-slate-400 uppercase">Customer Data</p>
                                    <p class="text-sm font-bold text-green-600 dark:text-green-400">${pmAnalysis.ipRights.customerData}</p>
                                </div>
                                <div class="bg-white dark:bg-[#1a2530] p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                                    <p class="text-[10px] font-bold text-slate-400 uppercase">SaaS Software</p>
                                    <p class="text-sm font-bold text-primary">${pmAnalysis.ipRights.saasSoftware}</p>
                                </div>
                                <div class="bg-white dark:bg-[#1a2530] p-3 rounded-xl border border-slate-200 dark:border-slate-800 col-span-2">
                                    <p class="text-[10px] font-bold text-slate-400 uppercase">Usage Restrictions</p>
                                    <p class="text-xs mt-1 text-slate-700 dark:text-slate-300">${pmAnalysis.ipRights.usageRestrictions}</p>
                                </div>
                            </div>
                        </section>

                        <!-- Section: Timelines -->
                        <section>
                            <div class="flex items-center gap-2 mb-4">
                                <span class="material-symbols-outlined text-primary">schedule</span>
                                <h3 class="font-bold text-base">Project Timelines</h3>
                            </div>
                            <div class="relative pl-6 space-y-6 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-slate-200 dark:before:bg-slate-800">
                                ${pmAnalysis.timelines.map((tl, i) => `
                                    <div class="relative">
                                        <div class="absolute -left-[19px] top-1 size-3 rounded-full ${i < 2 ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-700'} ring-4 ring-white dark:ring-background-dark"></div>
                                        <p class="text-xs font-bold">${tl.event}</p>
                                        <p class="text-[11px] text-slate-500">${tl.date}</p>
                                    </div>
                                `).join('')}
                            </div>
                        </section>

                        <!-- Section: Action Items -->
                        <section class="mt-4 pb-8">
                            <div class="flex items-center justify-between mb-4">
                                <div class="flex items-center gap-2">
                                    <span class="material-symbols-outlined text-primary">fact_check</span>
                                    <h3 class="font-bold text-base">Action Items</h3>
                                </div>
                            </div>
                            <div class="space-y-2">
                                ${pmAnalysis.actionItems.map(item => `
                                    <div class="flex items-center gap-3 bg-white dark:bg-[#1a2530] p-3 rounded-xl border border-slate-200 dark:border-slate-800 group transition-colors">
                                        <div class="size-5 rounded border-2 border-slate-200 dark:border-slate-700 flex items-center justify-center text-transparent group-hover:text-primary transition-colors">
                                            <span class="material-symbols-outlined !text-[14px]">check</span>
                                        </div>
                                        <div class="flex-1">
                                            <p class="text-xs font-medium">${item.task}</p>
                                            <p class="text-[10px] text-slate-400">Assigned: ${item.assigned}</p>
                                        </div>
                                    </div>
                                `).join('')}
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
            <aside class="w-16 flex flex-col items-center py-6 gap-6 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
                <div class="p-2 text-slate-400 hover:text-primary cursor-pointer transition-colors" title="Home" onclick="navigateTo('upload')">
                    <span class="material-symbols-outlined text-2xl">home</span>
                </div>
                <div class="p-2 text-primary bg-primary/10 rounded-lg" title="Active Chat">
                    <span class="material-symbols-outlined text-2xl" style="font-variation-settings: 'FILL' 1;">chat_bubble</span>
                </div>
            </aside>

            <div class="flex-1 flex flex-col min-w-0">
                <div class="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex flex-wrap justify-between items-center">
                    <div class="flex items-center gap-2 overflow-hidden">
                        <a class="text-slate-500 hover:text-primary text-sm font-medium cursor-pointer" onclick="navigateTo('upload')">Contracts</a>
                        <span class="text-slate-300 dark:text-slate-700">/</span>
                        <span class="text-slate-900 dark:text-white text-sm font-bold truncate">${state.currentContract ? state.currentContract.name : 'Contract'}</span>
                    </div>
                </div>

                <div class="flex-1 flex overflow-hidden">
                    <section class="flex-[1.5] bg-slate-50 dark:bg-background-dark overflow-y-auto p-8 border-r border-slate-200 dark:border-slate-800 flex flex-col">
                        <div class="bg-white dark:bg-slate-900 shadow-sm border border-slate-200 dark:border-slate-800 mx-auto max-w-4xl w-full p-12 text-slate-800 dark:text-slate-300 leading-relaxed text-[15px]">
                                <iframe src="/api/contracts/${state.currentContract.id}/file" class="w-full h-full border-0 min-h-[800px]"></iframe>
                        </div>
                        ${renderExtractedTextPanel()}
                    </section>

                    <section class="flex-1 bg-white dark:bg-slate-900 flex flex-col shadow-2xl z-10">
                        <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <div class="size-8 rounded-full bg-primary/20 text-primary flex items-center justify-center">
                                    <span class="material-symbols-outlined text-xl" style="font-variation-settings: 'FILL' 1;">smart_toy</span>
                                </div>
                                <div>
                                    <h3 class="text-sm font-bold text-slate-900 dark:text-white">AI Contract Specialist</h3>
                                    <div class="flex items-center gap-1.5">
                                        <span class="size-1.5 bg-green-500 rounded-full"></span>
                                        <span class="text-[10px] text-slate-500 font-medium uppercase tracking-tight">Contract Grounded</span>
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
                                    <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-2">Ask about this contract</h3>
                                    <p class="text-sm text-slate-500 dark:text-slate-400">I can help you understand clauses, risks, and implications across this contract.</p>
                                </div>
                            ` : state.chatMessages.map(msg => renderChatMessage(msg)).join('')}
                        </div>

                        <div class="p-6 border-t border-slate-100 dark:border-slate-800">
                            <div class="flex flex-col gap-3">
                                <div class="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                                    <button class="whitespace-nowrap bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 text-[11px] px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 transition-all" onclick="sendQuickQuestion('Explain termination rights')">
                                        Explain termination rights
                                    </button>
                                    <button class="whitespace-nowrap bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 text-[11px] px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 transition-all" onclick="sendQuickQuestion('What are the financial risks?')">
                                        Risk of non-payment
                                    </button>
                                    <button class="whitespace-nowrap bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 text-[11px] px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 transition-all" onclick="sendQuickQuestion('What about subcontractor terms?')">
                                        Subcontractor terms
                                    </button>
                                </div>
                                <div class="relative group">
                                    <textarea id="chatInput" class="w-full bg-slate-100 dark:bg-slate-800 border-none rounded-xl py-3 pl-4 pr-12 text-sm text-slate-900 dark:text-white placeholder:text-slate-500 focus:ring-2 focus:ring-primary/40 resize-none transition-all" placeholder="Ask a follow-up question..." rows="2" onkeydown="handleChatKeydown(event)"></textarea>
                                    <button class="absolute right-3 bottom-3 size-8 bg-primary text-white rounded-lg flex items-center justify-center shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all" onclick="handleSendChatMessage()">
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

function renderChatMessage(msg) {
    if (msg.role === 'user') {
        return `
            <div class="flex flex-col items-end">
                <div class="bg-primary text-white p-4 rounded-xl rounded-tr-none max-w-[85%] shadow-sm">
                    <p class="text-sm">${msg.content}</p>
                </div>
                <span class="text-[10px] text-slate-400 mt-1 mr-1">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        `;
    } else {
        if (msg.isLoading) {
            return `
                <div class="flex flex-col items-start">
                    <div class="bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 p-5 rounded-xl rounded-tl-none max-w-[95%] shadow-sm">
                        <div class="flex items-center gap-3">
                            <div class="loading-spinner"></div>
                            <p class="text-sm text-slate-700 dark:text-slate-300">${msg.content}</p>
                        </div>
                    </div>
                </div>
            `;
        }
        return `
            <div class="flex flex-col items-start">
                <div class="bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 p-5 rounded-xl rounded-tl-none max-w-[95%] shadow-sm">
                    ${msg.citations && msg.citations.length > 0 ? `
                        <div class="flex items-center gap-1 text-slate-400 text-xs mb-3">
                            <span class="material-symbols-outlined text-xs">policy</span>
                            <span>${msg.citations.join(', ')} cited</span>
                        </div>
                    ` : ''}
                    <p class="text-sm text-slate-800 dark:text-slate-200 leading-relaxed mb-4">${msg.content}</p>
                    ${msg.implications && msg.implications.length > 0 ? `
                        <h4 class="text-xs font-bold text-slate-900 dark:text-white uppercase mb-2">Key Implications:</h4>
                        <ul class="text-sm text-slate-700 dark:text-slate-300 space-y-2 list-disc pl-4">
                            ${msg.implications.map(imp => `<li>${imp}</li>`).join('')}
                        </ul>
                    ` : ''}
                </div>
                <div class="mt-3 flex gap-2">
                    <button class="flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] text-slate-500 transition-colors" onclick="copyToClipboard('${msg.content.replace(/'/g, "\\'")}')">
                        <span class="material-symbols-outlined text-sm">content_copy</span> Copy for Report
                    </button>
                </div>
            </div>
        `;
    }
}

function renderLoadingView() {
    return `
        <main class="flex-1 items-center justify-center">
            <div class="text-center">
                <div class="loading-spinner mx-auto mb-4"></div>
                <h2 class="text-xl font-bold text-[#0d141b] dark:text-slate-50 mb-2">Analyzing Contract...</h2>
            <p class="text-[#4c739a] dark:text-slate-400">Our AI is reviewing your document and generating insights.</p>
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
        if (contract.role) {
            state.selectedRole = contract.role;
        }

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

    // Add user message
    state.chatMessages.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    input.value = '';
    render();

    // Send to API
    const loadingMessage = {
        role: 'assistant',
        content: 'Preparing response...',
        timestamp: new Date().toISOString(),
        isLoading: true
    };
    state.chatMessages.push(loadingMessage);
    render();

    try {
        const response = await sendChatMessageAPI(state.currentContract.id, message, state.selectedRole);
        Object.assign(loadingMessage, {
            ...response,
            timestamp: new Date().toISOString(),
            isLoading: false
        });
        render();
        document.getElementById('chatInput')?.focus();
    } catch (error) {
        console.error('Chat error:', error);
        Object.assign(loadingMessage, {
            role: 'assistant',
            content: 'Sorry, I encountered an error. Please try again.',
            timestamp: new Date().toISOString(),
            isLoading: false
        });
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
    toast.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-3 rounded-lg shadow-xl text-sm font-medium animate-fade-in-up transition-all';
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

    // Handle role selection
    document.querySelectorAll('input[name="role-selector"]').forEach(el => {
        el.addEventListener('change', (e) => {
            selectRole(e.target.value);
        });
    });
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
