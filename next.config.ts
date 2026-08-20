import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Traced, self-contained server bundle for the container image, which then
  // carries only what the app actually imports instead of a 500MB
  // node_modules. `next start` in development is unaffected.
  //
  // Skipped on Vercel, which does its own tracing and packaging — asking for
  // standalone there duplicates that work and is a documented source of
  // build-output surprises. VERCEL=1 is set by their builder.
  ...(process.env.VERCEL ? {} : { output: 'standalone' as const }),

  /**
   * Keep file tracing inside the project.
   *
   * Without this the tracer walks upward looking for a workspace root and, on
   * Windows, ends up globbing the user's local application data — where
   * `Application Data` is a legacy compatibility junction pointing at its own
   * parent, access denied by design. The build then dies with `EPERM: scandir`
   * on a path nothing in this repository mentions, which suggests nothing at
   * all about the cause.
   */
  outputFileTracingRoot: __dirname,

  // The desktop shell (phase 9) loads this app over HTTPS from the hosted
  // origin; it is a client shell, not a static export. Nothing here assumes a
  // single region — see `organizations.region` in the schema.
  // Native/WASM modules the server bundler must not try to inline.
  //
  // `pdfkit` is here for a different reason than the other two: it is pure
  // JavaScript, but it reads its built-in font metrics (`Helvetica.afm` and
  // friends) from disk at runtime. Bundled, the code moves into
  // `.next/server/vendor-chunks` and the `data/` directory does not follow, so
  // every PDF fails with ENOENT — and only in Next, because a unit test
  // resolves it straight out of node_modules and passes.
  serverExternalPackages: ['@node-rs/argon2', '@electric-sql/pglite', 'pdfkit'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ]
  },
}

export default nextConfig
