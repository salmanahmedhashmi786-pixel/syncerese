'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, chipButtonStyle, inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { eraseSubjectAction, findSubjectsAction } from '@/app/actions/gdpr'
import type { DataSubject, ErasureReport } from '@/server/gdpr'

/**
 * Subject access requests and erasure.
 *
 * The person operating this is usually not a lawyer and is usually under a
 * 30-day clock, so the panel states plainly what each button does and — for
 * erasure — what will survive it and why. An erasure tool that silently keeps
 * the invoices leaves the controller unable to answer the obvious follow-up
 * question.
 */

const SUBJECT_LABEL: Record<string, string> = {
  user: 'Workspace member',
  partner_contact: 'Customer / supplier contact',
}

export function PrivacyPanel({ canManage }: { canManage: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [email, setEmail] = useState('')
  const [results, setResults] = useState<DataSubject[] | null>(null)
  const [erasing, setErasing] = useState<DataSubject | null>(null)
  const [reason, setReason] = useState('')
  const [report, setReport] = useState<ErasureReport | null>(null)

  if (!canManage) {
    return (
      <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Privacy &amp; data</div>
        <div style={{ color: 'var(--mut)', fontSize: 12 }}>
          Only an owner or admin can run subject access requests and erasures.
        </div>
      </section>
    )
  }

  const search = () =>
    startTransition(async () => {
      const result = await findSubjectsAction(email)
      if (result.ok) {
        setResults(result.data)
        if (result.data.length === 0) toast('Nobody in this workspace has that address')
      } else {
        toast(result.error, 'err')
      }
    })

  const confirmErase = () => {
    if (!erasing) return
    startTransition(async () => {
      const result = await eraseSubjectAction({
        subjectType: erasing.subjectType,
        subjectId: erasing.subjectId,
        reason,
      })
      if (result.ok) {
        setReport(result.data)
        setErasing(null)
        setReason('')
        setResults(null)
        setEmail('')
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })
  }

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Privacy &amp; data</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.55 }}>
        Answer a subject access request, erase someone from the operational records, or take a
        full copy of everything this organization holds.
      </div>

      {/* --- subject lookup ------------------------------------------------ */}
      <div style={{ ...labelStyle, marginBottom: 8 }}>FIND A PERSON</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="email"
          placeholder="the email address on the request"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          onClick={search}
          disabled={pending}
          style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
        >
          {pending ? 'Looking…' : 'Look up'}
        </button>
      </div>

      {results && results.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {results.map((s) => (
            <div
              key={`${s.subjectType}:${s.subjectId}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 0',
                borderBottom: '1px solid var(--bd)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>
                  {s.name ?? '—'} {s.erased && <Badge color="#6b7382">already erased</Badge>}
                </div>
                <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 1 }}>
                  {SUBJECT_LABEL[s.subjectType] ?? s.subjectType} · {s.email ?? 'no address'}
                </div>
              </div>

              <a
                href={`/api/gdpr/export?subjectType=${encodeURIComponent(s.subjectType)}&subjectId=${encodeURIComponent(s.subjectId)}`}
                style={{ ...chipButtonStyle, fontFamily: 'inherit', textDecoration: 'none' }}
              >
                Export
              </a>
              {!s.erased && (
                <button
                  type="button"
                  onClick={() => {
                    setErasing(s)
                    setReport(null)
                  }}
                  style={{ ...chipButtonStyle, fontFamily: 'inherit', color: '#dc2626' }}
                >
                  Erase
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* --- erasure confirmation ------------------------------------------ */}
      {erasing && (
        <div
          style={{
            marginTop: 14,
            padding: '13px 15px',
            border: '1px solid #dc2626',
            borderRadius: 8,
            background: 'rgba(220,38,38,.05)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
            Erase {erasing.name ?? erasing.email} — this cannot be undone
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.6, margin: '0 0 10px' }}>
            Their name, email, phone and any custom field values are destroyed and replaced with
            a non-identifying placeholder.{' '}
            <strong style={{ color: 'var(--fg)' }}>
              Invoices, credit notes and the ledger are kept
            </strong>{' '}
            — Art. 17(3)(b) disapplies erasure where retention is required by law, and every
            member state requires accounting records to be held for six to ten years. The person
            is no longer identifiable from the operational data; the books still balance.
          </p>

          <label style={{ ...labelStyle, display: 'block', marginBottom: 5 }}>
            REASON FOR THE RECORD *
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Article 17 request received by email on 14 August 2026"
            style={{ ...inputStyle, height: 'auto', padding: '7px 9px', resize: 'vertical', width: '100%' }}
          />
          <div style={{ color: 'var(--mut)', fontSize: 10.5, margin: '4px 0 10px' }}>
            Kept as evidence the request was honoured (Art. 5(2) accountability).
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => setErasing(null)}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmErase}
              disabled={pending || reason.trim().length < 3}
              style={{
                ...primaryButtonStyle,
                fontFamily: 'inherit',
                background: '#dc2626',
                opacity: pending || reason.trim().length < 3 ? 0.5 : 1,
              }}
            >
              {pending ? 'Erasing…' : 'Erase permanently'}
            </button>
          </div>
        </div>
      )}

      {/* --- report --------------------------------------------------------- */}
      {report && (
        <div
          style={{
            marginTop: 14,
            padding: '13px 15px',
            border: '1px solid var(--bd)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Erasure completed</div>
          <div style={{ ...labelStyle, marginBottom: 4 }}>DESTROYED</div>
          <ul style={{ margin: '0 0 10px', paddingLeft: 16, fontSize: 11.5, lineHeight: 1.6 }}>
            {report.erased.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <div style={{ ...labelStyle, marginBottom: 4 }}>KEPT, AND WHY</div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 16,
              fontSize: 11.5,
              lineHeight: 1.6,
              color: 'var(--mut)',
            }}
          >
            {report.retained.map((r) => (
              <li key={r.category}>
                <strong style={{ color: 'var(--fg)' }}>{r.category}</strong> — {r.basis}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- organization export -------------------------------------------- */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--bd)' }}>
        <div style={{ ...labelStyle, marginBottom: 6 }}>EXPORT EVERYTHING</div>
        <p style={{ fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.55, margin: '0 0 10px' }}>
          A complete JSON copy of this organization — partners, contacts, the chart of accounts,
          every journal entry, invoice and payment. Generated on request and never stored on the
          server, so there is no export file sitting anywhere waiting to leak. Credentials and API
          keys are excluded.
        </p>
        {/* A real anchor, not next/link: this is a route handler that streams a
            file back with Content-Disposition. A client-side transition would
            try to render the JSON as a page instead of downloading it. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/api/gdpr/export"
          style={{ ...chipButtonStyle, fontFamily: 'inherit', textDecoration: 'none' }}
        >
          Download organization export
        </a>
      </div>

      {/* --- cookies --------------------------------------------------------- */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--bd)' }}>
        <div style={{ ...labelStyle, marginBottom: 6 }}>COOKIES</div>
        <p style={{ fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.55, margin: 0 }}>
          Syncrèse sets two cookies: your session, and which organization you are currently
          looking at. Both are strictly necessary to provide the service you asked for, so under
          the ePrivacy Directive neither requires consent and there is no cookie banner. There is
          no analytics, advertising or third-party tracking in this application.
        </p>
      </div>
    </section>
  )
}

const labelStyle: React.CSSProperties = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
}
