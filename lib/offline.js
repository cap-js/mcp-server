import { configuredBoolean } from './utils.js'

export const OFFLINE = process.argv.includes('--offline') || configuredBoolean('CDS_MCP_OFFLINE')

export function preparationHint(model) {
  return `Prepare resources online with cds-mcp --download${model ? ` --model ${model}` : ''} (unset CDS_MCP_OFFLINE first).`
}
