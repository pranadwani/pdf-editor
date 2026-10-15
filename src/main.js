'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const fs = require('fs/promises');
const path = require('path');

let win = null;
let hasUnsaved = false;
const pendingOpen = [];            // files passed before the window was ready
const writablePaths = new Set();   // paths the user opened or chose, so the renderer can't write elsewhere
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// ---------- settings (recent files, theme) ----------
async function loadSettings() {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')); }
  catch { return { recent: [], theme: 'system' }; }
}
async function saveSettings(s) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2));
}
async function addRecent(p) {
  const s = await loadSettings();
  s.recent = [p, ...(s.recent || []).filter(x => x !== p)].slice(0, 12);
  await saveSettings(s);
  app.addRecentDocument(p);
}

const isPdf = p => typeof p === 'string' && path.extname(p).toLowerCase() === '.pdf';

async function readPdf(p) {
  if (!isPdf(p)) throw new Error('Only PDF files can be opened.');
  const data = await fs.readFile(p);
  writablePaths.add(path.resolve(p));
  await addRecent(p);
  return { name: path.basename(p), path: p, data: new Uint8Array(data) };
}

function sendOpen(paths) {
  const pdfs = paths.filter(isPdf);
  if (!pdfs.length) return;
  if (win && win.webContents && !win.webContents.isLoading()) {
    win.webContents.send('open-paths', pdfs);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else pendingOpen.push(...pdfs);
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 760, minHeight: 500,
    title: 'PDF Editor',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d21' : '#f4f2ee',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen.length) win.webContents.send('open-paths', pendingOpen.splice(0));
  });
  // Never navigate away from the app or open new windows; send links to the default browser.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', e => {
    if (!hasUnsaved) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Some documents have unsaved changes.',
      detail: 'If you close now, your edits will be lost.',
    });
    if (choice !== 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

function cmd(name) { return () => win && win.webContents.send('menu', name); }

function buildMenu() {
  const template = [
    { label: 'File', submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveAs') },
      { label: 'Insert Pages from PDF…', click: cmd('merge') },
      { type: 'separator' },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd('print') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('closeTab') },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: cmd('redo') },
      { type: 'separator' },
      { role: 'copy' }, { role: 'paste' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
    ]},
    { label: 'View', submenu: [
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoomIn') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoomOut') },
      { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: cmd('fitWidth') },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: cmd('sidebar') },
      { label: 'Toggle Dark Mode', click: cmd('theme') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools', visible: !app.isPackaged },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readPdf));
});

ipcMain.handle('read-path', async (_e, p) => readPdf(p));

ipcMain.handle('save', async (_e, { path: p, data }) => {
  const abs = path.resolve(p);
  if (!writablePaths.has(abs) || !isPdf(abs)) throw new Error('Saving to that location was not allowed.');
  // Write to a temp file first, then swap it in, so a crash mid-write can't corrupt the original.
  const tmp = abs + '.pdfeditor-tmp';
  await fs.writeFile(tmp, Buffer.from(data));
  await fs.rename(tmp, abs);
  return true;
});

ipcMain.handle('save-as', async (_e, { suggestedName, data }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName || 'document.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const p = isPdf(r.filePath) ? r.filePath : r.filePath + '.pdf';
  await fs.writeFile(p, Buffer.from(data));
  writablePaths.add(path.resolve(p));
  await addRecent(p);
  return { path: p, name: path.basename(p) };
});

ipcMain.handle('get-settings', loadSettings);
ipcMain.handle('set-theme', async (_e, theme) => {
  const s = await loadSettings();
  s.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  nativeTheme.themeSource = s.theme;
  await saveSettings(s);
  return s.theme;
});
ipcMain.handle('remove-recent', async (_e, p) => {
  const s = await loadSettings();
  s.recent = (s.recent || []).filter(x => x !== p);
  await saveSettings(s);
  return s.recent;
});
ipcMain.on('dirty', (_e, v) => { hasUnsaved = !!v; });
ipcMain.handle('print', async () => new Promise(res =>
  win.webContents.print({ printBackground: true }, ok => res(ok))));
ipcMain.handle('show-in-folder', (_e, p) => { if (writablePaths.has(path.resolve(p))) shell.showItemInFolder(p); });

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => sendOpen(argv.slice(1)));
  app.on('open-file', (e, p) => { e.preventDefault(); sendOpen([p]); }); // macOS
  app.whenReady().then(async () => {
    const s = await loadSettings();
    nativeTheme.themeSource = s.theme || 'system';
    buildMenu();
    createWindow();
    sendOpen(process.argv.slice(app.isPackaged ? 1 : 2));
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}
