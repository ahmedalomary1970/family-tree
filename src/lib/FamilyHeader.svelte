<script lang="ts">
  import { onMount } from "svelte";

  export let src: string = "/assets/header/family_header.svg";
  export let alt: string = "Family header";

  let svgHtml = "";
  let errorMsg = "";

  onMount(async () => {
    try {
      const res = await fetch(src, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      if (!text.toLowerCase().includes("<svg")) {
        throw new Error("File does not look like SVG.");
      }

      svgHtml = text;
      errorMsg = "";
    } catch (e: any) {
      svgHtml = "";
      errorMsg = `Header not found: ${src}`;
    }
  });
</script>

{#if svgHtml}
  <div class="w-full" aria-label={alt}>
    {@html svgHtml}
  </div>
{:else}
  <div class="w-full rounded-lg border border-dashed p-4 text-center text-sm opacity-70">
    {errorMsg || "Header not found"}
  </div>
{/if}
