// Open the app in a signed-in test session, then run this file with
// playwright-cli run-code --filename <absolute path to this file>.
async page => {
  const owner = 'sharing-regression-owner'
  const missing = { status: 404, json: { error: 'Shared workspace not found.' } }
  const listing = /\/api\/workspace\/sharing$/
  const preview = new RegExp(`/api/workspace/shared/${owner}(?:/copy)?$`)
  let shared = true
  const listRoute = route => route.fulfill({ json: { sections: [], sectionIds: [], owners: shared ? [owner] : [] } })
  const previewRoute = route => shared ? route.fulfill({
    headers: { ETag: '"test-version"' },
    json: { collections: [], environments: [], activeEnvironmentId: null, sections: [] },
  }) : route.fulfill(missing)

  await page.route(listing, listRoute)
  await page.route(preview, previewRoute)
  try {
    const openSharing = page.getByRole('button', { name: 'Workspace sharing', exact: true })
    const openPreview = page.getByRole('button', { name: `Preview workspace shared by ${owner}` })
    const copy = page.getByRole('button', { name: 'Copy to my workspace' })
    const close = page.getByRole('button', { name: 'Close', exact: true })
    const missingAlert = page.getByRole('alert').filter({ hasText: missing.json.error })
    const empty = page.getByText('No shared workspaces are available.', { exact: true })
    const timeout = 5000

    await openSharing.click({ timeout })
    await openPreview.click({ timeout })
    await copy.waitFor({ timeout })
    shared = false
    await copy.click({ timeout })
    await missingAlert.waitFor({ timeout })
    await page.getByRole('button', { name: 'Back', exact: true }).click({ timeout })
    await empty.waitFor({ timeout })

    await close.click({ timeout })
    shared = true
    await openSharing.click({ timeout })
    await openPreview.waitFor({ timeout })
    shared = false
    await openPreview.click({ timeout })
    await missingAlert.waitFor({ timeout })
    await empty.waitFor({ timeout })
    await close.click({ timeout })
  } finally {
    await page.unroute(listing, listRoute)
    await page.unroute(preview, previewRoute)
  }
}
