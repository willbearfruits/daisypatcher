import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Read the app version once at config-load so the renderer can expose it
// without having to reach into node APIs or touch package.json at runtime.
const pkgVersion: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
).version

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      // Sandboxed preload scripts in Electron MUST be CommonJS — ESM is not
      // supported in sandbox mode. Our package.json has `"type": "module"`,
      // which would otherwise force an ESM output and silently break the
      // preload bridge (window.daisy stays undefined, every IPC call
      // becomes a no-op). Force CJS with a `.js` extension here.
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: '.',
    resolve: {
      alias: { '@': resolve(__dirname, 'src') }
    },
    define: {
      // Injected at build time so the updater UI can print the currently
      // running version without pulling in fs or hitting IPC. JSON.stringify
      // is mandatory — Vite substitutes the raw text into the bundle.
      __APP_VERSION__: JSON.stringify(pkgVersion)
    },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      // By default Vite inlines assets under 4 KB as base64 data: URLs. For
      // AudioWorklet files that's a production-breaking bug: Chromium
      // enforces `script-src` (not `worker-src`) on `audioWorklet.addModule`
      // calls, and the CSP below lists `script-src 'self'` — data: URLs are
      // rejected and every worklet silently fails to register. Force
      // worklets to be emitted as real hashed .js files that 'self' covers.
      assetsInlineLimit: (filePath) => {
        if (filePath.endsWith('.worklet.js')) return false
        return undefined
      },
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    }
  }
})
