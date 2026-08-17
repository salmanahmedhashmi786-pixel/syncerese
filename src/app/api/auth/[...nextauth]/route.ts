import { handlers } from '@/auth'

export const { GET, POST } = handlers

// argon2 is a native module — this route cannot run on the Edge runtime.
export const runtime = 'nodejs'
