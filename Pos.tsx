import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "patagonia-api",
    version: "3.0.0",
    timestamp: new Date().toISOString()
  });
});
