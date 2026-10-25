import { signOut, withAuth } from "@workos-inc/authkit-nextjs";
import { customerPermissions, tidy } from "@/config/tidy";
import { agentMode } from "@/lib/agent-mode";
import { demo } from "@/demo.config";
import { Workspace } from "@/components/Workspace";
import type { CustomerListBody } from "@/lib/api-body";
import Link from "next/link";
import { agentIdentity } from "@/app/actions/demo";
import { appOrigin } from "@/lib/api";
import { requirePermission } from "@/lib/require-permission";
import { listCustomers } from "@/lib/store";

export const dynamic = "force-dynamic";

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  return name && domain ? `${name[0]}•••@${domain}` : "•••";
}

// Same permission check as GET /api/customers.
async function loadCustomers(): Promise<CustomerListBody | null> {
  try {
    await requirePermission("customers:read", new Request(`${appOrigin()}/`));
    return listCustomers();
  } catch {
    return null;
  }
}

// The side-panel assistant tells the whole story on one screen.
export default async function HomePage({ searchParams }: { searchParams: Promise<{ authError?: string }> }) {
  const loginError = (await searchParams).authError === "signin";
  const auth = await withAuth();
  const humanPermissions = auth.permissions ?? [];
  const humanReady = customerPermissions.every(permission => humanPermissions.includes(permission));
  // For explanation only. WorkOS computes the real intersection into the token's
  // `permissions` claim at mint; the identity card shows that claim.
  const effective = tidy.ceiling.filter(permission => humanPermissions.includes(permission));
  const [initialCustomers, initialIdentity] = auth.user
    ? await Promise.all([loadCustomers(), agentIdentity()])
    : [null, null];

  return (
    <main className="shell wide">
      <header className="appbar">
        <Link className="brand" href="/" aria-label={`${demo.productName} home`}>
          <span className="brand-mark">{demo.productName[0]}</span>
          {demo.productName}
        </Link>
        {auth.user && <span className="workspace-name">{demo.workspaceName} workspace</span>}
        {auth.user && (
          <div className="user-menu">
            <span>
              {auth.user.firstName || maskEmail(auth.user.email)} · {demo.adminRoleLabel}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut();
              }}
            >
              <button className="text-button" type="submit">
                Sign out
              </button>
            </form>
          </div>
        )}
      </header>
      <p className="audience">
        <span>{demo.audience}</span>
        <span className="environment">
          <span className="dot" />
          WorkOS Agent Auth demo
        </span>
      </p>

      {auth.user ? (
        <>
          <Workspace
            humanReady={humanReady}
            mode={agentMode()}
            initialCustomers={initialCustomers}
            initialIdentity={initialIdentity ?? { empty: true }}
          />
          <details className="delegation-lesson">
            <summary>Where the agent&apos;s permissions come from</summary>
            <div className="delegation-content">
              <div className="delegation-explainer">
                <div>
                  <h3>Your role</h3>
                  <p>
                    {humanPermissions.length
                      ? humanPermissions.join(", ")
                      : "No permissions in this session."}
                  </p>
                </div>
                <div>
                  <h3>{demo.agentDisplayName} blueprint ceiling</h3>
                  <p>{tidy.ceiling.join(", ")}</p>
                </div>
                <div>
                  <h3>Agent token gets the overlap</h3>
                  <p>{effective.join(", ") || "Nothing"}</p>
                </div>
              </div>
              <p className="footnote">
                WorkOS computes the overlap of your permissions and the blueprint ceiling into the
                token&apos;s <code>permissions</code> claim when it mints. {demo.productName}&apos;s API
                enforces that claim itself on every request, and separately asks WorkOS whether the agent&apos;s session is still live. {demo.ttlNote}
              </p>
            </div>
          </details>
        </>
      ) : (
        <section className="card sign-in-card">
          <div>
            <h2>Sign in as the {demo.workspaceName} admin.</h2>
            <p className="muted">
              You manage {demo.workspaceName}&apos;s customer records in {demo.productName}.{" "}
              {demo.agentDisplayName}, the built-in assistant, gets its own scoped identity:{" "}
              {tidy.ceiling.join(", ")}.
            </p>
          </div>
          {loginError && (
            <p role="alert">
              Sign-in could not finish. Use the Google account with access to this workspace and try again.
            </p>
          )}
          <a className="button" href="/login">
            Sign in with Google <span aria-hidden="true">↗</span>
          </a>
        </section>
      )}

      <footer>Fictional product and workspace · Built with WorkOS Agent Auth</footer>
    </main>
  );
}
