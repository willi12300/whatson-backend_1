const ts = () => new Date().toISOString()

const logger = {
  info:  (...a) => console.log(`[INFO  ${ts()}]`, ...a),
  warn:  (...a) => console.warn(`[WARN  ${ts()}]`, ...a),
  error: (...a) => console.error(`[ERROR ${ts()}]`, ...a),
  debug: (...a) => { if (process.env.NODE_ENV !== 'production') console.log(`[DEBUG ${ts()}]`, ...a) },
}

module.exports = logger
