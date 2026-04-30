#!/usr/bin/env node
// Real-machine verification for P3-C-3b crash-recovery supervisor.
// Sets up an isolated runtime tmpdir with one hall + one in_progress task card +
// one HallMessage + one stale `enqueue` line in `.hall/inbox/{agent}.jsonl` (no
// matching `consume` line — i.e. the orphan a crash would leave behind), then
// invokes recoverPendingHallInboxes the same way `src/index.ts` does at startup
// and prints what happened.
//
// HALL_RUNTIME_DISPATCH_ENABLED=false short-circuits the runtime call so the
// recovery loop completes without trying to talk to OpenClaw — the value of
// this script is verifying the *wiring* (scan → schedule → consume + delivery),
// not running an actual agent.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Force isolated runtime BEFORE any module that reads cwd / env at import time.
const runtimeDir = mkdtempSync(join(tmpdir(), "supv-verify-"));
process.env.OPENCLAW_RUNTIME_DIR = runtimeDir;
process.env.HALL_RUNTIME_DISPATCH_ENABLED = "false"; // we don't actually dispatch
process.chdir(runtimeDir); // hall-workspace.ts captures cwd at import time

mkdirSync(join(runtimeDir, "runtime"), { recursive: true });

const HALL_ID = "main";
const CARD_ID = "supv-e2e-card";
const PARTICIPANT_ID = "linus-dev";
const TRIGGER_MESSAGE_ID = "msg-orphan-1";
const ORPHAN_RECORD_ID = randomUUID();
const NOW = new Date().toISOString();

