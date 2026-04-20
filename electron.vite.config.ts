import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    }
  }
})
