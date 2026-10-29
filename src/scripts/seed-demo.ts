/**
 * Demo data for trying Agent Governance and AI traffic locally:
 *
 *   npm run seed:demo
 *
 * Creates (or reuses) one account and fills its workspace with agents of
 * every kind, an unregistered script, policies, activity, alerts, a held
 * approval, a month of AI spend and an SDK integration with AI traffic.
 * Safe to run again: earlier demo data is replaced, other data is left alone.
 *
 * DEMO_EMAIL / DEMO_PASSWORD choose the account (default qa@example.com /
 * Password123!). Refuses to run with NODE_ENV=production.
 */
import { Types } from "mongoose";

import { connectDatabase, disconnectDatabase } from "../config/db.config.js";
import UserModel from "../modules/auth/models/user.model.js";
import authService from "../modules/auth/services/auth.service.js";
import projectService from "../modules/project/services/project.service.js";
import ProjectModel from "../modules/project/models/project.model.js";
import workspaceService from "../modules/workspace/services/workspace.service.js";
import PromptExecutionLogModel from "../modules/prompt/models/prompt-execution-log.model.js";
import SdkIntegrationModel from "../modules/sdk-integrations/model.js";
import sdkIntegrationService from "../modules/sdk-integrations/service.js";
import AnalyticsLogModel from "../modules/analytics/models/analytics-log.model.js";
import trackingService from "../modules/analytics/services/tracking.service.js";
import agentService from "../modules/agents/agent.service.js";
import { recomputeRisk } from "../modules/agents/governance.service.js";
import { raiseAlert } from "../modules/agents/activity.service.js";
import { POLICY_TEMPLATES } from "../modules/agents/policy-templates.js";
import { redactInput } from "../modules/agents/redaction.js";
import {
  AgentActivityModel,
  AgentAlertModel,
  AgentApprovalModel,
  AgentModel,
  AgentPolicyModel,
} from "../modules/agents/model.js";

const EMAIL = process.env.DEMO_EMAIL ?? "qa@example.com";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Password123!";
const DEMO = "[demo]";
const DAY = 86400000;
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * DAY - hours * 3600_000);

async function account() {
  let user = await UserModel.findOne({ email: EMAIL });
  const created = !user;
  if (!user) {
    await authService.register({
      email: EMAIL,
      password: PASSWORD,
      name: "QA User",
    });
    user = await UserModel.findOne({ email: EMAIL });
  }
  if (!user) throw new Error("Could not create the demo account");
  const workspace = await workspaceService.getOrCreateDefaultWorkspace(
    user._id.toString(),
  );
  return { user, workspaceId: workspace._id.toString(), created };
}

async function project(userId: string, workspaceId: string, name: string) {
  const existing = await ProjectModel.findOne({ workspaceId, name }).lean();
  if (existing) return existing._id.toString();
  const created = await projectService.createProject(userId, {
    name,
    description: `${DEMO} sample project`,
    workspaceId,
  } as Parameters<typeof projectService.createProject>[1]);
  return String(
    (created as { id?: string; _id?: unknown }).id ??
      (created as { _id?: unknown })._id,
  );
}

