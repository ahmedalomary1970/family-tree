import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Important for Electron (file://): make chunk/asset paths relative so /_app doesn't resolve to C:\_app
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), sveltekit()]
});
