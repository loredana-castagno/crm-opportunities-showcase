/**
 * Opportunity Stage library — built-in stages available for any Opportunity.
 *
 * Each Opportunity gets its own set of stages (per-Opp customization, like JobStage).
 * On Opp creation we seed all library stages with the active flag matching DEFAULT_ACTIVE_KEYS.
 * Users can then toggle, reorder, rename (except SYSTEM keys), or add custom stages.
 *
 * SYSTEM stages (CLOSED_WON, CLOSED_LOST) are protected — their key, label and presence
 * are locked because backend logic (Account → CUSTOMER promotion, Job auto-close, etc.)
 * depends on those exact labels matching `opportunity.stage`.
 */

export const OPP_STAGE_LIBRARY = [
    { key: "NEW_OPP",                    label: "New Opp" },
    { key: "SEARCHING",                 label: "Searching" },
    { key: "PRESENTED",                 label: "Presented" },
    { key: "CLIENT_INTERVIEW_SCHEDULED", label: "Client Interview Scheduled" },
    { key: "AWAITING_FEEDBACK",         label: "Awaiting Feedback" },
    { key: "AWAITING_SOW",              label: "Awaiting SOW" },
    { key: "PREPARING_PROPOSAL",        label: "Preparing Proposal" },
    { key: "PROPOSAL_PRESENTED",        label: "Proposal Presented" },
    { key: "CLOSED_WON",                label: "Closed Won" },
    { key: "CLOSED_LOST",               label: "Closed Lost" },
];

// Active by default on Opp creation. The two "proposal" stages are seeded inactive.
export const OPP_DEFAULT_ACTIVE_KEYS = [
    "NEW_OPP",
    "SEARCHING",
    "PRESENTED",
    "CLIENT_INTERVIEW_SCHEDULED",
    "AWAITING_FEEDBACK",
    "AWAITING_SOW",
    "CLOSED_WON",
    "CLOSED_LOST",
];

// Protected stages — cannot be deleted, label cannot be edited.
export const OPP_SYSTEM_STAGE_KEYS = ["CLOSED_WON", "CLOSED_LOST"];

// First stage assigned to a new Opportunity (its `stage` column).
export const OPP_INITIAL_STAGE_LABEL = "New Opp";

export function isSystemStageKey(key: string): boolean {
    return OPP_SYSTEM_STAGE_KEYS.includes(key);
}