async function clearPrevious(userId: Types.ObjectId, workspaceId: string) {
  const agents = await AgentModel.find({
    ownerUserId: userId,
    name: { $regex: `^\\${DEMO}|^python-requests$` },
  }).select("_id");
  const ids = agents.map((a) => a._id);
  await Promise.all([
    AgentModel.deleteMany({ _id: { $in: ids } }),
    AgentActivityModel.deleteMany({ agentId: { $in: ids } }),
    AgentAlertModel.deleteMany({ agentId: { $in: ids } }),
    AgentApprovalModel.deleteMany({ agentId: { $in: ids } }),
    AgentPolicyModel.deleteMany({
      workspaceId,
      description: { $regex: `^\\${DEMO}` },
    }),
    PromptExecutionLogModel.deleteMany({ requestId: /^demo_/ }),
  ]);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seed:demo creates an account with a known password; it does not run in production.",
    );
  }
  await connectDatabase();
  const { user, workspaceId, created } = await account();
  const userId = user._id.toString();
  await clearPrevious(user._id, workspaceId);

  const apollo = await project(userId, workspaceId, "Apollo");
  const gemini = await project(userId, workspaceId, "Gemini");

  // --- Agents of every kind ---
  const nightly = await agentService.createApiKey({
    ownerUserId: userId,
    workspaceId,
    name: `${DEMO} Nightly sync`,
    scopes: ["work:read", "work:write"],
    projectIds: [apollo],
    expiresAt: new Date(Date.now() + 60 * DAY).toISOString(),
  });
  const reporting = await agentService.createApiKey({
    ownerUserId: userId,
    workspaceId,
    name: `${DEMO} Reporting bot`,
    scopes: ["work:read", "work:write", "ai:execute", "analytics:read"],
    expiresAt: null,
  });
  await AgentModel.updateOne(
    { _id: reporting.agent._id },
    { $set: { createdAt: ago(120), lastSeenAt: ago(1) } },
  );
  const claude = await agentService.registerMcpClient(user, {
    clientName: "Claude Desktop",
    userAgent: "Claude-Desktop/1.4",
  });
  await AgentModel.updateOne(
    { _id: claude._id },
    { $set: { name: `${DEMO} Claude Desktop`, rateLimitPerMinute: 120 } },
  );
  const script = await agentService.registerDetected(user, {
    family: "python-requests",
    signals: ["automation_library"],
    userAgent: "python-requests/2.32.3",
  });
  await AgentModel.findOneAndUpdate(
    { workspaceId, kind: "ai_provider", fingerprint: "provider:openai" },
    {
      $setOnInsert: {
        workspaceId,
        ownerUserId: user._id,
        kind: "ai_provider",
        fingerprint: "provider:openai",
        name: "OpenAI",
        clientName: "openai",
        scopes: ["ai:execute"],
        projectIds: [],
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  // --- Policies ---
  for (const id of ["approve-destructive", "read-only-unregistered"]) {
    const template = POLICY_TEMPLATES.find((t) => t.id === id)!;
    await AgentPolicyModel.create({
      workspaceId,
      name: template.name,
      description: `${DEMO} ${template.description}`,
      effect: template.effect,
      mode: "enforce",
      priority: template.priority,
      enabled: true,
      match: template.match,
      createdBy: user._id,
    });
  }

  // --- Activity ---
  const activity = (
    agentId: Types.ObjectId,
    action: string,
    outcome: "allowed" | "blocked" | "pending_approval",
    daysAgo: number,
    projectId: string | null,
    extra: Record<string, unknown> = {},
  ) => ({
    agentId,
    workspaceId,
    projectId,
    userId: user._id,
    channel: "rest",
    action,
    domain: action.split(":")[0],
    risk: action.endsWith(":delete") ? "destructive" : "write",
    input: redactInput({ title: "Weekly status report" }),
    outcome,
    statusCode: outcome === "allowed" ? 200 : outcome === "blocked" ? 403 : 202,
    advisoryPolicies: [],
    createdAt: ago(daysAgo, 2),
    ...extra,
  });
  await AgentActivityModel.insertMany([
    activity(
      nightly.agent._id as Types.ObjectId,
      "task:create",
      "allowed",
      1,
      apollo,
    ),
    activity(
      nightly.agent._id as Types.ObjectId,
      "task:update",
      "allowed",
      2,
      apollo,
    ),
    activity(
      reporting.agent._id as Types.ObjectId,
      "task:update",
      "allowed",
      3,
      apollo,
    ),
    activity(
      reporting.agent._id as Types.ObjectId,
      "task:delete",
      "pending_approval",
      0,
      apollo,
      { policyName: "Approve destructive actions" },
    ),
    activity(
      script._id as Types.ObjectId,
      "project:create",
      "blocked",
      0,
      null,
      { policyName: "Unregistered agents are read-only" },
    ),
  ]);
  await AgentApprovalModel.create({
    workspaceId,
    projectId: apollo,
    agentId: reporting.agent._id,
    ownerUserId: user._id,
    channel: "rest",
    action: "task:delete",
    domain: "task",
    risk: "destructive",
    input: { taskId: new Types.ObjectId().toString() },
    inputPreview: { taskId: "[id]" },
    request: null,
    policyName: "Approve destructive actions",
    status: "pending",
    expiresAt: new Date(Date.now() + DAY),
  });
  await raiseAlert({
    workspaceId,
    agentId: reporting.agent._id.toString(),
    type: "bulk_destructive",
    severity: "warning",
    title: `${DEMO} Reporting bot deleted 14 tasks in 10 minutes`,
    detail: "Check the activity log; changes to tasks can be undone.",
    dedupeKey: `demo:bulk:${reporting.agent._id}`,
  });

  // --- A month of AI spend ---
  const today = new Date().getUTCDate();
  const logs = [];
  for (let d = 0; d < Math.min(today, 20); d += 1) {
    logs.push(
      {
        requestId: `demo_${d}_a`,
        workspaceId,
        projectId: apollo,
        userId: user._id,
        agentId: null,
        source: "project_ai",
        provider: "openai",
        modelName: "gpt-4o",
        inputTokens: 4000,
        outputTokens: 900,
        cachedTokens: 0,
        totalTokens: 4900,
        inputCost: 0.01,
        outputCost: 0.009,
        totalCost: 0.4 + (d % 5) * 0.15,
        latencyMs: 900,
        status: "success",
        createdAt: ago(d, 3),
      },
      {
        requestId: `demo_${d}_b`,
        workspaceId,
        projectId: gemini,
        userId: user._id,
        agentId: reporting.agent._id,
        source: "mcp",
        provider: "anthropic",
        modelName: "claude-3-5-sonnet",
        inputTokens: 2500,
        outputTokens: 600,
        cachedTokens: 0,
        totalTokens: 3100,
        inputCost: 0.0075,
        outputCost: 0.009,
        totalCost: 0.25 + (d % 3) * 0.2,
        latencyMs: 1200,
        status: d % 7 === 0 ? "error" : "success",
        createdAt: ago(d, 5),
      },
    );
  }
  await PromptExecutionLogModel.insertMany(logs);

  // --- SDK integration with AI traffic ---
  const existing = await SdkIntegrationModel.findOne({
    tenantId: userId,
    name: "Demo shop",
  });
  let sdkKey: string | null = null;
  let integrationId = existing?._id.toString();
  if (!integrationId) {
    const created = await sdkIntegrationService.create({
      tenantId: userId,
      name: "Demo shop",
      environment: "production",
      domain: "https://shop.example.com",
    });
    integrationId = created.integration._id.toString();
    sdkKey = created.rawKey;
  }
  await AnalyticsLogModel.deleteMany({ sdkIntegrationId: integrationId });
  const visitors: Array<[string, string, number]> = [
    [CHROME, "https://shop.example.com/", 40],
    [CHROME, "https://shop.example.com/pricing", 18],
    [
      `${CHROME}; ChatGPT-User/1.0; +https://openai.com/bot`,
      "https://shop.example.com/pricing",
      9,
    ],
    [
      "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
      "https://shop.example.com/docs",
      5,
    ],
    [`${CHROME} Perplexity-User/1.0`, "https://shop.example.com/docs/api", 3],
    [
      CHROME.replace("Chrome/", "HeadlessChrome/"),
      "https://shop.example.com/login",
      4,
    ],
    [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "https://shop.example.com/",
      6,
    ],
  ];
  let n = 0;
  const events = visitors.flatMap(([userAgent, url, count]) =>
    Array.from({ length: count }, () => ({
      eventId: `demo_${n++}`,
      eventName: "page",
      sessionId: `demo_s_${userAgent.length}_${Math.floor(n / 3)}`,
      properties: {},
      context: { userAgent, page: { url } },
    })),
  );
  for (let i = 0; i < events.length; i += 100) {
    await trackingService.ingestBatch(
      integrationId,
      events.slice(i, i + 100),
      integrationId,
    );
  }
  // Spread the visits over the last two weeks.
  const stored = await AnalyticsLogModel.find({
    sdkIntegrationId: integrationId,
  }).select("_id");
  await Promise.all(
    stored.map((doc, i) =>
      AnalyticsLogModel.updateOne(
        { _id: doc._id },
        { $set: { createdAt: ago(i % 14, i % 20) } },
      ),
    ),
  );

  for (const agent of await AgentModel.find({ workspaceId }))
    await recomputeRisk(agent);

  console.log(`
Demo data is ready.

  Portal:     ${process.env.FRONTEND_BASE_URL ?? "http://localhost:5173"}
  Email:      ${EMAIL}
  Password:   ${created ? PASSWORD : "unchanged (the account already existed)"}

  Agent Governance: 5 agents incl. an unregistered python-requests script,
  2 enforced policies, a held approval, alerts, ~3 weeks of AI spend.
  SDK integration "Demo shop": AI traffic from ChatGPT, Claude, Perplexity.
  Nightly sync key (shown once): ${nightly.key}${sdkKey ? `\n  Demo shop SDK key (shown once): ${sdkKey}` : ""}
`);
  await disconnectDatabase();
}

main()
  // Exit explicitly: queues opened by registration keep retrying Redis.
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
