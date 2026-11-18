/**
 * #4401: hrn:node:hadronmemory.com:specs:cor:agt:050:22 r8 defines NO_FAMILY, so neither server copy of the roster-state
 * description may still say it is undefined. The `hadron_team_roster` MCP tool is disabled (#3082, `offTeamTool`), so its
 * text never reaches `tools/list` or the #2260 golden; it is pinned here from the exported constant (#4413).
 */
import { describe, expect, it } from "vitest";
import { HADRON_TEAM_ROSTER_DESCRIPTION } from "../../../mcp/agentTaskTools.js";
import { typeDefs } from "./typeDefs.js";

const STALE = /NO_FAMILY is served but not yet defined/;

function teamRosterStateBlock(): RegExpMatchArray {
  const m = typeDefs.match(/"""([^"]*?)"""\s*enum TeamRosterState\b\s*\{([^}]*)\}/);
  if (!m) throw new Error("TeamRosterState not found in typeDefs");
  return m;
}

function teamRosterStateDescription(): string {
  return teamRosterStateBlock()[1];
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
    const d = HADRON_TEAM_ROSTER_DESCRIPTION;
    expect(d).not.toMatch(STALE);
    expect(d).toContain(
      "hrn:node:hadronmemory.com:specs:cor:agt:050:22 (Proposed)",
    );
  });

  it("#4413 F3: NO_FAMILY is still a TeamRosterState member and the tool's state list still names it", () => {
    const members = teamRosterStateBlock()[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Z_]+$/.test(l));
    expect(members).toContain("NO_FAMILY");
    expect(HADRON_TEAM_ROSTER_DESCRIPTION).toMatch(/\bNO_FAMILY\b/);
  });
});
