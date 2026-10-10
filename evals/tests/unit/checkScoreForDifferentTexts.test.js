/* eslint-disable no-console */
import { test } from 'node:test'
import assert from 'node:assert'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createEmbeddings } from '../../../lib/calculateEmbeddings.js'
import { getEmbeddings, loadChunks } from '../../../lib/embeddings.js'

const MINILM = 'sentence-transformers/all-MiniLM-L6-v2' //  128-token window
const NOMIC = 'nomic-ai/nomic-embed-text-v1.5' //          2048-token window

// This single chunk is 556 MiniLM tokens. MiniLM keeps only the first 126
// content tokens — the cut falls on line 7, inside the Remote Services intro.
// So the `#### Cloud SDK` section and the `onBehalfOf` strategy list are
// dropped before MiniLM embeds the text. Nomic embeds the full chunk.
const PROBE_TEXT = `#### Remote Services

Java:
Remote APIs can be invoked either on behalf of a named user or a technical user, depending on the callee's specification.
Thus, a client executing a business request within a specific user context might need to explicitly adjust the user propagation strategy.
CAP's Remote Services (/docs/guides/services/consuming-services) offer an easy and declarative way to define client-side representations of remote service APIs.
Such services integrate seamlessly with CAP, managing connection setup, including authentication and user propagation (/docs/java/cqn-services/remote-services#configuring-the-authentication-strategy):

\`\`\`yaml
cds:
  remote.services:
    SomeReuseService:
      binding:
        name: reuse-service-instance
        onBehalfOf: systemUserProvider
\`\`\`

The parameter \`onBehalfOf\` in the binding configuration section allows to define the following *user propagation* strategies:

- \`currentUser\` (default): Propagate the user of the current Request Context.

- \`systemUser\`: Propagate the (tenant-specific) technical user, based on the tenant set in the current Request Context.

- \`systemUserProvider\`: Propagate the technical user of the provider tenant.

::: tip
Remote Services configurations with \`destination\` section support \`onBehalfOf\` only in case of IAS App-2-App flows (/docs/java/cqn-services/remote-services#consuming-apis-from-other-ias-applications).
:::

Learn more about Remote Services in CAP Java (/docs/java/cqn-services/remote-services#remote-services)

Java:
#### Cloud SDK

On a programmatic level, the CAP runtime integrates with Cloud SDK (https://sap.github.io/cloud-sdk/) offering an abstraction for connection setup with remote services, including authentication and user propagation.
By default,

- the *tenant* of the current Request Context is propagated under the hood.

- the *user token* is propagated via Spring's \`SecurityContext\` (/docs/guides/security/cap-users#user-token).

- *user propagation strategy* can be specified with parameter values \`OnBehalfOf\` (https://sap.github.io/cloud-sdk/docs/java/features/connectivity/service-bindings#multitenancy-and-principal-propagation).

::: tip
Prefer using Remote Services (/docs/guides/security/cap-users#remote-services) built on Cloud SDK rather than natively consuming the Cloud SDK.
:::

Learn more about Cloud SDK integration in CAP Java (/docs/java/cqn-services/remote-services#cloud-sdk-integration)`

// KEPT query  -> topic lives in the first 126 tokens (Remote Services intro).
// DROPPED query -> topic lives only past the MiniLM cut (Cloud SDK section).
const KEPT_QUERY = 'How do CAP Java Remote Services represent remote service APIs on the client side?'
const DROPPED_QUERY = 'user propagation strategy'

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
  return dot / (normA * normB)
}

async function scoreUnder(model) {
  const dir = path.join(os.tmpdir(), `embed-score-${model.replace(/\//g, '--')}-${Date.now()}`)
  try {
    const result = await createEmbeddings('code-chunks', [PROBE_TEXT], dir, { model })
    const [chunk] = await loadChunks('code-chunks', result.outDir)
    const keptVec = await getEmbeddings(KEPT_QUERY, model)
    const droppedVec = await getEmbeddings(DROPPED_QUERY, model)
    return {
      kept: cosineSimilarity(keptVec, chunk.embeddings),
      dropped: cosineSimilarity(droppedVec, chunk.embeddings)
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test('MiniLM truncation lowers the score for content past its 128-token window', async () => {
  const miniLM = await scoreUnder(MINILM)
  const nomic = await scoreUnder(NOMIC)

  console.log('\nchunk score (cosine similarity of query vs chunk embedding)\n')
  console.log('model                               kept-topic   dropped-topic (Cloud SDK)')
  console.log(`${MINILM.padEnd(36)}${miniLM.kept.toFixed(4)}       ${miniLM.dropped.toFixed(4)}`)
  console.log(`${NOMIC.padEnd(36)}${nomic.kept.toFixed(4)}       ${nomic.dropped.toFixed(4)}`)
  console.log()
  console.log(`MiniLM gap (kept - dropped): ${(miniLM.kept - miniLM.dropped).toFixed(4)}`)
  console.log(`Nomic  gap (kept - dropped): ${(nomic.kept - nomic.dropped).toFixed(4)}\n`)

  // Core hypothesis: because MiniLM truncates the Cloud SDK section away, its
  // score drops more between the kept topic and the dropped topic than nomic's,
  // which embeds the whole chunk.
  const miniLMGap = miniLM.kept - miniLM.dropped
  const nomicGap = nomic.kept - nomic.dropped
  assert.ok(
    miniLMGap > nomicGap,
    `Expected MiniLM to lose more on the truncated topic than nomic. MiniLM gap=${miniLMGap.toFixed(4)}, nomic gap=${nomicGap.toFixed(4)}`
  )
})
