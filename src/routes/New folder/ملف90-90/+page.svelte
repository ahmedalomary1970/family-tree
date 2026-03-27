<script>
  import { onMount } from "svelte";
  import { supabase } from "$lib/supabaseClient.js";
  /**
   * =====================================================
   * +page.svelte
   * =====================================================
   * هذا الملف هو الصفحة الرئيسية لمشروع شجرة العائلة.
   *
   * ترتيب الملف في هذه النسخة:
   * 1) الإعدادات والثوابت العامة
   * 2) حالات البرنامج (State)
   * 3) الأدوات المساعدة الهندسية
   * 4) التفاعل والسحب والتحريك
   * 5) إدارة الأشخاص والروابط والأجيال
   * 6) الحفظ والتحميل والمشاريع المحلية
   * 7) المزامنة السحابية مع Supabase
   * 8) الرسم داخل SVG
   * 9) النوافذ المنبثقة (المودالات)
   * 10) الستايل
   *
   * ملاحظات سريعة:
   * - مساحة العمل الحالية: 150 × 150 سم
   * - جميع الإحداثيات الداخلية تُدار بالـ mm
   * - الحفظ المحلي يعتمد على LocalStorage
   * - الحفظ السحابي يعتمد على Supabase
   * - دعم Undo / Redo موجود داخل نفس الملف
   * - أي مشروع قديم بمساحة 90cm يتم ترحيله إلى 150cm عند التحميل
   */

  // ================================
  // A) الإعدادات والثوابت العامة
  // ================================
  // هنا نعرّف مقاس مساحة العمل، حدود السماكات، ومفاتيح الحفظ.
  // أي تغيير في المقاسات الأساسية يبدأ من هذا القسم.
  const WORKSPACE_CM = 90;
  const WORKSPACE_MM = WORKSPACE_CM * 23.325; // 900mm
  const CX = WORKSPACE_MM / 2;
  const CY = WORKSPACE_MM / 2;

  const PERSON_DIAM_MAX_CM = 3; // max 3cm حسب طلبك
  const STROKE_MM_MIN = 0;
  const STROKE_MM_MAX = 3;

  const SNAP_KEY = "familytree_snapshot_v1";

  // ملف المشروع المحلي (فتح / حفظ / حفظ باسم مثل البرامج المكتبية)
  let currentDocName = "مستند جديد.ftree";
  let currentDocHandle = null;
  let fileOpenInputEl;
  let lastExplicitSaveJson = "";
  let hasUnsavedChanges = false;

  
  // حفظ مشاريع متعددة بأسماء
  const PROJECTS_KEY = "familytree_projects_v1";

  // ================================
  // B) نظام التراجع / الإعادة
  // ================================
  // هذا القسم يحتفظ بآخر لقطات الحفظ حتى يمكن الرجوع إليها بـ Ctrl+Z
  // أو إعادة الحركة بـ Ctrl+Y / Ctrl+Shift+Z.
  const UNDO_LIMIT = 10;
  let undoStack = [];
  let redoStack = [];
  let lastCommitJson = "";

  function resetHistoryFromCurrent() {
    try {
      lastCommitJson = JSON.stringify(buildSnapshot());
    } catch {
      lastCommitJson = "";
    }
    undoStack = [];
    redoStack = [];
  }

  function commitHistoryFromSnapshot(snap) {
    try {
      const json = JSON.stringify(snap);

      if (!lastCommitJson) {
        lastCommitJson = json;
        return false;
      }

      if (json === lastCommitJson) return false;

      undoStack.push(JSON.parse(lastCommitJson));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();

      redoStack = [];
      lastCommitJson = json;
      return true;
    } catch {
      return false;
    }
  }

  function persistSnapshotDirect(snap) {
    try {
      readProjectsStore();
      if (projectsStore.active) {
        const n = projectsStore.active;
        projectsStore.items = projectsStore.items || {};
        projectsStore.meta = projectsStore.meta || {};
        projectsStore.items[n] = snap;
        projectsStore.meta[n] = { ...(projectsStore.meta[n] || {}), savedAt: Date.now() };
        persistProjectsStore();
      }
    } catch {}

    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch {}
  }

  function undoAction() {
    if (!undoStack.length) return;

    try {
      const current = buildSnapshot();
      redoStack.push(JSON.parse(JSON.stringify(current)));
      if (redoStack.length > UNDO_LIMIT) redoStack.shift();
    } catch {}

    const prev = undoStack.pop();
    if (!prev) return;

    if (applySnapshot(prev)) {
      persistSnapshotDirect(prev);
      try {
        lastCommitJson = JSON.stringify(prev);
      } catch {
        lastCommitJson = "";
      }
      toast("↶ تراجع");
    }
  }

  function redoAction() {
    if (!redoStack.length) return;

    try {
      const current = buildSnapshot();
      undoStack.push(JSON.parse(JSON.stringify(current)));
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    } catch {}

    const next = redoStack.pop();
    if (!next) return;

    if (applySnapshot(next)) {
      persistSnapshotDirect(next);
      try {
        lastCommitJson = JSON.stringify(next);
      } catch {
        lastCommitJson = "";
      }
      toast("↷ إعادة");
    }
  }
// ================================
  // C) شكل البيانات (Data Model)
  // ================================
  // هذا توصيف مختصر لشكل الكيانات الأساسية داخل الملف:
  // الجيل / الشخص / الرابط / رقم الجيل.
  // B) Data Model Shapes (conceptual)
  // rings: { id, diameterCm }
  // people: { id, ringId, name, diameterCm, strokeMm, fontPx, x, y }
  // links: { parentId, childId, bends: [{x,y}], strokeMm? }
  // generationMarkers: { id, ringId, x, y, widthMm, heightMm, fontPx, fill, textColor, strokeColor }
  // ================================
let divisionCount = 0; // 0 / 4 / 8 / 16 / 32 / 64 / 128
const GUIDE_DIAM_CM = WORKSPACE_CM - 5;
const GUIDE_R_MM = (GUIDE_DIAM_CM * 10) / 2; // 425mm

  // ===== BEGIN: workspace guides + lineage controls =====
  let showWorkspaceGuides = true;
  let showLineageTrace = true;
  let lineageTraceMode = "ancestors"; // ancestors | descendants
  let showLineageDiagnostics = false;
  let workspaceGuideMinorColor = "#94a3b8";
  let workspaceGuideMajorColor = "#334155";
  let outerGuideColor = "#dc2626";
  let divisionGuideColor = "#dc2626";
  
  let guideStrokeWidth = 0.5;
  let showGuidePanel = false;
  let showEditPanel = false;
  let showDrawPanel = false;
  let showViewPanel = true;
  let showProjectPanel = false;
  let guideFrameOpen = true;
  let guideGridOpen = true;
  let guideAppearanceOpen = true;
  let editPersonSectionOpen = true;
  let editLinkSectionOpen = true;
let globalLinkStrokeWidth = 1.8;
let globalPersonStrokeWidth = 1;
  // ===== END: guide thickness controls =====
  // ===== BEGIN: lineage text-only mode =====
  // تم تجميد تلوين وتتبع المسار بصرياً مؤقتاً والإبقاء على سلسلة النسب النصية فقط.
  // ===== END: lineage text-only mode =====
  // ===== END: workspace guides + lineage controls =====

  // ================================
  // D) الحالات العامة للصفحة (Global State)
  // ================================
  // هنا تُعرَّف جميع متغيرات الواجهة، المودالات، الكاميرا، والاختيارات الحالية.
// === Add Ring Modal ===
let showAddRing = false;
let newRingDiameterCm = GUIDE_DIAM_CM;
let ringErr = "";
// === Edit Ring Modal ===
let showEditRing = false;
let editRingId = null;
let editRingDiameterCm = GUIDE_DIAM_CM;
let editRingErr = "";

  let rings = [
    { id: "r_1", diameterCm: GUIDE_DIAM_CM },
  ];

  let people = [];
  let generationMarkers = [];
  let baseGenerationNumber = 1;
  let selectedMarkerId = null;

// ================================
// مشاريع (حفظ باسم + تحميل + حذف) داخل LocalStorage
// ================================
let showProjects = false;
let projectsStore = { v: 1, active: "", items: {}, meta: {} }; // {active, items: {name: snapshot}}
let projectNames = [];
let projectNameInput = "";
let projectLoadSelect = "";
let showDeleteProjectConfirm = false;
let pendingDeleteProjectName = "";

  // مرجع للـ SVG لتحويل إحداثيات الماوس إلى إحداثيات مساحة العمل
  let svgEl;
let boardContentEl;

  let stageEl;

  // ===== BEGIN: toolbar polish + fullscreen =====
  let treeToolsMenuEl;
  let fileMenuEl;
  let workspaceFullscreenEl;
  let isWorkspaceFullscreen = false;

  function closeToolbarMenus() {
    try { treeToolsMenuEl?.removeAttribute("open"); } catch {}
    try { fileMenuEl?.removeAttribute("open"); } catch {}
  }

  function toggleMenu(menuEl) {
    if (!menuEl) return;
    const willOpen = !menuEl.open;
    closeToolbarMenus();
    if (willOpen) menuEl.setAttribute("open", "");
  }

  function runMenuAction(fn) {
    closeToolbarMenus();
    return typeof fn === "function" ? fn() : undefined;
  }

  async function toggleWorkspaceFullscreen() {
    try {
      if (!workspaceFullscreenEl) return;
      if (!document.fullscreenElement) {
        await workspaceFullscreenEl.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch (e) {
      toast("تعذر تفعيل وضع ملء الشاشة");
    }
  }
  // ===== END: toolbar polish + fullscreen =====

  // Zoom (Camera)
  let zoom = 1;
  let zoomInput = 1;

  // Camera viewBox state (world space in mm)
  let view = { x: 0, y: 0, w: WORKSPACE_MM, h: WORKSPACE_MM };

  // Pan (سحب مساحة العمل بالكلك اليسار على الفراغ)
  let isPanning = false;
  let panPointerId = null;
  let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
  let lastPanEndAt = 0;
// --------------------------------
// إنشاء مشروع فارغ من المشروع الحالي
// --------------------------------
// الفكرة: ننسخ المشروع النشط كما هو، ثم نفرغ الأشخاص والروابط فقط
// ونترك الهيكل العام مثل الأجيال والإعدادات.
function createEmptyFromActive() {
  // مهم: هذه الدالة تملأ projectsStore (ولا ترجع store)
  readProjectsStore();

  if (!projectsStore?.active) {
    toast("حدد مشروع أولاً");
    return;
  }

  const cur = projectsStore.items?.[projectsStore.active];
  if (!cur) {
    toast("تعذر قراءة المشروع الحالي");
    return;
  }

  // نسخة عميقة
  const copy = JSON.parse(JSON.stringify(cur));

  // تفريغ الأسماء/الروابط مع إبقاء الأجيال (rings) وباقي الإعدادات
  copy.people = [];
  copy.links = [];
  copy.generationMarkers = [];
  copy.selectedPersonId = null;
  copy.selectedMarkerId = null;
  copy.selectedLinkKey = null;

  // اسم جديد غير متكرر
  const base = `${projectsStore.active} - فارغ`;
  let n = base;
  let i = 2;
  while (projectsStore.items?.[n]) {
    n = `${base} (${i})`;
    i++;
  }

  // حفظ داخل المشاريع
  projectsStore.items[n] = copy;
  projectsStore.meta = projectsStore.meta || {};
  projectsStore.meta[n] = { savedAt: Date.now() };
  projectsStore.active = n;
  projectLoadSelect = n;

  persistProjectsStore();
  refreshProjectNames(true);

  // نثبت مساحة العمل الحالية داخل المشروع الجديد حتى لا يحدث ترحيل لاحقاً بالخطأ
  copy.workspaceCm = WORKSPACE_CM;

  // تحديث الحفظ القديم للتوافق (مثل ما ملفك يسوي بالتحميل/الحفظ)
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(copy)); } catch {}

  // تطبيقه على الشاشة
  applySnapshot(copy);

  toast("🆕 تم إنشاء: " + n);
}

  function startPan(e) {
    if (isPanning) return;
    isPanning = true;
    panPointerId = e.pointerId;
    panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    try {
      svgEl?.setPointerCapture?.(e.pointerId);
    } catch {}
  }

  function updatePan(e) {
    if (!isPanning || panPointerId !== e.pointerId) return false;

    const rect = svgEl?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return true;

    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;

    // تحويل حركة البكسل إلى إزاحة داخل world(mm) اعتماداً على viewBox الحالي
    const mmPerPxX = view.w / rect.width;
    const mmPerPxY = view.h / rect.height;

    view = {
      ...view,
      x: panStart.vx - dx * mmPerPxX,
      y: panStart.vy - dy * mmPerPxY
    };
    clampViewToWorkspace();
    return true;
  }

  function endPan(e) {
    if (!isPanning) return false;
    if (panPointerId !== e.pointerId) return false;
    isPanning = false;
    panPointerId = null;
    lastPanEndAt = Date.now();
    return true;
  }

  function clampViewToWorkspace() {
    // نبقي الكاميرا داخل مساحة العمل قدر الإمكان
    const maxX = WORKSPACE_MM - view.w;
    const maxY = WORKSPACE_MM - view.h;
    view.x = clamp(view.x, 0, Math.max(0, maxX));
    view.y = clamp(view.y, 0, Math.max(0, maxY));
  }

  function syncViewFromZoom(keepCenter = true) {
    // zoom = 1 يعني view.w = WORKSPACE_MM
    const z = clamp(Number(zoom) || 1, 0.5, 3);
    zoom = z;
    zoomInput = z;

    const cx = keepCenter ? (view.x + view.w / 2) : CX;
    const cy = keepCenter ? (view.y + view.h / 2) : CY;

    const w2 = WORKSPACE_MM / z;
    const h2 = WORKSPACE_MM / z;

    view = { x: cx - w2 / 2, y: cy - h2 / 2, w: w2, h: h2 };
    clampViewToWorkspace();
  }

  // مؤشر الماوس داخل مساحة العمل (نقطة إرشادية)
  let cursor = { x: CX, y: CY, show: false };

  function onMouseMove(e) {
    const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);
    cursor = { x: pt.x, y: pt.y, show: true };
  }

  function onMouseLeave() {
    cursor = { ...cursor, show: false };
  }

// إدارة الأشخاص (مودال إضافة)
  let showAddName = false;

// ===============================
// طباعة احترافية: اختيار حجم الورق (A4/A3/A2/A1/A0) بالـ mm
// - تكبير تلقائي لملء الورقة قدر الإمكان (بدون تشويه)
// - طباعة الدوائر + الروابط فقط (بدون حلقات/أدلة/مؤشرات/أزرار)
// ===============================
let showPrintModal = false;
let printPaper = "A4";       // A4 | A3 | A2 | A1 | A0
let printOrientation = "landscape"; // portrait | landscape
let printErr = "";
let printMode = "fit"; // fit | poster
let printPosterBasis = "content"; // content | workspace
let printPosterOverlapMm = 5;
let printPosterShowMarks = true;
let printPosterShowPageLabels = true;

const PAPER_MM = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A2: { w: 420, h: 594 },
  A1: { w: 594, h: 841 },
  A0: { w: 841, h: 1189 }
};

// ===============================
// تعديل الشخص (Right Click) - إضافة معزولة
// ===============================
let showPersonEditModal = false;
let peName = "";
let peFontPx = 12;
let peDiameterCm = 3;
let peHighlightRing = false;
let personEditErr = "";

let showGenerationMarkerModal = false;
let generationMarkerRingId = null;
let generationMarkerErr = "";

let showMarkerEditModal = false;
let meId = null;
let meRingId = null;
let meWidthMm = 22;
let meHeightMm = 10;
let meFontPx = 14;
let meFill = "#ffffff";
let meTextColor = "#111827";
let meStrokeColor = "#111827";
let meBaseGenerationNumber = 1;
let meTextFollowRotation = false;
let markerEditErr = "";

function openPersonEditModal(p) {
  if (!p) return;
  selectedPersonId = p.id;
  peName = String(p.name ?? "");
  peFontPx = Number(p.fontPx ?? 12) || 12;
  peDiameterCm = Number(p.diameterCm ?? 3) || 3;
  peHighlightRing = !!p.highlightRing;
  personEditErr = "";
  showPersonEditModal = true;
}

function closePersonEditModal() {
  showPersonEditModal = false;
  personEditErr = "";
}

function applyPersonEditModal() {
  const idx = people.findIndex((x) => x.id === selectedPersonId);
  if (idx === -1) { closePersonEditModal(); return; }

  const name = String(peName ?? "").trim();
  let fontPx = Number(peFontPx);
  let diameterCm = Number(peDiameterCm);

  if (!name) { personEditErr = "الاسم مطلوب"; return; }

  // بدون تقييد: نقبل أي رقم صالح، مع تنظيف بسيط لتفادي NaN
  if (!Number.isFinite(fontPx)) fontPx = 12;
  if (!Number.isFinite(diameterCm)) diameterCm = (Number(people[idx]?.diameterCm) || 3);

  // تحديث بطريقة تضمن Reactivity في Svelte (إعادة إسناد المصفوفة)
  const updated = { ...people[idx], name, fontPx: Math.round(fontPx), diameterCm: +Number(diameterCm).toFixed(2), highlightRing: !!peHighlightRing };
  people = [...people.slice(0, idx), updated, ...people.slice(idx + 1)];

  // الحفظ الفعلي (الدالة الأصلية الموجودة في الملف)
  try { saveNow(); } catch {}

  closePersonEditModal();
}

function deleteSelectedPersonFromEditModal() {
  const id = selectedPersonId;
  if (!id) {
    closePersonEditModal();
    return;
  }

  const person = people.find((x) => x.id === id);
  if (!person || person.locked) return;

  people = people.filter((x) => x.id !== id);
  links = links.filter((l) => l.parentId !== id && l.childId !== id && l.fromId !== id && l.toId !== id);
  selectedPersonIds = selectedPersonIds.filter((x) => x !== id);
  if (selectedPersonId === id) selectedPersonId = selectedPersonIds.length ? selectedPersonIds[selectedPersonIds.length - 1] : null;

  try { saveNow(); } catch {}
  closePersonEditModal();
}

function ringIndexById(ringId) {
  return rings.findIndex((r) => r.id === ringId);
}

function findGenerationMarkerByRingId(ringId) {
  return generationMarkers.find((m) => m.ringId === ringId) || null;
}

function formatGenerationNumber(n) {
  const safe = Math.max(0, Math.floor(Number(n) || 0));
  return String(safe).padStart(2, "0");
}

function getGenerationNumberForRing(ringId) {
  const idx = ringIndexById(ringId);
  if (idx < 0) return formatGenerationNumber(baseGenerationNumber);
  return formatGenerationNumber((Number(baseGenerationNumber) || 1) + idx);
}

function getDefaultMarkerPositionForRing(ringId) {
  const outerBase = ringRadiusMmById(ringId);
  const innerBase = prevRingRadiusMmById(ringId);
  const radius = innerBase > 0 ? (innerBase + outerBase) / 2 : Math.max(outerBase - 20, outerBase * 0.7);
  return {
    x: CX,
    y: clamp(CY - radius, 0, WORKSPACE_MM),
  };
}

