'use client';

import { createOpportunity, getUsers, searchContactsAndLeads } from "@/app/actions/commercial/opportunity";
import { getAccounts } from "@/app/actions/commercial/company";
import { getContacts } from "@/app/actions/commercial/contact";
import AutocompleteInput from "@/app/components/ui/AutocompleteInput";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import { Save, X } from "lucide-react";
import Link from "next/link";
import TagInput from "@/app/components/ui/TagInput";
import { normalizeSkill } from "@/app/lib/skills";
import RichTextEditor from "@/app/components/ui/RichTextEditor";
import { TIMEZONES } from "@/app/lib/timezones";

// Default-active stages a new Opp ships with (matches OPP_DEFAULT_ACTIVE_KEYS labels in /app/lib/opportunityStages).
// New Opps default to "Searching"; the full per-Opp customizable set is created on the server in createOpportunity.
const STAGES = [
    "New Opp",
    "Searching",
    "Presented",
    "Client Interview Scheduled",
    "Awaiting Feedback",
    "Awaiting SOW",
    "Closed Won",
    "Closed Lost",
];

const ENGLISH_LEVELS = ['None', 'A1 - Beginner', 'A2 - Elementary', 'B1 - Intermediate', 'B2 - Upper Intermediate', 'C1 - Advanced', 'C2 - Proficient', 'Native'];
const RATE_TYPES = ['Hourly', 'Fixed', 'Monthly'];

