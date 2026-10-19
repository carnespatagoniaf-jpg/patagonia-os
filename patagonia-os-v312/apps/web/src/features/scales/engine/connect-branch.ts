import { bindingFor, restoreBinding, type ScaleBinding } from "../registry/local-bindings";
import { findRegistered, legacyCandidate, sameIdentity, type BranchScale, type ScaleFamily } from "../registry/scale-identity";
import { serialApi, type SerialApi } from "./engine";
import { FriendlyError, friendlyKind } from "./friendly";
import { usbKeyOf } from "./memory";
import { emptyDiag, type ConnectDiag, type EngineContext, type ProgressFn, type ScaleAdapter, type ScaleSession } from "./types";

/**
 * Conectar UNA balanza de la sucursal (una registrada, o una nueva al "Agregar balanza").
 *
 * Reglas (ver docs/BALANZAS_DIAGNOSTICO_2026-10-19.md):
 * - El cable se busca primero entre los que esta computadora ya autorizó y que coinciden con el de ESA balanza; la
 *   lista de Chrome se abre solo si hace falta (agregar, o "Elegir el cable"), porque Chrome exige un click.
 * - Antes de abrir el puerto se les pide a las otras pantallas y pestañas de Patagonia que lo suelten.
 * - Antes de hablarle se restaura la configuración de conexión de ESA balanza (otra balanza pudo cambiarla).
 * - La balanza que contesta tiene que ser la elegida: se compara lo que contesta (número de balanza, letra) con lo
 *   registrado.
 * - "Agregar balanza" registra SIEMPRE una balanza nueva: el número y el chip del cable no alcanzan para decir que es
 *   la misma (real, Los gringos 19/10: una Systel nueva contestó N.º 20 por un FT232R, igual que la que ya tenían).
 *   Si se parece a una registrada, solo se avisa (`lookalike`).
 * - Todo lo técnico queda en `ctx.diag` para el reporte a soporte.
 */

export interface BranchConnectResult {
  session: ScaleSession;
  family: ScaleFamily;
  usb: string | null;
  identity: Record<string, unknown>;
  /** La balanza registrada que es esta: al reconectar, la elegida; al agregar, null (siempre es nueva). */
  matched: BranchScale | null;
  /** Al agregar: una registrada de la misma marca con el mismo número (o sin número guardado). Solo para avisar. */
  lookalike: BranchScale | null;
  diag: ConnectDiag;
  /** El contexto que tiene la sesión: al registrar una balanza nueva se le pone su clave (las Systel la usan al guardar). */
  ctx: EngineContext;
}

export interface BranchConnectDeps {
  adapters: ScaleAdapter[];
  serial?: SerialApi | null;
  /** Pedir a esta pestaña y a las demás que suelten los puertos (serial-tabs.releaseSerialEverywhere). */
  release?: () => Promise<{ localReleased: number; otherTabs: { busy: number }[] }>;
  binding?: (scaleKey: string, branchId: string) => ScaleBinding | null;
  restore?: (b: ScaleBinding) => void;
}

const FTDI = "0403:";

/** El chip del cable sugiere la marca: la Cuora Max trae FTDI (documentado por Systel); las Kretz de los clientes, otros. */
export function portFitsFamily(usb: string | null, family: ScaleFamily): boolean {
  if (!usb) return true;
  return family === "systel" ? usb.startsWith(FTDI) : !usb.startsWith(FTDI);
}

/** Puerto tomado: si una pestaña de Patagonia contestó que lo tiene en uso, es ella; si no, es otro programa. */
export function busyKind(otherTabs: { busy: number }[] | undefined): "puerto_ocupado" | "puerto_otro_programa" {
  return (otherTabs ?? []).some((t) => t.busy > 0) ? "puerto_ocupado" : "puerto_otro_programa";
}

/**
 * Qué cables probar sin abrir la lista de Chrome. Vacío = hay que elegirlo (Chrome lo pide con un click).
 * Con la balanza ya conectada antes en esta computadora: solo los cables iguales al de esa vez.
 */
export function candidatePorts(granted: SerialPort[], target: BranchScale, binding: ScaleBinding | null): SerialPort[] {
  if (binding) return binding.usb ? granted.filter((p) => usbKeyOf(p) === binding.usb) : granted;
  return granted.filter((p) => portFitsFamily(usbKeyOf(p), target.family));
}

