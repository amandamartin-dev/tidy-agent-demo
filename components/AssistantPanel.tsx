"use client";
import { useEffect, useEffectEvent, useState } from "react";
import { agentIdentity, revokeTidy, startTidy } from "@/app/actions/demo";
import { errorMessage } from "@/lib/api-body";
import { readAgentEvents } from "@/lib/agent-stream";
import { demo } from "@/demo.config";
import type { AgentIdentity, RevokeMoment } from "@/app/actions/demo";
import type { AgentEvent, StreamedEvent } from "@/lib/agent-events";

type ModeEvent = Extract<AgentEvent, { type: "mode" }>;
type IdentityResponse = Awaited<ReturnType<typeof agentIdentity>>;
type Session = { handle: string; identity: AgentIdentity };
// The transcript is the prompt plus the raw event stream; rows, outcome and mode are derived from it.
type Transcript = { prompt: string; events: StreamedEvent[] };
type Failure = { message: string; reauth: boolean };
// `key` is the eventId of the event that created the row; the prompt is always the one first row.
type Row =
  | { kind: "prompt"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | {
      kind: "call";
      key: string;
      id: string;
      name: string;
      args: string;
      result?: Extract<AgentEvent, { type: "tool_result" }>;
    }
  | { kind: "assistant"; key: string; text: string };

const time = (value: number | string | null) =>
  value === null ? "—" : new Date(typeof value === "number" ? value * 1000 : value).toLocaleTimeString();

// Fold the streamed events into transcript rows; a tool result attaches to its call.
function addEvent(rows: Row[], event: StreamedEvent): Row[] {
  if (event.type === "done")
    return rows.map(row =>
      row.kind === "call" && !row.result
        ? {
            ...row,
            result: {
              type: "tool_result",
              id: row.id,
              status: 0,
              tone: "error",
              summary: "Stopped · result unconfirmed",
            },
          }
        : row,
    );
  if (event.type === "thinking") return [...rows, { kind: "thinking", key: event.eventId, text: event.text }];
  if (event.type === "assistant")
    return [...rows, { kind: "assistant", key: event.eventId, text: event.text }];
  if (event.type === "tool_call")
    return [...rows, { kind: "call", key: event.eventId, id: event.id, name: event.name, args: event.args }];
  if (event.type === "tool_result")
    return rows.map(row => (row.kind === "call" && row.id === event.id ? { ...row, result: event } : row));
  return rows;
}

// Server actions report failures as { error } rather than throwing across the network boundary.
class ActionError extends Error {
  constructor(
    message: string,
    public reauth = false,
  ) {
    super(message);
  }
}
function unwrap<T extends object>(result: T): T {
  if ("error" in result && typeof result.error === "string") {
    throw new ActionError(result.error, "reauthRequired" in result && !!result.reauthRequired);
  }
  return result;
}
function failureFrom(error: unknown): Failure {
  return {
    message: error instanceof Error ? error.message : "Something went wrong.",
    reauth: error instanceof ActionError && error.reauth,
  };
}

// The pill and card always reflect what the server read from WorkOS, never client state.
function readIdentity(response: IdentityResponse) {
  const result = unwrap(response);
  if (!("identity" in result) || !result.identity) {
    return { session: null, serverBusy: false, transcript: null };
  }
  return {
    session: { handle: result.handle, identity: result.identity },
    serverBusy: result.busy,
    transcript: result.runPrompt ? { prompt: result.runPrompt, events: result.events } : null,
  };
}
function initialState(response: IdentityResponse) {
  try {
    return { ...readIdentity(response), failure: null };
  } catch (error) {
    return { session: null, serverBusy: false, transcript: null, failure: failureFrom(error) };
  }
}

function StatusPill({ identity }: { identity: AgentIdentity | null }) {
  if (!identity) return <span className="pill neutral">Not started</span>;
  const status = identity.status;
  const label = {
    active: "Live",
    revoked: "Revoked",
    expired: "Token expired",
    invalid: "Delegation ended",
    unverified: "Unverified · denied",
  }[status];
  return <span className={`pill ${status === "active" ? "live" : "dead"}`}>{label}</span>;
}

function IdentityClaims({ identity, notGranted }: { identity: AgentIdentity; notGranted: string[] }) {
  return (
    <dl>
      <dt>
        Agent instance <code>sub</code>
      </dt>
      <dd>
        <code>{identity.claims.sub}</code>
      </dd>
      <dt>
        Caller type <code>sub_profile</code>
      </dt>
      <dd>
        <code>{identity.claims.sub_profile}</code>
      </dd>
      <dt>
        Acting for <code>act.sub</code>
      </dt>
      <dd>
        {identity.actsForName} · <code>{identity.claims.act_sub ?? "—"}</code>
      </dd>
      <dt>
        Workspace <code>org_id</code>
      </dt>
      <dd>
        {demo.workspaceName} · <code>{identity.claims.org_id}</code>
      </dd>
      <dt>
        Can <code>permissions</code>
      </dt>
      <dd className="chips">
        {identity.claims.permissions.map(slug => (
          <span
            key={slug}
            className="chip yes"
            title={demo.permissionLabels[slug as keyof typeof demo.permissionLabels]}
          >
            {slug}
          </span>
        ))}
        {notGranted.map(slug => (
          <span key={slug} className="chip no" title="Not in this token">
            {slug}
          </span>
        ))}
      </dd>
      <dt>
        Session intent <code>intent.text</code>
      </dt>
      <dd>{identity.claims.intent ?? <span className="muted">not set</span>}</dd>
      <dt>
        Token expires <code>exp</code>
      </dt>
      <dd suppressHydrationWarning>{time(identity.claims.exp)}</dd>
    </dl>
  );
}

function RevokeMomentCard({ moment }: { moment: RevokeMoment }) {
  return (
    <div className="revoke-moment" role="status">
      <strong>Signed isn&apos;t live.</strong>
      <ul>
        <li className={moment.signatureVerifiesLocally ? "ok" : "bad"}>
          {moment.signatureVerifiesLocally ? "✓" : "✗"} JWT signature still verifies locally
          {moment.tokenExpiresAt ? ` (until ${time(moment.tokenExpiresAt)})` : ""}
        </li>
        <li className="bad">
          ✗ WorkOS session: {moment.sessionStatus}
          {moment.revokedAt ? ` at ${time(moment.revokedAt)}` : ""}
        </li>
        <li className="bad">
          ✗ {demo.productName} API: {moment.apiStatus}
          {moment.apiError ? ` · ${moment.apiError}` : ""}
        </li>
      </ul>
      <p>
        A signed agent token is not a live agent token. A local JWT check can&apos;t see a revoke until{" "}
        <code>exp</code>, so {demo.productName} asks WorkOS whether the session is live on every call. Run the
        assistant again to watch its next call fail.
      </p>
    </div>
  );
}

function TranscriptRows({ rows }: { rows: Row[] }) {
  return (
    <>
      {rows.map(row => {
        if (row.kind === "prompt")
          return (
            <p key={row.key} className="bubble user">
              {row.text}
            </p>
          );
        if (row.kind === "thinking")
          return (
            <p key={row.key} className="thinking">
              {row.text}
            </p>
          );
        if (row.kind === "assistant")
          return (
            <p key={row.key} className="bubble agent">
              {row.text}
            </p>
          );
        return (
          <div key={row.key} className={`tool ${row.result?.tone ?? "waiting"}`}>
            <code className="tool-call">
              {row.name}({row.args})
            </code>
            <span className="tool-result">{row.result ? row.result.summary : "…"}</span>
            {row.result?.body && (
              <details>
                <summary>Response body</summary>
                <pre>{row.result.body}</pre>
              </details>
            )}
          </div>
        );
      })}
    </>
  );
}

export function AssistantPanel({
  initialIdentity,
  onRecordsChanged,
  humanReady,
  initialMode,
}: {
  initialIdentity: IdentityResponse;
  onRecordsChanged: () => Promise<void>;
  humanReady: boolean;
  initialMode: ModeEvent;
}) {
  const [start] = useState(() => initialState(initialIdentity));
  const [session, setSession] = useState<Session | null>(start.session);
  const [serverBusy, setServerBusy] = useState(start.serverBusy);
  const [transcript, setTranscript] = useState<Transcript | null>(start.transcript);
  const [failure, setFailure] = useState<Failure | null>(start.failure);
  const [prompt, setPrompt] = useState<string>(demo.prefilledPrompt);
  const [moment, setMoment] = useState<RevokeMoment | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const identity = session?.identity ?? null;
  const working = busy || serverBusy;
  const events = transcript?.events ?? [];
  const rows = transcript
    ? events.reduce(addEvent, [{ kind: "prompt", key: "prompt", text: transcript.prompt }] as Row[])
    : [];
  const done = events.findLast(event => event.type === "done");
  const outcome = done?.type === "done" ? done.outcome : null;
  const lastMode = events.findLast(event => event.type === "mode");
  const mode = lastMode?.type === "mode" ? lastMode : initialMode;

  function showIdentity(response: IdentityResponse, restore = false) {
    const next = readIdentity(response);
    setSession(next.session);
    setServerBusy(next.serverBusy);
    if (restore && next.transcript) setTranscript(next.transcript);
    return next.session;
  }
  async function loadIdentity(restore = false) {
    return showIdentity(await agentIdentity(), restore);
  }
  function task(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    void action()
      .catch((error: unknown) => setFailure(failureFrom(error)))
      .finally(() => setBusy(false));
  }

  // Polling keeps the pill honest when the session is revoked or expires elsewhere.
  // While another tab's run is in progress, it also restores that run's transcript.
  const poll = useEffectEvent(() => {
    void loadIdentity(serverBusy).catch(() => {});
  });
  useEffect(() => {
    if (busy || revoking) return;
    const timer = setInterval(poll, 15_000);
    return () => clearInterval(timer);
  }, [busy, revoking]);

  async function newSession(text: string) {
    const result = unwrap(await startTidy(text));
    if (!("handle" in result) || !result.handle) throw new Error("The agent session could not be started.");
    setMoment(null);
    await loadIdentity();
    return result.handle;
  }

  async function run(text: string) {
    setTranscript({ prompt: text, events: [] });
    // Reuse the current session, even a revoked one: the point is that its next call fails.
    // Start a fresh session only when none exists or the old one simply expired.
    const current = await loadIdentity();
    const handle = current && current.identity.status !== "expired" ? current.handle : await newSession(text);
    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, prompt: text }),
      });
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(errorMessage(body, `HTTP ${response.status}`));
      }
      await readAgentEvents(response.body, event =>
        setTranscript(previous => previous && { ...previous, events: [...previous.events, event] }),
      );
    } finally {
      await Promise.allSettled([onRecordsChanged(), loadIdentity()]);
    }
  }

  async function revokeAgent() {
    if (!session) return;
    setRevoking(true);
    setFailure(null);
    try {
      const result = unwrap(await revokeTidy(session.handle));
      if ("moment" in result && result.moment) setMoment(result.moment);
    } catch (error) {
      setFailure(failureFrom(error));
    } finally {
      await Promise.allSettled([loadIdentity(), onRecordsChanged()]);
      setRevoking(false);
    }
  }

  const live = identity?.status === "active";
  const canRevoke = !!identity && identity.status !== "revoked";
  const notGranted = identity
    ? demo.permissionSlugs.filter(slug => !identity.claims.permissions.includes(slug))
    : [];
  const canArchive = !!identity?.claims.permissions.includes(demo.permissionSlugs[1]);

  return (
    <aside className="assistant" aria-label={`${demo.agentDisplayName} assistant`}>
      <div className="assistant-head">
        <span className="agent-avatar" aria-hidden="true">
          {demo.agentDisplayName[0]}
        </span>
        <div>
          <strong>{demo.agentDisplayName}</strong>
          <small>{demo.agentTagline}</small>
        </div>
        <StatusPill identity={identity} />
      </div>

      <p className="footnote honest" role="status">
        <strong>{mode.label}</strong>
        {mode.mode === "scripted"
          ? ` — ${mode.note ?? "Gemini isn't connected"}. Fixed steps, not an LLM; real WorkOS authorization checks still apply.`
          : " — Gemini chooses the tools; each action uses Tidy's scoped WorkOS identity."}
      </p>
      <section className="identity-card" aria-label="Agent identity">
        <div className="identity-title">
          <span className="eyebrow">Agent identity · from the token</span>
          {identity && (
            <small className="muted" suppressHydrationWarning>
              Status checked with WorkOS at {time(identity.checkedAt)}
            </small>
          )}
        </div>
        {identity ? (
          <IdentityClaims identity={identity} notGranted={notGranted} />
        ) : (
          <p className="muted">
            No agent session yet. Run a request below and {demo.productName} mints one for you.
          </p>
        )}
        <div className="identity-actions">
          <button
            className="button danger"
            disabled={revoking || !canRevoke}
            onClick={() => void revokeAgent()}
          >
            {revoking ? "Revoking…" : "Revoke agent"}
          </button>
          {identity && !live && (
            <button
              className="button secondary"
              disabled={working || revoking || !humanReady}
              onClick={() =>
                task(async () => {
                  setTranscript(null);
                  await newSession(prompt);
                })
              }
            >
              Start a new agent session
            </button>
          )}
        </div>
        {moment && <RevokeMomentCard moment={moment} />}
      </section>

      <section className="transcript" aria-live="polite" aria-label="Assistant activity">
        <TranscriptRows rows={rows} />
        {outcome === "denied" && canArchive && !working && !revoking && (
          <button
            className="chip-button"
            onClick={() => {
              setPrompt(demo.archiveFollowUpPrompt);
              task(() => run(demo.archiveFollowUpPrompt));
            }}
          >
            {demo.archiveFollowUpPrompt}
          </button>
        )}
      </section>

      {failure && (
        <p className="check-message failure" role="alert">
          {failure.message}
          {failure.reauth && (
            <>
              {" "}
              <a href="/login">Sign in again</a>
            </>
          )}
        </p>
      )}

      <form
        className="prompt-box"
        onSubmit={event => {
          event.preventDefault();
          task(() => run(prompt));
        }}
      >
        <label className="sr-only" htmlFor="assistant-prompt">
          Ask {demo.agentDisplayName}
        </label>
        <textarea
          id="assistant-prompt"
          rows={2}
          maxLength={500}
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
        />
        <button
          className="button"
          type="submit"
          disabled={working || revoking || !humanReady || !prompt.trim()}
        >
          {working ? "Working…" : "Run"}
        </button>
      </form>
      <p className="footnote honest">
        {mode.mode === "gemini"
          ? `The model chooses the tool calls (max ${demo.maxToolCalls}); it never sees the token. `
          : null}
        Every tool call is a real API request with a real WorkOS agent token, so each 200, 403 and 401 comes
        from {demo.productName}&apos;s server.
      </p>
    </aside>
  );
}
