'use client';

import { useState, useEffect } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { GripVertical, Check, Trash2, Plus, X, Lock } from 'lucide-react';
import { saveOpportunityStages, type OpportunityStageConfig } from '@/app/actions/opportunityStages';
import { OPP_STAGE_LIBRARY, OPP_SYSTEM_STAGE_KEYS } from '@/app/lib/opportunityStages';

type Props = {
    open: boolean;
    onClose: () => void;
    opportunityId: number;
    initialStages: OpportunityStageConfig[];
    onSaved?: (stages: OpportunityStageConfig[]) => void;
};

export default function OpportunityStagesModal({ open, onClose, opportunityId, initialStages, onSaved }: Props) {
    const [stages, setStages] = useState<OpportunityStageConfig[]>(initialStages);
    const [showAddCustom, setShowAddCustom] = useState(false);
    const [newCustomLabel, setNewCustomLabel] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Snapshot the initial stages ONLY when the modal opens.
    // The parent re-renders create a new initialStages array reference each time,
    // so we must not include it in deps — otherwise local edits get reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (open) {
            setStages(initialStages);
            setShowAddCustom(false);
            setNewCustomLabel('');
            setError(null);
        }
    }, [open]);

    if (!open) return null;

    const onDragEnd = (result: DropResult) => {
        if (!result.destination) return;
        const items = Array.from(stages);
        const [moved] = items.splice(result.source.index, 1);
        items.splice(result.destination.index, 0, moved);
        setStages(items.map((s, i) => ({ ...s, order: i })));
    };

    const toggleStage = (key: string) => {
        const s = stages.find(x => x.stageKey === key);
        if (s && OPP_SYSTEM_STAGE_KEYS.includes(key)) return; // can't deactivate system
        setStages(stages.map(x => x.stageKey === key ? { ...x, isActive: !x.isActive } : x));
    };

    const updateLabel = (key: string, label: string) => {
        if (OPP_SYSTEM_STAGE_KEYS.includes(key)) return; // system labels locked
        setStages(stages.map(x => x.stageKey === key ? { ...x, label } : x));
    };

    const removeStage = (key: string) => {
        if (OPP_SYSTEM_STAGE_KEYS.includes(key)) return; // can't remove system
        setStages(stages.filter(x => x.stageKey !== key));
    };

    const addLibraryStage = (key: string, label: string) => {
        if (stages.find(s => s.stageKey === key)) return;
        // Insert before the first system stage so Closed Won/Lost stay at the end
        const firstSysIdx = stages.findIndex(s => s.isSystem);
        const insertAt = firstSysIdx === -1 ? stages.length : firstSysIdx;
        const next = [...stages];
        next.splice(insertAt, 0, {
            stageKey: key, label, order: insertAt, isActive: true, isSystem: false,
        });
        setStages(next.map((s, i) => ({ ...s, order: i })));
    };

    const addCustomStage = () => {
        const trimmed = newCustomLabel.trim();
        if (!trimmed) return;
        const key = `CUSTOM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const firstSysIdx = stages.findIndex(s => s.isSystem);
        const insertAt = firstSysIdx === -1 ? stages.length : firstSysIdx;
        const next = [...stages];
        next.splice(insertAt, 0, {
            stageKey: key, label: trimmed, order: insertAt, isActive: true, isSystem: false,
        });
        setStages(next.map((s, i) => ({ ...s, order: i })));
        setNewCustomLabel('');
        setShowAddCustom(false);
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        const res = await saveOpportunityStages(opportunityId, stages);
        setSaving(false);
        if (res.success) {
            onSaved?.(stages);
            onClose();
        } else {
            setError(res.error || 'Failed to save stages');
        }
    };

    const libraryAvailable = OPP_STAGE_LIBRARY.filter(ls => !stages.find(s => s.stageKey === ls.key));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-bold text-gray-900" style={{ fontFamily: 'var(--font-montserrat)' }}>Manage Stages</h2>
                        <p className="text-xs text-gray-400 mt-0.5">Customize the pipeline stages for this opportunity. Closed Won and Closed Lost are protected.</p>
                    </div>
                    <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-all">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-5">
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                        <DragDropContext onDragEnd={onDragEnd}>
                            <Droppable droppableId="opp-stages-edit">
                                {(provided) => (
                                    <div ref={provided.innerRef} {...provided.droppableProps} className="divide-y divide-gray-100">
                                        {stages.map((stage, index) => (
                                            <Draggable key={stage.stageKey} draggableId={`opp-${stage.stageKey}`} index={index} isDragDisabled={false}>
                                                {(provided, snapshot) => (
                                                    <div ref={provided.innerRef} {...provided.draggableProps}
                                                        className={`transition-all ${snapshot.isDragging ? 'bg-blue-50 shadow-md rounded-lg' : 'bg-white hover:bg-gray-50'}`}>
                                                        <div className="flex items-center gap-3 px-4 py-2.5">
                                                            <div {...provided.dragHandleProps} className="text-gray-300 hover:text-gray-600 cursor-grab active:cursor-grabbing flex-shrink-0 p-1 -ml-1 rounded hover:bg-gray-100 transition-colors" title="Drag to reorder">
                                                                <GripVertical className="w-4 h-4" />
                                                            </div>
                                                            <button type="button" onClick={() => toggleStage(stage.stageKey)}
                                                                disabled={stage.isSystem}
                                                                className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${stage.isActive ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-300 bg-white'} ${stage.isSystem ? 'opacity-60 cursor-not-allowed' : ''}`}>
                                                                {stage.isActive && <Check className="w-3 h-3" />}
                                                            </button>
                                                            <input type="text"
                                                                value={stage.label}
                                                                onChange={(e) => updateLabel(stage.stageKey, e.target.value)}
                                                                disabled={stage.isSystem}
                                                                className={`flex-1 text-sm font-semibold bg-transparent border-b border-transparent outline-none px-1 py-0.5 transition-colors ${stage.isSystem ? 'text-gray-500 cursor-not-allowed' : 'text-gray-800 hover:border-gray-300 focus:border-blue-400'}`}
                                                            />
                                                            {stage.isSystem ? (
                                                                <span className="flex items-center gap-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest flex-shrink-0">
                                                                    <Lock className="w-3 h-3" /> System
                                                                </span>
                                                            ) : (
                                                                <span className="text-[9px] font-bold text-gray-300 uppercase tracking-widest flex-shrink-0">
                                                                    {stage.isActive
                                                                        ? `Stage ${stages.slice(0, index + 1).filter(s => s.isActive).length}`
                                                                        : 'Hidden'}
                                                                </span>
                                                            )}
                                                            {!stage.isSystem && (
                                                                <button type="button" onClick={() => removeStage(stage.stageKey)}
                                                                    className="flex-shrink-0 p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded transition-all">
                                                                    <Trash2 className="w-3.5 h-3.5" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                            </Draggable>
                                        ))}
                                        {provided.placeholder}
                                    </div>
                                )}
                            </Droppable>
                        </DragDropContext>

                        {libraryAvailable.length > 0 && (
                            <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
                                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5">Add from library</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {libraryAvailable.map(ls => (
                                        <button key={ls.key} type="button" onClick={() => addLibraryStage(ls.key, ls.label)}
                                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-100 hover:bg-blue-100 rounded-full transition-all">
                                            <Plus className="w-3 h-3" />{ls.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex items-center gap-3 flex-wrap">
                            {showAddCustom ? (
                                <div className="flex items-center gap-2 flex-1">
                                    <input autoFocus type="text" value={newCustomLabel}
                                        onChange={(e) => setNewCustomLabel(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') addCustomStage(); if (e.key === 'Escape') setShowAddCustom(false); }}
                                        placeholder="Stage name..."
                                        className="flex-1 text-sm px-3 py-1.5 border border-blue-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-400" />
                                    <button type="button" onClick={addCustomStage} disabled={!newCustomLabel.trim()} className="px-3 py-1.5 bg-blue-500 text-white text-xs font-bold rounded-lg hover:bg-blue-600 disabled:opacity-40 flex-shrink-0">Add</button>
                                    <button type="button" onClick={() => setShowAddCustom(false)} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg flex-shrink-0"><X className="w-4 h-4" /></button>
                                </div>
                            ) : (
                                <button type="button" onClick={() => setShowAddCustom(true)}
                                    className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-800">
                                    <Plus className="w-3.5 h-3.5" />Add Custom Stage
                                </button>
                            )}
                        </div>
                    </div>

                    {error && (
                        <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
                    )}
                </div>

                <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-end gap-2 bg-gray-50">
                    <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-semibold text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
                    <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                        {saving ? 'Saving...' : 'Save changes'}
                    </button>
                </div>
            </div>
        </div>
    );
}
