import { describe, it, expect } from "vitest";
import { placedHostNames } from "../host-view";
import type { HostStatus } from "../../lib/api-client";

const host = (name: string, role: string): HostStatus => ({
  name,
  role,
  ssh: null,
  isSelf: false,
  health: null,
  error: null,
  jobs: [],
});
const hosts = [host("PRO-1", "groupon-mac-16"), host("AIR-1", "groupon-mac-air")];

describe("placedHostNames", () => {
  it("maps a role to the Mac that has it", () => {
    expect(placedHostNames(hosts, "groupon-mac-air")).toEqual(["AIR-1"]);
  });

  it("places 'all', a missing runs_on and a list of every role on every Mac", () => {
    expect(placedHostNames(hosts, "all")).toEqual(["PRO-1", "AIR-1"]);
    expect(placedHostNames(hosts, undefined)).toEqual(["PRO-1", "AIR-1"]);
    expect(placedHostNames(hosts, ["groupon-mac-air", "groupon-mac-16"])).toEqual(["PRO-1", "AIR-1"]);
  });

  it("places a role no Mac declares nowhere", () => {
    expect(placedHostNames(hosts, "groupon-mac-mini")).toEqual([]);
  });
});
