import { describe, it, expect } from "vitest";
import { formatCronHuman } from "../format-cron";

describe("formatCronHuman", () => {
  it("describes hourly schedules instead of reading the hour field as one time", () => {
    // desk-activity-pull: rendered "Every day at NaN:50 AM" before (2026-10-15).
    expect(formatCronHuman("50 * * * *")).toBe("Every hour at :50");
    expect(formatCronHuman("15 * * * 1-5")).toBe("Weekdays, every hour at :15");
  });

  it("describes hour ranges as hourly windows", () => {
    // babysit-prs: rendered "Weekdays at 6:00 AM" before.
    expect(formatCronHuman("0 6-22 * * 1-5")).toBe("Weekdays, hourly at :00 from 6 AM to 10 PM");
    // autopilot-babysit: rendered as two single times before.
    expect(formatCronHuman("50 6-7,9-22 * * 1-5")).toBe(
      "Weekdays, hourly at :50 from 6 AM to 7 AM & 9 AM to 10 PM",
    );
    expect(formatCronHuman("30 0-11 * * *")).toBe("Every day, hourly at :30 from 12 AM to 11 AM");
  });

  it("keeps the existing single-time and list formats", () => {
    expect(formatCronHuman("5 9 * * 1-5")).toBe("Weekdays at 9:05 AM");
    expect(formatCronHuman("0 11,14,17 * * 5")).toBe("Fridays at 11:00 AM, 2:00 PM & 5:00 PM");
    expect(formatCronHuman("0 9,15,21 * * 5,6,0")).toBe("Fri, Sat & Sun at 9:00 AM, 3:00 PM & 9:00 PM");
    expect(formatCronHuman("*/15 * * * *")).toBe("Every 15 min");
    expect(formatCronHuman("0 */2 * * *")).toBe("Every 2 hours");
  });
});
