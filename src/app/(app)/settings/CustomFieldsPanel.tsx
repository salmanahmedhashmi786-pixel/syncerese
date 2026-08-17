'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  chipButtonStyle,
  inputStyle,
  panelStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { addCustomField, archiveCustomField } from '@/app/actions/admin'

export type CustomFieldRow = {
  id: string
  entityType: string
  key: string
  label: string
  fieldType: string
  isRequired: boolean
  options: string[]
}

const ENTITIES = [
  { value: 'business_partner', label: 'Customers & suppliers' },
  { value: 'product', label: 'Products' },
  { value: 'deal', label: 'Deals' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'sales_order', label: 'Sales orders' },
  { value: 'purchase_order', label: 'Purchase orders' },
  { value: 'partner_contact', label: 'Contacts' },
]

const TYPES = ['text', 'number', 'date', 'select', 'boolean', 'currency', 'url', 'email']

/** Derives a slug from the label so the user never has to think about the
 *  storage key — which is immutable once values exist under it. */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/^[^a-z]/, 'f')

export function CustomFieldsPanel({
  fields,
  canManage,
}: {
  fields: CustomFieldRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [entityType, setEntityType] = useState(ENTITIES[0]!.value)
  const [label, setLabel] = useState('')
  const [fieldType, setFieldType] = useState('text')
  const [options, setOptions] = useState('')
  const [isRequired, setIsRequired] = useState(false)

  const submit = () => {
    const key = slugify(label)
    if (!key) {
      toast('Give the field a name first', 'err')
      return
    }
    startTransition(async () => {
      const result = await addCustomField({
        entityType,
        key,
        label: label.trim(),
        fieldType,
        options: options
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        isRequired,
      })
      if (result.ok) {
        toast(`Field "${label.trim()}" added`)
        setLabel('')
        setOptions('')
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })
  }

  const archive = (id: string, name: string) => {
    startTransition(async () => {
      const result = await archiveCustomField(id)
      if (result.ok) {
        toast(`"${name}" archived`, 'warn')
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })
  }

  const grouped = ENTITIES.map((e) => ({
    ...e,
    fields: fields.filter((f) => f.entityType === e.value),
  })).filter((g) => g.fields.length > 0)

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Custom fields</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16 }}>
        Add fields to any record type without a database change. They appear in the filter
        builder and can be used as analytics dimensions.
      </div>

      {grouped.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--mut)' }}>No custom fields defined yet.</p>
      )}

      {grouped.map((g) => (
        <div key={g.value} style={{ marginBottom: 14 }}>
          <div
            style={{
              font: '500 9.5px var(--font-mono), monospace',
              letterSpacing: '.08em',
              color: 'var(--mut)',
              marginBottom: 6,
            }}
          >
            {g.label.toUpperCase()}
          </div>
          {g.fields.map((f) => (
            <div
              key={f.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 0',
                borderBottom: '1px solid var(--bd)',
                fontSize: 12.5,
              }}
            >
              <span style={{ minWidth: 0, flex: 1 }}>{f.label}</span>
              <span
                style={{
                  font: '400 10.5px var(--font-mono), monospace',
                  color: 'var(--mut)',
                }}
              >
                custom.{f.key}
              </span>
              <Badge color="#64748b">{f.fieldType}</Badge>
              {f.isRequired && <Badge color="#b45309">required</Badge>}
              {canManage && (
                <button
                  type="button"
                  onClick={() => archive(f.id, f.label)}
                  disabled={pending}
                  style={{ ...chipButtonStyle, height: 22, fontFamily: 'inherit' }}
                >
                  Archive
                </button>
              )}
            </div>
          ))}
        </div>
      ))}

      {canManage && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--bd)' }}>
          <div
            style={{
              font: '500 9.5px var(--font-mono), monospace',
              letterSpacing: '.08em',
              color: 'var(--mut)',
              marginBottom: 8,
            }}
          >
            ADD A FIELD
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              style={inputStyle}
              aria-label="Record type"
            >
              {ENTITIES.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
            <select
              value={fieldType}
              onChange={(e) => setFieldType(e.target.value)}
              style={inputStyle}
              aria-label="Field type"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              placeholder="Field name, e.g. Industry"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={inputStyle}
            />
            <input
              placeholder={fieldType === 'select' ? 'Options, comma separated' : '—'}
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              disabled={fieldType !== 'select'}
              style={{ ...inputStyle, opacity: fieldType === 'select' ? 1 : 0.5 }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginTop: 10,
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}>
              <input
                type="checkbox"
                checked={isRequired}
                onChange={(e) => setIsRequired(e.target.checked)}
                style={{ accentColor: 'var(--ac)' }}
              />
              Required
            </label>
            {label.trim() && (
              <span
                style={{
                  font: '400 10.5px var(--font-mono), monospace',
                  color: 'var(--mut)',
                }}
              >
                stored as custom.{slugify(label)}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
            >
              Add field
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
