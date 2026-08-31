'use server'

import { db as prisma } from "@/app/lib/db"
import { revalidatePath } from "next/cache"
import { getServerSession } from "next-auth"
import { authOptions } from "@/app/api/auth/[...nextauth]/route"
import { addSystemLog } from "@/app/actions/systemLog"
import { normalizeSkill } from "@/app/lib/skills"
import { createSystemNotification } from '@/app/actions/automations'
import crypto from "crypto"

// Prisma Decimal → plain number serializer (Next.js can't pass Decimal objects to Client Components)
function serializeOpp(opp: any) {
    if (!opp) return opp;
    return {
        ...opp,
        amount: opp.amount != null ? Number(opp.amount) : null,
        closedAmount: opp.closedAmount != null ? Number(opp.closedAmount) : null,
        clientDesiredRate: opp.clientDesiredRate != null ? Number(opp.clientDesiredRate) : null,
        proposedRate: opp.proposedRate != null ? Number(opp.proposedRate) : null,
        estimate: opp.estimate != null ? Number(opp.estimate) : null,
        jobs: Array.isArray(opp.jobs) ? opp.jobs.map((j: any) => ({
            ...j,
            minRate: j.minRate != null ? Number(j.minRate) : null,
            maxRate: j.maxRate != null ? Number(j.maxRate) : null,
        })) : [],
        candidates: opp.candidates?.map((dc: any) => ({
            ...dc,
            proposedRate: dc.proposedRate != null ? Number(dc.proposedRate) : null,
        })),
        history: opp.history?.map((h: any) => ({
            ...h,
            amount: h.amount != null ? Number(h.amount) : null,
        })),
        comments: opp.comments || [],
    };
}

export async function getOpportunities(opts?: { includeArchived?: boolean; q?: string }) {
    try {
        const where: any = opts?.includeArchived ? {} : { isArchived: false };
        if (opts?.q) {
            const { buildCommercialSearchCondition } = await import("@/app/lib/commercialSearch");
            const searchCondition = buildCommercialSearchCondition(opts.q, [
                "title", "project", "oppDetails", "description", "technologies",
                "endClient", "location", "type", "contactName", "potentialAccountName",
                "lostReason", "closedComments", "account.name", "sourceContact.fullName", "owner.name"
            ]);
            if (searchCondition) {
                where.AND = [...(where.AND || []), searchCondition];
            }
        }
        const opportunities = await (prisma as any).opportunity.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                account: {
                    select: { id: true, name: true }
                },
                owner: {
                    select: { name: true, image: true }
                },
                jobs: {
                    select: { id: true, title: true, client: true, status: true,
                        applications: {
                            where: { stage: 'HIRED' },
                            select: { id: true }
                        }
                    }
                },
                sourceContact: {
                    select: { id: true, fullName: true, type: true, companyName: true, title: true }
                },
                _count: {
                    select: { candidates: true, activities: true, jobs: true }
                }
            }
        })
        return { success: true, data: opportunities.map(serializeOpp) }
    } catch (error) {
        console.error("Error fetching opportunities:", error)
        return { success: false, error: "Failed to fetch opportunities" }
    }
}

export async function getOpportunity(id: number) {
    try {
        const opportunity = await (prisma as any).opportunity.findUnique({
            where: { id },
            include: {
                account: true,
                owner: { select: { id: true, name: true, image: true } },
                bd: { select: { id: true, name: true } },
                jobs: {
                    select: {
                        id: true,
                        title: true,
                        client: true,
                        status: true,
                        minRate: true,
                        maxRate: true,
                        stages: {
                            where: { isActive: true },
                            orderBy: { order: 'asc' }
                        },
                        applications: {
                            select: {
                                id: true,
                                stage: true,
                                candidateId: true
                            }
                        }
                    }
                },
                sourceContact: {
                    select: { id: true, fullName: true, companyName: true, type: true, title: true }
                },
                candidates: {
                    include: {
                        candidate: {
                            select: { id: true, fullName: true, email: true, seniority: true }
                        }
                    },
                    orderBy: { createdAt: 'desc' }
                },
                activities: {
                    orderBy: { createdAt: 'desc' },
                    include: { owner: { select: { name: true, image: true } } }
                },
                history: {
                    orderBy: { createdAt: 'desc' }
                },
                comments: {
                    orderBy: { createdAt: 'desc' }
                },
                stages: {
                    orderBy: { order: 'asc' }
                }
            }
        })
        if (!opportunity) return { success: false, error: "Opportunity not found" }

        // Aggregate pipeline stage counts across ALL linked Jobs (1:N).
        let pipelineSummary: { stage: string; count: number }[] = [];
        let archivedApplications: any[] = [];
        const linkedJobIds: number[] = (opportunity.jobs || []).map((j: any) => j.id);
        if (linkedJobIds.length > 0) {
            const apps = await prisma.application.findMany({
                where: { jobId: { in: linkedJobIds } },
                select: { stage: true, candidateId: true },
            });
            const counts: Record<string, number> = {};
            apps.forEach((a: any) => {
                counts[a.stage] = (counts[a.stage] || 0) + 1;
            });
            pipelineSummary = Object.entries(counts).map(([stage, count]) => ({ stage, count }));

            // Enrich DealCandidates with their pipeline stage (latest across linked jobs)
            if (opportunity.candidates?.length) {
                const appMap = new Map(apps.map((a: any) => [a.candidateId, a.stage]));
                opportunity.candidates = opportunity.candidates.map((dc: any) => ({
                    ...dc,
                    pipelineStage: dc.candidateId ? appMap.get(dc.candidateId) || null : null,
                }));
            }

            // Pull archived apps across all linked jobs
            archivedApplications = await prisma.application.findMany({
                where: { jobId: { in: linkedJobIds }, stage: 'ARCHIVED' },
                select: {
                    id: true,
                    rejectionReason: true,
                    previousStage: true,
                    updatedAt: true,
                    candidate: { select: { id: true, fullName: true } },
                },
                orderBy: { updatedAt: 'desc' },
            });
        }

        // Fetch additional linked contacts
        let additionalContacts: any[] = [];
        if (opportunity.additionalContactIds) {
            try {
                const ids: number[] = JSON.parse(opportunity.additionalContactIds);
                if (ids.length > 0) {
                    additionalContacts = await (prisma as any).contact.findMany({
                        where: { id: { in: ids } },
                        select: { id: true, fullName: true, companyName: true, type: true, title: true },
                    });
                }
            } catch {}
        }

        return { success: true, data: { ...serializeOpp(opportunity), pipelineSummary, archivedApplications, additionalContacts } }
    } catch (error) {
        console.error("Error fetching opportunity:", error)
        return { success: false, error: "Failed to fetch opportunity" }
    }
}

