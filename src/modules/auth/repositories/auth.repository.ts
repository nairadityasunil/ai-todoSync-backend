import UserModel, { IUserDocument } from "../models/user.model.js";

export interface CreateUserPayload {
  email: string;
  password: string | null;
  authProvider?: "local" | "google";
  googleId?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export const createUser = async (
  payload: CreateUserPayload,
): Promise<IUserDocument> => UserModel.create(payload);

export const findUserByEmail = async (
  email: string,
): Promise<IUserDocument | null> => UserModel.findOne({ email }).exec();

export const findUserByGoogleId = async (
  googleId: string,
): Promise<IUserDocument | null> => UserModel.findOne({ googleId }).exec();

export const findUserById = async (id: string): Promise<IUserDocument | null> =>
  UserModel.findById(id).exec();

export const searchUsersByEmail = async (
  query: string,
  limit = 10,
): Promise<IUserDocument[]> =>
  UserModel.find({
    email: {
      $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    },
  })
    .sort({ email: 1, _id: 1 })
    .limit(limit)
    .exec();

export const updateUser = async (
  userId: string,
  data: Partial<CreateUserPayload>,
): Promise<IUserDocument | null> =>
  UserModel.findByIdAndUpdate(userId, data, { new: true }).exec();
