import { apiRoute } from '@/api/handler'
import { emit } from '@/api/events'
import { recordPayment } from '@/finance/payments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/payments
 *
 * Records a payment and allocates it, through the same service the UI uses —
 * so an API-recorded payment posts realised FX, updates invoice status and
 * balances the ledger exactly as one entered by hand.
 */
export const POST = apiRoute('payment.record', async ({ ctx, tx, body }) => {
  const actor = { organizationId: ctx.organizationId, userId: null, requestId: ctx.requestId }

  const result = await recordPayment(tx, actor, body as never)

  await emit(tx, {
    organizationId: ctx.organizationId,
    type: 'payment.recorded',
    entityType: 'payment',
    entityId: result.id,
    payload: {
      paymentNo: result.paymentNo,
      fxDifferenceMinor: result.fxDifferenceMinor,
    },
  })

  return {
    data: {
      id: result.id,
      paymentNo: result.paymentNo,
      journalEntryId: result.journalEntryId,
      fxDifferenceMinor: result.fxDifferenceMinor,
    },
  }
})
