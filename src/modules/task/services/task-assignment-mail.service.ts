import env from "../../../config/env.js";
import logger from "../../../lib/logger.js";
import { EmailService } from "../../../shared/services/email.service.js";
import UserModel from "../../auth/models/user.model.js";
import ProjectModel from "../../project/models/project.model.js";
import TaskModel from "../models/task.model.js";
import { buildAssignmentEmail } from "./task-assignment-mail.js";

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
    const mail = buildAssignmentEmail({
      assigneeName: assignee.name || assignee.email,
      assignerName: assigner?.name || assigner?.email || "Someone",
      projectName: projects.length === 1 ? projects[0].name : null,
      tasks: tasks.map((t) => ({
        title: t.title,
        priority: t.priority,
        dueDate: t.date ? String(t.date).slice(0, 10) : null,
        link: t.projectId
          ? `${base}/projects/${t.projectId}?task=${t._id}`
          : `${base}/dashboard`,
      })),
    });
    await EmailService.sendEmail(
      assignee.email,
      mail.subject,
      mail.text,
      mail.html,
    );
  } catch (error) {
    logger.warn("Could not email a task assignee", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
