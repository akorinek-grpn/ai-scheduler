"use client";

import type { Toast } from "@/lib/use-notifications";

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const statusStyles: Record<string, { bg: string; border: string; icon: string }> = {
  started: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", icon: "\u25B6" },
  success: { bg: "bg-green-500/10", border: "border-green-500/30", icon: "\u2713" },
  failed: { bg: "bg-red-500/10", border: "border-red-500/30", icon: "\u2717" },
  timeout: { bg: "bg-orange-500/10", border: "border-orange-500/30", icon: "\u23F1" },
};

const statusText: Record<string, string> = {
  started: "text-yellow-400",
  success: "text-green-400",
  failed: "text-red-400",
  timeout: "text-orange-400",
};

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps): React.ReactElement | null {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => {
        const style = statusStyles[toast.status] ?? statusStyles.started;
        const textColor = statusText[toast.status] ?? "text-muted-foreground";
        return (
          <div
            key={toast.id}
            className={`
              flex items-start gap-3 rounded-lg border p-3 shadow-lg
              bg-card ${style.border}
              animate-in slide-in-from-right duration-200
            `}
          >
            <span className={`text-sm font-medium mt-0.5 ${textColor}`}>{style.icon}</span>
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-medium ${textColor}`}>{toast.title}</p>
              <p className="text-xs text-muted-foreground truncate">{toast.body}</p>
            </div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="text-muted-foreground hover:text-foreground text-xs shrink-0"
            >
              {"\u2715"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
