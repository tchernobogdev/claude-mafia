"use client";
import { useEffect, useRef } from "react";

interface Props { open: boolean; title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void; }

export default function ConfirmDialog({ open, title, message, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) cancelRef.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title} onClick={onCancel} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="glass-card p-6 max-w-sm w-full mx-4 space-y-4 animate-slideUp" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-text">{title}</h3>
        <p className="text-sm text-text-muted">{message}</p>
        <div className="flex justify-end gap-3">
          <button ref={cancelRef} onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-border text-text-muted hover:text-text hover:border-accent transition-all">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm rounded-lg bg-danger hover:bg-danger/80 text-white transition-all font-medium">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}