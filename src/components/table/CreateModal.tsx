'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ModuleDef } from '@/modules/registry'
import { writesFor, type WriteField } from '@/modules/writes'
import { chipButtonStyle, inputStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { createRecordAction } from '@/app/actions/records'

export type FormOptions = {
  partners: { id: string; label: string }[]
  products: { id: string; label: string }[]
  taxRates: { id: string; label: string }[]
  warehouses: { id: string; label: string }[]
  bankAccounts: { id: string; label: string }[]
  accounts: { id: string; label: string }[]
}

const EMPTY_OPTIONS: FormOptions = {
  partners: [],
  products: [],
  taxRates: [],
  warehouses: [],
  bankAccounts: [],
  accounts: [],
}

/** Which option list a reference field draws from. */
function optionsFor(field: WriteField, options: FormOptions) {
  switch (field.kind) {
    case 'partner':
      return options.partners
    case 'product':
      return options.products
    case 'taxRate':
      return options.taxRates
    case 'warehouse':
      return options.warehouses
    case 'bankAccount':
      return options.bankAccounts
    case 'account':
      return options.accounts
    default:
      return null
  }
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Create-record modal, built from the write registry.
 *
 * One form for every module: the fields, their types and the line-item spec all
 * come from `writes.ts`, so adding a creatable module is a registry entry
 * rather than another bespoke screen that drifts from the others.
 */
export function CreateModal({
  module,
  open,
  onClose,
  options = EMPTY_OPTIONS,
}: {
  module: ModuleDef
  open: boolean
  onClose: () => void
  options?: FormOptions
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const spec = writesFor(module.id)

  const initial = useMemo(() => {
    const out: Record<string, string> = {}
    for (const f of spec?.create ?? []) {
      if (f.default !== undefined) out[f.key] = String(f.default)
      // Only REQUIRED dates are pre-filled with today. Pre-filling an optional
      // one silently overrides the server's own default — a due date left blank
      // is meant to derive from the partner's payment terms, and filling it in
      // made every invoice due the day it was raised.
      else if (f.kind === 'date' && f.required) out[f.key] = today()
    }
    return out
  }, [spec])

  const [values, setValues] = useState<Record<string, string>>(initial)
  const [lines, setLines] = useState<Record<string, string>[]>([{}])
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  if (!spec || spec.create.length === 0) {
    return (
      <Shell title={`New ${module.noun.toLowerCase()}`} onClose={onClose}>
        <p style={{ fontSize: 12.5, color: 'var(--mut)', padding: '4px 0 8px' }}>
          {module.label} records are created by the documents that produce them — a bank
          transaction comes from a statement import, a journal entry from posting a document.
        </p>
      </Shell>
    )
  }

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }))
  const setLine = (i: number, key: string, value: string) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, [key]: value } : l)))

  const submit = () => {
    const next: Record<string, string> = {}
    for (const f of spec.create) {
      if (f.required && !String(values[f.key] ?? '').trim()) next[f.key] = 'Required'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) {
      toast(`Fix ${Object.keys(next).length} field(s) before saving`, 'err')
      return
    }

    startTransition(async () => {
      const result = await createRecordAction(module.id, {
        ...values,
        ...(spec.lines ? { lines } : {}),
      })
      if (result.ok) {
        toast(`${module.noun} ${result.data?.label ?? ''} created`)
        setValues(initial)
        setLines([{}])
        onClose()
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })
  }

  return (
    <Shell title={`New ${module.noun.toLowerCase()}`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        {spec.create.map((f) => (
          <Field
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            error={errors[f.key]}
            options={options}
            onChange={(v) => set(f.key, v)}
          />
        ))}
      </div>

      {spec.lines && (
        <div style={{ marginTop: 18 }}>
          <div
            style={{
              font: '500 9.5px var(--font-mono), monospace',
              letterSpacing: '.08em',
              color: 'var(--mut)',
              marginBottom: 8,
            }}
          >
            {spec.lines.label.toUpperCase()}
          </div>

          {lines.map((line, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${spec.lines!.fields.length}, 1fr) 28px`,
                gap: 7,
                marginBottom: 7,
                alignItems: 'end',
              }}
            >
              {spec.lines!.fields.map((f) => (
                <div key={f.key}>
                  {i === 0 && (
                    <label
                      style={{
                        display: 'block',
                        font: '500 9px var(--font-mono), monospace',
                        letterSpacing: '.06em',
                        color: 'var(--mut)',
                        marginBottom: 4,
                      }}
                    >
                      {f.label.toUpperCase()}
                    </label>
                  )}
                  <FieldInput
                    field={f}
                    value={line[f.key] ?? (f.default !== undefined ? String(f.default) : '')}
                    options={options}
                    onChange={(v) => setLine(i, f.key, v)}
                  />
                </div>
              ))}
              <button
                type="button"
                aria-label="Remove line"
                onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, x) => x !== i) : ls))}
                style={{
                  ...chipButtonStyle,
                  height: 30,
                  padding: 0,
                  justifyContent: 'center',
                  fontFamily: 'inherit',
                }}
              >
                ✕
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, {}])}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            + Add line
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose} style={{ ...chipButtonStyle, fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
        >
          {pending ? 'Saving…' : 'Save record'}
        </button>
      </div>
    </Shell>
  )
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,17,.42)', zIndex: 70 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed',
          left: '50%',
          top: '7vh',
          transform: 'translateX(-50%)',
          width: 720,
          maxWidth: '94vw',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: 'var(--pnl)',
          border: '1px solid var(--bd)',
          borderRadius: 10,
          zIndex: 75,
          boxShadow: '0 24px 60px rgba(0,0,0,.32)',
          animation: 'fade-rise .15s ease',
        }}
      >
        <div
          style={{
            padding: '16px 20px 12px',
            borderBottom: '1px solid var(--bd)',
            position: 'sticky',
            top: 0,
            background: 'var(--pnl)',
            zIndex: 1,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-.02em' }}>{title}</div>
          <div style={{ color: 'var(--mut)', fontSize: 11.5, marginTop: 2 }}>
            Required fields are marked. Values validate on save.
          </div>
        </div>
        <div style={{ padding: '16px 20px 20px' }}>{children}</div>
      </div>
    </>
  )
}

function Field({
  field,
  value,
  error,
  options,
  onChange,
}: {
  field: WriteField
  value: string
  error?: string
  options: FormOptions
  onChange: (v: string) => void
}) {
  return (
    <div style={{ gridColumn: field.wide ? 'span 2' : 'span 1' }}>
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
        {field.label}
        {field.required ? ' *' : ''}
      </label>
      <FieldInput field={field} value={value} options={options} onChange={onChange} error={error} />
      {error && <div style={{ color: '#dc2626', fontSize: 10.5, marginTop: 4 }}>{error}</div>}
      {field.help && !error && (
        <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 4 }}>{field.help}</div>
      )}
    </div>
  )
}

function FieldInput({
  field,
  value,
  options,
  onChange,
  error,
}: {
  field: WriteField
  value: string
  options: FormOptions
  onChange: (v: string) => void
  error?: string
}) {
  const style = { ...inputStyle, borderColor: error ? '#dc2626' : 'var(--bd)' }
  const list = optionsFor(field, options)

  if (list) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
        <option value="">—</option>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'longtext') {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        style={{ ...style, height: 'auto', padding: '7px 9px', resize: 'vertical' }}
      />
    )
  }

  return (
    <input
      type={field.kind === 'date' ? 'date' : 'text'}
      inputMode={field.kind === 'money' || field.kind === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder ?? (field.kind === 'money' ? '0.00' : undefined)}
      style={style}
    />
  )
}
