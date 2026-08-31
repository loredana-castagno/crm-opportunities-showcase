'use client';

import {
    getOpportunity, updateOpportunity,
    searchJobs, searchContactsAndLeads,
    getUsers,
    updateOppFile, addOtherFile, removeOtherFile,
    addOppComment, updateOppComment, deleteOppComment
} from '@/app/actions/commercial/opportunity';
import { getAccounts } from '@/app/actions/commercial/company';
import { getContacts } from '@/app/actions/commercial/contact';
import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Trophy, Briefcase, Plus, X, Trash2, ExternalLink, FileText, Upload, MessageSquare, Calendar, CalendarCheck, CalendarOff, Edit, Building2, Users } from 'lucide-react';
import AutocompleteInput from '@/app/components/ui/AutocompleteInput';
import TagInput from '@/app/components/ui/TagInput';
import RichTextEditor from '@/app/components/ui/RichTextEditor';
import { normalizeSkill } from '@/app/lib/skills';
import { zonedWallClockToUtcDate, utcDateToZonedParts } from '@/app/lib/dates';
import ArchivedBanner from '@/app/components/commercial/ArchivedBanner';
import PreviouslyArchivedNote from '@/app/components/commercial/PreviouslyArchivedNote';
import DeleteReasonModal from '@/app/components/modals/DeleteReasonModal';
import ConfirmModal from '@/app/components/modals/ConfirmModal';
import StageChangeInfoModal from '@/app/components/modals/StageChangeInfoModal';
import SystemLogTimeline from '@/app/components/SystemLogTimeline';
import FileDropzone from '@/app/components/FileDropzone';
import CollapsibleComment from '@/app/components/ui/CollapsibleComment';
import { archiveOpportunity, restoreOpportunity } from '@/app/actions/commercial/archive';
import { Archive } from 'lucide-react';
import { computeStageChangeInfo, type StageChangeInfo } from '@/app/lib/stageTransition';
import OpportunityStagesModal from '@/app/components/modals/OpportunityStagesModal';
import { Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import { OPP_STAGE_LIBRARY, OPP_DEFAULT_ACTIVE_KEYS, OPP_SYSTEM_STAGE_KEYS } from '@/app/lib/opportunityStages';
import { TIMEZONES, formatLocationDisplay } from '@/app/lib/timezones';
import { useEditLock, type OtherEditor } from '@/app/lib/useEditLock';
import EditLockModal from '@/app/components/EditLockModal';

const STAGE_WINDOW_SIZE = 4;

// Stage bg colors: system stages keep their semantic color; custom/non-system use neutral.
function getStageBg(stage: string): string {
    if (stage === 'Closed Won') return 'bg-green-100 text-green-700';
    if (stage === 'Closed Lost') return 'bg-red-100 text-red-700';
    return 'bg-gray-100 text-gray-600';
}

// Fallback: derive default stages from the library, in case an opp pre-dates the schema migration.
function defaultStagesFromLibrary() {
    return OPP_STAGE_LIBRARY.map((s, idx) => ({
        stageKey: s.key,
        label: s.label,
        order: idx,
        isActive: OPP_DEFAULT_ACTIVE_KEYS.includes(s.key),
        isSystem: OPP_SYSTEM_STAGE_KEYS.includes(s.key),
    }));
}

const ENGLISH_LEVELS = ['None', 'A1 - Beginner', 'A2 - Elementary', 'B1 - Intermediate', 'B2 - Upper Intermediate', 'C1 - Advanced', 'C2 - Proficient', 'Native'];
const RATE_TYPES = ['Hourly', 'Fixed', 'Monthly'];

function formatCurrency(val: any) {
    if (!val) return '—';
    const num = typeof val === 'string' ? parseFloat(val) : Number(val);
    if (isNaN(num)) return '$0';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDate(d: any) {
    if (!d) return '—';
    const date = new Date(d);
    const day = date.getDate().toString().padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function toDateInput(d: any) {
    if (!d) return '';
    return new Date(d).toISOString().split('T')[0];
}

// Same list as ActivityTimeline.tsx — not centralized anywhere in the codebase.
const FOLLOWUP_TIMEZONES = [
    'GMT-12', 'GMT-11', 'GMT-10', 'GMT-9', 'GMT-8', 'GMT-7', 'GMT-6', 'GMT-5',
    'GMT-4', 'GMT-3', 'GMT-2', 'GMT-1', 'GMT+0', 'GMT+1', 'GMT+2', 'GMT+3',
    'GMT+4', 'GMT+5', 'GMT+5:30', 'GMT+6', 'GMT+7', 'GMT+8', 'GMT+9', 'GMT+9:30',
    'GMT+10', 'GMT+11', 'GMT+12', 'GMT+13', 'GMT+14',
];

/**
 * Formats a follow-up instant as it reads in its own stored timezone — not the
 * viewer's browser timezone. Same "UTC-labeled Date + timeZone:'UTC'" trick used
 * in ActivityTimeline.tsx, for the same reason: plain toLocaleString() would
 * re-shift the digits to whoever is looking at the page.
 */
// CRM-wide default (matches User.timezone's schema default). A missing tz should
// never render as "no offset applied, no label" — that's indistinguishable from a
// real UTC follow-up and silently wrong for anyone who typed a local time.
const DEFAULT_FU_TZ = 'GMT-3';

function formatFollowUpInZone(isoDate: string, tz: string | null | undefined) {
    const effectiveTz = tz || DEFAULT_FU_TZ;
    const { dateStr, timeStr } = utcDateToZonedParts(new Date(isoDate), effectiveTz);
    const [y, m, d] = dateStr.split('-').map(Number);
    const [h, min] = timeStr.split(':').map(Number);
    const asUtc = new Date(Date.UTC(y, m - 1, d, h, min));
    const dateLabel = asUtc.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const timeLabel = asUtc.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    return `${dateLabel} · ${timeLabel} ${effectiveTz}`;
}

interface AttachedFile {
    url: string;
    name: string;
    date?: string;
}

function parseAttachedFiles(dbValue: string | null | undefined, defaultName: string): AttachedFile[] {
    if (!dbValue) return [];
    const trimmed = dbValue.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            return JSON.parse(trimmed);
        } catch (e) {
            // fallback
        }
    }
    return [{ url: trimmed, name: defaultName }];
}


function getInitials(name: string) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

const AVATAR_COLORS = [
    { bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-100' },
    { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-100' },
    { bg: 'bg-violet-50', text: 'text-violet-600', border: 'border-violet-100' },
    { bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-100' },
    { bg: 'bg-rose-50', text: 'text-rose-600', border: 'border-rose-100' },
];
function getAvatarColor(name: string) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function computeOpptyEstimate(positions: number | null, rate: number | null, fallbackRate: number | null, workload: number | null): number {
    const r = rate || fallbackRate || 0;
    return (positions || 0) * r * (workload || 0);
}

export default function OpportunityDetailPage() {
    const params = useParams();
    const router = useRouter();
    const id = parseInt(params.id as string);

    const [opp, setOpp] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    // Follow-up is inline-editable independent of the page's global `editing` toggle —
    // saves just its own 3 fields, doesn't touch the rest of the record.
    const [savingFollowUp, setSavingFollowUp] = useState(false);
    const [editData, setEditData] = useState<any>({});
    const [addingContact, setAddingContact] = useState(false);
    const [users, setUsers] = useState<any[]>([]);
    const [accounts, setAccounts] = useState<any[]>([]);
    const [accountContacts, setAccountContacts] = useState<any[]>([]);
    const [loadingContacts, setLoadingContacts] = useState(false);
    const [techTags, setTechTags] = useState<string[]>([]);
    const [selectedLeadName, setSelectedLeadName] = useState<string>('');
    const [editProspectCompanyName, setEditProspectCompanyName] = useState<string>('');
    // Advisory concurrent-edit warning state (lock wiring is set up further down,
    // after the comment sub-editor state it depends on is declared).
    const [lockEditors, setLockEditors] = useState<OtherEditor[] | null>(null);
    const [pendingEditOpen, setPendingEditOpen] = useState<(() => void) | null>(null);
    const [showAllCandidates, setShowAllCandidates] = useState(false);
    const [expandedComments, setExpandedComments] = useState<Record<number, boolean>>({});

    // Manage Stages modal
    const [stagesModalOpen, setStagesModalOpen] = useState(false);

    // Sliding window for the stage bar — shows STAGE_WINDOW_SIZE stages at a time.
    const [stageWindowStart, setStageWindowStart] = useState(0);

    // Recenter the stage window around the current stage when the opp loads or edit mode toggles.
    useEffect(() => {
        if (!opp) return;
        const stages = (opp.stages && opp.stages.length > 0) ? opp.stages : defaultStagesFromLibrary();
        const sortedActive = stages.filter((s: any) => s.isActive).sort((a: any, b: any) => a.order - b.order);
        const bar = editing
            ? sortedActive
            : sortedActive.filter((s: any) => s.stageKey !== 'CLOSED_LOST');
        const lookup = editing ? editData.stage : opp.stage;
        const idx = bar.findIndex((s: any) => s.label === lookup);
        if (idx < 0 || bar.length <= STAGE_WINDOW_SIZE) {
            setStageWindowStart(0);
            return;
        }
        const maxStart = Math.max(0, bar.length - STAGE_WINDOW_SIZE);
        // Position current at slot 1 (2nd of 4) when possible; clamp at edges.
        const next = Math.max(0, Math.min(idx - 1, maxStart));
        setStageWindowStart(next);
    }, [opp?.id, editing]);

    // Post-save stage change info modal
    const [stageInfoModal, setStageInfoModal] = useState<{
        open: boolean;
        oldStage: string;
        newStage: string;
        info: StageChangeInfo;
    } | null>(null);

    // G5: Closure modal state
    const [showClosureModal, setShowClosureModal] = useState(false);
    const [closureType, setClosureType] = useState<'won' | 'lost'>('won');
    const [lostReason, setLostReason] = useState('');
    const [closedComments, setClosedComments] = useState('');
    const [wonCandidateId, setWonCandidateId] = useState<number | null>(null);
    const [closedAmount, setClosedAmount] = useState('');

    // File uploads
    const [uploadingSow, setUploadingSow] = useState(false);
    const [uploadingNda, setUploadingNda] = useState(false);
    const [uploadingOther, setUploadingOther] = useState(false);
    const [uploadingOtherSingle, setUploadingOtherSingle] = useState(false);

    // Archive modal state
    const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
    const [isArchiving, setIsArchiving] = useState(false);

    // Notification modal (replaces native alert)
    const [notifyModal, setNotifyModal] = useState<{ open: boolean; title: string; description: string; variant: 'success' | 'info' | 'danger' }>({ open: false, title: '', description: '', variant: 'info' });

    // Confirm-action modal (replaces native confirm)
    const [confirmActionModal, setConfirmActionModal] = useState<{ open: boolean; title: string; description: string; variant: 'success' | 'info' | 'danger'; confirmLabel?: string; onConfirm: () => void }>({ open: false, title: '', description: '', variant: 'info', onConfirm: () => {} });

    // Manual comments state (History section)
    const [commentContent, setCommentContent] = useState('');
    const [editingCommentId, setEditingCommentId] = useState<number | null>(null);
    const [editCommentContent, setEditCommentContent] = useState('');

    // ── Concurrent-edit presence for the whole record ──
    // Active while the opportunity edit OR a comment sub-editor is open.
    const isEditingAnything = editing || editingCommentId !== null;
    const { acquire: acquireEditLock, release: releaseEditLock } = useEditLock('opportunity', Number.isNaN(id) ? null : id, isEditingAnything);
    const enterEditMode = () => {
        setSelectedLeadName(opp?.sourceContact?.fullName || '');
        setEditProspectCompanyName('');
        setEditing(true);
    };
    const guardEdit = async (open: () => void) => {
        const others = await acquireEditLock();
        if (others.length > 0) { setPendingEditOpen(() => open); setLockEditors(others); }
        else open();
    };
    const requestEdit = () => guardEdit(enterEditMode);

    useEffect(() => {
        async function load() {
            const [oppRes, usersRes, accRes] = await Promise.all([
                getOpportunity(id),
                getUsers(),
                getAccounts()
            ]);
            if (oppRes.success) {
                setOpp(oppRes.data);
                setEditData(oppRes.data);
                setTechTags(oppRes.data.technologies ? oppRes.data.technologies.split(',').map((s: string) => normalizeSkill(s.trim())).filter(Boolean) : []);
                // Load contacts for the current account
                if (oppRes.data.companyId) {
                    getContacts({ companyId: String(oppRes.data.companyId) }).then(res => {
                        if (res.success && res.data) setAccountContacts(res.data);
                    });
                }
            } else {
                setError(oppRes.error as string);
            }
            if (usersRes.success) setUsers(usersRes.data || []);
            if (accRes.success && accRes.data) setAccounts(accRes.data);
            setLoading(false);
        }
        load();
    }, [id]);

    async function handleSave() {
        setSaving(true);
        // Capture pre-save context so we can describe the transition AFTER the server commit
        const previousStage = opp?.stage;
        const previousAccountType = opp?.account?.type;
        const previousSourceContactType = opp?.sourceContact?.type;
        const previousLinkedJobs: { id: number; status: string | null }[] = (opp?.jobs || []).map((j: any) => ({ id: j.id, status: j.status ?? null }));
        const archivedAppCount = opp?.archivedApplications?.length || 0;
        const stageChanged = editData.stage && editData.stage !== previousStage;

        const res = await updateOpportunity(id, {
            title: editData.title,
            stage: editData.stage,
            amount: editData.amount ? parseFloat(editData.amount) : null,
            probability: editData.probability ? parseInt(editData.probability) : null,
            closeDate: editData.closeDate || null,
            type: editData.type || null,
            leadSource: editData.leadSource || null,
            campaign: editData.campaign || null,
            nextStep: editData.nextStep || null,
            description: editData.description || null,
            accountId: editData.companyId ? String(editData.companyId) : null,
            sourceContactId: editData.sourceContactId ?? null,
            prospectCompanyName: editProspectCompanyName || null,
            oppDetails: editData.oppDetails || null,
            dueDate: editData.dueDate || null,
            bdUserId: editData.bdUserId || null,
            rateType: editData.rateType || null,
            clientDesiredRate: editData.clientDesiredRate ? parseFloat(editData.clientDesiredRate) : null,
            proposedRate: editData.proposedRate ? parseFloat(editData.proposedRate) : null,
            numberOfPositions: editData.numberOfPositions ? parseInt(editData.numberOfPositions) : null,
            workload: editData.workload ? parseInt(editData.workload) : null,
            engagementTerm: editData.engagementTerm ? parseInt(editData.engagementTerm) : null,
            englishLevel: editData.englishLevel || null,
            endClient: editData.endClient || null,
            project: editData.project || null,
            workType: editData.workType || null,
            location: editData.location || null,
            technologies: techTags.map(t => normalizeSkill(t)).join(', '),
            additionalContactIds: editData.additionalContactIds || null,
            followUpDate: editData.followUpDate || null,
            followUpTimezone: editData.followUpTimezone || null,
            followUpNotifyEmail: !!editData.followUpNotifyEmail,
        });
        if (res.success) {
            // Re-fetch to get fresh data with relations
            const fresh = await getOpportunity(id);
            if (fresh.success) {
                setOpp(fresh.data);
                setEditData(fresh.data);
            }
            setSelectedLeadName('');
            setEditProspectCompanyName('');
            setEditing(false);

            // Notify if linked Jobs were auto-closed
            if ((res as any).jobClosed) {
                const count = (res as any).jobClosed as number;
                setNotifyModal({ open: true, title: 'Job Orders Closed', description: `${count} linked Job Order${count > 1 ? 's were' : ' was'} automatically closed because this opportunity was lost.`, variant: 'info' });
            }

            // Stage change → surface what was/wasn't auto-mutated so the user
            // can act manually if needed (esp. on reverts).
            if (stageChanged) {
                const info = computeStageChangeInfo(previousStage, editData.stage, {
                    id,
                    accountId: opp?.account?.id ?? null,
                    accountName: opp?.account?.name ?? null,
                    accountType: previousAccountType ?? null,
                    sourceContactId: opp?.sourceContact?.id ?? null,
                    sourceContactName: opp?.sourceContact?.fullName ?? null,
                    sourceContactType: previousSourceContactType ?? null,
                    linkedJobs: previousLinkedJobs,
                    archivedAppCount,
                });
                setStageInfoModal({
                    open: true,
                    oldStage: previousStage,
                    newStage: editData.stage,
                    info,
                });
            }
        }
        setSaving(false);
    }

    // G5: Open closure modal instead of directly saving
    function markAsWon() {
        setClosureType('won');
        setLostReason('');
        setClosedComments('');
        setWonCandidateId(null);
        setClosedAmount(opp.amount ? String(opp.amount) : '');
        setShowClosureModal(true);
    }

    function markAsLost() {
        setClosureType('lost');
        setLostReason('');
        setClosedComments('');
        setWonCandidateId(null);
        setShowClosureModal(true);
    }

    async function handleClosureConfirm() {
        setSaving(true);
        const stage = closureType === 'won' ? 'Closed Won' : 'Closed Lost';
        const updateData: any = {
            stage,
            closedComments: closedComments || null,
        };
        if (closureType === 'lost') {
            updateData.lostReason = lostReason || null;
        }
        if (closureType === 'won' && wonCandidateId) {
            updateData.wonCandidateId = wonCandidateId;
        }
        // G11: Include closedAmount
        if (closureType === 'won' && closedAmount) {
            updateData.closedAmount = parseFloat(closedAmount);
        }

        const res = await updateOpportunity(id, updateData);
        if (res.success) {
            const fresh = await getOpportunity(id);
            if (fresh.success) {
                setOpp(fresh.data);
                setEditData(fresh.data);
            } else {
                setOpp({ ...opp, stage });
            }
            // Notify if linked Job was auto-closed (G3 feedback)
            if ((res as any).jobClosed) {
                setNotifyModal({ open: true, title: 'Job Order Closed', description: `Job Order #${(res as any).jobClosed} was automatically closed because this opportunity was lost or closed.`, variant: 'info' });
            }

            // G9+G12: Auto-convert Lead→Contact on Closed Won without Account
            if (closureType === 'won' && opp.sourceContactId) {
                const { convertLeadToAccount, updateContact } = await import('@/app/actions/commercial/contact');

                if (!opp.companyId && !opp.account) {
                    // No Account — create one as Prospect type
                    const leadName = opp.sourceContact?.companyName || '';
                    if (leadName) {
                        const capturedConvert = convertLeadToAccount;
                        setConfirmActionModal({
                            open: true,
                            title: 'Create Account',
                            description: `Deal won! The company "${leadName}" is not yet an Account.\n\nWould you like to create an Account (Prospect type) from this company?`,
                            variant: 'success',
                            onConfirm: async () => {
                                const convRes = await capturedConvert(opp.sourceContactId);
                                if (convRes.success) {
                                    setNotifyModal({ open: true, title: 'Account Created', description: `Account "${convRes.data?.accountName}" created successfully.`, variant: 'success' });
                                    await updateOpportunity(id, { accountId: convRes.data?.accountId });
                                    const reFresh = await getOpportunity(id);
                                    if (reFresh.success) {
                                        setOpp(reFresh.data);
                                        setEditData(reFresh.data);
                                    }
                                } else {
                                    setNotifyModal({ open: true, title: 'Error', description: convRes.error || 'Failed to create the Account.', variant: 'danger' });
                                }
                                setConfirmActionModal(prev => ({ ...prev, open: false }));
                            },
                        });
                    }
                } else {
                    // G12: Account already exists — just ensure Lead is converted to Contact
                    if (opp.sourceContact?.type === 'LEAD') {
                        try {
                            await updateContact(opp.sourceContactId, {
                                type: 'CONTACT',
                                status: 'Client',
                            });
                        } catch (e) {
                            console.error('Failed to update sourceContact type:', e);
                        }
                    }
                }
            }

            // G13: Warn if Closed Won but Lead has no company name
            if ((res as any).missingCompany) {
                setNotifyModal({ open: true, title: 'Missing Company', description: 'The source Lead has no associated company. An Account could not be created automatically.\n\nPlease link a company to the Lead or create an Account manually from the Lead profile.', variant: 'danger' });
            }
        }
        setShowClosureModal(false);
        setSaving(false);
    }

    // Search callbacks for autocomplete
    const handleSearchJobs = useCallback(async (q: string) => {
        const res = await searchJobs(q);
        if (!res.success) return [];
        const jobs = (res.data || []);
        // Sort: Open first, then Closed
        jobs.sort((a: any, b: any) => {
            const aOpen = (a.status || '').toUpperCase() === 'OPEN' ? 0 : 1;
            const bOpen = (b.status || '').toUpperCase() === 'OPEN' ? 0 : 1;
            return aOpen - bOpen;
        });
        return jobs.map((j: any) => ({
            id: j.id,
            label: `ID: #${j.id} — ${j.title}`,
            sublabel: j.client ? `· ${j.client}` : undefined,
            status: j.status,
        }));
    }, []);

    const handleSearchContacts = useCallback(async (q: string) => {
        const res = await searchContactsAndLeads(q);
        if (!res.success) return [];
        return (res.data || []).map((c: any) => ({
            id: c.id,
            label: c.fullName || `${c.firstName} ${c.lastName}`,
            sublabel: [c.companyName, c.type].filter(Boolean).join(' · '),
        }));
    }, []);

    // Format comment text: supports **bold**, *italic*, ~~strikethrough~~ and HTML tags
    const formatCommentText = (text: string) => {
        if (!text) return '';
        if (/<\/?[a-z][\s\S]*>/i.test(text) || /&(?:nbsp|amp|lt|gt|quot|#\d+|#x[\da-fA-F]+);/i.test(text)) {
            const cleaned = text
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/on\w+="[^"]*"/gi, '')
                .replace(/on\w+='[^']*'/gi, '');
            return cleaned;
        }
        let html = text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            .replace(/\n/g, '<br/>');
        return html;
    };

    // Reload opportunity data (used after comment add/edit/delete)
    async function reloadOpp() {
        const res = await getOpportunity(id);
        if (res.success) {
            setOpp(res.data);
            setEditData(res.data);
        }
    }

    if (loading) return (
        <div className="flex-1 overflow-auto" style={{ backgroundColor: '#F8FAFC' }}>
            <div className="p-8 text-center text-gray-400">Loading...</div>
        </div>
    );

    if (error || !opp) return (
        <div className="flex-1 overflow-auto" style={{ backgroundColor: '#F8FAFC' }}>
            <div className="p-8">
                <div className="rounded-lg bg-red-50 p-4 border border-red-100 text-sm text-red-700">{error || "Opportunity not found"}</div>
            </div>
        </div>
    );

    // Per-Opp stages (active, sorted). Fall back to library defaults if the opp has no stages yet
    // (e.g. created before the schema migration).
    const oppStagesRaw: any[] = (opp.stages && opp.stages.length > 0) ? opp.stages : defaultStagesFromLibrary();
    const activeStages: { stageKey: string; label: string; isSystem: boolean }[] = oppStagesRaw
        .filter((s: any) => s.isActive)
        .sort((a: any, b: any) => a.order - b.order)
        .map((s: any) => ({ stageKey: s.stageKey, label: s.label, isSystem: s.isSystem }));
    // Stages shown in the read-mode progress bar: all active except Closed Lost (which is rendered separately when current).
    const progressStages = activeStages.filter(s => s.stageKey !== 'CLOSED_LOST');
    const currentStageIdx = progressStages.findIndex(s => s.label === opp.stage);

    // Bar to render depends on mode: edit shows all active (clickable), view shows progressStages.
    const barStages = editing ? activeStages : progressStages;
    const currentBarIdx = editing
        ? activeStages.findIndex(s => s.label === editData.stage)
        : currentStageIdx;
    const needsWindow = barStages.length > STAGE_WINDOW_SIZE;
    const maxWindowStart = Math.max(0, barStages.length - STAGE_WINDOW_SIZE);
    const clampedStart = Math.min(Math.max(0, stageWindowStart), maxWindowStart);
    const visibleStart = needsWindow ? clampedStart : 0;
    const visibleEnd = needsWindow ? clampedStart + STAGE_WINDOW_SIZE : barStages.length;
    const visibleStages = barStages.slice(visibleStart, visibleEnd);
    const canScrollLeft = needsWindow && visibleStart > 0;
    const canScrollRight = needsWindow && visibleStart < maxWindowStart;
    const prob = opp.probability || 0;
    const amount = opp.amount ? (typeof opp.amount === 'string' ? parseFloat(opp.amount) : Number(opp.amount)) : 0;
    const expectedRevenue = amount * (prob / 100);

    // Oppty Estimate — use stored value if available, otherwise compute
    const estPositions = editing ? (parseInt(editData.numberOfPositions) || 0) : (opp.numberOfPositions || 0);
    const hasProposedRate = editing ? !!parseFloat(editData.proposedRate) : !!parseFloat(opp.proposedRate);
    const estRate = editing
        ? (parseFloat(editData.proposedRate) || parseFloat(editData.clientDesiredRate) || 0)
        : (parseFloat(opp.proposedRate) || parseFloat(opp.clientDesiredRate) || 0);
    const estWorkload = editing ? (parseInt(editData.workload) || 0) : (opp.workload || 0);
    const computedEstimate = estPositions * estRate * estWorkload;
    const opptyEstimate = opp.estimate ? parseFloat(opp.estimate) : computedEstimate;
    const usedRateLabel = hasProposedRate ? 'Proposed Rate' : (estRate > 0 ? 'Client Rate' : 'Rate');

    // Build the "Create Job Order" link with pre-fill params
    const createJobParams = new URLSearchParams();
    createJobParams.set('fromOpp', String(id));
    if (opp.account?.name) createJobParams.set('client', opp.account.name);
    if (opp.numberOfPositions) createJobParams.set('positions', String(opp.numberOfPositions));
    if (opp.proposedRate || opp.clientDesiredRate) createJobParams.set('rate', String(opp.proposedRate || opp.clientDesiredRate));
    if (opp.technologies) createJobParams.set('technologies', opp.technologies);
    if (opp.endClient) createJobParams.set('endClient', opp.endClient);
    if (opp.englishLevel) createJobParams.set('englishLevel', opp.englishLevel);
    if (opp.title) createJobParams.set('title', opp.title);
    if (opp.contactName) createJobParams.set('contactName', opp.contactName);
    if (opp.project) createJobParams.set('project', opp.project);
    if (opp.workType) createJobParams.set('workType', opp.workType);
    if (opp.location) createJobParams.set('location', opp.location);

    async function handleArchiveOpp(reason: string) {
        setIsArchiving(true);
        const res = await archiveOpportunity(id, reason);
        if (res.success) {
            router.push('/commercial/opportunities');
            router.refresh();
        } else {
            setIsArchiving(false);
        }
    }

    async function handleRestoreOpp() {
        const res = await restoreOpportunity(id);
        if (res.success) {
            const fresh = await getOpportunity(id);
            if (fresh.success) setOpp(fresh.data);
            router.refresh();
        }
    }

    return (
        <div className="flex-1 overflow-auto" style={{ backgroundColor: '#F8FAFC' }}>
            <div className="p-4 max-w-4xl mx-auto space-y-4">

                {/* Back link */}
                <Link href="/commercial/opportunities" className="inline-flex items-center text-xs text-gray-400 hover:text-blue-600 transition-colors gap-1">
                    <ArrowLeft size={12} /> Opportunities
                </Link>

                {/* Archived banner */}
                {opp.isArchived && (
                    <ArchivedBanner
                        reason={opp.archiveReason}
                        archivedAt={opp.archivedAt}
                        archivedBy={opp.archivedBy}
                        onRestore={handleRestoreOpp}
                    />
                )}

                {/* Subtle note if previously archived (after restore) */}
                {!opp.isArchived && (
                    <PreviouslyArchivedNote archiveReason={opp.archiveReason} />
                )}

                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                        {editing ? (
                            <input
                                value={editData.title || ''}
                                onChange={e => setEditData({ ...editData, title: e.target.value })}
                                className="text-xl font-bold text-gray-800 bg-white border border-gray-200 rounded-lg px-3 py-1.5 focus:border-blue-500 outline-none transition-all w-full"
                                style={{ fontFamily: 'var(--font-montserrat)' }}
                            />
                        ) : (
                            <h1 className="text-xl font-bold text-gray-800" style={{ fontFamily: 'var(--font-montserrat)' }}>
                                {opp.title}
                            </h1>
                        )}
                        <div className="flex items-center gap-2 mt-1.5">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${getStageBg(opp.stage)}`}>
                                {opp.stage}
                            </span>
                            {opp.owner?.name && (
                                <span className="text-xs text-gray-400">Owner: {opp.owner.name}</span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        {editing ? (
                            <>
                                <button
                                    onClick={() => {
                                        setSelectedLeadName('');
                                        setEditProspectCompanyName('');
                                        setEditing(false);
                                        setEditData(opp);
                                        setTechTags(opp.technologies ? opp.technologies.split(',').map((s: string) => normalizeSkill(s.trim())).filter(Boolean) : []);
                                    }}
                                    className="px-4 py-2 text-sm font-bold text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-4 py-2 text-sm font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all disabled:opacity-50"
                                >
                                    {saving ? 'Saving...' : 'Save'}
                                </button>
                            </>
                        ) : (
                            <>
                                {opp.stage !== 'Closed Won' && opp.stage !== 'Closed Lost' && (
                                    <>
                                        <button
                                            onClick={markAsLost}
                                            disabled={saving}
                                            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all disabled:opacity-50"
                                            style={{ fontFamily: 'var(--font-lato)' }}
                                        >
                                            <X size={14} /> Lost
                                        </button>
                                        <button
                                            onClick={markAsWon}
                                            disabled={saving}
                                            className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-bold text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-green-50 hover:text-green-600 hover:border-green-200 transition-all disabled:opacity-50"
                                            style={{ fontFamily: 'var(--font-lato)' }}
                                        >
                                            <Trophy size={14} /> Mark as Won
                                        </button>
                                    </>
                                )}
                                <button
                                    onClick={requestEdit}
                                    className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all"
                                    style={{ fontFamily: 'var(--font-lato)' }}
                                >
                                    <Pencil size={14} /> Edit
                                </button>
                                {!opp.isArchived && (
                                    <button
                                        onClick={() => setIsArchiveModalOpen(true)}
                                        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-all"
                                        style={{ fontFamily: 'var(--font-lato)' }}
                                        title="Archive this opportunity (separate from Closed Lost)"
                                    >
                                        <Archive size={14} />
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* G5: Closure Modal */}
                {showClosureModal && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                        <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-md mx-4 p-6 space-y-4">
                            <div className="flex items-center gap-2">
                                {closureType === 'won' ? (
                                    <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                                        <Trophy size={16} className="text-green-600" />
                                    </div>
                                ) : (
                                    <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
                                        <X size={16} className="text-red-600" />
                                    </div>
                                )}
                                <h3 className="text-lg font-bold text-gray-800">
                                    {closureType === 'won' ? 'Mark as Closed Won' : 'Mark as Closed Lost'}
                                </h3>
                            </div>

                            {closureType === 'lost' && (
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Reason for Loss *</label>
                                    <select
                                        value={lostReason}
                                        onChange={e => setLostReason(e.target.value)}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none"
                                    >
                                        <option value="">Select reason...</option>
                                        <option value="Price/Budget">Price / Budget</option>
                                        <option value="Competitor Won">Competitor Won</option>
                                        <option value="No Decision">No Decision / Stalled</option>
                                        <option value="Lost to Internal">Lost to Internal Hire</option>
                                        <option value="Requirements Changed">Requirements Changed</option>
                                        <option value="Timing">Timing / Not Ready</option>
                                        <option value="Relationship">Relationship / Trust</option>
                                        <option value="Other">Other</option>
                                    </select>
                                </div>
                            )}
                            {/* G11: Closed Amount for Won deals */}
                            {closureType === 'won' && (
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Closed Amount (Revenue Final)</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={closedAmount}
                                        onChange={e => setClosedAmount(e.target.value)}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                        placeholder="0.00"
                                    />
                                    {opp.amount && closedAmount && parseFloat(closedAmount) !== parseFloat(String(opp.amount)) && (
                                        <p className="text-[10px] text-amber-600 mt-0.5">
                                            Estimado original: {formatCurrency(opp.amount)} → Final: {formatCurrency(closedAmount)}
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* G4: Won candidate selection */}
                            {closureType === 'won' && opp.candidates?.length > 0 && (
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Winning Candidate</label>
                                    <select
                                        value={wonCandidateId || ''}
                                        onChange={e => setWonCandidateId(e.target.value ? parseInt(e.target.value) : null)}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none"
                                    >
                                        <option value="">Select candidate...</option>
                                        {opp.candidates.map((dc: any) => (
                                            <option key={dc.id} value={dc.candidateId}>
                                                {dc.candidate?.fullName || `Candidate #${dc.candidateId}`}
                                                {dc.pipelineStage === 'HIRED' ? ' ✅ (Hired)' : ''}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Comments</label>
                                <textarea
                                    value={closedComments}
                                    onChange={e => setClosedComments(e.target.value)}
                                    rows={3}
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm resize-none"
                                    placeholder={closureType === 'won' ? 'Deal notes, terms agreed...' : 'Why was this opportunity lost?'}
                                />
                            </div>

                            <div className="flex justify-end gap-2 pt-2">
                                <button
                                    onClick={() => setShowClosureModal(false)}
                                    className="px-4 py-2 text-sm font-bold text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleClosureConfirm}
                                    disabled={saving || (closureType === 'lost' && !lostReason)}
                                    className={`px-5 py-2 text-sm font-bold text-white rounded-lg transition-all disabled:opacity-50 ${
                                        closureType === 'won'
                                            ? 'bg-green-600 hover:bg-green-700'
                                            : 'bg-red-600 hover:bg-red-700'
                                    }`}
                                >
                                    {saving ? 'Saving...' : closureType === 'won' ? 'Confirm Won' : 'Confirm Lost'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Stage Pipeline Bar — sliding window (3-4 stages visible, arrows to scroll) */}
                {editing ? (
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                            <div className="flex-1 bg-white rounded-lg border border-blue-200 ring-1 ring-blue-100 p-1 flex items-stretch">
                                {needsWindow && (
                                    <button type="button" onClick={() => setStageWindowStart(s => Math.max(0, s - 1))}
                                        disabled={!canScrollLeft}
                                        className="flex items-center justify-center px-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-all">
                                        <ChevronLeft className="w-4 h-4" />
                                    </button>
                                )}
                                {visibleStages.map((s) => {
                                    const isSelected = editData.stage === s.label;
                                    const isLost = s.stageKey === 'CLOSED_LOST';
                                    const isWon = s.stageKey === 'CLOSED_WON';
                                    let cls = 'flex-1 min-w-0 py-2 px-2 text-center text-[11px] font-bold uppercase tracking-wide rounded transition-all cursor-pointer truncate ';
                                    if (isSelected) {
                                        cls += isLost ? 'bg-red-600 text-white shadow-sm'
                                            : isWon ? 'bg-green-600 text-white shadow-sm'
                                                : 'bg-blue-600 text-white shadow-sm';
                                    } else {
                                        cls += 'bg-gray-50 text-gray-500 hover:bg-blue-50 hover:text-blue-600';
                                    }
                                    return (
                                        <button key={s.stageKey} type="button"
                                            title={s.label}
                                            onClick={() => setEditData({ ...editData, stage: s.label })}
                                            className={cls}>
                                            {s.label}
                                        </button>
                                    );
                                })}
                                {needsWindow && (
                                    <button type="button" onClick={() => setStageWindowStart(s => Math.min(maxWindowStart, s + 1))}
                                        disabled={!canScrollRight}
                                        className="flex items-center justify-center px-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-all">
                                        <ChevronRight className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                            <button type="button" onClick={() => setStagesModalOpen(true)}
                                title="Manage Stages"
                                aria-label="Manage Stages"
                                className="flex items-center justify-center p-1.5 text-blue-600 bg-white border border-blue-200 rounded-lg hover:bg-blue-50 transition-all flex-shrink-0">
                                <Settings className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        {editData.stage && editData.stage !== opp.stage && (
                            <p className="text-[11px] text-blue-600 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
                                Stage will change from <span className="font-semibold">{opp.stage}</span> to <span className="font-semibold">{editData.stage}</span> on save. You'll see a summary of automatic vs manual side effects.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="flex items-center gap-2">
                        <div className="flex-1 bg-white rounded-lg border border-gray-100 p-1 flex items-stretch">
                            {needsWindow && (
                                <button type="button" onClick={() => setStageWindowStart(s => Math.max(0, s - 1))}
                                    disabled={!canScrollLeft}
                                    className="flex items-center justify-center px-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-all">
                                    <ChevronLeft className="w-4 h-4" />
                                </button>
                            )}
                            {visibleStages.map((s, relIdx) => {
                                const absIdx = visibleStart + relIdx;
                                const isActive = opp.stage === s.label;
                                const isPast = currentStageIdx >= 0 && absIdx < currentStageIdx;
                                let cls = 'flex-1 min-w-0 py-2 px-2 text-center text-[11px] font-bold uppercase tracking-wide rounded transition-all truncate ';
                                if (isActive) cls += 'bg-blue-600 text-white shadow-sm';
                                else if (isPast) cls += 'bg-blue-50 text-blue-600';
                                else cls += 'bg-gray-50 text-gray-400';
                                return <div key={s.stageKey} title={s.label} className={cls}>{s.label}</div>;
                            })}
                            {needsWindow && (
                                <button type="button" onClick={() => setStageWindowStart(s => Math.min(maxWindowStart, s + 1))}
                                    disabled={!canScrollRight}
                                    className="flex items-center justify-center px-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-all">
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                            )}
                            {opp.stage === 'Closed Lost' && (
                                <div className="flex-1 min-w-0 py-2 px-2 text-center text-[11px] font-bold uppercase tracking-wide rounded bg-red-600 text-white shadow-sm truncate" title="Closed Lost">
                                    Closed Lost
                                </div>
                            )}
                        </div>
                        <button type="button" onClick={() => setStagesModalOpen(true)}
                            title="Manage Stages"
                            aria-label="Manage Stages"
                            className="flex items-center justify-center p-1.5 text-gray-500 bg-white border border-gray-200 rounded-lg hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50 transition-all flex-shrink-0">
                            <Settings className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}

                {/* G5: Closure Info Banner */}
                {(opp.stage === 'Closed Won' || opp.stage === 'Closed Lost') && (opp.lostReason || opp.closedComments || opp.wonCandidateId || opp.closedAmount) && (
                    <div className={`rounded-lg border p-4 ${opp.stage === 'Closed Won' ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                        <div className="flex items-center gap-2 mb-2">
                            {opp.stage === 'Closed Won' ? (
                                <Trophy size={14} className="text-green-600" />
                            ) : (
                                <X size={14} className="text-red-600" />
                            )}
                            <span className={`text-xs font-bold uppercase tracking-wider ${opp.stage === 'Closed Won' ? 'text-green-700' : 'text-red-700'}`}>
                                {opp.stage === 'Closed Won' ? 'Deal Won' : 'Deal Lost'}
                            </span>
                        </div>
                        <div className="space-y-1">
                            {opp.lostReason && (
                                <p className="text-sm text-red-700"><span className="font-bold">Reason:</span> {opp.lostReason}</p>
                            )}
                            {opp.wonCandidateId && opp.candidates?.length > 0 && (() => {
                                const winner = opp.candidates.find((dc: any) => dc.candidateId === opp.wonCandidateId);
                                return winner ? (
                                    <p className="text-sm text-green-700">
                                        <span className="font-bold">Winner:</span>{' '}
                                        <Link href={`/candidates/${winner.candidateId}`} className="underline hover:text-green-800">
                                            {winner.candidate?.fullName || `Candidate #${winner.candidateId}`}
                                        </Link>
                                    </p>
                                ) : null;
                            })()}
                            {opp.closedComments && (
                                <p className="text-sm text-gray-600"><span className="font-bold">Comments:</span> {opp.closedComments}</p>
                            )}
                            {opp.closedAmount && (
                                <p className="text-sm text-green-700">
                                    <span className="font-bold">Revenue Final:</span> {formatCurrency(opp.closedAmount)}
                                    {opp.amount && parseFloat(String(opp.closedAmount)) !== parseFloat(String(opp.amount)) && (
                                        <span className="text-xs text-gray-400 ml-2">(Estimado: {formatCurrency(opp.amount)})</span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>
                )}

                {/* Prompt to create Account if Lead has company but no Account linked */}
                {!opp.account && opp.sourceContact?.companyName && (
                    <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-2.5 flex items-center gap-2">
                        <Briefcase size={14} className="text-amber-600" />
                        <span className="text-xs font-bold text-amber-700 uppercase tracking-wider">Lead Company:</span>
                        <span className="text-sm font-medium text-gray-800">{opp.sourceContact.companyName}</span>
                        <span className="text-[10px] text-amber-600 ml-1">(Sin Account vinculado)</span>
                    </div>
                )}

                {/* Financial Summary Cards */}
                <div className="grid grid-cols-4 gap-4">
                    <div className="bg-white rounded-lg border border-gray-100 p-4">
                        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Amount</p>
                        {editing ? (
                            <input
                                value={editData.amount || ''}
                                onChange={e => setEditData({ ...editData, amount: e.target.value })}
                                className="mt-1 text-xl font-bold text-gray-800 bg-white border border-gray-200 rounded-lg px-2 py-1 w-full focus:border-blue-500 outline-none transition-all"
                                placeholder="0"
                            />
                        ) : (
                            <p className="text-xl font-bold text-gray-800 mt-1">{formatCurrency(opp.amount)}</p>
                        )}
                    </div>
                    <div className="bg-white rounded-lg border border-gray-100 p-4">
                        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Expected Revenue</p>
                        <p className="text-xl font-bold text-gray-800 mt-1">{formatCurrency(expectedRevenue)}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">Amount × {prob}%</p>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-100 p-4">
                        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Probability</p>
                        {editing ? (
                            <input
                                value={editData.probability || ''}
                                onChange={e => setEditData({ ...editData, probability: e.target.value })}
                                className="mt-1 text-xl font-bold text-gray-800 bg-white border border-gray-200 rounded-lg px-2 py-1 w-full focus:border-blue-500 outline-none transition-all"
                                placeholder="0"
                            />
                        ) : (
                            <p className="text-xl font-bold text-gray-800 mt-1">{prob}%</p>
                        )}
                    </div>
                    <div className="bg-white rounded-lg border border-gray-100 p-4">
                        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Oppty Estimate</p>
                        <p className="text-xl font-bold text-gray-800 mt-1">{formatCurrency(opptyEstimate || opp.amount)}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">{opp.estimate ? '' : `Pos × ${usedRateLabel} × Hours`}</p>
                    </div>
                </div>

                {/* IDENTIFICACIÓN Section */}
                <div className="bg-white rounded-lg border border-gray-100 p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Identification</span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-8 gap-y-4">
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Type</p>
                            {editing ? (
                                <select
                                    value={editData.type || ''}
                                    onChange={e => {
                                        const newType = e.target.value;
                                        setEditData({
                                            ...editData,
                                            type: newType,
                                            companyId: null,
                                            sourceContactId: null
                                        });
                                        setAccountContacts([]);
                                        setSelectedLeadName('');
                                        setEditProspectCompanyName('');
                                    }}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none"
                                >
                                    <option value="">—</option>
                                    <option value="New Business">New Business</option>
                                    <option value="Existing Business">Existing Business</option>
                                </select>
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.type || '—'}</p>
                            )}
                        </div>

                        {/* Conditional rendering based on Type */}
                        {(editing ? editData.type : opp.type) === 'New Business' ? (
                            <>
                                <div>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Contact (Lead)</p>
                                    {editing ? (
                                        <AutocompleteInput
                                            value={editData.sourceContactId ? String(editData.sourceContactId) : null}
                                            displayValue={selectedLeadName || (opp.sourceContact?.id === editData.sourceContactId ? opp.sourceContact.fullName : '') || ''}
                                            onSearch={async (q) => {
                                                const res = await searchContactsAndLeads(q, 'LEAD');
                                                return (res.data || [])
                                                    .filter((c: any) => c.type === 'LEAD')
                                                    .map((c: any) => ({
                                                        id: String(c.id),
                                                        label: c.fullName || c.name || '',
                                                        sublabel: `${c.companyName || ''} · ${c.type}`.replace(/^ · /, ''),
                                                        companyName: c.companyName || '',
                                                        companyId: c.companyId || null,
                                                    })).sort((a: any, b: any) => a.label.localeCompare(b.label));
                                            }}
                                            onSelect={(opt: any) => {
                                                if (opt) {
                                                    const parsedId = parseInt(String(opt.id));
                                                    setSelectedLeadName(opt.label);
                                                    setEditData({
                                                        ...editData,
                                                        sourceContactId: parsedId,
                                                        companyId: null,
                                                    });
                                                    setEditProspectCompanyName((opt as any).companyName || '');
                                                } else {
                                                    setSelectedLeadName('');
                                                    setEditData({ ...editData, sourceContactId: null });
                                                    setEditProspectCompanyName('');
                                                }
                                            }}
                                            placeholder="Search leads..."
                                        />
                                    ) : (
                                        <p className="text-sm text-gray-800 font-medium mt-0.5">
                                            {opp.sourceContact ? (
                                                <Link href={`/commercial/contacts/${opp.sourceContact.id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{opp.sourceContact.fullName}</Link>
                                            ) : '—'}
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Prospect Account Name</p>
                                    {editing ? (
                                        <input
                                            type="text"
                                            value={editProspectCompanyName}
                                            onChange={e => setEditProspectCompanyName(e.target.value)}
                                            className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                            placeholder="e.g. Acme Corp"
                                        />
                                    ) : (
                                        <p className="text-sm text-gray-800 font-medium mt-0.5">
                                            {opp.sourceContact?.companyName || '—'}
                                        </p>
                                    )}
                                </div>
                            </>
                        ) : (editing ? editData.type : opp.type) === 'Existing Business' ? (
                            <>
                                <div>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Client (Account)</p>
                                    {editing ? (
                                        <AutocompleteInput
                                            value={editData.companyId ? String(editData.companyId) : null}
                                            displayValue={accounts.find((a: any) => a.id === editData.companyId)?.name || ''}
                                            onSearch={(q) => {
                                                const lower = q.toLowerCase();
                                                return accounts
                                                    .filter((a: any) => a.name?.toLowerCase().includes(lower))
                                                    .map((a: any) => ({ id: String(a.id), label: a.name }))
                                                    .sort((a: any, b: any) => a.label.localeCompare(b.label));
                                            }}
                                            onSelect={(opt) => {
                                                const newId = opt ? parseInt(String(opt.id)) : null;
                                                setEditData({ ...editData, companyId: newId, sourceContactId: null });
                                                if (newId) {
                                                    setLoadingContacts(true);
                                                    getContacts({ companyId: String(newId) }).then(res => {
                                                        if (res.success && res.data) setAccountContacts(res.data);
                                                        else setAccountContacts([]);
                                                        setLoadingContacts(false);
                                                    });
                                                } else {
                                                    setAccountContacts([]);
                                                }
                                            }}
                                            placeholder="Search accounts..."
                                        />
                                    ) : (
                                        <p className="text-sm text-gray-800 font-medium mt-0.5">
                                            {opp.account ? (
                                                <Link href={`/commercial/accounts/${opp.account.id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{opp.account.name}</Link>
                                            ) : '—'}
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Contact</p>
                                    {editing ? (
                                        editData.companyId ? (
                                            accountContacts.length > 0 ? (
                                                <AutocompleteInput
                                                    value={editData.sourceContactId ? String(editData.sourceContactId) : null}
                                                    displayValue={accountContacts.find((c: any) => c.id === editData.sourceContactId)?.fullName || ''}
                                                    onSearch={(q) => {
                                                        const lower = q.toLowerCase();
                                                        return accountContacts
                                                            .filter((c: any) => {
                                                                const text = `${c.fullName || ''} ${c.title || ''}`.toLowerCase();
                                                                return text.includes(lower);
                                                            })
                                                            .map((c: any) => ({
                                                                id: String(c.id),
                                                                label: c.fullName || '',
                                                                sublabel: c.title || '',
                                                            }))
                                                            .sort((a: any, b: any) => a.label.localeCompare(b.label));
                                                    }}
                                                    onSelect={(opt) => {
                                                        if (opt) setEditData({ ...editData, sourceContactId: parseInt(String(opt.id)) });
                                                        else setEditData({ ...editData, sourceContactId: null });
                                                    }}
                                                    placeholder="Search contacts..."
                                                />
                                            ) : (
                                                <p className="text-xs text-gray-400 mt-2">{loadingContacts ? 'Loading...' : 'No contacts for this account'}</p>
                                            )
                                        ) : (
                                            <p className="text-xs text-gray-400 mt-2">Select a client first</p>
                                        )
                                    ) : (
                                        <p className="text-sm text-gray-800 font-medium mt-0.5">
                                            {opp.sourceContact ? (
                                                <Link href={`/commercial/contacts/${opp.sourceContact.id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{opp.sourceContact.fullName}</Link>
                                            ) : '—'}
                                        </p>
                                    )}
                                </div>
                            </>
                        ) : (
                            <>
                                {/* Default / No Type selected */}
                                <div>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Client (Account)</p>
                                    {editing ? (
                                        <AutocompleteInput
                                            value={editData.companyId ? String(editData.companyId) : null}
                                            displayValue={accounts.find((a: any) => a.id === editData.companyId)?.name || ''}
                                            onSearch={(q) => {
                                                const lower = q.toLowerCase();
                                                return accounts
                                                    .filter((a: any) => a.name?.toLowerCase().includes(lower))
                                                    .map((a: any) => ({ id: String(a.id), label: a.name }))
                                                    .sort((a: any, b: any) => a.label.localeCompare(b.label));
                                            }}
                                            onSelect={(opt) => {
                                                const newId = opt ? parseInt(String(opt.id)) : null;
                                                setEditData({ ...editData, companyId: newId, sourceContactId: null });
                                                if (newId) {
                                                    setLoadingContacts(true);
                                                    getContacts({ companyId: String(newId) }).then(res => {
                                                        if (res.success && res.data) setAccountContacts(res.data);
                                                        else setAccountContacts([]);
                                                        setLoadingContacts(false);
                                                    });
                                                } else {
                                                    setAccountContacts([]);
                                                }
                                            }}
                                            placeholder="Search accounts..."
                                        />
                                    ) : (
                                        <p className="text-sm text-gray-800 font-medium mt-0.5">
                                            {opp.account ? (
                                                <Link href={`/commercial/accounts/${opp.account.id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{opp.account.name}</Link>
                                            ) : '—'}
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Contact</p>
                                    {editing ? (
                                        <AutocompleteInput
                                            value={editData.sourceContactId ? String(editData.sourceContactId) : null}
                                            displayValue={selectedLeadName || (opp.sourceContact?.id === editData.sourceContactId ? opp.sourceContact.fullName : '') || ''}
                                            onSearch={async (q) => {
                                                const res = await searchContactsAndLeads(q);
                                                return (res.data || []).map((c: any) => ({
                                                    id: String(c.id),
                                                    label: c.fullName || c.name || '',
                                                    sublabel: `${c.companyName || ''} · ${c.type}`.replace(/^ · /, ''),
                                                    companyName: c.companyName || '',
                                                    companyId: c.companyId || null,
                                                })).sort((a: any, b: any) => a.label.localeCompare(b.label));
                                            }}
                                            onSelect={(opt: any) => {
                                                if (opt) {
                                                    const parsedId = parseInt(String(opt.id));
                                                    setSelectedLeadName(opt.label);
                                                    if (opt.companyId) {
                                                        setEditData({
                                                            ...editData,
                                                            sourceContactId: parsedId,
                                                            companyId: opt.companyId,
                                                        });
                                                        setLoadingContacts(true);
                                                        getContacts({ companyId: String(opt.companyId) }).then(res => {
                                                            if (res.success && res.data) setAccountContacts(res.data);
                                                            else setAccountContacts([]);
                                                            setLoadingContacts(false);
                                                        });
                                                    } else {
                                                        setEditData({
                                                            ...editData,
                                                            sourceContactId: parsedId,
                                                            companyId: null,
                                                        });
                                                        setEditProspectCompanyName((opt as any).companyName || '');
                                                    }
                                                } else {
                                                    setSelectedLeadName('');
                                                    setEditData({ ...editData, sourceContactId: null });
                                                    setEditProspectCompanyName('');
                                                }
                                            }}
                                            placeholder="Search contacts & leads..."
                                        />
                                    ) : (
                                        <p className="text-sm text-gray-800 font-medium mt-0.5">
                                            {opp.sourceContact ? (
                                                <Link href={`/commercial/contacts/${opp.sourceContact.id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{opp.sourceContact.fullName}</Link>
                                            ) : '—'}
                                        </p>
                                    )}
                                </div>
                            </>
                        )}

                        {/* Row 2: Col 1 = Start Date, Col 2 = Close Date, Col 3 = Other Contact */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Start Date</p>
                            {editing ? (
                                <input
                                    type="date"
                                    value={toDateInput(editData.dueDate)}
                                    onChange={e => setEditData({ ...editData, dueDate: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{formatDate(opp.dueDate)}</p>
                            )}
                        </div>
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Close Date</p>
                            {editing ? (
                                <input
                                    type="date"
                                    value={toDateInput(editData.closeDate)}
                                    onChange={e => setEditData({ ...editData, closeDate: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{formatDate(opp.closeDate)}</p>
                            )}
                        </div>
                        {/* Row 2 Col 3: Other Contact (fixed) */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Other Contact</p>
                            {editing ? (
                                <AutocompleteInput
                                    value={
                                        editData.additionalContactIds
                                            ? String((JSON.parse(editData.additionalContactIds) as number[])[0] || '')
                                            : null
                                    }
                                    displayValue={
                                        opp.additionalContacts?.[0]?.fullName || ''
                                    }
                                    onSearch={async (q) => {
                                        const res = await searchContactsAndLeads(q);
                                        return (res.data || [])
                                            .map((c: any) => ({
                                                id: String(c.id),
                                                label: c.fullName || c.name || '',
                                                sublabel: `${c.companyName || ''} · ${c.type}`.replace(/^ · /, ''),
                                            }))
                                            .sort((a: any, b: any) => a.label.localeCompare(b.label));
                                    }}
                                    onSelect={(opt) => {
                                        if (opt) {
                                            const newId = Number(opt.id);
                                            setEditData({ ...editData, additionalContactIds: JSON.stringify([newId]) });
                                            setOpp({
                                                ...opp,
                                                additionalContacts: [{
                                                    id: newId,
                                                    fullName: opt.label,
                                                    type: opt.sublabel || 'CONTACT',
                                                    title: '',
                                                    companyName: ''
                                                }]
                                            });
                                        } else {
                                            setEditData({ ...editData, additionalContactIds: null });
                                            setOpp({ ...opp, additionalContacts: [] });
                                        }
                                    }}
                                    placeholder="Search contacts & leads..."
                                />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">
                                    {opp.additionalContacts && opp.additionalContacts[0] ? (
                                        <Link href={`/commercial/contacts/${opp.additionalContacts[0].id}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                                            {opp.additionalContacts[0].fullName}
                                        </Link>
                                    ) : '—'}
                                </p>
                            )}
                        </div>

                        {/* Row 3: Col 1 = Business Owner, Col 2 & 3 = Next Step */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Business Owner</p>
                            {editing ? (
                                <select
                                    value={editData.bdUserId || ''}
                                    onChange={e => setEditData({ ...editData, bdUserId: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none"
                                >
                                    <option value="">—</option>
                                    {users.map((u: any) => (
                                        <option key={u.id} value={u.id}>{u.name || u.email}</option>
                                    ))}
                                </select>
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.bd?.name || '—'}</p>
                            )}
                        </div>
                        <div className="col-span-2">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Next Step</p>
                            {editing ? (
                                <input
                                    type="text"
                                    value={editData.nextStep || ''}
                                    onChange={e => setEditData({ ...editData, nextStep: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                    placeholder="Next action..."
                                />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.nextStep || '—'}</p>
                            )}
                        </div>
                    </div>

                    {/* Opp Details */}
                    <div className="mt-4 pt-2">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Opp Details</p>
                        {editing ? (
                            <RichTextEditor
                                value={editData.oppDetails || ''}
                                onChange={html => setEditData({ ...editData, oppDetails: html })}
                                placeholder="Full briefing of the role..."
                                minHeight="120px"
                            />
                        ) : (
                            <CollapsibleComment
                                content={opp.oppDetails || '<span class="italic text-gray-300">No details provided.</span>'}
                                className="text-sm text-gray-700 leading-relaxed max-w-none"
                                moreLabel="See all"
                                lessLabel="See less"
                            />
                        )}
                    </div>
                </div>

                {/* ── DOCUMENTS SECTION ── */}
                <div className="bg-white rounded-lg border border-gray-100 p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <FileText className="h-3.5 w-3.5 text-blue-500" />
                        <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Documents</span>
                    </div>

                    <p className="text-[11px] text-gray-400 mb-4 font-semibold uppercase tracking-wider">
                        Supported file formats: <span className="text-gray-500">.PDF & .DOC</span>
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {/* SOW BADGE */}
                        <div className="flex flex-col">
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                SOW
                            </label>
                            <div className="space-y-2">
                                {parseAttachedFiles(opp.sowUrl, "SOW Document").map((file, idx) => (
                                    <div key={idx} className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl border border-blue-100 shadow-sm transition-all hover:bg-blue-100/50">
                                        <FileText size={18} className="text-blue-500 flex-shrink-0" />
                                        <div className="flex flex-col min-w-0 flex-1">
                                            <a href={file.url} target="_blank" className="text-sm font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 transition-colors truncate">
                                                {file.name} <ExternalLink size={12} className="flex-shrink-0" />
                                            </a>
                                            {file.date && (
                                                <span className="text-[10px] text-gray-400 mt-0.5 font-medium">Uploaded {new Date(file.date).toLocaleDateString()}</span>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setConfirmActionModal({
                                                    open: true,
                                                    title: 'Remove SOW',
                                                    description: `Are you sure you want to remove the document "${file.name}"? This action takes effect immediately.`,
                                                    variant: 'danger',
                                                    confirmLabel: 'Remove',
                                                    onConfirm: async () => {
                                                        const current = parseAttachedFiles(opp.sowUrl, "SOW Document");
                                                        const updated = current.filter((_, i) => i !== idx);
                                                        const newValue = updated.length === 0 ? null : JSON.stringify(updated);
                                                        await updateOppFile(id, 'sow', newValue);
                                                        const fresh = await getOpportunity(id);
                                                        if (fresh.success) {
                                                            setOpp(fresh.data);
                                                            setEditData(fresh.data);
                                                        }
                                                        setConfirmActionModal(prev => ({ ...prev, open: false }));
                                                    }
                                                });
                                            }}
                                            className="p-1.5 rounded-full hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
                                ))}

                                {parseAttachedFiles(opp.sowUrl, "SOW Document").length < 4 && (
                                    <FileDropzone
                                        onFileSelect={async (file) => {
                                            setUploadingSow(true);
                                            const fd = new FormData();
                                            fd.append('file', file);
                                            try {
                                                const res = await fetch('/api/opportunities/upload-doc', { method: 'POST', body: fd });
                                                const json = await res.json();
                                                if (json.url) {
                                                    const current = parseAttachedFiles(opp.sowUrl, "SOW Document");
                                                    const updated = [...current, { url: json.url, name: json.name || file.name, date: new Date().toISOString() }];
                                                    await updateOppFile(id, 'sow', JSON.stringify(updated));
                                                    const fresh = await getOpportunity(id);
                                                    if (fresh.success) {
                                                        setOpp(fresh.data);
                                                        setEditData(fresh.data);
                                                    }
                                                }
                                            } catch (error) {
                                                console.error('Error uploading SOW:', error);
                                            }
                                            setUploadingSow(false);
                                        }}
                                        label={uploadingSow ? "Uploading..." : "+ Attach SOW"}
                                        accept=".pdf,.doc,.docx"
                                    />
                                )}
                            </div>
                        </div>

                        {/* OTHER BADGE */}
                        <div className="flex flex-col">
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1">
                                Other
                            </label>
                            <div className="space-y-2">
                                {parseAttachedFiles(opp.otherUrl, "Other Document").map((file, idx) => (
                                    <div key={idx} className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl border border-blue-100 shadow-sm transition-all hover:bg-blue-100/50">
                                        <FileText size={18} className="text-blue-500 flex-shrink-0" />
                                        <div className="flex flex-col min-w-0 flex-1">
                                            <a href={file.url} target="_blank" className="text-sm font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 transition-colors truncate">
                                                {file.name} <ExternalLink size={12} className="flex-shrink-0" />
                                            </a>
                                            {file.date && (
                                                <span className="text-[10px] text-gray-400 mt-0.5 font-medium">Uploaded {new Date(file.date).toLocaleDateString()}</span>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setConfirmActionModal({
                                                    open: true,
                                                    title: 'Remove Document',
                                                    description: `Are you sure you want to remove the document "${file.name}"? This action takes effect immediately.`,
                                                    variant: 'danger',
                                                    confirmLabel: 'Remove',
                                                    onConfirm: async () => {
                                                        const current = parseAttachedFiles(opp.otherUrl, "Other Document");
                                                        const updated = current.filter((_, i) => i !== idx);
                                                        const newValue = updated.length === 0 ? null : JSON.stringify(updated);
                                                        await updateOppFile(id, 'other', newValue);
                                                        const fresh = await getOpportunity(id);
                                                        if (fresh.success) {
                                                            setOpp(fresh.data);
                                                            setEditData(fresh.data);
                                                        }
                                                        setConfirmActionModal(prev => ({ ...prev, open: false }));
                                                    }
                                                });
                                            }}
                                            className="p-1.5 rounded-full hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
                                ))}

                                {parseAttachedFiles(opp.otherUrl, "Other Document").length < 4 && (
                                    <FileDropzone
                                        onFileSelect={async (file) => {
                                            setUploadingOtherSingle(true);
                                            const fd = new FormData();
                                            fd.append('file', file);
                                            try {
                                                const res = await fetch('/api/opportunities/upload-doc', { method: 'POST', body: fd });
                                                const json = await res.json();
                                                if (json.url) {
                                                    const current = parseAttachedFiles(opp.otherUrl, "Other Document");
                                                    const updated = [...current, { url: json.url, name: json.name || file.name, date: new Date().toISOString() }];
                                                    await updateOppFile(id, 'other', JSON.stringify(updated));
                                                    const fresh = await getOpportunity(id);
                                                    if (fresh.success) {
                                                        setOpp(fresh.data);
                                                        setEditData(fresh.data);
                                                    }
                                                }
                                            } catch (error) {
                                                console.error('Error uploading other file:', error);
                                            }
                                            setUploadingOtherSingle(false);
                                        }}
                                        label={uploadingOtherSingle ? "Uploading..." : "+ Attach Other"}
                                        accept=".pdf,.doc,.docx"
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </div>


                {/* STAFFING DETAILS Section */}
                <div className="bg-white rounded-lg border border-gray-100 p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Staffing Details</span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-8 gap-y-4">
                        {/* # of Positions */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider"># of Positions</p>
                            {editing ? (
                                <input type="number" value={editData.numberOfPositions || ''} onChange={e => setEditData({ ...editData, numberOfPositions: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="1" />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.numberOfPositions || '—'}</p>
                            )}
                        </div>
                        {/* Rate Type */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Rate Type</p>
                            {editing ? (
                                <select value={editData.rateType || ''} onChange={e => setEditData({ ...editData, rateType: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none">
                                    <option value="">—</option>
                                    {RATE_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.rateType || '—'}</p>
                            )}
                        </div>
                        {/* Client Desired Rate */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Client Desired Rate ($)</p>
                            {editing ? (
                                <input type="number" step="0.01" value={editData.clientDesiredRate || ''} onChange={e => setEditData({ ...editData, clientDesiredRate: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="0" />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{formatCurrency(opp.clientDesiredRate)}</p>
                            )}
                        </div>
                        {/* Proposed Rate */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Proposed Rate ($)</p>
                            {editing ? (
                                <input type="number" step="0.01" value={editData.proposedRate || ''} onChange={e => setEditData({ ...editData, proposedRate: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="0" />
                            ) : (
                                <>
                                    <p className="text-sm text-gray-800 font-medium mt-0.5">{formatCurrency(opp.proposedRate)}</p>
                                    {opp.proposedRate && opp.clientDesiredRate && (() => {
                                        const diff = Number(opp.proposedRate) - Number(opp.clientDesiredRate);
                                        if (diff === 0) return (
                                            <span className="text-[10px] font-bold text-green-600 flex items-center gap-0.5 mt-0.5">✓ Matches client rate</span>
                                        );
                                        if (diff > 0) return (
                                            <span className="text-[10px] font-bold text-amber-600 flex items-center gap-0.5 mt-0.5">↑ ${diff.toLocaleString()} above client rate</span>
                                        );
                                        return (
                                            <span className="text-[10px] font-bold text-green-600 flex items-center gap-0.5 mt-0.5">↓ ${Math.abs(diff).toLocaleString()} below client rate</span>
                                        );
                                    })()}
                                </>
                            )}
                        </div>
                        {/* Workload */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Workload (hours/month)</p>
                            {editing ? (
                                <input type="number" value={editData.workload || ''} onChange={e => setEditData({ ...editData, workload: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="e.g. 160" />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.workload ? `${opp.workload}h` : '—'}</p>
                            )}
                        </div>
                        {/* Engagement Term */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Expected Engagement Term (months)</p>
                            {editing ? (
                                <input type="number" value={editData.engagementTerm || ''} onChange={e => setEditData({ ...editData, engagementTerm: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="e.g. 3" />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.engagementTerm ? `${opp.engagementTerm} mo` : '—'}</p>
                            )}
                        </div>
                        {/* English Level */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">English Level</p>
                            {editing ? (
                                <select value={editData.englishLevel || ''} onChange={e => setEditData({ ...editData, englishLevel: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none">
                                    <option value="">--Select--</option>
                                    {ENGLISH_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                                </select>
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.englishLevel || '—'}</p>
                            )}
                        </div>
                        {/* End Client */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">End Client</p>
                            {editing ? (
                                <input type="text" value={editData.endClient || ''} onChange={e => setEditData({ ...editData, endClient: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="End client name" />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.endClient || '—'}</p>
                            )}
                        </div>
                        {/* G16: Project */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Project</p>
                            {editing ? (
                                <input type="text" value={editData.project || ''} onChange={e => setEditData({ ...editData, project: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" placeholder="Project name" />
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.project || '—'}</p>
                            )}
                        </div>
                        {/* Type */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Type</p>
                            {editing ? (
                                <select value={editData.workType || ''} onChange={e => setEditData({ ...editData, workType: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none">
                                    <option value="">—</option>
                                    <option value="Remote">Remote</option>
                                    <option value="Hybrid">Hybrid</option>
                                    <option value="Onsite">Onsite</option>
                                </select>
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{opp.workType || '—'}</p>
                            )}
                        </div>
                        {/* Location */}
                        <div>
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Location</p>
                            {editing ? (
                                <select
                                    value={editData.location || ''}
                                    onChange={e => setEditData({ ...editData, location: e.target.value })}
                                    className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none"
                                >
                                    <option value="">Select Timezone...</option>
                                    {editData.location && !TIMEZONES.includes(editData.location) && (
                                        <option key={editData.location} value={editData.location}>{editData.location}</option>
                                    )}
                                    {TIMEZONES.map(tz => (
                                        <option key={tz} value={tz}>{tz}</option>
                                    ))}
                                </select>
                            ) : (
                                <p className="text-sm text-gray-800 font-medium mt-0.5">{formatLocationDisplay(opp.location)}</p>
                            )}
                        </div>
                    </div>

                    {/* Technologies / Skills */}
                    <div className="mt-4 pt-2">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Technologies / Skills</p>
                        {editing ? (
                            <TagInput
                                value={techTags}
                                onChange={setTechTags}
                                placeholder="e.g. React, Node.js, Python"
                                normalize={normalizeSkill}
                            />
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {opp.technologies ? opp.technologies.split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string, i: number) => (
                                    <span key={i} className="inline-block px-2 py-0.5 bg-blue-50 text-blue-700 text-xs font-bold rounded-md border border-blue-100">{t}</span>
                                )) : (
                                    <span className="text-sm text-gray-300 italic">No technologies specified</span>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Linked Job Orders (1:N) */}
                    <div className="mt-4 pt-2">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                            Linked Job Orders{(opp.jobs || []).length > 0 ? ` (${opp.jobs.length})` : ''}
                        </p>

                        {/* List of linked jobs (always-visible — view + edit modes) */}
                        {(opp.jobs || []).length > 0 ? (
                            <div className="space-y-4">
                                {opp.jobs.map((j: any) => {
                                    const clientMismatch = opp.account?.name && j.client && j.client.toLowerCase() !== opp.account.name.toLowerCase();

                                    // Construct STAGE_ORDER and STAGE_LABELS dynamically for THIS job order's stages
                                    const activeStages: { key: string; label: string }[] = [];
                                    const seenKeys = new Set<string>();

                                    (j.stages || []).forEach((stg: any) => {
                                        if (!seenKeys.has(stg.stageKey)) {
                                            seenKeys.add(stg.stageKey);
                                            activeStages.push({ key: stg.stageKey, label: stg.label });
                                        }
                                    });

                                    // If for some reason we have no active stages from jobs, fallback to the default ones
                                    if (activeStages.length === 0) {
                                        const DEFAULT_BUILT_IN = [
                                            { key: 'SOURCING', label: 'Sourcing' },
                                            { key: 'HR_INTERVIEW', label: 'HR Interview' },
                                            { key: 'TECH_INTERVIEW', label: 'Technical Interview' },
                                            { key: 'CHALLENGE', label: 'Challenge' },
                                            { key: 'CULTURE_FIT', label: 'Culture Fit Interview' },
                                            { key: 'PRESENTED_TO_CLIENT', label: 'Presented to Client' },
                                            { key: 'CLIENT_FEEDBACK', label: 'Client Feedback' },
                                            { key: 'OFFER', label: 'Offer' },
                                            { key: 'HIRED', label: 'Hired' }
                                        ];
                                        DEFAULT_BUILT_IN.forEach(stg => {
                                            activeStages.push(stg);
                                            seenKeys.add(stg.key);
                                        });
                                    }

                                    // Always append ARCHIVED at the end if not present
                                    if (!seenKeys.has('ARCHIVED')) {
                                        activeStages.push({ key: 'ARCHIVED', label: 'Archived' });
                                        seenKeys.add('ARCHIVED');
                                    }

                                    const STAGE_ORDER = activeStages.map(s => s.key);
                                    const STAGE_LABELS: Record<string, string> = {};
                                    activeStages.forEach(s => { STAGE_LABELS[s.key] = s.label; });

                                    // Compute counts for THIS job's applications
                                    const counts: Record<string, number> = {};
                                    (j.applications || []).forEach((a: any) => {
                                        counts[a.stage] = (counts[a.stage] || 0) + 1;
                                    });

                                    const jobActiveCount = STAGE_ORDER.filter(s => s !== 'ARCHIVED').reduce((sum, s) => sum + (counts[s] || 0), 0);
                                    const jobArchivedCount = counts['ARCHIVED'] || 0;

                                    return (
                                        <div key={j.id} className="group p-4 bg-gray-50/50 rounded-lg border border-gray-200/80 space-y-3 hover:border-gray-300 transition-all shadow-sm">
                                            {/* Job Header */}
                                            <div className="flex items-center justify-between gap-4 flex-wrap">
                                                <div className="flex items-center gap-2">
                                                    <Briefcase size={14} className="text-blue-500 flex-shrink-0" />
                                                    <Link
                                                        href={`/jobs/${j.id}`}
                                                        target="_blank"
                                                        className="text-sm font-extrabold text-blue-600 hover:text-blue-700 transition-colors inline-flex items-center gap-1"
                                                    >
                                                        ID: #{j.id} — {j.title}{j.client ? ` · ${j.client}` : ''}
                                                        <ExternalLink size={12} className="flex-shrink-0" />
                                                    </Link>
                                                    {clientMismatch && (
                                                        <span title={`Job client "${j.client}" ≠ Opp account "${opp.account.name}"`} className="text-amber-500 text-xs flex-shrink-0 font-bold">⚠</span>
                                                    )}
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide flex-shrink-0 ${
                                                        j.status === 'OPEN' ? 'bg-green-50 text-green-600 border border-green-100 font-extrabold' : 'bg-red-50 text-red-600 border border-red-100 font-extrabold'
                                                    }`}>
                                                        {j.status}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={async () => {
                                                            const { unlinkJobFromOpportunity } = await import('@/app/actions/commercial/opportunity');
                                                            const res = await unlinkJobFromOpportunity(j.id);
                                                            if (res.success) {
                                                                const fresh = await getOpportunity(id);
                                                                if (fresh.success) setOpp(fresh.data);
                                                            } else {
                                                                setNotifyModal({ open: true, title: 'Error', description: res.error || 'Failed to unlink', variant: 'danger' });
                                                            }
                                                        }}
                                                        title="Unlink this Job (does not delete it)"
                                                        className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Job Pipeline Stages Grid */}
                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-2.5">
                                                {STAGE_ORDER.filter(s => s !== 'ARCHIVED').map(stage => (
                                                    <div key={stage} className="text-[11px] text-gray-700 flex items-center justify-between bg-white border border-gray-100 rounded px-2.5 py-1.5 shadow-sm min-h-[42px]">
                                                        <span className="font-semibold text-gray-500 leading-tight pr-1.5 text-left" title={STAGE_LABELS[stage] || stage}>
                                                            {STAGE_LABELS[stage] || stage}
                                                        </span>
                                                        <span className={`font-black flex-shrink-0 ${(counts[stage] || 0) > 0 ? 'text-blue-600 text-xs' : 'text-gray-400'}`}>
                                                            {counts[stage] || 0}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>

                                            {/* Job Pipeline Bottom Action/Badges Bar */}
                                            <div className="flex items-center gap-3 mt-1 flex-wrap">
                                                <div className="flex items-center gap-1.5 text-[10px] font-black text-gray-600 bg-gray-100/70 border border-gray-200/50 px-2.5 py-1 rounded-full uppercase tracking-widest shadow-sm">
                                                    <Users size={12} className="text-gray-400 flex-shrink-0" />
                                                    <span>
                                                        <span className="text-blue-600 font-extrabold text-xs">{jobActiveCount}</span> in pipeline
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-1.5 text-[10px] font-black text-gray-600 bg-gray-100/70 border border-gray-200/50 px-2.5 py-1 rounded-full uppercase tracking-widest shadow-sm">
                                                    <Archive size={12} className="text-gray-400 flex-shrink-0" />
                                                    <span>
                                                        <span className="text-red-500 font-extrabold text-xs">{jobArchivedCount}</span> archived
                                                    </span>
                                                </div>
                                                <Link href={`/pipeline?jobId=${j.id}`} className="text-xs font-bold text-blue-600 hover:text-blue-700 hover:underline transition-colors ml-1">
                                                    View Pipeline →
                                                </Link>
                                            </div>
                                        </div>
                                    );
                                })}
                                {/* G8: warn if any linked job was closed externally while Opp is still open */}
                                {opp.jobs.some((j: any) => j.status === 'CLOSED') && opp.stage !== 'Closed Lost' && (
                                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
                                        <span className="text-amber-500 text-sm">⚠️</span>
                                        <p className="text-xs text-amber-800 font-medium">
                                            At least one linked Job is closed. Review if this opportunity needs to be updated.
                                        </p>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm text-gray-300 italic">No Job Orders linked yet</span>
                            </div>
                        )}

                        {/* Add another Job Order — autocomplete + create-new */}
                        <div className="mt-3 space-y-2">
                            <AutocompleteInput
                                value={null}
                                displayValue=""
                                onSelect={async (opt) => {
                                    if (!opt) return;
                                    const { linkJobToOpportunity } = await import('@/app/actions/commercial/opportunity');
                                    const res = await linkJobToOpportunity(id, Number(opt.id));
                                    if (res.success) {
                                        const fresh = await getOpportunity(id);
                                        if (fresh.success) setOpp(fresh.data);
                                    } else {
                                        setNotifyModal({ open: true, title: 'Cannot link Job', description: res.error || 'Failed to link', variant: 'danger' });
                                    }
                                }}
                                onSearch={handleSearchJobs}
                                placeholder={(opp.jobs || []).length > 0 ? '+ Link another Job Order...' : 'Search and link a Job Order...'}
                                renderOption={(opt: any) => (
                                    <div className="flex items-center justify-between w-full gap-2">
                                        <div className="flex-1 min-w-0">
                                            <span className="font-medium">{opt.label}</span>
                                            {opt.sublabel && <span className="text-[11px] text-gray-400 ml-2">{opt.sublabel}</span>}
                                        </div>
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${
                                            (opt.status || '').toUpperCase() === 'OPEN'
                                                ? 'bg-green-100 text-green-700'
                                                : 'bg-gray-100 text-gray-500'
                                        }`}>
                                            {(opt.status || '').toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED'}
                                        </span>
                                    </div>
                                )}
                            />
                            <Link
                                href={`/jobs/new?${createJobParams.toString()}`}
                                className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 transition-colors"
                            >
                                <Plus size={12} /> Or create a new Job Order from this Opp
                            </Link>
                        </div>

                        {/* Rate Mismatch Banner — only meaningful when there's exactly one linked Job */}
                        {!editing && (opp.jobs || []).length === 1 && (() => {
                            const onlyJob = opp.jobs[0];
                            const clientMax = opp.clientDesiredRate || opp.proposedRate;
                            const jobMax = onlyJob.maxRate;
                            if (!clientMax) return null;
                            const mismatch = jobMax && Math.abs(clientMax - jobMax) > 0.01;
                            if (!mismatch) return null;
                            return (
                                <div className="mt-2 p-3 bg-orange-50 rounded-lg border border-orange-200">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-[11px] font-bold text-orange-700">
                                                ⚠ The maximum rate set by the client is ${clientMax}/hr
                                            </p>
                                            <p className="text-[10px] text-orange-500 mt-0.5">The linked Job Order has a different max rate (${jobMax}/hr). Update it to keep them in sync.</p>
                                        </div>
                                        <button
                                            onClick={async () => {
                                                const { syncOppRatesToJob } = await import('@/app/actions/commercial/opportunity');
                                                const res = await syncOppRatesToJob(id);
                                                if (res.success) {
                                                    const fresh = await getOpportunity(id);
                                                    if (fresh.success) { setOpp(fresh.data); setEditData(fresh.data); }
                                                    setNotifyModal({ open: true, title: 'Rates Updated', description: 'Job Order rates have been updated successfully to match this opportunity.', variant: 'success' });
                                                }
                                            }}
                                            className="text-[10px] font-bold text-orange-700 bg-orange-100 hover:bg-orange-200 px-3 py-1.5 rounded-lg border border-orange-300 transition-colors flex-shrink-0"
                                        >
                                            Update Job Rates →
                                        </button>
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </div>

                {/* FOLLOW-UP — inline-editable on its own, independent of the page's Edit/Save */}
                {(() => {
                    const tz = editData.followUpTimezone || 'GMT-3';
                    const parts = editData.followUpDate
                        ? utcDateToZonedParts(new Date(editData.followUpDate), tz)
                        : { dateStr: '', timeStr: '' };

                    const rebuild = (dateStr: string, timeStr: string, nextTz: string) => {
                        if (!dateStr) return null;
                        const [y, m, d] = dateStr.split('-').map(Number);
                        const [h, min] = (timeStr || '09:00').split(':').map(Number);
                        return zonedWallClockToUtcDate(y, m, d, h, min, nextTz).toISOString();
                    };

                    const hasSchedule = !!opp.followUpDate && !opp.followUpNotified;

                    // Dirty check against the last-saved value, not the page's own hasChanges()
                    // (that one covers the whole record and is gated behind the global Edit mode).
                    // Both sides go through new Date(...).toISOString() — editData.followUpDate
                    // may be a Date instance (fresh from the server) or an ISO string (just
                    // rebuilt locally); comparing those directly with !== would always differ.
                    const savedFollowUpIso = opp.followUpDate ? new Date(opp.followUpDate).toISOString() : null;
                    const editFollowUpIso = editData.followUpDate ? new Date(editData.followUpDate).toISOString() : null;
                    const followUpDirty =
                        editFollowUpIso !== savedFollowUpIso ||
                        (editData.followUpTimezone || null) !== (opp.followUpTimezone || null) ||
                        !!editData.followUpNotifyEmail !== !!opp.followUpNotifyEmail;

                    const saveFollowUp = async () => {
                        setSavingFollowUp(true);
                        const res = await updateOpportunity(id, {
                            followUpDate: editData.followUpDate || null,
                            followUpTimezone: editData.followUpTimezone || null,
                            followUpNotifyEmail: !!editData.followUpNotifyEmail,
                        });
                        if (res.success) {
                            const fresh = await getOpportunity(id);
                            if (fresh.success) {
                                setOpp(fresh.data);
                                // Merge only the follow-up fields into editData — this can fire
                                // while the page's own Edit mode has unrelated unsaved changes
                                // sitting in editData, and those must not get clobbered here.
                                setEditData((prev: any) => ({
                                    ...prev,
                                    followUpDate: fresh.data.followUpDate,
                                    followUpTimezone: fresh.data.followUpTimezone,
                                    followUpNotifyEmail: fresh.data.followUpNotifyEmail,
                                }));
                            }
                        }
                        setSavingFollowUp(false);
                    };

                    const cancelFollowUp = () => {
                        setEditData({
                            ...editData,
                            followUpDate: opp.followUpDate ? new Date(opp.followUpDate).toISOString() : null,
                            followUpTimezone: opp.followUpTimezone || null,
                            followUpNotifyEmail: !!opp.followUpNotifyEmail,
                        });
                    };

                    return (
                        <div className="bg-white rounded-lg border border-gray-100 p-5">
                                <div className="flex items-center gap-2 mb-4">
                                    <Calendar className="h-3.5 w-3.5 text-blue-500" />
                                    <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Follow-up</span>
                                </div>

                                {hasSchedule ? (
                                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 flex items-center gap-3 mb-4">
                                        <CalendarCheck className="h-5 w-5 text-emerald-600 flex-shrink-0" />
                                        <div>
                                            <p className="text-xs font-black text-emerald-700 uppercase tracking-widest">Scheduled Follow-up</p>
                                            <p className="text-sm text-emerald-800 mt-0.5">{formatFollowUpInZone(opp.followUpDate, opp.followUpTimezone)}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center gap-3 mb-4">
                                        <CalendarOff className="h-5 w-5 text-amber-600 flex-shrink-0" />
                                        <p className="text-xs font-black text-amber-700 uppercase tracking-widest">No Scheduled Follow-up</p>
                                    </div>
                                )}

                                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Date</p>
                                        <input
                                            type="date"
                                            value={parts.dateStr}
                                            onChange={e => setEditData({ ...editData, followUpTimezone: tz, followUpDate: rebuild(e.target.value, parts.timeStr || '09:00', tz) })}
                                            className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                        />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Time</p>
                                        <input
                                            type="time"
                                            value={parts.timeStr}
                                            onChange={e => setEditData({ ...editData, followUpTimezone: tz, followUpDate: rebuild(parts.dateStr, e.target.value, tz) })}
                                            className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm"
                                        />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Timezone (GMT)</p>
                                        <select
                                            value={tz}
                                            onChange={e => setEditData({ ...editData, followUpTimezone: e.target.value, followUpDate: rebuild(parts.dateStr, parts.timeStr, e.target.value) })}
                                            className="mt-0.5 w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer appearance-none"
                                        >
                                            {FOLLOWUP_TIMEZONES.map(z => <option key={z} value={z}>{z}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        {/* Invisible label + a box sharing the real inputs' padding/border, so the
                                            checkbox row lands at the exact same height instead of an eyeballed margin. */}
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider invisible">Notify by Email</p>
                                        <div className="mt-0.5 w-full px-3 py-2 border border-transparent rounded-lg flex items-center">
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={!!editData.followUpNotifyEmail}
                                                    onChange={e => setEditData({ ...editData, followUpNotifyEmail: e.target.checked })}
                                                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                />
                                                <span className="text-sm text-gray-700">Notify by Email</span>
                                            </label>
                                        </div>
                                    </div>
                                </div>
                                <p className="text-[11px] text-gray-400 mt-3">
                                    Notifies the Business Owner ({opp.bd?.name || 'unassigned — set one above to enable this'}) in the CRM{editData.followUpNotifyEmail ? ' and by email' : ''}.
                                </p>

                                {followUpDirty && (
                                    <div className="flex items-center justify-end gap-3 mt-4">
                                        <button
                                            type="button"
                                            onClick={cancelFollowUp}
                                            disabled={savingFollowUp}
                                            className="text-xs font-semibold text-gray-400 hover:text-gray-600"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={saveFollowUp}
                                            disabled={savingFollowUp}
                                            className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-60"
                                        >
                                            {savingFollowUp ? 'Saving…' : 'Save'}
                                        </button>
                                    </div>
                                )}
                            </div>
                    );
                })()}

                {/* EMPRESA Y CONTACTOS VINCULADOS */}
                <div className="bg-white rounded-lg border border-gray-100 p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Company & Contacts</span>
                    </div>

                    {/* Company */}
                    {opp.account && (
                        <div className="flex items-center justify-between py-2">
                            <div className="flex items-center gap-3">
                                {(() => { const c = getAvatarColor(opp.account.name); return (
                                    <div className={`h-9 w-9 rounded-lg ${c.bg} flex items-center justify-center ${c.text} border ${c.border} flex-shrink-0`}>
                                        <Building2 size={16} />
                                    </div>
                                ); })()}
                                <div>
                                    <div className="flex items-center gap-1.5">
                                        <a href={`/commercial/accounts/${opp.account.id || opp.companyId}`} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-gray-800 hover:text-blue-600 transition-colors">
                                            {opp.account.name}
                                        </a>
                                    </div>
                                    <p className="text-[11px] text-gray-400">
                                        {[opp.account.industry, opp.account.address, opp.account.numberOfEmployees ? `${opp.account.numberOfEmployees} emp.` : null].filter(Boolean).join(' · ') || 'No additional info'}
                                    </p>
                                </div>
                            </div>
                            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 border border-gray-200">
                                Account
                            </span>
                        </div>
                    )}

                    {/* Primary Contact */}
                    <div className="mt-3">
                        {opp.sourceContact ? (
                            <div className="flex items-center justify-between py-3">
                                <div className="flex items-center gap-3">
                                    {(() => { const c = getAvatarColor(opp.sourceContact.fullName); return (
                                        <div className={`h-9 w-9 rounded-lg ${c.bg} flex items-center justify-center ${c.text} text-xs font-bold border ${c.border} flex-shrink-0`}>
                                            {getInitials(opp.sourceContact.fullName)}
                                        </div>
                                    ); })()}
                                    <div>
                                        <div className="flex items-center gap-1.5">
                                            <a href={`/commercial/${opp.sourceContact.type === 'CLIENT_CONTACT' || opp.sourceContact.type === 'FORMER_CLIENT_CONTACT' ? 'contacts' : 'leads'}/${opp.sourceContact.id}`} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-gray-800 hover:text-blue-600 transition-colors">
                                                {opp.sourceContact.fullName}
                                            </a>
                                        </div>
                                        <p className="text-[11px] text-gray-400">
                                            {[opp.sourceContact.title, opp.sourceContact.companyName].filter(Boolean).join(' · ') || (opp.sourceContact.type === 'LEAD' ? 'Lead' : 'Contact')}
                                        </p>
                                    </div>
                                </div>
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${opp.sourceContact.type === 'LEAD' ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-blue-50 text-blue-600 border-blue-200'}`}>
                                    {opp.sourceContact.type === 'LEAD' ? 'Lead' : 'Contact'}
                                </span>
                            </div>
                        ) : opp.contactName ? (
                            <div className="flex items-center justify-between py-2">
                                <div className="flex items-center gap-3">
                                    {(() => { const c = getAvatarColor(opp.contactName); return (
                                        <div className={`h-8 w-8 rounded-lg ${c.bg} flex items-center justify-center ${c.text} text-[10px] font-bold border ${c.border} flex-shrink-0`}>
                                            {getInitials(opp.contactName)}
                                        </div>
                                    ); })()}
                                    <div>
                                        <p className="text-sm font-bold text-gray-800">{opp.contactName}</p>
                                        <p className="text-[11px] text-gray-400 italic">Legacy text — edit to link a real contact</p>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p className="text-sm text-gray-300 italic">No contact linked yet.</p>
                        )}
                    </div>

                    {/* Additional Contacts (read-only cards) */}
                    {(opp.additionalContacts || []).map((ac: any) => (
                        <div key={ac.id} className="flex items-center justify-between py-2">
                            <div className="flex items-center gap-3">
                                {(() => { const c = getAvatarColor(ac.fullName); return (
                                    <div className={`h-9 w-9 rounded-lg ${c.bg} flex items-center justify-center ${c.text} text-xs font-bold border ${c.border} flex-shrink-0`}>
                                        {getInitials(ac.fullName)}
                                    </div>
                                ); })()}
                                <div>
                                    <div className="flex items-center gap-1.5">
                                        <a href={`/commercial/${ac.type === 'CLIENT_CONTACT' || ac.type === 'FORMER_CLIENT_CONTACT' ? 'contacts' : 'leads'}/${ac.id}`} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-gray-800 hover:text-blue-600 transition-colors">
                                            {ac.fullName}
                                        </a>
                                    </div>
                                    <p className="text-[11px] text-gray-400">
                                        {[ac.title, ac.companyName].filter(Boolean).join(' · ') || (ac.type === 'LEAD' ? 'Lead' : 'Contact')}
                                    </p>
                                </div>
                            </div>
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${ac.type === 'LEAD' ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-blue-50 text-blue-600 border-blue-200'}`}>
                                {ac.type === 'LEAD' ? 'Lead' : 'Contact'}
                            </span>
                        </div>
                    ))}
                </div>

                {/* CANDIDATES — unified list (active + archived) */}
                <div className="bg-white rounded-lg border border-gray-100 p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Candidates</span>
                        {(() => {
                            const totalActive = opp.candidates?.length || 0;
                            const totalArchived = opp.archivedApplications?.length || 0;
                            const total = totalActive + totalArchived;
                            return total > 0 ? (
                                <span className="text-[10px] font-bold text-gray-400">({total})</span>
                            ) : null;
                        })()}
                    </div>

                    {(opp.candidates && opp.candidates.length > 0) || (opp.archivedApplications && opp.archivedApplications.length > 0) ? (() => {
                        const combinedList = [
                            ...(opp.candidates || []).map((dc: any) => ({
                                id: `dc-${dc.id}`,
                                candidate: dc.candidate,
                                proposedRate: dc.proposedRate,
                                pipelineStage: dc.pipelineStage,
                                rejectionReason: null,
                                isDc: true,
                                createdAt: dc.createdAt || opp.createdAt
                            })),
                            ...(opp.archivedApplications || []).map((app: any) => ({
                                id: `arch-${app.id}`,
                                candidate: app.candidate,
                                proposedRate: null,
                                pipelineStage: 'ARCHIVED',
                                rejectionReason: app.rejectionReason || (app.previousStage ? `Was at: ${app.previousStage}` : 'Archived'),
                                isDc: false,
                                createdAt: app.createdAt || app.updatedAt || opp.createdAt
                            }))
                        ];

                        // Sort by latest added first
                        const sortedList = combinedList.sort((a, b) => {
                            const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                            const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                            return dateB - dateA;
                        });
                        const displayedList = showAllCandidates ? sortedList : sortedList.slice(0, 5);

                        const STAGE_COLORS: Record<string, string> = {
                            SOURCING: 'bg-gray-100 text-gray-600',
                            HR_INTERVIEW: 'bg-blue-50 text-blue-600 border border-blue-100',
                            TECH_INTERVIEW: 'bg-indigo-50 text-indigo-600 border border-indigo-100',
                            CHALLENGE: 'bg-orange-50 text-orange-600 border border-orange-100',
                            CULTURE_FIT: 'bg-teal-50 text-teal-600 border border-teal-100',
                            PRESENTED_TO_CLIENT: 'bg-purple-50 text-purple-600 border border-purple-100',
                            PRESENTED: 'bg-purple-50 text-purple-600 border border-purple-100',
                            CLIENT_FEEDBACK: 'bg-cyan-50 text-cyan-600 border border-cyan-100',
                            CLIENT_INTERVIEW: 'bg-cyan-50 text-cyan-600 border border-cyan-100',
                            OFFER: 'bg-amber-50 text-amber-600 border border-amber-100',
                            HIRED: 'bg-green-50 text-green-600 border border-green-100',
                            ARCHIVED: 'bg-red-50 text-red-500 border border-red-100',
                        };
                        const STAGE_LABELS: Record<string, string> = {
                            SOURCING: 'Sourcing',
                            HR_INTERVIEW: 'HR Interview',
                            TECH_INTERVIEW: 'Tech Interview',
                            CHALLENGE: 'Challenge',
                            CULTURE_FIT: 'Culture Fit Interview',
                            PRESENTED_TO_CLIENT: 'Presented to Client',
                            PRESENTED: 'Presented to Client',
                            CLIENT_FEEDBACK: 'Client Feedback',
                            CLIENT_INTERVIEW: 'Client Interview',
                            OFFER: 'Offer',
                            HIRED: 'Hired',
                            ARCHIVED: 'Archived',
                        };

                        return (
                            <div className="flex flex-col gap-4">
                                <div className="space-y-1">
                                    {displayedList.map((item: any) => (
                                        <div key={item.id} className="flex items-center justify-between py-2.5">
                                            <div className="flex items-center gap-3">
                                                {item.candidate && (() => { const c = getAvatarColor(item.candidate.fullName); return (
                                                    <div className={`h-8 w-8 rounded-lg ${c.bg} flex items-center justify-center ${c.text} text-[10px] font-bold border ${c.border} flex-shrink-0`}>
                                                        {getInitials(item.candidate.fullName)}
                                                    </div>
                                                ); })()}
                                                <div>
                                                    {item.candidate ? (
                                                        <div className="flex items-center gap-1.5">
                                                            <a href={`/candidates/${item.candidate.id}`} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-gray-800 hover:text-blue-600 transition-colors">
                                                                {item.candidate.fullName}
                                                            </a>
                                                        </div>
                                                    ) : (
                                                        <span className="text-sm font-bold text-gray-400">Unknown</span>
                                                    )}
                                                    <p className="text-[11px] text-gray-400">
                                                        {item.isDc ? (
                                                            [item.candidate?.seniority, item.proposedRate ? `$${item.proposedRate}/hr` : null].filter(Boolean).join(' · ') || 'No details'
                                                        ) : (
                                                            [item.candidate?.seniority, item.rejectionReason].filter(Boolean).join(' · ') || 'Archived'
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                            {item.pipelineStage && (
                                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${STAGE_COLORS[item.pipelineStage] || 'bg-gray-100 text-gray-500'}`}>
                                                    {STAGE_LABELS[item.pipelineStage] || item.pipelineStage}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                {sortedList.length > 5 && (
                                    <div className="pt-2 flex justify-center">
                                        <button
                                            type="button"
                                            onClick={() => setShowAllCandidates(!showAllCandidates)}
                                            className="text-xs font-bold text-blue-600 hover:text-blue-700 hover:underline transition-colors flex items-center gap-1"
                                        >
                                            {showAllCandidates ? (
                                                <>See less</>
                                            ) : (
                                                <>See all ({sortedList.length - 5} more) →</>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })() : (
                        <p className="text-sm text-gray-300 italic">No candidates linked to this opportunity.</p>
                    )}
                </div>


                {/* HISTORY — Manual Comments */}
                <div className="bg-white rounded-lg border border-gray-200 p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <MessageSquare className="h-3.5 w-3.5 text-blue-500" />
                        <span className="text-[11px] font-black text-blue-600 uppercase tracking-widest">History</span>
                    </div>
                    <div className="space-y-4">
                        {/* Add new comment */}
                        <div>
                            <RichTextEditor
                                value={commentContent}
                                onChange={setCommentContent}
                                placeholder="Add a note about this opportunity..."
                                minHeight="90px"
                            />
                            <div className="flex justify-end items-center gap-3 mt-2">
                                {commentContent && commentContent.replace(/<[^>]*>/g, '').trim() && (
                                    <button
                                        type="button"
                                        onClick={() => setCommentContent('')}
                                        className="px-4 py-2 text-sm font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-all"
                                    >
                                        Cancel
                                    </button>
                                )}
                                <button
                                    type="button"
                                    disabled={!commentContent || !commentContent.replace(/<[^>]*>/g, '').trim()}
                                    onClick={async () => {
                                        const fd = new FormData();
                                        fd.set("opportunityId", opp.id.toString());
                                        fd.set("content", commentContent);
                                        await addOppComment(fd);
                                        setCommentContent('');
                                        await reloadOpp();
                                    }}
                                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    Save Comment
                                </button>
                            </div>
                        </div>

                        {/* Comments list — timeline style */}
                        {opp.comments?.length > 0 && (
                            <div className="space-y-6 pt-4">
                                {opp.comments.map((gc: any) => {
                                    return (
                                        <div key={gc.id} className="relative pl-8 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-blue-100">
                                            <div className="absolute left-[-4px] top-0 w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.15)]"></div>
                                            {editingCommentId === gc.id ? (
                                                <div className="border-b border-gray-200 pb-5 p-4 space-y-3">
                                                    <RichTextEditor
                                                        value={editCommentContent}
                                                        onChange={setEditCommentContent}
                                                        placeholder="Edit comment..."
                                                        minHeight="60px"
                                                    />
                                                    <div className="flex justify-end gap-2">
                                                        <button type="button" onClick={() => setEditingCommentId(null)} className="px-4 py-1.5 text-sm font-semibold text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                                                        <button
                                                            type="button"
                                                            onClick={async () => {
                                                                const fd = new FormData();
                                                                fd.set("id", gc.id.toString());
                                                                fd.set("opportunityId", opp.id.toString());
                                                                fd.set("content", editCommentContent);
                                                                await updateOppComment(fd);
                                                                setEditingCommentId(null);
                                                                await reloadOpp();
                                                            }}
                                                            className="px-4 py-1.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                                                        >Save</button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="group">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <div className="flex items-center gap-3 flex-wrap">
                                                            <div className="flex items-center gap-1.5 text-[10px] font-black text-blue-700 bg-blue-50 px-2.5 py-1 rounded-full uppercase tracking-widest">
                                                                <Calendar size={12} />
                                                                {new Date(gc.createdAt).toLocaleDateString()}
                                                            </div>
                                                            {gc.author && (
                                                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">By {gc.author}</span>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                            <button
                                                                type="button"
                                                                onClick={() => guardEdit(() => { setEditingCommentId(gc.id); setEditCommentContent(gc.content); })}
                                                                className="p-1.5 text-gray-300 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                                                            ><Edit size={13} /></button>
                                                            <button
                                                                type="button"
                                                                onClick={() => setConfirmActionModal({
                                                                    open: true,
                                                                    title: 'Delete comment',
                                                                    description: 'Are you sure you want to delete this comment? This action cannot be undone.',
                                                                    variant: 'danger',
                                                                    confirmLabel: 'Yes, Delete',
                                                                    onConfirm: async () => {
                                                                        await deleteOppComment(gc.id, opp.id);
                                                                        setConfirmActionModal(prev => ({ ...prev, open: false }));
                                                                        await reloadOpp();
                                                                    }
                                                                })}
                                                                className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                                            ><Trash2 size={13} /></button>
                                                        </div>
                                                    </div>
                                                    <CollapsibleComment
                                                        content={gc.content}
                                                        className="text-gray-700 text-sm whitespace-pre-wrap leading-relaxed max-w-full"
                                                        formatFn={formatCommentText}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* SYSTEM INFORMATION */}
                <SystemLogTimeline entityType="opportunity" entityId={opp.id} />

            </div>

            {/* Archive Reason Modal */}
            <DeleteReasonModal
                isOpen={isArchiveModalOpen}
                onClose={() => setIsArchiveModalOpen(false)}
                onConfirm={handleArchiveOpp}
                title="Archive Opportunity"
                description="The opportunity will be hidden from the active list but its full history (stage changes, activities, related candidates) will be preserved. You can restore it any time."
                isLoading={isArchiving}
                entityType="opportunity"
                confirmLabel="Archive"
                loadingLabel="Archiving..."
                reasonLabel="Reason for archiving"
            />

            {/* Manage Stages modal */}
            <EditLockModal
                editors={lockEditors}
                recordLabel="opportunity"
                onEditAnyway={() => { const open = pendingEditOpen; setLockEditors(null); setPendingEditOpen(null); open?.(); }}
                onCancel={() => { setLockEditors(null); setPendingEditOpen(null); if (!isEditingAnything) releaseEditLock(); }}
            />

            <OpportunityStagesModal
                open={stagesModalOpen}
                onClose={() => setStagesModalOpen(false)}
                opportunityId={opp.id}
                initialStages={oppStagesRaw.map((s: any) => ({
                    id: s.id,
                    stageKey: s.stageKey,
                    label: s.label,
                    order: s.order,
                    isActive: s.isActive,
                    isSystem: s.isSystem,
                }))}
                onSaved={async () => {
                    // Re-fetch the opp so opp.stages reflects the saved order/labels/customs.
                    const res = await getOpportunity(id);
                    if (res.success) setOpp(res.data);
                    router.refresh();
                }}
            />

            {/* Post-save Stage Change info — surfaces automatic vs manual side effects */}
            {stageInfoModal && (
                <StageChangeInfoModal
                    isOpen={stageInfoModal.open}
                    onClose={() => setStageInfoModal(null)}
                    oldStage={stageInfoModal.oldStage}
                    newStage={stageInfoModal.newStage}
                    autoChanges={stageInfoModal.info.autoChanges}
                    manualNotes={stageInfoModal.info.manualNotes}
                />
            )}

            {/* Notification Modal (replaces native alert) */}
            <ConfirmModal
                isOpen={notifyModal.open}
                onClose={() => setNotifyModal(prev => ({ ...prev, open: false }))}
                onConfirm={() => setNotifyModal(prev => ({ ...prev, open: false }))}
                title={notifyModal.title}
                description={notifyModal.description}
                confirmLabel="OK"
                cancelLabel=""
                variant={notifyModal.variant}
            />

            {/* Confirm Action Modal (replaces native confirm) */}
            <ConfirmModal
                isOpen={confirmActionModal.open}
                onClose={() => setConfirmActionModal(prev => ({ ...prev, open: false }))}
                onConfirm={confirmActionModal.onConfirm}
                title={confirmActionModal.title}
                description={confirmActionModal.description}
                confirmLabel={confirmActionModal.confirmLabel || "Confirm"}
                cancelLabel="Cancel"
                variant={confirmActionModal.variant}
            />
        </div>
    );
}
