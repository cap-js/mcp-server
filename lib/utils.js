export function configuredBoolean(name, defaultValue = false) {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

export function configuredNonEmptyString(name, defaultValue) {
  const value = process.env[name] ?? defaultValue
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
