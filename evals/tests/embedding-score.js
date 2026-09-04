// Usage: node evals/tests/embedding-score.js
import { getEmbeddings } from '../../lib/embeddings.js'

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const textA2 = "### Prefer @title and @description\n\n> Source: /docs/guides/uis/fiori#prefer-title-and-description\n\nInfluenced by the JSON Schema (https://json-schema.org), CDS supports the common annotations (/docs/cds/annotations#common-annotations) `@title` and `@description`, which are mapped to corresponding OData annotations (/docs/guides/protocols/odata#annotations) as follows:\n\n| CDS | JSON Schema | OData |\n|-|-|-|\n| `@title` | `title` | `@Common.Label` |\n| `@description` | `description` | `@Core.Description` |\n\nWe recommend preferring these annotations over the OData ones in protocol-agnostic data models and service models, for example:\n\n```cds\nannotate my.Books with { //...\n   title @title: 'Book Title';\n   author @title: 'Author ID';\n}\n```"
const textA = "### Prefer @title and @description\n\n> Source: /docs/guides/uis/fiori#prefer-title-and-description\n\nInfluenced by the JSON Schema, CDS supports the common annotations `@title` and `@description`, which are mapped to corresponding OData annotations as follows:\n\n| CDS | JSON Schema | OData |\n|-|-|-|\n| `@title` | `title` | `@Common.Label` |\n| `@description` | `description` | `@Core.Description` |\n\nWe recommend preferring these annotations over the OData ones in protocol-agnostic data models and service models, for example:\n\n```cds\nannotate my.Books with { //...\n   title @title: 'Book Title';\n   author @title: 'Author ID';\n}\n```"
const textB = "CDS Editors and IDEs > CDS Editors & LSP > Features and Functions\n\n#### Quick Fixes\n\n> Source: /docs/tools/cds-editors#quick-fixes\n\n+ Create using statement for unknown artifacts.\n\n+ Maintain missing translation.\n\n+ Convert `@cds.doc` and `@description` annotations to doc comments."

const questionString = "How do I use the common CDS annotations @title and @description?"

if (!textA || !textB) {
  console.error('Usage: node evals/tests/embedding-score.js "text one" "text two"')
  process.exit(1)
}

const [question, a, b] = await Promise.all([getEmbeddings(questionString), getEmbeddings(textA), getEmbeddings(textB)])
const scoreA = cosineSimilarity(question, a)
const scoreB = cosineSimilarity(question, b)
console.log(`Score against A: ${scoreA.toFixed(6)}`)
console.log(`Score against B: ${scoreB.toFixed(6)}`)
