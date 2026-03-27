<script>
  import { onMount } from "svelte";

  let loading = true;
  let errorMsg = "";
  let raw = null;

  let workspaceCm = 150;
  let workspaceMm =1500

  let rings = [];
  let people = [];
  let links = [];
  let generationMarkers = [];
  let zoom = 1;
  let fontFamily = "Cairo, Arial, sans-serif";
  let projectTitle = "Family Tree";

  let view = { x: 0, y: 0, w: workspaceMm, h: workspaceMm };

  let isPanning = false;
  let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
function splitNameToLines(name = "", maxChars = 8) {
  const text = String(name || "").trim();
  if (!text) return [""];

  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length <= maxChars) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.slice(0, 4);
}

function personTextLines(p) {
  const r = personRadiusMm(p);
  const maxChars =
    r >= 18 ? 10 :
    r >= 14 ? 8 :
    r >= 10 ? 6 : 4;

  return splitNameToLines(p?.name || "", maxChars);
}
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function fitViewToContent() {
  const cx = workspaceMm / 3;
  const cy = workspaceMm / 3;

  let minX = 0;
  let minY = 0;
  let maxX = workspaceMm;
  let maxY = workspaceMm;

  if (rings.length) {
    const maxRingR = Math.max(...rings.map(ringRadiusMm), workspaceMm / 2);
    minX = Math.min(minX, cx - maxRingR - 60);
    maxX = Math.max(maxX, cx + maxRingR + 60);
    minY = Math.min(minY, cy - maxRingR - 60);
    maxY = Math.max(maxY, cy + maxRingR + 60);
  }

  if (people.length) {
    for (const p of people) {
      const x = Number(p.x) || 0;
      const y = Number(p.y) || 0;
      const r = personRadiusMm(p) + 20;

      minX = Math.min(minX, x - r);
      maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r);
      maxY = Math.max(maxY, y + r);
    }
  }

  view = {
    x: minX,
    y: minY,
    w: Math.max(300, maxX - minX),
    h: Math.max(300, maxY - minY),
  };
}
  function getRingById(id) {
  return rings.find((r) => r.id === id) || null;
}
function generationLabelForMarker(gm) {
  const idx = rings.findIndex((r) => r.id === gm?.ringId);
  if (idx === -1) return "";

  return String((Number(raw?.baseGenerationNumber) || 1) + idx);
}
function ringRadiusMm(r) {
  return (Number(r?.diameterCm) || 0) * 5;
}
  function getPersonById(id) {
    return people.find((p) => p.id === id) || null;
  }

  function personRadiusMm(p) {
    const dCm =
      Number(p?.diameterCm) ||
      Number(getRingById(p?.ringId)?.diameterCm) ||
      1.5;
    return dCm * 5;
  }

  function personStrokeMm(p) {
    return Math.max(0.6, Number(p?.strokeMm) || 1);
  }

  function personFontPx(p) {
    return Math.max(4, Number(p?.fontPx) || 6);
  }

  function linkPathD(parent, child, bends = []) {
    const pts = [
      { x: Number(parent.x) || 0, y: Number(parent.y) || 0 },
      ...(Array.isArray(bends) ? bends : []).map((b) => ({
        x: Number(b.x) || 0,
        y: Number(b.y) || 0,
      })),
      { x: Number(child.x) || 0, y: Number(child.y) || 0 },
    ];

    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i].x} ${pts[i].y}`;
    }
    return d;
  }

  function onWheel(e) {
    e.preventDefault();

    const factor = e.deltaY > 0 ? 1.12 : 0.88;
    const mx = e.offsetX / e.currentTarget.clientWidth;
    const my = e.offsetY / e.currentTarget.clientHeight;

    const nw = clamp(view.w * factor, 120, workspaceMm * 2);
    const nh = clamp(view.h * factor, 120, workspaceMm * 2);

    const wx = view.x + view.w * mx;
    const wy = view.y + view.h * my;

    view = {
      x: wx - nw * mx,
      y: wy - nh * my,
      w: nw,
      h: nh,
    };
  }

  function onPointerDown(e) {
    isPanning = true;
    panStart = {
      x: e.clientX,
      y: e.clientY,
      vx: view.x,
      vy: view.y,
    };
  }

  function onPointerMove(e) {
    if (!isPanning) return;

    const dxPx = e.clientX - panStart.x;
    const dyPx = e.clientY - panStart.y;

    const box = e.currentTarget.getBoundingClientRect();
    const dxWorld = (dxPx / box.width) * view.w;
    const dyWorld = (dyPx / box.height) * view.h;

    view = {
      ...view,
      x: panStart.vx - dxWorld,
      y: panStart.vy - dyWorld,
    };
  }

  function onPointerUp() {
    isPanning = false;
  }

  async function loadTree() {
    loading = true;
    errorMsg = "";

    try {
      const url = new URL(window.location.href);
      const token = url.searchParams.get("token");

      if (!token) {
        errorMsg = "لا يوجد token في الرابط";
        loading = false;
        return;
      }

      const res = await fetch(
        `https://lvcugaeipvfhxwldujtv.supabase.co/functions/v1/public-tree-view?token=${encodeURIComponent(token)}`
      );

      const json = await res.json();

      if (!res.ok) {
        errorMsg = json?.error || "فشل تحميل الشجرة";
        loading = false;
        return;
      }

      raw = json?.data || {};
      projectTitle = json?.title || "Family Tree";

      workspaceCm = Number(raw.workspaceCm) || 150;
      workspaceMm = workspaceCm * 18;

      rings = Array.isArray(raw.rings) ? raw.rings : [];
      people = Array.isArray(raw.people) ? raw.people : [];
      links = Array.isArray(raw.links) ? raw.links : [];
      generationMarkers = Array.isArray(raw.generationMarkers) ? raw.generationMarkers : [];
     console.log("GEN MARKERS COUNT:", generationMarkers.length);
