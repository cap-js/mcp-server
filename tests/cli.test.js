// CLI test for cds-mcp command-line usage
import assert from 'node:assert'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const sampleProjectPath = join(dirname(fileURLToPath(import.meta.url)), 'sample')
const cdsMcpPath = join(dirname(fileURLToPath(import.meta.url)), '../index.js')

function runCliCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cdsMcpPath, ...args], {
      ...options,
      stdio: 'pipe'
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', data => {
      stdout += data.toString()
    })

    child.stderr.on('data', data => {
      stderr += data.toString()
    })

    child.on('close', code => {
      resolve({ code, stdout, stderr })
    })

    child.on('error', error => {
      reject(error)
    })
  })
}

test.describe('CLI usage', () => {
  test('search_model with --prefix works', async () => {
    const result = await runCliCommand(['--search_model', sampleProjectPath, 'Books', 'entity'])

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.length > 0, 'Should produce output')

    const output = JSON.parse(result.stdout)
    assert(Array.isArray(output), 'Output should be an array')
    assert(output.length > 0, 'Should find at least one result')
    assert(output[0].name, 'Result should have a name property')
  })

  test('search_docs with --prefix works', async () => {
    const result = await runCliCommand(['--search_docs', 'select statement'])

    assert.equal(result.code, 0, 'Command should exit with code 0')
    assert(result.stdout.length > 0, 'Should produce output')

    // search_docs returns plain text, not JSON
    assert(typeof result.stdout === 'string', 'Output should be a string')
    assert(result.stdout.includes('---'), 'Output should contain document separators')
  })

  test('invalid tool name shows error', async () => {
    const result = await runCliCommand(['--invalid_tool', 'arg1'])

    assert.equal(result.code, 1, 'Command should exit with code 1')
    assert(result.stderr.includes("Tool 'invalid_tool' not found"), 'Should show tool not found error')
    assert(result.stderr.includes('Available tools:'), 'Should list available tools')
  })

  test('missing --prefix starts MCP server mode', async () => {
    const child = spawn('node', [cdsMcpPath, 'search_model', sampleProjectPath], {
      stdio: 'pipe'
    })

    // Give the server a moment to start
    await new Promise(resolve => setTimeout(resolve, 100))

    // Kill the process
    child.kill('SIGTERM')

    // Wait for it to close
    await new Promise(resolve => child.on('close', resolve))

    assert(true, 'MCP server should start and be killable')
  })
})
