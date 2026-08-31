// Stage library — all built-in pipeline stages available to any job
export const STAGE_LIBRARY = [
    { key: "SOURCING", label: "Sourcing" },
    { key: "HR_INTERVIEW", label: "HR Interview" },
    { key: "TECH_INTERVIEW", label: "Technical Interview" },
    { key: "CHALLENGE", label: "Challenge" },
    { key: "CULTURE_FIT", label: "Culture Fit Interview" },
    { key: "PRESENTED_TO_CLIENT", label: "Presented to Client" },
    { key: "CLIENT_FEEDBACK", label: "Client Feedback" },
    { key: "OFFER", label: "Offer" },
    { key: "HIRED", label: "Hired" },
];

// Default active stages (subset of library)
export const DEFAULT_ACTIVE_KEYS = ["SOURCING", "HR_INTERVIEW", "TECH_INTERVIEW", "PRESENTED_TO_CLIENT", "CLIENT_FEEDBACK", "OFFER", "HIRED"];
