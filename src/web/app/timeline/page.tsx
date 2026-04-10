"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Timeline } from "@/components/timeline";
import { getJobs, getRuns, type JobResponse, type RunResponse } from "@/lib/api-client";

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Go back to Monday
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

export default function TimelinePage(): React.ReactElement {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));

  const fetchAll = useCallback(async () => {
    const [j, r] = await Promise.all([
      getJobs().catch(() => []),
      getRuns({ limit: 500 }).catch(() => []),
    ]);
    setJobs(j);
    setRuns(r);
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const goToPrevWeek = () => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - 7);
    setWeekStart(d);
  };

  const goToNextWeek = () => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    setWeekStart(d);
  };

  const goToThisWeek = () => {
    setWeekStart(getWeekStart(new Date()));
  };

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} \u2014 ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  const isCurrentWeek = getWeekStart(new Date()).getTime() === weekStart.getTime();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Timeline</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Weekly schedule view with run results
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={goToPrevWeek}>
          {"\u2190"} Prev
        </Button>
        <Button
          variant={isCurrentWeek ? "secondary" : "outline"}
          size="sm"
          onClick={goToThisWeek}
          disabled={isCurrentWeek}
        >
          This week
        </Button>
        <Button variant="outline" size="sm" onClick={goToNextWeek}>
          Next {"\u2192"}
        </Button>
        <span className="text-sm font-medium ml-2">{weekLabel}</span>
      </div>

      <Card>
        <CardContent className="pt-4">
          <Timeline
            jobs={jobs}
            runs={runs}
            startDate={weekStart}
            days={7}
          />
        </CardContent>
      </Card>
    </div>
  );
}
