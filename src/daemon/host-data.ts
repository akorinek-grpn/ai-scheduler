import fs from "fs";
import path from "path";

import { hostRole, type SchedulerConfig } from "@shared/config-schema";
import { hostMirrorRoot } from "./host-sync";

/**
 * Where each host's run data lives on this Mac: our own data/ for this host, and the mirror
 * host-sync.ts keeps in data/hosts/<name>/ for the others. `root` is used like a projectRoot,
 * so every reader in @shared/paths works on it unchanged.
 */
export interface HostDataRoot {
  name: string;
  role: string;
  root: string;
  isSelf: boolean;
}

/** Hosts in scheduler.yaml order; another host appears once its mirror exists. */
export function hostDataRoots(
  projectRoot: string,
  config: Pick<SchedulerConfig, "hosts" | "host"> | null,
): HostDataRoot[] {
  if (!config?.hosts || !config.host) {
    return [{ name: "local", role: "local", root: projectRoot, isSelf: true }];
  }
  const self = config.host.name.toLowerCase();
  const roots: HostDataRoot[] = [];
  for (const [name, entry] of Object.entries(config.hosts)) {
    const role = hostRole(entry);
    if (name.toLowerCase() === self) {
      roots.push({ name, role, root: projectRoot, isSelf: true });
      continue;
    }
    const root = hostMirrorRoot(projectRoot, name);
    if (fs.existsSync(path.join(root, "data"))) {
      roots.push({ name, role, root, isSelf: false });
    }
  }
  return roots;
}

/**
 * Whether a record found in `holder`'s data was produced there. Records carry the host that
 * ran them (meta.json `host`); one without is taken to be the holder's own. A copy of another
 * host's history (stamped with that host) is therefore never counted twice.
 */
export function producedBy(holder: HostDataRoot, recordHost: string | undefined): boolean {
  return (recordHost ?? holder.name).toLowerCase() === holder.name.toLowerCase();
}

/**
 * `?host=` on the API: absent or "self" is this host, "all" is every host, anything else must
 * name a host in scheduler.yaml (any case). null for an unknown name.
 */
export function selectHostRoots(
  roots: HostDataRoot[],
  selection: unknown,
): HostDataRoot[] | null {
  if (selection === undefined || selection === "self") return roots.filter((r) => r.isSelf);
  if (selection === "all") return roots;
  if (typeof selection !== "string") return null;
  const match = roots.find((r) => r.name.toLowerCase() === selection.toLowerCase());
  return match ? [match] : null;
}
