'use client'

import { useState } from 'react'
import { hexAlpha, panelStyle, PanelHeader } from '@/components/ui/primitives'
import { useTheme } from '@/components/shell/ThemeRoot'
import { ACCENTS, type AccentKey } from '@/lib/theme'

/**
 * The seven chart primitives from the handoff, hand-built as SVG/CSS.
 *
 * No charting library: every one of these is a handful of elements, and a
 * library would fight the token system on colour, spacing and type — the exact
 * places the design is most specific. They read `--ac` at runtime so a change
 * in the Customize drawer recolours every chart instantly.
 *
 * All of them take real aggregated data; none carries a hardcoded series.
 */

/** Series palette, cycling. First entry is the live accent. */
export function usePalette(): string[] {
  const { accent } = useTheme()
  const ac = ACCENTS[accent as AccentKey]?.hex ?? ACCENTS.syncrese.hex
  return [ac, '#0d9488', '#7c3aed', '#b45309', '#0891b2', '#64748b', '#db2777']
}

function useAlpha() {
  const { theme } = useTheme()
  return { bar: theme === 'dark' ? 0.45 : 0.34, area: theme === 'dark' ? 0.18 : 0.1 }
}

export function ChartCard({
  title,
  note,
  span,
  children,
}: {
  title: string
  note?: string
  span: number
  children: React.ReactNode
}) {
  return (
    <section
      style={{
        ...panelStyle,
        gridColumn: `span ${span}`,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <PanelHeader title={title} note={note} />
      {children}
    </section>
  )
}

function Tooltip({ text }: { text: string }) {
  const { theme } = useTheme()
  return (
    <div
      style={{
        position: 'absolute',
        bottom: '100%',
        marginBottom: 6,
        background: theme === 'dark' ? '#252d3a' : '#111725',
        color: '#fff',
        padding: '4px 8px',
        borderRadius: 5,
        font: '500 10.5px var(--font-mono), monospace',
        whiteSpace: 'nowrap',
        zIndex: 5,
        pointerEvents: 'none',
        animation: 'fade-rise .1s ease',
      }}
    >
      {text}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1. Stat + sparkline — span 3
// ---------------------------------------------------------------------------

export function StatSparkline({
  title,
  note,
  span = 3,
  value,
  delta,
  up,
  series,
}: {
  title: string
  note?: string
  span?: number
  value: string
  delta?: string
  up?: boolean
  series: number[]
}) {
  const { area } = useAlpha()
  const color = up ? '#0d9488' : '#dc2626'

  const points = sparkPoints(series)

  return (
    <ChartCard title={title} note={note} span={span}>
      <div style={{ padding: '8px 13px 14px' }}>
        <div style={{ fontWeight: 600, fontSize: 26, letterSpacing: '-.03em' }}>{value}</div>
        {delta ? (
          <div style={{ fontSize: 11, fontWeight: 600, marginTop: 3, color }}>{delta}</div>
        ) : null}
        {series.length > 1 && (
          <svg
            viewBox="0 0 200 46"
            preserveAspectRatio="none"
            style={{ width: '100%', height: 46, display: 'block', marginTop: 10 }}
            aria-hidden
          >
            <polyline points={`0,46 ${points} 200,46`} fill={hexAlpha(color, area)} stroke="none" />
            <polyline
              points={points}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
    </ChartCard>
  )
}

function sparkPoints(series: number[]): string {
  if (series.length < 2) return ''
  const min = Math.min(...series)
  const max = Math.max(...series)
  const range = max - min || 1
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * 200
      const y = 40 - ((v - min) / range) * 34
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// ---------------------------------------------------------------------------
// 2. Column chart — span 5–8, 150px tall
// ---------------------------------------------------------------------------

export function ColumnChart({
  title,
  note,
  span = 5,
  data,
  format = (v) => String(v),
  height = 150,
}: {
  title: string
  note?: string
  span?: number
  data: { label: string; value: number; color?: string }[]
  format?: (v: number) => string
  height?: number
}) {
  const [hot, setHot] = useState<number | null>(null)
  const palette = usePalette()
  const { bar } = useAlpha()
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1)

  return (
    <ChartCard title={title} note={note} span={span}>
      <div
        style={{
          padding: '16px 13px 12px',
          display: 'flex',
          alignItems: 'flex-end',
          gap: data.length > 8 ? 5 : 8,
          height,
        }}
      >
        {data.map((d, i) => {
          const on = hot === i
          const color = d.color ?? palette[0]!
          return (
            <div
              key={`${d.label}-${i}`}
              onMouseEnter={() => setHot(i)}
              onMouseLeave={() => setHot(null)}
              style={{
                flex: 1,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 6,
                position: 'relative',
                minWidth: 0,
              }}
            >
              {on && <Tooltip text={`${d.label} · ${format(d.value)}`} />}
              <div
                style={{
                  width: '100%',
                  height: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%`,
                  borderRadius: '3px 3px 0 0',
                  background: on ? color : hexAlpha(color, bar),
                  transition: 'background .12s',
                }}
              />
              <div
                style={{
                  font: '400 9.5px var(--font-mono), monospace',
                  color: 'var(--mut)',
                  whiteSpace: 'nowrap',
                }}
              >
                {d.label}
              </div>
            </div>
          )
        })}
      </div>
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// 3. Donut — span 4, r=54, stroke-width 21, rotated -90°
// ---------------------------------------------------------------------------

export function Donut({
  title,
  note,
  span = 4,
  data,
  centerValue,
  centerLabel,
  format = (v) => String(v),
}: {
  title: string
  note?: string
  span?: number
  data: { label: string; value: number; color?: string }[]
  centerValue: string
  centerLabel: string
  format?: (v: number) => string
}) {
  const palette = usePalette()
  const total = data.reduce((s, d) => s + d.value, 0)
  const C = 339.29 // 2πr for r=54
  let acc = 0

  const segments = data.map((d, i) => {
    const frac = total === 0 ? 0 : d.value / total
    const len = frac * C
    const offset = -acc
    acc += len
    return {
      ...d,
      color: d.color ?? palette[i % palette.length]!,
      dash: `${len.toFixed(2)} ${(C - len).toFixed(2)}`,
      offset: offset.toFixed(2),
      pct: Math.round(frac * 100),
    }
  })

  return (
    <ChartCard title={title} note={note} span={span}>
      <div
        style={{
          padding: '12px 13px 14px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div style={{ position: 'relative', flex: 'none', width: 112, height: 112 }}>
          <svg viewBox="0 0 140 140" style={{ width: 112, height: 112, transform: 'rotate(-90deg)' }} aria-hidden>
            <circle cx="70" cy="70" r="54" fill="none" stroke="var(--track)" strokeWidth="21" />
            {segments.map((s, i) => (
              <circle
                key={i}
                cx="70"
                cy="70"
                r="54"
                fill="none"
                stroke={s.color}
                strokeWidth="21"
                strokeDasharray={s.dash}
                strokeDashoffset={s.offset}
              />
            ))}
          </svg>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-.02em' }}>
              {centerValue}
            </div>
            <div
              style={{
                font: '400 9px var(--font-mono), monospace',
                color: 'var(--mut)',
                letterSpacing: '.06em',
              }}
            >
              {centerLabel}
            </div>
          </div>
        </div>
        <div
          style={{
            width: '100%',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {segments.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
              <span
                style={{ width: 9, height: 9, borderRadius: 3, background: s.color, flex: 'none' }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {s.label}
              </span>
              <span
                style={{
                  font: '500 10.5px var(--font-mono), monospace',
                  color: 'var(--mut)',
                  flex: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {format(s.value)} · {s.pct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// 4. Ranked horizontal bars — span 5, 7px track
// ---------------------------------------------------------------------------

export function RankedBars({
  title,
  note,
  span = 5,
  data,
  format = (v) => String(v),
  multicolor = false,
}: {
  title: string
  note?: string
  span?: number
  data: { label: string; value: number; color?: string }[]
  format?: (v: number) => string
  multicolor?: boolean
}) {
  const palette = usePalette()
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1)

  return (
    <ChartCard title={title} note={note} span={span}>
      <div
        style={{ padding: '13px 13px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}
      >
        {data.length === 0 && <Empty />}
        {data.map((d, i) => (
          <div key={`${d.label}-${i}`}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: 11.5,
                marginBottom: 4,
              }}
            >
              <span
                style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {d.label}
              </span>
              <span
                style={{
                  font: '500 11px var(--font-mono), monospace',
                  color: 'var(--mut)',
                  flex: 'none',
                }}
              >
                {format(d.value)}
              </span>
            </div>
            <div
              style={{
                height: 7,
                borderRadius: 4,
                background: 'var(--track)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${(Math.abs(d.value) / max) * 100}%`,
                  height: '100%',
                  borderRadius: 4,
                  background: d.color ?? (multicolor ? palette[i % palette.length] : palette[0]),
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// 5. Line chart — 600×190 viewBox, 4 gridlines, optional dashed second series
// ---------------------------------------------------------------------------

export function LineChart({
  title,
  note,
  span = 7,
  series,
  series2,
  labels,
  legend,
  height = 190,
}: {
  title: string
  note?: string
  span?: number
  series: number[]
  series2?: number[]
  labels: string[]
  legend?: [string, string]
  height?: number
}) {
  const palette = usePalette()
  const { area } = useAlpha()
  const all = [...series, ...(series2 ?? [])]
  const min = Math.min(...all, 0)
  const max = Math.max(...all, 1)
  const range = max - min || 1

  const map = (arr: number[]) =>
    arr
      .map((v, i) => {
        const x = (i / Math.max(1, arr.length - 1)) * 600
        const y = 170 - ((v - min) / range) * 145
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const points = map(series)

  return (
    <ChartCard title={title} note={note} span={span}>
      <div style={{ padding: '12px 13px 12px' }}>
        <svg
          viewBox="0 0 600 190"
          preserveAspectRatio="none"
          style={{ width: '100%', height, display: 'block' }}
          aria-hidden
        >
          {[30, 70, 110, 150].map((y) => (
            <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="var(--bd)" strokeWidth="1" />
          ))}
          <polyline
            points={`0,190 ${points} 600,190`}
            fill={hexAlpha(palette[0]!, area)}
            stroke="none"
          />
          <polyline
            points={points}
            fill="none"
            stroke={palette[0]}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {series2 && (
            <polyline
              points={map(series2)}
              fill="none"
              stroke={palette[1]}
              strokeWidth="2"
              strokeDasharray="5 4"
              strokeLinejoin="round"
            />
          )}
        </svg>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            font: '400 9px var(--font-mono), monospace',
            color: 'var(--mut)',
            marginTop: 6,
          }}
        >
          {labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
        {legend && (
          <div style={{ display: 'flex', gap: 14, marginTop: 9 }}>
            {legend.map((l, i) => (
              <div
                key={l}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: 'var(--mut)',
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 3,
                    background: i === 0 ? palette[0] : palette[1],
                    flex: 'none',
                  }}
                />
                {l}
              </div>
            ))}
          </div>
        )}
      </div>
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// 6. Heatmap — span 7, 19px cells at radius 3, alpha ramped 0.12 → 0.90
// ---------------------------------------------------------------------------

export function Heatmap({
  title,
  note,
  span = 7,
  rowLabels,
  colLabels,
  matrix,
  unit = '',
}: {
  title: string
  note?: string
  span?: number
  rowLabels: string[]
  colLabels: string[]
  matrix: number[][]
  unit?: string
}) {
  const palette = usePalette()
  const flat = matrix.flat()
  const max = Math.max(...flat, 1)

  return (
    <ChartCard title={title} note={note} span={span}>
      <div style={{ padding: '12px 13px 14px' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              paddingTop: 14,
              flex: 'none',
            }}
          >
            {rowLabels.map((r) => (
              <div
                key={r}
                style={{
                  height: 19,
                  display: 'flex',
                  alignItems: 'center',
                  font: '400 9px var(--font-mono), monospace',
                  color: 'var(--mut)',
                }}
              >
                {r}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${colLabels.length},1fr)`,
                gap: 4,
                marginBottom: 4,
              }}
            >
              {colLabels.map((c) => (
                <div
                  key={c}
                  style={{
                    textAlign: 'center',
                    font: '400 9px var(--font-mono), monospace',
                    color: 'var(--mut)',
                  }}
                >
                  {c}
                </div>
              ))}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${colLabels.length},1fr)`,
                gap: 4,
              }}
            >
              {matrix.flatMap((row, ri) =>
                row.map((v, ci) => (
                  <div
                    key={`${ri}-${ci}`}
                    title={`${rowLabels[ri]} · ${colLabels[ci]} · ${v}${unit}`}
                    style={{
                      height: 19,
                      borderRadius: 3,
                      background:
                        v === 0
                          ? 'var(--track)'
                          : hexAlpha(palette[0]!, 0.12 + (v / max) * 0.78),
                    }}
                  />
                )),
              )}
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 11,
            font: '400 9px var(--font-mono), monospace',
            color: 'var(--mut)',
          }}
        >
          <span>LOW</span>
          {[0.15, 0.35, 0.55, 0.75, 0.95].map((a) => (
            <span
              key={a}
              style={{
                width: 15,
                height: 8,
                borderRadius: 2,
                background: hexAlpha(palette[0]!, a),
                display: 'inline-block',
              }}
            />
          ))}
          <span>HIGH</span>
        </div>
      </div>
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// 7. Stacked bars — span 5, 9px rounded track split into palette segments
// ---------------------------------------------------------------------------

export function StackedBars({
  title,
  note,
  span = 5,
  rows,
  legend,
  format = (v) => String(v),
}: {
  title: string
  note?: string
  span?: number
  rows: { label: string; parts: number[] }[]
  legend: string[]
  format?: (v: number) => string
}) {
  const palette = usePalette()

  return (
    <ChartCard title={title} note={note} span={span}>
      <div
        style={{ padding: '13px 13px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}
      >
        {rows.length === 0 && <Empty />}
        {rows.map((r) => {
          const total = r.parts.reduce((a, b) => a + b, 0)
          return (
            <div key={r.label}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11.5,
                  marginBottom: 5,
                }}
              >
                <span>{r.label}</span>
                <span
                  style={{ font: '500 11px var(--font-mono), monospace', color: 'var(--mut)' }}
                >
                  {format(total)}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  height: 9,
                  borderRadius: 5,
                  overflow: 'hidden',
                  background: 'var(--track)',
                }}
              >
                {r.parts.map((p, i) => (
                  <div
                    key={i}
                    title={`${legend[i]} · ${format(p)}`}
                    style={{
                      width: total === 0 ? '0%' : `${(p / total) * 100}%`,
                      background: palette[i % palette.length],
                    }}
                  />
                ))}
              </div>
            </div>
          )
        })}
        <div style={{ display: 'flex', gap: 13, flexWrap: 'wrap', marginTop: 2 }}>
          {legend.map((l, i) => (
            <div
              key={l}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: 'var(--mut)',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 3,
                  background: palette[i % palette.length],
                  flex: 'none',
                }}
              />
              {l}
            </div>
          ))}
        </div>
      </div>
    </ChartCard>
  )
}

/** Charts driven by real tenant data will legitimately be empty on a new
 *  account. Saying so beats rendering a chart of nothing. */
function Empty() {
  return (
    <div style={{ fontSize: 11.5, color: 'var(--mut)', padding: '4px 0' }}>
      No data for this period yet.
    </div>
  )
}
