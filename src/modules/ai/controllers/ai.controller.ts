import type { Response } from "express";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import aiService from "../services/ai/ai.service.js";
import projectService from "../../project/services/project.service.js";
import taskService from "../../task/services/task.service.js";
import TaskModel from "../../task/models/task.model.js";
import NoteModel from "../../note/models/note.model.js";
import EpicModel from "../../epic/models/epic.model.js";
import mongoose from "mongoose";
import DocumentModel from "../../document/models/document.model.js";
import TaskDependencyModel from "../../task/models/task-dependency.model.js";
import ProjectPlanModel from "../../project/models/project-plan.model.js";
import { AppError } from "../../../utils/app-error.js";
import workspaceService from "../../workspace/services/workspace.service.js";
import env from "../../../config/env.js";

async function assembleProjectKnowledge(projectId: string): Promise<string> {
  const [project, canonicalPlan, tasks, epics, docs, notes] = await Promise.all(
    [
      projectService.getProjectById(projectId),
      ProjectPlanModel.findOne({ projectId, status: "APPROVED" }).lean(),
      TaskModel.find({ projectId }).lean(),
      EpicModel.find({ projectId }).lean(),
      DocumentModel.find({ projectId }).lean(),
      NoteModel.find({ projectId }).lean(),
    ],
  );

  const states = (project as any)?.states ?? [];

  const taskSummary = tasks
    .map(
      (t: any) =>
        `- [${t.status}] ${t.title} (Priority: ${t.priority}, Est: ${t.estimatedHours || 8}h, Due: ${t.date || "N/A"})`,
    )
    .join("\n");

  const stateSummary =
    states.map((s: any) => s.name).join(" -> ") || "Default Workflow";
  const epicSummary = epics.map((e: any) => `- Epic: ${e.name}`).join("\n");
  const docSummary = docs
    .map((d: any) => `- Doc (${d.type}): ${d.title}`)
    .join("\n");
  const noteSummary = notes.map((n: any) => `- Note: ${n.title}`).join("\n");

  const planSummary = canonicalPlan
    ? `Canonical Plan Goal: ${canonicalPlan.systemGoal}
Modules: ${canonicalPlan.modules?.map((m: any) => m.name).join(", ")}
Planned Hours: ${canonicalPlan.timeline?.totalEngineeringHours || "N/A"}h`
    : "No canonical plan stored";

  return `Project Name: ${project?.name || "Project"}
Description: ${project?.description || ""}
${planSummary}

Workflow States: ${stateSummary}

Epics:
${epicSummary || "None"}

Tasks (${tasks.length} total):
${taskSummary || "No tasks yet"}

Documents:
${docSummary || "None"}

Notes:
${noteSummary || "None"}`;
}

export const listWorkspacePlans = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const workspaceId =
      typeof req.query.workspaceId === "string"
        ? req.query.workspaceId
        : undefined;

    const query: any = { createdBy: userId };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const plans = await ProjectPlanModel.find(query)
      .sort({ updatedAt: -1 })
      .lean();
    res.status(200).json({ plans });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

import ProjectModel from "../../project/models/project.model.js";
import UserModel from "../../auth/models/user.model.js";
import AiPlanningSessionModel from "../../ai-planner/models/ai-planning-session.model.js";
import AiPlanningMessageModel from "../../ai-planner/models/ai-planning-message.model.js";
import AiPlanningDraftModel from "../../ai-planner/models/ai-planning-draft.model.js";

export interface ResolvedAiConfig {
  apiKey: string;
  provider: "gemini" | "openai" | "anthropic";
  modelName: string;
  baseUrl?: string;
}

