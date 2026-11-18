import type { Document } from "mongoose";
import { Schema, model } from "mongoose";

export interface ITemplateVariable {
  key: string;
  description: string;
  sample: string;
}

export interface IEmailTemplate {
  /** Stable name the code asks for, for example PROJECT_INVITATION. */
  code: string;
  name: string;
  description: string;
  subject: string;
  html: string;
  variables: ITemplateVariable[];
  /** Off means the app does not send this email. Not allowed for emails people need to sign in. */
  isActive: boolean;
  /** False for emails the app cannot work without (sign-in codes): they cannot be switched off. */
  canDisable: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEmailTemplateDocument extends IEmailTemplate, Document {}

const schema = new Schema<IEmailTemplateDocument>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    subject: { type: String, required: true, trim: true },
    html: { type: String, required: true },
    variables: {
      type: [{ key: String, description: String, sample: String, _id: false }],
      default: [],
    },
    isActive: { type: Boolean, default: true },
    canDisable: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const EmailTemplateModel = model<IEmailTemplateDocument>(
  "EmailTemplate",
  schema,
);
export default EmailTemplateModel;
