// src/cache/redis.ts
import IORedis from 'ioredis'
import { config } from '../config'
import { logger } from '../utils/logger'

export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true
})

redis.on('error', (err) => logger.error({ err }, 'Redis connection error'))
redis.on('connect', () => logger.info('Redis connected'))
