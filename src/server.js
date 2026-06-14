require('dotenv').config()

const path = require('path')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { pool } = require('./db/pool')
const { migrate } = require('./db/migrate')
const logger = require('./utils/logger')
const { config } = require('./config')

const app = express()
app.set('trust proxy', 1)

app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors())
app.use(express.json())
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, validate: { trustProxy: false } }))

// Serve the control panel dashboard at /app
app.use('/app', express.static(path.join(__dirname, '..', 'public')))

app.get('/health', async (req, res) => {
  let db = 'down'
  try { await pool.query('SELECT 1'); db = 'up' } catch (e) {}
  res.json({ status: 'ok', db, time: new Date().toISOString(), version: '1.0.0' })
})

// Attach req.userId from Bearer token when present (non-blocking)
app.use(require('./services/auth').withAuth)

app.use('/auth',   require('./routes/auth'))
app.use('/venues', require('./routes/venues'))
app.use('/events', require('./routes/events'))
app.use('/cities', require('./routes/cities'))
app.use('/enrich', require('./routes/enrich'))
app.use('/sync',   require('./routes/sync'))
app.use('/plan-night', require('./routes/plan'))
app.use('/weather', require('./routes/weather'))
app.use('/missions', require('./routes/missions'))
app.use('/checkins', require('./routes/checkins'))
app.use('/profile', require('./routes/profile'))

app.get('/', (req, res) => {
  res.json({
    name: "What'sOn API",
    dashboard: "/app/dashboard.html",
    endpoints: ['GET /health','GET /venues','GET /venues/:id','GET /events','GET /events/:id','GET /sync/liverpool?secret=','GET /sync/status']
  })
})

app.use((req, res) => res.status(404).json({ error: 'Not found' }))
app.use((err, req, res, next) => {
  logger.error('Error:', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

async function start() {
  try {
    logger.info('Running database migrations...')
    await migrate()
    logger.info('Migrations done.')
    try {
      const { seedMissions } = require('./services/seedMissions')
      const seeded = await seedMissions()
      if (seeded.created) logger.info(`Seeded ${seeded.created} curated missions.`)
    } catch (e) { logger.error('Mission seed skipped:', e.message) }
  } catch (err) {
    logger.error('Migration failed:', err.message)
  }
  app.listen(config.port, () => logger.info(`🚀 SAPPO API running on port ${config.port}`))
}

start()
process.on('SIGTERM', async () => { await pool.end(); process.exit(0) })
