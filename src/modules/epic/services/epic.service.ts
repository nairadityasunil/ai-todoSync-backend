import type { IEpicDocument, EpicStatus } from "../models/epic.model.js";
import {
  createEpic,
  getEpicById,
  getEpicByIdAndProject,
  getEpicsByProject,
  getNextEpicOrder,
  reorderEpics,
  type ReorderEpicPayload,
  type UpdateEpicPayload,
  updateEpic,
  deleteEpic,
  getEpicsByProjects,
} from "../../../modules/epic/repositories/epic.repository.js";
import projectService from "../../project/services/project.service.js";
import { getProjectMembershipsByUser } from "../../project/repositories/project-member.repository.js";

interface EpicDto {
  id: string;
  name: string;
  description?: string;
  projectId: string;
  status: EpicStatus;
  order: number;
  createdAt?: Date;
  updatedAt?: Date;
}

interface EpicPayload {
  name?: unknown;
  description?: unknown;
  status?: unknown;
}

interface ReorderEpicsInput {
  epicIds?: unknown;
}

class HttpError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

class EpicService {
  public async createEpic(
    userId: string,
    projectId: string,
    payload: EpicPayload,
  ): Promise<EpicDto> {
    await projectService.assertProjectMembership(userId, projectId);

    const epic = await createEpic({
      projectId,
      name: this.normalizeName(payload.name),
      description: this.normalizeOptionalText(payload.description),
      status: this.normalizeStatus(payload.status),
      order: await getNextEpicOrder(projectId),
    });

    return this.toDto(epic);
  }

  public async fetchProjectEpics(
    userId: string,
    projectId: string,
  ): Promise<EpicDto[]> {
    await projectService.assertProjectMembership(userId, projectId);
    const epics = await getEpicsByProject(projectId);
    return epics.map((epic) => this.toDto(epic));
  }

  /**
   * The epics of every project the person belongs to, or of one project (`projectId`). The server knows the
   * person's projects, so nothing needs to send a list of ids.
   */
  public async fetchMyEpics(
    userId: string,
    projectId?: string,
  ): Promise<EpicDto[]> {
    if (projectId) {
      await projectService.assertProjectMembership(userId, projectId);
      const epics = await getEpicsByProjects([projectId]);
      return epics.map((epic) => this.toDto(epic));
    }
    const memberships = await getProjectMembershipsByUser(userId);
    const ids = memberships.map((m) => m.projectId.toString());
    if (ids.length === 0) return [];
    const epics = await getEpicsByProjects(ids);
    return epics.map((epic) => this.toDto(epic));
  }

  public async updateEpic(
    userId: string,
    projectId: string,
    epicId: string,
    payload: EpicPayload,
  ): Promise<EpicDto> {
    await projectService.assertProjectMembership(userId, projectId);

    const existingEpic = await getEpicByIdAndProject(epicId, projectId);

    if (existingEpic == null) {
      throw new HttpError(404, "Epic not found");
    }

    const updates: UpdateEpicPayload = {};

    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      updates.name = this.normalizeName(payload.name);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "description")) {
      updates.description = this.normalizeOptionalText(payload.description);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "status")) {
      updates.status = this.normalizeStatus(payload.status);
    }

    const epic = await updateEpic(epicId, projectId, updates);

    if (epic == null) {
      throw new HttpError(404, "Epic not found");
    }

    return this.toDto(epic);
  }

  public async deleteEpic(
    userId: string,
    projectId: string,
    epicId: string,
  ): Promise<IEpicDocument> {
    await projectService.assertProjectOwnership(userId, projectId);

    const deletedEpic = await deleteEpic(epicId, projectId);

    if (deletedEpic == null) {
      throw new HttpError(404, "Epic not found");
    }

    return deletedEpic;
  }

  public async reorderProjectEpics(
    userId: string,
    projectId: string,
    payload: ReorderEpicsInput,
  ): Promise<EpicDto[]> {
    await projectService.assertProjectMembership(userId, projectId);

    const epics = await getEpicsByProject(projectId);
    const epicIds = this.normalizeEpicOrderPayload(payload.epicIds, epics);

    const updates: ReorderEpicPayload[] = epicIds.map((id, index) => ({
      id,
      order: index,
    }));

    const reordered = await reorderEpics(projectId, updates);
    return reordered.map((epic) => this.toDto(epic));
  }

  public async getEpicById(epicId: string): Promise<EpicDto | null> {
    const epic = await getEpicById(epicId);
    return epic ? this.toDto(epic) : null;
  }

  public async assertEpicInProject(
    projectId: string,
    epicId: string,
  ): Promise<EpicDto> {
    const epic = await getEpicById(epicId);

    if (epic == null) {
      throw new HttpError(400, "Epic not found");
    }

    if (epic.projectId.toString() !== projectId) {
      throw new HttpError(400, "Epic does not belong to the selected project");
    }

    return this.toDto(epic);
  }

  private normalizeEpicOrderPayload(
    value: unknown,
    epics: IEpicDocument[],
  ): string[] {
    if (!Array.isArray(value)) {
      throw new HttpError(400, "`epicIds` must be an array");
    }

    const expectedIds = new Set(epics.map((epic) => epic._id.toString()));

    if (value.length !== expectedIds.size) {
      throw new HttpError(
        400,
        "Epic reorder payload must include every epic exactly once",
      );
    }

    const epicIds = value.map((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        throw new HttpError(400, `Invalid epic id at index ${index}`);
      }

      return item;
    });

    if (new Set(epicIds).size !== epicIds.length) {
      throw new HttpError(
        400,
        "Epic reorder payload cannot contain duplicates",
      );
    }

    const hasUnexpectedId = epicIds.some((id) => !expectedIds.has(id));

    if (hasUnexpectedId) {
      throw new HttpError(
        400,
        "Epic reorder payload contains an invalid epic id",
      );
    }

    return epicIds;
  }

  private toDto(epic: IEpicDocument): EpicDto {
    return {
      id: epic._id.toString(),
      name: epic.name,
      description: epic.description,
      projectId: epic.projectId.toString(),
      status: epic.status ?? "planned",
      order: epic.order,
      createdAt: epic.createdAt,
      updatedAt: epic.updatedAt,
    };
  }

  private normalizeName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";

    if (!name) {
      throw new HttpError(400, "Epic name is required");
    }
    if (name.length > 120) {
      throw new HttpError(
        400,
        `Epic name can be at most 120 characters (this one has ${name.length}).`,
      );
    }

    return name;
  }

  private normalizeOptionalText(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    return value.trim();
  }

  private normalizeStatus(value: unknown): EpicStatus {
    if (value == null || value === "") {
      return "planned";
    }

    if (
      value === "planned" ||
      value === "active" ||
      value === "completed" ||
      value === "archived"
    ) {
      return value;
    }

    throw new HttpError(400, "Invalid epic status");
  }
}

const epicService = new EpicService();

export type { EpicDto, EpicPayload };
export default epicService;