export async function createOpportunity(data: any) {
    try {
        const session = await getServerSession(authOptions)

        // Map accountId to relation connect
        // prospectCompanyName: passed from Lead context to auto-create PROSPECT Account
        const { accountId, linkedJobId, bdUserId, sourceContactId, prospectCompanyName, ...rest } = data
        const createData: any = {
            ...rest,
            owner: (session?.user as any)?.id ? { connect: { id: (session?.user as any).id } } : undefined
        }

        if (accountId) {
            createData.account = { connect: { id: parseInt(accountId) } }
        }
        // linkedJobId at create time: link a single Job to the new Opp by setting
        // Job.opportunityId after the opp is created (1:N FK lives on the Job side).
        if (bdUserId) {
            createData.bd = { connect: { id: bdUserId } }
        }
        if (sourceContactId) {
            createData.sourceContact = { connect: { id: parseInt(sourceContactId) } }
        }

        // Normalize technologies server-side (defense in depth)
        if (createData.technologies) {
            createData.technologies = createData.technologies
                .split(',')
                .map((s: string) => normalizeSkill(s.trim()))
                .filter(Boolean)
                .join(', ');
        }

        const opportunity = await (prisma as any).opportunity.create({
            data: createData
        })

        // A: 1:N — if a linkedJobId was passed at create time, attach that Job to this Opp.
        if (linkedJobId) {
            try {
                await (prisma as any).job.update({
                    where: { id: parseInt(linkedJobId) },
                    data: { opportunityId: opportunity.id },
                });
            } catch (e) {
                console.error("Failed to link Job to new Opp (non-fatal):", e);
            }
        }

        // B: seed per-Opp stage library so the new Opp has its own customizable set.
        try {
            const { OPP_STAGE_LIBRARY, OPP_DEFAULT_ACTIVE_KEYS, OPP_SYSTEM_STAGE_KEYS } = await import("@/app/lib/opportunityStages");
            await (prisma as any).opportunityStage.createMany({
                data: OPP_STAGE_LIBRARY.map((s, idx) => ({
                    opportunityId: opportunity.id,
                    stageKey: s.key,
                    label: s.label,
                    order: idx,
                    isActive: OPP_DEFAULT_ACTIVE_KEYS.includes(s.key),
                    isSystem: OPP_SYSTEM_STAGE_KEYS.includes(s.key),
                })),
            });
        } catch (e) {
            console.error("Failed to seed OpportunityStages on create (non-fatal):", e);
        }

        // Audit: log creation in OpportunityHistory with oldStage=null so the
        // History timeline always has a complete chronological trail starting at creation.
        try {
            const userName = (session?.user as any)?.name || 'System';
            await (prisma as any).opportunityHistory.create({
                data: {
                    opportunityId: opportunity.id,
                    oldStage: "(New)",
                    newStage: opportunity.stage,
                    amount: opportunity.amount,
                    changedBy: userName,
                },
            });
        } catch (e) {
            console.error("Failed to log Opp creation in history (non-fatal):", e);
        }

        // G14: Auto-create PROSPECT Account if Lead has a company but no Account was selected.
        // We link the Account to both the Opp and the Lead WITHOUT converting the lead type —
        // that conversion only happens at Closed Won.
        if (!accountId && sourceContactId && prospectCompanyName?.trim()) {
            try {
                const companyName = prospectCompanyName.trim();
                // Reuse an existing Account with the same name if it exists
                let company = await (prisma as any).company.findFirst({
                    where: { name: companyName },
                    select: { id: true },
                });
                if (!company) {
                    company = await (prisma as any).company.create({
                        data: { name: companyName, type: 'PROSPECT' },
                    });
                }
                // Link opp to the account
                await (prisma as any).opportunity.update({
                    where: { id: opportunity.id },
                    data: { account: { connect: { id: company.id } } },
                });
                // Link the lead to the account (companyId only — type stays LEAD)
                await (prisma as any).contact.update({
                    where: { id: parseInt(sourceContactId) },
                    data: { companyId: company.id },
                });
                revalidatePath('/commercial/accounts');
                revalidatePath('/commercial/leads');
            } catch (e) {
                console.warn('G14: Auto-PROSPECT creation failed (non-fatal):', e);
            }
        }

        revalidatePath('/commercial/opportunities')

        // SystemLog: opportunity created
        try {
            const userName = (session?.user as any)?.name || 'System';
            const correlationId = crypto.randomUUID();
            await addSystemLog({
                entityType: 'opportunity',
                entityId: opportunity.id,
                action: 'created',
                description: `Opportunity created: ${opportunity.title}`,
                changedBy: userName,
                correlationId,
            });
            // Also log on the source lead/contact so their timeline shows the linked OPP
            if (sourceContactId) {
                const contact = await (prisma as any).contact.findUnique({ where: { id: parseInt(sourceContactId) }, select: { type: true } });
                const entityType = contact?.type === 'CLIENT_CONTACT' ? 'contact' : 'lead';
                await addSystemLog({
                    entityType,
                    entityId: parseInt(sourceContactId),
                    action: 'linked_opportunity',
                    description: `Opportunity linked: ${opportunity.title}`,
                    newValue: opportunity.title,
                    metadata: { opportunityId: opportunity.id },
                    changedBy: userName,
                    correlationId,
                });
            }
        } catch {}

        return { success: true, data: serializeOpp(opportunity) }
    } catch (error) {
        console.error("Error creating opportunity:", error)
        return { success: false, error: "Failed to create opportunity" }
    }
}

