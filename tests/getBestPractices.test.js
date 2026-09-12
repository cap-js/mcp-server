// Node.js test runner (test) for lib/getBestPractices.js
import getBestPractices from '../lib/getBestPractices.js'
import assert from 'node:assert'
import { test, mock } from 'node:test'
import fs from 'fs/promises'
import path from 'path'

test.describe('getBestPractices', () => {
  test('should fetch and return best practices', async () => {
    // Mock fetch to avoid actual network requests
    global.fetch = mock.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Map([['etag', 'W/"12345"']]),
        text: async () => `
          <html>
            <body>
              <div id="some-other-content">...</div>
              <h2 id="proven-best-practices">Proven Best Practices</h2>
              <div>
                <p>This is a best practice.</p>
                <ul>
                  <li>Use this</li>
                  <li>Not that</li>
                </ul>
              </div>
            </body>
          </html>
        `
      }
    })

    // Mock fs.writeFile to prevent writing to disk
    mock.method(fs, 'writeFile', async () => {})

    const result = await getBestPractices()

    assert(typeof result === 'string', 'Result should be a string')
    assert(result.includes('This is a best practice.'), 'Result should contain best practice text')
    assert(result.includes('*   Use this'), 'Result should contain list items')
  })

  test('should use cached version on fetch failure', async () => {
    // Mock fetch to simulate a failure
    global.fetch = mock.fn(async () => {
      return {
        ok: false,
        status: 500
      }
    })

    const cachedContent = '## Proven Best Practices\n\nThis is the cached content.'
    // Mock fs.readFile to return cached content
    mock.method(fs, 'readFile', async () => cachedContent)

    const result = await getBestPractices()

    assert.equal(result, cachedContent, 'Should return cached content on failure')
  })
})
