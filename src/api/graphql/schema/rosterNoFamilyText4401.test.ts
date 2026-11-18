/**
 * #4401: hrn:node:hadronmemory.com:specs:cor:agt:050:22 r8 defines NO_FAMILY, so neither server copy of the roster-state
 * description may still say it is undefined. The `hadron_team_roster` MCP tool is disabled (#3082, `offTeamTool`), so its
 * text never reaches `tools/list` or the #2260 golden; it is pinned here from source.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { typeDefs } from "./typeDefs.js";

const STALE = /NO_FAMILY is served but not yet defined/;

function teamRosterStateDescription(): string {
  const m = typeDefs.match(/"""([^"]*?)"""\s*enum TeamRosterState\b/);
  if (!m) throw new Error("TeamRosterState description not found in typeDefs");
  return m[1];
}

function rosterToolDescription(): string {
  const src = fs.readFileSync(
    new URL("../../../mcp/agentTaskTools.ts", import.meta.url),
    "utf8",
  );
  const start = src.search(/off\(\s*'hadron_team_roster',/);
  if (start < 0) throw new Error("hadron_team_roster registration not found");
  return src.slice(start, src.indexOf("SHAPE_HADRON_TEAM_ROSTER", start));
}

describe("#4401 NO_FAMILY is defined by cor:agt:050:22", () => {
  it("the TeamRosterState SDL description no longer says NO_FAMILY is undefined, and keeps the URN and Proposed", () => {
    const d = teamRosterStateDescription();
    expect(d).not.toMatch(STALE);
    expect(d).toContain("hrn:node:hadronmemory.com:specs:cor:agt:050:22");
    expect(d).toContain("Proposed");
    expect(d).toContain("first that holds, in this order.");
  });

  it("the hadron_team_roster tool description no longer says NO_FAMILY is undefined, and keeps the URN and Proposed", () => {
    const d = rosterToolDescription();
    expect(d).not.toMatch(STALE);
    expect(d).toContain(
      "hrn:node:hadronmemory.com:specs:cor:agt:050:22 (Proposed)",
    );
  });
});