export async function updateOpportunity(id: number, data: any) {
    try {
        const session = await getServerSession(authOptions)
        const userName = (session?.user as any)?.name || 'System';

        // Handle relation Ids. linkedJobId is intentionally NOT handled here anymore — the
        // Opp/Job link is 1:N via Job.opportunityId and uses dedicated linkJobToOpportunity /
        // unlinkJobFromOpportunity actions.
        const { accountId, linkedJobId: _ignoredLinkedJobId, bdUserId, sourceContactId, prospectCompanyName, ...rest } = data

        // Fetch current opportunity for change detection
        const currentOpp = await (prisma as any).opportunity.findUnique({ where: { id }, include: { account: { select: { name: true } } } });

        // Build comparison data with relation IDs as flat fields
        const comparisonData: any = { ...rest };
        if (accountId !== undefined) comparisonData.accountId = accountId ? parseInt(accountId) : null;
        if (bdUserId !== undefined) comparisonData.bdUserId = bdUserId || null;
        if (sourceContactId !== undefined) comparisonData.sourceContactId = sourceContactId ? parseInt(sourceContactId) : null;

        const { hasChanges } = await import("@/app/lib/changeDetection");
        if (currentOpp && !hasChanges(currentOpp, comparisonData)) {
            // Nothing changed — skip update
            revalidatePath('/commercial/opportunities')
            return { success: true, data: serializeOpp(currentOpp) }
        }

        // Detect stage change → create history record
        const stageChanged = currentOpp && rest.stage && rest.stage !== currentOpp.stage;

        const updateData: any = { ...rest }

        // Auto-set probability based on stage change
        if (stageChanged && rest.stage) {
            const STAGE_PROBABILITY_MAP: Record<string, number> = {
                'NEW_OPP': 10,
                'PREPARING_PROPOSAL': 10,
                'PROPOSAL_PRESENTED': 10,
                'SEARCHING': 10,
                'PRESENTED': 50,
                'CLIENT_INTERVIEW_SCHEDULED': 80,
                'AWAITING_FEEDBACK': 80,
                'AWAITING_SOW': 95,
                'CLOSED_WON': 100,
                'CLOSED_LOST': 0,
            };
            // Look up the stageKey from the OpportunityStage table using the label
            const stageRecord = await (prisma as any).opportunityStage.findFirst({
                where: { opportunityId: id, label: rest.stage, isActive: true },
                select: { stageKey: true },
            });
            const stageKey = stageRecord?.stageKey?.toUpperCase() || '';
            // Strip any CUSTOM_ prefix for custom stages that might reuse a known key
            const normalizedKey = stageKey.startsWith('CUSTOM_') ? '' : stageKey;
            if (normalizedKey in STAGE_PROBABILITY_MAP) {
                updateData.probability = STAGE_PROBABILITY_MAP[normalizedKey];
            }
        }

        // Sanitize date fields: date-only strings → Date objects, empty → null
        const dateFields = ['dueDate', 'closeDate', 'sowDate', 'ndaDate', 'otherDate', 'followUpDate'];
        for (const field of dateFields) {
            if (updateData[field] === '' || updateData[field] === null || updateData[field] === undefined) {
                updateData[field] = null;
            } else if (typeof updateData[field] === 'string') {
                updateData[field] = new Date(updateData[field]);
            }
        }

        // Sanitize numeric fields: strings → numbers, empty → null
        const numericFields = ['amount', 'probability', 'numberOfPositions', 'workload',
            'engagementTerm', 'clientDesiredRate', 'proposedRate', 'closedAmount', 'estimate'];
        for (const field of numericFields) {
            if (updateData[field] === '' || updateData[field] === undefined) {
                updateData[field] = null;
            } else if (typeof updateData[field] === 'string') {
                const parsed = parseFloat(updateData[field]);
                updateData[field] = isNaN(parsed) ? null : parsed;
            }
        }

        // Sanitize optional text fields: empty strings → null
        const textFields = ['type', 'leadSource', 'campaign', 'nextStep', 'contactName',
            'oppDetails', 'project', 'rateType', 'technologies', 'workType', 'location',
            'englishLevel', 'endClient', 'description', 'lostReason', 'closedComments', 'otherUrl'];
        for (const field of textFields) {
            if (updateData[field] === '') updateData[field] = null;
        }

        if (accountId !== undefined) {
            if (accountId) updateData.account = { connect: { id: parseInt(accountId) } }
            else updateData.account = { disconnect: true }
        }

        if (bdUserId !== undefined) {
            if (bdUserId) updateData.bd = { connect: { id: bdUserId } }
            else updateData.bd = { disconnect: true }
        }

        if (sourceContactId !== undefined) {
            if (sourceContactId) updateData.sourceContact = { connect: { id: parseInt(sourceContactId) } }
            else updateData.sourceContact = { disconnect: true }
        }

        // G14: Auto-create PROSPECT Account if Lead has a company but no Account was selected during Opportunity edit.
        const finalSourceContactId = sourceContactId !== undefined ? (sourceContactId ? parseInt(sourceContactId) : null) : (currentOpp?.sourceContactId || null);
        const finalAccountId = accountId !== undefined ? (accountId ? parseInt(accountId) : null) : (currentOpp?.companyId || null);

        if (!finalAccountId && finalSourceContactId && prospectCompanyName?.trim()) {
            try {
                const companyName = prospectCompanyName.trim();
                let company = await (prisma as any).company.findFirst({
                    where: { name: companyName },
                    select: { id: true },
                });
                if (!company) {
                    company = await (prisma as any).company.create({
                        data: { name: companyName, type: 'PROSPECT' },
                    });
                }
                updateData.account = { connect: { id: company.id } };
                
                await (prisma as any).contact.update({
                    where: { id: finalSourceContactId },
                    data: { companyId: company.id },
                });
                revalidatePath('/commercial/accounts');
                revalidatePath('/commercial/leads');
            } catch (e) {
                console.warn('G14: Auto-PROSPECT creation failed (non-fatal):', e);
            }
        }

        // Normalize technologies server-side (defense in depth)
        if (updateData.technologies) {
            updateData.technologies = updateData.technologies
                .split(',')
                .map((s: string) => normalizeSkill(s.trim()))
                .filter(Boolean)
                .join(', ');
        }

        // Rescheduling the follow-up date means the previous reminder cycle is moot —
        // reset so the cron treats it as pending again. Only when the caller actually
        // touched followUpDate (not on every unrelated save).
        if ('followUpDate' in rest) {
            const prevIso = currentOpp?.followUpDate ? new Date(currentOpp.followUpDate).toISOString() : null;
            const nextIso = updateData.followUpDate ? new Date(updateData.followUpDate).toISOString() : null;
            if (prevIso !== nextIso) {
                updateData.followUpNotified = false;
            }
        }

        const opportunity = await (prisma as any).opportunity.update({
            where: { id },
            data: updateData
        })

        // Create stage history entry if stage changed
        if (stageChanged) {
            await (prisma as any).opportunityHistory.create({
                data: {
                    opportunityId: id,
                    oldStage: currentOpp.stage,
                    newStage: rest.stage,
                    amount: currentOpp.amount,
                    changedBy: userName,
                }
            });

            // SystemLog: double-write stage change so it appears in the Timeline
            try {
                const isWon = rest.stage === 'Closed Won';
                const isLost = rest.stage === 'Closed Lost';
                let description = `Stage changed: ${currentOpp.stage} → ${rest.stage}`;
                if (isWon && rest.closedAmount) description += ` — $${Number(rest.closedAmount).toLocaleString()}`;
                if (isLost && rest.lostReason) description += ` — ${rest.lostReason}`;
                await addSystemLog({
                    entityType: 'opportunity',
                    entityId: id,
                    action: 'stage_changed',
                    description,
                    oldValue: currentOpp.stage,
                    newValue: rest.stage,
                    metadata: isWon ? { closedAmount: rest.closedAmount, closedComments: rest.closedComments } : isLost ? { lostReason: rest.lostReason, closedComments: rest.closedComments } : undefined,
                    changedBy: userName,
                });
            } catch {}

            // Auto-close ALL linked Jobs when OPP goes to "Closed Lost"
            if (rest.stage === 'Closed Lost') {
                try {
                    const { default: prismaDB } = await import("@/app/lib/db").then(m => ({ default: m.db }));
                    const linkedJobs = await prismaDB.job.findMany({ where: { opportunityId: id }, select: { id: true } });
                    for (const lj of linkedJobs) {
                        await prismaDB.job.update({
                            where: { id: lj.id },
                            data: {
                                status: 'CLOSED',
                                closureReason: 'Linked Opportunity lost',
                                closureComments: `Auto-closed because opportunity "${opportunity.title}" was lost.`,
                                closedAt: new Date(),
                                closedBy: userName,
                            },
                        });

                        // G12: Auto-archive active Applications on the closed Job
                        const archivedApps = await prismaDB.application.updateMany({
                            where: {
                                jobId: lj.id,
                                stage: { not: 'ARCHIVED' },
                            },
                            data: {
                                stage: 'ARCHIVED',
                                rejectionReason: `Opportunity lost: "${opportunity.title}"`,
                                lastModifiedBy: userName,
                            },
                        });
                        if (archivedApps.count > 0) {
                            console.log(`G12: Archived ${archivedApps.count} applications from Job #${lj.id}`);
                        }
                        revalidatePath(`/jobs/${lj.id}`);
                    }

                    if (linkedJobs.length > 0) {
                        revalidatePath('/jobs');
                        revalidatePath('/pipeline');
                    }
                } catch (e) {
                    console.error("Auto-close linked Jobs failed:", e);
                }
            }

            // Closed Won: promote Account to CUSTOMER and convert co-leads to contacts
            if (rest.stage === 'Closed Won') {
                const correlationId = crypto.randomUUID();
                try {
                    // Re-fetch opportunity with full relations needed
                    const fullOpp = await (prisma as any).opportunity.findUnique({
                        where: { id },
                        include: {
                            sourceContact: true,
                        },
                    });

                    let accountId: number | null = fullOpp?.companyId || null;

                    // If no account linked but there is a source lead, create/find account from lead data
                    if (!accountId && fullOpp?.sourceContact) {
                        const lead = fullOpp.sourceContact;
                        const companyName = (lead.companyName || "").replace(/^View company:\s*/i, "").trim();

                        if (companyName) {
                            let account = await (prisma as any).company.findFirst({
                                where: { name: { equals: companyName } },
                            });

                            if (!account) {
                                let numEmployees: number | null = null;
                                if (lead.numberOfEmployees) {
                                    const parsed = parseInt(String(lead.numberOfEmployees).replace(/[^0-9]/g, ''));
                                    if (!isNaN(parsed)) numEmployees = parsed;
                                }
                                let revenue: number | null = null;
                                if (lead.annualRevenue) {
                                    const parsed = parseFloat(String(lead.annualRevenue).replace(/[^0-9.]/g, ''));
                                    if (!isNaN(parsed)) revenue = parsed;
                                }
                                account = await (prisma as any).company.create({
                                    data: {
                                        name: companyName,
                                        type: "CUSTOMER",
                                        industry: lead.industry || null,
                                        website: lead.website || null,
                                        numberOfEmployees: numEmployees,
                                        description: lead.companyDetails || null,
                                        companyDetails: lead.companyDetails || null,
                                        address: lead.headquarters || null,
                                        source: lead.source || null,
                                        phone: lead.phone || null,
                                        annualRevenue: revenue,
                                        linkedinUrl: lead.companyLinkedinUrl || null,
                                        founded: lead.founded || null,
                                        specialties: lead.specialties || null,
                                        outsourcing: lead.outsourcing || null,
                                        lastModifiedBy: userName,
                                    },
                                });
                                // A3: Account created directly as CUSTOMER from a Won deal
                                const { recordCompanyTypeChange } = await import("@/app/actions/commercial/history");
                                await recordCompanyTypeChange(account.id, null, "CUSTOMER", "opp_won", id);
                                // SystemLog (double-write)
                                try {
                                    await addSystemLog({ entityType: 'account', entityId: account.id, action: 'created', description: `Account created as CUSTOMER (Closed Won)`, correlationId, changedBy: userName });
                                    await addSystemLog({ entityType: 'account', entityId: account.id, action: 'type_changed', description: 'Type set to CUSTOMER', oldValue: null, newValue: 'CUSTOMER', metadata: { trigger: 'opp_won', oppId: id }, correlationId, changedBy: userName });
                                } catch {}
                            } else {
                                // Existing account — promote to CUSTOMER
                                const previousType = account.type;
                                await (prisma as any).company.update({
                                    where: { id: account.id },
                                    data: { type: "CUSTOMER", lastModifiedBy: userName },
                                });
                                // A3: PROSPECT/FORMER → CUSTOMER promotion
                                const { recordCompanyTypeChange } = await import("@/app/actions/commercial/history");
                                await recordCompanyTypeChange(account.id, previousType, "CUSTOMER", "opp_won", id);
                                // SystemLog (double-write)
                                try {
                                    await addSystemLog({ entityType: 'account', entityId: account.id, action: 'type_changed', description: `Type changed from ${previousType || 'none'} to CUSTOMER`, oldValue: previousType || null, newValue: 'CUSTOMER', metadata: { trigger: 'opp_won', oppId: id }, correlationId, changedBy: userName });
                                } catch {}
                            }

                            accountId = account.id;

                            // Link the opportunity to this account
                            await (prisma as any).opportunity.update({
                                where: { id },
                                data: { account: { connect: { id: accountId } } },
                            });
                        }
                    } else if (accountId) {
                        // Account already linked — just promote to CUSTOMER if it isn't already
                        const existingAccount = await (prisma as any).company.findUnique({ where: { id: accountId } });
                        if (existingAccount && existingAccount.type !== "CUSTOMER") {
                            const previousType = existingAccount.type;
                            await (prisma as any).company.update({
                                where: { id: accountId },
                                data: { type: "CUSTOMER", lastModifiedBy: userName },
                            });
                            // A3: Already-linked Account promoted to CUSTOMER
                            const { recordCompanyTypeChange } = await import("@/app/actions/commercial/history");
                            await recordCompanyTypeChange(accountId, previousType, "CUSTOMER", "opp_won", id);
                            // SystemLog (double-write)
                            try {
                                await addSystemLog({ entityType: 'account', entityId: accountId, action: 'type_changed', description: `Type changed from ${previousType || 'none'} to CUSTOMER`, oldValue: previousType || null, newValue: 'CUSTOMER', metadata: { trigger: 'opp_won', oppId: id }, correlationId, changedBy: userName });
                            } catch {}
                        }
                    }

                    // Convert Lead(s) to CLIENT_CONTACT if source contact is a LEAD and we have a resolved accountId
                    if (accountId && fullOpp?.sourceContact && fullOpp.sourceContact.type === "LEAD") {
                        const lead = fullOpp.sourceContact;
                        const companyName = (lead.companyName || "").replace(/^View company:\s*/i, "").trim();

                        // Convert source lead to CLIENT_CONTACT
                        await (prisma as any).contact.update({
                            where: { id: lead.id },
                            data: {
                                companyId: accountId,
                                type: "CLIENT_CONTACT",
                                convertedAt: new Date(),           // Sprint 2: when converted
                                convertedFromOppId: id,            // Sprint 2: which Opp triggered it
                                lastModifiedBy: userName,
                            },
                        });

                        // Log for the primary lead
                        try {
                            await addSystemLog({
                                entityType: 'lead',
                                entityId: lead.id,
                                action: 'converted',
                                description: `Converted to CLIENT_CONTACT via Opportunity Closed Won`,
                                metadata: { accountId, opportunityId: id },
                                changedBy: userName,
                                correlationId
                            });
                            await addSystemLog({
                                entityType: 'contact',
                                entityId: lead.id,
                                action: 'converted',
                                description: `Contact converted from Lead via Opportunity Closed Won`,
                                metadata: { accountId, opportunityId: id },
                                changedBy: userName,
                                correlationId
                            });
                        } catch (err) {
                            console.error("Failed to log primary lead conversion:", err);
                        }

                        // Convert co-leads if companyName is present
                        if (companyName) {
                            const coLeads = await (prisma as any).contact.findMany({
                                where: {
                                    type: "LEAD",
                                    isArchived: false,
                                    companyId: null,
                                    id: { not: lead.id },
                                    OR: [
                                        { companyName: companyName },
                                        { companyName2: companyName },
                                        { companyName3: companyName },
                                    ],
                                },
                                select: { id: true }
                            });

                            if (coLeads.length > 0) {
                                const coLeadIds = coLeads.map((cl: any) => cl.id);
                                await (prisma as any).contact.updateMany({
                                    where: { id: { in: coLeadIds } },
                                    data: {
                                        companyId: accountId,
                                        type: "CLIENT_CONTACT",
                                        convertedAt: new Date(),           // Sprint 2
                                        convertedFromOppId: id,            // Sprint 2
                                        lastModifiedBy: userName,
                                    },
                                });

                                // Log for each co-lead
                                for (const cl of coLeads) {
                                    try {
                                        await addSystemLog({
                                            entityType: 'lead',
                                            entityId: cl.id,
                                            action: 'converted',
                                            description: `Converted to CLIENT_CONTACT as co-lead via Opportunity Closed Won`,
                                            metadata: { accountId, opportunityId: id },
                                            changedBy: userName,
                                            correlationId
                                        });
                                        await addSystemLog({
                                            entityType: 'contact',
                                            entityId: cl.id,
                                            action: 'converted',
                                            description: `Contact converted from co-lead via Opportunity Closed Won`,
                                            metadata: { accountId, opportunityId: id },
                                            changedBy: userName,
                                            correlationId
                                        });
                                    } catch (err) {
                                        console.error("Failed to log co-lead conversion:", err);
                                    }
                                }
                            }
                        }
                    }

                    if (accountId) {
                        revalidatePath('/commercial/accounts');
                        revalidatePath(`/commercial/accounts/${accountId}`);
                        revalidatePath('/commercial/leads');
                        revalidatePath('/commercial/contacts');
                    }
                } catch (e) {
                    console.error("Closed Won account promotion failed:", e);
                }
            }

            // Auto-create Job Order when OPP moves to Searching
            if (rest.stage === 'Searching') {
                try {
                    const { default: prismaDB } = await import("@/app/lib/db").then(m => ({ default: m.db }));

                    // Check if a linked Job already exists for this OPP (avoid duplicates)
                    const existingJob = await prismaDB.job.findFirst({ where: { opportunityId: id } });

                    if (!existingJob) {
                        // Fetch full OPP data with account for client name
                        const fullOpp = await (prisma as any).opportunity.findUnique({
                            where: { id },
                            include: { account: { select: { name: true } }, owner: { select: { name: true } }, bd: { select: { name: true } } },
                        });

                        const accountName = fullOpp?.account?.name || fullOpp?.potentialAccountName || '';

                        // Create Job Order from OPP data
                        const newJob = await prismaDB.job.create({
                            data: {
                                title: fullOpp?.title || `Job from OPP #${id}`,
                                project: fullOpp?.project || null,
                                client: accountName || null,
                                endClient: fullOpp?.endClient || null,
                                description: fullOpp?.oppDetails || fullOpp?.description || null,
                                mandatorySkills: fullOpp?.technologies || null,
                                location: fullOpp?.location || null,
                                workType: fullOpp?.workType || null,
                                englishLevel: fullOpp?.englishLevel || null,
                                numberOfPositions: fullOpp?.numberOfPositions || 1,
                                minRate: fullOpp?.clientDesiredRate || null,
                                maxRate: fullOpp?.proposedRate || null,
                                onboardingDate: fullOpp?.dueDate || null,
                                status: 'OPEN',
                                opportunityId: id,
                            },
                        });

                        // Initialize default pipeline stages for the new Job
                        try {
                            const { getOrInitJobStages } = await import("@/app/actions/jobStages");
                            await getOrInitJobStages(newJob.id);
                        } catch {}

                        // SystemLog: Job auto-created from OPP
                        try {
                            await addSystemLog({ entityType: 'job', entityId: newJob.id, action: 'created', description: `Job auto-created from Opportunity: ${fullOpp?.title || 'OPP #' + id}`, changedBy: userName });
                            await addSystemLog({ entityType: 'opportunity', entityId: id, action: 'job_auto_created', description: `Job Order auto-created: "${newJob.title}" (#${newJob.id})`, metadata: { jobId: newJob.id }, changedBy: userName });
                        } catch {}

                        // Notification: Job created from OPP → alert HR
                        await createSystemNotification('OPP_SEARCHING', {
                            type: 'JOB_AUTO_CREATED',
                            message: `📋 Job Order auto-created: "${newJob.title}"${accountName ? ` (${accountName})` : ''} — Start searching candidates!`,
                            link: `/jobs/${newJob.id}`,
                            icon: '📋',
                            sourceModule: 'commercial',
                            sourceId: id,
                        });

                        // Email: Send OPP details to the team
                        try {
                            await sendSearchingEmail(fullOpp, accountName, `/jobs/${newJob.id}`, `Job Order auto-created: "${newJob.title}"`);
                        } catch (emailErr) { console.error('OPP Searching email failed:', emailErr); }

                        revalidatePath('/jobs');
                        revalidatePath(`/jobs/${newJob.id}`);
                    } else {
                        // Job already exists — just send notification
                        const oppTitle = opportunity.title || `OPP #${id}`;
                        const accountName = currentOpp.account?.name || '';
                        await createSystemNotification('OPP_SEARCHING', {
                            type: 'OPP_SEARCHING',
                            message: `🔍 "${oppTitle}"${accountName ? ` (${accountName})` : ''} moved to Searching — Job Order already linked (#${existingJob.id})`,
                            link: `/jobs/${existingJob.id}`,
                            icon: '🔍',
                            sourceModule: 'commercial',
                            sourceId: id,
                        });

                        // Email: Send OPP details to the team (even if job already existed)
                        try {
                            const fullOpp = await (prisma as any).opportunity.findUnique({
                                where: { id },
                                include: { account: { select: { name: true } }, owner: { select: { name: true } }, bd: { select: { name: true } } },
                            });
                            await sendSearchingEmail(fullOpp, accountName || fullOpp?.account?.name || '', `/jobs/${existingJob.id}`, `Job Order already linked (#${existingJob.id})`);
                        } catch (emailErr) { console.error('OPP Searching email failed:', emailErr); }
                    }
                } catch (e) {
                    console.error("Auto-create Job from OPP Searching failed (non-fatal):", e);
                }
            }

            // System Automation: OPP moves to Awaiting SOW
            if (rest.stage === 'Awaiting SOW') {
                try {
                    const oppTitle = rest.title || currentOpp?.title || '';
                    await createSystemNotification('OPP_AWAITING_SOW', {
                        type: 'OPP_AWAITING_SOW',
                        message: `📄 "${oppTitle}" is now Awaiting SOW — prepare documentation`,
                        link: `/commercial/opportunities/${id}`,
                        icon: '📄',
                        sourceModule: 'commercial',
                        sourceId: id,
                    });
                } catch (e) { console.error('Awaiting SOW notification failed:', e); }
            }

            // G18: Create notification for Won/Lost
            if (rest.stage === 'Closed Won' || rest.stage === 'Closed Lost') {
                try {
                    const oppTitle = opportunity.title || `OPP #${id}`;
                    const isWon = rest.stage === 'Closed Won';
                    const closedAmt = rest.closedAmount ? ` — $${Number(rest.closedAmount).toLocaleString()}` : '';
                    if (isWon) {
                        await createSystemNotification('OPP_CLOSED_WON', {
                            type: "OPP_WON",
                            message: `Deal won: "${oppTitle}"${closedAmt}`,
                            link: `/commercial/opportunities/${id}`,
                            icon: "🏆",
                            sourceModule: "commercial",
                            sourceId: id,
                        });
                    }
                    if (!isWon) {
                        await createSystemNotification('OPP_CLOSED_LOST', {
                            type: "OPP_LOST",
                            message: `Deal lost: "${oppTitle}" — ${rest.lostReason || 'No reason'}`,
                            link: `/commercial/opportunities/${id}`,
                            icon: "❌",
                            sourceModule: "commercial",
                            sourceId: id,
                        });
                    }
                } catch (e) {
                    console.error("G18: Failed to create OPP notification", e);
                }

                // G4/G7: Log deal outcome on source Lead/Contact timeline (SystemLog)
                try {
                    const fullOppForLog = await (prisma as any).opportunity.findUnique({
                        where: { id },
                        select: { sourceContactId: true, title: true, sourceContact: { select: { type: true } } },
                    });
                    if (fullOppForLog?.sourceContactId) {
                        const isWonLog = rest.stage === 'Closed Won';
                        const oppTitleLog = fullOppForLog.title || `OPP #${id}`;
                        const amountStr = rest.closedAmount ? ` — $${Number(rest.closedAmount).toLocaleString()}` : '';
                        const reasonStr = !isWonLog && rest.lostReason ? ` — ${rest.lostReason}` : '';
                        const entityType = fullOppForLog.sourceContact?.type === 'CLIENT_CONTACT' ? 'contact' : 'lead';
                        await addSystemLog({
                            entityType,
                            entityId: fullOppForLog.sourceContactId,
                            action: isWonLog ? 'deal_won' : 'deal_lost',
                            description: isWonLog
                                ? `🏆 Deal won: "${oppTitleLog}"${amountStr}`
                                : `❌ Deal lost: "${oppTitleLog}"${reasonStr}`,
                            metadata: { opportunityId: id, closedAmount: rest.closedAmount, closedComments: rest.closedComments, lostReason: rest.lostReason },
                            changedBy: userName,
                        });
                    }
                } catch (e) {
                    console.error("G4/G7: Failed to log deal outcome on Lead:", e);
                }
            }
        }

        // G13: Check if Closed Won but source lead has no company name
        let missingCompany = false;
        if (stageChanged && rest.stage === 'Closed Won') {
            try {
                const checkOpp = await (prisma as any).opportunity.findUnique({
                    where: { id },
                    select: { companyId: true, sourceContactId: true, sourceContact: { select: { companyName: true, companyId: true } } },
                });
                if (checkOpp && !checkOpp.companyId && checkOpp.sourceContact) {
                    const cn = (checkOpp.sourceContact.companyName || '').replace(/^View company:\s*/i, '').trim();
                    if (!cn && !checkOpp.sourceContact.companyId) {
                        missingCompany = true;
                    }
                }
            } catch (e) {
                console.error("G13: Check missing company failed:", e);
            }
        }

        revalidatePath('/commercial/opportunities')
        revalidatePath(`/commercial/opportunities/${id}`)
        return {
            success: true,
            data: serializeOpp(opportunity),
            // For UI confirmation: did Closed Lost auto-close any linked Jobs?
            jobClosed: stageChanged && rest.stage === 'Closed Lost' ? (await (prisma as any).job.count({ where: { opportunityId: id } })) || null : null,
            missingCompany,
        }
    } catch (error) {
        console.error("Error updating opportunity:", error)
        return { success: false, error: "Failed to update opportunity" }
    }
}

