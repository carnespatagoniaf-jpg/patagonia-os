import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ago,
  classifyScaleCause,
  describeBrands,
  filterOverview,
  groupByCause,
  parseReportLog,
  redactSensitive,
  scaleTrafficLight,
  type LightInput
} from "./scale-center";

// Mensajes reales de producción (etapa / mensaje que guarda MyScale.tsx y engine/friendly.ts).
const REAL: Array<[string, string, string]> = [
  ["conectar", 'No elegiste la balanza en la lista. Tocá "Conectar balanza" de nuevo y elegí la que dice USB.', "sin_puerto"],
  ["conectar", 'Esta computadora todavía no conoce el cable de esta balanza. Tocá "Elegir el cable" y elegila en la lista (la que dice USB).', "sin_puerto"],
  ["conectar", "Otro programa tiene tomada la balanza (por ejemplo Qendra, el programa de la balanza, u otra ventana de Chrome o Edge). Cerralo y probá de nuevo.", "otro_programa"],
  [
    "frenada",
    "Tu balanza está conectada y Patagonia pudo leerla, pero este modelo de Systel todavía no está comprobado para recibir productos. Para no arriesgar los productos y precios de tu balanza, no se le mandó nada.",
    "modelo_no_comprobado"
  ],
  ["sincronizar (frenado)", "Frenamos para cuidar tus productos: no se cambió nada más en la balanza. 4 productos no quedaron bien en la balanza (respuesta 21)", "rechazo_productos"],
  ["red (no aparece)", "no apareció ninguna balanza en la red", "red_no_aparece"],
  ["conectar", "No pudimos conectar tu balanza. Revisá que esté prendida y el cable enchufado, o contactá a soporte.", "no_contesta"],
  ["sincronizar", "La balanza no contesta en 192.168.0.50 (puerto 3001). Revisá que esté prendida, que el cable de red esté enchufado", "red_no_aparece"],
  ["sincronizar", "la balanza rechaza (E5): no cambió nada", "rechazo_productos"],
  ["conectar", "Algo no salió bien. Probá de nuevo o contactá a soporte.", "otro"]
];

test("causas: mensajes reales de producción", () => {
  for (const [stage, message, key] of REAL) {
    assert.equal(classifyScaleCause({ stage, message }).key, key, `${stage} / ${message}`);
  }
});

test("causas: cada una trae su solución en una línea", () => {
  const sol = (stage: string, message: string) => classifyScaleCause({ stage, message }).solution;
  assert.match(sol("conectar", "No elegiste la balanza en la lista"), /Instalar Scale Connect/);
  assert.match(sol("conectar", "Otro programa tiene tomada la balanza"), /Cerrar iTegra\/Qendra/);
  assert.match(sol("conectar", "No pudimos conectar tu balanza"), /Revisar cable USB\/adaptador/);
  assert.match(sol("red (no aparece)", ""), /Revisar IP \/ cable de red/);
  for (const [stage, message] of REAL) assert.ok(!sol(stage, message).includes("\n"));
});

test("causas: el técnico y la nota también cuentan; sin datos es Otro", () => {
  assert.equal(classifyScaleCause({ stage: "conectar", message: "Algo no salió bien", technical: "NetworkError: Failed to open serial port." }).key, "otro_programa");
  assert.equal(classifyScaleCause({ note: "Mis balanzas (Report) · conectar: NotFoundError: No port selected by the user." }).key, "sin_puerto");
  assert.equal(classifyScaleCause({}).key, "otro");
});

test("causas: agrupadas, primero las que tienen reportes sin resolver", () => {
  const reports = [
    { stage: "conectar", message: "No elegiste la balanza en la lista", resolvedAt: "2026-11-01" },
    { stage: "conectar", message: "No elegiste la balanza en la lista", resolvedAt: "2026-11-02" },
    { stage: "red (no aparece)", message: "", resolvedAt: null }
  ];
  const groups = groupByCause(reports, (r) => classifyScaleCause(r));
  assert.deepEqual(groups.map((g) => [g.cause.key, g.items.length, g.open]), [["red_no_aparece", 1, 1], ["sin_puerto", 2, 0]]);
});

