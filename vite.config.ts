import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Phase 4.3: the bot writes data/*.json all the time; never watch those (or tests / archives).
      hmr: process.env.TRADEBOT_HMR === '1',
      watch: process.env.TRADEBOT_HMR === '1' ? { ignored: ['**/data/**', '**/tests/**', '**/*.zip', '**/dist/**'] } : null,
    },
  };
});
