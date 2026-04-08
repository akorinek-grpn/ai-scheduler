import fs from "fs";

import yaml from "js-yaml";

import { configSchema, type SchedulerConfig } from "@shared/config-schema";

interface ConfigSuccess {
  success: true;
  data: SchedulerConfig;
}

interface ConfigError {
  success: false;
  error: string;
}

export type ConfigResult = ConfigSuccess | ConfigError;

export function loadConfig(configPath: string): ConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read config file: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      success: false,
      error: `Invalid YAML: ${(err as Error).message}`,
    };
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: `Config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    };
  }

  return { success: true, data: result.data };
}
