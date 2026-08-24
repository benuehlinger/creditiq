import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

export default defineConfig({
  plugins: [react()],
  // PostCSS is configured HERE rather than in its own file so the project ships
  // no JavaScript config at all. Mail filters — Gmail's included — block any
  // archive containing a `.js` or `.mjs` file regardless of what it does, and
  // this project is emailed. Everything is TypeScript, which nothing blocks.
  css: { postcss: { plugins: [tailwindcss(), autoprefixer()] } },
  server: {
    port: 5173,
    open: true,
    // The API runs on 8000. Proxying means the app has ONE origin, so there is no
    // CORS surprise on a machine that has never run it before.
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
})
