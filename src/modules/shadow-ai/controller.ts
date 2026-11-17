import type { Request, Response } from "express";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { AppError } from "../../utils/app-error.js";
import { userIdOf } from "../agents/http.js";
import { consume } from "../agents/rate-limit.js";
import { KIND_LABELS } from "./catalog.js";
import * as service from "./service.js";

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
const q = (req: Request, name: string): string | undefined => {
  const value = req.query[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
const p = (req: Request, name: string): string =>
  String((req.params as Record<string, string | undefined>)[name] ?? "");
const actor = (req: AuthenticatedRequest) =>
  service.actorFor(
    userIdOf(req),
    q(req, "workspaceId") ??
      (typeof body(req).workspaceId === "string"
        ? (body(req).workspaceId as string)
        : undefined),
  );
const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data });

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;

/** A forwarder or scanner calls with a shadow AI token, not a person's login. */
async function tokenWorkspace(req: Request, cost: number): Promise<string> {
  const header = req.header("authorization");
  const raw =
    req.header("x-shadow-ai-token") ??
    (header?.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : undefined);
  const workspaceId = await service.workspaceOfToken(raw);
  if (!workspaceId)
    throw new AppError(
      401,
      "Invalid or revoked shadow AI token",
      "AUTH_REQUIRED",
    );
  const decision = await consume(
    `shadow-ingest:${workspaceId}`,
    Number(process.env.SHADOW_AI_INGEST_PER_MINUTE) || 30000,
    Date.now(),
    Math.max(1, cost),
  );
  if (!decision.allowed)
    throw new AppError(
      429,
      "Too many signals. Slow down and retry.",
      "RATE_LIMITED",
    );
  return workspaceId;
}

class ShadowAiController {
  public catalog: Handler = async (req, res) => {
    await actor(req);
    ok(res, {
      kinds: KIND_LABELS,
      tools: service.pickerOptions(),
      statuses: service.STATUSES,
      sources: ["network", "oauth", "cloud", "extension", "expense"],
    });
  };
  public overview: Handler = async (req, res) =>
    ok(res, await service.overview(await actor(req)));
  public getSettings: Handler = async (req, res) =>
    ok(res, await service.getSettings(await actor(req)));
  public updateSettings: Handler = async (req, res) =>
    ok(res, await service.updateSettings(await actor(req), body(req)));

  public tools: Handler = async (req, res) =>
    ok(
      res,
      await service.listTools(await actor(req), {
        status: q(req, "status"),
        q: q(req, "q"),
        kind: q(req, "kind"),
        source: q(req, "source"),
      }),
    );
  public tool: Handler = async (req, res) =>
    ok(res, await service.getTool(await actor(req), p(req, "id")));
  public decide: Handler = async (req, res) =>
    ok(res, await service.decide(await actor(req), p(req, "id"), body(req)));
  public reopen: Handler = async (req, res) =>
    ok(res, await service.reopen(await actor(req), p(req, "id"), body(req)));

  public importLog: Handler = async (req, res) =>
    ok(
      res,
      await service.importLog(
        await actor(req),
        typeof body(req).text === "string" ? (body(req).text as string) : "",
      ),
    );
  public signals: Handler = async (req, res) => {
    const a = await actor(req);
    if (!a.isAdmin)
      throw new AppError(
        403,
        "Only workspace owners and admins can do this",
        "FORBIDDEN",
      );
    const { source, signals } = service.parseSignalsBody(body(req));
    ok(res, await service.ingestSignals(a.workspaceId, source, signals));
  };
  public scan: Handler = async (req, res) => {
    const a = await actor(req);
    if (!a.isAdmin)
      throw new AppError(
        403,
        "Only workspace owners and admins can do this",
        "FORBIDDEN",
      );
    const { files, repo } = service.parseFilesBody(body(req));
    ok(res, await service.scanFiles(a.workspaceId, files, repo));
  };

  public tokens: Handler = async (req, res) =>
    ok(res, await service.listTokens(await actor(req)));
  public createToken: Handler = async (req, res) =>
    ok(res, await service.createToken(await actor(req), body(req)), 201);
  public revokeToken: Handler = async (req, res) =>
    ok(res, await service.revokeToken(await actor(req), p(req, "id")));

  public requests: Handler = async (req, res) =>
    ok(res, await service.listRequests(await actor(req), q(req, "status")));
  public declare: Handler = async (req, res) =>
    ok(res, await service.declare(await actor(req), body(req)), 201);
  public decideRequest: Handler = async (req, res) =>
    ok(
      res,
      await service.decideRequest(await actor(req), p(req, "id"), body(req)),
    );
  public withdrawRequest: Handler = async (req, res) =>
    ok(res, await service.withdrawRequest(await actor(req), p(req, "id")));

  public runMonitor: Handler = async (req, res) =>
    ok(res, await service.runMonitor(await actor(req)));

  public policy: Handler = async (req, res) => {
    const doc = await service.policy(
      await actor(req),
      q(req, "format") ?? "json",
    );
    res.setHeader("Content-Type", `${doc.type}; charset=utf-8`);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.name}"`);
    res.send(doc.body);
  };

  // Token endpoints: no login, a server-side token.
  public ingestSignals = async (req: Request, res: Response) => {
    const { source, signals } = service.parseSignalsBody(body(req));
    const workspaceId = await tokenWorkspace(req, signals.length);
    ok(res, await service.ingestSignals(workspaceId, source, signals));
  };
  public ingestCode = async (req: Request, res: Response) => {
    const { files, repo } = service.parseFilesBody(body(req));
    const workspaceId = await tokenWorkspace(req, files.length * 10);
    ok(res, await service.scanFiles(workspaceId, files, repo));
  };
}

export default new ShadowAiController();
