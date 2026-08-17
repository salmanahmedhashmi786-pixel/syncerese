'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ModuleDef } from '@/modules/registry'
import { STATUS_COLOR, statusLabel } from '@/modules/registry'
import { writesFor, type DocumentAction, type WriteField } from '@/modules/writes'
import {
  Badge,
  chipButtonStyle,
  iconButtonStyle,
  inputStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { runActionAction } from '@/app/actions/records'
import type { FormOptions } from './CreateModal'
import { renderValue, type TableRow } from './TableModule'

/**
 * Right-anchored 460px record drawer over a 34%-black scrim.
 *
 * An overlay rather than a route change, deliberately: the table behind keeps
 * its scroll position, its selection and its filter, so closing the drawer
 * returns you exactly where you were. That is the difference between browsing
 * fifty records and navigating fifty times.
 *
 * The field grid mirrors the table columns exactly, so nothing visible in the
 * row is hidden from the detail view.
 */
export function RecordDrawer({
  module,
  record,
  locale,
  baseCurrency,
  onClose,
  options,
}: {
  module: ModuleDef
  record: TableRow | null
  locale: string
  baseCurrency: string
  onClose: () => void
  options?: FormOptions
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [prompting, setPrompting] = useState<DocumentAction | null>(null)

  const status = String(record?.status ?? '')

  /** Invoices and credit notes live in the same module and the same table. */
  const isDocument = module.id === 'invoices'

  /**
   * Fetches the XML rather than navigating to it.
   *
   * A plain link would work when the document is valid and show a raw JSON
   * error page when it is not — and the whole point of validating before
   * emitting is that somebody can act on the answer. So the response is read,
   * and a 422 becomes a readable list of what to fix.
   */
  const downloadEInvoice = async (id: string) => {
    const response = await fetch(`/api/invoices/${id}/document?format=xml`)
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string; violations?: { message: string }[] } }
        | null
      const violations = body?.error?.violations ?? []
      toast(
        violations.length > 0
          ? violations.map((v) => v.message).join(' ')
          : (body?.error?.message ?? 'Could not produce the e-invoice.'),
        'err',
      )
      return
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download =
      response.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ??
      `${id}.xml`
    link.click()
    URL.revokeObjectURL(url)
  }
  // Only actions valid for this record's current state. The service checks the
  // same thing, so this is about not offering a button that would fail.
  const available = (writesFor(module.id)?.actions ?? []).filter(
    (a) => !a.whenStatus || a.whenStatus.includes(status),
  )

  if (!record) return null

  const first = module.columns[0]
  const second = module.columns[1]
  const title = [first && renderValue(first, record, locale, baseCurrency), second && renderValue(second, record, locale, baseCurrency)]
    .filter((v) => v && v !== '—')
    .join(' · ')

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,17,.34)', zIndex: 60 }}
      />
      <div
        role="dialog"
        aria-label={`${module.noun} detail`}
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: 460,
          maxWidth: '96vw',
          background: 'var(--pnl)',
          borderLeft: '1px solid var(--bd)',
          zIndex: 65,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slide-in .16s ease',
        }}
      >
        <div
          style={{
            flex: 'none',
            padding: '15px 18px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                font: '500 10px var(--font-mono), monospace',
                letterSpacing: '.08em',
                color: 'var(--mut)',
              }}
            >
              {module.noun.toUpperCase()}
            </div>
            <div
              style={{
                fontWeight: 600,
                fontSize: 16,
                letterSpacing: '-.02em',
                marginTop: 3,
                wordBreak: 'break-word',
              }}
            >
              {title}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ ...iconButtonStyle, fontFamily: 'inherit' }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 24px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 1,
              background: 'var(--bd)',
              border: '1px solid var(--bd)',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            {module.columns.map((c) => (
              <div key={c.key} style={{ background: 'var(--pnl)', padding: '10px 12px' }}>
                <div
                  style={{
                    font: '500 9.5px var(--font-mono), monospace',
                    letterSpacing: '.07em',
                    color: 'var(--mut)',
                  }}
                >
                  {c.label.toUpperCase()}
                </div>
                <div style={{ fontSize: 12.5, marginTop: 3, wordBreak: 'break-word' }}>
                  {c.badge ? (
                    <Badge color={STATUS_COLOR[String(record[c.key])] ?? '#64748b'}>
                      {statusLabel(String(record[c.key] ?? '—'))}
                    </Badge>
                  ) : (
                    renderValue(c, record, locale, baseCurrency)
                  )}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              font: '500 10px var(--font-mono), monospace',
              letterSpacing: '.08em',
              color: 'var(--mut)',
              margin: '20px 0 10px',
            }}
          >
            ACTIVITY
          </div>
          <div style={{ fontSize: 12, color: 'var(--mut)', lineHeight: 1.5 }}>
            Every change to this record is captured in <code>audit_log</code>. Surfacing that
            history here is still to come.
          </div>
        </div>

        <div
          style={{
            flex: 'none',
            padding: '12px 18px',
            borderTop: '1px solid var(--bd)',
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          {available.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => setPrompting(action)}
              disabled={pending}
              style={{
                ...(action.primary ? primaryButtonStyle : chipButtonStyle),
                height: 28,
                fontFamily: 'inherit',
                opacity: pending ? 0.6 : 1,
              }}
            >
              {action.label}
            </button>
          ))}

          {/* Output actions, for invoices and credit notes only. Print goes to
              a route with no application chrome; the other two stream a file
              generated on demand, so nothing is stored waiting to be found. */}
          {isDocument && record?.id && (
            <>
              <button
                type="button"
                onClick={() => window.open(`/invoices/${record.id}/print`, '_blank')}
                style={{ ...chipButtonStyle, height: 28, fontFamily: 'inherit' }}
              >
                Print
              </button>
              <button
                type="button"
                onClick={() =>
                  window.open(`/api/invoices/${record.id}/document?format=pdf`, '_blank')
                }
                style={{ ...chipButtonStyle, height: 28, fontFamily: 'inherit' }}
              >
                PDF
              </button>
              <button
                type="button"
                onClick={() => downloadEInvoice(String(record.id))}
                style={{ ...chipButtonStyle, height: 28, fontFamily: 'inherit' }}
              >
                e-Invoice
              </button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            Close
          </button>
        </div>

        {prompting && (
          <ActionDialog
            action={prompting}
            options={options}
            pending={pending}
            onCancel={() => setPrompting(null)}
            onConfirm={(input) => {
              startTransition(async () => {
                const result = await runActionAction(module.id, record.id, prompting.key, input)
                setPrompting(null)
                if (result.ok) {
                  toast(result.data?.message ?? 'Done')
                  onClose()
                  router.refresh()
                } else {
                  toast(result.error, 'err')
                }
              })
            }}
          />
        )}
      </div>
    </>
  )
}

