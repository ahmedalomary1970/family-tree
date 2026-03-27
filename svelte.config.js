import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html"
    }),
    // Important for Electron (file://): make generated asset/import paths relative
    // so "/_app" doesn't resolve to "C:\\_app".
    paths: {
      relative: true
    }
  }
};

export default config;
