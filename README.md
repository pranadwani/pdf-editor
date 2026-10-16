# PDF Editor

A desktop PDF viewer and editor for Windows, built with Electron. It works fully offline and never uploads your files.

## What it does

- **Tabs:** open several PDFs at once by drag and drop, Ctrl+O, or "Open with" from Explorer. Recent files are listed on the home screen.
- **Viewing:** page thumbnails, zoom (buttons, Ctrl+wheel, fit width), find in document with highlighted matches, and dark mode.
- **Annotating:** highlight, freehand pen, text boxes, rectangle, ellipse, arrow, whiteout, and a drawn signature. You can select, move, resize, recolor and delete what you add.
- **Pages:** rotate, delete, drag thumbnails to reorder, and insert pages from another PDF.
- **Undo and redo** for everything, plus save, Save As and print.

Annotations are written into the page content when you save, so they show up the same in every PDF reader. After saving, they can't be edited as separate objects.

## Run it

Install [Node.js](https://nodejs.org) 20 or newer, then in this folder run:

```
npm install
npm start
```

## Build a Windows installer

```
npm run dist
```

This creates the installer and a portable zip in `release/`. Building the installer works best on Windows. The portable zip also builds on Linux.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / H / P / T | Select, Highlight, Pen, Text |
| R / E / A / W | Rectangle, Ellipse, Arrow, Whiteout |
| S | Signature |
| Delete | Delete the selected annotation |
| Ctrl+Enter / Esc | Finish / cancel a text box |
| Ctrl+S, Ctrl+Shift+S | Save, Save As |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+F | Find |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / fit width |
| Ctrl+B | Toggle thumbnails |
| PageUp / PageDown | Previous / next page |

## How it's put together

- `src/main.js` is the main process. It handles windows, menus, file dialogs, safe saving (write to a temp file, then rename), recent files and theme. The page can only write to files the user opened or chose.
- `src/preload.js` is the only bridge between the page and the system: a small, fixed API.
- `src/renderer/app.js` is the UI: tabs, rendering with PDF.js, annotation tools, search, history.
- `src/renderer/pdfops.js` holds the PDF writes (save, rotate, reorder, insert), done with pdf-lib.
- `scripts/after-pack.js` locks down the packaged app: it can't be run as plain Node, it ignores NODE_OPTIONS and debugger flags, and it only loads code from its own app.asar.

## Limits

- **Whiteout covers content but doesn't remove it.** The text underneath can still be copied out. Don't use it to redact sensitive information.
- Text boxes use Helvetica, which only covers Western European characters. Other characters are saved as "?".
- There's no form filling, OCR, cloud storage, accounts or sharing.
- Password-protected PDFs can't be opened.
