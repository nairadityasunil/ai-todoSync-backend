import type {
  ChecklistEventDto,
  ChecklistQueryDto,
  CreateChecklistDto,
  UpdateChecklistDto,
} from "./dtos.js";
import {
  ChecklistModel,
  ChecklistProgressModel,
  type IChecklistDocument,
} from "./model.js";
import { escapeRegex } from "../../utils/escape-regex.js";

class ChecklistRepository {
  public listChecklists(tenantId: string, query: ChecklistQueryDto) {
    const filter: Record<string, unknown> = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
    };

    if (query.search) {
      filter.$or = [
        { title: { $regex: escapeRegex(query.search), $options: "i" } },
        { description: { $regex: escapeRegex(query.search), $options: "i" } },
      ];
    }

    return ChecklistModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  public listLiveChecklists(tenantId: string) {
    return ChecklistModel.find({ tenantId, status: "LIVE" })
      .sort({ updatedAt: -1 })
      .exec();
  }

  public getChecklist(tenantId: string, checklistId: string) {
    return ChecklistModel.findOne({ _id: checklistId, tenantId }).exec();
  }

  public createChecklist(
    tenantId: string,
    createdBy: string,
    dto: CreateChecklistDto,
  ) {
    return ChecklistModel.create({
      ...dto,
      tenantId,
      createdBy,
      updatedBy: createdBy,
      analytics: {},
    });
  }

  public updateChecklist(
    tenantId: string,
    checklistId: string,
    updatedBy: string,
    dto: UpdateChecklistDto,
  ) {
    return ChecklistModel.findOneAndUpdate(
      { _id: checklistId, tenantId },
      { $set: { ...dto, updatedBy } },
      { new: true },
    ).exec();
  }

  public deleteChecklist(tenantId: string, checklistId: string) {
    return ChecklistModel.deleteOne({ _id: checklistId, tenantId }).exec();
  }

  public async upsertProgress(input: {
    tenantId: string;
    checklist: IChecklistDocument;
    event: ChecklistEventDto;
    completedItemIds: string[];
  }) {
    const progressPercent =
      input.checklist.items.length > 0
        ? Math.round(
            (input.completedItemIds.length / input.checklist.items.length) *
              100,
          )
        : 0;
    const completedAt = progressPercent === 100 ? new Date() : null;

    return ChecklistProgressModel.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        checklistId: input.checklist._id.toString(),
        ...(input.event.userId ? { userId: input.event.userId } : {}),
        ...(input.event.sessionId && !input.event.userId
          ? { sessionId: input.event.sessionId }
          : {}),
      },
      {
        $set: {
          completedItemIds: input.completedItemIds,
          completedAt,
          progressPercent,
          lastEventName: input.event.eventName,
        },
        $setOnInsert: {
          tenantId: input.tenantId,
          checklistId: input.checklist._id.toString(),
          userId: input.event.userId,
          sessionId: input.event.sessionId,
        },
      },
      { upsert: true, new: true },
    ).exec();
  }

  public getProgress(input: {
    tenantId: string;
    checklistId: string;
    userId?: string;
    sessionId?: string;
  }) {
    return ChecklistProgressModel.findOne({
      tenantId: input.tenantId,
      checklistId: input.checklistId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionId && !input.userId
        ? { sessionId: input.sessionId }
        : {}),
    }).exec();
  }
}

export default new ChecklistRepository();
