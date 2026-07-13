import express from "express";
import { healthRouter } from "./modules/health/router.js";
import { salesRouter } from "./modules/sales/router.js";

const app = express();
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/sales", salesRouter);

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Patagonia API escuchando en http://localhost:${port}`);
});
