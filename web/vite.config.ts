import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendPort = env.PORT || '3000'
  const target = `http://localhost:${backendPort}`

  return {
    base: '/',
    plugins: [react()],
    build: {
      outDir: 'dist',
    },
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