const resolveAiConfigForUserOrProject = async (
  req: AuthenticatedRequest,
  projectId?: string,
  overrides?: { provider?: string; modelName?: string; apiKey?: string },
): Promise<ResolvedAiConfig> => {
  let provider: "gemini" | "openai" | "anthropic" =
    (overrides?.provider as any) || "gemini";
  let modelName = overrides?.modelName || "gemini-3.6-flash";
  let baseUrl = "";
  let apiKey = overrides?.apiKey?.trim() || "";

  // 1. Check Project AI Config if projectId provided
  if (!apiKey && projectId) {
    const projectDoc = await projectService.getProjectById(projectId);
    const config = projectDoc?.ai;
    if (config) {
      if (!overrides?.provider && config.provider)
        provider = config.provider as any;
      if (!overrides?.modelName && config.modelName)
        modelName = config.modelName;
      if (config.baseUrl) baseUrl = config.baseUrl;
      if (config.apiKey && config.apiKey.trim()) {
        apiKey = config.apiKey.trim();
      }
    }
  }

  // 2. Resolve API Key from UserModel DB for selected provider
  if (!apiKey && req.user) {
    const userId = req.user._id
      ? req.user._id.toString()
      : (req.user as any).id;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      const userDoc = await UserModel.findById(userId).exec();
      if (userDoc) {
        if (provider === "openai" && userDoc.openaiApiKey) {
          apiKey = userDoc.openaiApiKey.trim();
        } else if (provider === "anthropic" && userDoc.anthropicApiKey) {
          apiKey = userDoc.anthropicApiKey.trim();
        } else if (userDoc.geminiApiKey) {
          apiKey = userDoc.geminiApiKey.trim();
        } else {
          apiKey = (
            userDoc.geminiApiKey ||
            userDoc.openaiApiKey ||
            userDoc.anthropicApiKey ||
            ""
          ).trim();
        }
      }
      // No per-project API key fallback (embedded ai.apiKey is empty string by default)
    }
  }

  // 3. Fallback to env key if database key is unconfigured
  if (!apiKey && env.GEMINI_API_KEY) {
    apiKey = env.GEMINI_API_KEY.trim();
  }

  if (!apiKey) {
    throw new AppError(
      400,
      `No AI API key found for provider '${provider}' in your database profile or project settings. Please save your API key in Profile/Settings.`,
      "MISSING_API_KEY",
    );
  }

  return { apiKey, provider, modelName, baseUrl };
};

const toAiOptions = (config: ResolvedAiConfig) => ({
  modelName: config.modelName,
  provider: config.provider,
  baseUrl: config.baseUrl,
});

/** Workspace whose deployed prompts apply to work done in a project. */
const getProjectWorkspaceId = async (
  projectId?: unknown,
): Promise<string | null> => {
  if (typeof projectId !== "string" || !projectId.trim()) {
    return null;
  }
  const project = await projectService.getProjectById(projectId);
  return project?.workspaceId ? String(project.workspaceId) : null;
};

export const generateProjectPlan = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const {
      prompt,
      context,
      sessionId,
      workspaceId,
      projectId,
      provider,
      modelName,
      apiKey,
    } = req.body;
    if (!prompt?.trim()) {
      throw new AppError(
        400,
        "Project requirements prompt is required",
        "BAD_REQUEST",
      );
    }

    const userId = req.user!._id.toString();
    const aiConfig = await resolveAiConfigForUserOrProject(req, projectId, {
      provider,
      modelName,
      apiKey,
    });

    const plan = await aiService.planProject(
      prompt,
      context,
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId, userId },
    );

    // Persist to session history if sessionId is provided
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      const session = await AiPlanningSessionModel.findOne({
        _id: sessionId,
        createdBy: userId,
      });
      if (session) {
        const targetWsId = session.workspaceId || workspaceId || null;

        await AiPlanningMessageModel.create({
          workspaceId: targetWsId,
          sessionId,
          role: "USER",
          content: prompt,
          createdBy: userId,
        });

        await AiPlanningMessageModel.create({
          workspaceId: targetWsId,
          sessionId,
          role: "ASSISTANT",
          content: `Generated complete technical implementation blueprint for **${plan.name}**. System goal: ${plan.systemGoal || plan.description}`,
          metadata: { plan },
          createdBy: userId,
        });

        await AiPlanningDraftModel.create({
          workspaceId: targetWsId,
          sessionId,
          requestedBy: userId,
          status: "REVIEW",
          plan,
        });

        session.title = plan.name || session.title;
        session.lastMessageAt = new Date();
        await session.save();
      }
    }

    res.status(200).json({ plan });
  } catch (error: any) {
    const status = error.status || error.statusCode || 500;
    res.status(status).json({
      error: error.message || "An error occurred during AI plan generation",
    });
  }
};

