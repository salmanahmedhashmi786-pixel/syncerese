import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

/**
 * The shared secret guarding the internal scheduled endpoints.
 *
 * WHY THESE ROUTES ANSWER GET AS WELL AS POST
 *
 * Vercel Cron invokes a job by making an **HTTP GET** to the configured path.
 * `vercel.json` has declared a cron against `/api/internal/dispatch` since the
 * deployment work, and that route exported only `POST` — so on Vercel the cron
 * answered 405 every minute and no webhook was ever delivered. Exactly the
 * quiet failure the runbook warns about, caused by our own routing.
 *
 * A GET that mutates is normally worth objecting to. It is acceptable here
 * because the guard is a bearer token in a header rather than a cookie: a
 * browser cannot attach it cross-origin, so there is no CSRF surface, and a
 * prefetcher or crawler that stumbles on the path gets a 401. Vercel sets the
 * header itself from `CRON_SECRET`.
 */
export function checkCronSecret(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'CRON_SECRET is not set.' } },
      { status: 503 },
    )
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // Length first: timingSafeEqual throws on a mismatch, and the throw itself
  // would leak the length through timing.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Invalid cron secret.' } },
      { status: 401 },
    )
  }

  return null
}
