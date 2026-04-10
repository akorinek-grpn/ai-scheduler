"use client";

import { createContext, useContext, useEffect, useRef, useCallback } from "react";
import { useNotifications, type UseNotificationsResult } from "@/lib/use-notifications";
import { ToastContainer } from "@/components/toast-container";
import { getRuns, type RunResponse } from "@/lib/api-client";

const NotificationContext = createContext<UseNotificationsResult | null>(null);

export function useNotificationContext(): UseNotificationsResult {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotificationContext must be used within NotificationProvider");
  return ctx;
}

export function NotificationProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const notifications = useNotifications();
  const previousRunsRef = useRef<Map<string, RunResponse>>(new Map());
  const isFirstPollRef = useRef(true);

  const checkForChanges = useCallback(async () => {
    try {
      const runs = await getRuns({ limit: 20 });
      const currentMap = new Map(runs.map((r) => [`${r.jobId}-${r.runId}`, r]));
      const prevMap = previousRunsRef.current;

      // Skip notifications on first poll (don't notify for existing state)
      if (!isFirstPollRef.current) {
        for (const [key, run] of currentMap) {
          const prev = prevMap.get(key);

          if (!prev && run.status === "running") {
            // New run started
            notifications.notifyJobStarted(run.jobName, run.jobId);
          } else if (prev?.status === "running" && run.status !== "running") {
            // Run just finished
            notifications.notifyJobFinished(run.jobName, run.jobId, run.status);
          }
        }
      }

      isFirstPollRef.current = false;
      previousRunsRef.current = currentMap;
    } catch {
      // silently fail
    }
  }, [notifications]);

  useEffect(() => {
    checkForChanges();
    const interval = setInterval(checkForChanges, 5_000);
    return () => clearInterval(interval);
  }, [checkForChanges]);

  return (
    <NotificationContext.Provider value={notifications}>
      {children}
      <ToastContainer toasts={notifications.toasts} onDismiss={notifications.dismissToast} />
    </NotificationContext.Provider>
  );
}