export const modifyProjectPlan = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const {
      existingPlan,
      changeRequest,
      sessionId,
      workspaceId,
      projectId,
      provider,
      modelName,
      apiKey,
    } = req.body;
    if (!existingPlan || !changeRequest?.trim()) {
      throw new AppError(
        400,
        "existingPlan and changeRequest are required",
        "BAD_REQUEST",
      );
    }

    const userId = req.user!._id.toString();
    const aiConfig = await resolveAiConfigForUserOrProject(req, projectId, {
      provider,
      modelName,
      apiKey,
    });

    const result = await aiService.modifyProjectPlan(
      existingPlan,
      changeRequest,
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId, userId },
    );

    // Persist change request to session history
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      const session = await AiPlanningSessionModel.findOne({
        _id: sessionId,
        createdBy: userId,
      });
      if (session) {
        const targetWsId = session.workspaceId || workspaceId || null;

        await AiPlanningMessageModel.create({
          workspaceId: targetWsId,
          sessionId,
          role: "USER",
          content: `Change Request: ${changeRequest}`,
          createdBy: userId,
        });

        await AiPlanningMessageModel.create({
          workspaceId: targetWsId,
          sessionId,
          role: "ASSISTANT",
          content: `Plan updated cleanly: ${result.delta.summary}`,
          metadata: { plan: result.updatedPlan, delta: result.delta },
          createdBy: userId,
        });

        await AiPlanningDraftModel.create({
          workspaceId: targetWsId,
          sessionId,
          requestedBy: userId,
          status: "REVIEW",
          plan: result.updatedPlan,
        });

        session.lastMessageAt = new Date();
        await session.save();
      }
    }

    res.status(200).json(result);
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const confirmProjectPlan = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { workspaceId, plan } = req.body;

    if (!plan || !plan.name) {
      throw new AppError(
        400,
        "Valid project plan object is required",
        "BAD_REQUEST",
      );
    }

    // Resolve or get default workspace
    let targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId) {
      const defaultWs =
        await workspaceService.getOrCreateDefaultWorkspace(userId);
      targetWorkspaceId = defaultWs._id.toString();
    } else {
      await workspaceService.assertMembership(userId, targetWorkspaceId);
    }

    // Create Project
    const project = await projectService.createProject(userId, {
      name: plan.name,
      description: plan.description || "",
      workspaceId: targetWorkspaceId,
    });

    const projectId = project.id;
    const projectDoc = await projectService.getProjectById(projectId);
    const resolvedProjectId = projectDoc
      ? projectDoc._id.toString()
      : projectId;

    // Persist Canonical Approved Plan
    const totalEstHours =
      plan.timeline?.totalEngineeringHours ||
      (plan.tasks || []).reduce(
        (sum: number, t: any) => sum + (t.estimatedHours || 8),
        0,
      );

    const canonicalPlanDoc = await ProjectPlanModel.create({
      projectId: resolvedProjectId,
      workspaceId: targetWorkspaceId,
      version: 1,
      status: "APPROVED",
      systemGoal: plan.systemGoal || plan.description || plan.name,
      coreWorkflow: plan.coreWorkflow || [],
      actors: plan.actors || [],
      modules: plan.modules || [],
      dependencies: plan.dependencies || [],
      risks: plan.risks || [],
      timeline: plan.timeline || {
        totalEngineeringHours: totalEstHours,
        totalEngineeringDays: Math.ceil(totalEstHours / 8),
        estimatedCalendarWeeks: Math.ceil(totalEstHours / 40),
        confidence: "HIGH",
        assumptions: [],
        milestones: [],
      },
      approvedAt: new Date(),
      createdBy: userId,
    });

    // Create Custom Project States (embedded into Project.states)
    const stateMap = new Map<number, string>();
    const statesToEmbed: any[] = [];
    if (
      Array.isArray(plan.suggestedStates) &&
      plan.suggestedStates.length > 0
    ) {
      for (let i = 0; i < plan.suggestedStates.length; i++) {
        const st = plan.suggestedStates[i];
        statesToEmbed.push({
          name: st.name,
          color: st.color || "#3B82F6",
          category: st.category || "STARTED",
          position: i,
          isDefault: i === 0,
        });
      }
    } else {
      const defaults = [
        { name: "Backlog", category: "BACKLOG", color: "#9CA3AF", pos: 0 },
        { name: "In Progress", category: "STARTED", color: "#3B82F6", pos: 1 },
        { name: "Review", category: "STARTED", color: "#8B5CF6", pos: 2 },
        { name: "Done", category: "COMPLETED", color: "#10B981", pos: 3 },
      ];
      for (const d of defaults) {
        statesToEmbed.push({
          name: d.name,
          color: d.color,
          category: d.category as any,
          position: d.pos,
          isDefault: d.pos === 0,
        });
      }
    }
    if (statesToEmbed.length > 0) {
      const updatedProj = await ProjectModel.findByIdAndUpdate(
        resolvedProjectId,
        { $push: { states: { $each: statesToEmbed } } },
        { new: true },
      ).lean();
      (updatedProj?.states ?? []).forEach((s: any, idx: number) => {
        stateMap.set(idx, s._id?.toString() ?? "");
      });
    }

    // Create Epics
    const epicMap = new Map<number, string>();
    if (Array.isArray(plan.epics)) {
      for (let i = 0; i < plan.epics.length; i++) {
        const ep = plan.epics[i];
        const createdEpic = await EpicModel.create({
          projectId: resolvedProjectId,
          name: ep.name,
          description: ep.description || "",
          order: i,
        });
        epicMap.set(i, createdEpic._id.toString());
      }
    }

    // Create Tasks
    const taskMap = new Map<number, string>();
    if (Array.isArray(plan.tasks)) {
      const today = new Date().toISOString().split("T")[0];
      for (let i = 0; i < plan.tasks.length; i++) {
        const t = plan.tasks[i];
        const epicId =
          t.epicIndex !== undefined ? epicMap.get(t.epicIndex) : undefined;

        const createdTask = await taskService.createTask({
          userId,
          assignedTo: userId,
          title: t.title,
          description: t.description || "",
          date: today,
          priority: t.priority || "MEDIUM",
          source: "ai-plan",
          projectId,
          epicId,
          subtasks: (t.subtasks || []).map((st: any) => ({
            title: st.title,
            note: st.description || "",
            status: "TODO",
            completed: false,
          })),
        });
        taskMap.set(i, createdTask.id);
      }
    }

    // Create Dependencies
    if (Array.isArray(plan.dependencies)) {
      for (const dep of plan.dependencies) {
        const tId = taskMap.get(dep.taskIndex);
        const depId = taskMap.get(dep.dependsOnTaskIndex);
        if (tId && depId) {
          await TaskDependencyModel.create({
            projectId: resolvedProjectId,
            taskId: tId,
            dependsOnTaskId: depId,
            type: dep.type || "BLOCKS",
          });
        }
      }
    }

    // Auto-generate Canonical PRD Document
    const prdContent = `# ${plan.name} — System Architecture & Product Requirements Document

## System Goal
${plan.systemGoal || plan.description}

## Core Workflow
${(plan.coreWorkflow || []).map((step: string, idx: number) => `${idx + 1}. ${step}`).join("\n")}

## System Actors & Roles
${(plan.actors || []).map((a: any) => `- **${a.name}** (${a.type}): ${a.responsibilities?.join(", ")}`).join("\n")}

## System Modules & Feature Specs
${(plan.modules || [])
  .map(
    (m: any) => `### ${m.name}
