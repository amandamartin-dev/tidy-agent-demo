"use client";
import { useState } from "react";
import { demo } from "@/demo.config";
import { tidy } from "@/config/tidy";
import type { AgentEvent } from "@/lib/agent-events";
import { errorMessage, type ChangeBody, type CustomerListBody } from "@/lib/api-body";
import { AssistantPanel } from "@/components/AssistantPanel";
import type { agentIdentity } from "@/app/actions/demo";

const PAGE = 12;
const UNAVAILABLE = { text: "Customer records are unavailable. Check your session.", failed: true };

// Calls this app's own API with the browser session. The caller names the success body type.
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...(data === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(result, `HTTP ${response.status}`));
  return result as T;
}
const staleCutoff = () => Date.now() - demo.staleAfterDays * 86400000;

// The admin's control plane: the customer's records, with one-click human delete.
// Human actions use the AuthKit cookie session; the assistant uses its own agent token.
// Initial records come from the server render; the client only refetches after changes.
export function Workspace({
  humanReady,
  mode,
  initialCustomers,
  initialIdentity,
}: {
  humanReady: boolean;
  mode: Extract<AgentEvent, { type: "mode" }>;
  initialCustomers: CustomerListBody | null;
  initialIdentity: Awaited<ReturnType<typeof agentIdentity>>;
}) {
  const [data, setData] = useState<CustomerListBody>(
    initialCustomers ?? { customers: [], total: tidy.seedCount, archived: 0 },
  );
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(
    initialCustomers ? null : UNAVAILABLE,
  );

  async function refresh() {
    try {
      setData(await api<CustomerListBody>("/api/customers"));
    } catch {
      setMessage(UNAVAILABLE);
    }
  }

  function act(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    void action()
      .then(
        text => setMessage({ text, failed: false }),
        (error: unknown) =>
          setMessage({ text: error instanceof Error ? error.message : "The request failed.", failed: true }),
      )
      .finally(() => setBusy(false));
  }

  const rows = data.customers;
  const stale = rows.filter(row => row.status === "active" && Date.parse(row.lastActiveAt) < staleCutoff());
  const filtered =
    filter === "stale" ? stale : filter === "archived" ? rows.filter(row => row.status === "archived") : rows;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE) - 1));
  const visible = filtered.slice(currentPage * PAGE, (currentPage + 1) * PAGE);
  const years = demo.staleAfterDays / 365;

  return (
    <div className="workspace-grid">
      <section className="card records" aria-labelledby="records-heading">
        <div className="records-head">
          <div>
            <p className="eyebrow">{demo.workspaceName} · Customers</p>
            <h2 id="records-heading">{data.total.toLocaleString("en-US")} customer records</h2>
            <p className="muted">
              {stale.length} inactive {years}+ years · {data.archived} archived
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy || !humanReady}
            onClick={() =>
              act(async () => {
                await api<CustomerListBody>("/api/customers/reset", {});
                setPage(0);
                setFilter("all");
                await refresh();
                return `Reset: ${tidy.seedCount.toLocaleString("en-US")} sample records restored.`;
              })
            }
          >
            Reset sample data
          </button>
        </div>
        {!humanReady && (
          <p className="check-message failure">
            Your role needs {demo.permissionSlugs.join(", ")} to run this demo.
          </p>
        )}
        <div className="toolbar">
          <label>
            Show{" "}
            <select
              value={filter}
              onChange={event => {
                setFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="all">All customers</option>
              <option value="stale">Inactive {years}+ years</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          {message && (
            <span role="status" className={`inline-message ${message.failed ? "failure" : "success"}`}>
              {message.text}
            </span>
          )}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Last active</th>
                <th>Status</th>
                <th>Changed by</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr key={row.id}>
                  <td>
                    {row.name}
                    <small>
                      {row.company} · {row.id}
                    </small>
                  </td>
                  <td>{row.lastActiveAt.slice(0, 10)}</td>
                  <td>{row.status}</td>
                  <td>{row.changedBy || "—"}</td>
                  <td>
                    <button
                      className="text-button"
                      disabled={busy || !humanReady}
                      onClick={() =>
                        act(async () => {
                          const result = await api<ChangeBody>("/api/customers/delete", { ids: [row.id] });
                          await refresh();
                          return `200 · Deleted ${row.id} as ${result.changedBy}.`;
                        })
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="toolbar">
          <button
            className="button secondary"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span className="muted">
            Page {currentPage + 1} of {Math.max(1, Math.ceil(filtered.length / PAGE))} · {filtered.length}{" "}
            shown
          </span>
          <button
            className="button secondary"
            disabled={(currentPage + 1) * PAGE >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
        <p className="footnote">
          &ldquo;Changed by&rdquo; is {demo.productName}&apos;s own activity log, written from the agent
          token&apos;s <code>sub</code> and <code>act</code> claims. It is not a WorkOS audit log.
        </p>
      </section>
      <AssistantPanel
        initialIdentity={initialIdentity}
        onRecordsChanged={refresh}
        humanReady={humanReady}
        initialMode={mode}
      />
    </div>
  );
}
