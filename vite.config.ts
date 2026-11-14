import { defineConfig } from 'vite';

// Относительные пути: сборка работает и в корне сайта, и в подпапке (GitHub Pages).
export default defineConfig({ base: './' });
