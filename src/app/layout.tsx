import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

/**
 * IBM Plex Sans 400/500/600/700 for UI; IBM Plex Mono 400/500/600 for ids,
 * numbers, money, timestamps and micro-labels.
 *
 * VENDORED, not fetched. These were loaded through `next/font/google`, which
 * self-hosts them — so a running instance never spoke to Google either way, and
 * that was the point. But it downloads them AT BUILD TIME, which made `next
 * build` fail without a route to fonts.gstatic.com: fine on Vercel, fatal for a
 * `docker build` behind a firewall, and the error it produces ("Cannot read
 * properties of null") names neither fonts nor the network.
 *
 * The files in ./fonts are the complete faces from @ibm/plex-sans and
 * @ibm/plex-mono, under the SIL Open Font License 1.1 — LICENSE.txt sits beside
 * them, which the OFL requires when the font is redistributed, and this one is.
 *
 * They cover more than the `latin` + `latin-ext` slices did: Polish, Czech,
 * Hungarian, Baltic and Romanian names all render, and so do Greek and
 * Cyrillic, which the PDF renderer still cannot do.
 */
const sans = localFont({
  src: [
    { path: './fonts/IBMPlexSans-Regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexSans-Medium.woff2', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexSans-SemiBold.woff2', weight: '600', style: 'normal' },
    { path: './fonts/IBMPlexSans-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
})

const mono = localFont({
  src: [
    { path: './fonts/IBMPlexMono-Regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexMono-Medium.woff2', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexMono-SemiBold.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
})

/** User-facing text uses the accent. `Syncrese` (ASCII) is reserved for package
 *  names, database names and environment variables. The vendored faces above
 *  are what make the è render rather than fall back. */
export const metadata: Metadata = {
  title: {
    default: 'Syncrèse',
    template: '%s · Syncrèse',
  },
  description: 'Syncrèse — ERP for small and medium businesses.',
  applicationName: 'Syncrèse',
  icons: { icon: '/favicon.png' },
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1117' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  )
}
