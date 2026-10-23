import App from "./app.js";
import HealthRoutes from "./shared/routes/health.routes.js";
import AuthRoutes from "./modules/auth/routes/auth.routes.js";
import TaskRoutes from "./modules/task/routes/tasks.routes.js";
import SyncRoutes from "./modules/sync/routes/sync.routes.js";
import ProjectRoutes from "./modules/project/routes/project.routes.js";
import NoteRoutes from "./modules/note/routes/note.routes.js";
import EpicRoutes from "./modules/epic/routes/epic.routes.js";
import UserRoutes from "./modules/auth/routes/users.routes.js";
import ChatRoutes from "./modules/chat/routes/chat.routes.js";
import ActivityHistoryRoutes from "./modules/audit/routes/activity-log.routes.js";
import CommentRoutes from "./modules/comment/routes/comment.routes.js";
import AnalyticsRoutes from "./modules/analytics/routes/analytics.routes.js";
import SlaRoutes from "./modules/task/routes/sla.routes.js";
import ApprovalWorkflowRoutes from "./modules/approval-workflow/routes/approval-workflow.routes.js";
import PriorityEngineRoutes from "./modules/task/routes/priority-engine.routes.js";
import ChecklistRoutes from "./modules/checklists/routes.js";
import EngagementRoutes from "./modules/engagement/routes.js";
import GuideAnalyticsRoutes from "./modules/guide-analytics/routes.js";
import GuideRoutes from "./modules/guides/routes.js";
import SurveyRoutes from "./modules/surveys/routes.js";
import TargetingRoutes from "./modules/targeting/routes.js";
import AiPlanningRoutes from "./modules/ai-planner/routes/ai-planning.routes.js";
import SdkIntegrationRoutes from "./modules/sdk-integrations/routes.js";
import InvitationRoutes from "./modules/workspace/routes/invitation.routes.js";
import WorkspaceRoutes from "./modules/workspace/routes/workspace.routes.js";
import CentralizedAiRoutes from "./modules/ai/routes/ai.routes.js";
import DocumentRoutes from "./modules/document/routes/document.routes.js";
import PromptLibraryRoutes from "./modules/prompt/routes/prompt-library.routes.js";
import CompanionRoutes from "./modules/companion/routes/companion.routes.js";
import McpRoutes from "./modules/mcp/mcp.routes.js";
import AgentRoutes from "./modules/agents/routes.js";
import logger from "./lib/logger.js";

const server = new App([
  new McpRoutes(),
  new AgentRoutes(),
  new CompanionRoutes(),
  new PromptLibraryRoutes(),
  new DocumentRoutes(),
  new CentralizedAiRoutes(),
  new WorkspaceRoutes(),
  new GuideRoutes(),
  new SurveyRoutes(),
  new ChecklistRoutes(),
  new TargetingRoutes(),
  new EngagementRoutes(),
  new GuideAnalyticsRoutes(),
  new SdkIntegrationRoutes(),
  new AnalyticsRoutes(),
  new SlaRoutes(),
  new ApprovalWorkflowRoutes(),
  new PriorityEngineRoutes(),
  new HealthRoutes(),
  new AuthRoutes(),
  new TaskRoutes(),
  new ProjectRoutes(),
  new UserRoutes(),
  new EpicRoutes(),
  new NoteRoutes(),
  new SyncRoutes(),
  new ChatRoutes(),
  new AiPlanningRoutes(),
  new ActivityHistoryRoutes(),
  new CommentRoutes(),
  new InvitationRoutes(),
]);

process.on("uncaughtException", (error) => {
  logger.error("FATAL: Uncaught Exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error(
    "FATAL: Unhandled Rejection",
    reason instanceof Error ? reason : new Error(String(reason)),
  );
});

void server.listen().catch((error) => {
  logger.error(
    "Backend process exiting because startup failed",
    error instanceof Error ? error : new Error("Unknown error"),
  );
  process.exit(1);
});