const calm: LightInput = {
  lastJobStatus: "done", lastJobConfirmed: 10, lastJobRequested: 10, jobsFailed7d: 0, jobsStuck: 0,
  connectorsActive: 1, connectorsStale: 0, connectorVersionMin: "0.2.0", connectorVersionMax: "0.2.0", reportsOpen: 0, duplicateGroups: 0
};

test("semáforo: verde, amarillo y rojo con el motivo (mismo orden que la migración 230)", () => {
  assert.deepEqual(scaleTrafficLight(calm), { light: "verde", reason: "Sin problemas" });
  assert.deepEqual(scaleTrafficLight({ ...calm, lastJobStatus: null, connectorsActive: 0, connectorVersionMin: null, connectorVersionMax: null }), { light: "verde", reason: "Sin problemas" });
  assert.deepEqual(scaleTrafficLight({ ...calm, lastJobStatus: "failed", reportsOpen: 5 }), { light: "rojo", reason: "Falló el último envío a la balanza" });
  assert.equal(scaleTrafficLight({ ...calm, jobsStuck: 1 }).reason, "Hay envíos esperando una PC que no los toma");
  assert.equal(scaleTrafficLight({ ...calm, connectorsStale: 1 }).reason, "Ninguna PC con Scale Connect se conectó en el último día");
  assert.deepEqual(scaleTrafficLight({ ...calm, reportsOpen: 3 }), { light: "rojo", reason: "3 reportes sin resolver" });
  assert.deepEqual(scaleTrafficLight({ ...calm, reportsOpen: 1 }), { light: "amarillo", reason: "Hay un reporte sin resolver" });
  assert.equal(scaleTrafficLight({ ...calm, lastJobStatus: "partial", lastJobConfirmed: 18, lastJobRequested: 20 }).reason, "El último envío quedó a medias (18 de 20 confirmados)");
  assert.equal(scaleTrafficLight({ ...calm, jobsFailed7d: 2 }).reason, "2 envíos fallados en los últimos 7 días");
  assert.equal(scaleTrafficLight({ ...calm, connectorsActive: 2, connectorsStale: 1 }).reason, "Una PC con Scale Connect no se conecta hace más de un día");
  assert.equal(scaleTrafficLight({ ...calm, duplicateGroups: 1 }).light, "amarillo");
  assert.equal(scaleTrafficLight({ ...calm, connectorVersionMin: "0.9.0", connectorVersionMax: "0.10.0" }).reason, "Las PC tienen versiones distintas de Scale Connect");
});

test("lista: filtro con problemas, buscador sin tildes y rojos primero", () => {
  const rows = [
    { companyName: "Granja Verde", branchName: "Única", plan: "full", light: "verde" as const },
    { companyName: "Pollería Doña Rosa", branchName: "Viedma", plan: "basico", light: "amarillo" as const },
    { companyName: "Carnicería Roja", branchName: "Centro", plan: "estandar", light: "rojo" as const }
  ];
  assert.deepEqual(filterOverview(rows, { onlyProblems: false, query: "" }).map((r) => r.light), ["rojo", "amarillo", "verde"]);
  assert.deepEqual(filterOverview(rows, { onlyProblems: true, query: "" }).map((r) => r.companyName), ["Carnicería Roja", "Pollería Doña Rosa"]);
  assert.deepEqual(filterOverview(rows, { onlyProblems: false, query: "polleria" }).map((r) => r.companyName), ["Pollería Doña Rosa"]);
  assert.deepEqual(filterOverview(rows, { onlyProblems: false, query: "centro" }).map((r) => r.companyName), ["Carnicería Roja"]);
});

test("textos: marcas y hace cuánto", () => {
  assert.equal(describeBrands({ systel: 1, kretz: 2 }), "2 Kretz · 1 Systel");
  assert.equal(describeBrands({}), "Sin balanzas activas");
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(ago(null, now), "nunca");
  assert.equal(ago("2026-11-27T11:55:00Z", now), "hace 5 min");
  assert.equal(ago("2026-11-27T09:00:00Z", now), "hace 3 h");
  assert.equal(ago("2026-11-25T12:00:00Z", now), "hace 2 días");
});

