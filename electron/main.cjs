// electron/main.cjs  (أو نفس مكان ملفك الحالي)
const { app, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const sirv = require("sirv");

let server = null;

function createWindow(urlToLoad) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // ✅ مهم: بقاء LocalStorage/IndexedDB بعد الإغلاق
      partition: "persist:familytree",
      contextIsolation: true,
      // preload: path.join(__dirname, "preload.cjs"), // إذا عندك
    },
  });

  win.loadURL(urlToLoad);
}

app.whenReady().then(() => {
  const isDev = !app.isPackaged;

  if (isDev) {
    // تطوير
    createWindow("http://localhost:5173");
    return;
  }

  // ✅ إنتاج: نخدم ملفات SvelteKit المبنية
  const buildDir = path.join(app.getAppPath(), "build"); // إذا مخرجاتك مو build قلّي أعدله
  const serve = sirv(buildDir, { single: true });

  const PORT = 17777; // ✅ ثابت حتى الـ LocalStorage ما يتغيّر

  server = http.createServer((req, res) => serve(req, res));
  server.listen(PORT, "127.0.0.1", () => {
    createWindow(`http://127.0.0.1:${PORT}/`);
  });
});

// ✅ إغلاق نظيف
app.on("window-all-closed", () => {
  try {
    if (server) server.close();
  } catch {}
  if (process.platform !== "darwin") app.quit();
});

// ✅ macOS سلوك طبيعي (اختياري لكنه جيد)
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const isDev = !app.isPackaged;
    createWindow(isDev ? "http://localhost:5173" : "http://127.0.0.1:17777/");
  }
});