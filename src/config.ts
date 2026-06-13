// src/config.ts
import { z } from 'zod'
import dotenv from 'dotenv'
dotenv.config()

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // External APIs
  GOOGLE_PLACES_API_KEY: z.string().min(1),
  FOURSQUARE_API_KEY: z.string().min(1),
  EVENTBRITE_TOKEN: z.string().min(1),
  SKIDDLE_API_KEY: z.string().min(1),
  TICKETMASTER_API_KEY: z.string().min(1),

  // Storage
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default('whatson-photos'),
  R2_PUBLIC_URL: z.string().default(''),

  // Security
  API_SECRET: z.string().min(16),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌  Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data

export const LIVERPOOL = {
  lat: 53.4084,
  lng: -2.9916,
  radius: 8000,     // metres — covers city centre + suburbs
  bbox: '53.3,-3.05,53.5,-2.85', // OSM bounding box
}
