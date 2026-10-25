export class AuthError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 503,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function authErrorResponse(error: unknown): Response {
  const known = error instanceof AuthError;
  return Response.json(
    {
      error: known ? error.message : "Authorization could not be verified. Try again.",
      ...(known ? error.details : {}),
    },
    { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } },
  );
}
