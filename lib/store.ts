// Fake demo data. One process, no durable customer storage.
import "server-only";
import { tidy } from "@/config/tidy";
import { demo } from "@/demo.config";
import type { Actor } from "@/lib/require-permission";

type Customer = {
  id: string;
  name: string;
  company: string;
  lastActiveAt: string;
  status: "active" | "archived";
  changedBy: string | null;
};
type Activity = { at: string; action: "archive" | "delete"; ids: string[]; actor: Actor };
type Store = { customers: Customer[]; activity: Activity[] };
const globalStore = globalThis as typeof globalThis & { tidyCustomers?: Store };
function seed(): Store {
  const now = Date.now();
  return {
    activity: [],
    customers: Array.from({ length: tidy.seedCount }, (_, i) => ({
      id: `customer_${String(i + 1).padStart(4, "0")}`,
      name: `Sample Customer ${i + 1}`,
      company: `Example Company ${Math.floor(i / 3) + 1}`,
      // Exactly 402 customers (every third) are stale at reset: inactive for
      // demo.staleAfterDays + 30..229 days. Everyone else was active within 300 days.
      lastActiveAt: new Date(
        now - (i % 3 === 0 ? demo.staleAfterDays + 30 + (i % 200) : i % 300) * 86400000,
      ).toISOString(),
      status: "active",
      changedBy: null,
    })),
  };
}
function store() {
  return (globalStore.tidyCustomers ??= seed());
}
export function listCustomers(inactiveDays = 0) {
  const data = store();
  const cutoff = Date.now() - inactiveDays * 86400000;
  return {
    customers: data.customers.filter(row => !inactiveDays || Date.parse(row.lastActiveAt) < cutoff),
    total: data.customers.length,
    archived: data.customers.filter(row => row.status === "archived").length,
  };
}
export function changeCustomers(ids: string[], action: "archive" | "delete", actor: Actor) {
  const data = store();
  // Validate the whole batch before changing anything.
  if (ids.some(id => !data.customers.some(row => row.id === id))) return null;
  const selected = new Set(ids);
  const changedBy =
    actor.kind === "agent" ? `${actor.label} (agent) for ${actor.onBehalfOf}` : `${actor.label} (human)`;
  const changed: Customer[] = [];
  for (const row of data.customers) {
    if (!selected.has(row.id)) continue;
    // Archiving an already-archived row is a no-op, so its original attribution survives.
    if (action === "archive") {
      if (row.status === "archived") continue;
      row.status = "archived";
      row.changedBy = changedBy;
    }
    changed.push({ ...row, changedBy });
  }
  if (action === "delete") data.customers = data.customers.filter(row => !selected.has(row.id));
  if (changed.length)
    data.activity.push({
      at: new Date().toISOString(),
      action,
      ids: changed.map(row => row.id),
      actor: { ...actor },
    });
  return { action, count: changed.length, changedBy, customers: changed };
}
export function activityLog() {
  return structuredClone(store().activity);
}
export function resetCustomers() {
  globalStore.tidyCustomers = seed();
  return listCustomers();
}
