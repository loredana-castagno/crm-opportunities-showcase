'use client';

import { getOpportunities } from "@/app/actions/commercial/opportunity";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, Crown, DollarSign, TrendingUp, CheckCircle2, Layers, Target, ArrowUpRight, Minus, AlertTriangle, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import ClickableRow from "@/app/components/ClickableRow";
import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import SuccessToast from "@/app/components/SuccessToast";
import ColumnSelector, { useColumnVisibility, ColumnDef } from "@/app/components/ColumnSelector";
import ExportToolbar from "@/app/components/ExportToolbar";
import ConfirmModal from "@/app/components/modals/ConfirmModal";
import AlertModal from "@/app/components/modals/AlertModal";
import OpportunitiesFiltersDropdown from "./OpportunitiesFiltersDropdown";

const STAGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    'Prospecting': { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' },
    'Qualification': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
    'Proposal': { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
    'Negotiation': { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
    'Closed Won': { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
    'Closed Lost': { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
};

// Inline style avatar colors for owner mini-avatars (consistent with Accounts/Contacts/Leads)
const AVATAR_COLORS = [
    { bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
    { bg: '#ecfdf5', color: '#059669', border: '#a7f3d0' },
    { bg: '#f5f3ff', color: '#7c3aed', border: '#c4b5fd' },
    { bg: '#fffbeb', color: '#d97706', border: '#fcd34d' },
    { bg: '#fff1f2', color: '#e11d48', border: '#fda4af' },
    { bg: '#ecfeff', color: '#0891b2', border: '#a5f3fc' },
    { bg: '#fdf4ff', color: '#c026d3', border: '#e879f9' },
    { bg: '#fff7ed', color: '#ea580c', border: '#fdba74' },
    { bg: '#f0fdfa', color: '#0d9488', border: '#5eead4' },
    { bg: '#eef2ff', color: '#4f46e5', border: '#a5b4fc' },
];
function getAvatarColor(name: string) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'won', label: 'Won' },
    { key: 'lost', label: 'Lost' },
    { key: 'archived', label: 'Archived' },
];

function formatCurrency(val: any) {
    if (!val) return '—';
    const num = typeof val === 'string' ? parseFloat(val) : Number(val);
    if (isNaN(num)) return '—';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatShortDate(d: any) {
    if (!d) return '—';
    const date = new Date(d);
    const day = date.getDate().toString().padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function ownerAlias(name?: string) {
    if (!name) return '—';
    return name.split(' ')[0];
}

const OPP_COLUMNS: ColumnDef[] = [
    { key: 'opportunity', label: 'Opportunity', locked: true },
    { key: 'account', label: 'Account' },
    { key: 'contact', label: 'Contact' },
    { key: 'stage', label: 'Stage' },
    { key: 'amount', label: 'Amount' },
    { key: 'closeDate', label: 'Close Date' },
    { key: 'owner', label: 'Owner' },
    { key: 'probability', label: 'Probability', defaultVisible: false },
    { key: 'source', label: 'Source', defaultVisible: false },
    { key: 'createdAt', label: 'Created', defaultVisible: false },
];

function OpportunitiesSkeleton() {
    return (
        <div className="flex-1 overflow-auto min-h-[calc(100vh-theme(spacing.24))]" style={{ backgroundColor: '#F8FAFC' }}>
            <div className="p-4 max-w-7xl mx-auto space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-50 rounded-lg text-blue-600 border border-blue-100">
                            <Layers size={18} />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-gray-600" style={{ fontFamily: 'var(--font-montserrat)' }}>
                                Opportunities
                            </h1>
                            <p className="text-gray-500 text-sm mt-0.5" style={{ fontFamily: 'var(--font-lato)' }}>
                                Manage your deals and sales pipeline.
                            </p>
                        </div>
                    </div>
                </div>
                <div className="h-10 bg-white rounded-lg border border-gray-200 animate-pulse" />
                <div className="h-64 bg-white rounded-lg border border-gray-100 animate-pulse" />
            </div>
        </div>
    );
}

function OpportunitiesContent() {
    const searchParams = useSearchParams();
    const createdFrom = searchParams.get("createdFrom") || "";
    const createdTo = searchParams.get("createdTo") || "";
    const startFrom = searchParams.get("startFrom") || "";
    const startTo = searchParams.get("startTo") || "";
    const closeFrom = searchParams.get("closeFrom") || "";
    const closeTo = searchParams.get("closeTo") || "";

    const [opportunities, setOpportunities] = useState<any[]>([]);
    const [filter, setFilter] = useState('all');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [allGlobalSelected, setAllGlobalSelected] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sortField, setSortField] = useState<string>('closeDate');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    const [currentPage, setCurrentPage] = useState(1);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
    const PAGE_SIZE = 25;
    const { visibleColumns, toggle, isVisible } = useColumnVisibility('opp-columns', OPP_COLUMNS);
    const tableRef = useRef<HTMLDivElement>(null);
    const scrollTable = useCallback((dir: 'left' | 'right') => {
        tableRef.current?.scrollBy({ left: dir === 'right' ? 300 : -300, behavior: 'smooth' });
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearchQuery(searchQuery);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    useEffect(() => {
        setCurrentPage(1);
    }, [searchQuery]);

    function handleSort(field: string) {
        if (sortField === field) {
            setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortOrder('asc');
        }
        setCurrentPage(1);
    }

    useEffect(() => {
        async function load() {
            setLoading(true);
            const res = await getOpportunities({ 
                includeArchived: filter === 'archived',
                q: debouncedSearchQuery
            });
            if (res.success) setOpportunities(res.data || []);
            else setError(res.error as string);
            setLoading(false);
        }
        load();
    }, [filter, debouncedSearchQuery]);

    const filteredUnsorted = opportunities.filter((opp: any) => {
        if (filter === 'archived') return opp.isArchived === true;
        if (opp.isArchived) return false;
        if (filter === 'open') return opp.stage !== 'Closed Won' && opp.stage !== 'Closed Lost';
        if (filter === 'won') return opp.stage === 'Closed Won';
        if (filter === 'lost') return opp.stage === 'Closed Lost';

        if (createdFrom || createdTo) {
            if (!opp.createdAt) return false;
            const dt = new Date(opp.createdAt);
            if (createdFrom && dt < new Date(createdFrom + "T00:00:00")) return false;
            if (createdTo && dt > new Date(createdTo + "T23:59:59")) return false;
        }

        if (startFrom || startTo) {
            const startDateVal = opp.dueDate || opp.sowDate;
            if (!startDateVal) return false;
            const dt = new Date(startDateVal);
            if (startFrom && dt < new Date(startFrom + "T00:00:00")) return false;
            if (startTo && dt > new Date(startTo + "T23:59:59")) return false;
        }

        if (closeFrom || closeTo) {
            if (!opp.closeDate) return false;
            const dt = new Date(opp.closeDate);
            if (closeFrom && dt < new Date(closeFrom + "T00:00:00")) return false;
            if (closeTo && dt > new Date(closeTo + "T23:59:59")) return false;
        }

        return true;
    });

    const filtered = [...filteredUnsorted].sort((a: any, b: any) => {
        let aVal: any, bVal: any;
        switch (sortField) {
            case 'opportunity': aVal = (a.title || '').toLowerCase(); bVal = (b.title || '').toLowerCase(); break;
            case 'account': aVal = (a.account?.name || '').toLowerCase(); bVal = (b.account?.name || '').toLowerCase(); break;
            case 'contact': aVal = (a.sourceContact?.fullName || a.contactName || '').toLowerCase(); bVal = (b.sourceContact?.fullName || b.contactName || '').toLowerCase(); break;
            case 'stage': aVal = (a.stage || '').toLowerCase(); bVal = (b.stage || '').toLowerCase(); break;
            case 'amount': aVal = Number(a.amount) || 0; bVal = Number(b.amount) || 0; break;
            case 'closeDate': aVal = a.closeDate ? new Date(a.closeDate).getTime() : 0; bVal = b.closeDate ? new Date(b.closeDate).getTime() : 0; break;
            case 'owner': aVal = (a.owner?.name || '').toLowerCase(); bVal = (b.owner?.name || '').toLowerCase(); break;
            case 'probability': aVal = Number(a.probability) || 0; bVal = Number(b.probability) || 0; break;
            case 'source': aVal = (a.source || '').toLowerCase(); bVal = (b.source || '').toLowerCase(); break;
            case 'createdAt': aVal = a.createdAt ? new Date(a.createdAt).getTime() : 0; bVal = b.createdAt ? new Date(b.createdAt).getTime() : 0; break;
            default: return 0;
        }
        if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    // Pagination
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(currentPage, totalPages);
    const paginatedItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    // Selection handlers
    const dateParamsArr = [
        createdFrom && `createdFrom=${createdFrom}`,
        createdTo && `createdTo=${createdTo}`,
        startFrom && `startFrom=${startFrom}`,
        startTo && `startTo=${startTo}`,
        closeFrom && `closeFrom=${closeFrom}`,
        closeTo && `closeTo=${closeTo}`,
    ].filter(Boolean);
    const dateParamsStr = dateParamsArr.length > 0 ? `&${dateParamsArr.join("&")}` : "";
    const filterParams = `filter=${filter}${debouncedSearchQuery ? `&q=${encodeURIComponent(debouncedSearchQuery)}` : ""}${dateParamsStr}`;

    const toggleSelect = useCallback((id: number, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const toggleSelectAll = useCallback(() => {
        if (selectedIds.size === paginatedItems.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(paginatedItems.map((o: any) => o.id)));
        }
    }, [paginatedItems, selectedIds.size]);

    const deselectAll = useCallback(() => {
        setSelectedIds(new Set());
        setAllGlobalSelected(false);
    }, []);

    const selectAllGlobal = useCallback(() => setAllGlobalSelected(true), []);
    const deselectAllGlobal = useCallback(() => {
        setSelectedIds(new Set());
        setAllGlobalSelected(false);
    }, []);

    const [cloneModalOpen, setCloneModalOpen] = useState(false);
    const [cloneModalLoading, setCloneModalLoading] = useState(false);
    const [alertModalOpen, setAlertModalOpen] = useState(false);
    const [alertModalConfig, setAlertModalConfig] = useState({ title: "", description: "", variant: "success" as "success" | "danger" | "info" });

    const handleCloneSelected = useCallback(() => {
        if (selectedIds.size === 0) return;
        setCloneModalOpen(true);
    }, [selectedIds.size]);

    const handleCloneConfirm = useCallback(async () => {
        setCloneModalLoading(true);
        try {
            const ids = Array.from(selectedIds);
            const { cloneOpportunities } = await import("@/app/actions/commercial/opportunity");
            const res = await cloneOpportunities(ids);
            setCloneModalOpen(false);
            if (res.success) {
                setSelectedIds(new Set());
                setAllGlobalSelected(false);
                setAlertModalConfig({
                    title: "Success",
                    description: `Successfully cloned ${res.count} opportunity/opportunities. Cloned opportunities have "(CLONED)" added to their names.`,
                    variant: "success"
                });
                setAlertModalOpen(true);
            } else {
                setAlertModalConfig({
                    title: "Error",
                    description: `Failed to clone opportunities: ${res.error}`,
                    variant: "danger"
                });
                setAlertModalOpen(true);
            }
        } catch (err: any) {
            console.error("Cloning error:", err);
            setCloneModalOpen(false);
            setAlertModalConfig({
                title: "Error",
                description: `An error occurred: ${err.message || err}`,
                variant: "danger"
            });
            setAlertModalOpen(true);
        } finally {
            setCloneModalLoading(false);
        }
    }, [selectedIds]);

    const handleAlertModalClose = useCallback(() => {
        setAlertModalOpen(false);
        if (alertModalConfig.variant === "success") {
            window.location.reload();
        }
    }, [alertModalConfig.variant]);

    const allSelected = paginatedItems.length > 0 && selectedIds.size === paginatedItems.length;
    const someSelected = selectedIds.size > 0 && selectedIds.size < paginatedItems.length;

    // Metrics
    const totalPipeline = opportunities.reduce((sum: number, o: any) => sum + (Number(o.amount) || 0), 0);
    const closedWonTotal = opportunities.filter((o: any) => o.stage === 'Closed Won').reduce((sum: number, o: any) => sum + (Number(o.amount) || 0), 0);
    const openDeals = opportunities.filter((o: any) => o.stage !== 'Closed Won' && o.stage !== 'Closed Lost').length;
    const wonCount = opportunities.filter((o: any) => o.stage === 'Closed Won').length;
    // "Advancing" — opps in late-funnel stages of the new default vocabulary.
    // Counts any of: Awaiting Feedback, Awaiting SOW, Proposal Presented (and the legacy Negotiation/Proposal in case a user named a custom stage that way).
    const inNegotiation = opportunities.filter((o: any) =>
        ['Awaiting Feedback', 'Awaiting SOW', 'Proposal Presented', 'Negotiation', 'Proposal'].includes(o.stage)
    ).length;
    // Weighted Pipeline: sum of (amount × probability / 100) for open deals
    const openOpps = opportunities.filter((o: any) => o.stage !== 'Closed Won' && o.stage !== 'Closed Lost');
    const weightedPipeline = openOpps.reduce((sum: number, o: any) => sum + ((Number(o.amount) || 0) * ((Number(o.probability) || 0) / 100)), 0);
    const avgProbability = openOpps.length > 0 ? Math.round(openOpps.reduce((sum: number, o: any) => sum + (Number(o.probability) || 0), 0) / openOpps.length) : 0;

    return (
        <div className="flex-1 overflow-auto min-h-[calc(100vh-theme(spacing.24))]" style={{ backgroundColor: '#F8FAFC' }}>
            <Suspense><SuccessToast messages={{ opportunity: "Opportunity created successfully!" }} /></Suspense>
            <div className="p-4 max-w-7xl mx-auto space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-50 rounded-lg text-blue-600 border border-blue-100">
                            <Crown size={18} />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-gray-600" style={{ fontFamily: 'var(--font-montserrat)' }}>
                                Opportunities
                            </h1>
                            <p className="text-gray-500 text-sm mt-0.5" style={{ fontFamily: 'var(--font-lato)' }}>
                                Manage your deals and sales pipeline.
                            </p>
                        </div>
                    </div>
                    <Link
                        href="/commercial/opportunities/new"
                        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold shadow-sm hover:bg-blue-700 transition-all mr-14"
                        style={{ fontFamily: 'var(--font-lato)' }}
                    >
                        <Plus className="w-4 h-4" />
                        New Opportunity
                    </Link>
                </div>

                {/* Filter Pills & Date Filter */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                        {FILTERS.map(f => (
                            <button
                                key={f.key}
                                onClick={() => { setFilter(f.key); setCurrentPage(1); }}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                                    filter === f.key
                                        ? 'bg-gray-800 text-white shadow-sm'
                                        : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-300 hover:text-gray-700'
                                }`}
                                style={{ fontFamily: 'var(--font-lato)' }}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    <OpportunitiesFiltersDropdown />
                </div>

                {/* Metrics Cards */}
                {!loading && opportunities.length > 0 && (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <div className="bg-white py-3 px-4 rounded-lg border border-gray-200 flex items-center gap-3">
                            <div className="p-2 bg-[#EAF4FF] text-[#0783FC] rounded-lg">
                                <TrendingUp size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Total Pipeline</p>
                                <div className="flex items-end gap-2">
                                    <p className="text-2xl font-semibold text-gray-900">{formatCurrency(totalPipeline)}</p>
                                    <span className="flex items-center gap-0.5 text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full mb-1">
                                        <Layers size={9} />
                                        {opportunities.length} deal{opportunities.length !== 1 ? 's' : ''}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div className="bg-white py-3 px-4 rounded-lg border border-gray-200 flex items-center gap-3">
                            <div className="p-2 bg-[#EAF7EE] text-[#22C55E] rounded-lg">
                                <CheckCircle2 size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Closed Won</p>
                                <div className="flex items-end gap-2">
                                    <p className="text-2xl font-semibold text-gray-900">{formatCurrency(closedWonTotal)}</p>
                                    {wonCount > 0 ? (
                                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full mb-1">
                                            <ArrowUpRight size={10} />
                                            {wonCount} won
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full mb-1">
                                            <Minus size={10} />
                                            no wins yet
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="bg-white py-3 px-4 rounded-lg border border-gray-200 flex items-center gap-3">
                            <div className="p-2 bg-[#FFF4E5] text-[#F59E0B] rounded-lg">
                                <Layers size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Open Deals</p>
                                <div className="flex items-end gap-2">
                                    <p className="text-2xl font-semibold text-gray-900">{openDeals}</p>
                                    {inNegotiation > 0 ? (
                                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full mb-1">
                                            <ArrowUpRight size={10} />
                                            {inNegotiation} advancing
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-full mb-1">
                                            <Minus size={10} />
                                            early stage
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="bg-white py-3 px-4 rounded-lg border border-gray-200 flex items-center gap-3">
                            <div className="p-2 bg-[#F3E8FF] text-[#8B5CF6] rounded-lg">
                                <Target size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-600">Weighted Pipeline</p>
                                <div className="flex items-end gap-2">
                                    <p className="text-2xl font-semibold text-gray-900">{formatCurrency(weightedPipeline)}</p>
                                    <span className="flex items-center gap-0.5 text-[10px] font-bold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded-full mb-1">
                                        <Target size={9} />
                                        avg {avgProbability}% prob
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Search Bar */}
                <div className="relative w-full">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300" size={18} />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search opportunities by title, project, account, contact, technologies, lost reason, closed comments..."
                        className="w-full pl-12 pr-10 py-2.5 bg-white border border-gray-200 rounded-lg text-sm font-medium focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition-all"
                        style={{ fontFamily: 'var(--font-lato)' }}
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-gray-300 hover:text-gray-500 transition-colors"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {/* Results Count + Column Controls */}
                <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-gray-400" style={{ fontFamily: 'var(--font-lato)' }}>
                        <span className="font-semibold text-gray-500">{filtered.length}</span>{' '}
                        opportunit{filtered.length !== 1 ? 'ies' : 'y'}
                        {filter !== 'all' && <span className="text-gray-400"> of {opportunities.length} total</span>}
                        {filtered.length > PAGE_SIZE && (
                            <span className="text-gray-400"> · page {safePage} of {totalPages}</span>
                        )}
                    </p>
                    <div className="flex items-center gap-2">
                        <OpportunitiesFiltersDropdown />
                        <ColumnSelector columns={OPP_COLUMNS} storageKey="opp-columns" visibleColumns={visibleColumns} onToggle={toggle} />
                        <button onClick={() => scrollTable('left')} className="p-1 rounded-md border border-gray-200 bg-white text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-all">
                            <ChevronLeft size={14} />
                        </button>
                        <button onClick={() => scrollTable('right')} className="p-1 rounded-md border border-gray-200 bg-white text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-all">
                            <ChevronRight size={14} />
                        </button>
                    </div>
                </div>

                {/* Error */}
                {error && (
                    <div className="rounded-lg bg-red-50 p-3 border border-red-100 text-sm text-red-700">{error}</div>
                )}

                {/* Table */}
                <div ref={tableRef} className="bg-white rounded-lg border border-gray-100 overflow-x-auto scrollbar-hide">
                    <table className="w-full table-auto divide-y divide-gray-100">
                        <thead>
                            <tr className="border-b border-gray-200">
                                {/* Checkbox header */}
                                <th className="w-[36px] px-2 py-2.5">
                                    <div
                                        onClick={toggleSelectAll}
                                        className={`w-4 h-4 rounded border-2 cursor-pointer transition-all flex items-center justify-center ${
                                            allSelected
                                                ? "bg-blue-600 border-blue-600"
                                                : someSelected
                                                ? "bg-blue-600 border-blue-600"
                                                : "border-gray-300 hover:border-blue-400"
                                        }`}
                                    >
                                        {allSelected && (
                                            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                        )}
                                        {someSelected && !allSelected && (
                                            <div className="w-2 h-0.5 bg-white rounded" />
                                        )}
                                    </div>
                                </th>
                                {/* Opportunity (locked) */}
                                <th className="w-[430px] max-w-[430px] px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('opportunity')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Opportunity
                                        <span className={`text-[8px] ${sortField === 'opportunity' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'opportunity' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                {isVisible('account') && (
                                <th className="w-[200px] max-w-[200px] px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('account')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Account
                                        <span className={`text-[8px] ${sortField === 'account' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'account' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('contact') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('contact')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Contact
                                        <span className={`text-[8px] ${sortField === 'contact' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'contact' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('stage') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('stage')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Stage
                                        <span className={`text-[8px] ${sortField === 'stage' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'stage' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('amount') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('amount')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Amount
                                        <span className={`text-[8px] ${sortField === 'amount' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'amount' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('closeDate') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('closeDate')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Close Date
                                        <span className={`text-[8px] ${sortField === 'closeDate' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'closeDate' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('owner') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('owner')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Owner
                                        <span className={`text-[8px] ${sortField === 'owner' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'owner' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('probability') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('probability')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Probability
                                        <span className={`text-[8px] ${sortField === 'probability' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'probability' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('source') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('source')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Source
                                        <span className={`text-[8px] ${sortField === 'source' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'source' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                {isVisible('createdAt') && (
                                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                                    <button onClick={() => handleSort('createdAt')} className="inline-flex items-center gap-1 hover:text-blue-600 transition-colors">
                                        Created
                                        <span className={`text-[8px] ${sortField === 'createdAt' ? 'text-blue-600' : 'text-gray-300'}`}>{sortField === 'createdAt' && sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    </button>
                                </th>
                                )}
                                <th className="w-full"></th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-50">
                            {loading ? (
                                <tr><td colSpan={visibleColumns.length + 2} className="px-3 py-12 text-center text-sm text-gray-400">Loading...</td></tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={visibleColumns.length + 2} className="px-3 py-20 text-center">
                                        <div className="flex flex-col items-center gap-2 text-gray-400">
                                            <div className="p-4 bg-gray-50 rounded-full">
                                                <DollarSign size={40} className="text-gray-200" />
                                            </div>
                                            <p className="font-medium text-gray-500" style={{ fontFamily: 'var(--font-lato)' }}>No opportunities found.</p>
                                            <p className="text-sm text-gray-400" style={{ fontFamily: 'var(--font-lato)' }}>Create your first deal to get started.</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                paginatedItems.map((opp: any) => {
                                    const stageColor = STAGE_COLORS[opp.stage] || STAGE_COLORS['Prospecting'];
                                    const accountName = opp.account?.name;
                                    const accountType = opp.account ? 'Account' : 'Lead';
                                    return (
                                        <ClickableRow key={opp.id} destination={`/commercial/opportunities/${opp.id}`}>
                                            {/* Checkbox cell */}
                                            <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                                                <div
                                                    onClick={(e) => toggleSelect(opp.id, e)}
                                                    className={`w-4 h-4 rounded border-2 cursor-pointer transition-all flex items-center justify-center ${
                                                        selectedIds.has(opp.id)
                                                            ? "bg-blue-600 border-blue-600"
                                                            : "border-gray-300 hover:border-blue-400"
                                                    }`}
                                                >
                                                    {selectedIds.has(opp.id) && (
                                                        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                                            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                        </svg>
                                                    )}
                                                </div>
                                            </td>
                                            {/* Opportunity (locked) — Leads-style avatar + name + subtitle */}
                                            <td className="w-[430px] max-w-[430px] px-3 py-2.5 overflow-hidden">
                                                <div className="flex items-center gap-2.5">
                                                    <div
                                                        className="h-8 w-8 rounded-lg flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                                                        style={{ backgroundColor: getAvatarColor(opp.title || 'O').bg, color: getAvatarColor(opp.title || 'O').color, border: `1px solid ${getAvatarColor(opp.title || 'O').border}` }}
                                                    >
                                                        {(opp.title || 'O').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                                                    </div>
                                                    <div className="min-w-0 flex-1 flex flex-col justify-start h-[50px]">
                                                        <p className="text-[13px] font-medium leading-tight text-gray-900 group-hover:text-blue-600 transition-colors line-clamp-2">
                                                            <Link href={`/commercial/opportunities/${opp.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{opp.title}</Link>
                                                        </p>
                                                        <p className="text-[11px] text-gray-400 truncate mt-0.5">
                                                            {accountName || '—'}
                                                        </p>
                                                    </div>
                                                </div>
                                            </td>
                                            {/* Account */}
                                            {isVisible('account') && (
                                            <td className="w-[200px] max-w-[200px] px-3 py-2.5 overflow-hidden">
                                                {accountName ? (
                                                    opp.account ? (
                                                        <Link href={`/commercial/accounts/${opp.account.id}`} onClick={e => e.stopPropagation()} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-blue-600 hover:text-blue-700 leading-tight line-clamp-2 block hover:underline">
                                                            {accountName}
                                                        </Link>
                                                    ) : (
                                                        <span className="text-[12px] text-gray-600 leading-tight line-clamp-2 block">{accountName}</span>
                                                    )
                                                ) : (
                                                    <span className="text-[12px] italic text-gray-300">—</span>
                                                )}
                                            </td>
                                            )}
                                            {/* Contact */}
                                            {isVisible('contact') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                {opp.sourceContact ? (
                                                    <Link href={`/commercial/${opp.sourceContact.type === 'CLIENT_CONTACT' || opp.sourceContact.type === 'FORMER_CLIENT_CONTACT' ? 'contacts' : 'leads'}/${opp.sourceContact.id}`} onClick={e => e.stopPropagation()} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-blue-600 hover:text-blue-700 truncate block hover:underline">
                                                        {opp.sourceContact.fullName}
                                                    </Link>
                                                ) : opp.contactName ? (
                                                    <span className="text-[12px] text-gray-500 truncate block">{opp.contactName}</span>
                                                ) : (
                                                    <span className="italic text-gray-300 text-[12px]">—</span>
                                                )}
                                            </td>
                                            )}
                                            {/* Stage */}
                                            {isVisible('stage') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                <div className="flex items-center gap-1.5">
                                                    {opp.isArchived ? (
                                                        <span title={opp.archiveReason || 'Archived'} className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 border border-gray-200">
                                                            Archived
                                                        </span>
                                                    ) : (
                                                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide w-fit ${stageColor.bg} ${stageColor.text} border ${stageColor.border}`}>
                                                            {opp.stage}
                                                        </span>
                                                    )}
                                                    {opp.stage === 'Closed Won' && (() => {
                                                        const hired = (opp.jobs || []).reduce((acc: number, j: any) => acc + (j.applications?.length || 0), 0);
                                                        const needed = opp.numberOfPositions || 1;
                                                        if (hired >= needed) return null;
                                                        return (
                                                            <span title={`${hired}/${needed} position${needed > 1 ? 's' : ''} filled`}>
                                                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                                                            </span>
                                                        );
                                                    })()}
                                                </div>
                                            </td>
                                            )}
                                            {/* Amount */}
                                            {isVisible('amount') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                <span className="text-[13px] font-bold text-gray-800">{formatCurrency(opp.amount)}</span>
                                            </td>
                                            )}
                                            {/* Close Date */}
                                            {isVisible('closeDate') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                <span className="text-[12px] text-gray-500">{formatShortDate(opp.closeDate)}</span>
                                            </td>
                                            )}
                                            {/* Owner */}
                                            {isVisible('owner') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                {opp.owner?.name ? (
                                                    <span className="text-[12px] text-gray-600 truncate">{opp.owner.name.split(' ')[0]}</span>
                                                ) : (
                                                    <span className="text-gray-300 text-[12px]">—</span>
                                                )}
                                            </td>
                                            )}
                                            {/* Probability (hidden by default) */}
                                            {isVisible('probability') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                <span className="text-[12px] text-gray-500">{opp.probability ? `${opp.probability}%` : '—'}</span>
                                            </td>
                                            )}
                                            {/* Source (hidden by default) */}
                                            {isVisible('source') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                <span className="text-[12px] text-gray-500 truncate block">{opp.source || '—'}</span>
                                            </td>
                                            )}
                                            {/* Created (hidden by default) */}
                                            {isVisible('createdAt') && (
                                            <td className="px-3 py-2.5 overflow-hidden">
                                                <span className="text-[12px] text-gray-500">{formatShortDate(opp.createdAt)}</span>
                                            </td>
                                            )}
                                            <td></td>
                                        </ClickableRow>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between py-3">
                        <p className="text-xs text-gray-400" style={{ fontFamily: 'var(--font-lato)' }}>
                            Showing {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                        </p>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setCurrentPage(1)}
                                disabled={safePage === 1}
                                className="px-2 py-1 text-xs font-medium rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                First
                            </button>
                            <button
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                disabled={safePage === 1}
                                className="p-1 rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                <ChevronLeft size={14} />
                            </button>
                            {Array.from({ length: totalPages }, (_, i) => i + 1)
                                .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
                                .reduce<(number | 'ellipsis')[]>((acc, p, idx, arr) => {
                                    if (idx > 0 && p - (arr[idx - 1]) > 1) acc.push('ellipsis');
                                    acc.push(p);
                                    return acc;
                                }, [])
                                .map((item, i) =>
                                    item === 'ellipsis' ? (
                                        <span key={`e${i}`} className="px-1 text-xs text-gray-300">…</span>
                                    ) : (
                                        <button
                                            key={item}
                                            onClick={() => setCurrentPage(item as number)}
                                            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-all ${
                                                safePage === item
                                                    ? 'bg-blue-600 text-white border-blue-600'
                                                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                                            }`}
                                        >
                                            {item}
                                        </button>
                                    )
                                )}
                            <button
                                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                disabled={safePage === totalPages}
                                className="p-1 rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                <ChevronRight size={14} />
                            </button>
                            <button
                                onClick={() => setCurrentPage(totalPages)}
                                disabled={safePage === totalPages}
                                className="px-2 py-1 text-xs font-medium rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                Last
                            </button>
                        </div>
                    </div>
                )}

                <ExportToolbar
                    selectedCount={selectedIds.size}
                    totalCount={paginatedItems.length}
                    globalTotalCount={filtered.length}
                    entityType="leads"
                    selectedIds={Array.from(selectedIds)}
                    filterParams={filterParams}
                    onSelectAll={toggleSelectAll}
                    onDeselectAll={deselectAll}
                    allGlobalSelected={allGlobalSelected}
                    onSelectAllGlobal={selectAllGlobal}
                    onDeselectAllGlobal={deselectAllGlobal}
                    onClone={handleCloneSelected}
                />

                <ConfirmModal
                    isOpen={cloneModalOpen}
                    onClose={() => setCloneModalOpen(false)}
                    onConfirm={handleCloneConfirm}
                    title="Clone Opportunities"
                    description={`Are you sure you want to clone the ${selectedIds.size} selected opportunity/opportunities? This will duplicate their information with "(CLONED)" added to their names.`}
                    confirmLabel="Clone"
                    cancelLabel="Cancel"
                    isLoading={cloneModalLoading}
                    variant="info"
                />

                <AlertModal
                    isOpen={alertModalOpen}
                    onClose={handleAlertModalClose}
                    title={alertModalConfig.title}
                    description={alertModalConfig.description}
                    variant={alertModalConfig.variant}
                    dismissLabel="OK"
                />
            </div>
        </div>
    );
}

export default function OpportunitiesPage() {
    return (
        <Suspense fallback={<OpportunitiesSkeleton />}>
            <OpportunitiesContent />
        </Suspense>
    );
}
