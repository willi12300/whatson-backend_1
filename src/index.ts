// src/index.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { config } from './config'
import { logger } from './utils/logger'
import { prisma } from './db/client'
import { redis } from './cache/redis'
import { venueRoutes } from './api/venues'
import { feedRoutes } from './api/feed'
import { offerRoutes } from './api/offers'

const app = Fastify({ logger: false })

// ── Security & middleware ──────────────────────────────────────────────────

app.register(helmet)
app.register(cors, {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://yourdomain.com']
    : true
})
app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  redis
})

// ── Auth middleware (placeholder — swap in Firebase/Supabase SDK) ─────────

app.addHook('preHandler', async (req, reply) => {
  const authHeader = req.headers.authorization
  if (!authHeader) return // unauthenticated is fine for public routes

  // TODO: verify Firebase/Supabase JWT here
  // const userId = await verifyJwt(authHeader.replace('Bearer ', ''))
  // ;(req as any).userId = userId
})

// ── Routes ────────────────────────────────────────────────────────────────

app.register(venueRoutes, { prefix: '/api/v1' })
app.register(feedRoutes, { prefix: '/api/v1' })
app.register(offerRoutes, { prefix: '/api/v1' })

app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  version: '1.0.0'
}))

// ── Start ─────────────────────────────────────────────────────────────────

async function start() {
  try {
    await redis.connect()
    await prisma.$connect()
    await app.listen({ port: config.PORT, host: '0.0.0.0' })
    logger.info(`🚀  What'sOn API running on port ${config.PORT}`)
  } catch (err) {
    logger.error(err)
    process.exit(1)
  }
}

process.on('SIGTERM', async () => {
  logger.info('Shutting down...')
  await prisma.$disconnect()
  await redis.disconnect()
  process.exit(0)
})

start()
