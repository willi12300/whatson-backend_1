// src/api/offers.ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/client'
import { redis } from '../cache/redis'
import crypto from 'crypto'

const SECRET = process.env.API_SECRET || 'change_me'
const QR_TTL_SECONDS = 60

/**
 * Sign a QR token payload with HMAC-SHA256
 * Rotating signed tokens mean screenshots are useless after 60s
 */
function signToken(payload: object): string {
  const data = JSON.stringify(payload)
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex')
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url')
}

function verifyToken(token: string): object | null {
  try {
    const { data, sig } = JSON.parse(Buffer.from(token, 'base64url').toString())
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('hex')
    if (sig !== expected) return null
    const payload = JSON.parse(data)
    if (Date.now() > payload.exp) return null // expired
    return payload
  } catch {
    return null
  }
}

export async function offerRoutes(app: FastifyInstance) {

  // POST /offers/:id/claim
  // User claims an offer — creates a Claim record
  app.post('/offers/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = (req as any).userId // set by auth middleware

    const offer = await prisma.offer.findUnique({ where: { id } })
    if (!offer) return reply.code(404).send({ error: 'Offer not found' })
    if (offer.status !== 'ACTIVE') return reply.code(400).send({ error: 'Offer not active' })
    if (new Date() > offer.validUntil) return reply.code(400).send({ error: 'Offer expired' })
    if (new Date() < offer.validFrom) return reply.code(400).send({ error: 'Offer not yet active' })

    // Check redemption cap
    if (offer.redemptionCap) {
      if (offer.redemptionCount >= offer.redemptionCap) {
        return reply.code(400).send({ error: 'Offer fully redeemed' })
      }
    }

    // Check per-user limit
    const existingClaims = await prisma.offerClaim.count({
      where: { offerId: id, userId }
    })
    if (existingClaims >= offer.perUserLimit) {
      return reply.code(400).send({ error: 'Already claimed' })
    }

    const claim = await prisma.offerClaim.create({
      data: { offerId: id, userId, status: 'CLAIMED' }
    })

    // Track analytics
    await prisma.analyticsEvent.create({
      data: { type: 'offer_claim', venueId: offer.venueId, offerId: id, userId }
    })

    await prisma.offer.update({
      where: { id },
      data: { claimCount: { increment: 1 } }
    })

    return { claimId: claim.id, message: 'Offer claimed!' }
  })

  // GET /offers/claims/:claimId/qr
  // Returns a fresh rotating QR token for a claimed offer
  app.get('/offers/claims/:claimId/qr', async (req, reply) => {
    const { claimId } = req.params as { claimId: string }
    const userId = (req as any).userId

    const claim = await prisma.offerClaim.findUnique({
      where: { id: claimId },
      include: { offer: true }
    })

    if (!claim || claim.userId !== userId) {
      return reply.code(404).send({ error: 'Claim not found' })
    }
    if (claim.status === 'REDEEMED') {
      return reply.code(400).send({ error: 'Already redeemed' })
    }
    if (claim.status === 'EXPIRED') {
      return reply.code(400).send({ error: 'Claim expired' })
    }

    const now = Date.now()
    const payload = {
      claimId,
      userId,
      offerId: claim.offerId,
      venueId: claim.offer.venueId,
      iat: now,
      exp: now + (QR_TTL_SECONDS * 1000)
    }

    const token = signToken(payload)

    // Store token in DB for audit trail
    await prisma.qrToken.create({
      data: {
        claimId,
        signedToken: token,
        issuedAt: new Date(now),
        expiresAt: new Date(now + QR_TTL_SECONDS * 1000)
      }
    })

    return {
      token,
      expiresAt: new Date(payload.exp).toISOString(),
      ttlSeconds: QR_TTL_SECONDS
    }
  })

  // POST /offers/redeem
  // Staff scans user QR — validates and records redemption
  // Protected: staff PIN checked client-side, venueId verified server-side
  app.post('/offers/redeem', async (req, reply) => {
    const body = z.object({
      token: z.string(),
      staffVenueId: z.string(),
      gpsLat: z.number().optional(),
      gpsLng: z.number().optional()
    }).parse(req.body)

    const payload = verifyToken(body.token) as any
    if (!payload) {
      return reply.code(400).send({ error: 'Invalid or expired QR code' })
    }

    // Verify staff is scanning for the right venue
    if (payload.venueId !== body.staffVenueId) {
      return reply.code(403).send({ error: 'Token is not for this venue' })
    }

    // GPS sanity check (optional but recommended)
    if (body.gpsLat && body.gpsLng) {
      const venue = await prisma.venue.findUnique({ where: { id: payload.venueId } })
      if (venue) {
        const dist = Math.sqrt(
          Math.pow((body.gpsLat - venue.lat) * 111320, 2) +
          Math.pow((body.gpsLng - venue.lng) * 111320, 2)
        )
        if (dist > 500) {
          return reply.code(400).send({ error: 'Too far from venue' })
        }
      }
    }

    // Atomic redemption using Redis lock (prevent double-redemption race condition)
    const lockKey = `redeem_lock:${payload.claimId}`
    const locked = await redis.set(lockKey, '1', 'EX', 30, 'NX')
    if (!locked) {
      return reply.code(409).send({ error: 'Redemption in progress' })
    }

    try {
      // Check token not already consumed
      const qrToken = await prisma.qrToken.findUnique({
        where: { signedToken: body.token }
      })
      if (qrToken?.consumed) {
        return reply.code(400).send({ error: 'QR code already used' })
      }

      // Check claim not already redeemed
      const claim = await prisma.offerClaim.findUnique({ where: { id: payload.claimId } })
      if (!claim || claim.status !== 'CLAIMED') {
        return reply.code(400).send({ error: 'Claim already redeemed or invalid' })
      }

      // Execute redemption in a transaction
      const [redemption] = await prisma.$transaction([
        prisma.redemption.create({
          data: {
            claimId: payload.claimId,
            venueId: payload.venueId,
            userId: payload.userId,
            validatedBy: 'staff',
            gpsLat: body.gpsLat,
            gpsLng: body.gpsLng,
            tokenId: qrToken?.id
          }
        }),
        prisma.offerClaim.update({
          where: { id: payload.claimId },
          data: { status: 'REDEEMED' }
        }),
        prisma.qrToken.updateMany({
          where: { claimId: payload.claimId },
          data: { consumed: true }
        }),
        prisma.offer.update({
          where: { id: payload.offerId },
          data: { redemptionCount: { increment: 1 } }
        }),
        prisma.analyticsEvent.create({
          data: {
            type: 'offer_redemption',
            venueId: payload.venueId,
            offerId: payload.offerId,
            userId: payload.userId
          }
        })
      ])

      return {
        success: true,
        redemptionId: redemption.id,
        message: 'Offer redeemed successfully! 🎉'
      }
    } finally {
      await redis.del(lockKey)
    }
  })
}
