import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = `http://127.0.0.1:${process.env.PORT || 3000}`
const backendRoutes = /^\/(?:api(?:\/|\?|$)|(?:login|logout|favicon\.(?:png|ico))(?:\?|$))/

export default defineConfig({
  root: 'apps/web',
  plugins: [react(), {
    name: 'workspace-sign-in',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (backendRoutes.test(request.url ?? '')) return next()
        try {
          const auth = await fetch(`${backend}/api/health`, {
            method: 'HEAD',
            headers: { Cookie: request.headers.cookie ?? '' },
            signal: AbortSignal.timeout(5000),
          })
          if (auth.ok) return next()
          response.setHeader('Cache-Control', 'no-store')
          if (auth.status === 401) {
            const query = new URLSearchParams({ next: request.url ?? '/' })
            response.writeHead(303, { Location: `/login?${query}` }).end()
            return
          }
        } catch {
          // The backend is unavailable.
        }
        response.writeHead(503, { 'Cache-Control': 'no-store' }).end('Start the workspace server to sign in.')
      })
    },
  }],
  server: {
    host: '127.0.0.1',
    proxy: { [backendRoutes.source]: { target: backend, changeOrigin: false } },
    fs: {
      allow: [
        '.', '../../node_modules',
        '../server/body-format.ts', '../server/dynamic-variables.ts', '../server/jwt-settings.ts',
      ],
    },
  },
})
