import logger from "../../../lib/logger.js";
import ProjectMemberModel from "../../project/models/project-member.model.js";
import ProjectModel from "../../project/models/project.model.js";
import WorkspaceMemberModel from "../models/workspace-member.model.js";
import { ensureWorkspaceMembersForProject } from "../repositories/workspace-member.repository.js";

/**
 * Being in a project means being in its workspace. People who joined a project before that rule have no workspace
 * membership; this adds them as MEMBERs. Run at start-up, safe to repeat (it only adds what is missing).
 */
export const addMissingWorkspaceMembers = async (): Promise<number> => {
  let added = 0;
  const projects = ProjectModel.find({ workspaceId: { $ne: null } })
    .select("_id workspaceId")
    .lean()
    .cursor();
  for await (const project of projects) {
    const members = await ProjectMemberModel.find({ projectId: project._id })
      .select("userId")
      .lean();
    if (members.length === 0) continue;
    const already = new Set(
      (
        await WorkspaceMemberModel.find({
          workspaceId: project.workspaceId,
          userId: { $in: members.map((m) => m.userId) },
        })
          .select("userId")
          .lean()
      ).map((m) => String(m.userId)),
    );
    const missing = members
      .map((m) => String(m.userId))
      .filter((id) => !already.has(id));
    if (missing.length === 0) continue;
    await ensureWorkspaceMembersForProject(String(project._id), missing);
    added += missing.length;
  }
  if (added > 0)
    logger.info(
      `Added ${added} project member(s) to their project's workspace`,
    );
  return added;
};
