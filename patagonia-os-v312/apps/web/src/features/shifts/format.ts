export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

export function startOfWeekIso(date: string) {
  const d = new Date(`${date}T00:00:00`);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

export function endOfWeekIso(date: string) {
  return addDaysIso(startOfWeekIso(date), 6);
}

export function startOfMonthIso(date: string) {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonthIso(date: string) {
  const d = new Date(`${startOfMonthIso(date)}T00:00:00`);
  d.setMonth(d.getMonth() + 1);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
