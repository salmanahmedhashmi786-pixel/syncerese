/**
 * Boot hook. Next.js calls `register()` once per server process, before the
 * first request is served.
 *
 * The only thing here is the configuration gate: a production process with a
 * missing AUTH_SECRET or a superuser database connection must not accept
 * traffic. Crashing at boot is the loud failure; the alternative is a service
 * that looks healthy and is not.
 */
export async function register(): Promise<void> {
  // Edge runtime has no process env of the same shape and cannot connect to
  // Postgres anyway — the check belongs to the Node server.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { assertEnvironment } = await import('./lib/env')
  assertEnvironment()
}
