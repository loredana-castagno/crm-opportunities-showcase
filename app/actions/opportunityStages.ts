"use server";

import { db } from "@/app/lib/db";
import { revalidatePath } from "next/cache";
import {
    OPP_STAGE_LIBRARY,
    OPP_DEFAULT_ACTIVE_KEYS,
    OPP_SYSTEM_STAGE_KEYS,
} from "@/app/lib/opportunityStages";

export type OpportunityStageConfig = {
    id?: number;
    stageKey: string;
    label: string;
    order: number;
    isActive: boolean;
    isSystem: boolean;
};

/**
 * Returns the opportunity's stage configuration.
 * If none exist yet, initializes them with library defaults and returns.
 */
export async function getOrInitOpportunityStages(opportunityId: number): Promise<OpportunityStageConfig[]> {
    const existing = await (db as any).opportunityStage.findMany({
        where: { opportunityId },
        orderBy: { order: "asc" },
    });

    if (existing.length > 0) {
        return existing as OpportunityStageConfig[];
    }

    const data = OPP_STAGE_LIBRARY.map((s, idx) => ({
        opportunityId,
        stageKey: s.key,
        label: s.label,
        order: idx,
        isActive: OPP_DEFAULT_ACTIVE_KEYS.includes(s.key),
        isSystem: OPP_SYSTEM_STAGE_KEYS.includes(s.key),
    }));

    await (db as any).opportunityStage.createMany({ data });

    const created = await (db as any).opportunityStage.findMany({
        where: { opportunityId },
        orderBy: { order: "asc" },
    });
    return created as OpportunityStageConfig[];
}

/**
 * Saves the complete per-Opp stage config.
 * - Validates: system stages must remain present with their original label.
 * - If a stage label changes, propagates the rename to `opportunity.stage`
 *   when that opp's current stage matches the old label.
 */
export async function saveOpportunityStages(
    opportunityId: number,
    stages: OpportunityStageConfig[]
): Promise<{ success: boolean; error?: string }> {
    try {
        // Validate system stages
        const incomingSystemKeys = stages.filter(s => OPP_SYSTEM_STAGE_KEYS.includes(s.stageKey)).map(s => s.stageKey);
        for (const reqKey of OPP_SYSTEM_STAGE_KEYS) {
            if (!incomingSystemKeys.includes(reqKey)) {
                return { success: false, error: `System stage ${reqKey} cannot be removed.` };
            }
        }

        // Lock system labels to their library values
        const libByKey: Record<string, string> = {};
        OPP_STAGE_LIBRARY.forEach(s => { libByKey[s.key] = s.label; });
        const normalized = stages.map((s, idx) => ({
            ...s,
            order: idx,
            label: OPP_SYSTEM_STAGE_KEYS.includes(s.stageKey) ? libByKey[s.stageKey] : s.label,
            isActive: OPP_SYSTEM_STAGE_KEYS.includes(s.stageKey) ? true : s.isActive,
            isSystem: OPP_SYSTEM_STAGE_KEYS.includes(s.stageKey),
        }));

        // Diff old → new to detect label renames
        const old = await (db as any).opportunityStage.findMany({
            where: { opportunityId },
        });
        const oldByKey: Record<string, string> = {};
        old.forEach((s: any) => { oldByKey[s.stageKey] = s.label; });

        const renames: { from: string; to: string }[] = [];
        normalized.forEach(s => {
            const prev = oldByKey[s.stageKey];
            if (prev && prev !== s.label) renames.push({ from: prev, to: s.label });
        });

        // Replace stages
        await (db as any).opportunityStage.deleteMany({ where: { opportunityId } });
        await (db as any).opportunityStage.createMany({
            data: normalized.map(s => ({
                opportunityId,
                stageKey: s.stageKey,
                label: s.label,
                order: s.order,
                isActive: s.isActive,
                isSystem: s.isSystem,
            })),
        });

        // Propagate label renames: if opportunity.stage matches an old label, update it.
        if (renames.length > 0) {
            const opp = await (db as any).opportunity.findUnique({
                where: { id: opportunityId },
                select: { stage: true },
            });
            const hit = renames.find(r => r.from === opp?.stage);
            if (hit) {
                await (db as any).opportunity.update({
                    where: { id: opportunityId },
                    data: { stage: hit.to },
                });
            }
        }

        revalidatePath(`/commercial/opportunities/${opportunityId}`);
        revalidatePath("/commercial/opportunities");
        return { success: true };
    } catch (e: any) {
        console.error("saveOpportunityStages error:", e);
        return { success: false, error: e?.message || "Failed to save stages" };
    }
}

/**
 * Returns only the ACTIVE stages for an opportunity, sorted.
 */
export async function getActiveOpportunityStages(opportunityId: number): Promise<{ stageKey: string; label: string }[]> {
    const stages = await getOrInitOpportunityStages(opportunityId);
    return stages
        .filter(s => s.isActive)
        .sort((a, b) => a.order - b.order)
        .map(s => ({ stageKey: s.stageKey, label: s.label }));
}