export async function connectBranchScale(
  ctxIn: EngineContext,
  onProgress: ProgressFn,
  opts: { target: BranchScale | null; known: BranchScale[]; pick: boolean },
  deps: BranchConnectDeps
): Promise<BranchConnectResult> {
  const serial = deps.serial === undefined ? serialApi() : deps.serial;
  if (!serial) throw new FriendlyError("sin_navegador");
  const diag = ctxIn.diag ?? emptyDiag();
  const { target } = opts;
  const ctx: EngineContext = { ...ctxIn, diag, scaleKey: target?.key };
  const binding = target && ctx.branchId ? (deps.binding ?? bindingFor)(target.key, ctx.branchId) : null;

  // 1. El cable. Lo primero (Chrome solo muestra la lista enseguida de un click).
  let ports: SerialPort[];
  if (opts.pick || !target) {
    onProgress("permiso", "Elegí tu balanza en la lista y tocá \"Conectar\".");
    try {
      ports = [await serial.requestPort()];
    } catch (err) {
      throw new FriendlyError("sin_eleccion", err instanceof Error ? err.message : String(err));
    }
    diag.authorized = (await serial.getPorts()).map(usbKeyOf);
  } else {
    const granted = await serial.getPorts();
    diag.authorized = granted.map(usbKeyOf);
    ports = candidatePorts(granted, target, binding);
    diag.steps.push(`cables autorizados ${granted.length}, candidatos ${ports.length}${binding ? ` (recordado ${binding.usb ?? "sin USB"})` : " (sin recordar)"}`);
    if (ports.length === 0) throw new FriendlyError("elegir_cable", "sin cable recordado para esta balanza en esta computadora");
  }

  // 2. Que lo suelten las otras pantallas y pestañas de Patagonia.
  if (deps.release) {
    try {
      const r = await deps.release();
      diag.otherTabs = r;
      diag.steps.push(`pedido de soltar: esta pestaña ${r.localReleased}, otras ${r.otherTabs.length}`);
    } catch {
      // sin respuesta: se intenta igual
    }
  }

  // 3. La configuración de conexión de ESA balanza.
  if (binding) (deps.restore ?? restoreBinding)(binding);

  const families: ScaleFamily[] = target ? [target.family] : ["systel", "kretz"];
  let busyErr: unknown = null;
  let wrongScale = false;
  const errors: string[] = [];
  for (const port of ports) {
    const usb = usbKeyOf(port);
    diag.usb = usb;
    const order = target ? families : usb?.startsWith(FTDI) ? ["systel", "kretz"] : ["kretz", "systel"];
    const adapters = order.flatMap((f) => deps.adapters.filter((a) => a.family === f));
    for (const adapter of adapters) {
      let session: ScaleSession | null = null;
      try {
        session = await adapter.identify(port, ctx, onProgress);
      } catch (err) {
        if (friendlyKind(err) === "puerto_ocupado") {
          busyErr = err;
          diag.steps.push(`${adapter.family}: puerto ocupado (${usb ?? "?"})`);
          break;
        }
        errors.push(`${adapter.family}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!session) continue;
      const identity = session.identity?.() ?? {};
      if (target && Object.keys(target.identity).length > 0 && Object.keys(identity).length > 0 && !sameIdentity(target.identity, identity)) {
        // Contestó OTRA balanza (dos cables iguales en la misma computadora): se suelta y se prueba el siguiente cable.
        diag.steps.push(`contestó otra balanza ${JSON.stringify(identity)} en ${usb ?? "?"}; se buscaba ${JSON.stringify(target.identity)}`);
        wrongScale = true;
        await session.close().catch(() => {});
        continue;
      }
      const family = adapter.family;
      const matched = target;
      const lookalike = target ? null : findRegistered(opts.known, family, identity) ?? legacyCandidate(opts.known, family);
      diag.steps.push(`conectada: ${family} ${JSON.stringify(identity)}${matched ? ` = ${matched.key}` : " (nueva)"}${lookalike ? `, parecida a ${lookalike.key}` : ""}`);
      return { session, family, usb, identity, matched, lookalike, diag, ctx };
    }
  }
  if (busyErr) {
    const kind = busyKind((diag.otherTabs as { otherTabs?: { busy: number }[] } | undefined)?.otherTabs);
    throw new FriendlyError(kind, busyErr instanceof Error ? busyErr.message : String(busyErr));
  }
  if (wrongScale) throw new FriendlyError("otra_balanza", diag.steps.join(" · "));
  throw new FriendlyError("no_contesta", errors.join(" · ") || "ninguna balanza contestó");
}
