import ProjectModel from "./models/project.model.js";
import TaskModel from "../task/models/task.model.js";

/**
 * Every project starts with the same four workflow states, so the Workflow settings, the board columns and
 * the task Status dropdown always show the same stages.
 */
export const DEFAULT_WORKFLOW_STATES = [
  { name: "Backlog", color: "#9CA3AF", category: "BACKLOG", isTerminal: false },
  {
    name: "In Progress",
    color: "#3B82F6",
    category: "STARTED",
    isTerminal: false,
  },
  { name: "Review", color: "#8B5CF6", category: "STARTED", isTerminal: false },
  { name: "Done", color: "#10B981", category: "COMPLETED", isTerminal: true },
] as const;

const STATUS_CATEGORY: Record<string, string> = {
  BACKLOG: "BACKLOG",
  TODO: "UNSTARTED",
  IN_PROGRESS: "STARTED",
  IN_REVIEW: "STARTED",
  BLOCKED: "STARTED",
  DONE: "COMPLETED",
};

/**
 * Gives a project the default workflow once. Projects made before workflow states existed get it the first time
 * their states are read or a task changes; if someone later deletes every state on purpose, it is not added again.
 * Tasks that had no state are placed in the state that matches their status.
 */
export async function ensureDefaultWorkflow(projectId: string): Promise<void> {
  const seeded = await ProjectModel.findOneAndUpdate(
    {
      _id: projectId,
      statesInitialized: { $ne: true },
      $or: [{ states: { $exists: false } }, { states: { $size: 0 } }],
    },
    {
      $set: {
        statesInitialized: true,
        states: DEFAULT_WORKFLOW_STATES.map((s, position) => ({
          ...s,
          position,
          description: "",
          isDefault: false,
        })),
      },
    },
    { new: true },
  ).lean();

  if (!seeded) {
    // Already has states (or was set up on purpose): just remember that it has been looked at.
    await ProjectModel.updateOne(
      { _id: projectId, statesInitialized: { $ne: true } },
      { $set: { statesInitialized: true } },
    );
    return;
  }

  const states = (seeded.states ?? []) as Array<{
    _id: unknown;
    category: string;
  }>;
  const byCategory = (category: string) =>
    states.find((s) => s.category === category) ?? states[0];
  for (const status of Object.keys(STATUS_CATEGORY)) {
    const target = byCategory(STATUS_CATEGORY[status]);
    if (!target) continue;
    await TaskModel.updateMany(
      {
        projectId,
        status,
        $or: [{ stateId: null }, { stateId: { $exists: false } }],
      },
      { $set: { stateId: target._id } },
    );
  }
}
