function synchronous(fn, description) {
  if (typeof fn !== 'function') {
    throw new TypeError(`${description} must be a synchronous function`)
  }
  return (context) => {
    const result = fn(context)
    if (result && typeof result.then === 'function') {
      // Observe rejected promises even though asynchronous stages are unsupported.
      Promise.resolve(result).catch(() => {})
      throw new TypeError(`${description} returned a promise; stages must be synchronous`)
    }
    return result
  }
}

/** Compile once per invocation. Insertions inherit their existing anchor's group. */
export function compileStages(defaults, { insert = [], wrap = {} } = {}) {
  const groups = new Map()
  const locations = new Map()
  const register = (stage, group) => {
    if (typeof stage.id !== 'string' || !stage.id.trim() || locations.has(stage.id)) {
      throw new Error(`Invalid or duplicate stage ID: ${stage.id}`)
    }
    locations.set(stage.id, group)
  }
  for (const [name, stages] of Object.entries(defaults)) {
    const group = stages.map((stage) => ({ ...stage }))
    groups.set(name, group)
    for (const stage of group) register(stage, group)
  }
  const lastAfter = new Map()
  for (const stage of insert) {
    if (Boolean(stage.before) === Boolean(stage.after)) {
      throw new Error(`Stage ${stage.id} must specify exactly one before/after anchor`)
    }
    const anchor = stage.before ?? stage.after
    const group = locations.get(anchor)
    if (!group) throw new Error(`Unknown stage anchor for ${stage.id}: ${anchor}`)
    register(stage, group)
    const position = stage.after ? (lastAfter.get(anchor) ?? anchor) : anchor
    const index = group.findIndex(({ id }) => id === position)
    group.splice(index + (stage.after ? 1 : 0), 0, { id: stage.id, run: stage.run })
    if (stage.after) lastAfter.set(anchor, stage.id)
  }

  for (const id of Object.keys(wrap)) {
    if (!locations.has(id)) throw new Error(`Unknown wrapped stage: ${id}`)
  }
  for (const stages of groups.values()) {
    for (const stage of stages) {
      stage.run = synchronous(stage.run, `Stage ${stage.id}`)
      if (Object.hasOwn(wrap, stage.id)) {
        const factory = synchronous(wrap[stage.id], `Wrapper factory ${stage.id}`)
        stage.run = synchronous(factory(stage.run), `Wrapped stage ${stage.id}`)
      }
    }
  }

  return (group, context) => {
    for (const stage of groups.get(group) ?? []) {
      if (context.skip && (group === 'section' || group === 'partition')) break
      try {
        stage.run(context)
      } catch (cause) {
        const section = context.section ?? context.sectionContext?.section
        const location = section ? ` in section ${JSON.stringify(section.heading)}` : ''
        throw new Error(`[chunkMarkdown:${stage.id}]${location}: ${cause.message}`, { cause })
      }
    }
  }
}
