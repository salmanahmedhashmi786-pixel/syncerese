import type { ReactNode } from 'react'
import './print.css'

/**
 * The print route group.
 *
 * Deliberately its own layout with no application chrome. A print stylesheet
 * that has to hide a sidebar, a header and a command palette works by selector,
 * and the next component someone adds to the shell reappears in the middle of a
 * customer's invoice. Nothing to hide is a stronger guarantee than hiding
 * everything.
 */
export const metadata = { title: 'Print' }

export default function PrintLayout({ children }: { children: ReactNode }) {
  return children
}
