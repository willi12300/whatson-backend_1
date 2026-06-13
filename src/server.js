require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { pool } = require('./db/pool')
const { migrate } = require('./db/migrate')
const logger = require('./utils/logger')
const { config } = require('./config')

const app = express()

// Required for Railway — tells Express to trust Railway's proxy
app.set('trust proxy', 1)

app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }))

// ── Routes ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let db = 'down'
  try { await pool.query('SELECT 1'); db = 'up' } catch (e) {}
  res.json({ status: 'ok', db, time: new Date().toISOString(), version: '1.0.0' })
})

app.use('/venues', require('./routes/venues'))
app.use('/events', require('./routes/events'))
app.use('/sync',   require('./routes/sync'))

app.get('/', (req, res) => {
  res.json({
    name: "What'sOn API",
    endpoints: [
      'GET  /health',
      'GET  /venues',
      'GET  /venues/:id',
      'GET  /events',
      'GET  /events/:id',
      'POST /sync/liverpool',
      'POST /sync/city/:city',
      'GET  /sync/status',
    ]
  })
})

app.use((req, res) => res.status(404).json({ error: 'Not found' }))
app.use((err, req, res, next) => {
  logger.error('Error:', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

// ── Start: run migration first, then listen ─────────────────
async function start() {
  try {
    logger.info('Running database migrations...')
    await migrate()
    logger.info('Migrations done.')
  } catch (err) {
    logger.error('Migration failed:', err.message)
  }

  const port = config.port
  app.listen(port, () => {
    logger.info(`🚀 What'sOn API running on port ${port}`)
  })
}

start()

process.on('SIGTERM', async () => {
  await pool.end()
  process.exit(0)
})
