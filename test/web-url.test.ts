import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalWebUrl } from '../src/shared/web-url.js'

test('external evidence links allow web pages and preserve query strings', () => {
  assert.equal(externalWebUrl('https://example.com/result?q=kibu#answer'), 'https://example.com/result?q=kibu#answer')
  assert.equal(externalWebUrl('http://localhost:8080/'), 'http://localhost:8080/')
})

test('external evidence links refuse executable, file, and custom OS protocols', () => {
  for (const url of ['javascript:alert(1)', 'file:///Applications/Calculator.app', 'data:text/html,hello', 'custom-app://run', '//example.com', '', null]) {
    assert.throws(() => externalWebUrl(url))
  }
})