// DELETE Opportunity (legacy — now soft-delete to protect data)
// Hard deletes lose OpportunityHistory and break Assignments via opportunityId FK.
// Forward to soft-delete with a default reason.
export async function deleteOpportunity(id: number) {
    const { archiveOpportunity } = await import("@/app/actions/commercial/archive");
    return archiveOpportunity(id, 'Deleted via legacy delete flow');
}

// --- File attachment actions ---

export async function updateOppFile(id: number, field: 'sow' | 'nda' | 'other', url: string | null) {
    try {
        const updateData: any = {};
        if (field === 'sow') {
            updateData.sowUrl = url;
            updateData.sowDate = url ? new Date() : null;
        } else if (field === 'nda') {
            updateData.ndaUrl = url;
            updateData.ndaDate = url ? new Date() : null;
        } else if (field === 'other') {
            updateData.otherUrl = url;
            updateData.otherDate = url ? new Date() : null;
        }

        await (prisma as any).opportunity.update({
            where: { id },
            data: updateData,
        });

        // SystemLog: SOW/NDA/Other file change
        try {
            const session = await getServerSession(authOptions);
            const userName = (session?.user as any)?.name || 'System';
            const label = field.toUpperCase();
            await addSystemLog({
                entityType: 'opportunity',
                entityId: id,
                action: url ? 'file_uploaded' : 'file_removed',
                description: url ? `${label} document uploaded` : `${label} document removed`,
                changedBy: userName,
            });
        } catch {}

        // System Automation: document uploaded
        if (url) {
            try {
                const opp = await (prisma as any).opportunity.findUnique({ where: { id }, select: { title: true, company: { select: { name: true } } } });
                const docType = field === 'sow' ? 'SOW' : field === 'nda' ? 'NDA' : 'Other';
                await createSystemNotification('OPP_DOC_UPLOADED', {
                    type: 'OPP_DOC_UPLOADED',
                    message: `📎 ${docType} uploaded for "${opp?.title || ''}" — ${opp?.company?.name || ''}`,
                    link: `/commercial/opportunities/${id}`,
                    icon: '📎',
                    sourceModule: 'commercial',
                    sourceId: id,
                });
            } catch (e) { console.error('Doc upload notification failed:', e); }
        }

        revalidatePath(`/commercial/opportunities/${id}`);
        return { success: true };
    } catch (error) {
        console.error("Error updating opp file:", error);
        return { success: false, error: "Failed to update file" };
    }
}

