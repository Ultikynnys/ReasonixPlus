import { describe, expect, it } from "vitest";
import { groupSkills, skillSourceLabel } from "../src/skill-groups.js";

function skill(id: string, source?: string) {
  return source ? { id, source } : { id };
}

describe("skillSourceLabel", () => {
  it("names a git source by its repository path", () => {
    expect(skillSourceLabel("https://github.com/LLMQuant/skills")).toBe("LLMQuant/skills");
    expect(skillSourceLabel("https://github.com/LLMQuant/skills.git")).toBe("LLMQuant/skills");
    expect(skillSourceLabel("git@github.com:LLMQuant/skills.git")).toBe("LLMQuant/skills");
    expect(skillSourceLabel("https://github.com/LLMQuant/skills/")).toBe("LLMQuant/skills");
  });

  it("keeps the last two segments of a deeper repository path", () => {
    expect(skillSourceLabel("https://gitlab.com/group/team/skills")).toBe("team/skills");
  });

  it("names a local directory by its own folder", () => {
    expect(skillSourceLabel("/home/ana/work/skills")).toBe("skills");
    expect(skillSourceLabel("C:\\Users\\ana\\work\\skills\\")).toBe("skills");
  });
});

describe("groupSkills", () => {
  it("reads the skills of one install as one group", () => {
    const source = "https://github.com/LLMQuant/skills";
    const groups = groupSkills([
      skill("llmquant-risk", source),
      skill("llmquant-macro", source),
      skill("llmquant-credit", source),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: `source:${source}`,
      label: "LLMQuant/skills",
      source,
      inferred: false,
    });
    expect(groups[0]?.skills.map((row) => row.id)).toEqual([
      "llmquant-credit",
      "llmquant-macro",
      "llmquant-risk",
    ]);
  });

  it("keeps a lone install as its own row", () => {
    const groups = groupSkills([skill("churn-analysis", "/home/ana/skills")]);

    expect(groups).toEqual([
      {
        key: "solo:churn-analysis",
        label: "churn-analysis",
        inferred: false,
        skills: [{ id: "churn-analysis", source: "/home/ana/skills" }],
      },
    ]);
  });

  it("falls back to the shared id prefix for a skill installed before sources were recorded", () => {
    const groups = groupSkills([
      skill("llmquant-risk"),
      skill("llmquant-macro"),
      skill("churn-analysis"),
    ]);

    expect(groups.map((group) => [group.label, group.inferred, group.skills.length])).toEqual([
      ["churn-analysis", false, 1],
      ["llmquant-*", true, 2],
    ]);
  });

  it("leaves an id without a separator alone", () => {
    const groups = groupSkills([skill("review"), skill("deploy")]);
    expect(groups.map((group) => group.label)).toEqual(["deploy", "review"]);
  });

  it("keeps a recorded source ahead of the prefix fallback", () => {
    const groups = groupSkills([
      skill("llmquant-risk", "https://github.com/LLMQuant/skills"),
      skill("llmquant-macro", "https://github.com/LLMQuant/skills"),
      skill("llmquant-credit"),
    ]);

    expect(groups.map((group) => [group.label, group.skills.length])).toEqual([
      ["llmquant-credit", 1],
      ["LLMQuant/skills", 2],
    ]);
  });

  it("sorts groups by label", () => {
    const groups = groupSkills([
      skill("zeta", "/a/zeta"),
      skill("alpha", "/a/alpha"),
      skill("mid", "/a/mid"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns nothing for an empty inventory", () => {
    expect(groupSkills([])).toEqual([]);
  });
});
