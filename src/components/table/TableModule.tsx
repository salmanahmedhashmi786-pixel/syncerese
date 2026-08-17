'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import type { ColumnDef, ModuleDef } from '@/modules/registry'
import { STATUS_COLOR, statusLabel } from '@/modules/registry'
import { Badge, Checkbox, chipButtonStyle, hexAlpha, panelStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { useTheme } from '@/components/shell/ThemeRoot'
import { saveWorkspacePreferences } from '@/app/actions/preferences'
import { saveView } from '@/app/actions/views'
import { updateFieldAction } from '@/app/actions/records'
import type { Condition } from '@/modules/filters'
import { writesFor } from '@/modules/writes'
import { RecordDrawer } from './RecordDrawer'
import { CreateModal, type FormOptions } from './CreateModal'
import { FilterDrawer, type CustomFieldOption } from './FilterDrawer'
import { formatMoneyClient } from './format'

export type TableRow = Record<string, unknown> & { id: string }

export type SavedViewSummary = {
  id: string
  name: string
  filters: unknown
  isDefault: boolean
  shared: boolean
}

export function TableModule({
  module,
  rows,
  total,
  page,
  pageCount,
  statusCounts,
  hiddenColumns,
  locale,
  baseCurrency,
  canEdit,
  savedViews = [],
  customFields = [],
  pinnedRecord = null,
  formOptions,
}: {
  module: ModuleDef
  rows: TableRow[]
  total: number
  page: number
  pageCount: number
  statusCounts: Record<string, number>
  hiddenColumns: Record<string, boolean>
  locale: string
  baseCurrency: string
  canEdit: boolean
  savedViews?: SavedViewSummary[]
  customFields?: CustomFieldOption[]
  /** A record addressed by `?record=` that is not on the current page —
   *  fetched separately so a deep link always opens. */
  pinnedRecord?: TableRow | null
  /** Reference data for the create form's dropdowns. */
  formOptions?: FormOptions
}) {
  const router = useRouter()
  const params = useSearchParams()
  const toast = useToast()
  const { density } = useTheme()

  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [colMenu, setColMenu] = useState(false)
  const [hidden, setHidden] = useState<Record<string, boolean>>(hiddenColumns)
  const [editing, setEditing] = useState<{ rowId: string; key: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)

  // The active filter travels in the URL like sort and search do, so a filtered
  // view is shareable, survives the back button, and is applied on the server.
  const activeConditions: Condition[] = useMemo(() => {
    const raw = params.get('filter')
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed?.conditions) ? parsed.conditions : []
    } catch {
      return []
    }
  }, [params])

  const cellPad = density === 'comfortable' ? 10 : density === 'relaxed' ? 14 : 6
  const writeSpec = writesFor(module.id)

  const visibleColumns = useMemo(
    () => module.columns.filter((c) => !hidden[c.key]),
    [module.columns, hidden],
  )

  const sortKey = params.get('sort')
  const sortDir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const activeStatus = params.get('status') ?? 'all'
  const recordId = params.get('record')
  const creating = params.get('new') === '1'

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k)
        else next.set(k, v)
      }
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [params, router],
  )

  const onSort = (key: string) => {
    // Click to sort descending, click again to flip — matching the handoff.
    if (sortKey === key) setParam({ sort: key, dir: sortDir === 'asc' ? 'desc' : 'asc', page: null })
    else setParam({ sort: key, dir: 'desc', page: null })
  }

  const toggleColumn = async (key: string) => {
    const next = { ...hidden, [key]: !hidden[key] }
    if (!next[key]) delete next[key]
    setHidden(next)
    // Column visibility is per (user, organization) and survives the session —
    // hidden columns still participate in search, per the spec.
    await saveWorkspacePreferences({ columnVisibility: { [module.id]: next } })
  }

  const selectedIds = Object.keys(selected).filter((k) => selected[k])
  const allOn = rows.length > 0 && rows.every((r) => selected[r.id])

  const exportCsv = () => {
    const chosen = selectedIds.length ? rows.filter((r) => selected[r.id]) : rows
    const header = visibleColumns.map((c) => c.label).join(',')
    const body = chosen
      .map((r) =>
        visibleColumns
          .map((c) => {
            const v = renderValue(c, r, locale, baseCurrency, true)
            return `"${String(v).replace(/"/g, '""')}"`
          })
          .join(','),
      )
      .join('\n')
    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${module.id}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast(`Export queued · ${chosen.length} rows → CSV`)
  }

  return (
    <>
      <div style={{ ...panelStyle, overflow: 'visible' }}>
        {/* Filter bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 11px',
            borderBottom: '1px solid var(--bd)',
            flexWrap: 'wrap',
          }}
        >
          <FilterChip
            label="All"
            count={Object.values(statusCounts).reduce((a, b) => a + b, 0)}
            active={activeStatus === 'all'}
            onClick={() => setParam({ status: null, page: null })}
          />
          {(module.statuses ?? [])
            .filter((s) => statusCounts[s] !== undefined)
            .slice(0, 6)
            .map((s) => (
              <FilterChip
                key={s}
                label={statusLabel(s)}
                count={statusCounts[s] ?? 0}
                active={activeStatus === s}
                onClick={() => setParam({ status: s, page: null })}
              />
            ))}

          <div style={{ flex: 1 }} />

          {savedViews.length > 0 && (
            <select
              aria-label="Saved view"
              value={params.get('view') ?? ''}
              onChange={(e) => {
                const view = savedViews.find((v) => v.id === e.target.value)
                setParam({
                  view: view ? view.id : null,
                  filter: view ? JSON.stringify(view.filters) : null,
                  page: null,
                })
              }}
              style={{
                ...chipButtonStyle,
                fontFamily: 'inherit',
                paddingRight: 6,
                maxWidth: 190,
              }}
            >
              <option value="">All records</option>
              {savedViews.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.shared ? ' · shared' : ''}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            style={{
              ...chipButtonStyle,
              fontFamily: 'inherit',
              ...(activeConditions.length > 0
                ? { borderColor: 'var(--ac)', background: 'var(--acs)', color: 'var(--ac)', fontWeight: 600 }
                : {}),
            }}
          >
            Filters
            {activeConditions.length > 0 ? ` (${activeConditions.length})` : ''}
          </button>

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setColMenu((v) => !v)}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              Columns ({visibleColumns.length})
            </button>
            {colMenu && (
              <>
                <div
                  onClick={() => setColMenu(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 39 }}
                />
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 30,
                    zIndex: 40,
                    background: 'var(--pnl)',
                    border: '1px solid var(--bd)',
                    borderRadius: 8,
                    boxShadow: '0 12px 30px rgba(0,0,0,.16)',
                    padding: 6,
                    minWidth: 190,
                    animation: 'fade-rise .12s ease',
                  }}
                >
                  {module.columns.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => toggleColumn(c.key)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 5,
                        cursor: 'pointer',
                        fontSize: 12,
                        width: '100%',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--fg)',
                        fontFamily: 'inherit',
                        textAlign: 'left',
                      }}
                    >
                      <Checkbox checked={!hidden[c.key]} onChange={() => toggleColumn(c.key)} />
                      {c.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Bulk action bar */}
        {selectedIds.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              background: 'var(--acs)',
              borderBottom: '1px solid var(--bd)',
              fontSize: 12,
              color: 'var(--ac)',
              animation: 'fade-rise .14s ease',
            }}
          >
            <span style={{ fontWeight: 600 }}>{selectedIds.length} selected</span>
            <div style={{ flex: 1 }} />
            <BulkButton onClick={exportCsv}>Export CSV</BulkButton>
            <BulkButton onClick={() => setSelected({})}>Clear</BulkButton>
          </div>
        )}

        {/* Table — horizontally scrollable rather than truncating columns. */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead>
              <tr>
                <th
                  style={{
                    width: 34,
                    padding: `${cellPad + 2}px 0 ${cellPad + 2}px 12px`,
                    borderBottom: '1px solid var(--bd)',
                    background: 'rgba(0,0,0,.012)',
                  }}
                >
                  <Checkbox
                    checked={allOn}
                    label="Select all rows"
                    onChange={() =>
                      setSelected(
                        allOn ? {} : Object.fromEntries(rows.map((r) => [r.id, true])),
                      )
                    }
                  />
                </th>
                {visibleColumns.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => onSort(c.key)}
                    style={{
                      textAlign: c.align ?? 'left',
                      padding: `${cellPad + 2}px 10px`,
                      width: c.width,
                      font: '500 9.5px var(--font-mono), monospace',
                      letterSpacing: '.07em',
                      color: sortKey === c.key ? 'var(--ac)' : 'var(--mut)',
                      textTransform: 'uppercase',
                      borderBottom: '1px solid var(--bd)',
                      cursor: 'pointer',
                      userSelect: 'none',
                      background: 'rgba(0,0,0,.012)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.label}
                    <span style={{ opacity: 0.85, marginLeft: 5 }}>
                      {sortKey === c.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={visibleColumns.length + 1}
                    style={{ padding: '28px 12px', color: 'var(--mut)', fontSize: 12 }}
                  >
                    No records match this view.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const on = !!selected[r.id]
                return (
                  <tr
                    key={r.id}
                    style={{
                      background: on ? 'var(--acs)' : 'transparent',
                      borderBottom: `1px solid ${hexAlpha('#000000', 0.045)}`,
                    }}
                  >
                    <td style={{ padding: `${cellPad}px 0 ${cellPad}px 12px`, verticalAlign: 'middle' }}>
                      <Checkbox
                        checked={on}
                        label={`Select row ${r.id}`}
                        onChange={() => setSelected((s) => ({ ...s, [r.id]: !s[r.id] }))}
                      />
                    </td>
                    {visibleColumns.map((c, ci) => {
                      const isEditing = editing?.rowId === r.id && editing.key === c.key
                      // Editability comes from the WRITE registry, not the
                      // column definition — it is the same list the server
                      // enforces, including the statuses in which a field may
                      // still be changed. Offering an edit the server would
                      // refuse is worse than not offering it.
                      const rule = writeSpec?.editable.find((f) => f.key === c.key)
                      const statusOk =
                        !rule?.whenStatus || rule.whenStatus.includes(String(r.status ?? ''))
                      const editable = canEdit && !!rule && statusOk
                      return (
                        <td
                          key={c.key}
                          title={editable ? 'Double-click to edit' : undefined}
                          onClick={() => {
                            if (!isEditing) setParam({ record: r.id })
                          }}
                          onDoubleClick={(e) => {
                            if (!editable) return
                            e.stopPropagation()
                            setEditing({ rowId: r.id, key: c.key })
                            setEditValue(String(r[c.key] ?? ''))
                          }}
                          style={{
                            padding: `${cellPad}px 10px`,
                            textAlign: c.align ?? 'left',
                            fontFamily:
                              c.mono || c.money ? 'var(--font-mono), monospace' : 'inherit',
                            fontSize: c.mono || c.money ? '.94em' : '1em',
                            fontWeight: ci === 0 ? 500 : 400,
                            color: ci === 0 ? 'var(--ac)' : 'var(--fg)',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            // Dashed right hairline marks an editable column.
                            borderRight: editable
                              ? `1px dashed ${hexAlpha('#000000', 0.07)}`
                              : 'none',
                          }}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => setEditing(null)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  setEditing(null)
                                  return
                                }
                                if (e.key !== 'Enter') return
                                e.preventDefault()
                                const nextValue = editValue
                                setEditing(null)
                                // Unchanged value: skip the round trip rather
                                // than writing an audit entry that says nothing.
                                if (nextValue === String(r[c.key] ?? '')) return
                                void (async () => {
                                  const result = await updateFieldAction(
                                    module.id,
                                    r.id,
                                    c.key,
                                    nextValue,
                                  )
                                  if (result.ok) {
                                    toast(`${c.label} updated`)
                                    router.refresh()
                                  } else {
                                    toast(result.error, 'err')
                                  }
                                })()
                              }}
                              style={{
                                width: '100%',
                                border: '1px solid var(--ac)',
                                borderRadius: 4,
                                padding: '2px 6px',
                                font: 'inherit',
                                fontSize: '.94em',
                                background: 'var(--pnl)',
                                color: 'var(--fg)',
                                outline: 'none',
                                textAlign: 'inherit',
                              }}
                            />
                          ) : c.badge ? (
                            <Badge color={STATUS_COLOR[String(r[c.key])] ?? '#64748b'}>
                              {statusLabel(String(r[c.key] ?? '—'))}
                            </Badge>
                          ) : (
                            renderValue(c, r, locale, baseCurrency)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 12px',
            borderTop: '1px solid var(--bd)',
            font: '400 11px var(--font-mono), monospace',
            color: 'var(--mut)',
          }}
        >
          <span>
            {rows.length} of {total} records
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>click a row for detail</span>
          <div style={{ flex: 1 }} />
          {pageCount > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setParam({ page: String(page - 1) })}
                style={{ ...chipButtonStyle, opacity: page <= 1 ? 0.4 : 1, fontFamily: 'inherit' }}
              >
                ‹ Prev
              </button>
              <span>
                {page} / {pageCount}
              </span>
              <button
                type="button"
                disabled={page >= pageCount}
                onClick={() => setParam({ page: String(page + 1) })}
                style={{
                  ...chipButtonStyle,
                  opacity: page >= pageCount ? 0.4 : 1,
                  fontFamily: 'inherit',
                }}
              >
                Next ›
              </button>
            </div>
          )}
        </div>
      </div>

      <RecordDrawer
        module={module}
        record={rows.find((r) => r.id === recordId) ?? pinnedRecord}
        locale={locale}
        baseCurrency={baseCurrency}
        onClose={() => setParam({ record: null })}
        options={formOptions}
      />

      <CreateModal
        module={module}
        open={creating}
        onClose={() => setParam({ new: null })}
        options={formOptions}
      />

      <FilterDrawer
        module={module}
        open={filterOpen}
        initial={activeConditions}
        customFields={customFields}
        onClose={() => setFilterOpen(false)}
        onApply={(conditions) => {
          setParam({
            filter: conditions.length ? JSON.stringify({ conditions }) : null,
            // Applying an ad-hoc filter detaches from whatever saved view was
            // selected, otherwise the dropdown would lie about what is showing.
            view: null,
            page: null,
          })
          setFilterOpen(false)
        }}
        onSave={async (name, conditions, shared) => {
          const result = await saveView({
            module: module.id,
            name,
            filters: { conditions },
            scope: shared ? 'organization' : 'private',
          })
          if (result.ok) {
            toast(`View "${name}" saved`)
            setFilterOpen(false)
            setParam({ filter: JSON.stringify({ conditions }), view: null, page: null })
          } else {
            toast(result.error, 'err')
          }
        }}
      />
    </>
  )
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        padding: '0 10px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 11.5,
        display: 'inline-flex',
        alignItems: 'center',
        border: `1px solid ${active ? 'var(--ac)' : 'var(--bd)'}`,
        background: active ? 'var(--acs)' : 'transparent',
        color: active ? 'var(--ac)' : 'var(--fg)',
        fontWeight: active ? 600 : 400,
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {label}
      <span style={{ opacity: 0.55, marginLeft: 5, fontFamily: 'var(--font-mono), monospace' }}>
        {count}
      </span>
    </button>
  )
}

function BulkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 24,
        padding: '0 10px',
        borderRadius: 5,
        border: '1px solid rgba(0,0,0,0)',
        borderColor: 'var(--ac)',
        color: 'var(--ac)',
        display: 'inline-flex',
        alignItems: 'center',
        cursor: 'pointer',
        fontSize: 11.5,
        background: 'var(--pnl)',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

export function renderValue(
  column: ColumnDef,
  row: TableRow,
  locale: string,
  baseCurrency: string,
  raw = false,
): string {
  const v = row[column.key]
  if (v === null || v === undefined || v === '') return '—'
  if (column.money) {
    const currency = (row.currencyCode as string) ?? baseCurrency
    const n = Number(v)
    if (!Number.isFinite(n)) return '—'
    return raw ? String(n / 100) : formatMoneyClient(n, currency, locale)
  }
  return String(v)
}
