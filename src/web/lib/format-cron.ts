const DAY_NAMES: Record<string, string> = {
  "0": "Sunday",
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
  "7": "Sunday",
};

const DAY_SHORT: Record<string, string> = {
  "0": "Sun",
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
  "7": "Sun",
};

function formatTime(hour: string, min: string): string {
  const h = parseInt(hour);
  const m = min.padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m} ${ampm}`;
}

function formatDays(dow: string): string {
  if (dow === "*") return "Every day";
  if (dow === "1-5") return "Weekdays";
  if (dow === "0,6" || dow === "6,0") return "Weekends";

  // Comma-separated days: "1,4" → "Mon & Thu"
  if (dow.includes(",")) {
    const days = dow.split(",").map((d) => DAY_SHORT[d.trim()] ?? d);
    if (days.length === 2) return `${days[0]} & ${days[1]}`;
    return days.slice(0, -1).join(", ") + " & " + days[days.length - 1];
  }

  // Range: "1-5" handled above, but cover others like "0-3"
  if (dow.includes("-")) {
    const [start, end] = dow.split("-");
    return `${DAY_NAMES[start] ?? start} to ${DAY_NAMES[end] ?? end}`;
  }

  // Single day
  return `${DAY_NAMES[dow] ?? dow}s`;
}

export function formatCronHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;

  const [min, hour, dom, mon, dow] = parts;

  // Every N minutes
  if (min.startsWith("*/") && hour === "*") {
    return `Every ${min.slice(2)} min`;
  }

  // Every N hours
  if (min === "0" && hour.startsWith("*/")) {
    return `Every ${hour.slice(2)} hours`;
  }

  const time = formatTime(hour, min);
  const days = formatDays(dow);

  // Specific day of month
  if (dom !== "*" && dow === "*") {
    const monthStr = mon === "*" ? "every month" : `month ${mon}`;
    return `Day ${dom} of ${monthStr} at ${time}`;
  }

  return `${days} at ${time}`;
}
