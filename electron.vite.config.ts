import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The main build emits two entry points:
//   index.js   -> Electron main process (privileged)
//   runtime.js -> agent runtime, forked as its own OS process
// Keeping them in one build keeps shared/ types and helpers in sync.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          runtime: resolve('src/runtime/index.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@os': resolve('src/os') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
})
