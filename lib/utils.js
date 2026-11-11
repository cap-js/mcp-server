import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const embeddingCliOptions = {
  'min-tokens': { type: 'string' },
  'max-heading-depth': { type: 'string' },
  input: { type: 'string' },
  output: { type: 'string' },
  model: { type: 'string' }
}

export function embeddingCliOverrides(values) {
  const overrides = {}
  if (values['min-tokens'] !== undefined) overrides.minTokens = Number(values['min-tokens'])
  if (values['max-heading-depth'] !== undefined)
    overrides.maxHeadingDepth = Number(values['max-heading-depth'])
  if (values.input !== undefined) overrides.input = values.input
  if (values.model !== undefined) overrides.model = values.model
  if (values.output !== undefined) overrides.output = values.output
  return overrides
}

export async function embeddingCliConfig(overrides) {
  const { input, output, model, ...chunkingConfig } = overrides
  if (input !== undefined) chunkingConfig.text = await readFile(input, 'utf8')
  const embeddingConfig = {}
  if (model !== undefined) embeddingConfig.model = model
  if (output !== undefined) embeddingConfig.dir = path.dirname(path.resolve(output))
  return { chunkingConfig, embeddingConfig }
}

export function configuredBoolean(name, defaultValue = false) {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

export function configuredNonEmptyString(name, defaultValue) {
  const value = process.env[name] ?? defaultValue
  if (value === undefined) return value
  if (!value.trim()) throw new Error(`${name} must not be empty`)
  return value
}

export function configuredPositiveInteger(name, defaultValue, { maximum, unit } = {}) {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    const unitDescription = unit ? ` number of ${unit}` : ''
    const maximumDescription = maximum !== undefined ? ` no greater than ${maximum}` : ''
    throw new Error(`${name} must be a positive integer${unitDescription}${maximumDescription}`)
  }
  return value
}
