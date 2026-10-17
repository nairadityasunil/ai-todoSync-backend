import ProjectPlanModel from "../../project/models/project-plan.model.js";
import TaskModel from "../../task/models/task.model.js";
import ProjectModel from "../../project/models/project.model.js";
import TaskDependencyModel from "../../task/models/task-dependency.model.js";
import projectService from "../../project/services/project.service.js";

export interface ISemanticIntelligenceReport {
  projectId: string;
  projectName: string;
  healthScore: number; // 0-100
  plannedVsActual: {
    plannedHours: number;
    completedHours: number;
    inProgressHours: number;
    remainingHours: number;
    velocityRatio: number; // actual vs planned pace
  };
  taskBreakdown: {
    totalTasks: number;
    completedTasks: number;
    inProgressTasks: number;
    blockedTasks: number;
    overdueTasks: number;
  };
  risks: Array<{
    title: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    impact: string;
  }>;
  recommendations: Array<{
    id: string;
    type:
      | "REALLOCATE_TASK"
      | "ADJUST_SCHEDULE"
      | "UNBLOCK_DEPENDENCY"
      | "REDUCE_SCOPE";
    title: string;
    description: string;
    actionPayload?: any;
  }>;
}

class SemanticIntelligenceService {
  public async generateReport(
    projectId: string,
  ): Promise<ISemanticIntelligenceReport> {
    const project = await projectService.getProjectById(projectId);
    const resolvedProjectId = project ? project._id.toString() : projectId;
    const projectIds = project
      ? [resolvedProjectId, ...(project.uuid ? [project.uuid] : [])]
      : [projectId];

    const [canonicalPlan, tasks, _dependencies] = await Promise.all([
      ProjectPlanModel.findOne({
        projectId: { $in: projectIds },
        status: "APPROVED",
      }).lean(),
      TaskModel.find({ projectId: resolvedProjectId }).lean(),
      TaskDependencyModel.find({ projectId: resolvedProjectId }).lean(),
    ]);
    const _states = project?.states ?? [];

    const projectName = project?.name || "Project";
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(
      (t: any) => t.status === "DONE" || String(t.status) === "COMPLETED",
    ).length;
    const inProgressTasks = tasks.filter(
      (t: any) => t.status === "IN_PROGRESS" || String(t.status) === "STARTED",
    ).length;
    const blockedTasks = tasks.filter((t: any) => t.isBlocked).length;

    const todayStr = new Date().toISOString().split("T")[0];
    const overdueTasks = tasks.filter(
      (t: any) =>
        t.date &&
        t.date < todayStr &&
        t.status !== "DONE" &&
        String(t.status) !== "COMPLETED",
    ).length;

    // Planned vs Actual hours calculation
    const plannedHours =
      canonicalPlan?.timeline?.totalEngineeringHours ||
      tasks.reduce((acc: number, t: any) => acc + (t.estimatedHours || 8), 0) ||
      80;

    const completedHours = tasks
      .filter(
        (t: any) => t.status === "DONE" || String(t.status) === "COMPLETED",
      )
      .reduce((acc: number, t: any) => acc + (t.estimatedHours || 8), 0);

    const inProgressHours = tasks
      .filter(
        (t: any) =>
          t.status === "IN_PROGRESS" || String(t.status) === "STARTED",
      )
      .reduce((acc: number, t: any) => acc + (t.estimatedHours || 8), 0);

    const remainingHours = Math.max(0, plannedHours - completedHours);

    // Velocity ratio (completed vs target ratio)
    const completionPercent = totalTasks > 0 ? completedTasks / totalTasks : 0;
    const velocityRatio = Number((completionPercent * 1.2).toFixed(2));

    // Health Score calculation (0 - 100)
    let healthScore = 100;
    if (overdueTasks > 0) healthScore -= Math.min(30, overdueTasks * 10);
    if (blockedTasks > 0) healthScore -= Math.min(25, blockedTasks * 15);
    if (velocityRatio < 0.5 && totalTasks > 5) healthScore -= 20;
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Risks identification
    const risks: ISemanticIntelligenceReport["risks"] = [];
    if (blockedTasks > 0) {
      risks.push({
        title: `${blockedTasks} task(s) currently blocked by dependencies`,
        severity: "HIGH",
        impact: "Critical path delays until upstream blockers are cleared.",
      });
    }
    if (overdueTasks > 0) {
      risks.push({
        title: `${overdueTasks} task(s) past target completion date`,
        severity: "MEDIUM",
        impact: "Pushes back downstream milestone targets.",
      });
    }
    if (canonicalPlan?.risks) {
      canonicalPlan.risks.forEach((r: any) => {
        risks.push({
          title: r.title,
          severity: r.severity || "MEDIUM",
          impact:
            r.mitigation || "Plan risk identified during architecture phase.",
        });
      });
    }

    // Actionable Recommendations
    const recommendations: ISemanticIntelligenceReport["recommendations"] = [];
    if (blockedTasks > 0) {
      recommendations.push({
        id: "rec-unblock-deps",
        type: "UNBLOCK_DEPENDENCY",
        title: "Prioritize Upstream Blocking Tasks",
        description:
          "Focus dev effort on unblocking dependent tasks to restore project velocity.",
      });
    }
    if (overdueTasks > 0) {
      recommendations.push({
        id: "rec-adjust-schedule",
        type: "ADJUST_SCHEDULE",
        title: "Re-align Target Schedule",
        description:
          "Adjust due dates for overdue items or re-allocate available team capacity.",
      });
    }
    if (healthScore > 85) {
      recommendations.push({
        id: "rec-healthy-velocity",
        type: "REALLOCATE_TASK",
        title: "Maintain Current Sprint Pace",
        description:
          "Project execution velocity is on track with canonical plan guidelines.",
      });
    }

    return {
      projectId,
      projectName,
      healthScore,
      plannedVsActual: {
        plannedHours,
        completedHours,
        inProgressHours,
        remainingHours,
        velocityRatio,
      },
      taskBreakdown: {
        totalTasks,
        completedTasks,
        inProgressTasks,
        blockedTasks,
        overdueTasks,
      },
      risks,
      recommendations,
    };
  }
}

export default new SemanticIntelligenceService();
