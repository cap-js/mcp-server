// Subprocess fetch mock — loaded via NODE_OPTIONS=--import "file://..."
// Reads bundle from CDS_MCP_TEST_BUNDLE_PATH, serves it for any fetch call.
import { readFileSync } from 'node:fs'

const frame = readFileSync(process.env.CDS_MCP_TEST_BUNDLE_PATH)
const commitId = process.env.CDS_MCP_TEST_BUNDLE_VERSION ?? '__test_bundle__'

globalThis.fetch = async (_url, _init) =>
  new Response(frame, {
    status: 200,
    headers: {
      etag: `W/"${commitId}"`,
      'x-embeddings-version': commitId,
      'content-type': 'application/octet-stream'
    }
  })
