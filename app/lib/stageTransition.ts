/**
 * Helper to compute the post-save info-modal contents for an Opportunity
 * stage change.
 *
 * Mirror of the actual server-side side effects in `updateOpportunity`:
 *   - Closed Won (forward):  Account → CUSTOMER, Lead → CLIENT_CONTACT,
 *                            Activity logged, Notification fired
 *   - Closed Lost (forward): Job auto-closed, Applications auto-archived,
 *                            Activity logged, Notification fired
 *   - Reverting from Closed: ONLY OpportunityHistory entry. No side effects
 *                            are reverted — that's what this modal surfaces.
 */

import type { StageChangeNote } from "@/app/components/modals/StageChangeInfoModal";

const CLOSED = ['Closed Won', 'Closed Lost'];

export function isClosedStage(stage: string) {
    return CLOSED.includes(stage);
}

export interface OppContext {
    id: number;
    accountId?: number | null;
    accountName?: string | null;
    accountType?: string | null;     // PROSPECT / CUSTOMER / FORMER_CUSTOMER / BLACKLISTED
    sourceContactId?: number | null;
    sourceContactName?: string | null;
    sourceContactType?: string | null; // LEAD / CLIENT_CONTACT
    // Per A: 1:N Opps↔Jobs — list of linked jobs (was single linkedJobId/Status).
    linkedJobs?: { id: number; status: string | null }[];
    archivedAppCount?: number;          // applications archived previously due to Closed Lost
}

export interface StageChangeInfo {
    autoChanges: StageChangeNote[];
    manualNotes: StageChangeNote[];
}

export function computeStageChangeInfo(
    oldStage: string,
    newStage: string,
    ctx: OppContext
): StageChangeInfo {
    const auto: StageChangeNote[] = [];
    const manual: StageChangeNote[] = [];

    const wasClosed = isClosedStage(oldStage);
    const isClosed = isClosedStage(newStage);

    // Always: history entry
    auto.push({
        label: 'Stage transition recorded in History',
        detail: `${oldStage} → ${newStage}`,
    });

    // ── FORWARD: Any → Searching ─────────────────────────────────────────
    if (newStage === 'Searching') {
        auto.push({ label: 'Job Order auto-created or linked to existing Job' });
        auto.push({
            label: 'Email sent to the team with OPP details',
            detail: 'To: Emily | CC: Loredana, Pablo, Leandro, Vanesa',
        });
        auto.push({ label: 'Cross-module notification sent (HR + Commercial)' });
    }

    // ── FORWARD: Open → Closed Won ────────────────────────────────────────
    if (!wasClosed && newStage === 'Closed Won') {
        auto.push({ label: 'Activity logged on the source Lead/Contact timeline' });
        auto.push({ label: 'Cross-module notification sent (HR + Commercial)' });

        if (ctx.accountId && ctx.accountType !== 'CUSTOMER') {
            auto.push({
                label: `Account "${ctx.accountName}" promoted to CUSTOMER`,
                detail: ctx.accountType ? `was ${ctx.accountType}` : undefined,
            });
        }
        if (ctx.sourceContactId && ctx.sourceContactType === 'LEAD') {
            auto.push({
                label: `Source contact "${ctx.sourceContactName}" converted to CLIENT_CONTACT`,
                detail: 'Co-leads with the same company were also converted',
            });
        }
        if (!ctx.accountId && ctx.sourceContactId) {
            manual.push({
                label: 'No Account is linked',
                detail: 'You may want to create or link an Account so the deal sits under a CUSTOMER record.',
                link: { href: `/commercial/leads/${ctx.sourceContactId}`, label: 'Open source Lead' },
            });
        }
    }

    // ── FORWARD: Open → Closed Lost ───────────────────────────────────────
    if (!wasClosed && newStage === 'Closed Lost') {
        auto.push({ label: 'Activity logged on the source Lead/Contact timeline' });
        auto.push({ label: 'Cross-module notification sent (HR + Commercial)' });

        const openLinkedJobs = (ctx.linkedJobs || []).filter(j => j.status === 'OPEN');
        if (openLinkedJobs.length > 0) {
            auto.push({
                label: openLinkedJobs.length === 1 ? 'Linked Job auto-closed' : `${openLinkedJobs.length} Linked Jobs auto-closed`,
                detail: 'All active Applications on them were archived with reason "Opportunity lost"',
            });
        }
    }

    // ── REVERT: Closed → Open ─────────────────────────────────────────────
    if (wasClosed && !isClosed) {
        // Side effects from the original close are NOT auto-reverted.
        // List them so the user can restore manually if it makes sense.

        if (oldStage === 'Closed Won') {
            if (ctx.accountId && ctx.accountType === 'CUSTOMER') {
                manual.push({
                    label: `Account "${ctx.accountName}" stays CUSTOMER`,
                    detail: 'It was promoted when the deal was won. If this revert means it was never a real customer, change the type back manually from the Account profile.',
                    link: ctx.accountId ? { href: `/commercial/accounts/${ctx.accountId}`, label: 'Open Account' } : undefined,
                });
            }
            if (ctx.sourceContactId && ctx.sourceContactType === 'CLIENT_CONTACT') {
                manual.push({
                    label: `Source contact "${ctx.sourceContactName}" stays CLIENT_CONTACT`,
                    detail: 'Convert it back to LEAD manually if the relationship was never formalised.',
                    link: { href: `/commercial/leads/${ctx.sourceContactId}`, label: 'Open contact' },
                });
            }
        }

        if (oldStage === 'Closed Lost') {
            const closedLinkedJobs = (ctx.linkedJobs || []).filter(j => j.status === 'CLOSED');
            if (closedLinkedJobs.length > 0) {
                manual.push({
                    label: closedLinkedJobs.length === 1 ? 'Linked Job stays CLOSED' : `${closedLinkedJobs.length} Linked Jobs stay CLOSED`,
                    detail: 'Reopen each manually from its Job page if you want to resume hiring.',
                    link: closedLinkedJobs.length === 1 ? { href: `/jobs/${closedLinkedJobs[0].id}`, label: 'Open Job' } : undefined,
                });
            }
            if (ctx.archivedAppCount && ctx.archivedAppCount > 0) {
                manual.push({
                    label: `${ctx.archivedAppCount} archived Application${ctx.archivedAppCount > 1 ? 's' : ''} stay archived`,
                    detail: 'Restore each manually from the Pipeline if you want them back in flight.',
                });
            }
        }

        // Always remind: this revert does not unwind notifications/activities (append-only log)
        manual.push({
            label: 'Activities and notifications from the original close stay in the timeline',
            detail: 'These records show what happened at that moment (the deal was marked won/lost). They are not deleted on revert so the history of decisions stays intact — like an audit log.',
        });
    }

    // ── LATERAL: Closed Won ↔ Closed Lost ─────────────────────────────────
    if (wasClosed && isClosed && oldStage !== newStage) {
        manual.push({
            label: 'Lateral close-state change',
            detail: 'Switching between Closed Won and Closed Lost does not auto-trigger forward side effects again. Review Account type, linked Job status, and Applications manually.',
        });
    }

    return { autoChanges: auto, manualNotes: manual };
}
