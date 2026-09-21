const { query } = require('../db/pool')
async function listTemplates() {
  const { rows } = await query('SELECT * FROM experience_templates WHERE active=TRUE ORDER BY id')
  if (!rows.length) return []
  const ids = rows.map(t => t.id)
  const [stops, rules] = await Promise.all([
    query('SELECT * FROM experience_template_stops WHERE template_id = ANY($1::bigint[]) ORDER BY template_id, stop_order', [ids]),
    query('SELECT * FROM experience_template_rules WHERE template_id = ANY($1::bigint[]) ORDER BY template_id, id', [ids]),
  ])
  return rows.map(t => ({ ...t, stops: stops.rows.filter(s => String(s.template_id) === String(t.id)), rules: rules.rows.filter(r => String(r.template_id) === String(t.id)) }))
}
module.exports = { listTemplates }
