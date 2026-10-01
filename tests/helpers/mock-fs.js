import { mock } from 'node:test'
import fs from 'fs/promises'

export function mockReadFile(jsonPayload, binData) {
  mock.method(fs, 'readFile', (filePath) => {
    if (String(filePath).endsWith('.json')) {
      if (jsonPayload === null) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      return Promise.resolve(typeof jsonPayload === 'string' ? jsonPayload : JSON.stringify(jsonPayload))
    }
    if (binData === null) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    return Promise.resolve(Buffer.from(binData.buffer))
  })
}

export function mockUnlink() {
  return mock.method(fs, 'unlink', () => Promise.resolve())
}

export function mockFsWrites() {
  const writes = new Map()
  mock.method(fs, 'writeFile', async (filepath, data) => { writes.set(String(filepath), data) })
  mock.method(fs, 'mkdir', async () => {})
  mock.method(fs, 'unlink', async () => {})
  return writes
}

export function getWrittenJson(writes) {
  const [, data] = [...writes.entries()].find(([k]) => k.endsWith('.json'))
  return JSON.parse(data)
}