*${m.purpose}*

${(m.features || [])
  .map(
    (f: any) => `#### ${f.name}
${f.description}
- **Acceptance Criteria**: ${(f.acceptanceCriteria || []).join("; ")}
- **Est. Effort**: ${f.estimatedHours || 8}h`,
  )
  .join("\n\n")}`,
  )
  .join("\n\n")}

## Risks & Mitigations
${(plan.risks || []).map((r: any) => `- [${r.severity}] **${r.title}**: ${r.mitigation}`).join("\n")}
`;

    await DocumentModel.create({
      projectId: resolvedProjectId,
      workspaceId: targetWorkspaceId,
      title: `${plan.name} - Architecture & PRD Spec`,
      type: "PRD",
      content: prdContent,
      authorId: userId,
      tags: ["prd", "canonical-spec", "ai-generated"],
      version: 1,
      aiGenerated: true,
    });

    res.status(201).json({
      message:
        "Project plan confirmed, materialized, and persisted successfully",
      project,
      canonicalPlanId: canonicalPlanDoc._id,
    });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const decomposeTask = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { taskId, title, description, projectContext } = req.body;
    const userId = req.user!._id.toString();
    let taskTitle = title;
    let taskDesc = description;
    let projectId: string | undefined =
      typeof req.body.projectId === "string" ? req.body.projectId : undefined;

    if (taskId) {
      const task = await TaskModel.findById(taskId).lean();
      if (task) {
        taskTitle = task.title;
        taskDesc = task.description;
        if (task.projectId) projectId = String(task.projectId);
      }
    }

    if (!taskTitle?.trim()) {
      throw new AppError(400, "Task title is required", "BAD_REQUEST");
    }

    const aiConfig = await resolveAiConfigForUserOrProject(req, projectId);
    const breakdown = await aiService.decomposeTask(
      taskTitle,
      taskDesc,
      projectContext,
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId: await getProjectWorkspaceId(projectId), userId },
    );
    res.status(200).json({ breakdown });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const planDailyWork = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const tasks = await TaskModel.find({
      $or: [{ userId }, { assignedTo: userId }],
      status: { $ne: "DONE" },
    })
      .sort({ priority: -1, date: 1 })
      .lean();

    const taskSummaryList = tasks.map((t) => ({
      id: t._id.toString(),
      title: t.title,
      priority: t.priority,
      dueDate: t.date,
      isBlocked: t.isBlocked,
    }));

    const aiConfig = await resolveAiConfigForUserOrProject(req);
    const schedule = await aiService.planDailyWork(
      taskSummaryList,
      req.body.workloadContext,
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId: req.body.workspaceId, userId },
    );
    res.status(200).json({ schedule });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const generateDocument = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { projectId, docType, title } = req.body;
    if (!projectId || !docType || !title) {
      throw new AppError(
        400,
        "projectId, docType, and title are required",
        "BAD_REQUEST",
      );
    }

    const userId = req.user!._id.toString();
    await projectService.assertProjectMembership(userId, projectId);

    const projectKnowledge = await assembleProjectKnowledge(projectId);
    const aiConfig = await resolveAiConfigForUserOrProject(req, projectId);
    const draft = await aiService.generateDocument(
      docType,
      title,
      projectKnowledge,
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId: await getProjectWorkspaceId(projectId), userId },
    );

    res.status(200).json({ draft });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const generateNotes = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { projectId, transcript } = req.body;
    if (!transcript?.trim()) {
      throw new AppError(
        400,
        "Meeting transcript or notes content is required",
        "BAD_REQUEST",
      );
    }

    const userId = req.user!._id.toString();
    let knowledge = "N/A";
    if (projectId) {
      await projectService.assertProjectMembership(userId, projectId);
      knowledge = await assembleProjectKnowledge(projectId);
    }

    const aiConfig = await resolveAiConfigForUserOrProject(req, projectId);
    const notesDraft = await aiService.generateMeetingNotes(
      transcript,
      knowledge,
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId: await getProjectWorkspaceId(projectId), userId },
    );
    res.status(200).json({ notesDraft });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const chatWithProjectAssistant = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { projectId, message, chatHistory } = req.body;
    if (!projectId || !message?.trim()) {
      throw new AppError(
        400,
        "projectId and message are required",
        "BAD_REQUEST",
      );
    }

    const userId = req.user!._id.toString();
    await projectService.assertProjectMembership(userId, projectId);

    const knowledge = await assembleProjectKnowledge(projectId);
    const aiConfig = await resolveAiConfigForUserOrProject(req, projectId);
    const reply = await aiService.chatAssistant(
      message,
      knowledge,
      chatHistory || [],
      aiConfig.apiKey,
      toAiOptions(aiConfig),
      { workspaceId: await getProjectWorkspaceId(projectId), userId },
    );

    res.status(200).json({ reply });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};
