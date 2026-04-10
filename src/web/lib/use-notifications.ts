"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type NotificationPermission = "default" | "granted" | "denied";

export interface Toast {
  id: string;
  title: string;
  body: string;
  status: "started" | "success" | "failed" | "timeout";
  timestamp: number;
}

export interface UseNotificationsResult {
  permission: NotificationPermission;
  requestPermission: () => Promise<void>;
  notifyJobStarted: (jobName: string, jobId: string) => void;
  notifyJobFinished: (jobName: string, jobId: string, status: string) => void;
  toasts: Toast[];
  dismissToast: (id: string) => void;
}

export function useNotifications(): UseNotificationsResult {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounter = useRef(0);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setPermission(Notification.permission as NotificationPermission);
    }
  }, []);

  // Auto-dismiss toasts after 8 seconds
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => now - t.timestamp < 8000));
    }, 1000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const requestPermission = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result as NotificationPermission);
  }, []);

  const addToast = useCallback((title: string, body: string, status: Toast["status"]) => {
    const id = `toast-${++toastCounter.current}`;
    setToasts((prev) => [...prev.slice(-4), { id, title, body, status, timestamp: Date.now() }]);
  }, []);

  const notifyJobStarted = useCallback((jobName: string, jobId: string) => {
    addToast("Job Started", jobName, "started");

    if (permission === "granted" && typeof window !== "undefined" && "Notification" in window) {
      new Notification("AI Scheduler: Job Started", {
        body: jobName,
        icon: "/favicon.ico",
        tag: `job-started-${jobId}`,
      });
    }
  }, [permission, addToast]);

  const notifyJobFinished = useCallback((jobName: string, jobId: string, status: string) => {
    const statusLabel = status === "success" ? "completed successfully"
      : status === "failed" ? "failed"
        : status === "timeout" ? "timed out"
          : "finished";
    const toastStatus = (status === "success" || status === "failed" || status === "timeout")
      ? status as Toast["status"]
      : "success";

    addToast("Job Finished", `${jobName} ${statusLabel}`, toastStatus);

    if (permission === "granted" && typeof window !== "undefined" && "Notification" in window) {
      new Notification(`AI Scheduler: Job ${statusLabel}`, {
        body: jobName,
        icon: "/favicon.ico",
        tag: `job-finished-${jobId}`,
      });
    }
  }, [permission, addToast]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { permission, requestPermission, notifyJobStarted, notifyJobFinished, toasts, dismissToast };
}
