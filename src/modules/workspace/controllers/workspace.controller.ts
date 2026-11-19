import type { Response } from "express";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import workspaceService from "../services/workspace.service.js";
import {
  validateCreateWorkspace,
  validateUpdateWorkspace,
  validateInviteMember,
  validateUpdateMemberRole,
} from "../workspace.validator.js";

export const listWorkspaces = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const workspaces = await workspaceService.listUserWorkspaces(userId);
    res.status(200).json({ workspaces });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const createWorkspace = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const payload = validateCreateWorkspace(req.body);
    const workspace = await workspaceService.createWorkspace(userId, payload);
    res.status(201).json({ workspace });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const getWorkspaceDetails = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    const workspace = await workspaceService.getWorkspaceDetails(userId, id);
    res.status(200).json({ workspace });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const updateWorkspace = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    const payload = validateUpdateWorkspace(req.body);
    const workspace = await workspaceService.updateWorkspace(
      userId,
      id,
      payload,
    );
    res.status(200).json({ workspace });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const deleteWorkspace = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    await workspaceService.deleteWorkspace(userId, id);
    res.status(200).json({ message: "Workspace deleted successfully" });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const listMembers = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    const members = await workspaceService.listMembers(userId, id);
    res.status(200).json({ members });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const inviteMember = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    const payload = validateInviteMember(req.body);
    const member = await workspaceService.inviteMember(userId, id, payload);
    res.status(201).json({ member });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const updateMemberRole = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id, memberUserId } = req.params as Record<string, string>;
    const { role } = validateUpdateMemberRole(req.body);
    const member = await workspaceService.updateMemberRole(
      userId,
      id,
      memberUserId,
      role,
    );
    res.status(200).json({ member });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const removeMember = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id, memberUserId } = req.params as Record<string, string>;
    await workspaceService.removeMember(userId, id, memberUserId);
    res.status(200).json({ message: "Member removed successfully" });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const markWorkspaceUsed = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    await workspaceService.markUsed(userId, id);
    res.status(200).json({ message: "OK" });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};

export const leaveWorkspace = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id } = req.params as Record<string, string>;
    await workspaceService.leaveWorkspace(userId, id);
    res.status(200).json({ message: "You left the workspace" });
  } catch (error: any) {
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ error: error.message });
  }
};
