import { Router } from "express";
import { z } from "zod";

export const salesRouter = Router();

const saleSchema = z.object({
  branchId: z.string().uuid(),
  paymentMethod: z.enum(["cash", "qr", "debit", "credit", "bank_province", "transfer"]),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative()
    })
  ).min(1)
});

salesRouter.post("/", async (req, res) => {
  const parsed = saleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
  }

  // Implementación definitiva:
  // llamar una función SQL transaccional para validar stock,
  // crear la venta, descontar inventario y generar caja.
  return res.status(501).json({
    error: "Supabase pendiente de conexión",
    payloadValidated: parsed.data
  });
});
