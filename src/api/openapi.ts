import { MODULES } from '@/modules/registry'
import { PERMISSIONS } from '@/auth/permissions'
import { EVENT_TYPES } from './events'
import { OPERATORS } from '@/modules/filters'

/**
 * OpenAPI 3.1 description, GENERATED from the module registry and the
 * permission catalogue.
 *
 * Hand-written API docs drift from the API within about two releases. Deriving
 * the resource list and the scope list from the same constants the routes use
 * means the document is wrong only if the code is wrong.
 */
export function buildOpenApiSpec(origin: string) {
  const tableModules = MODULES.filter((m) => m.kind === 'table')

  const listParams = [
    { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Free-text search across the resource, including hidden columns.' },
    { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Filter by a single status value.' },
    { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Column to sort by. Unknown values fall back to the default.' },
    { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    {
      name: 'filter',
      in: 'query',
      schema: { type: 'string' },
      description:
        'URL-encoded JSON: {"conditions":[{"field":"totalMinor","op":"gt","value":500000}]}. ' +
        `Operators: ${OPERATORS.join(', ')}. Custom fields are addressed as "custom.<key>".`,
    },
  ]

  const paths: Record<string, unknown> = {}

  for (const module of tableModules) {
    const columns = Object.fromEntries(
      module.columns.map((c) => [
        c.key,
        {
          type: c.money ? 'integer' : 'string',
          description: c.money
            ? `${c.label}, in minor units (cents). Pair with currencyCode.`
            : c.label,
        },
      ]),
    )

    paths[`/api/v1/${module.id}`] = {
      get: {
        summary: `List ${module.label.toLowerCase()}`,
        description: `${module.subtitle}. Filtering, sorting and paging are applied server-side.`,
        tags: [module.group],
        security: [{ bearerAuth: [] }],
        'x-required-scope': module.permission,
        parameters: listParams,
        responses: {
          '200': {
            description: 'A page of records.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'object', properties: columns } },
                    meta: { $ref: '#/components/schemas/PageMeta' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    }
  }

  // Write endpoints, declared explicitly because each has its own body.
  paths['/api/v1/invoices'] = {
    ...(paths['/api/v1/invoices'] as object),
    post: {
      summary: 'Create an invoice',
      description:
        'Creates a draft. Pass `issue: true` to issue it immediately, which posts it to the ' +
        'general ledger under the same double-entry rules as the UI.',
      tags: ['FINANCE'],
      security: [{ bearerAuth: [] }],
      'x-required-scope': 'invoice.create',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['direction', 'businessPartnerId', 'issueDate', 'lines'],
              properties: {
                direction: { type: 'string', enum: ['ar', 'ap'] },
                businessPartnerId: { type: 'string', format: 'uuid' },
                issueDate: { type: 'string', format: 'date' },
                dueDate: { type: 'string', format: 'date' },
                currencyCode: { type: 'string', minLength: 3, maxLength: 3 },
                fxRate: { type: 'number', description: 'Required when currencyCode differs from the base currency.' },
                issue: { type: 'boolean', default: false },
                lines: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    required: ['description', 'unitPriceMinor'],
                    properties: {
                      description: { type: 'string' },
                      quantity: { type: 'number', default: 1 },
                      unitPriceMinor: { type: 'integer', description: 'Minor units (cents).' },
                      taxRateId: { type: 'string', format: 'uuid' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'The created invoice.' },
        '422': { $ref: '#/components/responses/ValidationFailed' },
      },
    },
  }

  paths['/api/v1/payments'] = {
    post: {
      summary: 'Record a payment',
      description:
        'Records and allocates a payment. Posts realised FX when the settlement rate differs ' +
        'from the rate the invoice was booked at.',
      tags: ['FINANCE'],
      security: [{ bearerAuth: [] }],
      'x-required-scope': 'payment.record',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['direction', 'paymentDate', 'bankAccountId', 'amountMinor'],
              properties: {
                direction: { type: 'string', enum: ['in', 'out'] },
                paymentDate: { type: 'string', format: 'date' },
                bankAccountId: { type: 'string', format: 'uuid' },
                amountMinor: { type: 'integer' },
                currencyCode: { type: 'string' },
                fxRate: { type: 'number' },
                allocations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['invoiceId', 'amountMinor'],
                    properties: {
                      invoiceId: { type: 'string', format: 'uuid' },
                      amountMinor: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: { '200': { description: 'The recorded payment.' } },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Syncrèse API',
      version: '1.0.0',
      description: [
        'Every action available in the Syncrèse UI is available here, backed by the same',
        'services — so an invoice created through the API posts to the ledger under identical',
        'rules.',
        '',
        '## Authentication',
        'Send your key as a bearer token: `Authorization: Bearer syn_live_…`.',
        'Keys are scoped and tenant-bound; a key can never reach another organization’s data.',
        '',
        '## Money',
        'All monetary values are integers in MINOR UNITS (cents), paired with a `currencyCode`.',
        'There are no floats anywhere in this API. `123456` with `EUR` is €1,234.56.',
        '',
        '## Rate limits',
        'Every response carries `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset`',
        '(seconds until the window rolls). Exceeding the limit returns 429.',
        '',
        '## Webhooks',
        'Payloads are signed `HMAC-SHA256` over `{timestamp}.{body}` in the',
        '`syncrese-signature` header as `t=<unix>,v1=<hex>`. Verify the timestamp is recent',
        'before trusting the signature — a body-only signature is replayable forever.',
      ].join('\n'),
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key' },
      },
      schemas: {
        PageMeta: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            pageCount: { type: 'integer' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'object' },
              },
            },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing, invalid, revoked or expired API key.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        Forbidden: {
          description: 'The key is valid but lacks the required scope.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        RateLimited: {
          description: 'Rate limit exceeded.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        ValidationFailed: {
          description: 'The request body failed validation.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    paths,
    'x-scopes': PERMISSIONS,
    'x-webhook-events': EVENT_TYPES,
  }
}
