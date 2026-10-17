import AiPlanningDraftModel, {
  type IAiPlanningDraftDocument,
  type IAiPlanningPlan,
} from "../../../modules/ai-planner/models/ai-planning-draft.model.js";
import AiPlanningMessageModel from "../models/ai-planning-message.model.js";
import AiPlanningSessionModel from "../models/ai-planning-session.model.js";
import ProjectModel from "../../project/models/project.model.js";
import EpicModel from "../../epic/models/epic.model.js";
import NoteModel from "../../note/models/note.model.js";
import TaskModel from "../../task/models/task.model.js";
import UserModel from "../../auth/models/user.model.js";
import logger from "../../../lib/logger.js";
import { buildSafeRefMatch } from "../../../utils/mongo-ref.js";
import activityLogService from "../../audit/services/activity-log.service.js";
import epicService from "../../epic/services/epic.service.js";
import noteService from "../../note/services/note.service.js";
import projectService from "../../project/services/project.service.js";
import taskService from "../../task/services/task.service.js";
import workspaceService from "../../workspace/services/workspace.service.js";
import env from "../../../config/env.js";
import promptResolverService from "../../prompt/services/prompt-resolver.service.js";
import mongoose from "mongoose";

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class AiPlanningService {
  public async getContext(userId: string, projectId: string) {
    const access = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = access.project._id.toString();
    const [milestones, tasks, notes, team] = await Promise.all([
      EpicModel.find(buildSafeRefMatch("projectId", resolvedProjectId))
        .sort({ order: 1, _id: 1 })
        .lean(),
      TaskModel.find(buildSafeRefMatch("projectId", resolvedProjectId))
        .sort({ date: 1, order: 1, _id: 1 })
        .lean(),
      NoteModel.find(buildSafeRefMatch("projectId", resolvedProjectId))
        .sort({ updatedAt: -1, _id: -1 })
        .lean(),
      projectService.fetchProjectMembers(userId, resolvedProjectId),
    ]);

    return {
      project: {
        id: access.project.uuid || access.project._id.toString(),
        name: access.project.name,
        description: access.project.description ?? "",
        workspaceId: access.project.workspaceId
          ? String(access.project.workspaceId)
          : null,
        currentUserRole: access.role,
      },
      milestones: milestones.map((milestone) => ({
        id: milestone._id.toString(),
        name: milestone.name,
        description: milestone.description ?? "",
        status: milestone.status ?? "planned",
        order: milestone.order,
      })),
      tasks: tasks.map((task) => ({
        id: task._id.toString(),
        title: task.title,
        description: task.description ?? "",
        status: task.status,
        priority: task.priority,
        date: task.date,
        epicId: task.epicId?.toString() ?? null,
        subtasks: (task.subtasks ?? []).map((subtask) => ({
          id: subtask._id?.toString() ?? "",
          title: subtask.title,
          description: subtask.description ?? "",
          status: subtask.status,
        })),
      })),
      notes: notes.map((note) => ({
        id: note._id.toString(),
        title: note.title,
        content: note.content,
        parentType: note.parentType,
      })),
      team: team.map((member) => ({
        userId: member.userId,
        role: member.role,
        name: member.user.name,
        email: member.user.email,
      })),
    };
  }

  public async listSessions(userId: string, projectId: string) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const sessions = await AiPlanningSessionModel.find(
      buildSafeRefMatch("projectId", resolvedProjectId),
    )
      .sort({ updatedAt: -1, _id: -1 })
      .lean();

    return sessions.map((session) => this.toSessionDto(session));
  }

  public async createSession(
    userId: string,
    projectId: string,
    payload: { title?: unknown },
  ) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const title =
      typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim().slice(0, 120)
        : "Planning conversation";
    const session = await AiPlanningSessionModel.create({
      projectId: resolvedProjectId,
      createdBy: userId,
      title,
      status: "ACTIVE",
    });

    return this.toSessionDto(session);
  }

  public async getSession(
    userId: string,
    projectId: string,
    sessionId: string,
  ) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const session = await this.requireSession(resolvedProjectId, sessionId);
    const [messages, drafts] = await Promise.all([
      AiPlanningMessageModel.find(buildSafeRefMatch("sessionId", sessionId))
        .sort({ createdAt: 1, _id: 1 })
        .lean(),
      AiPlanningDraftModel.find(buildSafeRefMatch("sessionId", sessionId))
        .sort({ createdAt: -1, _id: -1 })
        .lean(),
    ]);

    return {
      session: this.toSessionDto(session),
      messages: messages.map((message) => this.toMessageDto(message)),
      drafts: drafts.map((draft) => this.toDraftDto(draft)),
    };
  }

  public async sendMessage(
    userId: string,
    projectId: string,
    sessionId: string,
    payload: { content?: unknown },
  ) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    await this.requireSession(resolvedProjectId, sessionId);
    const content = this.requiredText(payload.content, "Message", 8000);

    const userMessage = await AiPlanningMessageModel.create({
      projectId: resolvedProjectId,
      sessionId,
      role: "USER",
      content,
      createdBy: userId,
    });
    await AiPlanningSessionModel.findByIdAndUpdate(sessionId, {
      updatedAt: new Date(),
    }).exec();

    const context = await this.getContext(userId, resolvedProjectId);
    const history = await AiPlanningMessageModel.find(
      buildSafeRefMatch("sessionId", sessionId),
    )
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    const config = project.ai ?? null;
    const assistantContent = await this.generateAssistantReply(
      userId,
      resolvedProjectId,
      config,
      context,
      history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );
    const assistantMessage = await AiPlanningMessageModel.create({
      projectId: resolvedProjectId,
      sessionId,
      role: "ASSISTANT",
      content: assistantContent,
      metadata: {
        source:
          config && config.enabled ? `provider-${config.provider}` : "fallback",
      },
    });

    return {
      userMessage: this.toMessageDto(userMessage),
      assistantMessage: this.toMessageDto(assistantMessage),
    };
  }

  public async createDraft(
    userId: string,
    projectId: string,
    sessionId: string,
  ) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    await this.requireSession(resolvedProjectId, sessionId);
    const history = await AiPlanningMessageModel.find({
      ...buildSafeRefMatch("sessionId", sessionId),
      role: "USER",
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    if (history.length === 0) {
      throw new HttpError(
        400,
        "Add at least one requirement message before generating a draft",
      );
    }

    const context = await this.getContext(userId, resolvedProjectId);
    const config = project.ai ?? null;
    const plan = await this.generatePlan(
      userId,
      resolvedProjectId,
      config,
      context,
      history.map((message) => message.content),
    );
    const draft = await AiPlanningDraftModel.create({
      projectId: resolvedProjectId,
      sessionId,
      requestedBy: userId,
      status: "REVIEW",
      plan,
    });

    await this.logProjectEvent(
      userId,
      resolvedProjectId,
      "created",
      "generated AI planning draft",
      {
        aiPlanning: true,
        event: "draft_generated",
        draftId: draft._id.toString(),
        sessionId,
      },
    );

    return this.toDraftDto(draft);
  }

  public async rejectDraft(
    userId: string,
    projectId: string,
    draftId: string,
    payload: { reason?: unknown },
  ) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = project._id.toString();
    const draft = await AiPlanningDraftModel.findOneAndUpdate(
      {
        _id: draftId,
        ...buildSafeRefMatch("projectId", resolvedProjectId),
        status: "REVIEW",
      },
      {
        status: "REJECTED",
        rejectedBy: userId,
        rejectionReason:
          typeof payload.reason === "string" ? payload.reason.trim() : "",
      },
      { new: true },
    ).exec();

    if (!draft) {
      throw new HttpError(409, "Draft is not available for rejection");
    }

    await this.logProjectEvent(
      userId,
      resolvedProjectId,
      "rejected",
      "rejected AI planning draft",
      {
        aiPlanning: true,
        event: "draft_rejected",
        draftId,
      },
    );

    return this.toDraftDto(draft);
  }

  public async approveDraft(
    userId: string,
    projectId: string,
    draftId: string,
  ) {
    const { project } = await projectService.assertProjectRole(
      userId,
      projectId,
      "ADMIN",
    );
    const resolvedProjectId = project._id.toString();
    const draft = await AiPlanningDraftModel.findOneAndUpdate(
      {
        _id: draftId,
        ...buildSafeRefMatch("projectId", resolvedProjectId),
        status: "REVIEW",
      },
      { status: "EXECUTING", approvedBy: userId },
      { new: true },
    ).exec();

    if (!draft) {
      throw new HttpError(409, "Draft is not available for approval");
    }

    try {
      const artifacts = await this.executePlan(
        userId,
        resolvedProjectId,
        draft,
      );
      draft.status = "EXECUTED";
      draft.artifacts = artifacts;
      draft.executedAt = new Date();
      await draft.save();
      await this.logProjectEvent(
        userId,
        resolvedProjectId,
        "approved",
        "approved and executed AI planning draft",
        {
          aiPlanning: true,
          event: "draft_executed",
          draftId,
          artifacts,
        },
      );
      return this.toDraftDto(draft);
    } catch (error) {
      draft.status = "FAILED";
      draft.failureReason =
        error instanceof Error ? error.message : "Draft execution failed";
      await draft.save();
      await this.logProjectEvent(
        userId,
        resolvedProjectId,
        "updated",
        "AI planning draft execution failed",
        {
          aiPlanning: true,
          event: "draft_execution_failed",
          draftId,
          failureReason: draft.failureReason,
        },
      );
      throw error;
    }
  }

  private async executePlan(
    userId: string,
    projectId: string,
    draft: IAiPlanningDraftDocument,
  ) {
    const draftId = draft._id.toString();
    const note = await noteService.createNote(userId, projectId, {
      title: `${draft.plan.documentationTitle} (${draftId.slice(-6)})`,
      content: draft.plan.documentation,
    });
    await this.logArtifactCreated(
      userId,
      projectId,
      "note",
      note.id,
      note.title,
      draftId,
    );

    const epicIds: string[] = [];
    for (const milestone of draft.plan.milestones) {
      const epic = await epicService.createEpic(userId, projectId, {
        name: milestone.name,
        description: milestone.description,
        status: "planned",
      });
      epicIds.push(epic.id);
      await this.logArtifactCreated(
        userId,
        projectId,
        "epic",
        epic.id,
        epic.name,
        draftId,
      );
    }

    const taskIds: string[] = [];
    for (const task of draft.plan.tasks) {
      const epicId = epicIds[task.milestoneIndex] ?? epicIds[0] ?? null;
      const created = await taskService.createTask({
        userId,
        assignedTo: userId,
        title: task.title,
        description: task.description,
        date: task.date,
        priority: task.priority,
        source: "ai-planning",
        projectId,
        epicId,
        subtasks: task.subtasks.map((subtask) => ({
          title: subtask.title,
          note: subtask.description ?? "",
          status: "TODO",
          completed: false,
        })),
      });
      taskIds.push(created.id);
      await this.logArtifactCreated(
        userId,
        projectId,
        "task",
        created.id,
        created.title,
        draftId,
      );
    }

    return { noteId: note.id, epicIds, taskIds };
  }

  private async logArtifactCreated(
    userId: string,
    projectId: string,
    entityType: "note" | "epic" | "task",
    entityId: string,
    entityName: string,
    draftId: string,
  ) {
    await activityLogService.logActivity({
      projectId,
      entityType,
      entityId,
      entityName,
      action: "created",
      userId,
      userName: await this.getUserName(userId),
      description: `AI planning created ${entityType} "${entityName}"`,
      metadata: { aiPlanning: true, draftId },
    });
  }

  private async logProjectEvent(
    userId: string,
    projectId: string,
    action: "created" | "updated" | "approved" | "rejected",
    description: string,
    metadata: Record<string, unknown>,
  ) {
    await activityLogService.logActivity({
      projectId,
      entityType: "project",
      entityId: projectId,
      action,
      userId,
      userName: await this.getUserName(userId),
      description,
      metadata,
    });
  }

  private async getUserName(userId: string): Promise<string> {
    const user = await UserModel.findById(userId)
      .select("name firstName lastName")
      .lean();
    return (
      user?.name ||
      [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
      "Unknown"
    );
  }

  public async getSettings(userId: string, projectId: string) {
    const { project } = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const config = project?.ai ?? null;

    const user = await UserModel.findById(userId).exec();
    const provider = config?.provider || "gemini";
    let hasGlobalKey = false;
    if (user) {
      if (provider === "openai") hasGlobalKey = !!user.openaiApiKey;
      if (provider === "anthropic") hasGlobalKey = !!user.anthropicApiKey;
      if (provider === "gemini") hasGlobalKey = !!user.geminiApiKey;
    }

    if (!config || !config.enabled) {
      return {
        enabled: false,
        provider: config?.provider ?? "gemini",
        apiKey: hasGlobalKey ? "••••••••" : "",
        baseUrl: config?.baseUrl ?? "",
        modelName: config?.modelName ?? "Gemini 3.6 Flash",
      };
    }
    return {
      enabled: config.enabled,
      provider: config.provider,
      apiKey: hasGlobalKey ? "••••••••" : "",
      baseUrl: config.baseUrl || "",
      modelName: config.modelName,
    };
  }

  public async updateSettings(userId: string, projectId: string, payload: any) {
    const { project } = await projectService.assertProjectRole(
      userId,
      projectId,
      "ADMIN",
    );
    const resolvedProjectId = project._id.toString();

    const enabled = !!payload.enabled;
    const provider = payload.provider || "gemini";
    const baseUrl =
      typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
    const modelName =
      typeof payload.modelName === "string"
        ? payload.modelName.trim()
        : "Gemini 3.6 Flash";

    if (enabled) {
      const supportedProviders = ["openai", "anthropic", "gemini"];
      if (!supportedProviders.includes(provider)) {
        throw new Error(`Unsupported AI provider: ${provider}`);
      }
      const user = await UserModel.findById(userId).exec();
      const hasGlobalKey =
        user &&
        ((provider === "openai" && user.openaiApiKey) ||
          (provider === "anthropic" && user.anthropicApiKey) ||
          (provider === "gemini" && user.geminiApiKey));
      if (!hasGlobalKey) {
        throw new Error(
          "No global API Key configured for this provider. Please set your API Key in your profile settings.",
        );
      }
    }

    const oldAi = project.ai;

    const updatedProject = await ProjectModel.findByIdAndUpdate(
      resolvedProjectId,
      {
        $set: {
          "ai.enabled": enabled,
          "ai.provider": provider,
          "ai.apiKey": "",
          "ai.baseUrl": baseUrl,
          "ai.modelName": modelName,
        },
      },
      { new: true },
    ).lean();

    // Activity log events
    if (!oldAi?.enabled && enabled) {
      await this.logProjectEvent(
        userId,
        resolvedProjectId,
        "updated",
        "AI Enabled",
        {
          provider,
          modelName,
        },
      );
    } else if (oldAi?.enabled && !enabled) {
      await this.logProjectEvent(
        userId,
        resolvedProjectId,
        "updated",
        "AI Disabled",
        {
          provider,
          modelName,
        },
      );
    }
    if (oldAi?.provider && oldAi.provider !== provider) {
      await this.logProjectEvent(
        userId,
        resolvedProjectId,
        "updated",
        "Provider Changed",
        { oldProvider: oldAi.provider, newProvider: provider },
      );
    }
    if (oldAi?.modelName && oldAi.modelName !== modelName) {
      await this.logProjectEvent(
        userId,
        resolvedProjectId,
        "updated",
        "Model Changed",
        { oldModelName: oldAi.modelName, newModelName: modelName },
      );
    }

    const user = await UserModel.findById(userId).exec();
    let hasGlobalKey = false;
    if (user) {
      if (provider === "openai") hasGlobalKey = !!user.openaiApiKey;
      if (provider === "anthropic") hasGlobalKey = !!user.anthropicApiKey;
      if (provider === "gemini") hasGlobalKey = !!user.geminiApiKey;
    }

    const savedAi = updatedProject?.ai;
    return {
      enabled: savedAi?.enabled ?? enabled,
      provider: savedAi?.provider ?? provider,
      apiKey: hasGlobalKey ? "••••••••" : "",
      baseUrl: savedAi?.baseUrl ?? baseUrl,
      modelName: savedAi?.modelName ?? modelName,
    };
  }

  public async testConnection(userId: string, projectId: string, payload: any) {
    await projectService.assertProjectRole(userId, projectId, "ADMIN");

    const provider = payload.provider || "gemini";
    const baseUrl =
      typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
    const modelName =
      typeof payload.modelName === "string"
        ? payload.modelName.trim()
        : "Gemini 3.6 Flash";

    let apiKey = payload.apiKey;
    if (!apiKey || apiKey === "••••••••") {
      const user = await UserModel.findById(userId).exec();
      if (user) {
        if (provider === "openai") apiKey = user.openaiApiKey;
        if (provider === "anthropic") apiKey = user.anthropicApiKey;
        if (provider === "gemini")
          apiKey = user?.geminiApiKey || env.GEMINI_API_KEY;
      }
    }
    if (!apiKey && provider === "gemini") {
      apiKey = env.GEMINI_API_KEY;
    }

    const supportedProviders = ["openai", "anthropic", "gemini"];
    if (!supportedProviders.includes(provider)) {
      return { success: false, error: "Configuration Invalid" };
    }

    if (!apiKey) {
      return { success: false, error: "Configuration Invalid" };
    }

    const config = {
      enabled: true,
      provider,
      apiKey,
      baseUrl,
      modelName,
    };

    try {
      const testResponse = await this.executeProviderRequest(config, [
        { role: "user", content: "Say 'success' only." },
      ]);
      if (!testResponse) {
        await this.logProjectEvent(
          userId,
          projectId,
          "updated",
          "Connection Tested",
          { success: false, error: "Provider Unreachable" },
        );
        return { success: false, error: "Provider Unreachable" };
      }

      await this.logProjectEvent(
        userId,
        projectId,
        "updated",
        "Connection Tested",
        { success: true },
      );
      return { success: true, message: "Connected" };
    } catch (error: any) {
      const msg = error.message || "";
      let errorStatus = "Provider Unreachable";

      if (
        msg.includes("401") ||
        msg.toLowerCase().includes("invalid api key") ||
        msg.toLowerCase().includes("unauthorized")
      ) {
        errorStatus = "Invalid API Key";
      } else if (
        msg.includes("404") ||
        msg.toLowerCase().includes("model") ||
        msg.toLowerCase().includes("not found")
      ) {
        errorStatus = "Model Not Available";
      } else if (
        msg.includes("429") ||
        msg.toLowerCase().includes("rate limit") ||
        msg.toLowerCase().includes("quota")
      ) {
        errorStatus = "Rate Limit Exceeded";
      }

      await this.logProjectEvent(
        userId,
        projectId,
        "updated",
        "Connection Tested",
        { success: false, error: errorStatus },
      );
      return { success: false, error: errorStatus };
    }
  }

  private async executeProviderRequest(
    config: {
      provider: string;
      apiKey?: string;
      baseUrl?: string;
      modelName: string;
    },
    messages: Array<{ role: string; content: string }>,
  ): Promise<string | null> {
    const provider = config.provider;
    const apiKey = config.apiKey;
    const model = config.modelName;
    let url = config.baseUrl ? config.baseUrl.trim() : "";
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    let body: any = {};

    if (provider === "openai") {
      if (!url) url = "https://api.openai.com/v1";
      url = `${url.replace(/\/$/, "")}/chat/completions`;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      body = { model, messages, temperature: 0.2 };
    } else if (provider === "gemini") {
      if (!url) url = "https://generativelanguage.googleapis.com/v1beta/openai";
      url = `${url.replace(/\/$/, "")}/chat/completions${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
        headers["x-goog-api-key"] = apiKey;
      }
      let sanitizedModel = "gemini-3.6-flash";
      body = { model: sanitizedModel, messages, temperature: 0.2 };
    } else if (provider === "anthropic") {
      if (!url) url = "https://api.anthropic.com/v1";
      url = `${url.replace(/\/$/, "")}/messages`;
      if (apiKey) {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      }
      const systemMessages = messages.filter((m) => m.role === "system");
      const system = systemMessages.map((m) => m.content).join("\n\n");
      const anthropicMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role:
            m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        }));

      body = {
        model,
        messages: anthropicMessages,
        max_tokens: 4000,
        temperature: 0.2,
      };
      if (system) {
        body.system = system;
      }
    } else if (provider === "openrouter") {
      if (!url) url = "https://openrouter.ai/api/v1";
      url = `${url.replace(/\/$/, "")}/chat/completions`;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      body = { model, messages, temperature: 0.2 };
    } else if (provider === "groq") {
      if (!url) url = "https://api.groq.com/openai/v1";
      url = `${url.replace(/\/$/, "")}/chat/completions`;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      body = { model, messages, temperature: 0.2 };
    } else if (provider === "ollama") {
      if (!url) url = "http://localhost:11434/v1";
      url = `${url.replace(/\/$/, "")}/chat/completions`;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      body = { model, messages, temperature: 0.2 };
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `AI provider request failed with status ${response.status}: ${errorText || response.statusText}`,
      );
    }

    const resBody = (await response.json()) as any;
    let content = "";
    if (provider === "anthropic") {
      content = resBody.content?.[0]?.text || "";
    } else {
      content = resBody.choices?.[0]?.message?.content || "";
    }

    return content.trim() ? content.trim() : null;
  }

  private cleanAndParseJson(raw: string): any {
    let cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      logger.warn("JSON parse failed, attempting auto-repair...", err as Error);
      cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
      try {
        return JSON.parse(cleaned);
      } catch (innerErr) {
        throw new Error(`JSON parsing failed: ${(innerErr as Error).message}`);
      }
    }
  }

  private async generateAssistantReply(
    userId: string,
    projectId: string,
    config: any,
    context: Awaited<ReturnType<AiPlanningService["getContext"]>>,
    history: Array<{ role: string; content: string }>,
  ): Promise<string> {
    if (config && config.enabled) {
      try {
        let apiKey = config.apiKey;
        if (!apiKey) {
          const user = await UserModel.findById(userId).exec();
          if (user) {
            if (config.provider === "openai") apiKey = user.openaiApiKey;
            if (config.provider === "anthropic") apiKey = user.anthropicApiKey;
            if (config.provider === "gemini")
              apiKey = user.geminiApiKey || env.GEMINI_API_KEY;
          }
        }
        if (!apiKey && config.provider === "gemini") {
          apiKey = env.GEMINI_API_KEY;
        }

        const { content: systemPrompt } = await promptResolverService.resolve(
          "planning-assistant",
          { workspaceId: context.project.workspaceId, userId },
          {
            project_name: context.project.name,
            project_description: context.project.description,
            existing_milestones: JSON.stringify(context.milestones),
            existing_tasks: JSON.stringify(
              context.tasks.map((t) => ({
                title: t.title,
                status: t.status,
                epicId: t.epicId,
              })),
            ),
            existing_notes: JSON.stringify(
              context.notes.map((n) => ({ title: n.title })),
            ),
            team_members: JSON.stringify(
              context.team.map((t) => ({ name: t.name, role: t.role })),
            ),
          },
        );

        const messages = [
          { role: "system", content: systemPrompt },
          ...history.map((message) => ({
            role:
              message.role === "ASSISTANT"
                ? ("assistant" as const)
                : ("user" as const),
            content: message.content,
          })),
        ];

        const providerReply = await this.executeProviderRequest(
          {
            provider: config.provider,
            apiKey,
            baseUrl: config.baseUrl,
            modelName: config.modelName,
          },
          messages,
        );
        if (providerReply) {
          return providerReply;
        }
      } catch (error) {
        logger.warn(
          "Custom AI provider failed for assistant reply; using static fallback",
          error as Error,
        );
      }
    }

    const userMessageCount = history.filter(
      (message) => message.role === "USER",
    ).length;
    const questions = [
      "What outcome should this project deliver, and who are the primary users?",
      "Which workflows are required for the first release, and which are explicitly out of scope?",
      "What constraints matter most: timeline, security, integrations, performance, or compliance?",
      "Which acceptance signals will tell us the plan is complete enough to execute?",
    ];

    if (userMessageCount <= questions.length) {
      return `Requirement captured. ${questions[userMessageCount - 1]}`;
    }

    return "Requirement captured. Context is sufficient for a review draft. Generate draft when ready; no project artifacts will be created until an admin approves it.";
  }

  private async generatePlan(
    userId: string,
    projectId: string,
    config: any,
    context: Awaited<ReturnType<AiPlanningService["getContext"]>>,
    requirements: string[],
  ): Promise<IAiPlanningPlan> {
    if (config && config.enabled) {
      try {
        let apiKey = config.apiKey;
        if (!apiKey) {
          const user = await UserModel.findById(userId).exec();
          if (user) {
            if (config.provider === "openai") apiKey = user.openaiApiKey;
            if (config.provider === "anthropic") apiKey = user.anthropicApiKey;
            if (config.provider === "gemini")
              apiKey = user.geminiApiKey || env.GEMINI_API_KEY;
          }
        }
        if (!apiKey && config.provider === "gemini") {
          apiKey = env.GEMINI_API_KEY;
        }

        const { content: systemPrompt } = await promptResolverService.resolve(
          "planning-draft",
          { workspaceId: context.project.workspaceId, userId },
          {
            project_name: context.project.name,
            project_description: context.project.description,
            existing_milestones: JSON.stringify(context.milestones),
            existing_tasks: JSON.stringify(
              context.tasks.map((t) => ({
                title: t.title,
                status: t.status,
                epicId: t.epicId,
              })),
            ),
          },
        );

        const messages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Please generate the project plan JSON for the following requirements:\n\n${requirements.join("\n\n")}`,
          },
        ];

        const providerPlan = await this.executeProviderRequest(
          {
            provider: config.provider,
            apiKey,
            baseUrl: config.baseUrl,
            modelName: config.modelName,
          },
          messages,
        );
        if (providerPlan) {
          try {
            const parsed = this.cleanAndParseJson(providerPlan);
            return this.normalizePlan(parsed);
          } catch {
            logger.warn(
              "AI provider returned invalid planning JSON; using fallback",
            );
          }
        }
      } catch (error) {
        logger.warn(
          "AI provider failed to generate plan; using fallback",
          error as Error,
        );
      }
    }

    return this.buildFallbackPlan(context.project.name, requirements);
  }
  private buildFallbackPlan(
    projectName: string,
    requirements: string[],
  ): IAiPlanningPlan {
    const requirementItems = requirements
      .flatMap((message) => message.split(/\n|[.!?]\s+/))
      .map((item) => item.replace(/^[-*]\s*/, "").trim())
      .filter((item) => item.length >= 8)
      .slice(0, 8);
    const items =
      requirementItems.length > 0
        ? requirementItems
        : ["Define and deliver approved project scope"];
    const date = new Date().toISOString().slice(0, 10);

    return {
      documentationTitle: `AI Project Plan - ${projectName}`,
      documentation: [
        `# ${projectName} Project Plan`,
        "",
        "## Summary",
        "Plan generated from approved planning conversation.",
        "",
        "## Requirements",
        ...items.map((item) => `- ${item}`),
        "",
        "## Acceptance Criteria",
        "- Approved scope is represented by milestones, tasks, and subtasks.",
        "- Created artifacts remain editable through existing project workflows.",
        "",
        "## Assumptions",
        "- Workspace discussion is source for initial plan draft.",
        "- Admin reviews draft before execution.",
      ].join("\n"),
      milestones: [
        {
          name: "MVP Delivery",
          description: "Deliver approved first-release project scope.",
        },
      ],
      tasks: items.map((item) => ({
        title: this.toTaskTitle(item),
        description: item,
        priority: "MEDIUM" as const,
        date,
        milestoneIndex: 0,
        subtasks: [
          {
            title: `Clarify ${this.toTaskTitle(item)}`,
            description: "Confirm expected outcome.",
          },
          {
            title: `Deliver ${this.toTaskTitle(item)}`,
            description: "Complete approved work.",
          },
        ],
      })),
    };
  }

  private normalizePlan(value: unknown): IAiPlanningPlan {
    if (!value || typeof value !== "object") {
      throw new Error("Plan must be an object");
    }
    const plan = value as Record<string, unknown>;
    const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];

    if (milestones.length === 0) {
      milestones.push({
        name: "MVP Delivery",
        description: "First release deliverables",
      });
    }
    if (tasks.length === 0) {
      tasks.push({
        title: "Define project scope",
        description: "Initial scoping tasks",
        priority: "MEDIUM",
        date: new Date().toISOString().slice(0, 10),
        milestoneIndex: 0,
        subtasks: [],
      });
    }

    const finalMilestones = milestones.slice(0, 4).map((entry, index) => {
      const milestone = this.requireObject(entry, `Milestone ${index + 1}`);
      return {
        name: this.requiredText(
          milestone.name,
          `Milestone ${index + 1} name`,
          160,
        ),
        description:
          this.optionalText(milestone.description, 1000) ||
          "No description provided",
      };
    });

    const finalTasks = tasks.slice(0, 12).map((entry, index) => {
      const task = this.requireObject(entry, `Task ${index + 1}`);
      let milestoneIndex = Number(task.milestoneIndex);
      if (
        isNaN(milestoneIndex) ||
        milestoneIndex < 0 ||
        milestoneIndex >= finalMilestones.length
      ) {
        throw new Error(`milestoneIndex is invalid: ${milestoneIndex}`);
      }

      let priority =
        typeof task.priority === "string"
          ? task.priority.toUpperCase()
          : "MEDIUM";
      if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(priority)) {
        priority = "MEDIUM";
      }

      let date =
        typeof task.date === "string"
          ? task.date
          : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        date = new Date().toISOString().slice(0, 10);
      }

      const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];

      return {
        title: this.requiredText(task.title, `Task ${index + 1} title`, 200),
        description:
          this.optionalText(task.description, 2000) ||
          "No description provided",
        priority: priority as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        date,
        milestoneIndex,
        subtasks: subtasks.slice(0, 12).map((subEntry, subtaskIndex) => {
          const subtask = this.requireObject(
            subEntry,
            `Subtask ${subtaskIndex + 1}`,
          );
          return {
            title: this.requiredText(
              subtask.title,
              `Subtask ${subtaskIndex + 1} title`,
              200,
            ),
            description:
              this.optionalText(subtask.description, 1000) ||
              "No description provided",
          };
        }),
      };
    });

    return {
      documentationTitle:
        this.requiredText(
          plan.documentationTitle,
          "Documentation title",
          160,
        ) || "AI Project Plan",
      documentation:
        this.requiredText(plan.documentation, "Documentation", 20000) ||
        "# Project Plan Documentation",
      milestones: finalMilestones,
      tasks: finalTasks,
    };
  }

  private async requireSession(projectId: string, sessionId: string) {
    const session = await AiPlanningSessionModel.findOne({
      _id: sessionId,
      ...buildSafeRefMatch("projectId", projectId),
    }).exec();
    if (!session) {
      throw new HttpError(404, "Planning session not found");
    }
    return session;
  }

  private requiredText(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
      throw new HttpError(400, `${field} is required`);
    }
    if (text.length > maxLength) {
      throw new HttpError(400, `${field} exceeds ${maxLength} characters`);
    }
    return text;
  }

  private optionalText(value: unknown, maxLength: number): string {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  private requireObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> {
    if (!value || typeof value !== "object") {
      throw new Error(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  private toTaskTitle(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 72
      ? `${normalized.slice(0, 69)}...`
      : normalized;
  }

  private async resolveValidWorkspaceId(
    userId: string,
    workspaceId?: string | null,
  ): Promise<string | null> {
    if (workspaceId && mongoose.Types.ObjectId.isValid(workspaceId)) {
      return workspaceId;
    }
    try {
      const defaultWs =
        await workspaceService.getOrCreateDefaultWorkspace(userId);
      return defaultWs._id.toString();
    } catch {
      return null;
    }
  }

  public async listWorkspaceSessions(
    userId: string,
    workspaceId?: string | null,
  ) {
    const validWsId = await this.resolveValidWorkspaceId(userId, workspaceId);
    const query: any = { createdBy: userId };
    if (validWsId) {
      query.workspaceId = validWsId;
    }
    const sessions = await AiPlanningSessionModel.find(query)
      .sort({ updatedAt: -1, _id: -1 })
      .lean();

    return sessions.map((session) => this.toSessionDto(session));
  }

  public async createWorkspaceSession(
    userId: string,
    workspaceId?: string | null,
    payload?: { title?: unknown },
  ) {
    const validWsId = await this.resolveValidWorkspaceId(userId, workspaceId);
    const title =
      typeof payload?.title === "string" && payload.title.trim()
        ? payload.title.trim().slice(0, 120)
        : "New Planning Session";

    const session = await AiPlanningSessionModel.create({
      workspaceId: validWsId,
      createdBy: userId,
      title,
      status: "ACTIVE",
    });

    return this.toSessionDto(session);
  }

  public async getWorkspaceSession(
    userId: string,
    workspaceId?: string | null,
    sessionId?: string,
  ) {
    if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
      throw new HttpError(400, "Invalid session ID");
    }

    const session = await AiPlanningSessionModel.findOne({
      _id: sessionId,
      createdBy: userId,
    }).exec();

    if (!session) {
      throw new HttpError(404, "Planning session not found");
    }

    const [messages, drafts] = await Promise.all([
      AiPlanningMessageModel.find({ sessionId })
        .sort({ createdAt: 1, _id: 1 })
        .lean(),
      AiPlanningDraftModel.find({ sessionId })
        .sort({ createdAt: -1, _id: -1 })
        .lean(),
    ]);

    return {
      session: this.toSessionDto(session),
      messages: messages.map((message) => this.toMessageDto(message)),
      drafts: drafts.map((draft) => this.toDraftDto(draft)),
    };
  }

  public async deleteWorkspaceSession(
    userId: string,
    workspaceId?: string | null,
    sessionId?: string,
  ) {
    if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
      throw new HttpError(400, "Invalid session ID");
    }

    const session = await AiPlanningSessionModel.findOne({
      _id: sessionId,
      createdBy: userId,
    }).exec();

    if (!session) {
      throw new HttpError(404, "Planning session not found");
    }

    await Promise.all([
      AiPlanningSessionModel.deleteOne({ _id: sessionId }),
      AiPlanningMessageModel.deleteMany({ sessionId }),
      AiPlanningDraftModel.deleteMany({ sessionId }),
    ]);

    return { success: true };
  }

  private toSessionDto(session: any) {
    return {
      id: session._id.toString(),
      workspaceId: session.workspaceId ? session.workspaceId.toString() : null,
      projectId: session.projectId ? session.projectId.toString() : null,
      createdBy: session.createdBy.toString(),
      title: session.title,
      status: session.status,
      createdAt: session.createdAt?.toISOString() ?? null,
      updatedAt: session.updatedAt?.toISOString() ?? null,
    };
  }

  private toMessageDto(message: any) {
    return {
      id: message._id.toString(),
      workspaceId: message.workspaceId ? message.workspaceId.toString() : null,
      projectId: message.projectId ? message.projectId.toString() : null,
      sessionId: message.sessionId.toString(),
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? {},
      createdAt: message.createdAt?.toISOString() ?? null,
    };
  }

  private toDraftDto(draft: any) {
    return {
      id: draft._id.toString(),
      workspaceId: draft.workspaceId ? draft.workspaceId.toString() : null,
      projectId: draft.projectId ? draft.projectId.toString() : null,
      sessionId: draft.sessionId.toString(),
      requestedBy: draft.requestedBy.toString(),
      status: draft.status,
      plan: draft.plan,
      rejectionReason: draft.rejectionReason ?? "",
      failureReason: draft.failureReason ?? "",
      artifacts: draft.artifacts ?? {},
      approvedBy: draft.approvedBy?.toString() ?? null,
      rejectedBy: draft.rejectedBy?.toString() ?? null,
      executedAt: draft.executedAt?.toISOString() ?? null,
      createdAt: draft.createdAt?.toISOString() ?? null,
      updatedAt: draft.updatedAt?.toISOString() ?? null,
    };
  }
}

export default new AiPlanningService();
