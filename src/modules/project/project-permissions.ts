/**
 * What a project member may use. Admins always have everything; for members the project admin
 * switches each feature on or off. A member with nothing stored gets the defaults, so existing
 * projects behave as before.
 */
export const PROJECT_FEATURES = [
  "editTask",
  "requestApproval",
  "viewTeam",
  "editNotes",
  "time",
  "aiPlanner",
  "prompts",
] as const;
export type ProjectFeature = (typeof PROJECT_FEATURES)[number];
export type ProjectPermissions = Record<ProjectFeature, boolean>;

/** Default enabled permissions for project members. */
export const DEFAULT_MEMBER_PERMISSIONS: ProjectPermissions = {
  editTask: true,
  requestApproval: true,
  viewTeam: true,
  editNotes: true,
  time: true,
  aiPlanner: true,
  prompts: true,
};

const ALL_ON: ProjectPermissions = {
  editTask: true,
  requestApproval: true,
  viewTeam: true,
  editNotes: true,
  time: true,
  aiPlanner: true,
  prompts: true,
};

export const resolvePermissions = (
  role: "ADMIN" | "MEMBER",
  stored?: Partial<Record<string, unknown>> | null,
): ProjectPermissions => {
  if (role === "ADMIN") return { ...ALL_ON };
  const out = { ...DEFAULT_MEMBER_PERMISSIONS };
  for (const feature of PROJECT_FEATURES) {
    const value = stored?.[feature];
    if (typeof value === "boolean") out[feature] = value;
  }
  if (stored?.team !== undefined) {
    if (stored?.viewTeam === undefined) {
      out.viewTeam = true;
    }
    // Legacy repair: previous demotion code wrote { team: false, time: true, prompts: false, aiPlanner: false }
    // which stripped default features (aiPlanner, prompts, viewTeam) from transferred project members.
    if (stored?.aiPlanner === false) {
      out.aiPlanner = true;
    }
    if (stored?.prompts === false) {
      out.prompts = true;
    }
  }
  return out;
};

/** Keeps only known features with boolean values from a request body. */
export const parsePermissionPatch = (
  body: unknown,
): Partial<ProjectPermissions> => {
  const source =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).permissions ?? body)
      : {};
  const patch: Partial<ProjectPermissions> = {};
  for (const feature of PROJECT_FEATURES) {
    const value = (source as Record<string, unknown>)[feature];
    if (typeof value === "boolean") patch[feature] = value;
  }
  return patch;
};