export async function addOtherFile(id: number, url: string, name: string) {
    try {
        const opp = await (prisma as any).opportunity.findUnique({
            where: { id },
            select: { otherFiles: true },
        });

        const files: { url: string; name: string; date: string }[] = opp?.otherFiles
            ? JSON.parse(opp.otherFiles)
            : [];

        if (files.length >= 5) {
            return { success: false, error: "Maximum 5 files allowed" };
        }

        files.push({ url, name, date: new Date().toISOString() });

        await (prisma as any).opportunity.update({
            where: { id },
            data: { otherFiles: JSON.stringify(files) },
        });

        // SystemLog: file added
        try {
            const session = await getServerSession(authOptions);
            const userName = (session?.user as any)?.name || 'System';
            await addSystemLog({
                entityType: 'opportunity',
                entityId: id,
                action: 'file_uploaded',
                description: `File added: ${name}`,
                changedBy: userName,
            });
        } catch {}

        revalidatePath(`/commercial/opportunities/${id}`);
        return { success: true, data: files };
    } catch (error) {
        console.error("Error adding other file:", error);
        return { success: false, error: "Failed to add file" };
    }
}

export async function removeOtherFile(id: number, index: number) {
    try {
        const opp = await (prisma as any).opportunity.findUnique({
            where: { id },
            select: { otherFiles: true },
        });

        const files: any[] = opp?.otherFiles ? JSON.parse(opp.otherFiles) : [];
        const removedFile = files[index];
        files.splice(index, 1);

        await (prisma as any).opportunity.update({
            where: { id },
            data: { otherFiles: files.length > 0 ? JSON.stringify(files) : null },
        });

        // SystemLog: file removed
        try {
            const session = await getServerSession(authOptions);
            const userName = (session?.user as any)?.name || 'System';
            await addSystemLog({
                entityType: 'opportunity',
                entityId: id,
                action: 'file_removed',
                description: `File removed: ${removedFile?.name || 'unknown'}`,
                changedBy: userName,
            });
        } catch {}

        revalidatePath(`/commercial/opportunities/${id}`);
        return { success: true, data: files };
    } catch (error) {
        console.error("Error removing other file:", error);
        return { success: false, error: "Failed to remove file" };
    }
}

