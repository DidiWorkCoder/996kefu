import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite 默认入口:
//   main:    src/main/index.ts
//   preload: src/preload/index.ts
//   renderer: src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