/**
 * Collects whatever extra input an action needs, and shows its consequence
 * before it happens.
 *
 * Issuing an invoice or shipping an order posts to the ledger irreversibly, so
 * the confirmation text says exactly what will occur rather than asking "are
 * you sure?".
 */
function ActionDialog({
  action,
  options,
  pending,
  onCancel,
  onConfirm,
}: {
  action: DocumentAction
  options?: FormOptions
  pending: boolean
  onCancel: () => void
  onConfirm: (input: Record<string, string>) => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (action.fields ?? []).map((f) => [f.key, f.kind === 'date' ? today : '']),
    ),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const listFor = (f: WriteField) =>
    f.kind === 'bankAccount'
      ? options?.bankAccounts
      : f.kind === 'partner'
        ? options?.partners
        : f.kind === 'warehouse'
          ? options?.warehouses
          : null

  const submit = () => {
    const next: Record<string, string> = {}
    for (const f of action.fields ?? []) {
      if (f.required && !String(values[f.key] ?? '').trim()) next[f.key] = 'Required'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return
    onConfirm(values)
  }

  return (
    <>
      <div
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,17,.42)', zIndex: 90 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={action.label}
        style={{
          position: 'fixed',
          left: '50%',
          top: '22vh',
          transform: 'translateX(-50%)',
          width: 460,
          maxWidth: '92vw',
          background: 'var(--pnl)',
          border: '1px solid var(--bd)',
          borderRadius: 10,
          zIndex: 95,
          boxShadow: '0 24px 60px rgba(0,0,0,.32)',
          animation: 'fade-rise .15s ease',
          padding: '18px 20px 16px',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14, letterSpacing: '-.02em' }}>{action.label}</div>
        {action.confirm && (
          <p style={{ fontSize: 12, color: 'var(--mut)', lineHeight: 1.5, marginTop: 6 }}>
            {action.confirm}
          </p>
        )}

        {(action.fields ?? []).length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 11,
              marginTop: 14,
            }}
          >
            {(action.fields ?? []).map((f) => {
              const list = listFor(f)
              return (
                <div key={f.key} style={{ gridColumn: f.wide ? 'span 2' : 'span 1' }}>
                  <label
                    style={{
                      display: 'block',
                      font: '500 9.5px var(--font-mono), monospace',
                      letterSpacing: '.07em',
                      color: 'var(--mut)',
                      marginBottom: 5,
                      textTransform: 'uppercase',
                    }}
                  >
                    {f.label}
                    {f.required ? ' *' : ''}
                  </label>
                  {list ? (
                    <select
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      style={{ ...inputStyle, borderColor: errors[f.key] ? '#dc2626' : 'var(--bd)' }}
                    >
                      <option value="">—</option>
                      {list.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.kind === 'longtext' ? (
                    // The create form already honoured `longtext`; this dialog
                    // did not, so a field declared as prose — a credit note's
                    // reason, which goes on the document and into the audit
                    // trail — was collected in a one-line box.
                    <textarea
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      rows={3}
                      style={{
                        ...inputStyle,
                        height: 'auto',
                        padding: '7px 9px',
                        resize: 'vertical',
                        borderColor: errors[f.key] ? '#dc2626' : 'var(--bd)',
                      }}
                    />
                  ) : (
                    <input
                      type={f.kind === 'date' ? 'date' : 'text'}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.kind === 'money' ? 'leave blank for the full amount' : undefined}
                      style={{ ...inputStyle, borderColor: errors[f.key] ? '#dc2626' : 'var(--bd)' }}
                    />
                  )}
                  {f.help && (
                    <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 4 }}>{f.help}</div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onCancel} style={{ ...chipButtonStyle, fontFamily: 'inherit' }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
          >
            {pending ? 'Working…' : action.label}
          </button>
        </div>
      </div>
    </>
  )
}