// --- Search helpers for autocomplete lookups ---

export async function searchJobs(query: string) {
    try {
        const where = query.trim() ? {
            OR: [
                { title: { contains: query } },
                { client: { contains: query } },
            ],
        } : {};
        const jobs = await (prisma as any).job.findMany({
            where,
            select: { id: true, title: true, client: true, status: true },
            take: 20,
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]
        })
        return { success: true, data: jobs }
    } catch (error) {
        console.error("Error searching jobs:", error)
        return { success: false, data: [] }
    }
}

export async function searchContactsAndLeads(query: string, type?: string) {
    try {
        const whereClause: any = {
            OR: [
                { firstName: { contains: query } },
                { lastName: { contains: query } },
                { fullName: { contains: query } },
                { companyName: { contains: query } },
            ],
        };

        if (type) {
            whereClause.type = type;
        }

        const contacts = await (prisma as any).contact.findMany({
            where: whereClause,
            select: { id: true, firstName: true, lastName: true, fullName: true, companyName: true, type: true },
            take: 10,
            orderBy: { createdAt: 'desc' }
        })
        return { success: true, data: contacts }
    } catch (error) {
        console.error("Error searching contacts:", error)
        return { success: false, data: [] }
    }
}

export async function searchCandidates(query: string) {
    try {
        const candidates = await (prisma as any).candidate.findMany({
            where: {
                fullName: { contains: query },
            },
            select: { id: true, fullName: true, email: true, seniority: true, isEmployee: true },
            take: 10,
            orderBy: { createdAt: 'desc' }
        })
        return { success: true, data: candidates }
    } catch (error) {
        console.error("Error searching candidates:", error)
        return { success: false, data: [] }
    }
}

export async function getUsers() {
    try {
        const users = await (prisma as any).user.findMany({
            where: { isActive: true },
            select: { id: true, name: true, email: true },
            orderBy: { name: 'asc' }
        });
        return { success: true, data: users };
    } catch (error) {
        return { success: false, data: [] };
    }
}

export async function syncOppRatesToJob(oppId: number) {
    try {
        const opp = await (prisma as any).opportunity.findUnique({
            where: { id: oppId },
            select: { proposedRate: true, clientDesiredRate: true, jobs: { select: { id: true } } },
        });
        if (!opp || !opp.jobs?.length) return { success: false, error: "No linked Jobs" };

        // 1:N — propagate rates to every linked Job.
        for (const j of opp.jobs) {
            await prisma.job.update({
                where: { id: j.id },
                data: {
                    minRate: opp.clientDesiredRate || null,
                    maxRate: opp.proposedRate || null,
                },
            });
            revalidatePath(`/jobs/${j.id}`);
        }

        revalidatePath('/pipeline');
        revalidatePath(`/commercial/opportunities/${oppId}`);
        return { success: true };
    } catch (error) {
        console.error("Error syncing rates:", error);
        return { success: false, error: "Failed to sync rates" };
    }
}

