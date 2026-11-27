import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { listDuplicateScaleCandidates, markScalesDistinct, mergeBranchScales } from "./registry/branch-scales";
import { duplicateNotice, mergeResultText, type DuplicateGroup } from "./registry/scale-merge";

/**
 * "Encontramos N registros que parecen la misma balanza" (migración 225), arriba de la lista de "Mis balanzas".
 * Solo dueño o administrador (la base exige lo mismo). Un grupo por vez: "Unir" (eligiendo cuál queda) o
 * "Son distintas" (queda guardado en la base y no se vuelve a preguntar). Sin la migración no aparece nada.
 */
export function DuplicateScalesNotice({ branchId, onChanged }: { branchId: string; onChanged: () => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [keep, setKeep] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setGroups(await listDuplicateScaleCandidates(branchId));
    } catch {
      setGroups([]);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const group = groups[0] ?? null;
  const notice = group ? duplicateNotice(group) : null;
  const keepKey = notice && keep && notice.rows.some((r) => r.key === keep) ? keep : (notice?.suggestedKeep ?? null);

  async function merge() {
    if (!group || !keepKey) return;
    const keepName = group.scales.find((s) => s.key === keepKey)?.name ?? keepKey;
    const others = group.scales.filter((s) => s.key !== keepKey).map((s) => s.key);
    if (!window.confirm(`¿Unir ${others.length === 1 ? "el otro registro" : `los otros ${others.length} registros`} a "${keepName}"?\n\nQueda una sola balanza con ese nombre. Los productos reconocidos, las ventas y los envíos pasan a esa. En la balanza no se cambia nada.`)) return;
    setBusy(true);
    try {
      const r = mergeResultText(await mergeBranchScales(branchId, keepKey, others), keepName);
      setResult(r);
      if (r.ok) {
        setKeep(null);
        onChanged();
        await load();
      }
    } catch {
      setResult({ ok: false, text: "No se pudieron unir. Revisá la conexión y probá de nuevo. No se cambió nada." });
    } finally {
      setBusy(false);
    }
  }

  async function distinct() {
    if (!group) return;
    setBusy(true);
    try {
      await markScalesDistinct(branchId, group.scales.map((s) => s.key));
      setResult({ ok: true, text: "Listo: quedan como balanzas distintas y no te preguntamos más." });
      setKeep(null);
      await load();
    } catch {
      setResult({ ok: false, text: "No se pudo guardar. Revisá la conexión y probá de nuevo." });
    } finally {
      setBusy(false);
    }
  }

  if (!notice) {
    return result?.ok ? <p className="my-scale-status ok"><CheckCircle2 size={20} /> {result.text}</p> : null;
  }
  return (
    <div className="my-scale-review" role="group" aria-label="Registros repetidos de una balanza">
      <p className="my-scale-status"><TriangleAlert size={20} /> {notice.title}</p>
      <p className="muted">{notice.help}</p>
      <ul className="my-scale-notes">
        {notice.rows.map((r) => (
          <li key={r.key}>
            {notice.canMerge ? (
              <label className="my-scale-check">
                <input type="radio" name="duplicate-keep" checked={keepKey === r.key} disabled={busy} onChange={() => setKeep(r.key)} />
                <span>
                  <strong>{r.name}</strong> <span className="muted">· {r.lastUse}</span>
                </span>
              </label>
            ) : (
              <span>
                <strong>{r.name}</strong> <span className="muted">· {r.lastUse}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {notice.canMerge && <p className="muted">Queda la marcada.</p>}
      {result && <p className={result.ok ? "my-scale-status ok" : "my-scale-warning"}>{result.text}</p>}
      <div className="my-scale-actions">
        {notice.canMerge && (
          <button className="my-scale-primary" disabled={busy} onClick={() => void merge()}>
            Unir
          </button>
        )}
        <button className="secondary" disabled={busy} onClick={() => void distinct()}>
          Son distintas
        </button>
      </div>
    </div>
  );
}
