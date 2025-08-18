export default function fuzzyTopN(searchTerm, list, n, min) {
  function modifiedLevenshtein(a, b) {
    const m = a.length
    const n = b.length
    const matrix = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

    for (let i = 0; i <= m; i++) matrix[i][0] = i * 0.5
    for (let j = 0; j <= n; j++) matrix[0][j] = j * 0.5

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 0.5, // deletion
          matrix[i][j - 1] + 0.5, // insertion
          matrix[i - 1][j - 1] + cost // substitution
        )
      }
    }

    return matrix[m][n]
  }

  function score(term, content) {
    term = term.toLowerCase()
    content = content.toLowerCase()
    const distance = modifiedLevenshtein(term, content)
    const maxLength = Math.max(term.length, content.length)
    return maxLength === 0 ? 1 : 1 - distance / maxLength
  }

  let result = list.map(item => ({ item, score: score(searchTerm, item) }))
  if (min) result = result.filter(entry => entry.score >= min)
  return result.sort((a, b) => b.score - a.score).slice(0, n)
}
