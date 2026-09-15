import cds from '@sap/cds/eslint.config.mjs'
export default [
  ...cds.recommended,
  {
    ignores: ['scripts/']
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
]
