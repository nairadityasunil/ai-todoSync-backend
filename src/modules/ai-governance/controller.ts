import type { Response } from "express";

import type { AuthenticatedRequest } from "../../types/auth.js";
import { toCsv } from "../../utils/csv.js";
import { userIdOf } from "../agents/http.js";
import { EU_QUESTIONS, RISK_QUESTIONS } from "./catalog.js";
import * as service from "./service.js";

const body = (req: AuthenticatedRequest): Record<string, unknown> =>
  req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
const q = (req: AuthenticatedRequest, name: string): string | undefined => {
  const value = req.query[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
const p = (req: AuthenticatedRequest, name: string): string =>
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

/** AI governance: use case inventory, assessments, risks, approvals, evaluations, issues and reports. */
class AiGovernanceController {
  public catalog: Handler = async (req, res) => {
    await actor(req);
    ok(res, {
      ...service.catalogView(),
      riskQuestions: RISK_QUESTIONS,
      euQuestions: EU_QUESTIONS,
    });
  };
  public overview: Handler = async (req, res) =>
    ok(res, await service.overview(await actor(req)));
  public ungoverned: Handler = async (req, res) =>
    ok(res, await service.ungoverned(await actor(req)));
  public assets: Handler = async (req, res) =>
    ok(res, await service.assets(await actor(req)));
  public getSettings: Handler = async (req, res) =>
    ok(res, await service.getSettings(await actor(req)));
  public updateSettings: Handler = async (req, res) =>
    ok(res, await service.updateSettings(await actor(req), body(req)));

  public list: Handler = async (req, res) =>
    ok(
      res,
      await service.listUseCases(await actor(req), {
        stage: q(req, "stage"),
        tier: q(req, "tier"),
        q: q(req, "q"),
      }),
    );
  public create: Handler = async (req, res) =>
    ok(res, await service.createUseCase(await actor(req), body(req)), 201);
  public get: Handler = async (req, res) =>
    ok(res, await service.getUseCase(await actor(req), p(req, "id")));
  public update: Handler = async (req, res) =>
    ok(
      res,
      await service.updateUseCase(await actor(req), p(req, "id"), body(req)),
    );
  public remove: Handler = async (req, res) =>
    ok(res, await service.deleteUseCase(await actor(req), p(req, "id")));

  public assessment: Handler = async (req, res) =>
    ok(
      res,
      await service.saveAssessment(await actor(req), p(req, "id"), body(req)),
    );
  public suggestedRisks: Handler = async (req, res) =>
    ok(res, await service.suggestedRisks(await actor(req), p(req, "id")));
  public addRisks: Handler = async (req, res) =>
    ok(
      res,
      await service.addRisks(await actor(req), p(req, "id"), body(req)),
      201,
    );
  public updateRisk: Handler = async (req, res) =>
    ok(
      res,
      await service.updateRisk(
        await actor(req),
        p(req, "id"),
        p(req, "riskId"),
        body(req),
      ),
    );
  public removeRisk: Handler = async (req, res) =>
    ok(
      res,
      await service.removeRisk(
        await actor(req),
        p(req, "id"),
        p(req, "riskId"),
      ),
    );

  public decide: Handler = async (req, res) =>
    ok(res, await service.decide(await actor(req), p(req, "id"), body(req)));
  public advance: Handler = async (req, res) =>
    ok(res, await service.advance(await actor(req), p(req, "id")));
  public transition: Handler = async (req, res) =>
    ok(
      res,
      await service.transition(await actor(req), p(req, "id"), body(req)),
    );
  public attest: Handler = async (req, res) =>
    ok(res, await service.attest(await actor(req), p(req, "id"), body(req)));

  public ingest: Handler = async (req, res) =>
    ok(
      res,
      await service.ingestRecords(await actor(req), p(req, "id"), body(req)),
      201,
    );
  public records: Handler = async (req, res) =>
    ok(
      res,
      await service.listRecords(await actor(req), p(req, "id"), {
        flagged: q(req, "flagged") === "true",
        limit: Number(q(req, "limit")) || undefined,
      }),
    );
  public evaluate: Handler = async (req, res) =>
    ok(res, await service.runEvaluation(await actor(req), p(req, "id")));
  public baseline: Handler = async (req, res) =>
    ok(res, await service.setBaseline(await actor(req), p(req, "id")));

  public factsheet: Handler = async (req, res) => {
    const doc = await service.factsheetMarkdown(await actor(req), p(req, "id"));
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${doc.filename}"`,
    );
    res.send(doc.body);
  };
  public exportInventory: Handler = async (req, res) => {
    const { header, rows } = await service.inventoryRows(await actor(req));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ai-use-cases-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(toCsv(header, rows));
  };

  public listIssues: Handler = async (req, res) =>
    ok(
      res,
      await service.listIssues(await actor(req), {
        status: q(req, "status"),
        useCaseId: q(req, "useCaseId"),
      }),
    );
  public createIssue: Handler = async (req, res) =>
    ok(res, await service.createIssue(await actor(req), body(req)), 201);
  public updateIssue: Handler = async (req, res) =>
    ok(
      res,
      await service.updateIssue(await actor(req), p(req, "issueId"), body(req)),
    );
}

export default new AiGovernanceController();
