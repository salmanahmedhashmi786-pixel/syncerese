'use client'

import { useEffect } from 'react'

/**
 * Opens the print dialog once, on load.
 *
 * The page is reached from a "Print" button that opens it in a new tab, so the
 * dialog appearing immediately is what the user asked for. `afterprint` is not
 * used to close the window: Safari and Firefox fire it inconsistently, and a
 * tab that fails to close is a much smaller annoyance than one that closes
 * while somebody is still reading the preview.
 */
export function PrintTrigger() {
  useEffect(() => {
    // A frame, so layout and fonts have settled. Printing mid-layout produces a
    // first page with the table header floating on its own.
    const id = requestAnimationFrame(() => window.print())
    return () => cancelAnimationFrame(id)
  }, [])

  return null
}
