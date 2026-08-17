'use client'

/**
 * The last-resort error boundary: a crash in the root layout itself, which no
 * nested `error.tsx` can catch.
 *
 * It renders its own `<html>` and `<body>` because at this point the root
 * layout is what failed, so there is nothing to nest inside. That also means
 * the font variables are gone, hence the explicit system stack below — this is
 * the one screen that cannot assume the app's own CSS survived.
 *
 * NOTHING FROM THE ERROR IS SHOWN. A stack trace here can carry a connection
 * string, a query with tenant identifiers in it, or a file path that maps the
 * server; `digest` is the handle Next puts in the server log, and it is enough
 * to find the real error without printing any of it to whoever hit the page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f6f7f9',
          color: '#111827',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          padding: 20,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Something went wrong</div>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: '#6b7280', marginTop: 10 }}>
            The page could not be loaded. Nothing you were working on has been changed.
          </p>
          {error.digest && (
            <p style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 12 }}>
              Reference <code>{error.digest}</code> — quote this if you report it.
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 18,
              padding: '8px 16px',
              fontSize: 13,
              fontFamily: 'inherit',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