function createGenerationMarkerForRing(ringId) {
  const existing = findGenerationMarkerByRingId(ringId);
  if (existing) {
    selectedMarkerId = existing.id;
    selectedPersonId = null;
    selectedPersonIds = [];
    toast("رقم الجيل موجود مسبقًا");
    return existing;
  }

  const pos = getDefaultMarkerPositionForRing(ringId);
  const marker = {
    id: `gm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ringId,
    x: pos.x,
    y: pos.y,
    widthMm: 22,
    heightMm: 10,
    fontPx: 14,
    rotationDeg: 0,
    fill: "#ffffff",
    textColor: "#111827",
    strokeColor: "#111827",
    textFollowRotation: false,
  };

  generationMarkers = [...generationMarkers, marker];
  selectedMarkerId = marker.id;
  selectedPersonId = null;
  selectedPersonIds = [];
  toast("تمت إضافة رقم الجيل");
  try { saveNow(); } catch {}
  return marker;
}

function openGenerationMarkerModal() {
  generationMarkerErr = "";
  showGenerationMarkerModal = true;

  const selectedPerson = people.find((p) => p.id === selectedPersonId);
  if (selectedPerson?.ringId) generationMarkerRingId = selectedPerson.ringId;
  else if (rings.length) generationMarkerRingId = rings[rings.length - 1].id;
  else generationMarkerRingId = null;
}

function closeGenerationMarkerModal() {
  showGenerationMarkerModal = false;
  generationMarkerErr = "";
}

function confirmGenerationMarkerModal() {
  generationMarkerErr = "";
  if (!generationMarkerRingId) {
    generationMarkerErr = "اختر جيلاً أولاً.";
    return;
  }

  const marker = createGenerationMarkerForRing(generationMarkerRingId);
  showGenerationMarkerModal = false;
  if (marker) openMarkerEditModal(marker);
}

function openMarkerEditModal(marker) {
  if (!marker) return;
  selectedMarkerId = marker.id;
  selectedPersonId = null;
  selectedPersonIds = [];
  meId = marker.id;
  meRingId = marker.ringId;
  meWidthMm = Number(marker.widthMm ?? 22) || 22;
  meHeightMm = Number(marker.heightMm ?? 10) || 10;
  meFontPx = Number(marker.fontPx ?? 14) || 14;
  meFill = String(marker.fill || "#ffffff");
  meTextColor = String(marker.textColor || "#111827");
  meStrokeColor = String(marker.strokeColor || "#111827");
  meBaseGenerationNumber = Number(baseGenerationNumber) || 1;
  meTextFollowRotation = Boolean(marker.textFollowRotation);
  markerEditErr = "";
  showMarkerEditModal = true;
}

function closeMarkerEditModal() {
  showMarkerEditModal = false;
  markerEditErr = "";
  meId = null;
}

function applyMarkerEditModal() {
  markerEditErr = "";
  const idx = generationMarkers.findIndex((x) => x.id === meId);
  if (idx === -1) {
    closeMarkerEditModal();
    return;
  }

  if (!meRingId) {
    markerEditErr = "اختر جيلاً.";
    return;
  }

  const duplicate = generationMarkers.find((x) => x.ringId === meRingId && x.id !== meId);
  if (duplicate) {
    markerEditErr = "هذا الجيل يملك رقم جيل بالفعل.";
    return;
  }

  let widthMm = Number(meWidthMm);
  let heightMm = Number(meHeightMm);
  let fontPx = Number(meFontPx);
  let baseNum = Number(meBaseGenerationNumber);
  let textFollowRotation = Boolean(meTextFollowRotation);

  if (!Number.isFinite(widthMm) || widthMm < 10) widthMm = 22;
  if (!Number.isFinite(heightMm) || heightMm < 6) heightMm = 10;
  if (!Number.isFinite(fontPx) || fontPx < 8) fontPx = 14;
  if (!Number.isFinite(baseNum)) baseNum = 1;

  const current = generationMarkers[idx];
  const halfW = widthMm / 2;
  const halfH = heightMm / 2;

  generationMarkers = generationMarkers.map((marker) =>
    marker.id !== meId
      ? marker
      : {
          ...marker,
          ringId: meRingId,
          widthMm: +widthMm.toFixed(2),
          heightMm: +heightMm.toFixed(2),
          fontPx: Math.round(fontPx),
          fill: meFill || "#ffffff",
          textColor: meTextColor || "#111827",
          strokeColor: meStrokeColor || "#111827",
          textFollowRotation,
          x: clamp(Number(current.x) || CX, halfW, WORKSPACE_MM - halfW),
          y: clamp(Number(current.y) || CY, halfH, WORKSPACE_MM - halfH),
        }
  );

  baseGenerationNumber = Math.max(0, Math.round(baseNum));
  try { saveNow(); } catch {}
  closeMarkerEditModal();
}

function deleteMarker(id) {
  generationMarkers = generationMarkers.filter((m) => m.id !== id);
  if (selectedMarkerId === id) selectedMarkerId = null;
  if (meId === id) closeMarkerEditModal();
  toast("تم حذف رقم الجيل");
  try { saveNow(); } catch {}
}

function openPrintModal() {
  printErr = "";
  showPrintModal = true;
}

function closePrintModal() {
  showPrintModal = false;
  printErr = "";
}

function getWorkspaceContentBBox() {
  try {
    const g = boardContentEl || (svgEl ? svgEl.querySelector("g") : null);
    if (!g) return null;
    const bb = g.getBBox();
    if (!bb || !Number.isFinite(bb.width) || !Number.isFinite(bb.height)) return null;
    return bb;
  } catch {
    return null;
  }
}

function getPageSizeMm() {
  const p = PAPER_MM[printPaper] || PAPER_MM.A4;
  if (printOrientation === "landscape") return { w: p.h, h: p.w };
  return { w: p.w, h: p.h };
}

function buildPrintableSvg(viewBox, preserveAspectRatio = "xMidYMid meet") {
  if (!svgEl) return "";
  const svgClone = svgEl.cloneNode(true);
  if (viewBox) svgClone.setAttribute("viewBox", viewBox);
  svgClone.removeAttribute("width");
  svgClone.removeAttribute("height");
  svgClone.setAttribute("preserveAspectRatio", preserveAspectRatio);
  svgClone.style.width = "100%";
  svgClone.style.height = "100%";
  return svgClone.outerHTML;
}

function getPosterSourceRect() {
  if (printPosterBasis === "workspace") {
    return { x: 0, y: 0, w: WORKSPACE_MM, h: WORKSPACE_MM };
  }
  const bb = getWorkspaceContentBBox();
  if (bb && bb.width > 0 && bb.height > 0) {
    return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  }
  return { x: 0, y: 0, w: WORKSPACE_MM, h: WORKSPACE_MM };
}

function getPosterGridInfo() {
  const page = getPageSizeMm();
  const source = getPosterSourceRect();
  const overlap = clamp(Number(printPosterOverlapMm) || 0, 0, Math.min(page.w - 1, page.h - 1, 50));
  const stepX = Math.max(1, page.w - overlap);
  const stepY = Math.max(1, page.h - overlap);

  const pagesX = Math.max(1, Math.ceil(Math.max(0, source.w - page.w) / stepX) + 1);
  const pagesY = Math.max(1, Math.ceil(Math.max(0, source.h - page.h) / stepY) + 1);

  return { page, source, overlap, stepX, stepY, pagesX, pagesY, totalPages: pagesX * pagesY };
}

function getPosterPageLabel(ix, iy) {
  return `${String.fromCharCode(65 + iy)}${ix + 1}`;
}

function printBaseCss() {
  return `
    html, body { margin: 0; padding: 0; background: #fff; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: system-ui, sans-serif; }
    svg { background: #fff !important; display:block; }
    .noPrintGuide, .ringCircle, .guideCircle, .guideLine, .cursorDot, .selCross, .bendPlus, .bendHandle, .generationMarkerSvg { display: none !important; }
    .boardBg { fill: #fff !important; }
    .personTextSvg { direction: rtl; unicode-bidi: plaintext; fill:#000; font-weight:700; pointer-events:none; }
  `;
}

function doPrintWorkspace() {
  printErr = "";
  const page = getPageSizeMm();
  if (typeof window === "undefined") return;
  if (!svgEl) { printErr = "SVG غير جاهز"; return; }

  const bb = getWorkspaceContentBBox();
  const vb = bb ? `${bb.x} ${bb.y} ${bb.width} ${bb.height}` : svgEl.getAttribute("viewBox");
  const svgHTML = buildPrintableSvg(vb, "xMidYMid meet");

  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" /><title>Print</title><style>
    @page { size: ${page.w}mm ${page.h}mm; margin: 0; }
    ${printBaseCss()}
    html, body, .wrap { width: 100%; height: 100%; }
  </style></head><body><div class="wrap">${svgHTML}</div></body></html>`;

  const win = window.open("", "_blank");
  if (!win) { printErr = "تعذر فتح نافذة الطباعة (قد يكون Pop-up محجوب)."; return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => { try { win.focus(); win.print(); } catch {} };
  closePrintModal();
}

function doPrintPoster() {
  printErr = "";
  if (typeof window === "undefined") return;
  if (!svgEl) { printErr = "SVG غير جاهز"; return; }

  const info = getPosterGridInfo();
  const pages = [];

  for (let iy = 0; iy < info.pagesY; iy += 1) {
    for (let ix = 0; ix < info.pagesX; ix += 1) {
      const rawX = info.source.x + ix * info.stepX;
      const rawY = info.source.y + iy * info.stepY;
      const maxX = info.source.x + Math.max(0, info.source.w - info.page.w);
      const maxY = info.source.y + Math.max(0, info.source.h - info.page.h);
      const vx = info.pagesX === 1 ? info.source.x : Math.min(rawX, maxX);
      const vy = info.pagesY === 1 ? info.source.y : Math.min(rawY, maxY);
      const vb = `${vx} ${vy} ${info.page.w} ${info.page.h}`;
      pages.push({
        label: getPosterPageLabel(ix, iy),
        svg: buildPrintableSvg(vb, "none")
      });
    }
  }

  const marksHtml = printPosterShowMarks ? `
    <div class="mark tl-h"></div><div class="mark tl-v"></div>
    <div class="mark tr-h"></div><div class="mark tr-v"></div>
    <div class="mark bl-h"></div><div class="mark bl-v"></div>
    <div class="mark br-h"></div><div class="mark br-v"></div>` : "";

  const pagesHtml = pages.map((page) => `
    <section class="posterPage">
      ${printPosterShowPageLabels ? `<div class="pageLabel">${page.label}</div>` : ""}
      ${marksHtml}
      <div class="pageInner">${page.svg}</div>
    </section>
  `).join("\n");


  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" /><title>Poster Print</title><style>
    @page { size: ${info.page.w}mm ${info.page.h}mm; margin: 0; }
    ${printBaseCss()}
    .posterPage { position: relative; width: ${info.page.w}mm; height: ${info.page.h}mm; page-break-after: always; overflow: hidden; }
    .posterPage:last-child { page-break-after: auto; }
    .pageInner { width: 100%; height: 100%; }
    .pageLabel { position:absolute; top:4mm; left:4mm; background:#fff; border:1px solid #111; border-radius:3mm; padding:1.2mm 2.4mm; font-size:12px; font-weight:800; z-index:5; }
    .mark { position:absolute; background:#111; z-index:4; }
    .tl-h, .tr-h, .bl-h, .br-h { width:8mm; height:0.4mm; }
    .tl-v, .tr-v, .bl-v, .br-v { width:0.4mm; height:8mm; }
    .tl-h { top:0; left:0; } .tl-v { top:0; left:0; }
    .tr-h { top:0; right:0; } .tr-v { top:0; right:0; }
    .bl-h { bottom:0; left:0; } .bl-v { bottom:0; left:0; }
    .br-h { bottom:0; right:0; } .br-v { bottom:0; right:0; }
  </style></head><body>${pagesHtml}</body></html>`;

  const win = window.open("", "_blank");
  if (!win) { printErr = "تعذر فتح نافذة الطباعة (قد يكون Pop-up محجوب)."; return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => { try { win.focus(); win.print(); } catch {} };
  closePrintModal();
}

  let personName = "";
  let personRingId = null;
  let personDiameterCm = 2; // default
  let nameErr = "";

  // تبويب إدارة الأسماء: add/edit
  let namesTab = "add";
  let nmRingId = null; // جيل الإضافة داخل تبويب add
  let emRingId = null; // جيل التحرير داخل تبويب edit
  let emSelectedId = null; // الشخص المحدد للتحرير في edit

   // تحديد شخص
  let selectedPersonId = null;
  let selectedPersonIds = [];
  let projectRotationDeg = 0;

  // نوع خط الأسماء
  let fontFamily = localStorage.getItem("tree_font_family") || "Tahoma";

  function handleFontFamilyChange() {
    try {
      localStorage.setItem("tree_font_family", fontFamily);
      saveNow();
    } catch {}
  }

  // ربط الأب -> الابن (يدوي)
  let links = [
    { parentId: "p_1", childId: "p_3", bends: [] },
    { parentId: "p_1", childId: "p_4", bends: [] },
  ];

  // ================================
  // Supabase Online (حساب واحد لكل الأجهزة)
  // ================================
  let authEmail = "";
  let authPassword = "";
  let authUser = null;

  let cloudProjectId = null;
  let cloudStatus = "";

  // الرابط المحدد حاليا (لإظهار وميض أزرق + إضافة تعرجات)
  let selectedLinkKey = null; // مثال: "p_1_p_3"
  $: selectedPersonForEditPanel = people.find((p) => p.id === selectedPersonId) || null;
  $: selectedLinkForEditPanel = findLinkByKey(selectedLinkKey);
  $: selectedLinkParentForEditPanel = selectedLinkForEditPanel ? people.find((p) => p.id === selectedLinkForEditPanel.parentId) || null : null;
  $: selectedLinkChildForEditPanel = selectedLinkForEditPanel ? people.find((p) => p.id === selectedLinkForEditPanel.childId) || null : null;
  $: selectedGroupCountForEditPanel = Array.isArray(selectedPersonIds) ? selectedPersonIds.length : 0;

  // ===== BEGIN: workspace guides + lineage controls =====
  $: selectedLineagePersonIds = getSelectedLineagePersonIds();
  $: selectedLineagePersonIdSet = new Set(selectedLineagePersonIds);
  $: selectedLineageLinkKeys = getSelectedLineageLinkKeys();
  $: selectedLineageLinkKeySet = new Set(selectedLineageLinkKeys);
  $: selectedLineageLabel = getSelectedLineageLabel();
  $: selectedLineageLabelLines = splitLineageLabel(selectedLineageLabel);
  $: isLineageHighlightActive = !!(showLineageTrace && selectedPersonId && selectedLineagePersonIds.length);
  // ===== BEGIN: lineage diagnostics =====
  $: lineageDiagnostics = getLineageDiagnostics(selectedPersonId);
  $: selectedPersonIdSet = new Set(selectedPersonIds || []);
  $: selectedGroupLinkKeys = links
    .filter((l) => selectedPersonIdSet.has(l.parentId) && selectedPersonIdSet.has(l.childId))
    .map((l) => mkLinkKey(l));
  $: selectedGroupLinkKeySet = new Set(selectedGroupLinkKeys);
  // ===== END: lineage diagnostics =====
  // ===== END: workspace guides + lineage controls =====
function openEditRingModal() {
  editRingErr = "";
  showEditRing = true;

  // افتراضي: آخر جيل إن وجد
  if (rings.length) {
    const last = rings[rings.length - 1];
    editRingId = last.id;
    editRingDiameterCm = Number(last.diameterCm) || GUIDE_DIAM_CM;
  } else {
    editRingId = null;
    editRingDiameterCm = GUIDE_DIAM_CM;
    editRingErr = "لا يوجد أجيال لتعديلها.";
  }
}

function cancelEditRing() {
  showEditRing = false;
  editRingErr = "";
}

function applyEditRing() {
  editRingErr = "";
  if (!editRingId) {
    editRingErr = "اختر جيلاً.";
    return;
  }
  const d = Number(editRingDiameterCm);
  if (!Number.isFinite(d) || d <= 0) {
    editRingErr = "أدخل قطر صحيح (cm).";
    return;
  }

  const ring = rings.find((r) => r.id === editRingId);
  if (!ring) {
    editRingErr = "الجيل غير موجود.";
    return;
  }

  ring.diameterCm = Math.round(d * 10) / 10;
  rings = rings.map((x) => x);

  showEditRing = false;
  toast("تم تعديل قطر الجيل");
  try { saveNow(); } catch (e) {}
}

function openAddRingModal() {
  ringErr = "";
  showAddRing = true;

  // اقتراح افتراضي ذكي
  if (rings.length) {
    const last = rings[rings.length - 1];
    newRingDiameterCm = Math.round((Number(last.diameterCm) + 10) * 10) / 10;
  } else {
    newRingDiameterCm = GUIDE_DIAM_CM;
  }
}

function cancelAddRing() {
  showAddRing = false;
  ringErr = "";
}

function confirmAddRing() {
  ringErr = "";
  const d = Number(newRingDiameterCm);

  if (!Number.isFinite(d) || d <= 0) {
    ringErr = "أدخل قطر صحيح (cm).";
    return;
  }

  // إنشاء الجيل
  const id = `r_${Date.now()}`;
  rings = [...rings, { id, diameterCm: Math.round(d * 10) / 10 }];

  showAddRing = false;
  toast("تمت إضافة جيل");
  try { saveNow(); } catch (e) {}
}

  function mkLinkKey(l) {
  // مهم: لا نستخدم "_" لأن ids تحتوي "_" أصلاً، فيخرب split. نستخدم "|" كفاصل آمن.
  return `${l.parentId}|${l.childId}`;
}

function findLinkByKey(key) {
  if (!key) return null;
  const [parentId, childId] = String(key).split("|");
  return links.find((l) => l.parentId === parentId && l.childId === childId) || null;
}

function deleteLink(key) {
  if (!key) return;
  const [parentId, childId] = String(key).split("|");
  links = links.filter((l) => !(l.parentId === parentId && l.childId === childId));
  if (selectedLinkKey === key) selectedLinkKey = null;
  toast("تم حذف الرابط");
  try { saveNow(); } catch (e) {}
}


function deleteSelectedPersonFromPanel() {
  const id = selectedPersonId;
  if (!id) return;

  const person = people.find((x) => x.id === id);
  if (!person || person.locked) return;

  people = people.filter((x) => x.id !== id);
  links = links.filter((l) => l.parentId !== id && l.childId !== id && l.fromId !== id && l.toId !== id);
  selectedPersonIds = selectedPersonIds.filter((x) => x !== id);
  if (selectedPersonId === id) selectedPersonId = selectedPersonIds.length ? selectedPersonIds[selectedPersonIds.length - 1] : null;
  selectedLinkKey = null;

  toast("تم حذف الشخص");
  try { saveNow(); } catch {}
}

function toggleSelectedPersonHighlightFromPanel() {
  const id = selectedPersonId;
  if (!id) return;
  const idx = people.findIndex((x) => x.id === id);
  if (idx === -1) return;

  people = people.map((person, i) =>
    i === idx ? { ...person, highlightRing: !person.highlightRing } : person
  );

  toast(people[idx]?.highlightRing ? "تم إلغاء التمييز" : "تم تمييز الشخص");
  try { saveNow(); } catch {}
}

function resetSelectedLinkBendsFromPanel() {
  if (!selectedLinkKey) return;
  const link = findLinkByKey(selectedLinkKey);
  if (!link) return;

  links = links.map((item) => {
    const key = mkLinkKey(item);
    if (key !== selectedLinkKey) return item;
    return { ...item, bends: [] };
  });
  selectedBend = null;
  toast("تم تصفير تعرجات الرابط");
  try { saveNow(); } catch {}
}

  // وضع الربط
  let linkMode = false;
  let linkParentId = null;

  // إدارة تعرجات الرابط
  let draggingBend = null; // { key, idx } أثناء سحب تعرّج
  let selectedBend = null; // { key, idx } للنقطة المحددة (للحذف بـ Delete)

  // Toast بسيط
  let toastMsg = "";
  let toastTimer = null;

  function toast(msg) {
    toastMsg = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastMsg = "";
    }, 1800);
  }

  // ================================
  // E) أدوات مساعدة هندسية ووحدات القياس
  // ================================
  // هذا القسم يحول بين cm و mm ويحتوي حسابات القيود والمسافات.
  function cmToMm(cm) {
    return Number(cm) * 10;
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function degToRad(deg) {
    return (Number(deg) * Math.PI) / 180;
  }

  function rotatePointAround(x, y, cx, cy, deg) {
    const rad = degToRad(deg);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = x - cx;
    const dy = y - cy;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    };
  }
  // ================================
  // قيد حركة الشخص داخل نطاق جيله (بين الجيل السابق ونصف الجيل الحالي)
  // القاعدة: يسمح للدائرة أن تدخل خط الجيل حتى منتصفها فقط.
  // ================================
  function ringRadiusMmById(ringId) {
    const r = rings.find((x) => x.id === ringId);
    const diamCm = r ? Number(r.diameterCm) : GUIDE_DIAM_CM;
    return cmToMm(diamCm) / 2;
  }

  function prevRingRadiusMmById(ringId) {
    const idx = rings.findIndex((x) => x.id === ringId);
    if (idx <= 0) return 0;
    const prev = rings[idx - 1];
    return cmToMm(Number(prev.diameterCm)) / 2;
  }

  function constrainPointToRingBand(ringId, personRadiusMm, x, y) {
    const innerBase = prevRingRadiusMmById(ringId);
    const outerBase = ringRadiusMmById(ringId);

    // السماح بالتقاطع حتى نصف دائرة الشخص
    const inner = Math.max(0, innerBase + personRadiusMm / 2);
    const outer = Math.max(0, outerBase - personRadiusMm / 2);

    // لو النطاق غير صالح (مثلاً دوائر صغيرة جداً) نرجع النقطة كما هي
    if (!(outer > inner)) return { x, y };

    const dx = x - CX;
    const dy = y - CY;
    const dist = Math.hypot(dx, dy) || 0.000001;

    const cd = clamp(dist, inner, outer);
    const k = cd / dist;

    return { x: CX + dx * k, y: CY + dy * k };
  }

  function personFontPx(diameterCm, name) {
  const n = (name || "").trim();
  // تصغير عام حتى لا يلمس الحافة
  let base = clamp(Math.round((diameterCm * 10) / 3), 8, 18);

  // إذا النص طويل، ننزل أكثر
  if (n.length > 14) base = Math.max(6, base - 4);
  else if (n.length > 10) base = Math.max(6, base - 2);

  return base;
}

  function clientToSvgPoint(clientX, clientY) {
    if (!svgEl) return { x: CX, y: CY };
    const rect = svgEl.getBoundingClientRect();

    const svgW = rect.width || 1;
    const svgH = rect.height || 1;

    // نحول من إحداثيات الشاشة إلى إحداثيات الكاميرا (viewBox) الحالية
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const x = view.x + (mx / svgW) * view.w;
    const y = view.y + (my / svgH) * view.h;

    return { x, y };
  }

  function clientToLogicalSvgPoint(clientX, clientY) {
    const pt = clientToSvgPoint(clientX, clientY);
    return rotatePointAround(pt.x, pt.y, CX, CY, -projectRotationDeg);
  }

  function findSafeGroupDelta(selectedPeople, peopleStartMap, dx, dy) {
    const factors = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];

    for (const f of factors) {
      const testDx = dx * f;
      const testDy = dy * f;
      let ok = true;

      for (const p of selectedPeople) {
        const start = peopleStartMap.get(p.id);
        if (!start) continue;
        const radiusMm = cmToMm(p.diameterCm || PERSON_DIAM_MAX_CM) / 2;
        const constrained = constrainPointToRingBand(p.ringId, radiusMm, start.x + testDx, start.y + testDy);
        const diffX = Math.abs(constrained.x - (start.x + testDx));
        const diffY = Math.abs(constrained.y - (start.y + testDy));
        if (diffX > 0.01 || diffY > 0.01) {
          ok = false;
          break;
        }
      }

      if (ok) return { dx: testDx, dy: testDy };
    }

    return { dx: 0, dy: 0 };
  }

  // ================================
  // F) أدوات الالتقاط وتحديد المواقع داخل اللوحة
  // ================================
  // تُستخدم لمعرفة الشخص تحت المؤشر، وتحديد الجيل المناسب، وحساب أماكن الإضافة.
  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function findPersonAtPoint(pt) {
    // pt in workspace mm
    // نبحث من الأعلى (آخر عنصر) حتى تكون الدوائر المضافة مؤخرًا هي الأعلى في الالتقاط
    for (let i = people.length - 1; i >= 0; i--) {
      const p = people[i];
      const rMm = (cmToMm(p.diameterCm) / 2);
      if (dist2(pt, { x: p.x, y: p.y }) <= rMm * rMm) return p;
    }
    return null;
  }

  function pickRingIdForPoint(pt) {
    if (!rings.length) return null;
    const d = Math.sqrt(dist2(pt, { x: CX, y: CY })); // distance from center in mm
    // اختر أقرب حلقة (بالنسبة لنصف القطر) لكن ضمن الحدود: إذا خارج أكبر حلقة خذ الأخيرة
    let best = rings[rings.length - 1];
    let bestScore = Infinity;
    for (const r of rings) {
      const radiusMm = cmToMm(r.diameterCm) / 2;
      const score = Math.abs(d - radiusMm);
      if (score < bestScore) {
        best = r;
        bestScore = score;
      }
    }
    return best?.id ?? null;
  }

  // ================================

  function getMarkerHalfWidth(marker) {
    return Math.max(5, Number(marker?.widthMm) || 22) / 2;
  }

  function getMarkerHalfHeight(marker) {
    return Math.max(3, Number(marker?.heightMm) || 10) / 2;
  }

  function getMarkerLabel(marker) {
    return getGenerationNumberForRing(marker?.ringId);
  }

  // ================================
  // G) التحكم بالتفاعل: سحب / إفلات / تحريك / Pan
  // ================================
  // هذا القسم مسؤول عن حركة الماوس والتعامل مع الأشخاص والروابط أثناء السحب.
  let draggingPersonId = null;
  let dragOffset = { dx: 0, dy: 0 };
  let draggingSelection = null;
  let draggingMarkerId = null;
  let markerDragOffset = { dx: 0, dy: 0 };

  function cancelLinking() {
    linkMode = false;
    linkParentId = null;
  }

  function onBoardPointerDown(e) {
    // ضغط على الخلفية: إلغاء اختيار شخص + إلغاء اختيار رابط
    // لكن إذا في وضع ربط: نسمح بالبقاء
    if (e.altKey) {
      // Alt يستخدم في إضافة bend على رابط (من خلال اختيار رابط أولاً) أو لأوامر أخرى
      return;
    }

    // بدء Pan فقط إذا كان الضغط على الفراغ (خلفية اللوحة)
    const t = e.target;
    const isEmptyBoard =
      t === e.currentTarget ||
      (t && t.classList && t.classList.contains("boardBg"));

    if (e.button === 0 && isEmptyBoard) {
      startPan(e);
    }

    // إذا النقر كان على عنصر داخلي وتوقف propagation، لن نصل هنا أصلاً
    if (!linkMode) {
      selectedPersonId = null;
      selectedPersonIds = [];
      selectedMarkerId = null;
      selectedLinkKey = null;
    }
    cancelLinking();
  }

  function onBoardDblClick(e) {
    // دبل كلك على الفراغ = إضافة شخص جديد
    // ملاحظة: عناصر الأشخاص/الروابط توقف الانتشار لمنع الإضافة فوقها
    if (linkMode) return;
    if (draggingPersonId) return;
    if (draggingMarkerId) return;
    if (draggingBend) return;

    const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);

    // أمان إضافي: إذا كان هناك شخص تحت النقطة لا نضيف
    const hitP = findPersonAtPoint(pt);
    if (hitP) return;

    addPersonAtPoint(pt);
  }

  function onPersonPointerDown(e, p) {
    e.stopPropagation();

    const isMultiToggle = !!(e.ctrlKey || e.shiftKey);
    if (isMultiToggle) {
      if (selectedPersonIdSet.has(p.id)) {
        selectedPersonIds = selectedPersonIds.filter((id) => id !== p.id);
        selectedPersonId = selectedPersonIds.length ? selectedPersonIds[selectedPersonIds.length - 1] : null;
      } else {
        selectedPersonIds = [...selectedPersonIds, p.id];
        selectedPersonId = p.id;
      }
      selectedLinkKey = null;
      selectedMarkerId = null;
      ensureLineageTraceOnPersonSelect();
      return;
    }

    selectedPersonId = p.id;
    if (!selectedPersonIdSet.has(p.id) || selectedPersonIds.length <= 1) {
      selectedPersonIds = [p.id];
    }
    selectedLinkKey = null;
    selectedMarkerId = null;
    ensureLineageTraceOnPersonSelect();

    if (linkMode) {
      if (!linkParentId) {
        linkParentId = p.id;
        toast("اختر الابن الآن");
        return;
      }
      if (linkParentId === p.id) {
        toast("لا يمكن ربط الشخص بنفسه");
        return;
      }
      const exists = links.some((l) => l.parentId === linkParentId && l.childId === p.id);
      if (!exists) {
        links = [...links, { parentId: linkParentId, childId: p.id, bends: [] }];
        selectedLinkKey = `${linkParentId}|${p.id}`;
        toast("تم إنشاء الرابط");
        try { saveNow(); } catch (e) {}
      } else {
        selectedLinkKey = `${linkParentId}|${p.id}`;
        toast("الرابط موجود مسبقاً");
      }
      cancelLinking();
      return;
    }

    const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);

    if (selectedPersonIds.length > 1 && selectedPersonIdSet.has(p.id)) {
      const peopleStartMap = new Map();
      for (const person of people) {
        if (selectedPersonIdSet.has(person.id)) {
          peopleStartMap.set(person.id, { x: person.x, y: person.y, ringId: person.ringId, diameterCm: person.diameterCm });
        }
      }
      const internalLinkBendsStart = new Map();
      for (const l of links) {
        if (selectedPersonIdSet.has(l.parentId) && selectedPersonIdSet.has(l.childId)) {
          internalLinkBendsStart.set(mkLinkKey(l), (Array.isArray(l.bends) ? l.bends : []).map((b) => ({ x: b.x, y: b.y })));
        }
      }
      draggingSelection = {
        pointerStart: { x: pt.x, y: pt.y },
        peopleStartMap,
        internalLinkBendsStart,
      };
    } else {
      draggingPersonId = p.id;
      dragOffset.dx = p.x - pt.x;
      dragOffset.dy = p.y - pt.y;
    }

    try {
      svgEl.setPointerCapture(e.pointerId);
    } catch (e) {}
  }


  function onMarkerPointerDown(e, marker) {
    e.stopPropagation();
    selectedMarkerId = marker.id;
    selectedPersonId = null;
    selectedPersonIds = [];
    selectedLinkKey = null;

    const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);
    draggingMarkerId = marker.id;
    markerDragOffset.dx = (Number(marker.x) || CX) - pt.x;
    markerDragOffset.dy = (Number(marker.y) || CY) - pt.y;

    try {
      svgEl.setPointerCapture(e.pointerId);
    } catch (e) {}
  }

  function onPersonPointerMove(e) {
    // Pan (تحريك مساحة العمل) أولوية أعلى من السحب الأخرى
    if (isPanning) {
      const handled = updatePan(e);
      if (handled) return;
    }

    // سحب نقطة تعرّج للرابط المحدد
    if (draggingBend) {
      const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);
      const link = findLinkByKey(draggingBend.key);
      if (!link) return;
      if (!Array.isArray(link.bends)) link.bends = [];
      const idx = draggingBend.idx;
      if (idx < 0 || idx >= link.bends.length) return;
      link.bends[idx] = { x: pt.x, y: pt.y };
      links = links.map((x) => x);
      return;
    }

    // سحب مجموعة محددة
    if (draggingSelection) {
      const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);
      const dx = pt.x - draggingSelection.pointerStart.x;
      const dy = pt.y - draggingSelection.pointerStart.y;

      const selectedPeople = people.filter((person) => selectedPersonIdSet.has(person.id));
      const safe = findSafeGroupDelta(selectedPeople, draggingSelection.peopleStartMap, dx, dy);
      const finalDx = safe.dx;
      const finalDy = safe.dy;

      people = people.map((person) => {
        if (!selectedPersonIdSet.has(person.id)) return person;
        const start = draggingSelection.peopleStartMap.get(person.id);
        if (!start) return person;
        return { ...person, x: start.x + finalDx, y: start.y + finalDy };
      });

      links = links.map((link) => {
        const key = mkLinkKey(link);
        const startBends = draggingSelection.internalLinkBendsStart.get(key);
        if (!startBends) return link;
        return {
          ...link,
          bends: startBends.map((b) => ({ x: b.x + finalDx, y: b.y + finalDy })),
        };
      });
      return;
    }

    // سحب رقم الجيل
    if (draggingMarkerId) {
      const marker = generationMarkers.find((x) => x.id === draggingMarkerId);
      if (!marker) return;

      const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);
      const halfW = getMarkerHalfWidth(marker);
      const halfH = getMarkerHalfHeight(marker);

      const x = clamp(pt.x + markerDragOffset.dx, halfW, WORKSPACE_MM - halfW);
      const y = clamp(pt.y + markerDragOffset.dy, halfH, WORKSPACE_MM - halfH);

      generationMarkers = generationMarkers.map((m) => (m.id === draggingMarkerId ? { ...m, x, y } : m));
      return;
    }

    // سحب شخص
    if (!draggingPersonId) return;
    const p = people.find((x) => x.id === draggingPersonId);
    if (!p) return;

    const pt = clientToLogicalSvgPoint(e.clientX, e.clientY);
    const nx = pt.x + dragOffset.dx;
    const ny = pt.y + dragOffset.dy;

    // أولاً: قيد ضمن مساحة العمل
    let x = clamp(nx, 0, WORKSPACE_MM);
    let y = clamp(ny, 0, WORKSPACE_MM);

    // ثانياً: قيد ضمن نطاق الجيل (بين السابق والحالي مع سماح نصف الدائرة)
    const personRadiusMm = cmToMm(Number(p.diameterCm) || 2) / 2;
    const c = constrainPointToRingBand(p.ringId, personRadiusMm, x, y);
    x = c.x;
    y = c.y;

    p.x = x;
    p.y = y;
    people = people.map((x) => x);
  }

  function onPersonPointerUp(e) {
    // إنهاء Pan إذا كان مفعّل
    if (endPan(e)) return;

    if (draggingBend) {
      draggingBend = null;
      try { saveNow(); } catch (e) {}
      return;
    }

    if (draggingSelection) {
      draggingSelection = null;
      try { saveNow(); } catch (e) {}
      return;
    }

    if (draggingMarkerId) {
      draggingMarkerId = null;
      try { saveNow(); } catch (e) {}
      return;
    }

    if (!draggingPersonId) return;
    draggingPersonId = null;
    try { saveNow(); } catch (e) {}
  }

  function onBendPointerDown(e, key, idx) {
    e.stopPropagation();
    selectedLinkKey = key;
    selectedPersonId = null;
    selectedPersonIds = [];
    selectedPersonIds = [];
    selectedBend = { key, idx };
    draggingBend = { key, idx };
    try {
      svgEl.setPointerCapture(e.pointerId);
    } catch (e) {}
  }

  // ================================
  // H) أوامر التعديل على البيانات
  // ================================
  // إضافة / حذف / تعديل الأجيال والأشخاص والروابط يتم هنا.
  function addRing() {
    const id = `r_${Date.now()}`;
    const last = rings[rings.length - 1];
    const nextDiam = last ? Math.round((Number(last.diameterCm) + 10) * 10) / 10 : GUIDE_DIAM_CM;
    rings = [...rings, { id, diameterCm: nextDiam }];
    toast("تمت إضافة جيل");
    try { saveNow(); } catch (e) {}
  }

  function updateLastRingDiameter(v) {
    if (!rings.length) return;
    const last = rings[rings.length - 1];
    last.diameterCm = Math.round(Number(v) * 10) / 10;
    rings = rings.map((x) => x);
    try { saveNow(); } catch (e) {}
  }

  function deleteLastRing() {
    if (!rings.length) return;
    const last = rings[rings.length - 1];

    // لا نحذف جيل إذا عليه أشخاص
    const hasPeople = people.some((p) => p.ringId === last.id);
    if (hasPeople) {
      toast("لا يمكن حذف آخر جيل لأن عليه أشخاص");
      return;
    }

    const nextMarkers = generationMarkers.filter((m) => m.ringId !== last.id);
    generationMarkers = nextMarkers;
    if (selectedMarkerId && !nextMarkers.some((m) => m.id === selectedMarkerId)) selectedMarkerId = null;
    rings = rings.slice(0, -1);
    toast("تم حذف آخر جيل");
    try { saveNow(); } catch (e) {}
  }

  function addPerson() {
    nameErr = "";

    if (!personRingId) {
      nameErr = "اختر جيلاً أولاً.";
      return;
    }

    const n = String(personName || "").trim();
    if (!n) {
      nameErr = "الرجاء كتابة الاسم.";
      return;
    }

    const d = Number(personDiameterCm);
    if (!Number.isFinite(d) || d <= 0) {
      nameErr = "الرجاء إدخال قطر صحيح لدائرة الشخص (cm).";
      return;
    }
    if (d > PERSON_DIAM_MAX_CM) {
      nameErr = `الحد الأقصى لقطر دائرة الشخص هو ${PERSON_DIAM_MAX_CM}cm.`;
      return;
    }

    // الإضافة في مركز مساحة العمل (مؤقتًا)
    const id = `p_${Date.now()}`;
    people = [
      ...people,
      {
        id,
        ringId: personRingId,
        name: n,
        diameterCm: Math.round(d * 10) / 10,
        strokeMm: 1,
        fontPx: personFontPx(Math.round(d * 10) / 10, n),
        x: CX,
        y: CY,
      },
    ];

    // تبقى الواجهة مرتبة
    personName = "";
    selectedPersonId = id;
    // ===== BEGIN: lineage display controls =====
    ensureLineageTraceOnPersonSelect();
    // ===== END: lineage display controls =====
    namesTab = "edit";
    emRingId = personRingId;
    emSelectedId = id;

    toast("تمت إضافة شخص");
    try { saveNow(); } catch (e) {}
  }

  function addPersonAtPoint(pt) {
    // إضافة شخص جديد بالدبل كلك على الفراغ
    if (!rings.length) {
      toast("أضف جيلاً أولاً ثم أضف الأشخاص.");
      return;
    }

    const ringId = pickRingIdForPoint(pt);
    if (!ringId) {
      toast("تعذر تحديد الجيل المناسب.");
      return;
    }

    const d = Number(personDiameterCm) || 2;
    const safeD = Math.min(Math.max(0.5, d), PERSON_DIAM_MAX_CM);

    // اسم افتراضي قابل للتعديل لاحقاً
    const n = `شخص جديد ${people.length + 1}`;

    const id = `p_${Date.now()}`;
    const person = {
      id,
      ringId,
      name: n,
      diameterCm: Math.round(safeD * 10) / 10,
      strokeMm: 1,
      fontPx: personFontPx(Math.round(safeD * 10) / 10, n),
      x: pt.x,
      y: pt.y,
    };

    // قيد مكان الإضافة ضمن مساحة العمل + نطاق الجيل
    person.x = clamp(person.x, 0, WORKSPACE_MM);
    person.y = clamp(person.y, 0, WORKSPACE_MM);
    {
      const pr = cmToMm(Number(person.diameterCm) || 2) / 2;
      const c = constrainPointToRingBand(ringId, pr, person.x, person.y);
      person.x = c.x;
      person.y = c.y;
    }

    people = [...people, person];

    // تحديده + فتح تبويب التعديل مباشرة
    selectedPersonId = id;
    // ===== BEGIN: lineage display controls =====
    ensureLineageTraceOnPersonSelect();
    // ===== END: lineage display controls =====
    namesTab = "edit";
    emRingId = ringId;
    emSelectedId = id;

    try { saveNow(); } catch (e) {}
  }

  function deletePerson(id) {
    people = people.filter((p) => p.id !== id);
    // حذف الروابط المرتبطة
    links = links.filter((l) => l.parentId !== id && l.childId !== id);
    if (selectedPersonId === id) selectedPersonId = null;
    if (emSelectedId === id) emSelectedId = null;
    toast("تم حذف الشخص");
    try { saveNow(); } catch (e) {}
  }

  function toggleLinkMode() {
    linkMode = !linkMode;
    linkParentId = null;
    toast(linkMode ? "وضع الربط: اختر الأب ثم الابن" : "تم إيقاف وضع الربط");
  }

  function addBendToSelectedLinkAtPoint(pt) {
    if (!selectedLinkKey) {
      toast("اختر رابطاً أولاً");
      return;
    }
    const link = findLinkByKey(selectedLinkKey);
    if (!link) return;
    if (!Array.isArray(link.bends)) link.bends = [];
    link.bends.push({ x: pt.x, y: pt.y });
    links = links.map((x) => x);
    toast("تمت إضافة تعرّج");
    try { saveNow(); } catch (e) {}
  }

  function removeBend(key, idx) {
    const link = findLinkByKey(key);
    if (!link) return;
    if (!Array.isArray(link.bends)) link.bends = [];
    if (idx < 0 || idx >= link.bends.length) return;
    link.bends.splice(idx, 1);
    links = links.map((x) => x);
    try { saveNow(); } catch (e) {}
  }

  function setZoom(v) {
    const z = clamp(Number(v) || 1, 0.5, 3);
    zoom = z;
    zoomInput = z;
    // نترجم الزوم إلى كاميرا viewBox (مع الحفاظ على مركز الرؤية)
    syncViewFromZoom(true);
  }

  // ================================
  // I) أوامر الواجهة (مودالات / تبويبات / فتح وإغلاق النوافذ)
  // ================================
  function openAddName() {
    showAddName = true;
    nameErr = "";
    // افتراضيًا: آخر جيل
    personRingId = rings.length ? rings[rings.length - 1].id : null;
  }

  function closeAddName() {
    showAddName = false;
    nameErr = "";
  }

  function goToEditTab() {
    namesTab = "edit";
    // افتراضيًا: نفس جيل الإضافة إن كان محددًا، وإلا آخر جيل
    if (nmRingId) emRingId = nmRingId;
    else if (rings.length) emRingId = rings[rings.length - 1].id;
    else emRingId = null;

    emSelectedId = null;
  }

  // ================================
  // J) الحفظ والتحميل (Snapshot / Persistence)
  // ================================
  function getGuideLayerSnapshot() {
    return {
      enabled: showWorkspaceGuides,
      panelOpen: showGuidePanel,
      editPanelOpen: showEditPanel,
      drawPanelOpen: showDrawPanel,
      viewPanelOpen: showViewPanel,
      projectPanelOpen: showProjectPanel,
      sections: {
        frame: guideFrameOpen,
        grid: guideGridOpen,
        appearance: guideAppearanceOpen,
      },
      frame: {
        outerCircleColor: outerGuideColor,
        divisionColor: divisionGuideColor,
        divisionCount: Number(divisionCount) || 0,
      },
      grid: {
        minorColor: workspaceGuideMinorColor,
        majorColor: workspaceGuideMajorColor,
      },
      appearance: {
        light: true,
        strokeWidth: guideStrokeWidth,
      },
    };
  }

  function applyGuideLayerSnapshot(guide) {
    if (!guide || typeof guide !== "object") return;

    if (typeof guide.enabled === "boolean") showWorkspaceGuides = guide.enabled;
    if (typeof guide.panelOpen === "boolean") showGuidePanel = guide.panelOpen;
    if (typeof guide.editPanelOpen === "boolean") showEditPanel = guide.editPanelOpen;
    if (typeof guide.drawPanelOpen === "boolean") showDrawPanel = guide.drawPanelOpen;
    if (typeof guide.viewPanelOpen === "boolean") showViewPanel = guide.viewPanelOpen;
    if (typeof guide.projectPanelOpen === "boolean") showProjectPanel = guide.projectPanelOpen;

    if (guide.sections && typeof guide.sections === "object") {
      if (typeof guide.sections.frame === "boolean") guideFrameOpen = guide.sections.frame;
      if (typeof guide.sections.grid === "boolean") guideGridOpen = guide.sections.grid;
      if (typeof guide.sections.appearance === "boolean") guideAppearanceOpen = guide.sections.appearance;
    }

    if (guide.frame && typeof guide.frame === "object") {
      if (typeof guide.frame.outerCircleColor === "string" && guide.frame.outerCircleColor) outerGuideColor = guide.frame.outerCircleColor;
      if (typeof guide.frame.divisionColor === "string" && guide.frame.divisionColor) divisionGuideColor = guide.frame.divisionColor;
      if (Number.isFinite(Number(guide.frame.divisionCount))) divisionCount = Math.max(0, Number(guide.frame.divisionCount));
    }

    if (guide.grid && typeof guide.grid === "object") {
      if (typeof guide.grid.minorColor === "string" && guide.grid.minorColor) workspaceGuideMinorColor = guide.grid.minorColor;
      if (typeof guide.grid.majorColor === "string" && guide.grid.majorColor) workspaceGuideMajorColor = guide.grid.majorColor;
    }

    if (guide.appearance && typeof guide.appearance === "object") {
      if (Number.isFinite(Number(guide.appearance.strokeWidth))) {
        guideStrokeWidth = Math.max(0.1, Math.min(5, Number(guide.appearance.strokeWidth)));
      }
    }
  }

  function toggleGuidePanel() {
    showGuidePanel = !showGuidePanel;
    showViewPanel = true;
    saveNow();
  }

  function toggleDrawPanel() {
    showDrawPanel = !showDrawPanel;
    saveNow();
  }


  function toggleEditPanel() {
    showEditPanel = !showEditPanel;
    saveNow();
  }

  function toggleViewPanel() {
    showViewPanel = !showViewPanel;
    saveNow();
  }

  function toggleProjectPanel() {
    showProjectPanel = !showProjectPanel;
    saveNow();
  }

  function resetGuideLayerDefaults() {
    showWorkspaceGuides = true;
    showGuidePanel = true;
    guideFrameOpen = true;
    guideGridOpen = true;
    guideAppearanceOpen = true;
    workspaceGuideMinorColor = "#94a3b8";
    workspaceGuideMajorColor = "#334155";
    outerGuideColor = "#dc2626";
    divisionGuideColor = "#dc2626";
    divisionCount = 0;
    guideStrokeWidth = 0.5;
    saveNow();
    toast("تمت إعادة ضبط طبقة الإرشاد");
  }

  // هذا القسم يبني نسخة الحفظ، يطبق الحفظ على الواجهة،
  // ويعالج ترحيل المشاريع القديمة من مساحة 90cm إلى 150cm.
  function buildSnapshot() {
    return {
      workspaceCm: WORKSPACE_CM,
      v: 1,
      rings,
      people,
      generationMarkers,
      baseGenerationNumber,
      links: links.map((l) => ({ ...l, bends: Array.isArray(l.bends) ? l.bends : [] })),
      zoom,
      projectRotationDeg,
      selectedPersonId,
      selectedPersonIds,
      selectedMarkerId,
      selectedLinkKey,
      namesTab,
      nmRingId,
      emRingId,
      emSelectedId,
           personDiameterCm,
      fontFamily,
      guideLayer: getGuideLayerSnapshot(),
      // ===== BEGIN: workspace guides + lineage controls =====
      showWorkspaceGuides,
      showLineageTrace,
      lineageTraceMode,
      showLineageDiagnostics,
      workspaceGuideMinorColor,
      workspaceGuideMajorColor,
      outerGuideColor,
      divisionGuideColor,
      divisionCount,
      
      guideStrokeWidth,
      globalLinkStrokeWidth,
      globalPersonStrokeWidth,
      // ===== END: guide thickness controls =====
      // ===== BEGIN: lineage visual enhancement =====
      // ===== END: lineage visual enhancement =====
      // ===== END: workspace guides + lineage controls =====
    };
  }

  // =====================================================
  // Migration: نقل إحداثيات المشاريع القديمة عند تغيير مساحة العمل
  // =====================================================
  // --------------------------------
  // ترحيل المشاريع القديمة من مساحة 90cm إلى مساحة 150cm
  // --------------------------------
  // إذا كان الحفظ قديماً ولا يحمل workspaceCm الحالي، ننقل الإحداثيات مرة واحدة فقط.
  function migrateSnapshotToWorkspace(snap) {
    if (!snap || typeof snap !== "object") return snap;

    const oldCm = typeof snap.workspaceCm === "number" ? snap.workspaceCm : 90;

    // إذا كان المشروع أصلاً على نفس المساحة فلا نلمس الإحداثيات
    if (oldCm === WORKSPACE_CM) {
      return snap;
    }

    const delta = ((WORKSPACE_CM - oldCm) * 10) / 2; // mm shift of center

    const copy = JSON.parse(JSON.stringify(snap));

    if (Array.isArray(copy.people)) {
      copy.people = copy.people.map((p) => ({
        ...p,
        x: typeof p.x === "number" ? p.x + delta : p.x,
        y: typeof p.y === "number" ? p.y + delta : p.y,
      }));
    }

    if (Array.isArray(copy.generationMarkers)) {
      copy.generationMarkers = copy.generationMarkers.map((m) => ({
        ...m,
        x: typeof m.x === "number" ? m.x + delta : m.x,
        y: typeof m.y === "number" ? m.y + delta : m.y,
        rotationDeg: Number.isFinite(Number(m?.rotationDeg)) ? Number(m.rotationDeg) : 0,
        textFollowRotation: Boolean(m?.textFollowRotation),
      }));
    }

    if (Array.isArray(copy.links)) {
      copy.links = copy.links.map((l) => {
        const next = { ...l };

        // bends نقاط تعرج الروابط
        if (Array.isArray(next.bends)) {
          next.bends = next.bends.map((pt) => ({
            ...pt,
            x: typeof pt.x === "number" ? pt.x + delta : pt.x,
            y: typeof pt.y === "number" ? pt.y + delta : pt.y,
          }));
        }

        // points إن كانت موجودة (خطوط/مسارات)
        if (Array.isArray(next.points)) {
          next.points = next.points.map((pt) => ({
            ...pt,
            x: typeof pt.x === "number" ? pt.x + delta : pt.x,
            y: typeof pt.y === "number" ? pt.y + delta : pt.y,
          }));
        }

        // boundary إن كانت موجودة
        if (next.boundary && typeof next.boundary === "object") {
          next.boundary = {
            ...next.boundary,
            x: typeof next.boundary.x === "number" ? next.boundary.x + delta : next.boundary.x,
            y: typeof next.boundary.y === "number" ? next.boundary.y + delta : next.boundary.y,
          };
        }

        return next;
      });
    }

    // مهم: منع تكرار الترحيل
    copy.workspaceCm = WORKSPACE_CM;

    return copy;
  }


  // تطبيق Snapshot على الواجهة الحالية
  // نستخدمها في التحميل المحلي، المشاريع، والسحابة.
  function applySnapshot(snap) {
    if (!snap || typeof snap !== "object") return false;
    snap = migrateSnapshotToWorkspace(snap);
    try {
      if (Array.isArray(snap.rings)) rings = snap.rings;
      if (Array.isArray(snap.people)) people = snap.people;
      if (Array.isArray(snap.generationMarkers)) generationMarkers = snap.generationMarkers;
      else generationMarkers = [];
      if (typeof snap.baseGenerationNumber === "number") baseGenerationNumber = Math.max(0, Math.round(snap.baseGenerationNumber));
      else baseGenerationNumber = 1;
      if (Array.isArray(snap.links)) links = snap.links.map((l) => ({ ...l, bends: Array.isArray(l.bends) ? l.bends : [] }));

      if (typeof snap.zoom === "number") {
        zoom = snap.zoom;
        zoomInput = snap.zoom;
        syncViewFromZoom(false);
      }

      if (typeof snap.projectRotationDeg === "number") projectRotationDeg = snap.projectRotationDeg;
      else projectRotationDeg = 0;

      if (typeof snap.selectedPersonId === "string" || snap.selectedPersonId === null) selectedPersonId = snap.selectedPersonId;
      if (Array.isArray(snap.selectedPersonIds)) selectedPersonIds = snap.selectedPersonIds.filter((id) => typeof id === "string");
      else selectedPersonIds = selectedPersonId ? [selectedPersonId] : [];
      if (typeof snap.selectedMarkerId === "string" || snap.selectedMarkerId === null) selectedMarkerId = snap.selectedMarkerId;
      else selectedMarkerId = null;
      if (typeof snap.selectedLinkKey === "string" || snap.selectedLinkKey === null) selectedLinkKey = snap.selectedLinkKey;

      if (snap.namesTab === "add" || snap.namesTab === "edit") namesTab = snap.namesTab;

      if (typeof snap.nmRingId === "string" || snap.nmRingId === null) nmRingId = snap.nmRingId;
      if (typeof snap.emRingId === "string" || snap.emRingId === null) emRingId = snap.emRingId;
      if (typeof snap.emSelectedId === "string" || snap.emSelectedId === null) emSelectedId = snap.emSelectedId;

      if (typeof snap.personDiameterCm === "number") personDiameterCm = snap.personDiameterCm;
            if (typeof snap.fontFamily === "string" && snap.fontFamily) fontFamily = snap.fontFamily;
      applyGuideLayerSnapshot(snap.guideLayer);
      // ===== BEGIN: workspace guides + lineage controls =====
      if (typeof snap.showWorkspaceGuides === "boolean") showWorkspaceGuides = snap.showWorkspaceGuides;
      if (typeof snap.showLineageTrace === "boolean") showLineageTrace = snap.showLineageTrace;
      else showLineageTrace = true;
      if (snap.lineageTraceMode === "ancestors" || snap.lineageTraceMode === "descendants") lineageTraceMode = snap.lineageTraceMode;
      else lineageTraceMode = "ancestors";
      if (typeof snap.showLineageDiagnostics === "boolean") showLineageDiagnostics = snap.showLineageDiagnostics;
      if (typeof snap.workspaceGuideMinorColor === "string" && snap.workspaceGuideMinorColor) workspaceGuideMinorColor = snap.workspaceGuideMinorColor;
      if (typeof snap.workspaceGuideMajorColor === "string" && snap.workspaceGuideMajorColor) workspaceGuideMajorColor = snap.workspaceGuideMajorColor;
      if (typeof snap.outerGuideColor === "string" && snap.outerGuideColor) outerGuideColor = snap.outerGuideColor;
      if (typeof snap.divisionGuideColor === "string" && snap.divisionGuideColor) divisionGuideColor = snap.divisionGuideColor;
      if (Number.isFinite(Number(snap.divisionCount))) divisionCount = Math.max(0, Number(snap.divisionCount));
      // ===== BEGIN: guide thickness controls =====
      if (typeof snap.guideStrokeWidth === "number") {
        guideStrokeWidth = Math.max(0.1, Math.min(5, snap.guideStrokeWidth));
      } 
	if (typeof snap.globalLinkStrokeWidth === "number") {
 	 globalLinkStrokeWidth = Math.max(0.1, Math.min(10, snap.globalLinkStrokeWidth));
	}
	if (typeof snap.globalPersonStrokeWidth === "number") {
 	 globalPersonStrokeWidth = Math.max(0.1, Math.min(10, snap.globalPersonStrokeWidth));
	}
	else if (typeof snap.guideCircleStrokeWidth === "number") {
        guideStrokeWidth = Math.max(0.1, Math.min(5, snap.guideCircleStrokeWidth));
      } else if (typeof snap.guideDivisionStrokeWidth === "number") {
        guideStrokeWidth = Math.max(0.1, Math.min(5, snap.guideDivisionStrokeWidth));
      }

      // ===== END: guide thickness controls =====
      // ===== BEGIN: lineage visual enhancement =====
      // ===== END: lineage visual enhancement =====
      // ===== END: workspace guides + lineage controls =====

      return true;
    } catch {
      return false;
    }
  }

  // ================================
  // K) السحابة: تسجيل الدخول / التحميل / الحفظ
  // ================================
  // هنا يتم ربط المشروع بـ Supabase وتحميل/حفظ التصميم من قاعدة البيانات.
  async function cloudLogin() {
    cloudStatus = "جاري تسجيل الدخول...";
    const { data, error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    });
    if (error) {
      cloudStatus = "فشل تسجيل الدخول: " + error.message;
      return;
    }
    authUser = data.user;
    cloudStatus = "تم تسجيل الدخول ✓";
    await cloudLoadOrCreate();
  }

  async function cloudLogout() {
    try {
      await supabase.auth.signOut();
    } catch (e) {}
    authUser = null;
    cloudProjectId = null;
    cloudStatus = "تم تسجيل الخروج";
  }

  // بناء نسخة الحفظ المرسلة إلى السحابة
  // ملاحظة: نرسل workspaceCm حتى لا يعاد ترحيل المشروع عند التحميل من السحابة.
  function buildSnapshotForCloud() {
    return {
      workspaceCm: WORKSPACE_CM,
      rings,
      people,
      generationMarkers,
      baseGenerationNumber,
      links: links.map((l) => ({ ...l, bends: Array.isArray(l.bends) ? l.bends : [] })),
      zoom,
      projectRotationDeg,
      selectedPersonId,
      selectedPersonIds,
      selectedMarkerId,
      selectedLinkKey,
      namesTab,
      nmRingId,
      emRingId,
      emSelectedId,
            personDiameterCm,
      fontFamily,
      guideLayer: getGuideLayerSnapshot(),
      // ===== BEGIN: workspace guides + lineage controls =====
      showWorkspaceGuides,
      showLineageTrace,
      lineageTraceMode,
      showLineageDiagnostics,
      workspaceGuideMinorColor,
      workspaceGuideMajorColor,
      outerGuideColor,
      divisionGuideColor,
      divisionCount,
      
      guideStrokeWidth,
	globalLinkStrokeWidth,
	globalPersonStrokeWidth,
      // ===== END: guide thickness controls =====
      // ===== BEGIN: lineage visual enhancement =====
      // ===== END: lineage visual enhancement =====
      // ===== END: workspace guides + lineage controls =====
    };
  }

  async function cloudLoadOrCreate() {
    if (!authUser) return;

    cloudStatus = "جاري تحميل التصميم من السحابة...";
    const { data: rows, error } = await supabase
      .from("projects")
      .select("id, name, data")
      .eq("owner_id", authUser.id)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error) {
      cloudStatus = "خطأ تحميل: " + error.message;
      return;
    }

    // لا يوجد مشروع: أنشئ واحد
    if (!rows || rows.length === 0) {
      const emptySnap = buildSnapshotForCloud();
      const { data: ins, error: insErr } = await supabase
        .from("projects")
        .insert([{ name: "My Family Tree", owner_id: authUser.id, data: emptySnap }])
        .select("id")
        .single();

      if (insErr) {
        cloudStatus = "فشل إنشاء المشروع: " + insErr.message;
        return;
      }

      cloudProjectId = ins.id;
      cloudStatus = "تم إنشاء مشروع سحابي ✓";
      return;
    }

    cloudProjectId = rows[0].id;
    const snap = rows[0].data;

    try {
      const ok = applySnapshot(snap);
      if (ok) resetHistoryFromCurrent();
      cloudStatus = ok ? "تم تحميل التصميم ✓" : "تم التحميل لكن البيانات غير صالحة";

      // ✅ حفظ المشروع القادم من السحابة داخل قائمة المشاريع المحلية
      // حتى يبقى موجود بعد غلق وفتح البرنامج (familytree_projects_v1)
      if (ok) {
        try {
          readProjectsStore();
          const baseName = String(rows[0]?.name || "مشروع سحابي").trim() || "مشروع سحابي";

          // إذا الاسم موجود لمشروع سحابي آخر، نخزن كنسخة جديدة
          let finalName = baseName;
          const exists = !!projectsStore.items?.[finalName];
          const sameCloud = exists && projectsStore.meta?.[finalName]?.cloudId === cloudProjectId;

          if (exists && !sameCloud) {
            let i = 2;
            while (projectsStore.items?.[`${baseName} (${i})`]) i++;
            finalName = `${baseName} (${i})`;
          }

          projectsStore.items = projectsStore.items || {};
          projectsStore.meta = projectsStore.meta || {};
          projectsStore.items[finalName] = buildSnapshot(); // نفس البيانات بعد التطبيق
          projectsStore.meta[finalName] = { savedAt: Date.now(), cloudId: cloudProjectId };
          projectsStore.active = finalName;
          projectLoadSelect = finalName;

          persistProjectsStore();
          refreshProjectNames(true);

          // للتوافق مع الحفظ القديم
          try { localStorage.setItem(SNAP_KEY, JSON.stringify(buildSnapshot())); } catch {}
        } catch {}
      }
    } catch (e) {
      cloudStatus = "فشل تطبيق البيانات: " + (e?.message || String(e));
    }
  }

  async function cloudSave() {
    if (!authUser || !cloudProjectId) {
      cloudStatus = "سجّل الدخول أولاً";
      return;
    }

    cloudStatus = "جاري الحفظ...";
    const snap = buildSnapshotForCloud();

    const { error } = await supabase
      .from("projects")
      .update({ data: snap, updated_at: new Date().toISOString() })
      .eq("id", cloudProjectId)
      .eq("owner_id", authUser.id);

    if (error) {
      cloudStatus = "فشل الحفظ: " + error.message;
      return;
    }

    cloudStatus = "تم الحفظ ✓";
  }

// ================================
// L) المشاريع المحلية (حفظ باسم / تحميل / حذف)
// ================================
// هذا القسم يدير قائمة المشاريع داخل LocalStorage باستعمال PROJECTS_KEY.
function readProjectsStore() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && obj.items && typeof obj.items === "object") {
        projectsStore = {
          v: 1,
          active: String(obj.active || ""),
          items: obj.items || {},
          meta: (obj.meta && typeof obj.meta === "object") ? obj.meta : {}
        };
        refreshProjectNames(true);
        // مزامنة اختيار التحميل مع النشط
        projectLoadSelect = projectsStore.active || "";
        return;
      }
    }
  } catch {}

  // ترحيل تلقائي من الحفظ القديم (SNAP_KEY) إذا موجود
  try {
    const legacy = localStorage.getItem(SNAP_KEY);
    if (legacy) {
      const snap = JSON.parse(legacy);
      projectsStore = { v: 1, active: "مشروع 1", items: { "مشروع 1": snap }, meta: { "مشروع 1": { savedAt: Date.now() } } };
      persistProjectsStore();
      refreshProjectNames(true);
      projectLoadSelect = projectsStore.active || "";
      return;
    }
  } catch {}

  projectsStore = { v: 1, active: "", items: {}, meta: {} };
  refreshProjectNames(false);
  projectLoadSelect = "";
}

function persistProjectsStore() {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsStore));
  } catch {}
}

function refreshProjectNames(keepActive = false) {
  projectNames = Object.keys(projectsStore?.items || {}).sort((a, b) => a.localeCompare(b, "ar"));

  if (!keepActive) return;

  if (projectsStore.active && projectsStore.items?.[projectsStore.active]) {
    if (!projectLoadSelect) projectLoadSelect = projectsStore.active;
    return;
  }

  if (projectNames.length) {
    projectsStore.active = projectNames[0];
    if (!projectLoadSelect) projectLoadSelect = projectsStore.active;
  } else {
    projectsStore.active = "";
    projectLoadSelect = "";
  }
}

function openProjects() {
  showProjects = true;
  readProjectsStore();
  projectNameInput = projectsStore.active || "";
  projectLoadSelect = projectsStore.active || "";
}

function closeProjects() {
  showProjects = false;
}

// حفظ المشروع الحالي تحت اسم محدد داخل قائمة المشاريع المحلية
function saveToProjectName(name) {
  const n = String(name || "").trim();
  if (!n) {
    toast("اكتب اسم للحفظ");
    return false;
  }
  const snap = buildSnapshot();
  // buildSnapshot يحمل workspaceCm أيضاً، لذلك المشاريع الجديدة لا تعيد ترحيل الإحداثيات.
  projectsStore.items = projectsStore.items || {};
  projectsStore.meta = projectsStore.meta || {};

  projectsStore.items[n] = snap;
  projectsStore.meta[n] = { savedAt: Date.now() };

  projectsStore.active = n;
  projectLoadSelect = n;

  persistProjectsStore();
  refreshProjectNames(true);

  // احتفاظ أيضاً بالحفظ القديم للتوافق
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch {}

  toast("✅ تم الحفظ: " + n);
  return true;
}

function saveActiveProject() {
  readProjectsStore();
  if (!projectsStore.active) {
    openProjects();
    toast("حدد اسم مشروع أولاً");
    return;
  }
  saveToProjectName(projectsStore.active);
}

function saveAsProject() {
  const n = String(projectNameInput || "").trim();
  if (!n) { toast("اكتب اسم جديد"); return; }
  saveToProjectName(n);
}

function loadProjectByName(name) {
  readProjectsStore();
  const n = String(name || "").trim();
  const snap = projectsStore.items?.[n];
  if (!snap) { toast("المشروع غير موجود"); return; }
  try {
    const ok = applySnapshot(snap);
    if (ok) {
      projectsStore.active = n;
      projectLoadSelect = n;
      persistProjectsStore();
      refreshProjectNames(true);

      // تحديث الحفظ القديم للتوافق
      try { localStorage.setItem(SNAP_KEY, JSON.stringify(buildSnapshot())); } catch {}

      resetHistoryFromCurrent();
      toast("📥 تم تحميل: " + n);
    } else toast("تعذر تحميل المشروع");
  } catch {
    toast("تعذر تطبيق بيانات المشروع");
  }
}

function closeDeleteProjectConfirm() {
  showDeleteProjectConfirm = false;
  pendingDeleteProjectName = "";
}

function confirmDeleteProjectByName() {
  readProjectsStore();
  const n = String(pendingDeleteProjectName || "").trim();
  if (!n) {
    closeDeleteProjectConfirm();
    return;
  }
  if (!projectsStore.items?.[n]) {
    closeDeleteProjectConfirm();
    toast("المشروع غير موجود");
    return;
  }
  delete projectsStore.items[n];
  if (projectsStore.meta) delete projectsStore.meta[n];
  if (projectsStore.active === n) {
    refreshProjectNames(false);
    const names = Object.keys(projectsStore.items || {});
    projectsStore.active = names.length ? names.sort((a, b) => a.localeCompare(b, "ar"))[0] : "";
  }
  persistProjectsStore();
  refreshProjectNames(true);
  closeDeleteProjectConfirm();
  toast("تم حذف: " + n);
}

function deleteProjectByName(name) {
  readProjectsStore();
  const n = String(name || "").trim();
  if (!projectsStore.items?.[n]) { toast("المشروع غير موجود"); return; }
  pendingDeleteProjectName = n;
  showDeleteProjectConfirm = true;
}

  // حفظ سريع: إذا عندنا مشروع نشط نحفظ عليه مباشرة، وإلا نحفظ في SNAP_KEY فقط
function saveNow() {
    // حفظ تلقائي محلي فقط، أما الحفظ كملف فيتم عبر أزرار فتح/حفظ/حفظ باسم
    const snap = buildSnapshot();
    commitHistoryFromSnapshot(snap);

    readProjectsStore();
    if (projectsStore.active) {
      projectsStore.items = projectsStore.items || {};
      projectsStore.meta = projectsStore.meta || {};
      projectsStore.items[projectsStore.active] = snap;
      projectsStore.meta[projectsStore.active] = { ...(projectsStore.meta[projectsStore.active] || {}), savedAt: Date.now() };
      persistProjectsStore();
      refreshProjectNames(true);
      try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch {}
      updateExplicitDirtyState(snap);
      return;
    }

    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch {}
    updateExplicitDirtyState(snap);
  }

  // تحميل سريع: يحمّل المشروع النشط إن وجد، وإلا يرجع إلى آخر Snapshot محلي
function loadNow() {
    // تحميل سريع: يحمّل المشروع النشط إن وجد وإلا SNAP_KEY
    readProjectsStore();
    if (projectsStore.active && projectsStore.items?.[projectsStore.active]) {
      loadProjectByName(projectsStore.active);
      return;
    }
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) {
      toast("لا يوجد حفظ سابق");
      return;
    }
    try {
      const obj = JSON.parse(raw);
      if (applySnapshot(obj)) {
        resetHistoryFromCurrent();
        toast("تم التحميل");
        try { saveNow(); } catch (e) {}
      } else toast("تعذر تحميل الحفظ");
    } catch {
      toast("تعذر قراءة الحفظ");
    }
  }

  // ================================
  // M) أدوات الرسم داخل SVG
  // ================================
  // هنا تُبنى مسارات الروابط ونقاط المنتصف وعناصر الرسم المساعدة.
  function getDivisionPoint(parent, child) {
    // نقطة منتصف تقريبية
    return {
      x: (parent.x + child.x) / 2,
      y: (parent.y + child.y) / 2,
    };
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function linkPathD(parent, child, bends) {
    const pts = [{ x: parent.x, y: parent.y }, ...(bends || []), { x: child.x, y: child.y }];
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
    return d;
  }

  // نقطة "عصرية" لوضع زر (+) لإضافة تعرّج:
  // نختار منتصف طول المسار (Polyline) تقريبًا، حتى يبقى الزر في مكان منطقي مهما كثرت التعرجات.
  function linkMidpoint(parent, child, bends) {
    const pts = [{ x: parent.x, y: parent.y }, ...(bends || []), { x: child.x, y: child.y }];
    if (pts.length < 2) return { x: parent.x, y: parent.y };

    // إجمالي طول المسار
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
    if (total <= 0) return { x: (parent.x + child.x) / 2, y: (parent.y + child.y) / 2 };

    const target = total / 2;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = dist(a, b);
      if (acc + seg >= target) {
        const t = seg === 0 ? 0 : (target - acc) / seg;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      acc += seg;
    }
    return pts[Math.floor(pts.length / 2)];
  }

  function addBendToLinkAtPoint(key, pt, startDragPointerId = null) {
    const link = findLinkByKey(key);
    if (!link) return;
    if (!Array.isArray(link.bends)) link.bends = [];
    link.bends.push({ x: pt.x, y: pt.y });
    links = links.map((x) => x);
    selectedLinkKey = key;

    // إذا طلبنا: ابدأ سحب النقطة مباشرة بعد الإضافة (تجربة حديثة)
    if (startDragPointerId != null) {
      draggingBend = { key, idx: link.bends.length - 1 };
      try {
        svgEl.setPointerCapture(startDragPointerId);
      } catch (e) {}
    }

    try { saveNow(); } catch (e) {}
  }




  // ===== BEGIN: workspace guides + lineage controls =====
  // ===== BEGIN: guide radius follows last generation =====
  function getLastGuideRadiusMm() {
    if (!rings || !rings.length) return WORKSPACE_MM / 2;
    const last = rings[rings.length - 1];
    return cmToMm(Number(last.diameterCm) || 0) / 2;
  }
  // ===== END: guide radius follows last generation =====

  function getWorkspaceGuideRadiiMm() {
    const radii = [];
    const maxR = getLastGuideRadiusMm();
    for (let r = 5; r <= maxR; r += 5) radii.push(r);
    return radii;
  }

  function isWorkspaceGuideMajor(r) {
    return r % 10 === 0;
  }

  // ===== BEGIN: lineage visual enhancement =====
  function hexToRgb(hex) {
    const clean = String(hex || "").replace("#", "").trim();
    const normalized = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const safe = /^[0-9a-fA-F]{6}$/.test(normalized) ? normalized : "991b1b";
    return [
      parseInt(safe.slice(0, 2), 16),
      parseInt(safe.slice(2, 4), 16),
      parseInt(safe.slice(4, 6), 16)
    ];
  }
  // ===== END: lineage visual enhancement =====

  function getParentLinkForChild(childId) {
    if (!childId) return null;
    return links.find((l) => l.childId === childId) || null;
  }

  function getChildLinksForParent(parentId) {
    if (!parentId) return [];
    return links.filter((l) => l.parentId === parentId);
  }

  function getAncestorLineagePersonIds(startId) {
    if (!startId) return [];

    const ids = [];
    const seen = new Set();
    let currentId = startId;

    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      ids.push(currentId);
      const parentLink = getParentLinkForChild(currentId);
      currentId = parentLink?.parentId || null;
    }

    return ids;
  }

  function getAncestorLineageLinkKeys(startId) {
    if (!startId) return [];

    const keys = [];
    const seen = new Set();
    let currentId = startId;

    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const parentLink = getParentLinkForChild(currentId);
      if (!parentLink) break;
      keys.push(mkLinkKey(parentLink));
      currentId = parentLink.parentId || null;
    }

    return keys;
  }

  function getDescendantLineageData(startId) {
    if (!startId) return { ids: [], linkKeys: [] };

    const ids = [];
    const linkKeys = [];
    const seenIds = new Set();
    const seenLinks = new Set();
    const stack = [startId];

    while (stack.length) {
      const currentId = stack.pop();
      if (!currentId || seenIds.has(currentId)) continue;
      seenIds.add(currentId);
      ids.push(currentId);

      const childLinks = getChildLinksForParent(currentId);
      for (const link of childLinks) {
        const key = mkLinkKey(link);
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          linkKeys.push(key);
        }
        if (link.childId && !seenIds.has(link.childId)) {
          stack.push(link.childId);
        }
      }
    }

    return { ids, linkKeys };
  }

  function getSelectedLineagePersonIds() {
    if (!showLineageTrace || !selectedPersonId) return [];

    if (lineageTraceMode === "descendants") {
      return getDescendantLineageData(selectedPersonId).ids;
    }

    return getAncestorLineagePersonIds(selectedPersonId);
  }

  function getSelectedLineageLinkKeys() {
    if (!showLineageTrace || !selectedPersonId) return [];

    if (lineageTraceMode === "descendants") {
      return getDescendantLineageData(selectedPersonId).linkKeys;
    }

    return getAncestorLineageLinkKeys(selectedPersonId);
  }

  function getSelectedLineageLabel() {
    if (!showLineageTrace || !selectedPersonId) return "";

    if (lineageTraceMode === "descendants") {
      const rootPerson = people.find((p) => p.id === selectedPersonId);
      const rootName = String(rootPerson?.name || "").trim();
      const data = getDescendantLineageData(selectedPersonId);
      const descendantsCount = Math.max(0, data.ids.length - 1);
      if (!rootName) return descendantsCount ? `ذرية (${descendantsCount})` : "";
      return descendantsCount ? `${rootName} ← الذرية (${descendantsCount})` : `${rootName}`;
    }

    const names = [];
    const ids = getAncestorLineagePersonIds(selectedPersonId);

    for (const id of ids) {
      const person = people.find((p) => p.id === id);
      const cleanName = String(person?.name || "").trim();
      if (cleanName) names.push(cleanName);
    }

    return names.join(" بن ");
  }

  function getLineagePersonOpacity(personId) {
    return 1;
  }

  function getLineageLinkOpacity(linkKey) {
    return 1;
  }

  function splitLineageLabel(label) {
    const clean = String(label || "").trim();
    if (!clean) return [];
    if (clean.includes(" بن ")) return clean.split(" بن ").map((part, idx, arr) => idx < arr.length - 1 ? `${part} بن` : part);
    return [clean];
  }

  // ===== BEGIN: lineage visual enhancement =====
  function getActiveLineageColor() {
    return "#000000";
  }

  function getLineagePathStrokeWidth() {
    return 1.8;
  }

  function getLineageGlowFilter() {
    return "";
  }

  function getLineagePersonStroke(personId) {
    return "#000";
  }

  function getLineagePersonStrokeWidth(person) {
    const base = person?.id === selectedPersonId ? 2.6 : clamp(person?.strokeMm, STROKE_MM_MIN, STROKE_MM_MAX) / 3;
    return base;
  }

  function getLineageLabelStrokeColor() {
    return "rgba(255,255,255,0.98)";
  }
  // ===== END: lineage visual enhancement =====

  // ===== BEGIN: lineage display controls =====
  function ensureLineageTraceOnPersonSelect() {
    showLineageTrace = true;
    lineageTraceMode = "ancestors";
  }

  function getLineageLabelY(person, linesCount, fontPx) {
    if (!person) return 0;
    const radiusMm = cmToMm(person.diameterCm) / 2;
    const lineHeight = fontPx * 1.05;
    const rawY = person.y - radiusMm - 12 - Math.max(0, linesCount - 1) * lineHeight;
    const minVisibleY = Number(view?.y || 0) + lineHeight + 4;
    return Math.max(rawY, minVisibleY);
  }

  // ===== BEGIN: lineage diagnostics =====
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

    const personMap = new Map(people.map((p) => [p.id, p]));
    const selectedPerson = personMap.get(startId) || null;
    result.selectedName = String(selectedPerson?.name || "").trim();

    const incomingLinks = links.filter((l) => l.childId === startId);
    result.selectedHasIncomingParentLink = incomingLinks.length > 0;

    const seen = new Set();
    let currentId = startId;

    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      result.chainIds.push(currentId);

      const person = personMap.get(currentId) || null;
      const cleanName = String(person?.name || "").trim();
      result.chainNames.push(cleanName || `(بدون اسم: ${currentId})`);

      const parentLinks = links.filter((l) => l.childId === currentId);
      if (!parentLinks.length) break;

      const chosen = parentLinks[0];
      result.chainLinkKeys.push(mkLinkKey(chosen));

      const parentPerson = personMap.get(chosen.parentId) || null;
      if (!parentPerson) {
        result.brokenLinks.push({
          key: mkLinkKey(chosen),
          parentId: chosen.parentId,
          childId: chosen.childId
        });
        break;
      }

      if (parentLinks.length > 1) {
        for (const extra of parentLinks.slice(1)) {
          result.missingParentLinks.push(`روابط أب متعددة للابن ${currentId}: ${mkLinkKey(extra)}`);
        }
      }

      currentId = chosen.parentId || null;
    }

    result.hasVisibleAncestors = result.chainIds.length > 1;
    if (!result.hasVisibleAncestors && !result.selectedHasIncomingParentLink) {
      result.note = "الشخص المحدد لا يملك رابطًا صاعدًا كـ childId، لذلك لن يظهر مسار أحمر صاعد.";
    } else if (result.brokenLinks.length) {
      result.note = "يوجد رابط نسب يشير إلى parentId غير موجود داخل people.";
    } else if (result.missingParentLinks.length) {
      result.note = "يوجد أكثر من أب مباشر لنفس الابن، ويتم حاليًا اعتماد أول رابط فقط.";
    } else {
      result.note = "سلسلة النسب محسوبة بنجاح.";
    }

    return result;
  }
  // ===== END: lineage diagnostics =====
  // ===== END: lineage diagnostics =====
  // ===== END: lineage display controls =====
  // ===== END: workspace guides + lineage controls =====

  function updateExplicitDirtyState(snap = null) {
    try {
      const json = JSON.stringify(snap || buildSnapshot());
      hasUnsavedChanges = lastExplicitSaveJson ? json !== lastExplicitSaveJson : false;
    } catch {
      hasUnsavedChanges = false;
    }
  }

  function markExplicitSaved(snap = null) {
    try {
      const json = JSON.stringify(snap || buildSnapshot());
      lastExplicitSaveJson = json;
      hasUnsavedChanges = false;
    } catch {
      lastExplicitSaveJson = "";
      hasUnsavedChanges = false;
    }
  }

  function sanitizeDocName(name) {
    const base = String(name || "مستند جديد").trim() || "مستند جديد";
    return /\.ftree$/i.test(base) ? base : `${base}.ftree`;
  }

  async function writeFileHandle(handle, textData) {
    const writable = await handle.createWritable();
    await writable.write(textData);
    await writable.close();
  }

  function buildSnapshotForFile() {
    return buildSnapshot();
  }

  function loadSnapshotFromFileObject(obj, fileName = "مستند جديد.ftree") {
    if (!obj || typeof obj !== "object") {
      toast("ملف غير صالح");
      return false;
    }

    const snap = obj.people || obj.links || obj.rings ? obj : (obj.snapshot || null);
    if (!snap) {
      toast("الملف لا يحتوي بيانات مشروع");
      return false;
    }

    const ok = applySnapshot(snap);
    if (!ok) {
      toast("تعذر تحميل الملف");
      return false;
    }

    currentDocName = sanitizeDocName(fileName);
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(buildSnapshot())); } catch {}
    resetHistoryFromCurrent();
    markExplicitSaved(buildSnapshot());
    toast("📂 تم فتح الملف");
    return true;
  }

  async function saveDocumentAs() {
    const snap = buildSnapshotForFile();
    const payload = JSON.stringify(snap, null, 2);

    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: sanitizeDocName(currentDocName),
          types: [{
            description: "Family Tree Project",
            accept: {
              "application/json": [".ftree", ".json"]
            }
          }]
        });
        await writeFileHandle(handle, payload);
        currentDocHandle = handle;
        currentDocName = sanitizeDocName(handle.name || currentDocName);
        markExplicitSaved(snap);
        toast("💾 تم الحفظ باسم");
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }

    try {
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = sanitizeDocName(currentDocName);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      currentDocName = sanitizeDocName(currentDocName);
      currentDocHandle = null;
      markExplicitSaved(snap);
      toast("💾 تم تنزيل الملف");
    } catch {
      toast("تعذر حفظ الملف");
    }
  }

  async function saveDocument() {
    const snap = buildSnapshotForFile();
    const payload = JSON.stringify(snap, null, 2);

    if (currentDocHandle && window.showSaveFilePicker) {
      try {
        await writeFileHandle(currentDocHandle, payload);
        currentDocName = sanitizeDocName(currentDocHandle.name || currentDocName);
        markExplicitSaved(snap);
        toast("💾 تم الحفظ");
        return;
      } catch (e) {
        if (!(e && e.name === "AbortError")) {
          toast("تعذر الحفظ المباشر، سيتم الحفظ باسم");
        }
      }
    }

    await saveDocumentAs();
  }

  async function openDocumentPicker() {
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: "Family Tree Project",
            accept: {
              "application/json": [".ftree", ".json"]
            }
          }]
        });
        if (!handle) return;
        const file = await handle.getFile();
        const textData = await file.text();
        const obj = JSON.parse(textData);
        currentDocHandle = handle;
        loadSnapshotFromFileObject(obj, file.name || handle.name || "مستند جديد.ftree");
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
      toast("تعذر فتح منتقي الملفات");
    }

    fileOpenInputEl?.click?.();
  }

  async function onOpenFileSelected(e) {
    const file = e?.currentTarget?.files?.[0];
    if (!file) return;
    try {
      const textData = await file.text();
      const obj = JSON.parse(textData);
      currentDocHandle = null;
      loadSnapshotFromFileObject(obj, file.name || "مستند جديد.ftree");
    } catch {
      toast("تعذر قراءة الملف");
    } finally {
      if (e?.currentTarget) e.currentTarget.value = "";
    }
  }

  // ================================
  // N) دورة حياة الصفحة (Lifecycle)
  // ================================
  // عند فتح الصفحة: نحاول قراءة الحفظ المحلي، ثم نفحص جلسة السحابة، ثم نربط اختصارات الكيبورد.
  onMount(() => {
    // حاول تحميل آخر استرداد تلقائي محلي
    try {
      const raw = localStorage.getItem(SNAP_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (applySnapshot(obj)) {
          currentDocName = "استرداد تلقائي.ftree";
          currentDocHandle = null;
          resetHistoryFromCurrent();
          markExplicitSaved(buildSnapshot());
        }
      } else {
        resetHistoryFromCurrent();
        markExplicitSaved(buildSnapshot());
      }
    } catch (e) {}

    // Online: إذا كان هناك Session مفتوحة، حمّل المشروع تلقائياً
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        authUser = data?.session?.user ?? null;
        if (authUser) await cloudLoadOrCreate();
      } catch (e) {}
    })();
  
    function onKeyDown(ev) {
  const t = ev.target;
  const tag = t && t.tagName ? String(t.tagName).toUpperCase() : "";
  const isTyping =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (t && t.isContentEditable);

  if (isTyping) return;

  // =========================
  // Ctrl + S (حفظ)
  // =========================
  if (ev.ctrlKey && !ev.shiftKey && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    try { saveNow(); } catch (e) {}
    return;
  }

  // =========================
  // Ctrl + O (فتح)
  // =========================
  if (ev.ctrlKey && !ev.shiftKey && (ev.key === "o" || ev.key === "O")) {
    ev.preventDefault();
    try { document.getElementById("fileInput")?.click(); } catch (e) {}
    return;
  }

  // =========================
  // Undo / Redo
  // =========================
  if (ev.ctrlKey && !ev.shiftKey && (ev.key === "z" || ev.key === "Z")) {
    ev.preventDefault();
    try { undo(); } catch (e) {}
    return;
  }

  if (
    (ev.ctrlKey && ev.shiftKey && (ev.key === "z" || ev.key === "Z")) ||
    (ev.ctrlKey && (ev.key === "y" || ev.key === "Y"))
  ) {
    ev.preventDefault();
    try { redo(); } catch (e) {}
    return;
  }

    // =========================
  // 🎯 تحريك رقم الجيل / شخص واحد / مجموعة بالأسهم
  // =========================
  if (
    ev.key === "ArrowUp" ||
    ev.key === "ArrowDown" ||
    ev.key === "ArrowLeft" ||
    ev.key === "ArrowRight"
  ) {
    const hasMarker = !!selectedMarkerId;
    const hasSingle = !!selectedPersonId;
    const hasGroup = Array.isArray(selectedPersonIds) && selectedPersonIds.length > 0;

    if (!hasMarker && !hasSingle && !hasGroup) return;

    ev.preventDefault();

    let step = 2;
if (ev.shiftKey) step = 10;
else if (ev.ctrlKey) step = 1;

    let dx = 0;
    let dy = 0;

    if (ev.key === "ArrowUp") dy = -step;
    if (ev.key === "ArrowDown") dy = step;
    if (ev.key === "ArrowLeft") dx = -step;
    if (ev.key === "ArrowRight") dx = step;

    // =========================
    // أولاً: تحريك رقم الجيل المحدد
    // =========================
    if (hasMarker) {
      const idx = generationMarkers.findIndex((m) => m.id === selectedMarkerId);
      if (idx === -1) return;

      const marker = generationMarkers[idx];
      const halfW = getMarkerHalfWidth(marker);
      const halfH = getMarkerHalfHeight(marker);

      const x = clamp((Number(marker.x) || CX) + dx, halfW, WORKSPACE_MM - halfW);
      const y = clamp((Number(marker.y) || CY) + dy, halfH, WORKSPACE_MM - halfH);

      generationMarkers = generationMarkers.map((m, i) =>
        i === idx ? { ...m, x, y } : m
      );

      try { saveNow(); } catch (e) {}
      return;
    }

    // =========================
    // ثانيًا: تحريك مجموعة أشخاص
    // =========================
    if (hasGroup && selectedPersonIds.length > 1) {
      const selectedSet = new Set(selectedPersonIds);
      const selectedPeople = people.filter((p) => selectedSet.has(p.id));

      if (!selectedPeople.length) return;

      const peopleStartMap = new Map();
      for (const p of selectedPeople) {
        peopleStartMap.set(p.id, {
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          ringId: p.ringId,
          diameterCm: p.diameterCm,
        });
      }

      const internalLinkBendsStart = new Map();
      for (const l of links) {
        if (selectedSet.has(l.parentId) && selectedSet.has(l.childId)) {
          internalLinkBendsStart.set(
            mkLinkKey(l),
            (Array.isArray(l.bends) ? l.bends : []).map((b) => ({ x: b.x, y: b.y }))
          );
        }
      }

      const safe = findSafeGroupDelta(selectedPeople, peopleStartMap, dx, dy);
      const finalDx = safe.dx;
      const finalDy = safe.dy;

      if (finalDx === 0 && finalDy === 0) return;

      people = people.map((person) => {
        if (!selectedSet.has(person.id)) return person;
        const start = peopleStartMap.get(person.id);
        if (!start) return person;
        return {
          ...person,
          x: start.x + finalDx,
          y: start.y + finalDy,
        };
      });

      links = links.map((link) => {
        const key = mkLinkKey(link);
        const startBends = internalLinkBendsStart.get(key);
        if (!startBends) return link;
        return {
          ...link,
          bends: startBends.map((b) => ({
            x: b.x + finalDx,
            y: b.y + finalDy,
          })),
        };
      });

      try { saveNow(); } catch (e) {}
      return;
    }

    // =========================
    // ثالثًا: تحريك شخص واحد
    // =========================
    const idx = people.findIndex((p) => p.id === selectedPersonId);
    if (idx === -1) return;

    const person = people[idx];
    const personRadiusMm = cmToMm(Number(person.diameterCm) || 2) / 2;

    let x = clamp((Number(person.x) || CX) + dx, 0, WORKSPACE_MM);
    let y = clamp((Number(person.y) || CY) + dy, 0, WORKSPACE_MM);

    const constrained = constrainPointToRingBand(
      person.ringId,
      personRadiusMm,
      x,
      y
    );

    x = constrained.x;
    y = constrained.y;

    people = people.map((p, i) =>
      i === idx ? { ...p, x, y } : p
    );

    try { saveNow(); } catch (e) {}
    return;
  }
  // =========================
  // Delete
  // =========================
  if (ev.key === "Delete") {
    if (selectedLinkKey) {
      ev.preventDefault();
      links = links.filter((l) => mkLinkKey(l) !== selectedLinkKey);
      selectedLinkKey = null;
      selectedBend = null;
      try { saveNow(); } catch (e) {}
      return;
    }

    if (selectedPersonId) {
      ev.preventDefault();
      const p = people.find((x) => x.id === selectedPersonId);
      if (p && !p.locked) {
        people = people.filter((x) => x.id !== selectedPersonId);
        links = links.filter(
          (l) =>
            l.parentId !== selectedPersonId &&
            l.childId !== selectedPersonId &&
            l.fromId !== selectedPersonId &&
            l.toId !== selectedPersonId
        );
        selectedPersonIds = selectedPersonIds.filter((id) => id !== selectedPersonId);
        selectedPersonId = selectedPersonIds.length ? selectedPersonIds[selectedPersonIds.length - 1] : null;
        try { saveNow(); } catch (e) {}
      }
    }
  }
}

    function onBeforeUnload(ev) {
      if (!hasUnsavedChanges) return;
      ev.preventDefault();
      ev.returnValue = "";
    }

    function onDocumentPointerDown(ev) {
      if (treeToolsMenuEl?.contains(ev.target) || fileMenuEl?.contains(ev.target)) return;
      closeToolbarMenus();
    }

    function onFullscreenChange() {
      const fsEl = document.fullscreenElement;
      isWorkspaceFullscreen = !!fsEl && !!workspaceFullscreenEl && (fsEl === workspaceFullscreenEl || workspaceFullscreenEl.contains(fsEl));
      if (isWorkspaceFullscreen) closeToolbarMenus();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
});

  // ===============================
  // O) زوم الكاميرا بعجلة الماوس
  // ===============================
  // هذا الجزء يجعل التكبير والتصغير يتم حول موضع المؤشر بدل مركز اللوحة.

  const MIN_W = 200;
  const MAX_W = 8000;

  function onWheel(e) {
    e.preventDefault();
    if (!svgEl) return;

    const rect = svgEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const svgW = rect.width || 1;
    const svgH = rect.height || 1;

    const wx = view.x + (mx / svgW) * view.w;
    const wy = view.y + (my / svgH) * view.h;

    const zoomIn = e.deltaY < 0;
    const factor = zoomIn ? 0.9 : 1.1;

    let w2 = view.w * factor;
    let h2 = view.h * factor;

    if (w2 < MIN_W) {
      w2 = MIN_W;
      h2 = view.h * (MIN_W / view.w);
    }
    if (w2 > MAX_W) {
      w2 = MAX_W;
      h2 = view.h * (MAX_W / view.w);
    }

    const x2 = wx - (mx / svgW) * w2;
    const y2 = wy - (my / svgH) * h2;

    view = { x: x2, y: y2, w: w2, h: h2 };
    clampViewToWorkspace();
    // تحديث قيمة الزوم المعروضة (1..3 تقريبًا)
    const z = WORKSPACE_MM / view.w;
    zoom = clamp(z, 0.5, 3);
    zoomInput = zoom;
  }
</script>

<style>
select {
  background-color: #ffffff;
  color: #000000;
}

select option {
  background-color: #ffffff;
  color: #000000;
}

  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    background: #0b1220;
    color: #e5e7eb;
  }

  .page {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background:
      radial-gradient(circle at top, rgba(37,99,235,0.10), transparent 34%),
      linear-gradient(180deg, #0b1220 0%, #0f172a 100%);
  }
  .page.fullscreenMode {
    background: #020617;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    padding: 12px;
    display: grid;
    gap: 12px;
    background: rgba(8, 15, 28, 0.86);
    border-bottom: 1px solid rgba(148,163,184,0.14);
    backdrop-filter: blur(10px);
  }

  .btn {
    background: rgba(255,255,255,0.07);
    color: #e5e7eb;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 9px 12px;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    transition: background .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease;
  }
  .btn:hover { background: rgba(255,255,255,0.12); transform: translateY(-1px); }
  .btn.primary {
    background: linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
    border-color: rgba(147,197,253,0.55);
    box-shadow: 0 10px 24px rgba(37,99,235,0.22);
  }
  .btn.secondary {
    background: linear-gradient(180deg, #4f46e5 0%, #4338ca 100%);
    border-color: rgba(196,181,253,0.45);
    box-shadow: 0 10px 24px rgba(79,70,229,0.20);
  }
  .btn.accent {
    background: linear-gradient(180deg, #0f766e 0%, #115e59 100%);
    border-color: rgba(153,246,228,0.30);
    box-shadow: 0 10px 24px rgba(20,184,166,0.18);
  }
  .btn.danger { border-color: rgba(239,68,68,0.55); }

  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .toolbarMain {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .toolbarAux {
    display: grid;
    grid-template-columns: minmax(260px, 340px) minmax(320px, 1fr);
    gap: 12px;
    align-items: stretch;
  }
  .toolbarCard {
    background: rgba(255,255,255,0.045);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 18px;
    padding: 12px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.03), 0 10px 30px rgba(0,0,0,0.18);
  }
  .toolbarCardTitle {
    font-size: 12px;
    font-weight: 900;
    color: #cbd5e1;
    margin-bottom: 8px;
  }
  .toolbarActions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .guideControls {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .colorField {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #e2e8f0;
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 6px 8px;
  }
  .colorField input[type="color"] {
    width: 30px;
    height: 30px;
    border: 0;
    background: transparent;
    padding: 0;
  }
  .guidePanelCard {
    display: grid;
    gap: 12px;
    margin-top: 10px;
  }
  .guidePanelHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .guidePanelSub {
    color: #94a3b8;
    font-size: 12px;
  }
  .guideMasterToggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 12px;
    background: rgba(15,23,42,0.5);
    border: 1px solid rgba(148,163,184,0.18);
    color: #e2e8f0;
    font-size: 12px;
    font-weight: 800;
  }
  .guideSection {
    border: 1px solid rgba(148,163,184,0.14);
    border-radius: 14px;
    overflow: hidden;
    background: rgba(15,23,42,0.22);
  }
  .guideSectionToggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: rgba(255,255,255,0.02);
    color: #e2e8f0;
    border: 0;
    padding: 12px 14px;
    cursor: pointer;
    font: inherit;
    text-align: right;
  }
  .guideSectionToggle span {
    font-weight: 900;
  }
  .guideSectionToggle small {
    color: #94a3b8;
    font-size: 11px;
  }
  .guideSectionBody {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    padding: 0 14px 14px;
  }
  .editPanelEmpty {
    border: 1px dashed rgba(148,163,184,0.26);
    border-radius: 14px;
    color: #cbd5e1;
    background: rgba(15,23,42,0.18);
    padding: 14px;
  }
  .editInfoPill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-radius: 999px;
    background: rgba(30,41,59,0.78);
    border: 1px solid rgba(148,163,184,0.16);
    color: #e2e8f0;
    font-size: 12px;
    font-weight: 700;
  }
  .projTag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-radius: 14px;
    background: rgba(15,23,42,0.72);
    border: 1px solid rgba(148,163,184,0.22);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
    color: #e2e8f0;
    font-size: 13px;
  }
  .projTagSub {
    color: #fca5a5;
    font-weight: 800;
  }

  .label {
    font-size: 12px;
    opacity: 0.85;
  }

  .input {
    background: rgba(255,255,255,0.06);
    color: #e5e7eb;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 10px;
    padding: 8px 10px;
    font-size: 13px;
    outline: none;
    width: 110px;
  }

  .stageWrap {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: auto;
    padding: 14px;
    position: relative;
  }
  .stageWrap.fullscreenMode {
    width: 100vw;
    height: 100vh;
    padding: 0;
    background:
      radial-gradient(circle at center, rgba(30,41,59,0.65), rgba(2,6,23,0.96));
  }

  .stage {
    width: min(92vmin, 920px);
    aspect-ratio: 1 / 1;
    border-radius: 24px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02));
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 18px 60px rgba(0,0,0,0.28);
    overflow: visible;
    transition: width .2s ease, border-radius .2s ease, box-shadow .2s ease;
  }
  .stage.fullscreenMode {
    width: 100vw;
    height: 100vh;
    aspect-ratio: auto;
    border-radius: 0;
    border: 0;
    box-shadow: none;
    background: rgba(255,255,255,0.02);
  }
  .fullscreenHint {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    z-index: 35;
    background: rgba(15,23,42,0.82);
    color: #e2e8f0;
    border: 1px solid rgba(148,163,184,0.24);
    padding: 8px 12px;
    border-radius: 999px;
    font-size: 12px;
    backdrop-filter: blur(8px);
  }

  .toast {
    position: fixed;
    left: 16px;
    bottom: 16px;
    background: rgba(0,0,0,0.65);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 10px 12px;
    font-size: 13px;
    z-index: 50;
    backdrop-filter: blur(6px);
  }

  /* Modal */
  .modalBack {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }

  .modal {
    width: min(520px, 92vw);
    background: #0f172a;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 16px;
    padding: 14px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.45);
  }

  .modal h3 {
    margin: 0 0 10px 0;
    font-size: 16px;
  }

  .modal .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .err {
    color: #fca5a5;
    font-size: 12px;
    margin-top: 8px;
  }

  /* SVG text */
  .personText {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;

  line-height: 1.1;

  /* هوامش داخلية */
  padding: 8px;
  box-sizing: border-box;

  /* التفاف بدون تقطيع الكلمة */
  white-space: normal;
  overflow-wrap: break-word; /* يكسر فقط إذا كلمة طويلة جدًا */
  word-break: normal;

  /* لا نسمح بالخروج خارج الدائرة */
  overflow: hidden;

  color: #000;
}

  .linkGlow {
    filter: drop-shadow(0 0 6px rgba(59,130,246,0.95));
  }

  .bendHandle {
    cursor: grab;
  }
  .bendHandle:active {
    cursor: grabbing;
  }

  .bendPlus {
    cursor: pointer;
    user-select: none;
  }
  .bendPlusCircle {
    fill: #fff;
    stroke: #2563eb; /* أزرق عصري */
    stroke-width: 1.5;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.25));
  }
  .bendPlusText {
    font-size: 14px;
    font-weight: 700;
    fill: #2563eb;
  }
  .bendPlus:hover .bendPlusCircle {
    fill: #eff6ff;
  }

  /* (+) minimal marker for bends */
  .bendPlusHit { pointer-events: all; }
  .bendPlusLine {
    stroke: #111;
    stroke-width: 1.6;
    stroke-linecap: round;
    pointer-events: none;
  }

  /* ================================
     Supabase Online Box
     ================================ */
  .cloudBox {
    position: fixed;
    left: 12px;
    bottom: 12px;
    z-index: 999;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    padding: 10px;
    border-radius: 12px;
    width: 360px;
    backdrop-filter: blur(6px);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .cloudRow {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cloudInput {
    flex: 1;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    outline: none;
    min-width: 0;
  }
  .cloudBtn {
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
  }
  .cloudOk {
    font-weight: 700;
    opacity: 0.95;
  }
  .cloudStatus {
    margin-top: 8px;
    font-size: 12px;
    opacity: 0.9;
    line-height: 1.2;
  }

  /* ===============================
     Modal base styles (إضافة فقط)
     =============================== */
  .modalBack {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 16px;
  }

  .modal {
    width: min(520px, 96vw);
    background: #0b1220;
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 14px;
    padding: 14px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.35);
  }

  .modal h3 {
    margin: 0 0 10px 0;
    font-size: 16px;
  }

  .modal .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 12px;
  }

  .err {
    color: #fca5a5;
    font-size: 12px;
    margin-top: 8px;
  }


  .personTextSvg{
    direction: rtl;
    unicode-bidi: plaintext;
    fill: #000;
    font-weight: 700;
    pointer-events: none;
  }

  /* ===== BEGIN: workspace guides + lineage trace ===== */
  .lineageTextSvg {
    direction: rtl;
    unicode-bidi: plaintext;
    fill: #7f1d1d;
    font-weight: 950;
    paint-order: stroke;
    stroke: rgba(255,255,255,0.98);
    stroke-width: 3.2px;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
    overflow: visible;
    pointer-events: none;
  }
  /* ===== END: workspace guides + lineage trace ===== */

  /* ===== BEGIN: ui layout polish ===== */
  .menuWrap {
    position: relative;
    display: inline-block;
  }
  .menuDrop {
    position: relative;
  }
  .menuDrop > summary {
    list-style: none;
  }
  .menuDrop > summary::-webkit-details-marker {
    display: none;
  }
  .menuPanel {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 220px;
    background: #fff;
    border: 1px solid #d6d3d1;
    border-radius: 14px;
    box-shadow: 0 14px 34px rgba(0,0,0,.12);
    padding: 8px;
    z-index: 40;
    display: grid;
    gap: 6px;
  }
  .menuTitle {
    font-size: 12px;
    font-weight: 900;
    color: #6b7280;
    padding: 2px 6px 4px;
  }
  .menuBtn {
    width: 100%;
    text-align: right;
    justify-content: flex-start;
    color: #0f172a;
    background: #f8fafc;
    border-color: #dbe3ee;
    font-weight: 800;
  }
  .menuBtn:hover {
    background: #eef4ff;
  }
  .menuPanel .danger {
    color: #991b1b;
    background: #fff5f5;
    border-color: #fecaca;
  }
  .diagCard {
    border: 1px solid #fecaca;
    background: #fff7f7;
    color: #7f1d1d;
  }
  @media (max-width: 980px) {
    .toolbarAux {
      grid-template-columns: 1fr;
    }
  }
  /* ===== END: ui layout polish ===== */

</style>

<!-- ====================================================
     Q) واجهة الصفحة الرئيسية
     ==================================================== -->
<div class="page" class:fullscreenMode={isWorkspaceFullscreen}>
  {#if !isWorkspaceFullscreen}
    <div class="topbar">
      <div class="toolbarMain">
        <div class="row">
          <button class="btn primary" type="button" onclick={toggleDrawPanel}>
            {showDrawPanel ? "✏️ إخفاء الرسم" : "✏️ الرسم"}
          </button>
          <button class="btn" type="button" onclick={toggleEditPanel}>
            {showEditPanel ? "🛠️ إخفاء التحرير" : "🛠️ التحرير"}
          </button>
          <button class="btn" type="button" onclick={toggleViewPanel}>
            {showViewPanel ? "🪟 إخفاء العرض" : "🪟 العرض"}
          </button>
          <button class="btn secondary" type="button" onclick={toggleProjectPanel}>
            {showProjectPanel ? "📁 إخفاء المشروع" : "📁 المشروع"}
          </button>
          <button class="btn accent" type="button" onclick={toggleWorkspaceFullscreen}>⛶ ملء الشاشة</button>
          <button class="btn" type="button" onclick={openPrintModal}>🖨️ طباعة</button>
          <button class="btn" type="button" onclick={() => { showLineageDiagnostics = !showLineageDiagnostics; saveNow(); }}>
            {showLineageDiagnostics ? "🧪 إخفاء تشخيص النسب" : "🧪 إظهار تشخيص النسب"}
           </button>
 </div>

        <span class="projTag">📄 الملف: <b>{currentDocName}</b>{#if hasUnsavedChanges}<span class="projTagSub">• غير محفوظ</span>{/if}</span>
      </div>

      {#if showDrawPanel}
        <div class="toolbarCard guidePanelCard">
          <div class="guidePanelHeader">
            <div>
              <div class="toolbarCardTitle" style="margin-bottom:4px;">✏️ الرسم</div>
              <div class="guidePanelSub">أدوات إنشاء العناصر الجديدة داخل الشجرة.</div>
            </div>
            <div class="projTagSub">{linkMode ? "وضع الربط مفعل" : "وضع الرسم العادي"}</div>
          </div>

          <div class="toolbarActions">
            <button class="btn" type="button" onclick={openAddName}>➕ إضافة اسم</button>
            <button class="btn" type="button" onclick={toggleLinkMode}>
              {linkMode ? "🔗 إيقاف الربط" : "🔗 ربط أب→ابن"}
            </button>
            <button class="btn" type="button" onclick={openAddRingModal}>⭕ إضافة جيل</button>
            <button class="btn" type="button" onclick={openEditRingModal}>✏️ تعديل الجيل</button>
            <button class="btn" type="button" onclick={openGenerationMarkerModal}>🔢 إضافة رقم جيل</button>
            <button class="btn danger" type="button" onclick={deleteLastRing}>🗑️ حذف آخر جيل</button>
          </div>
        </div>
      {/if}

      {#if showViewPanel}
        <div class="toolbarCard guidePanelCard">
          <div class="guidePanelHeader">
            <div>
              <div class="toolbarCardTitle" style="margin-bottom:4px;">🪟 العرض</div>
              <div class="guidePanelSub">الزوم والدوران والإرشادات والمظهر البصري فقط.</div>
            </div>
            <div class="toolbarActions">
              <button class="btn" type="button" onclick={toggleGuidePanel}>
                {showGuidePanel ? "🧭 إخفاء الإرشادات" : "🧭 الإرشادات"}
              </button>
              
            </div>
          </div>

          <div class="guideControls">
            <div class="toolbarCard">
              <div class="toolbarCardTitle">الزوم</div>
              <div class="toolbarActions">
                <span class="label">Zoom</span>
                <input
                  class="input"
                  type="number"
                  step="0.1"
                  min="0.2"
                  max="3"
                  bind:value={zoomInput}
                  oninput={() => setZoom(zoomInput)}
                />
                <input
                  type="range"
                  min="0.2"
                  max="3"
                  step="0.05"
                  value={zoom}
                  oninput={(e) => setZoom(e.currentTarget.value)}
                />
              </div>
            </div>

            <div class="toolbarCard">
              <div class="toolbarCardTitle">دوران المشروع</div>
              <div class="toolbarActions">
                <span class="label">الزاوية</span>
                <input
                  class="input"
                  type="number"
                  step="1"
                  min="-180"
                  max="180"
                  bind:value={projectRotationDeg}
                />
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="1"
                  bind:value={projectRotationDeg}
                />
                <button class="btn" type="button" onclick={() => { projectRotationDeg = 0; saveNow(); }}>تصفير</button>
              </div>
            </div>

            <div class="toolbarCard">
              <div class="toolbarCardTitle">سماكات الشجرة</div>
              <div class="toolbarActions">
                <label class="colorField">
                  سماكة الروابط
                  <input
                    class="input"
                    type="number"
                    min="0.1"
                    max="10"
                    step="0.1"
                    bind:value={globalLinkStrokeWidth}
                    style="width:96px;"
                    onchange={saveNow}
                  />
                </label>

                <label class="colorField">
                  سماكة الدوائر
                  <input
                    class="input"
                    type="number"
                    min="0.1"
                    max="10"
                    step="0.1"
                    bind:value={globalPersonStrokeWidth}
                    style="width:96px;"
                    onchange={saveNow}
                  />
                </label>
              </div>
            </div>

            <div class="toolbarCard">
              <div class="toolbarCardTitle">نوع خط الأسماء</div>
              <select class="input" style="width:180px;" bind:value={fontFamily} onchange={handleFontFamilyChange}>
                <option value="Tahoma">Tahoma</option>
                <option value="Segoe UI">Segoe UI</option>
                <option value="Tajawal">Tajawal</option>
                <option value="Noto Sans Arabic">Noto Sans Arabic</option>
              </select>
            </div>
          </div>

          {#if showGuidePanel}
            <div class="toolbarCard guidePanelCard">
              <div class="guidePanelHeader">
                <div>
                  <div class="toolbarCardTitle" style="margin-bottom:4px;">🧭 طبقة الإرشاد</div>
                  <div class="guidePanelSub">إعدادات الإطار، الشبكة، والمظهر تحفظ داخل المشروع.</div>
                </div>
                <label class="guideMasterToggle">
                  <input type="checkbox" bind:checked={showWorkspaceGuides} onchange={saveNow} />
                  <span>{showWorkspaceGuides ? "مفعلة" : "مخفية"}</span>
                </label>
              </div>

              <div class="guideSection">
                <button class="guideSectionToggle" type="button" onclick={() => { guideFrameOpen = !guideFrameOpen; saveNow(); }}>
                  <span>{guideFrameOpen ? "▼" : "▶"} الإطار</span>
                  <small>الدائرة الخارجية + تقسيم الدائرة</small>
                </button>
                {#if guideFrameOpen}
                  <div class="guideSectionBody">
                    <label class="colorField">الدائرة الخارجية 85cm <input type="color" bind:value={outerGuideColor} onchange={saveNow} /></label>
                    <label class="colorField">خطوط التقسيم <input type="color" bind:value={divisionGuideColor} onchange={saveNow} /></label>
                    <label class="colorField">تقسيم الدائرة
                      <select class="input" style="width:110px;" bind:value={divisionCount} onchange={saveNow}>
                        <option value="0">بدون</option>
                        <option value="4">4</option>
                        <option value="8">8</option>
                        <option value="16">16</option>
                        <option value="32">32</option>
                        <option value="64">64</option>
                        <option value="128">128</option>
                      </select>
                    </label>
                  </div>
                {/if}
              </div>

              <div class="guideSection">
                <button class="guideSectionToggle" type="button" onclick={() => { guideGridOpen = !guideGridOpen; saveNow(); }}>
                  <span>{guideGridOpen ? "▼" : "▶"} الشبكة</span>
                  <small>الدوائر الخفيفة + كل 10mm</small>
                </button>
                {#if guideGridOpen}
                  <div class="guideSectionBody">
                    <label class="colorField">خفيف <input type="color" bind:value={workspaceGuideMinorColor} onchange={saveNow} /></label>
                    <label class="colorField">كل 10mm <input type="color" bind:value={workspaceGuideMajorColor} onchange={saveNow} /></label>
                  </div>
                {/if}
              </div>

              <div class="guideSection">
                <button class="guideSectionToggle" type="button" onclick={() => { guideAppearanceOpen = !guideAppearanceOpen; saveNow(); }}>
                  <span>{guideAppearanceOpen ? "▼" : "▶"} المظهر</span>
                  <small>طريقة ظهور طبقة الإرشاد</small>
                </button>
                {#if guideAppearanceOpen}
                  <div class="guideSectionBody">
                    <label class="colorField">سماكة الإرشاد
                      <input
                        class="input"
                        type="number"
                        min="0.1"
                        max="5"
                        step="0.1"
                        bind:value={guideStrokeWidth}
                        style="width:110px;"
                        onchange={saveNow}
                      />
                    </label>
                    <button class="btn" type="button" onclick={resetGuideLayerDefaults}>↺ استعادة الافتراضي</button>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      {#if showEditPanel}
        <div class="toolbarCard guidePanelCard">
          <div class="guidePanelHeader">
            <div>
              <div class="toolbarCardTitle" style="margin-bottom:4px;">🛠️ لوحة التحرير</div>
              <div class="guidePanelSub">أدوات التعديل تظهر بحسب العنصر المحدد: شخص أو رابط.</div>
            </div>
            <div class="projTagSub">
              {#if selectedPersonForEditPanel}
                شخص محدد
              {:else if selectedLinkForEditPanel}
                رابط محدد
              {:else}
                لا يوجد تحديد
              {/if}
            </div>
          </div>

          {#if !selectedPersonForEditPanel && !selectedLinkForEditPanel}
            <div class="guideSectionBody editPanelEmpty">
              اختر شخصاً أو رابطاً من الشجرة لتظهر أدوات التحرير هنا.
            </div>
          {/if}

          {#if selectedPersonForEditPanel}
            <div class="guideSection">
              <button class="guideSectionToggle" type="button" onclick={() => { editPersonSectionOpen = !editPersonSectionOpen; saveNow(); }}>
                <span>{editPersonSectionOpen ? "▼" : "▶"} تحرير الشخص</span>
                <small>{selectedPersonForEditPanel.name || "بدون اسم"}{selectedGroupCountForEditPanel > 1 ? ` • تحديد متعدد (${selectedGroupCountForEditPanel})` : ""}</small>
              </button>
              {#if editPersonSectionOpen}
                <div class="guideSectionBody">
                  <div class="editInfoPill">المعرف: {selectedPersonForEditPanel.id}</div>
                  <div class="editInfoPill">الجيل: {getGenerationNumberForRing(selectedPersonForEditPanel.ringId)}</div>
                  <div class="editInfoPill">القطر: {selectedPersonForEditPanel.diameterCm ?? "-"} سم</div>

                  <button class="btn" type="button" onclick={() => openPersonEditModal(selectedPersonForEditPanel)}>✏️ تعديل البيانات</button>
                  <button class="btn" type="button" onclick={toggleSelectedPersonHighlightFromPanel}>
                    {selectedPersonForEditPanel.highlightRing ? "⭕ إلغاء التمييز" : "⭕ تمييز الشخص"}
                  </button>
                  <button class="btn danger" type="button" onclick={deleteSelectedPersonFromPanel}>🗑️ حذف الشخص</button>
                </div>
              {/if}
            </div>
          {/if}

          {#if selectedLinkForEditPanel}
            <div class="guideSection">
              <button class="guideSectionToggle" type="button" onclick={() => { editLinkSectionOpen = !editLinkSectionOpen; saveNow(); }}>
                <span>{editLinkSectionOpen ? "▼" : "▶"} تحرير الرابط</span>
                <small>{selectedLinkParentForEditPanel?.name || selectedLinkForEditPanel.parentId} ← {selectedLinkChildForEditPanel?.name || selectedLinkForEditPanel.childId}</small>
              </button>
              {#if editLinkSectionOpen}
                <div class="guideSectionBody">
                  <div class="editInfoPill">من: {selectedLinkParentForEditPanel?.name || selectedLinkForEditPanel.parentId}</div>
                  <div class="editInfoPill">إلى: {selectedLinkChildForEditPanel?.name || selectedLinkForEditPanel.childId}</div>
                  <div class="editInfoPill">التعرجات: {Array.isArray(selectedLinkForEditPanel.bends) ? selectedLinkForEditPanel.bends.length : 0}</div>

                  <button class="btn" type="button" onclick={resetSelectedLinkBendsFromPanel}>↺ تصفير التعرجات</button>
                  <button class="btn danger" type="button" onclick={() => deleteLink(selectedLinkKey)}>🗑️ حذف الرابط</button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if showProjectPanel}
        <div class="toolbarCard guidePanelCard">
          <div class="guidePanelHeader">
            <div>
              <div class="toolbarCardTitle" style="margin-bottom:4px;">📁 المشروع</div>
              <div class="guidePanelSub">فتح وحفظ المشروع، وإدارة النسخ المحلية.</div>
            </div>
            <div class="projTagSub">{projectsStore?.active || "لا يوجد مشروع نشط"}</div>
          </div>

          <div class="toolbarActions">
            <button class="btn menuBtn" type="button" onclick={openDocumentPicker}>📂 فتح ملف</button>
            <button class="btn menuBtn" type="button" onclick={saveDocument}>💾 حفظ الملف</button>
            <button class="btn menuBtn" type="button" onclick={saveDocumentAs}>📝 حفظ الملف باسم</button>
            <button class="btn menuBtn" type="button" onclick={openProjects}>🗂️ المشاريع المحلية</button>
            <button class="btn menuBtn" type="button" onclick={saveActiveProject}>📌 حفظ على المشروع النشط</button>
            <button class="btn menuBtn" type="button" onclick={createEmptyFromActive}>🆕 مشروع فارغ من الحالي</button>
          </div>
        </div>
      {/if}

      {#if showLineageDiagnostics}
        <!-- ===== BEGIN: lineage diagnostics ===== -->
        <div class="toolbarCard diagCard">
          <div style="font-weight:900; margin-bottom:6px;">تشخيص النسب</div>
          <div>الشخص المحدد: {lineageDiagnostics.selectedName || "-"} {lineageDiagnostics.selectedId ? `(${lineageDiagnostics.selectedId})` : ""}</div>
          <div>عدد الأشخاص في السلسلة حتى الجذر: {lineageDiagnostics.chainIds.length}</div>
          <div>عدد الروابط في المسار: {lineageDiagnostics.chainLinkKeys.length}</div>
          <div>الحالة: {lineageDiagnostics.note}</div>
          {#if lineageDiagnostics.chainNames.length}
            <div style="margin-top:6px;">السلسلة: {lineageDiagnostics.chainNames.join(" ← ")}</div>
          {/if}
          {#if lineageDiagnostics.brokenLinks.length}
            <div style="margin-top:6px; font-weight:800;">روابط مكسورة:</div>
            {#each lineageDiagnostics.brokenLinks as item}
              <div>{item.key} | parentId غير موجود: {item.parentId}</div>
            {/each}
          {/if}
          {#if lineageDiagnostics.missingParentLinks.length}
            <div style="margin-top:6px; font-weight:800;">ملاحظات:</div>
            {#each lineageDiagnostics.missingParentLinks as item}
              <div>{item}</div>
            {/each}
          {/if}
        </div>
        <!-- ===== END: lineage diagnostics ===== -->
      {/if}
    </div>
  {/if}

  <input
    bind:this={fileOpenInputEl}
    type="file"
    accept=".ftree,.json,application/json"
    style="display:none"
    onchange={onOpenFileSelected}
  />

  <!-- ================================
       Online (Supabase) - حساب واحد
       ================================ -->
  {#if !isWorkspaceFullscreen}
    <div class="cloudBox">
      {#if !authUser}
        <div class="cloudRow">
          <input class="cloudInput" placeholder="Email" bind:value={authEmail} />
          <input class="cloudInput" type="password" placeholder="Password" bind:value={authPassword} />
          <button class="cloudBtn" type="button" onclick={cloudLogin}>دخول</button>
        </div>
      {:else}
        <div class="cloudRow">
          <div class="cloudOk">Online ✓</div>
          <button class="cloudBtn" type="button" onclick={cloudSave}>حفظ</button>
          <button class="cloudBtn" type="button" onclick={cloudLoadOrCreate}>تحميل</button>
          <button class="cloudBtn" type="button" onclick={cloudLogout}>خروج</button>
        </div>
      {/if}

      {#if cloudStatus}
        <div class="cloudStatus">{cloudStatus}</div>
      {/if}
    </div>
  {/if}

  <div class="stageWrap" class:fullscreenMode={isWorkspaceFullscreen} bind:this={workspaceFullscreenEl}>
    <div class="stage" class:fullscreenMode={isWorkspaceFullscreen} bind:this={stageEl}>
      <svg
        bind:this={svgEl}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Family Tree Workspace"
        style="touch-action:none; overflow: visible;"
        onwheel={onWheel}
        onmousemove={onMouseMove}
        onmouseleave={onMouseLeave}
        onpointermove={onPersonPointerMove}
        onpointerup={onPersonPointerUp}
        onpointercancel={onPersonPointerUp}
        ondblclick={onBoardDblClick}
        onpointerdown={onBoardPointerDown}
        onclick={(e) => {
          // إذا كان هناك Pan للتو، نتجاهل click الناتج عن السحب
          if (Date.now() - lastPanEndAt < 250) return;

          // ضغط فارغ (بدون Alt): يلغي تحديد الرابط
          if (!e.altKey && !linkMode) selectedLinkKey = null;
        }}
      >
        <!-- خلفية -->
        <rect class="boardBg" x="0" y="0" width="{WORKSPACE_MM}" height="{WORKSPACE_MM}" fill="#ffffff" />

        <!-- Zoom: نطبق كـ transform على مجموعة الرسم -->
        <g bind:this={boardContentEl} transform={`rotate(${projectRotationDeg} ${CX} ${CY})`}>
          <!-- حلقات الأجيال -->
          {#each rings as r, idx (r.id)}
            <circle class="\ringCircle\"
  cx={CX}
  cy={CY}
  r={(cmToMm(r.diameterCm) / 2)}
  fill="none"
  stroke="#000"
  stroke-width="0.5"
/>

          {/each}

          <!-- ===== BEGIN: workspace guides + lineage trace ===== -->
          {#if showWorkspaceGuides}
            <g class="noPrintGuide" pointer-events="none" aria-hidden="true">
              {#each getWorkspaceGuideRadiiMm() as guideR (guideR)}
                <circle
                  cx={CX}
                  cy={CY}
                  r={guideR}
                  fill="none"
                  stroke={isWorkspaceGuideMajor(guideR) ? workspaceGuideMajorColor : workspaceGuideMinorColor}
                  stroke-width={guideStrokeWidth}
                  opacity={isWorkspaceGuideMajor(guideR) ? "0.9" : "0.35"}
                  vector-effect="non-scaling-stroke"
                />
              {/each}
            </g>
          {/if}
          <!-- ===== END: workspace guides + lineage trace ===== -->
<circle class="\guideCircle\"
  cx={CX}
  cy={CY}
  r={getLastGuideRadiusMm()}
  fill="none"
  stroke={outerGuideColor}
  stroke-width={guideStrokeWidth}
  opacity="0.25"
  vector-effect="non-scaling-stroke"
  pointer-events="none"
/>

{#if Number(divisionCount) > 0}
  {@const n = Number(divisionCount)}
  {@const step = (Math.PI * 2) / n}

  {#each Array(n) as _, i (i)}
    {@const ang = i * step}
    {@const x2 = CX + Math.cos(ang) * getLastGuideRadiusMm()}
    {@const y2 = CY + Math.sin(ang) * getLastGuideRadiusMm()}

    <line class="guideLine"
      x1={CX}
      y1={CY}
      x2={x2}
      y2={y2}
      stroke={divisionGuideColor}
      stroke-width={guideStrokeWidth}
      opacity="0.35"
      vector-effect="non-scaling-stroke"
      pointer-events="none"
    />
  {/each}
{/if}

          <!-- الروابط -->
          {#each links as l (mkLinkKey(l))}
            {#if people.find(p => p.id === l.parentId) && people.find(p => p.id === l.childId)}
              {@const parent = people.find(p => p.id === l.parentId)}
              {@const child = people.find(p => p.id === l.childId)}
              {@const key = mkLinkKey(l)}
              {@const d = linkPathD(parent, child, l.bends || [])}

              <path
   d={d}
  fill="none"
  stroke={selectedGroupLinkKeySet.has(key) ? "#2563eb" : "#000"}
  stroke-width={selectedLinkKey === key ? globalLinkStrokeWidth + 0.8 : (selectedGroupLinkKeySet.has(key) ? globalLinkStrokeWidth + 0.4 : globalLinkStrokeWidth)}
  opacity="1"
  vector-effect="non-scaling-stroke"
  stroke-linecap="round"
  stroke-linejoin="round"
  style="cursor: pointer;"
  onpointerdown={(e) => {
    e.stopPropagation();
    selectedLinkKey = key;
    selectedPersonId = null;
    selectedPersonIds = [];
    selectedPersonIds = [];
    selectedBend = null;
  }}
  onclick={(e) => {
    e.stopPropagation();
    selectedLinkKey = key;
    selectedPersonId = null;
    selectedPersonIds = [];
    selectedPersonIds = [];
    selectedBend = null;
  }}
  oncontextmenu={(e) => {
    e.preventDefault();
    e.stopPropagation();
    selectedLinkKey = key;
  }}
/>

{#if selectedLinkKey === key}
  {@const mid = linkMidpoint(parent, child, l.bends || [])}

  <!-- زر (+) عصري لإضافة تعرّج -->
  <g
    class="bendPlus"
    transform={`translate(${mid.x} ${mid.y})`}
    onpointerdown={(e) => {
      e.stopPropagation();
      addBendToLinkAtPoint(key, mid, e.pointerId);
    }}
  >
    <!-- منطقة ضغط شفافة (لا تعيق ما خلفها) -->
    <circle class="bendPlusHit" r="12" fill="transparent" />
    <!-- علامة + رفيعة -->
    <line class="bendPlusLine" x1="-6" y1="0" x2="6" y2="0" />
    <line class="bendPlusLine" x1="0" y1="-6" x2="0" y2="6" />
  </g>

  <!-- مقابض التعرجات -->

  {#each (l.bends || []) as b, bi (bi)}
    <circle
      cx={b.x}
      cy={b.y}
      r="6"
      fill="#000"
      opacity="0.09"
      class="bendHandle"
      onpointerdown={(e) => onBendPointerDown(e, key, bi)}
      ondblclick={(e) => { e.stopPropagation(); removeBend(key, bi); }}
    />

                {/each}
              {/if}
            {/if}
          {/each}

          <!-- أرقام الأجيال -->
{#each generationMarkers as marker (marker.id)}
  {@const halfW = getMarkerHalfWidth(marker)}
  {@const halfH = getMarkerHalfHeight(marker)}
  {@const markerRotationDeg = Number(marker?.rotationDeg ?? 0) || 0}
  {@const markerTextFollowRotation = Boolean(marker?.textFollowRotation)}
  <g
    class="generationMarkerSvg"
    transform={`translate(${(marker.x || CX) - halfW} ${(marker.y || CY) - halfH})`}
    onpointerdown={(e) => onMarkerPointerDown(e, marker)}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      openMarkerEditModal(marker);
    }}
    style="cursor: grab"
  >
    <g transform={`rotate(${markerRotationDeg} ${halfW} ${halfH})`}>
      <rect
        x="0"
        y="0"
        rx={Math.min(halfH, 3)}
        ry={Math.min(halfH, 3)}
        width={halfW * 2}
        height={halfH * 2}
        fill={marker.fill || "#ffffff"}
        stroke={selectedMarkerId === marker.id ? "#2563eb" : (marker.strokeColor || "#111827")}
        stroke-width={selectedMarkerId === marker.id ? 1.8 : 1}
      />
      <text
        x={halfW}
        y={halfH}
        text-anchor="middle"
        dominant-baseline="middle"
        transform={markerTextFollowRotation ? `rotate(${-projectRotationDeg} ${halfW} ${halfH})` : `rotate(${-projectRotationDeg - markerRotationDeg} ${halfW} ${halfH})`}
        font-size={Math.max(8, Number(marker.fontPx ?? 14) || 14)}
        style={`fill:${marker.textColor || "#111827"}; font-weight:800;`}
      >{getMarkerLabel(marker)}</text>
    </g>
  </g>
{/each}

          <!-- الأشخاص -->
{#each people as p (p.id)}
  {@const rMm = cmToMm(p.diameterCm) / 2}
  {@const parts = String(p.name ?? "").trim().split(/\s+/).filter(Boolean)}
  {@const line1 = parts.length <= 2 ? (parts[0] ?? "") : parts.slice(0, Math.ceil(parts.length/2)).join(" ")}
  {@const line2 = parts.length <= 2 ? (parts[1] ?? "") : parts.slice(Math.ceil(parts.length/2)).join(" ")}

  <g
    transform={`translate(${p.x - rMm} ${p.y - rMm})`}
    onpointerdown={(e) => onPersonPointerDown(e, p)}
    ondblclick={(e) => { e.stopPropagation(); }}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
      openPersonEditModal(p);
    }}
    style="cursor: grab"
  >
    {#if p.highlightRing}
      <!-- دائرة تمييز خاصة فوق الدائرة الأصلية بزيادة 2mm على القطر -->
      <circle
        cx={rMm}
        cy={rMm}
        r={rMm + 1}
        opacity={getLineagePersonOpacity(p.id)}
        stroke="#000000"
        stroke-width="1.7"
        fill="none"
        vector-effect="non-scaling-stroke"
        pointer-events="none"

      />
    {/if}
 {#if p.highlightRing}
      <!-- دائرة تمييز الثانية خاصة فوق الدائرة الأصلية بزيادة 2mm على القطر -->
      <circle
        cx={rMm}
        cy={rMm}
        r={rMm + 3}
        opacity={getLineagePersonOpacity(p.id)}
        stroke="#000000"
        stroke-width="1.7"
        fill="none"
        vector-effect="non-scaling-stroke"
        pointer-events="none"

      />
    {/if}

    {#if selectedPersonIdSet.has(p.id)}
      <!-- دائرة تحديد للشخص المختار -->
      <circle
        cx={rMm}
        cy={rMm}
        r={rMm + 1.9}
        opacity={getLineagePersonOpacity(p.id)}
        stroke="#2563eb"
        stroke-width="1.2"
        fill="none"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
    {/if}

    <!-- ===== BEGIN: main person circle ===== -->
<circle
  cx={rMm}
  cy={rMm}
  r={rMm}
  opacity={getLineagePersonOpacity(p.id)}
  stroke={selectedPersonIdSet.has(p.id) ? "#2563eb" : "#000"}
  stroke-width={selectedPersonIdSet.has(p.id) ? globalPersonStrokeWidth + 0.8 : globalPersonStrokeWidth}
  style=""
  fill="#fff"
/>
<!-- ===== END: main person circle ===== -->


    {#if p.id === selectedPersonId}
      <line class="selCross"
        x1="0"
        y1={rMm}
        x2={rMm * 2}
        y2={rMm}
        stroke="red"
        stroke-width="0.8"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />

      <line class="selCross"
        x1={rMm}
        y1="0"
        x2={rMm}
        y2={rMm * 2}
        stroke="red"
        stroke-width="0.8"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
    {/if}

          <text
      x={rMm}
      y={rMm}
      text-anchor="middle"
      class="personTextSvg"
      opacity={getLineagePersonOpacity(p.id)}
      transform={`rotate(${-projectRotationDeg} ${rMm} ${rMm})`}
      style={`font-size:${p.fontPx}px; fill:#111827; font-weight:500; font-family:${fontFamily}, Arial, sans-serif;`}
    >
      {#if !line2}
        <tspan x={rMm} dy="0.35em">{line1}</tspan>
      {:else}
        <tspan x={rMm} dy="-0.2em">{line1}</tspan>
        <tspan x={rMm} dy="1.2em">{line2}</tspan>
      {/if}
    </text>
  </g>
{/each}
          <!-- ===== BEGIN: workspace guides + lineage trace ===== -->
          <!-- تم تجميد المسار البصري للنسب والإبقاء على السلسلة النصية فقط. -->
          <!-- ===== END: workspace guides + lineage trace ===== -->
        {#if cursor.show}
          <circle class="cursorDot"
            cx={cursor.x}
            cy={cursor.y}
            r="2.5"
            fill="#1d4ed8"
            opacity="0.85"
            pointer-events="none"
          />
        {/if}

      </svg>
    </div>
    {#if isWorkspaceFullscreen}
      <div class="fullscreenHint">اضغط Esc للخروج من ملء الشاشة</div>
    {/if}
  </div>
</div>

{#if toastMsg}
  <div class="toast">{toastMsg}</div>
{/if}

<!-- نافذة إضافة رقم جيل -->
{#if showGenerationMarkerModal}
  <div class="modalBack" onclick={closeGenerationMarkerModal}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>إضافة رقم جيل</h3>

      <div class="grid">
        <div>
          <div class="label">اختر الجيل</div>
          <select class="input" style="width:100%;" bind:value={generationMarkerRingId}>
            <option value={null}>-- اختر --</option>
            {#each rings as r, i (r.id)}
              <option value={r.id}>جيل [{formatGenerationNumber((Number(baseGenerationNumber) || 1) + i)}] ({r.diameterCm}cm)</option>
            {/each}
          </select>
        </div>
      </div>

      {#if generationMarkerErr}
        <div class="err">{generationMarkerErr}</div>
      {/if}

      <div class="actions">
        <button class="btn" type="button" onclick={closeGenerationMarkerModal}>إلغاء</button>
        <button class="btn primary" type="button" onclick={confirmGenerationMarkerModal}>إضافة</button>
      </div>
    </div>
  </div>
{/if}

<!-- نافذة تعديل رقم الجيل -->
{#if showMarkerEditModal}
  <div class="modalBack" onclick={closeMarkerEditModal}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>تعديل رقم الجيل</h3>

      <div class="grid" style="display:flex; flex-direction:column; gap:10px;">
        <div>
          <div class="label">بداية ترقيم الأجيال</div>
          <input class="input" type="number" step="1" bind:value={meBaseGenerationNumber} />
        </div>

        <div>
          <div class="label">الجيل</div>
          <select class="input" bind:value={meRingId}>
            <option value={null}>-- اختر --</option>
            {#each rings as r, i (r.id)}
              <option value={r.id}>جيل [{formatGenerationNumber((Number(meBaseGenerationNumber) || 1) + i)}]</option>
            {/each}
          </select>
        </div>

        <div style="display:flex; gap:10px;">
          <div style="flex:1;">
            <div class="label">العرض (mm)</div>
            <input class="input" type="number" step="1" bind:value={meWidthMm} />
          </div>
          <div style="flex:1;">
            <div class="label">الارتفاع (mm)</div>
            <input class="input" type="number" step="1" bind:value={meHeightMm} />
          </div>
        </div>

        <div style="display:flex; gap:10px;">
          <div style="flex:1;">
            <div class="label">حجم الخط (px)</div>
            <input class="input" type="number" step="1" bind:value={meFontPx} />
          </div>
          <div style="flex:1; display:grid; gap:6px;">
            <div class="label">المعاينة</div>
            <div style={`display:flex; justify-content:center; align-items:center; min-height:42px; border:1px solid #cbd5e1; border-radius:10px; background:${meFill || "#ffffff"}; color:${meTextColor || "#111827"}; font-weight:800; font-size:${Math.max(8, Number(meFontPx) || 14)}px;`}>
              {formatGenerationNumber(Number(meBaseGenerationNumber) || 1)}
            </div>
          </div>
        </div>

        <div>
          <div class="label">اتجاه النص</div>
          <label style="display:flex; align-items:center; gap:8px; color:#e5e7eb; font-size:13px;">
            <input type="checkbox" bind:checked={meTextFollowRotation} />
            يتبع دوران المستطيل
          </label>
        </div>

        <div style="display:flex; gap:10px;">
          <div style="flex:1;">
            <div class="label">لون الخلفية</div>
            <input class="input" type="color" bind:value={meFill} />
          </div>
          <div style="flex:1;">
            <div class="label">لون النص</div>
            <input class="input" type="color" bind:value={meTextColor} />
          </div>
          <div style="flex:1;">
            <div class="label">لون الحدود</div>
            <input class="input" type="color" bind:value={meStrokeColor} />
          </div>
        </div>
      </div>

      {#if markerEditErr}
        <div class="err">{markerEditErr}</div>
      {/if}

      <div class="actions">
        <button class="btn danger" type="button" onclick={() => deleteMarker(meId)}>حذف</button>
        <button class="btn" type="button" onclick={closeMarkerEditModal}>إلغاء</button>
        <button class="btn primary" type="button" onclick={applyMarkerEditModal}>حفظ</button>
      </div>
    </div>
  </div>
{/if}

<!-- نافذة تعديل الشخص -->
{#if showPersonEditModal}
  <div class="modalBack" onclick={closePersonEditModal}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>تعديل الشخص</h3>

      <div class="grid" style="display:flex; flex-direction:column; gap:10px;">
        <div>
          <div class="label">الاسم</div>
          <input class="input" type="text" bind:value={peName} />
        </div>

        <div style="display:flex; gap:10px;">
          <div style="flex:1;">
            <div class="label">حجم الخط (px)</div>
            <input class="input" type="number" step="1" bind:value={peFontPx} />
          </div>
          <div style="flex:1;">
            <div class="label">قطر الدائرة (cm)</div>
            <input class="input" type="number" step="0.1" bind:value={peDiameterCm} />
          </div>
        </div>

        <label style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid #cbd5e1; border-radius:12px; background:#f8fafc; color:#111827; font-weight:700;">
          <input type="checkbox" bind:checked={peHighlightRing} />
          تمييز هذا الشخص بدائرة خارجية إضافية 
        </label>
      </div>

      {#if personEditErr}
        <div class="err">{personEditErr}</div>
      {/if}

      <div style="margin-top:12px; display:flex; justify-content:flex-start;">
        <button
          class="btn danger"
          type="button"
          style="min-width:120px; font-weight:900;"
          onclick={deleteSelectedPersonFromEditModal}
        >
          🗑️ حذف الشخص
        </button>
      </div>

      <div class="actions">
        <button class="btn" type="button" onclick={closePersonEditModal}>إلغاء</button>
        <button class="btn primary" type="button" onclick={applyPersonEditModal}>حفظ</button>
      </div>
    </div>
  </div>
{/if}

<!-- نافذة الطباعة -->
{#if showPrintModal}
  <div class="modalBack" onclick={closePrintModal}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>🖨️ طباعة</h3>
      <div style="opacity:.8; font-size:13px; line-height:1.5;">
        يطبع <b>الدوائر + الروابط فقط</b> مع تكبير تلقائي لملء الورقة قدر الإمكان (بدون عنوان).
      </div>

      <div class="grid" style="margin-top:12px;">
        <div>
          <div class="label">الوضع</div>
          <select class="input" bind:value={printMode}>
            <option value="fit">ملء ورقة واحدة</option>
            <option value="poster">Poster متعدد الصفحات</option>
          </select>
        </div>

        <div>
          <div class="label">حجم الورق</div>
          <select class="input" bind:value={printPaper}>
            <option value="A4">A4</option>
            <option value="A3">A3</option>
            <option value="A2">A2</option>
            <option value="A1">A1</option>
            <option value="A0">A0</option>
          </select>
        </div>

        <div>
          <div class="label">الاتجاه</div>
          <select class="input" bind:value={printOrientation}>
            <option value="landscape">أفقي</option>
            <option value="portrait">عمودي</option>
          </select>
        </div>
      </div>

      {#if printMode === "poster"}
        {@const posterInfo = getPosterGridInfo()}
        <div class="grid" style="margin-top:12px;">
          <div>
            <div class="label">نطاق التقسيم</div>
            <select class="input" bind:value={printPosterBasis}>
              <option value="content">محتوى الرسم فقط</option>
              <option value="workspace">كل مساحة العمل</option>
            </select>
          </div>
          <div>
            <div class="label">التداخل بين الصفحات (mm)</div>
            <input class="input" type="number" min="0" max="50" step="1" bind:value={printPosterOverlapMm} />
          </div>
        </div>
        <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:10px;">
          <label><input type="checkbox" bind:checked={printPosterShowMarks} /> علامات قص</label>
          <label><input type="checkbox" bind:checked={printPosterShowPageLabels} /> ترقيم الصفحات</label>
          <div style="opacity:.82; font-size:13px;">عدد الصفحات المتوقع: <b>{posterInfo.pagesX} × {posterInfo.pagesY} = {posterInfo.totalPages}</b></div>
        </div>
      {/if}

      {#if printErr}
        <div class="err">{printErr}</div>
      {/if}

      <div class="actions">
        <button class="btn" type="button" onclick={closePrintModal}>إلغاء</button>
        <button class="btn primary" type="button" onclick={printMode === "poster" ? doPrintPoster : doPrintWorkspace}>🖨️ طباعة</button>
      </div>
    </div>
  </div>
{/if}

<!-- نافذة إضافة اسم -->
{#if showAddName}
  <div class="modalBack" onclick={closeAddName}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>إضافة اسم</h3>
      <div class="grid">
        <div>
          <div class="label">الاسم</div>
          <input class="input" style="width:100%;" bind:value={personName} />
        </div>
        <div>
          <div class="label">الجيل</div>
          <select class="input" style="width:100%;" bind:value={personRingId}>
            <option value={null}>-- اختر --</option>
            {#each rings as r (r.id)}
              <option value={r.id}>جيل ({r.diameterCm}cm)</option>
            {/each}
          </select>
        </div>
        <div>
          <div class="label">قطر الشخص (cm)</div>
          <input class="input" style="width:100%;" type="number" min="0.5" max={PERSON_DIAM_MAX_CM} step="0.1" bind:value={personDiameterCm} />
        </div>
        <div style="display:flex; gap:10px; align-items:end;">
          <button class="btn primary" type="button" onclick={addPerson}>إضافة</button>
          <button class="btn" type="button" onclick={closeAddName}>إغلاق</button>
        </div>
      </div>
      {#if nameErr}
        <div class="err">{nameErr}</div>
      {/if}
      <div class="label" style="margin-top:10px; opacity:0.8;">
        ملاحظة: يمكنك أيضًا إضافة شخص جديد بسرعة عبر دبل كلك على الفراغ داخل مساحة الرسم.
      </div>
    </div>
  </div>
{/if}
<!-- نافذة إضافة جيل -->
{#if showAddRing}
  <div class="modalBack" onclick={cancelAddRing}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>إضافة جيل</h3>

      <div class="grid">
        <div>
          <div class="label">قطر الجيل (cm)</div>
          <input
            class="input"
            style="width:100%;"
            type="number"
            min="1"
            step="0.1"
            bind:value={newRingDiameterCm}
          />
        </div>

        <div style="display:flex; gap:10px; align-items:end; justify-content:flex-end;">
          <button class="btn primary" type="button" onclick={confirmAddRing}>إضافة</button>
          <button class="btn" type="button" onclick={cancelAddRing}>إلغاء</button>
        </div>
      </div>

      {#if ringErr}
        <div class="err">{ringErr}</div>
      {/if}
    </div>
  </div>
{/if}
{#if showDeleteProjectConfirm}
  <div class="modalBack" onclick={closeDeleteProjectConfirm}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>تأكيد حذف المشروع</h3>
      <div style="display:grid; gap:10px;">
        <div>سيتم حذف المشروع التالي من التخزين المحلي:</div>
        <div style="font-weight:900; color:#991b1b;">{pendingDeleteProjectName || "-"}</div>
        <div style="font-size:13px; color:#64748b;">هذا الإجراء لا يمكن التراجع عنه من داخل النافذة.</div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn" type="button" onclick={closeDeleteProjectConfirm}>إلغاء</button>
          <button class="btn danger" type="button" onclick={confirmDeleteProjectByName}>حذف</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- نافذة تعديل الجيل -->
{#if showEditRing}
  <div class="modalBack" onclick={cancelEditRing}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <h3>تعديل الجيل</h3>

      <div class="grid">
        <div>
          <div class="label">اختر الجيل</div>
          <select class="input" style="width:100%;" bind:value={editRingId}>
            <option value={null}>-- اختر --</option>
            {#each rings as r (r.id)}
              <option value={r.id}>جيل ({r.diameterCm}cm)</option>
            {/each}
          </select>
        </div>

        <div>
          <div class="label">قطر الجيل (cm)</div>
          <input
            class="input"
            style="width:100%;"
            type="number"
            min="1"
            step="0.1"
            bind:value={editRingDiameterCm}
          />
        </div>

        <div style="display:flex; gap:10px; align-items:end;">
          <button class="btn primary" type="button" onclick={applyEditRing}>تطبيق</button>
          <button class="btn" type="button" onclick={cancelEditRing}>إلغاء</button>
        </div>
      </div>

      {#if editRingErr}
        <div class="err">{editRingErr}</div>
      {/if}
    </div>
  </div>
{/if}