function NewOpportunityForm() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // Pre-fill from Lead context via URL params (#11)
    const preSourceContactId = searchParams.get('sourceContactId');
    const preContactName = searchParams.get('contactName');
    const preCompanyName = searchParams.get('companyName');
    const preCompanyName2 = searchParams.get('companyName2');
    const preCompanyName3 = searchParams.get('companyName3');
    const preLeadSource = searchParams.get('leadSource');

    const [isLoading, setIsLoading] = useState(false);
    const [accounts, setAccounts] = useState<any[]>([]);
    const [users, setUsers] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [techTags, setTechTags] = useState<string[]>([]);
    const [workType, setWorkType] = useState('');
    const [businessType, setBusinessType] = useState(preSourceContactId ? 'New Business' : '');
    const [manualCompanyName, setManualCompanyName] = useState(preCompanyName || '');
    const [manualContactName, setManualContactName] = useState(preContactName || '');
    const [selectedLeadName, setSelectedLeadName] = useState(preSourceContactId ? (preContactName || '') : '');
    const [oppDetails, setOppDetails] = useState('');

    // G14: Build list of available companies from Lead
    const availableCompanies = [preCompanyName, preCompanyName2, preCompanyName3].filter(Boolean) as string[];
    const [selectedCompany, setSelectedCompany] = useState<string>(preCompanyName || '');

    // G5: Account contacts state
    const [selectedAccountId, setSelectedAccountId] = useState<string>('');
    const [accountContacts, setAccountContacts] = useState<any[]>([]);
    const [selectedSourceContactId, setSelectedSourceContactId] = useState<string>(preSourceContactId || '');
    const [selectedSourceContactName, setSelectedSourceContactName] = useState<string>(preContactName || '');
    const [loadingContacts, setLoadingContacts] = useState(false);

    const handleTypeChange = (val: string) => {
        setBusinessType(val);
        setSelectedAccountId('');
        setAccountContacts([]);
        setSelectedSourceContactId('');
        setSelectedSourceContactName('');
        setManualCompanyName('');
        setManualContactName('');
        setSelectedLeadName('');
    };

    useEffect(() => {
        Promise.all([
            getAccounts(),
            getUsers()
        ]).then(([accRes, usersRes]) => {
            if (accRes.success && accRes.data) setAccounts(accRes.data);
            if (usersRes.success) setUsers(usersRes.data || []);
        });
    }, []);

    // G5: Fetch contacts when Account changes
    useEffect(() => {
        if (!selectedAccountId) {
            setAccountContacts([]);
            return;
        }
        setLoadingContacts(true);
        getContacts({ companyId: selectedAccountId }).then(res => {
            if (res.success && res.data) {
                setAccountContacts(res.data);
            } else {
                setAccountContacts([]);
            }
            setLoadingContacts(false);
        });
    }, [selectedAccountId]);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setIsLoading(true);
        setError(null);

        const formData = new FormData(event.currentTarget);

        const data = {
            title: formData.get("title") as string,
            accountId: selectedAccountId ? parseInt(selectedAccountId) : null,
            amount: formData.get("amount") ? parseFloat(formData.get("amount") as string) : null,
            stage: formData.get("stage") as string,
            probability: formData.get("probability") ? parseInt(formData.get("probability") as string) : null,
            closeDate: formData.get("closeDate") ? new Date(formData.get("closeDate") as string) : null,
            type: formData.get("type") as string,
            leadSource: preLeadSource || formData.get("leadSource") as string,
            campaign: formData.get("campaign") as string,
            nextStep: formData.get("nextStep") as string,
            oppDetails: formData.get("oppDetails") as string,

            // Main Info
            dueDate: formData.get("dueDate") ? new Date(formData.get("dueDate") as string) : null,
            bdUserId: formData.get("bdUserId") as string || null,

            // Staffing Fields
            rateType: formData.get("rateType") as string,
            clientDesiredRate: formData.get("clientDesiredRate") ? parseFloat(formData.get("clientDesiredRate") as string) : null,
            proposedRate: formData.get("proposedRate") ? parseFloat(formData.get("proposedRate") as string) : null,
            numberOfPositions: formData.get("numberOfPositions") ? parseInt(formData.get("numberOfPositions") as string) : null,
            technologies: techTags.join(', '),
            workload: formData.get("workload") ? parseInt(formData.get("workload") as string) : null,
            engagementTerm: formData.get("engagementTerm") ? parseInt(formData.get("engagementTerm") as string) : null,
            workType: workType || null,
            location: formData.get("location") as string || null,
            englishLevel: formData.get("englishLevel") as string || null,
            endClient: formData.get("endClient") as string || null,
            sourceContactId: businessType === 'New Business' ? (selectedSourceContactId || null) : (selectedSourceContactId || preSourceContactId || null),
            // G14: Pass the target company name so createOpportunity can auto-create
            // a PROSPECT Account server-side (without converting the Lead type yet)
            prospectCompanyName: businessType === 'New Business' ? (manualCompanyName || null) : (!selectedAccountId ? (selectedCompany || preCompanyName || null) : null),
            potentialAccountName: businessType === 'New Business' ? (manualCompanyName || null) : (!selectedAccountId ? (selectedCompany || preCompanyName || null) : null),
            contactName: businessType === 'New Business' ? (manualContactName || null) : (selectedSourceContactName || preContactName || null),
        };

        if (!data.title || !data.stage) {
            setError("Title and Stage are required");
            setIsLoading(false);
            return;
        }

        const result = await createOpportunity(data);

        if (result.success) {
            router.push("/commercial/opportunities?created=opportunity");
            router.refresh();
        } else {
            setError(result.error as string);
            setIsLoading(false);
        }
    }

    return (
        <div className="px-8 pt-5 pb-8 max-w-3xl mx-auto space-y-8 min-h-screen bg-gray-50/50">
            <Link
                href="/commercial/opportunities"
                className="inline-flex items-center text-xs text-gray-400 hover:text-gray-500 transition-colors"
            >
                ← Opportunities
            </Link>

            <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
                {/* Header */}
                <div className="px-8 pt-8 pb-4 border-b border-gray-50 bg-gray-50/50 flex justify-between items-start">
                    <div>
                        <h1 className="text-xl font-bold text-gray-900 font-montserrat">New Opportunity</h1>
                        <p className="text-gray-500 text-sm font-medium font-lato">Create a new deal in the pipeline.</p>
                    </div>
                </div>

                <form id="new-opp-form" onSubmit={onSubmit} className="px-8 pt-3 pb-8 space-y-6">
                    {error && (
                        <div className="p-4 bg-red-50 border-b border-red-100 rounded-lg">
                            <p className="text-sm text-red-600 font-medium">{error}</p>
                        </div>
                    )}

                    {/* ── MAIN INFO ── */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Main Info</span>
                            <div className="h-px bg-gray-100 flex-1"></div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2 col-span-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Opportunity Name *</label>
                                <input type="text" name="title" required placeholder="e.g. Mailvery — Email Tool" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Stage *</label>
                                <select name="stage" required defaultValue="New Opp" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm">
                                    {STAGES.map((s) => (
                                        <option key={s} value={s}>{s}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Amount ($)</label>
                                <input type="number" name="amount" step="0.01" placeholder="0" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Close Date</label>
                                <input type="date" name="closeDate" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Start Date</label>
                                <input type="date" name="dueDate" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Probability (%)</label>
                                <input type="number" name="probability" min="0" max="100" placeholder="e.g. 60" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Business Owner</label>
                                <select name="bdUserId" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm">
                                    <option value="">Select Owner...</option>
                                    {users.map((u) => (
                                        <option key={u.id} value={u.id}>{u.name || u.email}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* ── IDENTIFICATION ── */}
                    <div className="flex flex-col gap-6 pt-6 border-t border-gray-50">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Identification</span>
                            <div className="h-px bg-gray-100 flex-1"></div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2 col-span-2">
                                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Type</label>
                                <select 
                                    name="type" 
                                    value={businessType} 
                                    onChange={(e) => handleTypeChange(e.target.value)} 
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer"
                                >
                                    <option value="">Select Opportunity Type...</option>
                                    <option value="New Business">New Business</option>
                                    <option value="Existing Business">Existing Business</option>
                                </select>
                            </div>

                            {businessType === 'New Business' ? (
                                <>
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Contact (Lead)</label>
                                        <AutocompleteInput
                                            value={selectedSourceContactId || null}
                                            displayValue={selectedLeadName || selectedSourceContactName || ''}
                                            onSearch={async (q) => {
                                                const res = await searchContactsAndLeads(q, 'LEAD');
                                                return (res.data || [])
                                                    .filter((c: any) => c.type === 'LEAD')
                                                    .map((c: any) => ({
                                                        id: String(c.id),
                                                        label: c.fullName || c.name || '',
                                                        sublabel: `${c.companyName || ''} · ${c.type}`.replace(/^ · /, ''),
                                                        companyName: c.companyName || '',
                                                    })).sort((a: any, b: any) => a.label.localeCompare(b.label));
                                            }}
                                            onSelect={(opt) => {
                                                if (opt) {
                                                    setSelectedSourceContactId(String(opt.id));
                                                    setSelectedSourceContactName(opt.label);
                                                    setSelectedLeadName(opt.label);
                                                    setManualContactName(opt.label);
                                                    setManualCompanyName((opt as any).companyName || '');
                                                } else {
                                                    setSelectedSourceContactId('');
                                                    setSelectedSourceContactName('');
                                                    setSelectedLeadName('');
                                                    setManualContactName('');
                                                    setManualCompanyName('');
                                                }
                                            }}
                                            placeholder="Search leads..."
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Prospect Account Name</label>
                                        <input 
                                            type="text" 
                                            value={manualCompanyName} 
                                            onChange={(e) => setManualCompanyName(e.target.value)} 
                                            placeholder="e.g. Acme Corp" 
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" 
                                        />
                                    </div>
                                    <div className="space-y-2 col-span-2">
                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Manual Contact Name</label>
                                        <input 
                                            type="text" 
                                            value={manualContactName} 
                                            onChange={(e) => setManualContactName(e.target.value)} 
                                            placeholder="e.g. John Smith" 
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:border-blue-500 outline-none transition-all font-medium text-sm" 
                                        />
                                    </div>
                                </>
                            ) : businessType === 'Existing Business' ? (
                                <>
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Client (Account)</label>
                                        <AutocompleteInput
                                            value={selectedAccountId || null}
                                            displayValue={accounts.find((a: any) => String(a.id) === selectedAccountId)?.name || ''}
                                            onSearch={(q) => {
                                                const lower = q.toLowerCase();
                                                return accounts
                                                    .filter((a: any) => a.name?.toLowerCase().includes(lower))
                                                    .map((a: any) => ({ id: String(a.id), label: a.name }))
                                                    .sort((a: any, b: any) => a.label.localeCompare(b.label));
                                            }}
                                            onSelect={(opt) => {
                                                if (opt) {
                                                    setSelectedAccountId(String(opt.id));
                                                    setSelectedSourceContactId('');
                                                    setSelectedSourceContactName('');
                                                } else {
                                                    setSelectedAccountId('');
                                                    setSelectedSourceContactId('');
                                                    setSelectedSourceContactName('');
                                                }
                                            }}
                                            placeholder="Search accounts..."
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Contact</label>
                                        {selectedAccountId ? (
                                            accountContacts.length > 0 ? (
                                                <AutocompleteInput
                                                    value={selectedSourceContactId || null}
                                                    displayValue={accountContacts.find((c: any) => String(c.id) === selectedSourceContactId)?.fullName || ''}
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
                                                        if (opt) {
                                                            setSelectedSourceContactId(String(opt.id));
                                                            setSelectedSourceContactName(opt.label);
                                                        } else {
                                                            setSelectedSourceContactId('');
                                                            setSelectedSourceContactName('');
                                                        }
                                                    }}
                                                    placeholder="Search contacts..."
                                                />
                                            ) : (
                                                <p className="text-xs text-gray-400 py-2.5">
                                                    {loadingContacts ? 'Loading contacts...' : 'No contacts for this account'}
                                                </p>
                                            )
                                        ) : (
                                            <div className="p-2.5 rounded-lg bg-gray-50 border border-gray-100 text-xs text-gray-400 font-medium">
                                                Select a client first
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <div className="space-y-2 col-span-2 bg-blue-50/50 border border-blue-100/50 rounded-lg p-4 flex flex-col gap-1">
                                    <p className="text-xs font-bold text-blue-600 uppercase tracking-wider">Identification Guidance</p>
                                    <p className="text-sm text-blue-700/80 font-medium">
                                        Please select opportunity Type above to search/define contact and account information.
                                    </p>
                                </div>
                            )}
                        </div>


                        <div className="space-y-2">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Next Step</label>
                            <input type="text" name="nextStep" placeholder="e.g. Send economic proposal" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Opp Details</label>
                            <RichTextEditor
                                name="oppDetails"
                                value={oppDetails}
                                onChange={setOppDetails}
                                placeholder="Full briefing of the role..."
                                minHeight="120px"
                            />
                        </div>
                    </div>

                    {/* ── STAFFING DETAILS ── */}
                    <div className="flex flex-col gap-6 pt-6 border-t border-gray-50">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-black text-blue-500 uppercase tracking-widest">Staffing Details</span>
                            <div className="h-px bg-gray-100 flex-1"></div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider"># of Positions</label>
                                <input type="number" name="numberOfPositions" defaultValue={1} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Rate Type</label>
                                <select name="rateType" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm">
                                    {RATE_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Client Desired Rate ($)</label>
                                <input type="number" name="clientDesiredRate" step="0.01" placeholder="0" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Proposed Rate ($)</label>
                                <input type="number" name="proposedRate" step="0.01" placeholder="0" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Workload (total hours per month)</label>
                                <input type="number" name="workload" placeholder="e.g. 160" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Expected Engagement Term (months)</label>
                                <input type="number" name="engagementTerm" placeholder="e.g. 3" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">English Level Required</label>
                                <select name="englishLevel" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm">
                                    <option value="">--Select--</option>
                                    {ENGLISH_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                                </select>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">End Client</label>
                                <input type="text" name="endClient" placeholder="End client name" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm" />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Technologies / Skills</label>
                            <TagInput
                                value={techTags}
                                onChange={setTechTags}
                                placeholder="e.g. React, Node.js, Python"
                                normalize={normalizeSkill}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Type</label>
                                <select value={workType} onChange={e => setWorkType(e.target.value)} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm">
                                    <option value="">Select Type...</option>
                                    <option value="Remote">Remote</option>
                                    <option value="Hybrid">Hybrid</option>
                                    <option value="Onsite">Onsite</option>
                                </select>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Location</label>
                                <select name="location" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:bg-white focus:border-blue-500 outline-none transition-all font-medium text-sm cursor-pointer">
                                    <option value="">Select Timezone...</option>
                                    {TIMEZONES.map(tz => (
                                        <option key={tz} value={tz}>{tz}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Footer Actions */}
                    <div className="flex justify-end gap-3 pt-8 border-t border-gray-100">
                        <Link href="/commercial/opportunities" className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-white text-gray-500 border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all" style={{ fontFamily: 'var(--font-lato)' }}>
                            <X size={16} /> Cancel
                        </Link>
                        <button
                            type="submit"
                            disabled={isLoading}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 text-white hover:bg-blue-700 transition-all disabled:opacity-50"
                            style={{ fontFamily: 'var(--font-lato)' }}
                        >
                            <Save size={16} /> {isLoading ? 'Saving...' : 'Save Opportunity'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default function NewOpportunityPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-gray-400">Loading...</div>}>
            <NewOpportunityForm />
        </Suspense>
    );
}
