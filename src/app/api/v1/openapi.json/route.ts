import { NextResponse } from 'next/server'
import { buildOpenApiSpec } from '@/api/openapi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The API description. Public and unauthenticated on purpose — it documents
 * shapes and scopes, never data, and an integrator needs to read it before they
 * have a key.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const origin = new URL(request.url).origin
  return NextResponse.json(buildOpenApiSpec(origin), {
    headers: { 'cache-control': 'public, max-age=300' },
  })
}