// A: Opp ↔ Job 1:N — dedicated link/unlink server actions.
// A Job has at most one Opp (FK lives on Job side). An Opp can have many Jobs.

export async function linkJobToOpportunity(opportunityId: number, jobId: number) {
    try {
        const session = await getServerSession(authOptions);
        const userName = (session?.user as any)?.name || 'System';

        const job = await (prisma as any).job.findUnique({
            where: { id: jobId },
            select: { id: true, title: true, opportunityId: true },
        });
        if (!job) return { success: false, error: "Job not found" };
        if (job.opportunityId && job.opportunityId !== opportunityId) {
            return { success: false, error: `Job is already linked to opportunity #${job.opportunityId}. Unlink it first.` };
        }
        if (job.opportunityId === opportunityId) {
            return { success: true, data: { id: job.id }, alreadyLinked: true };
        }

        await (prisma as any).job.update({
            where: { id: jobId },
            data: { opportunityId },
        });

        try {
            await addSystemLog({
                entityType: 'opportunity',
                entityId: opportunityId,
                action: 'linked_job',
                description: `Linked Job: ${job.title}`,
                changedBy: userName,
                metadata: { jobId },
            });
            await addSystemLog({
                entityType: 'job',
                entityId: jobId,
                action: 'linked_opportunity',
                description: `Linked to Opportunity #${opportunityId}`,
                changedBy: userName,
                metadata: { opportunityId },
            });
        } catch (e) {
            console.error("SystemLog on link failed (non-fatal):", e);
        }

        // Touch parent Opportunity updatedAt
        await (prisma as any).opportunity.update({ where: { id: opportunityId }, data: { updatedAt: new Date() } });

        revalidatePath(`/commercial/opportunities/${opportunityId}`);
        revalidatePath(`/jobs/${jobId}`);
        return { success: true };
    } catch (e: any) {
        console.error("linkJobToOpportunity error:", e);
        return { success: false, error: e?.message || "Failed to link job" };
    }
}

export async function unlinkJobFromOpportunity(jobId: number) {
    try {
        const session = await getServerSession(authOptions);
        const userName = (session?.user as any)?.name || 'System';

        const job = await (prisma as any).job.findUnique({
            where: { id: jobId },
            select: { id: true, title: true, opportunityId: true },
        });
        if (!job) return { success: false, error: "Job not found" };
        if (!job.opportunityId) return { success: true, alreadyUnlinked: true };

        const previousOppId = job.opportunityId;
        await (prisma as any).job.update({
            where: { id: jobId },
            data: { opportunityId: null },
        });

        try {
            await addSystemLog({
                entityType: 'opportunity',
                entityId: previousOppId,
                action: 'unlinked_job',
                description: `Unlinked Job: ${job.title}`,
                changedBy: userName,
                metadata: { jobId },
            });
            await addSystemLog({
                entityType: 'job',
                entityId: jobId,
                action: 'unlinked_opportunity',
                description: `Unlinked from Opportunity #${previousOppId}`,
                changedBy: userName,
                metadata: { opportunityId: previousOppId },
            });
        } catch (e) {
            console.error("SystemLog on unlink failed (non-fatal):", e);
        }

        // Touch parent Opportunity updatedAt
        await (prisma as any).opportunity.update({ where: { id: previousOppId }, data: { updatedAt: new Date() } });

        revalidatePath(`/commercial/opportunities/${previousOppId}`);
        revalidatePath(`/jobs/${jobId}`);
        return { success: true };
    } catch (e: any) {
        console.error("unlinkJobFromOpportunity error:", e);
        return { success: false, error: e?.message || "Failed to unlink job" };
    }
}

export async function addOppComment(formData: FormData) {
    const opportunityId = Number(formData.get("opportunityId"));
    const content = formData.get("content") as string;

    if (!content) {
        throw new Error("Content is required");
    }

    const session = await getServerSession(authOptions);
    const author = (session?.user as any)?.name || (session?.user as any)?.email || "System";

    await (prisma as any).opportunityComment.create({
        data: {
            opportunityId,
            content,
            author,
        },
    });

    revalidatePath(`/commercial/opportunities/${opportunityId}`);
}

export async function updateOppComment(formData: FormData) {
    const id = Number(formData.get("id"));
    const opportunityId = Number(formData.get("opportunityId"));
    const content = formData.get("content") as string;

    if (!content) {
        throw new Error("Content is required");
    }

    const session = await getServerSession(authOptions);
    const author = (session?.user as any)?.name || (session?.user as any)?.email || "System";

    await (prisma as any).opportunityComment.update({
        where: { id },
        data: { content, author },
    });

    revalidatePath(`/commercial/opportunities/${opportunityId}`);
}

export async function deleteOppComment(id: number, opportunityId: number) {
    await (prisma as any).opportunityComment.delete({
        where: { id },
    });

    revalidatePath(`/commercial/opportunities/${opportunityId}`);
}

