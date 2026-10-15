import type { Response } from "express";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import ProjectModel from "../models/project.model.js";
import projectService from "../services/project.service.js";
import { AppError } from "../../../utils/app-error.js";

const STATE_CATEGORIES = [
  "BACKLOG",
  "UNSTARTED",
  "STARTED",
  "COMPLETED",
  "CANCELED",
] as const;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_STATE_NAME_LENGTH = 50;

const validateStateFields = (
  body: Record<string, unknown>,
  { requireName }: { requireName: boolean },
): void => {
  const { name, color, category, description } = body;

  if (requireName || name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      throw new AppError(400, "State name is required", "BAD_REQUEST");
    }
    if (name.trim().length > MAX_STATE_NAME_LENGTH) {
      throw new AppError(
        400,
        `State name must be at most ${MAX_STATE_NAME_LENGTH} characters`,
        "BAD_REQUEST",
      );
    }
  }
  if (
    color !== undefined &&
    (typeof color !== "string" || !HEX_COLOR.test(color))
  ) {
    throw new AppError(
      400,
      "Color must be a hex value like #3B82F6",
      "BAD_REQUEST",
    );
  }
  if (
    category !== undefined &&
    !STATE_CATEGORIES.includes(category as (typeof STATE_CATEGORIES)[number])
  ) {
    throw new AppError(
      400,
      `Category must be one of ${STATE_CATEGORIES.join(", ")}`,
      "BAD_REQUEST",
    );
  }
  if (description !== undefined && typeof description !== "string") {
    throw new AppError(400, "Description must be a string", "BAD_REQUEST");
  }
};

const hasDuplicateName = (
  states: { _id?: unknown; name: string }[],
  name: string,
  excludeId?: string,
): boolean =>
  states.some(
    (s) =>
      s._id?.toString() !== excludeId &&
      s.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

export const getProjectStates = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id: projectId } = req.params as Record<string, string>;
    await projectService.assertProjectMembership(userId, projectId);

    const project = await ProjectModel.findById(projectId).lean();
    if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");

    const states = (project.states ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    res.status(200).json({ states });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const createProjectState = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id: projectId } = req.params as Record<string, string>;
    await projectService.assertProjectRole(userId, projectId, "ADMIN");

    validateStateFields(req.body ?? {}, { requireName: true });
    const { name, color, category, description } = req.body;

    const project = await ProjectModel.findById(projectId);
    if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");
    if (hasDuplicateName(project.states ?? [], name)) {
      throw new AppError(
        409,
        "A state with this name already exists",
        "CONFLICT",
      );
    }

    const position = (project.states ?? []).length;
    const newState = {
      name: name.trim(),
      description: description || "",
      color: color || "#3B82F6",
      category: category || "STARTED",
      position,
      isDefault: false,
      isTerminal: false,
    };

    project.states = [...(project.states ?? []), newState as any];
    await project.save();

    const state = project.states[project.states.length - 1];
    res.status(201).json({ state });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const updateProjectState = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id: projectId, stateId } = req.params as Record<string, string>;
    await projectService.assertProjectRole(userId, projectId, "ADMIN");

    validateStateFields(req.body ?? {}, { requireName: false });
    const { name, color, category, description } = req.body;

    const project = await ProjectModel.findById(projectId);
    if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");

    const state = (project.states ?? []).find(
      (s) => s._id?.toString() === stateId,
    );
    if (!state) {
      throw new AppError(404, "Project state not found", "NOT_FOUND");
    }

    if (
      name !== undefined &&
      hasDuplicateName(project.states ?? [], name, stateId)
    ) {
      throw new AppError(
        409,
        "A state with this name already exists",
        "CONFLICT",
      );
    }

    // Position is managed through the reorder endpoint so positions stay
    // contiguous.
    if (name !== undefined) state.name = name.trim();
    if (color !== undefined) state.color = color;
    if (category !== undefined) state.category = category;
    if (description !== undefined) state.description = description;

    project.markModified("states");
    await project.save();

    res.status(200).json({ state });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const deleteProjectState = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id: projectId, stateId } = req.params as Record<string, string>;
    await projectService.assertProjectRole(userId, projectId, "ADMIN");

    const project = await ProjectModel.findById(projectId);
    if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");

    const initialLength = (project.states ?? []).length;
    project.states = (project.states ?? []).filter(
      (s) => s._id?.toString() !== stateId,
    ) as any;

    if ((project.states ?? []).length === initialLength) {
      throw new AppError(404, "Project state not found", "NOT_FOUND");
    }

    (project.states ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .forEach((s, index) => {
        s.position = index;
      });

    project.markModified("states");
    await project.save();

    res.status(200).json({ message: "State deleted successfully" });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};

export const reorderProjectStates = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { id: projectId } = req.params as Record<string, string>;
    const { stateIds } = req.body;

    await projectService.assertProjectRole(userId, projectId, "ADMIN");

    if (
      !Array.isArray(stateIds) ||
      !stateIds.every((id: unknown) => typeof id === "string")
    ) {
      throw new AppError(400, "stateIds array is required", "BAD_REQUEST");
    }

    const project = await ProjectModel.findById(projectId);
    if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");

    const existingIds = new Set(
      (project.states ?? []).map((s) => s._id?.toString()),
    );
    if (
      stateIds.length !== existingIds.size ||
      new Set(stateIds).size !== stateIds.length ||
      !stateIds.every((id: string) => existingIds.has(id))
    ) {
      throw new AppError(
        400,
        "stateIds must list every project state exactly once",
        "BAD_REQUEST",
      );
    }

    stateIds.forEach((stateId: string, index: number) => {
      const state = (project.states ?? []).find(
        (s) => s._id?.toString() === stateId,
      );
      if (state) state.position = index;
    });

    project.markModified("states");
    await project.save();

    const states = (project.states ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    res.status(200).json({ states });
  } catch (error: any) {
    res
      .status(error.status || error.statusCode || 500)
      .json({ error: error.message });
  }
};
