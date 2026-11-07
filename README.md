Da werden auch noch unterschiedliche Revisionen abgelegt, das wusste ich gar nicht.
# API Protocol Test Suite

![Hello World demo showing sign-in, the demo environment, JWT authorization, request options, and a 200 OK response](docs/hello-world-showcase.gif)

A self-hosted workspace for preparing HTTP API tests. The English-language interface manages collections, folders, requests, and environments. With a valid session, `GET /api/health` returns HTTP 200 and `{"status":"ok"}`.

## Local setup

The build requires Node.js 24 or later and npm.

If `.env` does not exist, copy `.env.example` to `.env` in the repository root. Generate an active storage key before the first start. See [Account data encryption](#account-data-encryption).

```sh
npm ci
npm run build
npm start
```

The interface is available at `http://127.0.0.1:3000` by default. The `HOST` and `PORT` environment variables set the server's bind address and port. A [local account](#local-accounts) is required before the first sign-in.

Default startup requires an active [account storage key](#account-data-encryption).

## Development

`npm run dev` starts the Vite development server at `http://127.0.0.1:5173`. In a second terminal, `npm run dev:server` starts the Node.js server and restarts it when files change. Vite uses the HTTP server at `http://127.0.0.1:3000` for sign-in and API requests. This setup requires the Node.js server to run in HTTP mode. If a different port is used, set `PORT` in both terminals.

| Command | Purpose |
| --- | --- |
| `npm run lint` | Checks JavaScript, TypeScript, and React Hooks with ESLint. |
| `npm run check` | Checks TypeScript types and the syntax of the server entry point. |
| `npm test` | Runs tests with the built-in Node.js test runner. |

| Path | Contents |
| --- | --- |
| `apps/web/` | React interface built with TypeScript, Vite, and VSCode Elements |
| `apps/server/` | Node.js server for the API and the built frontend |

## Windows x64 deployment

| Package | Contents | Target requirements |
| --- | --- | --- |
| Slim | Server, built frontend, and npm manifests | Node.js 24.x for Windows x64, npm, and access to the package registry. Run `npm ci --omit=dev` from the extracted directory. |
| Runtime Bundle | Slim contents and installed runtime dependencies | Node.js 24.x for Windows x64 on `PATH`. |
| Standalone | Runtime Bundle contents and `runtime\node.exe` | Windows x64. |

Extract the ZIP. For a new installation, copy the included `.env.example` to `.env` in the extracted directory. After installing dependencies if required, run `start.cmd storage generate-key` to generate the first storage key, then run `start.cmd` to start the server. The launcher uses the extracted directory as its working directory and accepts the server commands documented below.

GitHub Actions provides all three ZIPs as workflow artifacts. A push of a version tag such as `v1.0.0` also attaches the ZIPs to a GitHub Release. Each workflow run resolves the latest stable Node.js 24.x release for Windows x64 before building and testing. Standalone records the bundled version in `runtime\VERSION.txt`.

To replace the Standalone runtime, stop the server, replace `runtime\node.exe` with the executable from another official Node.js 24.x Windows x64 release, and run `start.cmd` again. The application does not require a rebuild.

### Local accounts

The account commands use the server entry point. Run them from the deployment root. In a Windows release package, `start.cmd accounts <command>` invokes the same entry point with the package's runtime.

```powershell
node --env-file-if-exists=.env apps/server/server.mjs accounts add anna
node --env-file-if-exists=.env apps/server/server.mjs accounts set-password anna
node --env-file-if-exists=.env apps/server/server.mjs accounts remove anna
node --env-file-if-exists=.env apps/server/server.mjs accounts list
```

`add` and `set-password` prompt for the password and its confirmation in an interactive terminal without echoing either input. Passwords must be 15 to 1024 characters long. Usernames are case-sensitive, start with an ASCII letter or digit, and contain up to 64 ASCII letters, digits, periods, hyphens, or underscores. `add` requires an unused username. `set-password` and `remove` require an existing account.

The first successful `add` creates `data/accounts.json`. `ACCOUNTS_FILE` sets a different path outside the directories served as web content. Relative paths are resolved against the working directory. The JSON file stores a unique salt and a scrypt hash for each account. The server needs read access to the file. The account commands need write access to its directory. A forced termination can leave a `.lock` file behind. It can be removed once all account commands have stopped.

The server protects the interface and all API routes, including `/api/health`. Without a valid session, browser requests are redirected to the sign-in page and API requests receive HTTP 401. Each account has its own workspace and can use the interface in one browser tab at a time, across browsers. Additional tabs can wait for access or select **Open anyway** to take over. The previous tab loses access for that account. Sessions end at sign-out, after eight hours, or when the server restarts. Changing an account's password or deleting the account invalidates its sessions on their next use. A password change preserves the workspace. Creating an account with a previously used username gives it a new workspace.

API clients sign in with `POST /login`. The request sends `username` and `password` as `application/x-www-form-urlencoded` data. On success, the server returns HTTP 303 and a session cookie. Include the cookie in API requests and in `POST /logout`.

### Allowed request targets

The target commands use the server entry point. Run them from the deployment root.

```powershell
node --env-file-if-exists=.env apps/server/server.mjs targets list
node --env-file-if-exists=.env apps/server/server.mjs targets add test-api https://api-test.intern:8443
node --env-file-if-exists=.env apps/server/server.mjs targets update test-api https://api-test.intern:9443
node --env-file-if-exists=.env apps/server/server.mjs targets remove test-api
```

An origin consists of an HTTP or HTTPS scheme, a hostname or IP address, and an optional port. Omitted ports use the scheme's default. Paths, queries, fragments, and embedded credentials are invalid. Names are case-sensitive, start with an ASCII letter or digit, and contain up to 64 ASCII letters, digits, periods, hyphens, or underscores. Each name and origin must be unique. The `list` command displays each name and origin with its effective port. The `update` and `remove` commands require an existing name.

The first successful `add` creates the server-wide `data/targets.json`. The `TARGETS_FILE` environment variable overrides the path. Relative paths are resolved against the working directory. The file belongs outside the directories served as web content. The server needs read access. Restrict write access to administrators. The CLI replaces the file atomically. If a forced termination leaves a `.lock` file, it can be removed once all target commands have stopped.

The server reads the list before each outbound request. Changes apply at the next check without a restart. A missing or empty list denies all targets. Request URLs remain editable in the workspace. The server checks the resolved origin for request sends, HTTP requests from scripts, and every WSDL URL download, including redirect destinations.

### HTTPS

The following command generates a self-signed certificate for `localhost`, `127.0.0.1`, and `::1`. It requires only Node.js and creates `data/tls/cert.pem` and `data/tls/key.pem`.

```sh
node apps/server/server.mjs generate-tls-certificate
```

Positional arguments replace the default names. They accept ASCII DNS names and IPv4 or IPv6 addresses without ports. `--out-dir` specifies a different directory for a new certificate. The command fails if the destination directory already exists. The certificate is valid for about one year. The private key stays on the server.

```sh
node apps/server/server.mjs generate-tls-certificate --out-dir data/tls-new localhost 127.0.0.1
```

`HTTPS_ENABLED` selects the protocol for the interface and API. Set it in `.env` or in the process environment. The setting takes effect the next time the server starts. Relative paths are resolved against the server's working directory.

```dotenv
HTTPS_ENABLED=true
TLS_CERT_FILE=data/tls/cert.pem
TLS_KEY_FILE=data/tls/key.pem
```

| Setting | Behavior |
| --- | --- |
| `HTTPS_ENABLED=true` | Starts in HTTPS mode. Both TLS paths are required. Startup fails if the certificate or key cannot be loaded. |
| `HTTPS_ENABLED=false` | Starts in HTTP mode and ignores configured TLS paths. |
| `HTTPS_ENABLED` unset | Starts in HTTPS mode if both TLS paths are set and in HTTP mode if neither is set. Startup fails if only one path is set. |

Other values for `HTTPS_ENABLED` cause a configuration error at startup.

Clients must explicitly trust the self-signed certificate. The generator writes only the PEM files to the destination directory.

#### Existing certificates

For an existing server certificate, set the paths in `.env` to the certificate and key files.

```dotenv
HTTPS_ENABLED=true
TLS_CERT_FILE=C:/ServiceCertificates/fullchain.pem
TLS_KEY_FILE=C:/ServiceCertificates/privkey.pem
```

`TLS_CERT_FILE` points to a PEM file containing the server certificate followed by the required intermediate certificates in chain order. The client provides the root certificate as a trust anchor. The server certificate must cover the DNS name or IP address that clients use to reach the server. `TLS_KEY_FILE` points to the corresponding private key in an unencrypted PEM file. The server account needs read access to both files.

The server loads the files at startup. Restart the server after replacing the certificate or key. [Node.js TLS options](https://nodejs.org/api/tls.html#tlscreatesecurecontextoptions)

## Workspace

Each section appears by name in the explorer and contains its own collections and one environment. Right-click a section name to add, rename, or delete a section. If the workspace has no sections, right-click the empty state to add one. Right-click a collection to move it to another section. The editor resolves references such as `{{baseUrl}}` using enabled variables from the section's environment. The stored URL retains the original references. **Save** saves changes to collections, environments, and their sections.

The **Body** tab offers **none** and **raw**. The Monaco editor supports raw bodies in Text, JavaScript, JSON, HTML, and XML. New raw bodies default to JSON. For older requests, the displayed format is derived from an enabled `Content-Type` header. When sending a request with an explicitly selected raw format, the server sets the corresponding `Content-Type` unless an enabled header supplies it.

**Send** runs the current draft through the application server and displays the HTTP status, duration, headers, and response body. The section's environment applies to the URL, enabled headers, body, and authorization. The draft remains unsaved. Redirects are displayed as responses. The timeout is 15 seconds. The response body display is limited to 2 MiB. Starting the server through npm also enables the system certificates for TLS. The server can send requests to destinations reachable from its environment. For network deployments, restrict access to trusted users.

Request URLs, enabled headers, bodies, and authorization fields support dynamic variables from the Postman Collection SDK. The server resolves references such as `{{$guid}}` when sending the request. The workspace and Postman exports retain the references.

**Scripts** contains **Pre-request** and **Post-response** scripts for collections, folders, and requests. The server runs pre-request scripts before post-response scripts in the Postman Sandbox. Values set through `pm.variables.set` in a pre-request script are available when resolving the current request. Script changes to variables are transient. `pm.sendRequest` sends HTTP requests with an optional raw body through the server. Results from `pm.test` appear under **Test Results**. The sandbox has no integration with Postman Vault, cookie jars, external script packages, or `pm.execution.runRequest`.

**Authorization** supports **No Auth**, **Inherit auth from parent**, **Basic Auth**, **Bearer Token**, and **JWT Bearer**. Inherited authorization uses the nearest ancestor with an explicit setting. Literal Basic and Bearer credentials and variable values are stored in the workspace JSON.

### JWT Bearer

**JWT Bearer** supports HS256/384/512, RS256/384/512, PS256/384/512, and ES256/384/512. **Payload** and **JWT headers** accept JSON objects and variable references. The server generates the token when sending the request and adds it as an `Authorization` header or query parameter. The selected algorithm determines `alg`. The default prefix is `Bearer`, and the default query parameter name is `token`.

Each key reference specifies a target origin and an algorithm. HS algorithms use a text or Base64 key. RS, PS, and ES algorithms use an unencrypted PKCS #8 private key in PEM format. The workspace and newly generated collection files store the reference. Postman requires the corresponding key in a separate variable.

**Show key** displays the signed-in account's key for the specified reference. **Set key** and **Edit key** store the key, target origin, and algorithm in the account's `jwt-keys.json` file. The file is encrypted by default.

## Personal workspaces

`DATA_DIR` sets the base directory for `accounts.json`, `targets.json`, and `users/`. It defaults to the installation's `data/` directory. Relative paths are resolved against the working directory. `ACCOUNTS_FILE`, `TARGETS_FILE`, and `USER_DATA_DIR` override the corresponding paths individually.

The server stores each account's data in `users/<username>--<account-id>/` under that base directory by default. The account ID keeps data separate when a username is reused. The directory must be outside the served web content and is intended for a single server instance.

New workspaces start with a **Root** section and an empty environment. Encrypted accounts store the workspace in `workspace.enc.json`. Connection profiles, JWT signing keys, and sharing settings have separate files in the account directory. In plaintext mode, the workspace uses the previous section folders and `workspace/workspace-index.json`.

### Account data encryption

`WORKSPACE_ENCRYPTION_ENABLED` defaults to `true`. Set it to `false` to allow plaintext storage for accounts that have never been encrypted. Existing encrypted accounts continue to use encryption and require their keys. Other values prevent server startup.

Set `ENCRYPTION_KEYS_DIR` to the directory containing the RSA key pairs and the `active` file. These keys protect account data keys and sealed password packages. Relative paths are resolved against the working directory. The key directory must be outside the account data directory (`DATA_DIR/users` by default). The server account requires read access. Restrict access to the private key files and back them up separately from the account data. Existing configurations can still use `ACCOUNT_KEY_DIR` as a fallback.

```sh
node --env-file-if-exists=.env apps/server/server.mjs storage generate-key
```

The command creates an RSA key pair and prints its ID. The first pair becomes active. The application creates an AES-256 key per account and stores it wrapped with the active public key in `data-key.json`. It uses AES-GCM for the workspace, profiles, JWT signing keys, and sharing settings.

When encryption is enabled, the server migrates existing plaintext account directories before accepting requests. It verifies each encrypted copy before replacing the account directory. Startup stops if migration fails. The next startup resumes any interrupted migration. Existing sharing selections remain in effect. Existing plaintext backups require separate protection. Use a single server process per user data directory.

To migrate a single account manually, stop the server and run the following command.

```sh
node --env-file-if-exists=.env apps/server/server.mjs storage migrate anna
```

For rotation, stop the server, generate a new pair, then run `storage rotate <new-key-id>` through the same entrypoint. Rotation rewraps the stored AES keys and activates the new pair after the last successful update. Repeat the command with the same ID after an interruption. Keep retired private keys for as long as backups that depend on them remain restorable.

### Sealed account passwords

On the admin workstation, set `ACCOUNT_PUBLIC_KEY_FILE` to the active `<key-id>.public.pem` obtained from the server. The following command prompts for a password and writes an encrypted package to standard output.

```sh
node --env-file-if-exists=.env apps/server/server.mjs accounts seal-password add anna
```

An operator with access to the server-side CLI passes the package on standard input to `accounts add anna --sealed`. For a reset, use `set-password` in both commands. The package is bound to the command and username. Generate a fresh package after key rotation. The server stores the password hash, and resetting the password preserves the account's data key.

For existing connection profiles with a deployment-specific JWT profile type, set `LEGACY_JWT_PROFILE_TYPE` in the local environment to the stored type. The profiles API returns the `merchant-jwt` type.

### Share a workspace

Under **Workspace sharing**, select the saved sections and choose **Save sharing**. All signed-in accounts can then view the selected sections and subsequent changes to them. A section includes its collections, request credentials stored in those collections, and its environment values. Connection profiles and separately stored JWT signing keys remain private. An older workspace-wide sharing setting requires a new section selection.

**Copy to my workspace** adds each shared section as a separate section in the recipient's workspace. Collection and environment IDs that conflict with existing entries are replaced. **Stop sharing** revokes access to all shared sections and prevents further copies. Existing copies remain in their respective workspaces.

### Migrate the previous shared workspace

The migration command copies the previous data into an existing account with no saved data. It preserves the source files. The migrated workspace starts out private.

1. Stop the server and back up the existing data files.
2. Run the command from the deployment root with the target username.

   ```powershell
   node --env-file-if-exists=.env apps/server/server.mjs workspace migrate anna
   ```

3. Start the server and verify the migrated workspace in the target account.

By default, the command reads `workspace.json` from `DATA_DIR` and copies `profiles.json` and `jwt-keys.json` from that directory if they exist. `WORKSPACE_FILE`, `PROFILES_FILE`, and `JWT_KEYS_FILE` override the source paths. For keys configured through `JWT_SIGNING_KEYS`, the command reads the referenced environment variables and stores their values in the target account's key file. If a reference appears in both sources, the existing key file takes precedence. The command fails if the workspace source is missing, the data is invalid, or the target account already has saved data.

## Collection import and export

**Import** accepts a WSDL file, a WSDL URL, or a ZIP archive in Postman Collection Format v3.0.0. The import API also accepts collection directories in this format.

WSDL import supports standalone WSDL 1.1 and 2.0 documents encoded in UTF-8 or UTF-16, up to 2 MiB. The application server fetches WSDL URLs over HTTP or HTTPS. External WSDL or XSD references and DTDs cause the import to fail.

The Postman converter creates a collection with request templates, variables, and example responses. For SOAP 1.1, the import sets `text/xml` and a quoted `SOAPAction` value. For SOAP 1.2, it sets `application/soap+xml` and includes the action, if present, as an `action` parameter. A WSDL 2.0 SOAP binding without a version defaults to SOAP 1.2. [Postman converter](https://github.com/postmanlabs/wsdl-to-postman), [SOAP 1.1](https://www.w3.org/TR/soap11/), [SOAP 1.2](https://www.w3.org/TR/soap12-part2/), [WSDL 2.0](https://www.w3.org/TR/wsdl20-adjuncts/#soap-version)

**Export** downloads the collection as a ZIP archive with YAML files and resources. After extraction, the directory can be used in a local Postman project. The collection view flags content preserved only during import and export, such as additional resources. Export reports a conflict if an edit would overwrite this content. Deleting an item also removes its associated resources from the export. Environments have no defined interchange format. [Postman collection schema](https://learning.postman.com/docs/use/use-collections/collections-schemas)

| Method and path | Behavior |
| --- | --- |
| `GET /api/workspace` | Returns the collections, environments, and saved section assignments when available. Each entry in `sections` contains `id`, `name`, `collectionIds`, and `environmentId`. |
| `PUT /api/workspace` | Saves the workspace. Each collection and environment must belong to exactly one section, and each section must have exactly one environment. |
| `GET /api/workspace/sharing` | Returns the account's saved sections as `sections`, the selected IDs as `sectionIds`, and the usernames of other accounts with shared sections as `owners`. |
| `PUT /api/workspace/sharing` | Replaces the sharing selection with the supplied JSON `sectionIds` array. An empty array revokes all sharing. Invalid or duplicate section IDs return HTTP 400. |
| `DELETE /api/workspace/sharing` | Revokes all sharing and returns an empty `sectionIds` array. |
| `GET /api/workspace/shared/{username}` | Returns the shared sections with their collections and environments and an `ETag`. An account with no shared sections returns HTTP 404. |
| `POST /api/workspace/shared/{username}/copy` | Copies the shared sections into the personal workspace and returns the updated workspace. `If-Match` must match the preview's `ETag`. A mismatch returns HTTP 412. |
| `POST /api/requests/send` | Sends an HTTP request. Accepts JSON with `method`, `url`, `headers` as a list of name-value pairs, and an optional text `body`. The response field `status` contains the target server's HTTP status. |
| `POST /api/collections/import` | Adds a collection and returns the updated workspace with HTTP 201. Accepts `application/zip`, WSDL as `application/wsdl+xml`, `application/xml`, or `text/xml`, and `application/json` with `url` for a WSDL URL. A collection directory is sent as JSON with `rootName` and `files`. Each file entry contains `path` relative to the collection root and Base64-encoded `content`. The upload limits are 24 MiB for collections and 2 MiB for WSDL documents. |
| `GET /api/collections/{id}/export` | Returns the saved collection as a ZIP archive. An unknown ID returns HTTP 404. |

If a request send or a WSDL download targets an origin outside the allowlist, the API returns HTTP 403 with `code: "target_not_allowed"` and an `error` message. If the allowlist is unreadable or invalid, the API returns HTTP 500 with `code: "target_configuration_error"`. An HTTP status received from a test target is reported separately in the `status` field of a successful send response.
