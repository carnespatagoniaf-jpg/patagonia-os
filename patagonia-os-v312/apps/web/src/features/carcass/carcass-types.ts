/**
 * Qué se desposta (media res, cerdo, pollo…): los botones de Despiece y de Compras ("Para despostar").
 * Puro, sin Supabase, para poder testearlo. La clave normalizada es la misma cuenta que
 * carcass_norm / carcass_type_key en SQL (migración 162): cambiar las dos juntas.
 */

/** Los que vienen siempre: todos compran carne, cerdo y pollo. El nombre guardado de la media res es el histórico. */
export const DEFAULT_ANIMAL_TYPES = ["Vaca / media res", "Cerdo", "Pollo"];

/** Cuántos botones se ven antes de "Más". */
export const MAX_VISIBLE_TYPES = 5;

const MEDIA_RES = ["mediares", "vacamediares", "mediaresvaca", "mediaresdevaca", "mediaresnovillo", "mediaresdenovillo", "vaca", "novillo", "carne", "carnevacuna"];
const CERDO = ["cerdo", "cerdos", "mediocerdo", "mediaresdecerdo", "mediarescerdo", "cerdoentero", "porcino"];
const POLLO = ["pollo", "pollos", "cajondepollo", "cajonpollo", "cajonesdepollo", "polloentero"];

/** Minúsculas, sin acentos, solo letras y números. */
export function carcassNorm(text: string): string {
  const lower = text.trim().toLowerCase();
  const plain = lower.replace(/[áéíóúüñ]/g, (c) => ({ á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", ñ: "n" })[c] ?? c);
  return plain.replace(/[^a-z0-9]/g, "");
}

/** Nombres que significan lo mismo dan la misma clave ("Vaca / media res", "MEDIA RES" → "mediares"). */
export function carcassTypeKey(text: string): string {
  const n = carcassNorm(text);
  if (MEDIA_RES.includes(n)) return "mediares";
  if (CERDO.includes(n)) return "cerdo";
  if (POLLO.includes(n)) return "pollo";
  return n;
}

/** Cómo se muestra: "Vaca / media res" es "Media res"; el resto, como lo escribió el negocio. */
export function animalTypeLabel(type: string): string {
  return carcassNorm(type) === "vacamediares" ? "Media res" : type.trim();
}

/** Si ya existe uno igual (misma clave), cuál; para no crear "MEDIA" cuando ya está "Media res". */
export function findSameType(name: string, types: string[]): string | undefined {
  const key = carcassTypeKey(name);
  if (!key) return undefined;
  return types.find((t) => carcassTypeKey(t) === key);
}

export interface TypeChips {
  /** Todos, sin repetidos, en orden. */
  all: string[];
  /** Los primeros MAX_VISIBLE_TYPES. */
  visible: string[];
  /** El resto, en "Más". */
  more: string[];
}

/**
 * Los botones: los que trae el sistema + los que el negocio ya usó (reses y cortes de siempre), sin repetidos.
 * Si el negocio ya usa un nombre para uno de los de siempre ("MEDIA RES"), se muestra el suyo.
 * Orden fijo para que no salten: primero los más usados (por cantidad de reses), después los de siempre.
 */
export function buildTypeChips(batchTypes: string[], templateTypes: string[], max = MAX_VISIBLE_TYPES): TypeChips {
  const byKey = new Map<string, { name: string; count: number; order: number }>();
  DEFAULT_ANIMAL_TYPES.forEach((name, index) => byKey.set(carcassTypeKey(name), { name, count: 0, order: index }));
  let next = DEFAULT_ANIMAL_TYPES.length;
  const add = (raw: string, counts: boolean) => {
    const name = raw.trim();
    const key = carcassTypeKey(name);
    if (!key) return;
    const found = byKey.get(key);
    if (found) {
      if (found.count === 0 && !DEFAULT_ANIMAL_TYPES.includes(name)) found.name = name;
      if (counts) found.count += 1;
    } else {
      byKey.set(key, { name, count: counts ? 1 : 0, order: next++ });
    }
  };
  batchTypes.forEach((t) => add(t, true));
  templateTypes.forEach((t) => add(t, false));
  const all = [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((v) => v.name);
  return { all, visible: all.slice(0, max), more: all.slice(max) };
}

/** El que se elige al abrir: el de la última res, o el primero. */
export function initialType(chips: TypeChips, latestBatchType?: string): string {
  if (latestBatchType) {
    const same = findSameType(latestBatchType, chips.all);
    if (same) return same;
  }
  return chips.all[0] ?? DEFAULT_ANIMAL_TYPES[0];
}
