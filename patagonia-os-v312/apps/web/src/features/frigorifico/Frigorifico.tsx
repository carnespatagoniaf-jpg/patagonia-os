import { useCallback, useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { localDateIso } from "../shifts/format";
import { FrigoCamaras, FrigoDts, FrigoTraza } from "./FrigoParts";
import { FrigoFaena } from "./FrigoFaena";
import { FrigoSalidas } from "./FrigoSalidas";
import { CamaraCards, errorText, type FrigoData } from "./FrigoShared";
import { formatKg, inStock, sumKg } from "./frigo-logic";
import { listCamaras, listDts, listMedias, listSalidas } from "./frigo-service";

// Frigorífico (migración 169, a pedido: solo la ve la empresa con
// 'frigorifico' en companies.features). Ciclo: DT de carga → faena (tropa,
// garrón y kilo de cada media, con etiqueta) → cámara → salida a un cliente
// (cuenta corriente en Clientes) o a una carnicería propia (ciclo 2).

export type FrigoTab = "resumen" | "dt" | "faena" | "camaras" | "salidas" | "traza";

const TABS: { id: FrigoTab; label: string }[] = [
  { id: "resumen", label: "Resumen" },
  { id: "dt", label: "DT de carga" },
  { id: "faena", label: "Faena y etiquetas" },
  { id: "camaras", label: "Cámaras" },
  { id: "salidas", label: "Salidas" },
  { id: "traza", label: "Trazabilidad" }
];

export function Frigorifico() {
  const [tab, setTab] = useState<FrigoTab>("resumen");
  const [data, setData] = useState<FrigoData>({ camaras: [], dts: [], medias: [], salidas: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [faenaDtId, setFaenaDtId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    try {
      const [camaras, dts, medias, salidas] = await Promise.all([listCamaras(), listDts(), listMedias(), listSalidas()]);
      setData({ camaras, dts, medias, salidas });
      setError("");
    } catch (err) {
      setError(errorText(err, "No se pudieron cargar los datos del frigorífico."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function startFaena(dtId: string) {
    setFaenaDtId(dtId);
    setTab("faena");
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <p className="eyebrow">FRIGORÍFICO</p>
          <h1>Frigorífico</h1>
          <p className="muted">Stock de medias reses por tropa, garrón y kilo: desde el DT de carga hasta la salida a un cliente o a tu carnicería.</p>
        </div>
      </header>

      {!isSupabaseConfigured && <div className="message">Modo demostración: el frigorífico necesita la base conectada.</div>}
      {error && <div className="message">{error}</div>}

      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 16px" }}>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "" : "secondary"} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <p className="muted">Cargando…</p>
      ) : (
        <>
          {tab === "resumen" && <Resumen data={data} onGo={setTab} onFaenar={startFaena} />}
          {tab === "dt" && <FrigoDts dts={data.dts} onChanged={reload} onFaenar={startFaena} />}
          {tab === "faena" && <FrigoFaena data={data} dtId={faenaDtId} onSelectDt={setFaenaDtId} onChanged={reload} />}
          {tab === "camaras" && <FrigoCamaras data={data} onChanged={reload} />}
          {tab === "salidas" && <FrigoSalidas data={data} onChanged={reload} />}
          {tab === "traza" && <FrigoTraza data={data} />}
        </>
      )}
    </div>
  );
}

function Resumen({ data, onGo, onFaenar }: { data: FrigoData; onGo: (t: FrigoTab) => void; onFaenar: (dtId: string) => void }) {
  const stock = inStock(data.medias);
  const pending = data.dts.filter((d) => d.status === "pendiente");
  const today = localDateIso();
  const todaySalidas = data.salidas.filter((s) => s.salidaDate === today && !s.voidedAt);
  const activeCamaras = data.camaras.filter((c) => c.active);

  return (
    <>
      <section className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Kpi title="Medias en cámara" value={String(stock.length)} detail={`${formatKg(sumKg(stock))} kg`} />
        <Kpi title="DT para faenar" value={String(pending.length)} detail={`${pending.reduce((t, d) => t + d.heads, 0)} animales`} />
        <Kpi title="Salidas de hoy" value={String(todaySalidas.length)} detail={`${formatKg(todaySalidas.reduce((t, s) => t + s.totalKg, 0))} kg`} />
        <Kpi title="Cámaras" value={String(activeCamaras.length)} detail={activeCamaras.length ? "activas" : "cargalas en Cámaras"} />
      </section>

      {activeCamaras.length === 0 && (
        <div className="message">
          Para empezar, cargá tus cámaras (1, 2, 3, 4…).{" "}
          <button className="link-button" onClick={() => onGo("camaras")}>Ir a Cámaras</button>
        </div>
      )}

      <section className="panel">
        <div className="panel-title"><h2>Stock por cámara</h2></div>
        <CamaraCards data={data} />
      </section>

      {pending.length > 0 && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title"><h2>DT para faenar</h2></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {pending.map((d) => (
              <button key={d.id} onClick={() => onFaenar(d.id)}>
                Faenar {d.dtNumber} · {d.producer} · {d.heads} {d.category.toLowerCase()}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Kpi({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="panel" style={{ padding: "14px 16px" }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{title}</p>
      <strong style={{ fontSize: 26 }}>{value}</strong>
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{detail}</p>
    </div>
  );
}
