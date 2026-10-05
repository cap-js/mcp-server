// General path and constant helpers shared across the test suites.
// Pure, side-effect-free — just computes embeddings/etag paths from the active
// model and the installed cds version. Keep bundle/fs-mock logic out of here.

import path from 'node:path'
import cds from '@sap/cds'
import { getActiveEmbeddingsDir } from '../../lib/calculateEmbeddings.js'

// Fixed commit id the mock server reports for the test bundle.
export const TEST_COMMIT_ID = '__test_bundle__'

// <embeddings>/<activeModelFolder>/etags
export function modelEtagsRoot() {
  return path.join(getActiveEmbeddingsDir(), 'etags')
}

// Etag path for the ACTIVE model and the installed cds version:
// <embeddings>/<activeModelFolder>/etags/<cds.version>/manifest.etag
export function getManifestEtagPath() {
  return path.join(modelEtagsRoot(), cds.version, 'manifest.etag')
}

// <embeddings>/<activeModelFolder>/<commitId>
export function versionDir(commitId) {
  return path.join(getActiveEmbeddingsDir(), commitId)
}
