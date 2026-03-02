import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendPort = env.VITE_BACKEND_PORT || env.PORT || '3000'
  const target = env.VITE_BACKEND_URL || `http://localhost:${backendPort}`

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
        '/session': {
          target,
          changeOrigin: true,
        },
        '/auth': {
          target,
          changeOrigin: true,
        },
      },
    },
  }
})
