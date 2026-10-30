import { filterChunks } from '../../../chunker/stages/08-filterChunks.js'

function isRelease(chunk) {
  return /\/docs\/releases\//.test(chunk.source ?? '')
}

export const capireFilterPolicy = {
  exclude: isRelease,
  dropAnchorOnly: true,
  dropValueless: true,
  dropRedirectStubs: true,
  deduplicate: true
}

export function filter(chunks, config) {
  const { outputFilter, dropped } = filterChunks(chunks, config, capireFilterPolicy)
  return {
    outputFilter,
    dropped: {
      releases: dropped.excluded,
      emptyBody: dropped.emptyBody,
      anchorOnlyBody: dropped.anchorOnlyBody,
      valueless: dropped.valueless,
      redirectStub: dropped.redirectStub,
      toSmallBody: dropped.tooSmallBody,
      duplicates: dropped.duplicates
    }
  }
}
