import type { Document, Types } from "mongoose";
import { Schema, model } from "mongoose";

export type ProjectRole = "ADMIN" | "MEMBER";

export interface IProjectMember {
  projectId: Types.ObjectId | string;
  userId: Types.ObjectId | string;
  role: ProjectRole;
  /** Feature switches set by the project admin; unset means the default. */
  permissions?: Partial<
    Record<"team" | "time" | "prompts" | "aiPlanner", boolean>
  >;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IProjectMemberDocument extends IProjectMember, Document {}

const projectMemberSchema = new Schema<IProjectMemberDocument>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Project",
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    role: {
      type: String,
      enum: ["ADMIN", "MEMBER"],
      required: true,
      default: "MEMBER",
    },
    permissions: {
      type: new Schema(
        {
          team: { type: Boolean },
          time: { type: Boolean },
          prompts: { type: Boolean },
          aiPlanner: { type: Boolean },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

projectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });
projectMemberSchema.index({ userId: 1, projectId: 1 });
projectMemberSchema.index({ projectId: 1, role: 1 });

const ProjectMemberModel = model<IProjectMemberDocument>(
  "ProjectMember",
  projectMemberSchema,
);

export default ProjectMemberModel;
