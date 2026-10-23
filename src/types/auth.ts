import type { Request } from "express";

import type { IAgentDocument } from "../modules/agents/model.js";
import type { ICompanionDeviceDocument } from "../modules/ai/models/companion-device.model.js";
import type {
  IDeviceSessionDocument,
  SessionDeviceKind,
} from "../modules/auth/models/device-session.model.js";
import type { IProjectDocument } from "../modules/project/models/project.model.js";
import type { ProjectRole } from "../interfaces/project/project.interface.js";
import type { IUserDocument } from "../modules/auth/models/user.model.js";
import type { IWorkspaceDocument } from "../modules/workspace/models/workspace.model.js";
import type { IWorkspaceMemberDocument } from "../modules/workspace/models/workspace-member.model.js";

export interface AuthProfile {
  id: string;
  email: string;
  syncApiKey: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  authProvider: "local" | "google";
  openaiApiKeyConfigured?: boolean;
  anthropicApiKeyConfigured?: boolean;
  geminiApiKeyConfigured?: boolean;
  twoFactorEnabled?: boolean;
}

export interface SessionDeviceContext {
  sessionId: string | null;
  deviceId: string | null;
  deviceType: SessionDeviceKind | "sync_key";
  deviceName: string | null;
  companionDeviceType: string | null;
  authMethod: "access_token" | "sync_api_key";
  /** Set when the request comes from a governed agent. */
  agentId?: string | null;
}

export interface AuthResult {
  token: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
  syncApiKey: string | null;
  user: AuthProfile;
  session: SessionDeviceContext;
}

export interface AuthenticatedRequest extends Request {
  user?: IUserDocument;
  auth?: SessionDeviceContext;
  deviceSession?: IDeviceSessionDocument | null;
  companionDevice?: ICompanionDeviceDocument | null;
  agent?: IAgentDocument | null;
  /** Set on an approved agent request replayed by the approvals service. */
  agentApprovalId?: string | null;
  projectAccess?: {
    project: IProjectDocument;
    role: ProjectRole;
  };
  workspaceAccess?: {
    workspace: IWorkspaceDocument;
    member: IWorkspaceMemberDocument;
  };
}
