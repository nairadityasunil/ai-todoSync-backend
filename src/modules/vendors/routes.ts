import express, { Router } from "express";

import type { Routes } from "../../interfaces/routes.interface.js";
import authMiddleware from "../../middleware/auth.middleware.js";
import vendorController from "./controller.js";
import { MAX_EVIDENCE_BYTES } from "./evidence.service.js";

/**
 * Third-party risk management. Workspace owners and admins only; agents are
 * refused by the REST guard (they must not approve their own vendor).
 */
class VendorRoutes implements Routes {
  public path = "/api/vendors";
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    const c = vendorController;
    this.router.use(authMiddleware);

    this.router.get("/", c.list);
    this.router.post("/", c.create);
    this.router.get("/catalog", c.catalog);
    this.router.get("/export", c.exportRegister);
    this.router.get("/subprocessors", c.subprocessors);

    this.router.get("/:vendorId", c.detail);
    this.router.patch("/:vendorId", c.update);
    this.router.delete("/:vendorId", c.remove);
    this.router.post("/:vendorId/status", c.setStatus);
    this.router.put("/:vendorId/assessment", c.saveAssessment);
    this.router.post(
      "/:vendorId/evidence",
      // The file is the body; the service checks type, content and size.
      express.raw({ type: () => true, limit: MAX_EVIDENCE_BYTES + 1024 }),
      c.uploadEvidence,
    );
    this.router.get("/:vendorId/evidence/:evidenceId", c.downloadEvidence);
    this.router.delete("/:vendorId/evidence/:evidenceId", c.deleteEvidence);
  }
}

export default VendorRoutes;
