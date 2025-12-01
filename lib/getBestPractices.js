import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import * as cheerio from 'cheerio'
import TurndownService from 'turndown'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bestPracticesPath = path.join(__dirname, '..', 'best-practices.md')
const etagPath = path.join(__dirname, '..', 'best-practices.etag')

async function downloadBestPractices() {
  try {
    await fs.mkdir(path.dirname(bestPracticesPath), { recursive: true })
    // Ensure the file exists before proceeding, creating it if necessary.
    try {
      await fs.access(bestPracticesPath)
    } catch {
      await fs.writeFile(bestPracticesPath, '')
    }

    const urls = {
      best: 'https://cap.cloud.sap/docs/about/best-practices',
      bad: 'https://cap.cloud.sap/docs/about/bad-practices'
    }

    let storedEtags = { best: null, bad: null }
    try {
      const etagContent = await fs.readFile(etagPath, 'utf-8')
      const [bestEtag, badEtag] = etagContent.split('\n')
      storedEtags = { best: bestEtag, bad: badEtag }
    } catch {
      // No stored ETag found
    }

    const fetchOptions = (etag) => (etag ? { headers: { 'If-None-Match': etag } } : {})

    const [bestPracticeResponse, badPracticeResponse] = await Promise.all([
      fetch(urls.best, fetchOptions(storedEtags.best)),
      fetch(urls.bad, fetchOptions(storedEtags.bad))
    ])

    if (bestPracticeResponse.status === 304 && badPracticeResponse.status === 304) {
      // Content is unchanged for both
      return
    }

    const turndownService = new TurndownService()

    const processResponse = async (response) => {
      if (response.status === 304) return { content: null, etag: response.headers.get('etag') }
      if (!response.ok) throw new Error(`Failed to download from ${response.url}: ${response.status}`)
      const html = await response.text()
      const $ = cheerio.load(html)
      
      // Remove unwanted sections
      $('aside, nav, footer').remove()
      
      // Only select headers and paragraphs
      const filteredElements = $('h1, h2, h3, h4, h5, h6, p')
      const filteredHtml = $('<div>').append(filteredElements).html()
      
      return {
        content: turndownService.turndown(filteredHtml || ''),
        etag: response.headers.get('etag')
      }
    }

    const [bestResult, badResult] = await Promise.all([
      processResponse(bestPracticeResponse),
      processResponse(badPracticeResponse)
    ])

    let bestPracticesMd = bestResult.content
    if (!bestPracticesMd) {
      const cachedContent = await fs.readFile(bestPracticesPath, 'utf-8')
      bestPracticesMd = cachedContent.split('# Things to Avoid')[0]
    }

    let badPracticesMd = badResult.content
    if (!badPracticesMd) {
      const cachedContent = await fs.readFile(bestPracticesPath, 'utf-8')
      const sections = cachedContent.split('# Things to Avoid')
      badPracticesMd = sections.length > 1 ? sections[1] : ''
    }

    const combinedMarkdown = `# Best Practices\n\n${bestPracticesMd}\n\n# Things to Avoid\n\n${badPracticesMd}`
    await fs.writeFile(bestPracticesPath, combinedMarkdown)

    const newBestEtag = bestResult.etag || storedEtags.best
    const newBadEtag = badResult.etag || storedEtags.bad
    if (newBestEtag && newBadEtag) {
      await fs.writeFile(etagPath, `${newBestEtag}\n${newBadEtag}`)
    }
  } catch (error) {
    console.error('Error downloading best practices:', error)
    try {
      await fs.access(bestPracticesPath)
    } catch (e) {
      throw new Error('Failed to fetch best practices and no cached version is available.')
    }
  }
}

export default async function getBestPractices({ filePath } = {}) {
  // Always download and read the official best practices first.
  await downloadBestPractices()
  const officialContent = await fs.readFile(bestPracticesPath, 'utf-8')

  // If no custom file path is provided, just return the official content.
  if (!filePath) {
    return officialContent
  }

  // If a custom file path is provided, read it and append its content.
  try {
    const customContent = await fs.readFile(filePath, 'utf-8')
    // Combine the official and custom content with a clear separator.
    return `${officialContent}\n\n---\n\n# Custom Guidelines\n\n${customContent}`
  } catch (error) {
    console.error(`Error reading custom guidelines file: ${error.message}`)
    throw new Error(`Could not read the file at ${filePath}. Please ensure the path is correct and the file exists.`)
  }
}
