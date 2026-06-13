// src/server.js
// What'sOn backend — Express + PostgreSQL. Railway-ready.

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')

const { config, validate } = require('./config')
const logger = require('./utils/logger')
const { pool } = require('./db/pool')

const venuesRouter = require('./routes/venues')
const eventsRouter = require('./routes/events')
const syncRouter = require('./routes/sync')

validate() // warn about missing env vars

const app = express()

app.use(helmet())
app.use(cors()) // open CORS for the MVP; restrict to your frontend domain later
app.use(express.json())

// Basic rate limiting
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
)

// ── Routes ────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let db = 'down'
  try {
    await pool.query('SELECT 1')
    db = 'up'
  } catch (e) {
    db = 'down'
  }
  res.json({
    status: 'ok',
    db,
    time: new Date().toISOString(),
    version: '1.0.0',
  })
})

app.use('/venues', venuesRouter)
app.use('/events', eventsRouter)
app.use('/sync', syncRouter)

app.get('/', (req, res) => {
  res.json({
    name: "What'sOn API",
    endpoints: [
      'GET /health',
      'GET /venues',
      'GET /venues/:id',
      'GET /events',
      'GET /events/:id',
      'POST /sync/liverpool   (header: x-sync-secret)',
      'POST /sync/city/:city  (header: x-sync-secret)',
      'GET /sync/status',
    ],
  })
})

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }))

// Central error handler
app.use((err, req, res, next) => {
  logger.error('Request error:', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

// ── Start ─────────────────────────────────────────────────
const port = config.port
app.listen(port, () => {
  logger.info(`🚀 What'sOn API listening on port ${port}`)
  logger.info(`   Environment: ${config.nodeEnv}`)
})

// graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing pool...')
  await pool.end()
  process.exit(0)
})
