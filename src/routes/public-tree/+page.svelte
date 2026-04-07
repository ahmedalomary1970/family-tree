<script>
  import { onMount } from "svelte";

  let loading = true;
  let errorMsg = "";
  let raw = null;

  let workspaceCm = 150;
  let workspaceMm = 1500;

  let rings = [];
  let people = [];
  let links = [];
  let generationMarkers = [];
  let zoom = 1;
  let fontFamily = "Cairo, Arial, sans-serif";
  let projectTitle = "Family Tree";
  let projectRotationDeg = 0;
  let globalLinkStrokeWidth = 1.8;
  let globalPersonStrokeWidth = 1;

  let view = { x: 0, y: 0, w: workspaceMm, h: workspaceMm };
let activeBounds = { x: 0, y: 0, w: workspaceMm, h: workspaceMm };
  let isPanning = false;
  let panStart = { x: 0, y: 0, vx: 0, vy: 0 };

  let activePointers = new Map();
  let pinchStartDist = 0;
  let pinchStartView = null;

  let selectedPersonId = null;
  let showLineageDiagnostics = true;
  let personSearchName = "";
  let personSearchFather = "";
  let searchResults = [];
  let showSearchResults = false;
function computeActiveBounds() {
  if (!people.length) {
    activeBounds = {
      x: 0,
      y: 0,
      w: workspaceMm,
      h: workspaceMm
    };
    return;
  }

  const centerX = workspaceMm / 2;
  const centerY = workspaceMm / 2;

  const usedRingIds = new Set(
    people.map((p) => p.ringId).filter(Boolean)
  );

  const usedRings = rings.filter((r) => usedRingIds.has(r.id));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  if (usedRings.length) {
    const maxUsedRadius = Math.max(...usedRings.map(ringRadiusMm));
    minX = Math.min(minX, centerX - maxUsedRadius);
    maxX = Math.max(maxX, centerX + maxUsedRadius);
    minY = Math.min(minY, centerY - maxUsedRadius);
    maxY = Math.max(maxY, centerY + maxUsedRadius);
  }

  for (const p of people) {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const r = personRadiusMm(p) + 10;

    minX = Math.min(minX, x - r);
    maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r);
    maxY = Math.max(maxY, y + r);
  }

  if (!Number.isFinite(minX)) {
    activeBounds = {
      x: 0,
      y: 0,
      w: workspaceMm,
      h: workspaceMm
    };
    return;
  }

  const pad = 18;

  activeBounds = {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(100, maxX - minX + pad * 2),
    h: Math.max(100, maxY - minY + pad * 2)
  };
}
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

  function fitTreeToScreen() {
    if (!people.length) {
      view = {
        x: -40,
        y: -40,
        w: workspaceMm + 80,
        h: workspaceMm + 80
      };
      return;
    }

    const centerX = workspaceMm / 2;
    const centerY = workspaceMm / 2;

    const usedRingIds = new Set(
      people.map((p) => p.ringId).filter(Boolean)
    );

    const usedRings = rings.filter((r) => usedRingIds.has(r.id));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    if (usedRings.length) {
      const maxUsedRadius = Math.max(...usedRings.map(ringRadiusMm));
      minX = Math.min(minX, centerX - maxUsedRadius);
      maxX = Math.max(maxX, centerX + maxUsedRadius);
      minY = Math.min(minY, centerY - maxUsedRadius);
      maxY = Math.max(maxY, centerY + maxUsedRadius);
    }

    for (const p of people) {
      const x = Number(p.x) || 0;
      const y = Number(p.y) || 0;
      const r = personRadiusMm(p) + 8;

      minX = Math.min(minX, x - r);
      maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r);
      maxY = Math.max(maxY, y + r);
    }

    if (!Number.isFinite(minX)) {
      view = {
        x: -40,
        y: -40,
        w: workspaceMm + 80,
        h: workspaceMm + 80
      };
      return;
    }

    const pad = 24;

    view = {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(160, maxX - minX + pad * 2),
      h: Math.max(160, maxY - minY + pad * 2)
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

  function idsEqual(a, b) {
    return String(a ?? "") === String(b ?? "");
  }

  function getPersonById(id) {
    return people.find((p) => idsEqual(p.id, id)) || null;
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

  function getParentLinkForChild(childId) {
    if (!childId) return null;

    return (
      links.find((l) => idsEqual(l?.childId, childId) && l?.parentId) ||
      links.find((l) => idsEqual(l?.child, childId) && l?.parent) ||
      links.find((l) => idsEqual(l?.toId, childId) && l?.fromId) ||
      links.find((l) => idsEqual(l?.target, childId) && l?.source) ||
      null
    );
  }

  function getParentIdFromLink(link) {
    return link?.parentId || link?.parent || link?.fromId || link?.source || null;
  }

  function getChildIdFromLink(link) {
    return link?.childId || link?.child || link?.toId || link?.target || null;
  }

  function getLineageDiagnostics(startId) {
    const result = {
      selectedId: startId || null,
      selectedName: "",
      chainIds: [],
      chainNames: [],
      chainLinkKeys: [],
      hasVisibleAncestors: false,
      missingParentLinks: [],
      brokenLinks: [],
      selectedHasIncomingParentLink: false,
      note: ""
    };

    if (!startId) {
      result.note = "لا يوجد شخص محدد.";
      return result;
    }

    const selectedPerson = getPersonById(startId);
    result.selectedName = String(selectedPerson?.name || "").trim();

    const incomingLinks = links.filter((l) =>
      idsEqual(getChildIdFromLink(l), startId)
    );
    result.selectedHasIncomingParentLink = incomingLinks.length > 0;

    const seen = new Set();
    let currentId = startId;

    while (currentId && !seen.has(String(currentId))) {
      seen.add(String(currentId));
      result.chainIds.push(currentId);

      const person = getPersonById(currentId);
      const cleanName = String(person?.name || "").trim();
      result.chainNames.push(cleanName || `(بدون اسم: ${currentId})`);

      const parentLinks = links.filter((l) => idsEqual(getChildIdFromLink(l), currentId));
      if (!parentLinks.length) break;

      const chosen = parentLinks[0];
      const parentId = getParentIdFromLink(chosen);
      result.chainLinkKeys.push(`${parentId}|${currentId}`);

      const parentPerson = getPersonById(parentId);
      if (!parentPerson) {
        result.brokenLinks.push({ parentId, childId: currentId });
        break;
      }

      if (parentLinks.length > 1) {
        result.missingParentLinks.push(`يوجد أكثر من رابط أب مباشر للشخص ${cleanName || currentId}`);
      }

      currentId = parentId || null;
    }

    result.hasVisibleAncestors = result.chainIds.length > 1;

    if (!result.chainIds.length) {
      result.note = "تعذر تكوين سلسلة النسب لهذا الشخص.";
    } else if (!result.hasVisibleAncestors && !result.selectedHasIncomingParentLink) {
      result.note = "الشخص المحدد لا يملك رابطًا صاعدًا ظاهرًا.";
    } else if (result.brokenLinks.length) {
      result.note = "يوجد رابط نسب يشير إلى أب غير موجود داخل الأشخاص.";
    } else if (result.missingParentLinks.length) {
      result.note = "تم اعتماد أول رابط أب مباشر فقط لهذا التشخيص.";
    } else {
      result.note = "تم تشخيص السلسلة التصاعدية بنجاح.";
    }

    return result;
  }

  $: selectedPerson = getPersonById(selectedPersonId);
  $: lineageDiagnostics = selectedPersonId ? getLineageDiagnostics(selectedPersonId) : getLineageDiagnostics(null);
  $: lineageText = lineageDiagnostics.chainNames.length ? lineageDiagnostics.chainNames.join(" ← ") : "";
  
  function selectPerson(personId) {
    selectedPersonId = personId;
  }

  function normalizeArabicText(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[أإآ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/\s+/g, " ");
  }

  function getDirectParentPerson(personId) {
    const parentLink = getParentLinkForChild(personId);
    const parentId = getParentIdFromLink(parentLink);
    return parentId ? getPersonById(parentId) : null;
  }

  function getPersonSearchLabel(person) {
    const father = getDirectParentPerson(person?.id);
    const grandfather = father ? getDirectParentPerson(father.id) : null;

    const selfName = String(person?.name || "بدون اسم").trim() || "بدون اسم";
    const fatherName = String(father?.name || "—").trim() || "—";
    const grandName = String(grandfather?.name || "—").trim() || "—";

    return {
      selfName,
      fatherName,
      grandName,
      full: `${selfName} | ${fatherName} | ${grandName}`
    };
  }

  function updateSearchResults() {
    const nameQ = normalizeArabicText(personSearchName);
    const fatherQ = normalizeArabicText(personSearchFather);

    if (!nameQ && !fatherQ) {
      searchResults = [];
      showSearchResults = false;
      return;
    }

    searchResults = people
      .map((p) => ({
        person: p,
        ...getPersonSearchLabel(p)
      }))
      .filter((item) => {
        const matchName = !nameQ || normalizeArabicText(item.selfName).includes(nameQ);
        const matchFather = !fatherQ || normalizeArabicText(item.fatherName).includes(fatherQ);
        return matchName && matchFather;
      })
      .sort((a, b) => a.full.localeCompare(b.full, "ar"))
      .slice(0, 30);

    showSearchResults = true;
  }

  function handleSearchInput() {
    updateSearchResults();
  }

  function runSearch() {
    updateSearchResults();
  }

  function focusOnPerson(person) {
    if (!person) return;

    selectedPersonId = person.id;
    showLineageDiagnostics = true;

    const x = Number(person.x) || 0;
    const y = Number(person.y) || 0;
    const personBox = Math.max(140, personRadiusMm(person) * 10);

    view = {
      x: x - personBox / 2,
      y: y - personBox / 2,
      w: personBox,
      h: personBox
    };

    personSearchName = "";
    personSearchFather = "";
    searchResults = [];
    showSearchResults = false;
  }

  function pointerDistance(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.hypot(dx, dy);
  }

  function zoomAtClientPoint(clientX, clientY, factor, target) {
    const rect = target.getBoundingClientRect();
    const mx = (clientX - rect.left) / rect.width;
    const my = (clientY - rect.top) / rect.height;

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

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.88;
    zoomAtClientPoint(e.clientX, e.clientY, factor, e.currentTarget);
  }

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);

    activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
    });

    if (activePointers.size === 1) {
      isPanning = true;
      panStart = {
        x: e.clientX,
        y: e.clientY,
        vx: view.x,
        vy: view.y,
      };
    }

    if (activePointers.size === 2) {
      isPanning = false;
      const pts = Array.from(activePointers.values());
      pinchStartDist = pointerDistance(pts[0], pts[1]);
      pinchStartView = { ...view };
    }
  }

  function onPointerMove(e) {
    if (!activePointers.has(e.pointerId)) return;

    activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
    });

    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const newDist = pointerDistance(pts[0], pts[1]);

      if (pinchStartDist > 0 && pinchStartView && newDist > 0) {
        view = { ...pinchStartView };
        const factor = pinchStartDist / newDist;
        const centerX = (pts[0].x + pts[1].x) / 2;
        const centerY = (pts[0].y + pts[1].y) / 2;
        zoomAtClientPoint(centerX, centerY, factor, e.currentTarget);
      }
      return;
    }

    if (!isPanning || activePointers.size !== 1) return;

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

  function onPointerUp(e) {
    activePointers.delete(e.pointerId);

    if (activePointers.size < 2) {
      pinchStartDist = 0;
      pinchStartView = null;
    }

    if (activePointers.size === 1) {
      const remaining = Array.from(activePointers.values())[0];
      isPanning = true;
      panStart = {
        x: remaining.x,
        y: remaining.y,
        vx: view.x,
        vy: view.y,
      };
    } else {
      isPanning = false;
    }
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
      zoom = Number(raw.zoom) || 1;
      fontFamily = raw.fontFamily || "Cairo, Arial, sans-serif";
      projectRotationDeg = Number(raw.projectRotationDeg) || 0;
      globalLinkStrokeWidth = Math.max(0.1, Number(raw.globalLinkStrokeWidth) || 1.8);
      globalPersonStrokeWidth = Math.max(0.1, Number(raw.globalPersonStrokeWidth) || 1);
      selectedPersonId = null;

      computeActiveBounds();
fitTreeToScreen();
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

      <div class="searchBoxWrap">
        <div class="searchRow">
          <input
            class="searchInput"
            type="text"
            bind:value={personSearchName}
            placeholder="ابحث بالاسم..."
            on:input={handleSearchInput}
            on:focus={() => {
              if (personSearchName.trim() || personSearchFather.trim()) showSearchResults = true;
            }}
          />
          <input
            class="searchInput"
            type="text"
            bind:value={personSearchFather}
            placeholder="اسم الأب..."
            on:input={handleSearchInput}
            on:focus={() => {
              if (personSearchName.trim() || personSearchFather.trim()) showSearchResults = true;
            }}
          />
          <button class="btn searchBtn" type="button" on:click={runSearch}>بحث</button>
        </div>

        {#if showSearchResults}
          <div class="searchDropdown">
            {#if searchResults.length}
              {#each searchResults as item}
                <button
                  class="searchItem"
                  type="button"
                  on:click={() => focusOnPerson(item.person)}
                >
                  <div class="searchMain">{item.selfName}</div>
                  <div class="searchMeta">الأب: {item.fatherName} • الجد: {item.grandName}</div>
                </button>
              {/each}
            {:else}
              <div class="searchEmpty">لا توجد نتائج مطابقة.</div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="actions">
        <button class="btn" on:click={fitTreeToScreen}>ملاء الشاشة</button>
        <button class="btn" on:click={() => (showLineageDiagnostics = !showLineageDiagnostics)}>
          {showLineageDiagnostics ? "🧪 إخفاء تشخيص النسب" : "🧪 إظهار تشخيص النسب"}
        </button>
      </div>
    </div>

    <div class="contentGrid">
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
          on:pointercancel={onPointerUp}
          on:pointerleave={onPointerUp}
        >
         <!-- الخلفية الليلية -->
<rect
  x={-workspaceMm}
  y={-workspaceMm}
  width={workspaceMm * 3}
  height={workspaceMm * 3}
  fill="#2b2f36"
/>

<!-- مساحة العمل الفعلية فقط -->
<rect
  x={activeBounds.x}
  y={activeBounds.y}
  width={activeBounds.w}
  height={activeBounds.h}
  rx="10"
  ry="10"
  fill="#ffffff"
  stroke="#d1d5db"
  stroke-width="2"
/>

          <g transform={`rotate(${projectRotationDeg} ${workspaceMm / 2} ${workspaceMm / 2})`}>
          {#each rings as ring}
  <circle
    cx={workspaceMm / 2}
    cy={workspaceMm / 2}
    r={ringRadiusMm(ring)}
    fill="none"
    stroke="#000000"
    stroke-width="0.5"
    vector-effect="non-scaling-stroke"
  />
{/each}

          {#each links as link}
            {@const parent = getPersonById(link.parentId)}
            {@const child = getPersonById(link.childId)}
            {#if parent && child}
              <path
                d={linkPathD(parent, child, link.bends)}
                fill="none"
                stroke="#000000"
                stroke-width={globalLinkStrokeWidth}
                stroke-linecap="round"
                stroke-linejoin="round"
                opacity="1"
                vector-effect="non-scaling-stroke"
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
                transform={`rotate(${-projectRotationDeg - (Number(gm.rotationDeg) || 0)} 0 0)`}
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
            {@const isSelected = p.id === selectedPersonId}

            <g
              transform={`translate(${p.x || 0}, ${p.y || 0})`}
              class:selected={isSelected}
              class="personNode"
              role="button"
              tabindex="0"
              on:pointerdown|stopPropagation={() => selectPerson(p.id)}
              on:click|stopPropagation={() => selectPerson(p.id)}
              on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectPerson(p.id)}
            >
              {#if p.highlightRing}
                <circle
                  r={r + 1}
                  fill="none"
                  stroke="#000000"
                  stroke-width="1.7"
                  vector-effect="non-scaling-stroke"
                />
                <circle
                  r={r + 3}
                  fill="none"
                  stroke="#000000"
                  stroke-width="1.7"
                  vector-effect="non-scaling-stroke"
                />
              {/if}

              {#if isSelected}
                <circle
                  r={r + 1.9}
                  fill="none"
                  stroke="#2563eb"
                  stroke-width="1.2"
                  vector-effect="non-scaling-stroke"
                />
              {/if}

              <circle
                r={r}
                fill="#ffffff"
                stroke={isSelected ? "#2563eb" : "#000000"}
                stroke-width={isSelected ? globalPersonStrokeWidth + 0.8 : globalPersonStrokeWidth}
              />

              <text
                text-anchor="middle"
                fill="#111827"
                transform={`rotate(${-projectRotationDeg} 0 0)`}
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
          </g>
        </svg>
      </div>

      {#if showLineageDiagnostics}
        <aside class="diagPanel">
          <div class="diagTitle">🧪 تشخيص النسب التصاعدي</div>

          {#if selectedPerson}
            <div class="diagHint">
              الشخص المحدد: <strong>{selectedPerson.name}</strong>
            </div>

            {#if lineageDiagnostics.chainNames.length}
              <div class="diagLineText">{lineageText}</div>

              <div class="diagChain">
                {#each lineageDiagnostics.chainNames as name, idx}
                  <div class="diagItem">
                    <div class="diagStep">
                      {#if idx === 0}
                        الاسم
                      {:else if idx === 1}
                        الأب
                      {:else}
                        الجد {idx - 1}
                      {/if}
                    </div>
                    <div class="diagName">{name || "بدون اسم"}</div>
                  </div>
                {/each}
              </div>

              {#if lineageDiagnostics.note}
                <div class="diagNote">{lineageDiagnostics.note}</div>
              {/if}
            {:else}
              <div class="diagEmpty">لا يوجد نسب صاعد لهذا الشخص.</div>
            {/if}
          {:else}
            <div class="diagEmpty">اضغط على أي شخص داخل الشجرة لإظهار النسب التصاعدي.</div>
          {/if}
        </aside>
      {/if}
    </div>
  </div>
{/if}

<style>
  .searchBoxWrap {
    position: relative;
    min-width: 280px;
    max-width: 460px;
    width: 100%;
    z-index: 20;
  }

  .searchRow {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .searchInput {
    flex: 1 1 auto;
    width: 100%;
    height: 42px;
    border: 1px solid #d1d5db;
    border-radius: 12px;
    background: #fff;
    padding: 0 14px;
    font-size: 14px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .searchInput:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08);
  }

  .searchDropdown {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    left: 0;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.08);
    max-height: 320px;
    overflow: auto;
    z-index: 50;
  }

  .searchItem {
    width: 100%;
    border: 0;
    background: transparent;
    text-align: right;
    padding: 10px 12px;
    cursor: pointer;
    font-family: inherit;
  }

  .searchItem:hover {
    background: #f8fafc;
  }

  .searchMain {
    font-size: 14px;
    font-weight: 800;
    color: #111827;
  }

  .searchBtn {
    white-space: nowrap;
    height: 42px;
  }

  .searchEmpty {
    padding: 12px;
    font-size: 13px;
    color: #6b7280;
    text-align: center;
  }

  .searchMeta {
    margin-top: 4px;
    font-size: 12px;
    color: #6b7280;
    line-height: 1.6;
  }

  .page {
    min-height: 100vh;
     background: #1f2329;
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
    flex-wrap: wrap;
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

  .contentGrid {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 12px;
    padding: 10px;
  }

  .stageWrap {
    min-width: 0;
    overflow: hidden;
  }

  .stage {
    width: 100%;
    height: calc(100vh - 86px);
    background: #1f2329;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    cursor: grab;
  }

  .stage:active {
    cursor: grabbing;
  }

  .personNode {
    cursor: pointer;
  }

  .diagPanel {
    align-self: start;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 14px;
    box-shadow: 0 8px 24px rgba(17, 24, 39, 0.06);
  }

  .diagTitle {
    font-size: 17px;
    font-weight: 800;
    color: #111827;
    margin-bottom: 10px;
  }

  .diagHint {
    font-size: 14px;
    color: #374151;
    margin-bottom: 12px;
    line-height: 1.8;
  }

  .diagLineText {
    border: 1px solid #fde68a;
    background: #fffbeb;
    color: #92400e;
    border-radius: 12px;
    padding: 10px 12px;
    margin-bottom: 12px;
    font-size: 15px;
    font-weight: 800;
    line-height: 1.9;
    word-break: break-word;
  }

  .diagChain {
    display: grid;
    gap: 8px;
  }

  .diagItem {
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 10px 12px;
    background: #f9fafb;
  }

  .diagStep {
    font-size: 12px;
    color: #6b7280;
    margin-bottom: 4px;
  }

  .diagName {
    font-size: 15px;
    font-weight: 700;
  }

  .diagNote {
    margin-top: 10px;
    font-size: 13px;
    color: #6b7280;
    line-height: 1.7;
    color: #111827;
  }

  .diagEmpty {
    font-size: 14px;
    color: #6b7280;
    line-height: 1.8;
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

  @media (max-width: 900px) {
    .contentGrid {
      grid-template-columns: 1fr;
    }

    .diagPanel {
      order: -1;
    }

    .searchBoxWrap {
      min-width: 100%;
      max-width: 100%;
      order: 3;
    }

    .actions {
      width: 100%;
    }

    .stage {
      height: 70vh;
    }
  }
</style>
