import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './test-support/server.mjs'

test('sign-in language follows the selection and persists on form errors', async t => {
  const { address } = await startServer(t)
  const german = await fetch(address + '/login?language=de&next=%2Fcollections%2Fexample')
  const cookie = german.headers.get('set-cookie').split(';')[0]
  const page = await german.text()
  assert.match(page, /<html lang="de">/)
  assert.match(page, /Benutzername/)
  assert.match(page, /name="next" value="\/collections\/example"/)
  const invalid = await fetch(address + '/login', { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ username: 'tester', password: 'wrong' }) })
  assert.match(await invalid.text(), /Benutzername oder Passwort ungültig/)
  const english = await fetch(address + '/login?language=en', { headers: { Cookie: cookie } })
  assert.match(await english.text(), /<html lang="en">/)
  assert.match(english.headers.get('set-cookie'), /ui_language=en/)
})
