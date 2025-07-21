// Node.js test runner (test) for lib/tools.js
import tools from '../lib/tools.js';
import assert from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Point to the sample project directory
const sampleProjectPath = join(dirname(fileURLToPath(import.meta.url)), 'sample');

test('search_cds_definitions: should find services', async () => {
  const result = await tools.search_cds_definitions.handler({
    projectPath: sampleProjectPath,
    kind: 'service',
    topN: 3
  });
  assert(Array.isArray(result), 'Result should be an array');
  assert(result.length > 0, 'Should find at least one service');
});

test('search_cds_definitions: fuzzy search for Books entity', async () => {
  const books = await tools.search_cds_definitions.handler({
    projectPath: sampleProjectPath,
    name: 'Books',
    kind: 'entity',
    topN: 2
  });
  assert(Array.isArray(books), 'Result should be an array');
  assert(books.length > 0, 'Should find at least one entity');
});

test('list_all_cds_definition_names: should list all entities', async () => {
  const entities = await tools.list_all_cds_definition_names.handler({
    projectPath: sampleProjectPath,
    kind: 'entity'
  });
  assert(Array.isArray(entities), 'Entities should be an array');
  assert(entities.length > 0, 'Should find at least one entity');
});

test('list_all_cds_definition_names: should list all services', async () => {
  const services = await tools.list_all_cds_definition_names.handler({
    projectPath: sampleProjectPath,
    kind: 'service'
  });
  assert(Array.isArray(services), 'Services should be an array');
  assert(services.length > 0, 'Should find at least one service');
});
