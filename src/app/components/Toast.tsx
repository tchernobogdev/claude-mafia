"use client";
import { useState, useEffect, createContext, useContext, useCallback } from "react";

type ToastType = "success" | "error" | "info";
interface Toast { id: number; message: string; type: ToastType; }

const ToastContext = createContext<{ toast: (message: string, type?: ToastType) => void }>({ toast: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Date.now();
    setToasts((p) => [...p, { id, message, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 space-y-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`glass-card px-4 py-3 rounded-lg text-sm font-medium animate-slideUp shadow-lg border ${
            t.type === "success" ? "border-success/40 text-success" : t.type === "error" ? "border-danger/40 text-danger" : "border-accent/40 text-accent"
          }`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