// Step 1: pre-populate runtime stores
writeFileSync(
  join(runtimeDir, "collaboration-halls.json"),
  JSON.stringify(
    {
      halls: [
        {
          hallId: HALL_ID,
          title: "Verify",
          participants: [
            {
              participantId: "operator",
              agentId: "operator",
              displayName: "Operator",
              semanticRole: "manager",
              active: true,
              aliases: [],
              isHuman: true,
            },
            {
              participantId: PARTICIPANT_ID,
              agentId: PARTICIPANT_ID,
              displayName: "Linus",
              semanticRole: "coder",
              active: true,
              aliases: [],
            },
          ],
          taskCardIds: [CARD_ID],
          messageIds: [TRIGGER_MESSAGE_ID],
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
    null,
    2,
  ),
);

writeFileSync(
  join(runtimeDir, "collaboration-task-cards.json"),
  JSON.stringify(
    {
      taskCards: [
        {
          taskCardId: CARD_ID,
          hallId: HALL_ID,
          projectId: "p1",
          taskId: "t1",
          title: "verify supervisor",
          description: "stale inbox record waiting for recovery",
          status: "in_progress",
          mentionedParticipantIds: [PARTICIPANT_ID],
          plannedExecutionOrder: [],
          plannedExecutionItems: [],
          sessionKeys: [],
          blockers: [],
          requiresInputFrom: [],
          createdByParticipantId: "operator",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
    null,
    2,
  ),
);

writeFileSync(
  join(runtimeDir, "collaboration-hall-messages.json"),
  JSON.stringify(
    {
      messages: [
        {
          hallId: HALL_ID,
          messageId: TRIGGER_MESSAGE_ID,
          kind: "task",
          authorParticipantId: "operator",
          authorLabel: "Operator",
          content: "@linus-dev verify recovery",
          targetParticipantIds: [PARTICIPANT_ID],
          mentionTargets: [{ participantId: PARTICIPANT_ID, raw: "@linus-dev" }],
          taskCardId: CARD_ID,
          projectId: "p1",
          taskId: "t1",
          createdAt: NOW,
        },
      ],
    },
    null,
    2,
  ),
);

// Step 2: write the orphan inbox line (enqueue without consume — what a crash leaves)
const cardWorkspace = join(runtimeDir, "runtime", "hall-workspaces", CARD_ID);
const inboxDir = join(cardWorkspace, ".hall", "inbox");
mkdirSync(inboxDir, { recursive: true });

const orphan = {
  recordId: ORPHAN_RECORD_ID,
  triggerMessageId: TRIGGER_MESSAGE_ID,
  taskCardId: CARD_ID,
  targetParticipantId: PARTICIPANT_ID,
  triggerAuthorParticipantId: "operator",
  enqueueReason: "operator-route" as const,
  chainDepth: 0,
  enqueuedAt: NOW,
};
const inboxFile = join(inboxDir, `${PARTICIPANT_ID}.jsonl`);
writeFileSync(
  inboxFile,
  JSON.stringify({ op: "enqueue", record: orphan }) + "\n",
  "utf8",
);

console.log("[verify] runtime tmpdir:", runtimeDir);
console.log("[verify] orphan inbox file:", inboxFile);
console.log("[verify] orphan recordId:", ORPHAN_RECORD_ID);

// Step 3: invoke supervisor exactly like src/index.ts does at startup
async function run(): Promise<void> {
  const { recoverPendingHallInboxes } = await import("../src/runtime/hall-supervisor");
  const { buildHallRecoveryDispatcher } = await import("../src/runtime/collaboration-hall-orchestrator");
  const { createToolClient } = await import("../src/clients/factory");

  const client = createToolClient();
  const t0 = Date.now();
  const report = await recoverPendingHallInboxes({
    dispatcher: buildHallRecoveryDispatcher(client),
  });
  const t1 = Date.now();

  console.log("[verify] report:", JSON.stringify(report, null, 2));
  console.log(`[verify] elapsed: ${t1 - t0} ms`);

  // Step 4: assert disk state — the orphan must now have a matching consume line
  const lines = readFileSync(inboxFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`[verify] inbox lines after recovery: ${lines.length}`);
  for (const line of lines) {
    console.log(`  • ${line.op} ${line.record.recordId} ${line.op === "consume" ? `(${line.record.outcome}: ${line.record.reason ?? ""})` : ""}`);
  }

  const enqueueCount = lines.filter((l) => l.op === "enqueue").length;
  const consumeCount = lines.filter((l) => l.op === "consume").length;
  if (enqueueCount !== 1) {
    throw new Error(`expected 1 enqueue line, found ${enqueueCount}`);
  }
  if (consumeCount !== 1) {
    throw new Error(`expected 1 consume line (recovery should have closed the orphan), found ${consumeCount}`);
  }

  // Step 5: assert deliveries.jsonl was written
  const deliveriesPath = join(cardWorkspace, ".hall", "deliveries.jsonl");
  if (!existsSync(deliveriesPath)) {
    throw new Error(`expected deliveries.jsonl at ${deliveriesPath}`);
  }
  const deliveries = readFileSync(deliveriesPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  console.log(`[verify] deliveries.jsonl entries: ${deliveries.length}`);
  for (const d of deliveries) {
    console.log(`  • ${d.recordId} → ${d.outcome}${d.reason ? ` (${d.reason})` : ""} (${d.durationMs}ms)`);
  }
  if (deliveries.length !== 1) {
    throw new Error(`expected 1 delivery, found ${deliveries.length}`);
  }
  if (deliveries[0].recordId !== ORPHAN_RECORD_ID) {
    throw new Error(`delivery recordId ${deliveries[0].recordId} != orphan ${ORPHAN_RECORD_ID}`);
  }

  // Step 6: assert the report numbers match
  if (report.scheduledCount !== 1) {
    throw new Error(`expected scheduledCount=1, got ${report.scheduledCount}`);
  }

  console.log("[verify] ✅ all assertions passed — supervisor recovered the orphan end-to-end");
}

// hall-scheduler's debounce timer is `.unref()`'d so it doesn't block dev
// server exit. But this CLI script has no HTTP server keeping the event loop
// alive — without an explicit ref the unresolved scheduleRecovered promise
// won't hold the process either, and we silently exit before the worker
// drains. Hold the loop with a refed interval until run() finishes.
const eventLoopAnchor = setInterval(() => undefined, 60_000);
run().then(
  () => {
    clearInterval(eventLoopAnchor);
    process.exit(0);
  },
  (err) => {
    clearInterval(eventLoopAnchor);
    console.error("[verify] ❌ FAILED:", err);
    process.exit(1);
  },
);
