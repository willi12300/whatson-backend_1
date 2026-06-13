// src/api/venues.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/client'
import { redis } from '../cache/redis'
import { roundCoords } from '../utils/geo'

const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().min(100).max(10000).default(2000),
  type: z.string().optional(),
  hasEvents: z.coerce.boolean().optional(),
  limit: z.coerce.number().min(1).max(100).default(50)
})

export async function venueRoutes(app: FastifyInstance) {

  // GET /venues/nearby?lat=53.4084&lng=-2.9916&radius=2000
  app.get('/venues/nearby', async (req, reply) => {
    const q = nearbySchema.parse(req.query)
    const { lat, lng } = roundCoords(q.lat, q.lng, 3)

    const cacheKey = `venues:nearby:${lat}:${lng}:${q.radius}:${q.type || 'all'}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      reply.header('X-Cache', 'HIT')
      return JSON.parse(cached)
    }

    const venues = await prisma.$queryRaw<any[]>`
      SELECT
        v.id, v.name, v.lat, v.lng, v.address,
        v."venueType", v."subtypes", v."vibeTags",
        v.rating, v."ratingCount", v."priceLevel",
        v."coverPhoto", v.photos, v."businessStatus",
        v."openingHours", v."followerCount",
        v.claimed, v."instagramHandle",
        ST_Distance(
          ST_MakePoint(v.lng, v.lat)::geography,
          ST_MakePoint(${q.lng}, ${q.lat})::geography
        ) AS distance_m,
        COUNT(DISTINCT e.id) FILTER (
          WHERE e."startsAt" >= NOW() AND e."startsAt" <= NOW() + INTERVAL '24 hours'
        ) AS events_tonight,
        COUNT(DISTINCT vr.id) FILTER (
          WHERE vr."expiresAt" > NOW()
        ) AS active_vibe_reports,
        ROUND(AVG(vr.level) FILTER (WHERE vr."expiresAt" > NOW())) AS vibe_level,
        COUNT(DISTINCT ch.id) FILTER (
          WHERE ch."createdAt" >= NOW() - INTERVAL '2 hours'
        ) AS recent_checkins
      FROM "Venue" v
      LEFT JOIN "Event" e ON e."venueId" = v.id AND e.status = 'ACTIVE'
      LEFT JOIN "VibeReport" vr ON vr."venueId" = v.id
      LEFT JOIN "Checkin" ch ON ch."venueId" = v.id
      WHERE v.canonical = true
        AND ST_DWithin(
          ST_MakePoint(v.lng, v.lat)::geography,
          ST_MakePoint(${q.lng}, ${q.lat})::geography,
          ${q.radius}
        )
        ${q.type ? prisma.$raw`AND v."venueType" = ${q.type}::\"VenueType\"` : prisma.$raw``}
      GROUP BY v.id
      ORDER BY
        CASE WHEN v.claimed THEN 0 ELSE 1 END,
        distance_m ASC
      LIMIT ${q.limit}
    `

    const result = { venues, count: venues.length, radius: q.radius }
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 900) // 15 min TTL
    reply.header('X-Cache', 'MISS')
    return result
  })

  // GET /venues/:id — full venue profile
  app.get('/venues/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    const cacheKey = `venue:${id}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      reply.header('X-Cache', 'HIT')
      return JSON.parse(cached)
    }

    const venue = await prisma.venue.findUnique({
      where: { id },
      include: {
        events: {
          where: { status: 'ACTIVE', startsAt: { gte: new Date() } },
          orderBy: { startsAt: 'asc' },
          take: 10
        },
        posts: {
          where: {
            OR: [
              { expiresAt: null },
              { expiresAt: { gte: new Date() } }
            ]
          },
          orderBy: { createdAt: 'desc' },
          take: 20
        },
        offers: {
          where: {
            status: 'ACTIVE',
            validFrom: { lte: new Date() },
            validUntil: { gte: new Date() }
          }
        },
        communityPosts: {
          where: { status: 'active' },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            user: { select: { id: true, displayName: true, avatar: true } }
          }
        },
        _count: {
          select: { followers: true, checkins: true }
        }
      }
    })

    if (!venue) return reply.code(404).send({ error: 'Venue not found' })

    await redis.set(cacheKey, JSON.stringify(venue), 'EX', 300) // 5 min for profiles
    reply.header('X-Cache', 'MISS')
    return venue
  })

  // GET /venues/search?q=cavern&city=Liverpool
  app.get('/venues/search', async (req, reply) => {
    const { q, city = 'Liverpool' } = req.query as { q: string; city?: string }
    if (!q || q.length < 2) return reply.code(400).send({ error: 'Query too short' })

    const venues = await prisma.$queryRaw<any[]>`
      SELECT id, name, lat, lng, "venueType", "coverPhoto", address, rating, claimed
      FROM "Venue"
      WHERE canonical = true
        AND city = ${city}
        AND similarity(lower(name), lower(${q})) > 0.2
      ORDER BY similarity(lower(name), lower(${q})) DESC
      LIMIT 20
    `
    return { venues }
  })
}
