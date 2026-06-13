// src/api/feed.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/client'
import { redis } from '../cache/redis'
import { roundCoords } from '../utils/geo'

export async function feedRoutes(app: FastifyInstance) {

  // GET /feed?lat=53.4&lng=-2.99&radius=2000
  // Returns merged venues + events sorted by relevance + recency
  app.get('/feed', async (req, reply) => {
    const q = z.object({
      lat: z.coerce.number(),
      lng: z.coerce.number(),
      radius: z.coerce.number().default(2000),
      filter: z.enum(['all', 'tonight', 'offers', 'free', 'music', 'food']).default('all')
    }).parse(req.query)

    const { lat, lng } = roundCoords(q.lat, q.lng, 2) // 2dp = ~1km cache zones
    const cacheKey = `feed:${lat}:${lng}:${q.radius}:${q.filter}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const now = new Date()
    const tonight = new Date(now)
    tonight.setHours(23, 59, 59)

    // Venues with active content nearby
    const venuesWithContent = await prisma.$queryRaw<any[]>`
      SELECT
        v.id, v.name, v.lat, v.lng, v."venueType", v."coverPhoto",
        v.rating, v.claimed, v."businessStatus",
        v."instagramHandle",
        ST_Distance(
          ST_MakePoint(v.lng, v.lat)::geography,
          ST_MakePoint(${q.lng}, ${q.lat})::geography
        ) AS distance_m,
        (SELECT json_agg(row_to_json(p) ORDER BY p."createdAt" DESC) FROM (
          SELECT id, type, title, body, "mediaUrl", "createdAt", "viewCount"
          FROM "Post" WHERE "venueId" = v.id
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY "createdAt" DESC LIMIT 3
        ) p) AS recent_posts,
        (SELECT json_agg(row_to_json(o)) FROM (
          SELECT id, title, terms, "validUntil", "redemptionCap", "redemptionCount"
          FROM "Offer" WHERE "venueId" = v.id
            AND status = 'ACTIVE' AND "validFrom" <= NOW() AND "validUntil" >= NOW()
          LIMIT 2
        ) o) AS active_offers,
        (SELECT json_agg(row_to_json(e)) FROM (
          SELECT id, name, "startsAt", "endsAt", "isFree", "minPrice", "imageUrl"
          FROM "Event" WHERE "venueId" = v.id
            AND status = 'ACTIVE' AND "startsAt" BETWEEN NOW() AND ${tonight}
          ORDER BY "startsAt" ASC LIMIT 3
        ) e) AS events_tonight,
        ROUND(AVG(vr.level) FILTER (WHERE vr."expiresAt" > NOW())) AS vibe_level,
        COUNT(DISTINCT vr.id) FILTER (WHERE vr."expiresAt" > NOW()) AS vibe_count
      FROM "Venue" v
      LEFT JOIN "VibeReport" vr ON vr."venueId" = v.id
      WHERE v.canonical = true
        AND v."businessStatus" != 'CLOSED_PERMANENTLY'
        AND ST_DWithin(
          ST_MakePoint(v.lng, v.lat)::geography,
          ST_MakePoint(${q.lng}, ${q.lat})::geography,
          ${q.radius}
        )
      GROUP BY v.id
      HAVING
        (SELECT COUNT(*) FROM "Post" WHERE "venueId" = v.id AND (expires_at IS NULL OR expires_at > NOW())) > 0
        OR (SELECT COUNT(*) FROM "Event" WHERE "venueId" = v.id AND status = 'ACTIVE' AND "startsAt" BETWEEN NOW() AND ${tonight}) > 0
        OR (SELECT COUNT(*) FROM "Offer" WHERE "venueId" = v.id AND status = 'ACTIVE' AND "validFrom" <= NOW() AND "validUntil" >= NOW()) > 0
      ORDER BY
        CASE WHEN (SELECT COUNT(*) FROM "Offer" WHERE "venueId" = v.id AND status = 'ACTIVE' AND "validFrom" <= NOW() AND "validUntil" >= NOW()) > 0 THEN 0 ELSE 1 END,
        CASE WHEN (SELECT COUNT(*) FROM "Event" WHERE "venueId" = v.id AND status = 'ACTIVE' AND "startsAt" BETWEEN NOW() AND ${tonight}) > 0 THEN 0 ELSE 1 END,
        distance_m ASC
      LIMIT 40
    `

    const result = { items: venuesWithContent, generatedAt: now.toISOString() }
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
    return result
  })
}
