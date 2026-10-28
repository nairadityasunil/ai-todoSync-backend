import type { Types } from "mongoose";

export interface IWorkspaceSettings {
  defaultProjectRole?: string;
  allowGuestInvites?: boolean;
  /** Mask personal data and secrets before prompts go to AI providers. */
  aiDataMasking?: boolean;
  /** Scripts and automated browsers must use an agent key, not a person's login. */
  requireAgentKeys?: boolean;
  /** Suspend agents unused for this many days (0: never). */
  inactiveAgentDays?: number;
}

export interface IWorkspace {
  name: string;
  slug: string;
  ownerId: Types.ObjectId | string;
  settings?: IWorkspaceSettings;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IWorkspaceMember {
  workspaceId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
  joinedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IInvitation {
  workspaceId: Types.ObjectId | string;
  email: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
  invitedBy: Types.ObjectId | string;
  token: string;
  status: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
