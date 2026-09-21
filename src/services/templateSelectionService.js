async function selectFirstBuildableTemplate(rankedTemplates, build) {
  for (const template of rankedTemplates) {
    const assembled = await build(template)
    if (assembled?.valid) return { template, assembled }
  }
  return null
}
module.exports = { selectFirstBuildableTemplate }
