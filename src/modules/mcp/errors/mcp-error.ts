export type McpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "conflict"
  | "rate_limited"
  | "internal_error"
  | "confirmation_required"
  | "approval_required";

const HTTP_STATUS_MAP: Record<McpErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 400,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
  confirmation_required: 202,
  approval_required: 202,
};

export class McpError extends Error {
  public readonly code: McpErrorCode;
  public readonly httpStatus: number;
  public readonly details?: unknown;

  constructor(code: McpErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.httpStatus = HTTP_STATUS_MAP[code];
    this.details = details;
    Object.setPrototypeOf(this, McpError.prototype);
  }
}

/**
 * Map a caught domain/HTTP error into an MCP semantic error.
 */
export function mapDomainError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  const domainError = error as { status?: number; message?: string };
  const message = domainError.message ?? "An unexpected error occurred";
  const status = domainError.status;

  if (status === 401) return new McpError("unauthorized", message);
  if (status === 403) return new McpError("forbidden", message);
  if (status === 404) return new McpError("not_found", message);
  if (status === 409) return new McpError("conflict", message);
  if (status === 429) return new McpError("rate_limited", message);
  if (status != null && status >= 400 && status < 500) {
    return new McpError("validation_error", message);
  }

  return new McpError("internal_error", message);
}
