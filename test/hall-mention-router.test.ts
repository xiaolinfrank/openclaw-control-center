import assert from "node:assert/strict";
import test from "node:test";
import { resolveHallMentionTargets } from "../src/runtime/hall-mention-router";
import type { HallParticipant } from "../src/types";

const participants: HallParticipant[] = [
  {
    participantId: "main",
    agentId: "main",
    displayName: "Main",
    semanticRole: "manager",
    active: true,
    aliases: ["Main", "main"],
  },
  {
    participantId: "pandas",
    agentId: "pandas",
    displayName: "Pandas",
    semanticRole: "coder",
    active: true,
    aliases: ["Pandas", "pandas"],
  },
];

test("hall mention router resolves one exact participant", () => {
  const result = resolveHallMentionTargets("Please review this, @Pandas", participants);
  assert.equal(result.broadcastAll, false);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].participantId, "pandas");
});

test("hall mention router recognizes @all", () => {
  const result = resolveHallMentionTargets("Heads up, @all", participants);
  assert.equal(result.broadcastAll, true);
});

test("hall mention router routes @ wrapped in markdown emphasis (bold/italic/strike)", () => {
  // Real-world regression: PM-style replies frequently bold the assignee,
  // e.g. `- **@Pandas** — own this`. Before the fix `*` wasn't a valid
  // pre/post boundary, so mentionTargets came out empty and the @-ed agent
  // got no inbox enqueue.
  const cases = ["**@Pandas**", "*@Pandas*", "_@Pandas_", "~~@Pandas~~"];
  for (const c of cases) {
    const result = resolveHallMentionTargets(`- ${c} — own this`, participants);
    assert.equal(result.targets.length, 1, `case=${c}`);
    assert.equal(result.targets[0].participantId, "pandas", `case=${c}`);
  }
});

test("hall mention router routes multiple bolded mentions in a list", () => {
  const content = `任务拆解：
- **@Pandas** — 写代码
- **@Main** — 汇总`;
  const result = resolveHallMentionTargets(content, participants);
  assert.equal(result.targets.length, 2);
  const ids = result.targets.map((t) => t.participantId).sort();
  assert.deepEqual(ids, ["main", "pandas"]);
});
