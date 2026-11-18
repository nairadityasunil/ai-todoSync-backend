import env from "../../../config/env.js";
import logger from "../../../lib/logger.js";
import { EmailService } from "../../../shared/services/email.service.js";
import UserModel from "../../auth/models/user.model.js";
import ProjectModel from "../../project/models/project.model.js";
import TaskModel from "../models/task.model.js";
import { escapeHtml } from "../../email-templates/email-template.service.js";

/**
 * Emails a person when another member assigns them a task. Never the person who made the
 * assignment, and never allowed to fail the request that caused it.
 */
export async function emailAssignee(opts: {
  taskIds: string[];
  assigneeId: string;
  assignerId: string;
}): Promise<void> {
  try {
    if (!opts.taskIds.length || opts.assigneeId === opts.assignerId) return;
    const [assignee, assigner, tasks] = await Promise.all([
      UserModel.findById(opts.assigneeId).select("name email").lean(),
      UserModel.findById(opts.assignerId).select("name email").lean(),
      TaskModel.find({ _id: { $in: opts.taskIds } })
        .select("title priority date projectId")
        .lean(),
    ]);
    if (!assignee?.email || !tasks.length) return;
    const projectIds = [
      ...new Set(tasks.map((t) => t.projectId?.toString()).filter(Boolean)),
    ] as string[];
    const projects = projectIds.length
      ? await ProjectModel.find({ _id: { $in: projectIds } })
          .select("name")
          .lean()
      : [];
    const base = env.FRONTEND_BASE_URL.replace(/\/$/, "");
    const where = projects.length === 1 ? ` in ${projects[0].name}` : "";
    const many = tasks.length > 1;
    const items = tasks
      .map((t) => {
        const link = t.projectId
          ? `${base}/projects/${t.projectId}?task=${t._id}`
          : `${base}/dashboard`;
        const priority = t.priority
          ? ` <span style="color:#52635c">&middot; ${escapeHtml(String(t.priority).toLowerCase())} priority</span>`
          : "";
        const due = t.date
          ? ` <span style="color:#52635c">&middot; due ${escapeHtml(String(t.date).slice(0, 10))}</span>`
          : "";
        return `<li style="margin-bottom:10px"><a href="${escapeHtml(link)}" style="color:#1c2d27;font-weight:700;text-decoration:none">${escapeHtml(t.title)}</a>${priority}${due}</li>`;
      })
      .join("");
    await EmailService.sendTemplate(assignee.email, "TASK_ASSIGNED", {
      assigneeName: assignee.name || assignee.email,
      inviterName: assigner?.name || assigner?.email || "Someone",
      taskWord: many ? `${tasks.length} tasks` : "a task",
      inProject: where,
      projectName: projects.length === 1 ? projects[0].name : "",
      taskCount: String(tasks.length),
      taskListHtml: `<ul style="padding-left:18px;margin:0">${items}</ul>`,
    });
  } catch (error) {
    logger.warn("Could not email a task assignee", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
