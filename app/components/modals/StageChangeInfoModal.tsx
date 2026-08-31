'use client';

import { Fragment } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { CheckCircle2, AlertCircle, X, ArrowRight } from 'lucide-react';

export interface StageChangeNote {
    /** Short label, e.g. "Account promoted to CUSTOMER" */
    label: string;
    /** Optional follow-up text, e.g. link to act on it */
    detail?: string;
    /** Optional link the user can click to fix manually */
    link?: { href: string; label: string };
}

interface StageChangeInfoModalProps {
    isOpen: boolean;
    onClose: () => void;
    oldStage: string;
    newStage: string;
    /** Things the system did automatically as a side effect of this transition */
    autoChanges: StageChangeNote[];
    /** Things the system did NOT touch — user may want to fix manually */
    manualNotes: StageChangeNote[];
}

/**
 * Post-save informational modal shown after an Opportunity stage change.
 *
 * Surfaces (1) what the system mutated automatically and (2) what stayed put
 * so the user can act on it manually. The system never auto-reverts side
 * effects when reverting a stage — this modal is the channel that tells the
 * user what they may want to do by hand.
 */
export default function StageChangeInfoModal({
    isOpen,
    onClose,
    oldStage,
    newStage,
    autoChanges,
    manualNotes,
}: StageChangeInfoModalProps) {
    return (
        <Transition.Root show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={onClose}>
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/25 transition-opacity" />
                </Transition.Child>

                <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
                    <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
                        <Transition.Child
                            as={Fragment}
                            enter="ease-out duration-300"
                            enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                            enterTo="opacity-100 translate-y-0 sm:scale-100"
                            leave="ease-in duration-200"
                            leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                            leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                        >
                            <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-xl sm:p-6">
                                <div className="absolute right-0 top-0 hidden pr-4 pt-4 sm:block">
                                    <button
                                        type="button"
                                        className="rounded-md bg-white text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                                        onClick={onClose}
                                    >
                                        <span className="sr-only">Close</span>
                                        <X className="h-6 w-6" aria-hidden="true" />
                                    </button>
                                </div>

                                {/* Header: stage transition */}
                                <div className="sm:flex sm:items-start">
                                    <div className="w-full">
                                        <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900">
                                            Stage changed
                                        </Dialog.Title>
                                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                                            <span className="inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide bg-gray-100 text-gray-600 border border-gray-200">
                                                {oldStage}
                                            </span>
                                            <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
                                            <span className="inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide bg-blue-100 text-blue-700 border border-blue-200">
                                                {newStage}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {/* Automatic changes block */}
                                {autoChanges.length > 0 && (
                                    <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                                            <h4 className="text-[11px] font-black uppercase tracking-widest text-emerald-700">
                                                Automatic changes
                                            </h4>
                                        </div>
                                        <ul className="space-y-1.5">
                                            {autoChanges.map((c, i) => (
                                                <li key={i} className="text-sm text-emerald-900">
                                                    <span className="font-medium">{c.label}</span>
                                                    {c.detail && <span className="text-emerald-700"> — {c.detail}</span>}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {/* Manual review block */}
                                {manualNotes.length > 0 && (
                                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                                            <h4 className="text-[11px] font-black uppercase tracking-widest text-amber-700">
                                                Manual review — not changed automatically
                                            </h4>
                                        </div>
                                        <ul className="space-y-2">
                                            {manualNotes.map((n, i) => (
                                                <li key={i} className="text-sm text-amber-900">
                                                    <p className="font-medium">{n.label}</p>
                                                    {n.detail && <p className="text-[12px] text-amber-700 mt-0.5">{n.detail}</p>}
                                                    {n.link && (
                                                        <a
                                                            href={n.link.href}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="inline-block mt-1 text-[12px] font-semibold text-amber-700 underline hover:text-amber-900"
                                                        >
                                                            {n.link.label} →
                                                        </a>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {/* Empty state — should rarely happen but safe fallback */}
                                {autoChanges.length === 0 && manualNotes.length === 0 && (
                                    <div className="mt-5 text-sm text-gray-500">
                                        No related side effects for this transition.
                                    </div>
                                )}

                                <div className="mt-6 flex justify-end">
                                    <button
                                        type="button"
                                        className="inline-flex justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
                                        onClick={onClose}
                                    >
                                        Got it
                                    </button>
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition.Root>
    );
}