// El mismo registro que tests/sql/230_admin_scale_center.sql.
const DIRTY = JSON.stringify({
  cuando: "2026-11-27T10:00:00Z",
  etapa: "sincronizar (frenado)",
  mensaje: "4 productos no quedaron bien en la balanza (respuesta 21)",
  tecnico: "token=abcDEF1234567890 Bearer eyJhbGciOi.eyJzdWIiOi.firma",
  cable: { ip: "169.254.137.200", com: "COM3" },
  email: "duenio@carniceria.com",
  password: "Secreta123",
  importe: 15300,
  detalle: "cobró $ 12.345,50 a CUIT 20-12345678-9, mail otro@gmail.com, +54 9 299 555-1234, o al 11 2787-1634",
  x: "00000000-0000-0000-0000-0000000f30c1.AbCdEfGhIjKlMnOpQrStUv",
  clave: "kretz-1",
  apiKey: "clave-de-prueba-AbC123xyZ987LmNoPqRsTuVw",
  mp: "APP_USR-1234567890123456-112714-AbCdEf0123456789abcdef0123456789-1234567",
  pasos: ["abrir puerto", "07 30 30 30 31 04"]
});

test("limpieza: sin credenciales, tokens, emails, teléfonos, CUIT ni importes", () => {
  const clean = redactSensitive(DIRTY);
  for (const bad of ["Secreta123", "abcDEF1234567890", "eyJhbGciOi", "duenio@carniceria.com", "otro@gmail.com", "2787-1634", "555-1234", "20-12345678-9", "12.345", "15300", "AbCdEfGhIjKlMnOpQrStUv", "clave-de-prueba-AbC123", "AbCdEf0123456789abcdef"]) {
    assert.ok(!clean.includes(bad), `quedó ${bad}: ${clean}`);
  }
  // Lo técnico queda.
  for (const good of ["sincronizar (frenado)", "respuesta 21", "169.254.137.200", "COM3", "07 30 30 30 31 04", "2026-11-27T10:00:00Z", '"clave":"kretz-1"']) {
    assert.ok(clean.includes(good), `se perdió ${good}: ${clean}`);
  }
  const parsed = JSON.parse(clean) as Record<string, unknown>;
  assert.equal(parsed.password, "[oculto]");
  assert.equal(parsed.importe, "[oculto]");
  assert.equal(parsed.x, "[credencial]");
});

test("limpieza: texto suelto, nulo e idempotente", () => {
  assert.equal(redactSensitive(null), "");
  assert.equal(redactSensitive("password: hola123 · ok"), "password: [oculto] · ok");
  assert.equal(redactSensitive("Llamar al (0299) 15 555-1234"), "Llamar al [teléfono]");
  const once = redactSensitive(DIRTY);
  assert.equal(redactSensitive(once), once);
  // Fechas, horas, IP y números de producto no son teléfonos.
  const tech = "2026-11-27 10:00:00 · 192.168.0.50:3001 · PLU 0001-0002 · peso 1.250 kg";
  assert.equal(redactSensitive(tech), tech);
});

test("registro: etapa, mensaje, técnico, cable y pasos del JSON de MyScale (ya limpio)", () => {
  const log = parseReportLog(JSON.stringify({
    etapa: "conectar",
    mensaje: "No elegiste la balanza en la lista",
    tecnico: "NotFoundError: No port selected by the user.",
    cable: { usb: "FTDI 0403:6001" },
    version: "2026-11-27",
    pasos: [{ label: "Abrir puerto", ok: false, detail: "no se eligió" }, "listo"],
    email: "a@b.com"
  }));
  assert.equal(log.isJson, true);
  assert.equal(log.stage, "conectar");
  assert.equal(log.message, "No elegiste la balanza en la lista");
  assert.equal(log.cable, '{"usb":"FTDI 0403:6001"}');
  assert.deepEqual(log.steps, ["✗ Abrir puerto: no se eligió", "listo"]);
  assert.ok(!log.pretty.includes("a@b.com"));
  assert.ok(log.pretty.includes("\n  "));
});

test("registro: texto viejo y JSON roto quedan como texto", () => {
  const old = parseReportLog("10:01 detectar · Kretz Report · mail duenio@x.com");
  assert.equal(old.isJson, false);
  assert.equal(old.pretty, "10:01 detectar · Kretz Report · mail [email]");
  assert.equal(parseReportLog('{"etapa": "con').isJson, false);
});