console.log("GEN MARKERS FIRST:", generationMarkers[0]);
console.log("GEN MARKERS JSON:", JSON.stringify(generationMarkers[0] || {}, null, 2));
 zoom = Number(raw.zoom) || 1;
      fontFamily = raw.fontFamily || "Cairo, Arial, sans-serif";

      fitViewToContent();
    } catch (err) {
      errorMsg = String(err);
    } finally {
      loading = false;
    }
  }

  onMount(loadTree);
</script>

<svelte:head>
  <title>{projectTitle}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #f7f7f7;
      font-family: Cairo, Arial, sans-serif;
    }
  </style>
</svelte:head>

{#if loading}
  <div class="stateBox">جاري تحميل الشجرة...</div>
{:else if errorMsg}
  <div class="stateBox error">{errorMsg}</div>
{:else}
  <div class="page">
    <div class="topBar">
      <div class="titleWrap">
        <div class="title">{projectTitle}</div>
        <div class="sub">
          عرض فقط • الأشخاص: {people.length} • الروابط: {links.length}
        </div>
      </div>

      <div class="actions">
        <button class="btn" on:click={fitViewToContent}>ملاءمة</button>
        <button
  class="btn"
  on:click={() =>
    (view = {
      x: -40,
      y: -40,
      w: workspaceMm + 80,
      h: workspaceMm + 80
    })}
>
  المساحة كاملة
</button>
      </div>
    </div>

    <div class="stageWrap">
      <svg
        class="stage"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Public Family Tree"
        on:wheel={onWheel}
        on:pointerdown={onPointerDown}
        on:pointermove={onPointerMove}
        on:pointerup={onPointerUp}
        on:pointerleave={onPointerUp}
      >
       <rect x="0" y="0" width={workspaceMm} height={workspaceMm} fill="#ffffff" stroke="#e5e7eb" stroke-width="2" />

{#each rings as ring}
  <circle
    cx={workspaceMm / 2}
    cy={workspaceMm / 2}
    r={ringRadiusMm(ring)}
    fill="none"
    stroke="#d1d5db"
    stroke-width="1"
  />
{/each}

        {#each links as link}
          {@const parent = getPersonById(link.parentId)}
          {@const child = getPersonById(link.childId)}
          {#if parent && child}
            <path
              d={linkPathD(parent, child, link.bends)}
              fill="none"
              stroke="#2563eb"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              opacity="0.9"
            />
          {/if}
        {/each}

     {#each generationMarkers as gm}
  {@const label = generationLabelForMarker(gm)}
  {@const w = Math.max(14, Number(gm.widthMm) || 26)}
  {@const h = Math.max(10, Number(gm.heightMm) || 12)}

  <g transform={`translate(${gm.x || 0}, ${gm.y || 0}) rotate(${gm.rotationDeg || 0})`}>
    <rect
      x={-w / 2}
      y={-h / 2}
      width={w}
      height={h}
      rx="2"
      ry="2"
      fill={gm.fill || "#ffffff"}
      stroke={gm.strokeColor || "#374151"}
      stroke-width="0.8"
    />
    <text
      x="0"
      y="0"
      dominant-baseline="middle"
      text-anchor="middle"
      font-size={Math.max(6, Number(gm.fontPx) || 10)}
      fill={gm.textColor || "#111827"}
      style={`font-family:${fontFamily}; font-weight:700; user-select:none;`}
    >
      {label}
    </text>
  </g>
{/each}
       {#each people as p}
  {@const r = personRadiusMm(p)}
  {@const sw = personStrokeMm(p)}
  {@const lines = personTextLines(p)}
  {@const lineHeight = Math.max(4, personFontPx(p) * 0.9)}
  {@const startY = -((lines.length - 1) * lineHeight) / 2}

  <g transform={`translate(${p.x || 0}, ${p.y || 0})`}>
    {#if p.highlightRing}
      <circle
        r={r + 2}
        fill="none"
        stroke="#2563eb"
        stroke-width={sw}
        opacity="0.9"
      />
    {/if}

    <circle
      r={r}
      fill="#ffffff"
      stroke="#111827"
      stroke-width={sw}
    />

    <text
      text-anchor="middle"
      fill="#111827"
      style={`font-family:${fontFamily}; user-select:none;`}
    >
      {#each lines as line, i}
        <tspan
          x="0"
          y={startY + i * lineHeight}
          font-size={personFontPx(p)}
          dominant-baseline="middle"
        >
          {line}
        </tspan>
      {/each}
    </text>
  </g>
{/each}
      </svg>
    </div>
  </div>
{/if}

<style>
  .page {
    min-height: 100vh;
    background: #f3f4f6;
    display: grid;
    grid-template-rows: auto 1fr;
  }

  .topBar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
  }

  .title {
    font-size: 20px;
    font-weight: 800;
    color: #111827;
  }

  .sub {
    font-size: 13px;
    color: #6b7280;
    margin-top: 4px;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .btn {
    border: 1px solid #d1d5db;
    background: #fff;
    border-radius: 10px;
    padding: 8px 12px;
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
  }

  .btn:hover {
    background: #f9fafb;
  }

  .stageWrap {
    padding: 10px;
    overflow: hidden;
  }

  .stage {
    width: 100%;
    height: calc(100vh - 86px);
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    touch-action: none;
    cursor: grab;
  }

  .stage:active {
    cursor: grabbing;
  }

  .stateBox {
    margin: 40px auto;
    width: min(640px, calc(100vw - 32px));
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    text-align: center;
    font-size: 18px;
  }

  .stateBox.error {
    color: #991b1b;
    border-color: #fecaca;
    background: #fff7f7;
  }
</style>