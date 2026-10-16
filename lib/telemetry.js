import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function resolveLogPath() {
    const env = process.env.CDS_MCP_TELEMETRY_FILE
    if (env === '') return null
    return env ?? join(homedir(), '.cds-mcp-telemetry.ndjson')
}

export function record(entry) {
    const path = resolveLogPath()
    if (!path) return
    appendFile(path, JSON.stringify(entry) + '\n').catch(() => {})
}
