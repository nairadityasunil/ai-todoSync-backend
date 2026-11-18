/**
 * What a project member may use. Admins always have everything; for members the project admin
 * switches each feature on or off. A member with nothing stored gets the defaults, so existing
 * projects behave as before.
 */
export const PROJECT_FEATURES = [
  "team",
  "time",
  "prompts",
  "aiPlanner",
] as const;
export type ProjectFeature = (typeof PROJECT_FEATURES)[number];
export type ProjectPermissions = Record<ProjectFeature, boolean>;

/** Members could already use time, prompts and the AI planner; only managing the team was admin-only. */
export const DEFAULT_MEMBER_PERMISSIONS: ProjectPermissions = {
  team: false,
  time: true,
  prompts: true,
  aiPlanner: true,
};

const ALL_ON: ProjectPermissions = {
  team: true,
  time: true,
  prompts: true,
  aiPlanner: true,
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