// --- Email helper: OPP moved to Searching ---
async function sendSearchingEmail(opp: any, accountName: string, jobLink: string, jobNote: string) {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
        host: process.env.SYSTEM_SMTP_HOST,
        port: Number(process.env.SYSTEM_SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SYSTEM_SMTP_USER, pass: process.env.SYSTEM_SMTP_PASS },
    });

    const crmBase = process.env.NEXTAUTH_URL || 'https://crm.mycompany.co';
    const oppLink = `${crmBase}/commercial/opportunities/${opp.id}`;
    const fullJobLink = `${crmBase}${jobLink}`;

    const fmt = (d: any) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--';
    const money = (v: any) => v ? `$${Number(v).toLocaleString()}` : '--';

    const title = opp?.title || 'Untitled Opportunity';
    const ownerName = opp?.owner?.name || '--';

    // KPIs
    const amt = opp?.amount ? Number(opp.amount) : 0;
    const prob = opp?.probability ? Number(opp.probability) : 0;
    const expRev = amt && prob ? amt * prob / 100 : 0;
    const pos = opp?.numberOfPositions || 0;
    const rate = opp?.proposedRate ? Number(opp.proposedRate) : 0;
    const wl = opp?.workload || 160;
    const estimate = opp?.estimate ? Number(opp.estimate) : (pos && rate ? pos * rate * wl : 0);

    const oppDetails = opp?.oppDetails || '';
    const desc = opp?.description || '';

    const html = `
    <div style="font-family:'Inter',Arial,sans-serif;max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="background:linear-gradient(135deg,#3b82f6,#6366f1);padding:28px 32px;">
            <h1 style="color:#fff;margin:0;font-size:20px;">&#127881; Opportunity Moved to Searching</h1>
            <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px;">${title}${accountName ? ' - ' + accountName : ''}</p>
        </div>
        <div style="padding:24px 32px;">
            <p style="color:#6b7280;font-size:13px;margin:0 0 16px;">&#128203; ${jobNote}</p>

            <!-- KPIs -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                    <td style="padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:0;">Amount</p>
                        <p style="color:#111827;font-size:20px;font-weight:700;margin:4px 0 0;">${money(amt || null)}</p>
                    </td>
                    <td width="8"></td>
                    <td style="padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:0;">Expected Revenue</p>
                        <p style="color:#111827;font-size:20px;font-weight:700;margin:4px 0 0;">${money(expRev || null)}</p>
                        <p style="color:#9ca3af;font-size:10px;margin:2px 0 0;">Amount x ${prob}%</p>
                    </td>
                    <td width="8"></td>
                    <td style="padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:0;">Probability</p>
                        <p style="color:#111827;font-size:20px;font-weight:700;margin:4px 0 0;">${prob}%</p>
                    </td>
                    <td width="8"></td>
                    <td style="padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:0;">Oppty Estimate</p>
                        <p style="color:#111827;font-size:20px;font-weight:700;margin:4px 0 0;">${money(estimate || null)}</p>
                        <p style="color:#9ca3af;font-size:10px;margin:2px 0 0;">${opp?.estimate ? '' : 'Pos x Rate x Hours'}</p>
                    </td>
                </tr>
            </table>

            <!-- IDENTIFICATION -->
            <p style="color:#3b82f6;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:0 0 0;padding-bottom:8px;border-bottom:2px solid #3b82f6;">Identification</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;font-size:13px;">
                <tr>
                    <td width="33%" style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Name</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${title}</p>
                    </td>
                    <td width="33%" style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Type</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.type || '--'}</p>
                    </td>
                    <td width="33%" style="padding:10px 0 10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Lead Source</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.leadSource || '--'}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Close Date</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${fmt(opp?.closeDate)}</p>
                    </td>
                    <td style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Due Date</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${fmt(opp?.dueDate)}</p>
                    </td>
                    <td style="padding:10px 0 10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Business Owner</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${ownerName}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Next Step</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.nextStep || '--'}</p>
                    </td>
                    <td style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Campaign</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.campaign || '--'}</p>
                    </td>
                    <td></td>
                </tr>
            </table>

            ${oppDetails ? `<!-- OPP DETAILS -->
            <div style="margin-bottom:20px;padding:12px 16px;background:#f9fafb;border-radius:8px;border-left:3px solid #6366f1;">
                <p style="color:#6b7280;font-size:10px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Opp Details</p>
                <p style="color:#374151;font-size:13px;margin:0;line-height:1.6;">${oppDetails}</p>
            </div>` : ''}

            ${desc ? `<!-- DESCRIPTION -->
            <div style="margin-bottom:20px;padding:12px 16px;background:#f9fafb;border-radius:8px;border-left:3px solid #10b981;">
                <p style="color:#6b7280;font-size:10px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Description</p>
                <p style="color:#374151;font-size:13px;margin:0;line-height:1.6;">${desc}</p>
            </div>` : ''}

            <!-- STAFFING DETAILS -->
            <p style="color:#3b82f6;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:0 0 0;padding-bottom:8px;border-bottom:2px solid #3b82f6;">Staffing Details</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;font-size:13px;">
                <tr>
                    <td width="33%" style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;"># of Positions</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${pos || '--'}</p>
                    </td>
                    <td width="33%" style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Rate Type</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.rateType || '--'}</p>
                    </td>
                    <td width="33%" style="padding:10px 0 10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Client Desired Rate ($)</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${money(opp?.clientDesiredRate)}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Proposed Rate ($)</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${money(opp?.proposedRate)}</p>
                    </td>
                    <td style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Workload (hours/month)</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.workload || '--'}</p>
                    </td>
                    <td style="padding:10px 0 10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Expected Engagement (months)</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.engagementTerm || '--'}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">English Level</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.englishLevel || '--'}</p>
                    </td>
                    <td style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">End Client</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.endClient || '--'}</p>
                    </td>
                    <td style="padding:10px 0 10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Project</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.project || '--'}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding:10px 8px 10px 0;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Type</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.workType || '--'}</p>
                    </td>
                    <td style="padding:10px 8px;vertical-align:top;">
                        <p style="color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin:0;">Location</p>
                        <p style="color:#111827;font-weight:500;margin:2px 0 0;">${opp?.location || '--'}</p>
                    </td>
                    <td></td>
                </tr>
            </table>

            ${(opp?.technologies) ? `<!-- TECHNOLOGIES -->
            <div style="margin-bottom:20px;">
                <p style="color:#3b82f6;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:0 0 0;padding-bottom:8px;border-bottom:2px solid #3b82f6;">Technologies / Skills</p>
                <p style="color:#111827;font-size:13px;margin:8px 0 0;font-weight:500;">${opp.technologies}</p>
            </div>` : ''}

            <!-- BUTTONS -->
            <table cellpadding="0" cellspacing="0" style="margin-top:24px;">
                <tr>
                    <td><a href="${oppLink}" style="display:inline-block;padding:10px 20px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">View Opportunity &#8594;</a></td>
                    <td width="16"></td>
                    <td><a href="${fullJobLink}" style="display:inline-block;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">View Job Order &#8594;</a></td>
                </tr>
            </table>

            <p style="color:#9ca3af;font-size:11px;margin:24px 0 0;">This is an automated email from MyCompany CRM</p>
        </div>
    </div>`;

    await transporter.sendMail({
        from: `"MyCompany CRM" <${process.env.SYSTEM_SMTP_FROM}>`,
        to: 'alex.morgan@example.com',
        cc: [
            'jordan.lee@example.com',
            'sam.rivera@example.com',
            'chris.diaz@example.com',
            'taylor.kim@example.com',
        ].join(', '),
        subject: `OPP > Searching: ${title}${accountName ? ' (' + accountName + ')' : ''}`,
        html,
    });
}

export async function cloneOpportunities(ids: number[]) {
    try {
        const session = await getServerSession(authOptions);
        const userName = (session?.user as any)?.name || "System";

        const results = [];
        for (const id of ids) {
            const original = await (prisma as any).opportunity.findUnique({
                where: { id }
            });

            if (!original) continue;

            const { id: _, createdAt: __, updatedAt: ___, ...dataToClone } = original;

            const clonedData = {
                ...dataToClone,
                title: `${original.title || ''} (CLONED)`.trim(),
                stage: 'New Opp',
                lostReason: null,
                closedComments: null,
                closedAmount: null,
                wonCandidateId: null,
                isArchived: false,
                archiveReason: null,
                archivedAt: null,
                archivedBy: null,
            };

            const cloned = await (prisma as any).opportunity.create({
                data: clonedData
            });

            // Seed per-Opp stage library so the cloned Opp has its own customizable set
            try {
                const { OPP_STAGE_LIBRARY, OPP_DEFAULT_ACTIVE_KEYS, OPP_SYSTEM_STAGE_KEYS } = await import("@/app/lib/opportunityStages");
                await (prisma as any).opportunityStage.createMany({
                    data: OPP_STAGE_LIBRARY.map((s, idx) => ({
                        opportunityId: cloned.id,
                        stageKey: s.key,
                        label: s.label,
                        order: idx,
                        isActive: OPP_DEFAULT_ACTIVE_KEYS.includes(s.key),
                        isSystem: OPP_SYSTEM_STAGE_KEYS.includes(s.key),
                    })),
                });
            } catch (e) {
                console.error("Failed to seed OpportunityStages on clone (non-fatal):", e);
            }

            // Log creation in OpportunityHistory
            try {
                await (prisma as any).opportunityHistory.create({
                    data: {
                        opportunityId: cloned.id,
                        oldStage: "(New)",
                        newStage: cloned.stage,
                        amount: cloned.amount,
                        changedBy: userName,
                    },
                });
            } catch (e) {
                console.error("Failed to log cloned Opp in history (non-fatal):", e);
            }

            try {
                await addSystemLog({
                    entityType: 'opportunity',
                    entityId: cloned.id,
                    action: 'created',
                    description: `Opportunity cloned from Opportunity ID ${id}`,
                    changedBy: userName,
                });
            } catch {}

            results.push(cloned);
        }

        revalidatePath('/commercial/opportunities');
        return { success: true, count: results.length };
    } catch (error: any) {
        console.error("Error cloning opportunities:", error);
        return { success: false, error: error.message || "Failed to clone opportunities" };
    }
}
