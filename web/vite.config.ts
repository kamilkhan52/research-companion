import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      // Modern browsers all support WOFF2. KaTeX's published CSS also references legacy WOFF
      // and TTF fallbacks, which otherwise triples the checked-in production font assets.
      name: 'katex-woff2-only',
      enforce: 'pre',
      transform(code, id) {
        if (!id.includes('/katex/dist/katex.min.css')) return null;
        return code.replace(
          /src:(url\([^)]+\.woff2\) format\("woff2"\)),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
          'src:$1',
        );
      },
    },
  ],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    css: true,
  },
});
