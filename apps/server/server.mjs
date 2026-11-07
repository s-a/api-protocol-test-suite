const [command, ...args] = process.argv.slice(2)

if (command === undefined) {
  await import('./http-server.mjs')
} else if (command === 'accounts') {
  try {
    const { runAccountsCommand } = await import('./accounts-cli.mjs')
    await runAccountsCommand(args)
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid accounts file.' : error.message)
    process.exitCode = 1
  }
} else if (command === 'generate-tls-certificate') {
  const { runGenerateTlsCertificate } = await import('./generate-tls-certificate.mjs')
  await runGenerateTlsCertificate(args)
} else if (command === 'targets') {
  try {
    const { runTargetsCommand } = await import('./targets.mjs')
    await runTargetsCommand(args)
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid targets file.' : error.message)
    process.exitCode = 1
  }
} else if (command === 'storage') {
  try {
    const { runStorageCommand } = await import('./storage-cli.mjs')
    await runStorageCommand(args)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
} else if (command === 'workspace') {
  try {
    const { migrateWorkspace } = await import('./workspace-migration.mjs')
    await migrateWorkspace(args)
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid JSON in the account data or legacy workspace configuration.' : error.message)
    process.exitCode = 1
  }
} else {
  console.error('Usage: node --env-file-if-exists=.env apps/server/server.mjs [accounts <command> | storage <command> | targets <command> | generate-tls-certificate | workspace migrate <username>]')
  process.exitCode = 1
}
