import fs from "fs/promises";
// Bitap search for fuzzy matching
function bitapSearch(text, pattern, maxErrors = 2) {
  const m = pattern.length;
  if (m === 0) return { isMatch: false, score: 1 };

  const patternMask = {};
  for (let i = 0; i < m; i++) {
    patternMask[pattern[i]] = (patternMask[pattern[i]] || 0) | (1 << i);
  }

  let R = new Array(maxErrors + 1).fill(0).map(() => ~1);
  const patternBitmask = (c) => patternMask[c] || 0;

  let bestScore = 1;
  let bestLocation = -1;

  for (let i = 0; i < text.length; i++) {
    let char = text[i];
    let charMask = patternBitmask(char);

    R[0] = ((R[0] << 1) | 1) & charMask;
    for (let d = 1; d <= maxErrors; d++) {
      R[d] =
        (((R[d] << 1) | 1) & charMask) |
        ((R[d - 1] << 1) | 1) |
        R[d - 1] |
        (R[d - 1] << 1);
    }

    if ((R[maxErrors] & (1 << (m - 1))) === 0) {
      const score = i - m + 1 >= 0 ? maxErrors + (i - m + 1) / text.length : 1;
      if (score < bestScore) {
        bestScore = score;
        bestLocation = i - m + 1;
      }
    }
  }

  return {
    isMatch: bestLocation !== -1,
    score: bestScore,
    index: bestLocation,
  };
}

/**
 * Splits markdown into chunks by headings and performs fuzzy search.
 * Prioritizes code-heavy chunks.
 *
 * @param {string} filePath - Path to the markdown file.
 * @param {string} query - Search term.
 * @param {number} maxResults - Max number of results to return.
 * @returns {Promise<string[]>} - Matching markdown chunks as formatted strings.
 */
export async function searchMarkdownDocs(filePath, query, maxResults = 5) {
  const content = await fs.readFile(filePath, "utf-8");

  const headingRegex = /^(#{1,6}) (.+)$/gm;
  const indices = [];
  let match;

  while ((match = headingRegex.exec(content)) !== null) {
    indices.push({
      index: match.index,
      heading: match[2],
      level: match[1].length,
    });
  }

  const chunks = [];
  const parentStack = [];
  for (let i = 0; i < indices.length; i++) {
    const { level, heading } = indices[i];
    while (
      parentStack.length > 0 &&
      parentStack[parentStack.length - 1].level >= level
    ) {
      parentStack.pop();
    }
    const parentIndex =
      parentStack.length > 0 ? parentStack[parentStack.length - 1].i : null;
    parentStack.push({ level, i });

    const start = indices[i].index;
    const end = i + 1 < indices.length ? indices[i + 1].index : content.length;
    const chunkText = content.slice(start, end).trim();

    if (chunkText) {
      // Extract code blocks
      const codeBlocks = [...chunkText.matchAll(/```[\s\S]*?```/g)].map(
        (m) => m[0],
      );
      // Remove heading line
      const headingLine = `#`.repeat(level) + " " + heading;
      let body = chunkText.replace(headingLine, "").trim();
      // Remove code blocks from body
      codeBlocks.forEach((cb) => {
        body = body.replace(cb, "");
      });
      body = body.trim();
      // Join code blocks as a single string
      const code = codeBlocks.join("\n\n");
      chunks.push({
        heading,
        body,
        code,
        level,
        parentIndex,
        parentHeading:
          parentIndex !== null ? indices[parentIndex].heading : null,
      });
    }
  }
  // Use bitapSearch for fuzzy scoring with weighted keys
  const weights = { heading: 0.4, body: 0.2, code: 0.4 };
  // Token-based fuzzy search for multi-word queries
  const queryTokens = query.split(/\s+/).filter(Boolean);
  const results = chunks.map((item) => {
    // Phrase match (case-insensitive)
    const phrase = query.toLowerCase();
    const heading = (item.heading || "").toLowerCase();
    const body = (item.body || "").toLowerCase();
    const code = (item.code || "").toLowerCase();
    let phraseScore = 0;
    let phraseInHeading = heading.includes(phrase);
    let phraseInCode = code.includes(phrase);
    let phraseInBody = body.includes(phrase);
    if (phraseInHeading || phraseInCode || phraseInBody) {
      phraseScore = 1; // perfect match for phrase
    }
    // Token presence count
    let tokenMatches = 0;
    let tokenInHeading = false;
    let tokenInCode = false;
    for (const token of queryTokens) {
      if (heading.includes(token.toLowerCase())) {
        tokenMatches++;
        tokenInHeading = true;
      } else if (code.includes(token.toLowerCase())) {
        tokenMatches++;
        tokenInCode = true;
      } else if (body.includes(token.toLowerCase())) {
        tokenMatches++;
      }
    }
    const tokenScore = tokenMatches / queryTokens.length;

    // Fuzzy score using bitapSearch (lower is better)
    const fuzzyHeading = bitapSearch(heading, phrase);
    const fuzzyBody = bitapSearch(body, phrase);
    const fuzzyCode = bitapSearch(code, phrase);
    // Weighted fuzzy score (lower is better)
    const fuzzyScore =
      weights.heading * fuzzyHeading.score +
      weights.body * fuzzyBody.score +
      weights.code * fuzzyCode.score;

    // Final score: prioritize phrase match, then token match, then fuzzy
    // Higher is better, so invert fuzzyScore (1 - fuzzyScore, clamp to >=0)
    let score;
    if (phraseScore > 0) {
      // Boost if phrase is in heading or code
      if (phraseInHeading) {
        score = 4 + tokenScore;
      } else if (phraseInCode) {
        score = 3.5 + tokenScore;
      } else {
        score = 2 + tokenScore;
      }
    } else if (tokenScore > 0) {
      // Boost if any token is in heading or code
      if (tokenInHeading) {
        score = 2.5 + tokenScore + Math.max(0, 1 - fuzzyScore);
      } else if (tokenInCode) {
        score = 2 + tokenScore + Math.max(0, 1 - fuzzyScore);
      } else {
        score = 1 + tokenScore + Math.max(0, 1 - fuzzyScore);
      }
    } else {
      score = Math.max(0, 1 - fuzzyScore);
    }
    return { item, score, fuzzyScore };
  });
  function buildHeadingChain(chunk, allChunks) {
    const chain = [];
    let current = chunk;
    while (current) {
      chain.unshift(current.heading);
      if (current.parentIndex !== null && allChunks[current.parentIndex]) {
        current = allChunks[current.parentIndex];
      } else {
        current = null;
      }
    }
    return chain;
  }

  const prioritized = results
    .filter(({ item }) => item.body && item.body.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ item }) => {
      const headingChain = buildHeadingChain(item, chunks).join(" > ");
      if (item.code && item.code.trim().length > 0) {
        return `${headingChain}\n\n${item.code.trim()}`;
      }
      // If no code blocks, skip by returning null
      return null;
    })
    .filter(Boolean);
  return prioritized;
}

const results = await searchMarkdownDocs("lib/llms-full.txt", "forupdate");
console.dir(results, { depth: null }); // Each result is now a string: "Header1 > Header2\nBody..."
