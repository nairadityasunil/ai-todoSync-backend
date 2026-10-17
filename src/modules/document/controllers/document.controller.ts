import type { Response } from "express";
import type { AuthenticatedRequest } from "../../../types/auth.js";
import DocumentModel from "../models/document.model.js";
import projectService from "../../project/services/project.service.js";
import { AppError } from "../../../utils/app-error.js";

const getParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export const getProjectDocuments = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const projectId = getParam(req.params.projectId || req.params.id);
    const access = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = access.project._id.toString();
    const publicProjectUuid = access.project.uuid || resolvedProjectId;

    const documents = await DocumentModel.find({ projectId: resolvedProjectId })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({
      documents: documents.map((doc) => ({
        ...doc,
        projectId: publicProjectUuid,
      })),
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const createDocument = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const projectId = getParam(req.params.projectId || req.params.id);
    const access = await projectService.assertProjectMembership(
      userId,
      projectId,
    );
    const resolvedProjectId = access.project._id.toString();
    const publicProjectUuid = access.project.uuid || resolvedProjectId;

    const { title, type, content, tags, aiGenerated } = req.body;
    if (!title?.trim()) {
      throw new AppError(400, "Document title is required", "BAD_REQUEST");
    }

    const doc = await DocumentModel.create({
      projectId: resolvedProjectId,
      title: title.trim(),
      type: type || "GENERAL",
      content: content || "",
      authorId: userId,
      tags: Array.isArray(tags) ? tags : [],
      aiGenerated: !!aiGenerated,
    });

    const docObj = doc.toObject();
    (docObj as any).projectId = publicProjectUuid;

    res.status(201).json({ document: docObj });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const getDocumentById = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { docId } = req.params as Record<string, string>;

    const doc = await DocumentModel.findById(docId).lean();
    if (!doc) {
      throw new AppError(404, "Document not found", "NOT_FOUND");
    }

    const access = await projectService.assertProjectMembership(
      userId,
      doc.projectId.toString(),
    );
    const publicProjectUuid =
      access.project.uuid || access.project._id.toString();

    res.status(200).json({
      document: {
        ...doc,
        projectId: publicProjectUuid,
      },
    });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const updateDocument = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { docId } = req.params as Record<string, string>;

    const doc = await DocumentModel.findById(docId);
    if (!doc) {
      throw new AppError(404, "Document not found", "NOT_FOUND");
    }

    const access = await projectService.assertProjectMembership(
      userId,
      doc.projectId.toString(),
    );
    const publicProjectUuid =
      access.project.uuid || access.project._id.toString();

    const { title, type, content, tags } = req.body;
    if (title !== undefined) doc.title = title.trim();
    if (type !== undefined) doc.type = type;
    if (content !== undefined) doc.content = content;
    if (tags !== undefined) doc.tags = Array.isArray(tags) ? tags : [];
    doc.version = (doc.version || 1) + 1;

    await doc.save();
    const docObj = doc.toObject();
    (docObj as any).projectId = publicProjectUuid;

    res.status(200).json({ document: docObj });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

export const deleteDocument = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!._id.toString();
    const { docId } = req.params as Record<string, string>;

    const doc = await DocumentModel.findById(docId);
    if (!doc) {
      throw new AppError(404, "Document not found", "NOT_FOUND");
    }

    await projectService.assertProjectMembership(
      userId,
      doc.projectId.toString(),
    );
    await DocumentModel.deleteOne({ _id: docId });

    res.status(200).json({ message: "Document deleted successfully" });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};
