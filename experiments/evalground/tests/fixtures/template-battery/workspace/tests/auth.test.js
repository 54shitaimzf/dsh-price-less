const { test } = require('node:test')
const assert = require('node:assert')
const { checkAuth } = require('../src/auth.js')

test('checkAuth rejects missing credentials', () => {
  assert.throws(() => checkAuth(null, 'x'))
  assert.throws(() => checkAuth({ secret: 's' }, null))
})

test('checkAuth accepts valid credentials', () => {
  assert.equal(checkAuth({ secret: 's' }, 's'), true)
  assert.equal(checkAuth({ secret: 's' }, 'wrong'), false)
})
