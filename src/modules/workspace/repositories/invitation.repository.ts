import type { ClientSession } from "mongoose";
import InvitationModel, {
  type IInvitationDocument,
} from "../../../modules/workspace/models/invitation.model.js";
import { resolveProjectObjectId } from "../../../utils/project-id.js";

export interface CreateInvitationPayload {
  projectId: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  token: string;
  invitedBy: string;
}

export const createInvitation = async (
  payload: CreateInvitationPayload,
  session?: ClientSession | null,
): Promise<IInvitationDocument> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(payload.projectId)) || payload.projectId;
  return InvitationModel.create(
    [{ ...payload, projectId: resolvedProjectId, status: "PENDING" }],
    { session },
  ).then(([invitation]) => invitation);
};

export const getInvitationByToken = async (
  token: string,
): Promise<IInvitationDocument | null> =>
  InvitationModel.findOne({ token }).exec();

export const getInvitationByProjectAndEmail = async (
  projectId: string,
  email: string,
): Promise<IInvitationDocument | null> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return InvitationModel.findOne({
    email: email.toLowerCase().trim(),
    projectId: resolvedProjectId,
  }).exec();
};

export const getPendingInvitationsByEmail = async (
  email: string,
): Promise<IInvitationDocument[]> =>
  InvitationModel.find({
    email: email.toLowerCase().trim(),
    status: "PENDING",
  }).exec();

export const updateInvitationStatus = async (
  invitationId: string,
  status: "PENDING" | "ACCEPTED" | "REJECTED",
  session?: ClientSession | null,
): Promise<IInvitationDocument | null> =>
  InvitationModel.findByIdAndUpdate(
    invitationId,
    { status },
    { new: true, session },
  ).exec();

export const getPendingInvitationsByProject = async (
  projectId: string,
): Promise<IInvitationDocument[]> => {
  const resolvedProjectId =
    (await resolveProjectObjectId(projectId)) || projectId;
  return InvitationModel.find({
    projectId: resolvedProjectId,
    status: "PENDING",
  })
    .sort({ createdAt: -1 })
    .exec();
};

export const deleteInvitationById = async (
  invitationId: string,
): Promise<IInvitationDocument | null> =>
  InvitationModel.findByIdAndDelete(invitationId).exec();
