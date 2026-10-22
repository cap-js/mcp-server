export const OFFLINE = process.argv.includes('--offline') || process.env.CDS_MCP_OFFLINE === 'true'

export function preparationHint(model) {
  return `Prepare resources online with cds-mcp --download${model ? ` --model ${model}` : ''} (unset CDS_MCP_OFFLINE first).`
}
