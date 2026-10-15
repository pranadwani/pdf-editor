import * as pdfjsLib from './vendor/pdf.min.mjs';
import { hydrateIcons, icon } from './icons.js';
import {
  loadMetrics, textBlockSize, sanitizeText, orientedFrame, arrowHead, TEXT_LINE_HEIGHT,
  flatten, rotatePage, deletePage, movePage, insertPdf,
} from './pdfops.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDFJS_OPTS = {
  cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href, cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
};

const api = window.pdfEditor;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const COLORS = ['#111111', '#d6342b', '#1f6fd6', '#1c8a4a', '#f2c200', '#8a3fd1'];
const HIGHLIGHT_DEFAULT = '#f2c200';
const SIGNATURE_INK = '#1b2a5e';
const MAX_CANVAS_PIXELS = 16_000_000;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const state = {
  docs: [],
  active: null,
  tool: 'select',
  color: COLORS[1],
  colors: { highlight: HIGHLIGHT_DEFAULT, ink: COLORS[1] }, // highlight keeps its own color
  size: 2,
  pendingImage: null,     // signature waiting to be placed
  selected: null,         // { doc, page, index }
};

// ============================================================ utilities
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2400);
}
function status(msg) { $('#statusMsg').textContent = msg || ''; }
const clone = v => structuredClone(v);
const uid = () => Math.random().toString(36).slice(2, 10);
const normBox = (x1, y1, x2, y2) => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// ============================================================ documents
class Doc {
  constructor({ name, path, data }) {
    this.id = uid();
    this.name = name;
    this.path = path || null;
    this.bytes = data;
    this.annots = [];
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.scale = null;
    this.pdf = null;
    this.pages = [];          // { div, canvas, ink, hits, viewport, rendered, renderTask, pageProxy }
    this.textCache = new Map();
    this.hits = [];           // { page, rects:[[x1,y1,x2,y2]] }
    this.hitIndex = -1;
    this.currentPage = 0;
    this.view = document.createElement('div');
    this.view.className = 'doc-view';
    this.thumbs = document.createElement('div');
    this.thumbs.className = 'thumbs';
  }
}

async function loadIntoDoc(doc, keepScroll = false) {
  const oldScroll = keepScroll ? { top: doc.view.scrollTop, left: doc.view.scrollLeft } : null;
  if (doc.pdf) { try { await doc.pdf.destroy(); } catch {} }
  // PDF.js takes ownership of the buffer it is given, so always hand it a copy.
  doc.pdf = await pdfjsLib.getDocument({ data: doc.bytes.slice(), ...PDFJS_OPTS }).promise;
  doc.textCache.clear();
  while (doc.annots.length < doc.pdf.numPages) doc.annots.push([]);
  doc.annots.length = doc.pdf.numPages;
  if (doc.scale == null) doc.scale = await fitWidthScale(doc);
  await buildPages(doc);
  buildThumbs(doc);
  if (oldScroll) { doc.view.scrollTop = oldScroll.top; doc.view.scrollLeft = oldScroll.left; }
  updateChrome();
}

async function fitWidthScale(doc) {
  const p = await doc.pdf.getPage(Math.min(doc.currentPage + 1, doc.pdf.numPages));
  const vp = p.getViewport({ scale: 1 });
  const avail = ($('#viewer').clientWidth || 900) - 64;
  return Math.max(0.25, Math.min(3, avail / vp.width));
}

// ============================================================ page rendering
let observer = null;
function getObserver() {
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      for (const e of entries) {
        const doc = state.active;
        if (!doc || !e.isIntersecting) continue;
        const i = Number(e.target.dataset.index);
        if (doc.pages[i] && doc.pages[i].div === e.target) renderPage(doc, i);
      }
    }, { root: null, rootMargin: '600px 0px' });
  }
  return observer;
}

async function buildPages(doc) {
  const obs = getObserver();
  for (const p of doc.pages) { obs.unobserve(p.div); p.renderTask?.cancel(); }
  doc.view.innerHTML = '';
  doc.pages = [];
  for (let i = 0; i < doc.pdf.numPages; i++) {
    const pageProxy = await doc.pdf.getPage(i + 1);
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.index = i;
    div.innerHTML = '<div class="loading">Loading…</div>';
    const canvas = document.createElement('canvas'); canvas.className = 'pdf';
    const ink = document.createElement('canvas'); ink.className = 'ink';
    const hits = document.createElement('div'); hits.className = 'hits';
    div.append(canvas, hits, ink);
    doc.view.append(div);
    const entry = { div, canvas, ink, hits, pageProxy, viewport: null, rendered: 0, renderTask: null };
    doc.pages.push(entry);
    layoutPage(doc, i);
    attachInk(doc, i);
    obs.observe(div);
  }
}

function layoutPage(doc, i) {
  const p = doc.pages[i];
  p.viewport = p.pageProxy.getViewport({ scale: doc.scale });
  p.div.style.width = `${Math.floor(p.viewport.width)}px`;
  p.div.style.height = `${Math.floor(p.viewport.height)}px`;
  p.rendered = 0;
  sizeCanvas(p.ink, p.viewport);
  drawInk(doc, i);
  drawHits(doc, i);
}

function sizeCanvas(c, vp) {
  let ratio = DPR();
  if (vp.width * vp.height * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
  c.width = Math.floor(vp.width * ratio);
  c.height = Math.floor(vp.height * ratio);
  return ratio;
}

async function renderPage(doc, i) {
  const p = doc.pages[i];
  if (!p || p.rendered === doc.scale) return;
  p.rendered = doc.scale;
  p.renderTask?.cancel();
  const vp = p.viewport;
  const off = document.createElement('canvas');
  const ratio = sizeCanvas(off, vp);
  const task = p.pageProxy.render({
    canvasContext: off.getContext('2d'),
    viewport: vp,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  });
  p.renderTask = task;
  try {
    await task.promise;
    // Swap in the finished bitmap in one step so zooming never flashes a blank page.
    p.canvas.width = off.width; p.canvas.height = off.height;
    p.canvas.getContext('2d').drawImage(off, 0, 0);
    p.div.querySelector('.loading')?.remove();
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') { p.rendered = 0; console.error(err); }
  }
}

function rerenderAll(doc) {
  for (let i = 0; i < doc.pages.length; i++) layoutPage(doc, i);
  // Pages near the viewport get re-rendered immediately; the observer handles the rest on scroll.
  const vr = doc.view.getBoundingClientRect();
  doc.pages.forEach((p, i) => {
    const r = p.div.getBoundingClientRect();
    if (r.bottom > vr.top - 600 && r.top < vr.bottom + 600) renderPage(doc, i);
  });
}

// ============================================================ annotation drawing
function toView(vp, x, y) { const [vx, vy] = vp.convertToViewportPoint(x, y); return { x: vx, y: vy }; }
function boxToView(vp, b) {
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([b.x, b.y, b.x + b.w, b.y + b.h]);
  return normBox(x1, y1, x2, y2);
}
function viewToUser(vp, vx, vy) { const [x, y] = vp.convertToPdfPoint(vx, vy); return { x, y }; }
function viewBoxToUser(vp, b) {
  const a = viewToUser(vp, b.x, b.y), c = viewToUser(vp, b.x + b.w, b.y + b.h);
  return normBox(a.x, a.y, c.x, c.y);
}

const imageCache = new Map();
function getImage(src, onload) {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = onload;
    img.src = src;
    imageCache.set(src, img);
  }
  return img.complete ? img : null;
}

/** Draws annotations onto a 2D context whose coordinates match the given viewport. */
function paintAnnots(ctx, vp, list, scale, opts = {}) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  list.forEach((a, idx) => {
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = a.color || '#000';
    ctx.lineWidth = (a.width || 1) * scale;
    switch (a.type) {
      case 'highlight': {
        const b = boxToView(vp, a);
        ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        break;
      }
      case 'whiteout': {
        const b = boxToView(vp, a);
        ctx.fillStyle = '#fff'; ctx.fillRect(b.x, b.y, b.w, b.h);
        if (opts.editing) { ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.strokeRect(b.x + .5, b.y + .5, b.w - 1, b.h - 1); }
        break;
      }
      case 'rect': { const b = boxToView(vp, a); ctx.strokeRect(b.x, b.y, b.w, b.h); break; }
      case 'ellipse': {
        const b = boxToView(vp, a);
        ctx.beginPath(); ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'line': {
        const s = toView(vp, a.x1, a.y1), e = toView(vp, a.x2, a.y2);
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        for (const [hx, hy] of arrowHead(a)) { const h = toView(vp, hx, hy); ctx.moveTo(e.x, e.y); ctx.lineTo(h.x, h.y); }
        ctx.stroke();
        break;
      }
      case 'pen': {
        ctx.beginPath();
        a.points.forEach(([x, y], k) => { const v = toView(vp, x, y); k ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y); });
        if (a.points.length === 1) { const v = toView(vp, ...a.points[0]); ctx.lineTo(v.x + .01, v.y); }
        ctx.stroke();
        break;
      }
      case 'text': {
        if (opts.hideIndex === idx) break;
        const b = boxToView(vp, a);
        const size = a.size * scale, lh = size * TEXT_LINE_HEIGHT;
        ctx.font = `${size}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'alphabetic';
        sanitizeText(a.text).split('\n').forEach((line, n) => {
          ctx.fillText(line, b.x, b.y + n * lh + (lh - size) / 2 + size * 0.78);
        });
        break;
      }
      case 'image': {
        const b = boxToView(vp, a);
        const img = getImage(a.src, () => opts.onImageLoad?.());
        if (img) ctx.drawImage(img, b.x, b.y, b.w, b.h);
        break;
      }
    }
    ctx.restore();
  });
}

function drawInk(doc, i, preview = null) {
  const p = doc.pages[i];
  if (!p?.viewport) return;
  const ctx = p.ink.getContext('2d');
  const ratio = p.ink.width / p.viewport.width;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, p.viewport.width, p.viewport.height);
  const hide = editingText && editingText.doc === doc && editingText.page === i ? editingText.index : -1;
  paintAnnots(ctx, p.viewport, doc.annots[i], doc.scale, { editing: true, hideIndex: hide, onImageLoad: () => drawInk(doc, i) });
  if (preview) paintAnnots(ctx, p.viewport, [preview], doc.scale, { editing: true });
  const sel = state.selected;
  if (sel && sel.doc === doc && sel.page === i && doc.annots[i][sel.index]) {
    const b = boxToView(p.viewport, annotBounds(doc.annots[i][sel.index]));
    ctx.save();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1f6f6a';
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(b.x - 3.5, b.y - 3.5, b.w + 7, b.h + 7);
    if (isResizable(doc.annots[i][sel.index])) {
      ctx.setLineDash([]); ctx.fillStyle = '#fff';
      ctx.fillRect(b.x + b.w - 1, b.y + b.h - 1, 9, 9); ctx.strokeRect(b.x + b.w - 1, b.y + b.h - 1, 9, 9);
    }
    ctx.restore();
  }
  drawThumbInk(doc, i);
}

function annotBounds(a) {
  if (a.type === 'line') {
    const pad = a.width * 4;
    const b = normBox(a.x1, a.y1, a.x2, a.y2);
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }
  if (a.type === 'pen') {
    const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
    const pad = a.width;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}
const isResizable = a => ['image', 'rect', 'ellipse', 'highlight', 'whiteout'].includes(a.type);

function translateAnnot(a, dx, dy) {
  if (a.type === 'line') { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
  else if (a.type === 'pen') a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  else { a.x += dx; a.y += dy; }
}

// ============================================================ ink interaction
let editingText = null; // { doc, page, index|-1, el }

function attachInk(doc, i) {
  const p = doc.pages[i];
  const ink = p.ink;
  let drag = null;

  const pos = e => { const r = ink.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  ink.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const vp = p.viewport;
    const v = pos(e);
    const u = viewToUser(vp, v.x, v.y);
    commitTextEditor();

    if (state.pendingImage) {
      placeImage(doc, i, v);
      return;
    }

    const tool = state.tool;
    if (tool === 'select') {
      // Resize handle on the current selection takes priority.
      const sel = state.selected;
      if (sel && sel.doc === doc && sel.page === i) {
        const a = doc.annots[i][sel.index];
        if (a && isResizable(a)) {
          const b = boxToView(vp, annotBounds(a));
          if (Math.abs(v.x - (b.x + b.w + 3)) < 9 && Math.abs(v.y - (b.y + b.h + 3)) < 9) {
            pushUndo(doc);
            drag = { mode: 'resize', start: v, box: b, ratio: b.w / Math.max(1, b.h), a };
            ink.setPointerCapture(e.pointerId);
            return;
          }
        }
      }
      const hit = hitTest(doc, i, v);
      setSelected(hit == null ? null : { doc, page: i, index: hit });
      if (hit != null) {
        drag = { mode: 'move', last: u, moved: false, a: doc.annots[i][hit] };
        ink.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (tool === 'text') {
      // Keep the mousedown from pulling focus back off the new text box.
      e.preventDefault();
      const hit = hitTest(doc, i, v);
      if (hit != null && doc.annots[i][hit].type === 'text') openTextEditor(doc, i, hit);
      else openTextEditor(doc, i, -1, v);
      return;
    }
    ink.setPointerCapture(e.pointerId);
    const base = { id: uid(), color: state.color, width: state.size };
    if (tool === 'pen') drag = { mode: 'draw', a: { ...base, type: 'pen', points: [[u.x, u.y]] } };
    else if (tool === 'line') drag = { mode: 'draw', a: { ...base, type: 'line', x1: u.x, y1: u.y, x2: u.x, y2: u.y } };
    else drag = { mode: 'draw', start: u, a: { ...base, type: tool, x: u.x, y: u.y, w: 0, h: 0 } };
  });

  ink.addEventListener('pointermove', e => {
    if (!drag) {
      if (state.tool === 'select') ink.style.cursor = hitTest(doc, i, pos(e)) != null ? 'move' : '';
      return;
    }
    const v = pos(e);
    const u = viewToUser(p.viewport, v.x, v.y);
    if (drag.mode === 'move') {
      if (!drag.moved) { pushUndo(doc); drag.moved = true; }
      translateAnnot(drag.a, u.x - drag.last.x, u.y - drag.last.y);
      drag.last = u;
      drawInk(doc, i);
    } else if (drag.mode === 'resize') {
      let w = Math.max(6, drag.box.w + v.x - drag.start.x);
      let h = Math.max(6, drag.box.h + v.y - drag.start.y);
      if (drag.a.type === 'image') h = w / drag.ratio;
      Object.assign(drag.a, viewBoxToUser(p.viewport, { x: drag.box.x, y: drag.box.y, w, h }));
      drawInk(doc, i);
    } else {
      const a = drag.a;
      if (a.type === 'pen') {
        const last = a.points[a.points.length - 1];
        if (Math.hypot(u.x - last[0], u.y - last[1]) * doc.scale > 1.5) a.points.push([u.x, u.y]);
      } else if (a.type === 'line') { a.x2 = u.x; a.y2 = u.y; }
      else Object.assign(a, normBox(drag.start.x, drag.start.y, u.x, u.y));
      drawInk(doc, i, a);
    }
  });

  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === 'draw') {
      const a = d.a;
      const tiny = a.type === 'line' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 2
        : a.type === 'pen' ? false : (a.w < 2 || a.h < 2);
      if (!tiny) {
        pushUndo(doc);
        doc.annots[i].push(a);
        markDirty(doc);
      }
      drawInk(doc, i);
    } else if (d.mode === 'move' && d.moved || d.mode === 'resize') {
      markDirty(doc);
    }
  };
  ink.addEventListener('pointerup', end);
  ink.addEventListener('pointercancel', end);
  ink.addEventListener('dblclick', e => {
    const hit = hitTest(doc, i, pos(e));
    if (hit != null && doc.annots[i][hit].type === 'text') openTextEditor(doc, i, hit);
  });
}

function hitTest(doc, i, v) {
  const p = doc.pages[i];
  const list = doc.annots[i];
  for (let k = list.length - 1; k >= 0; k--) {
    const b = boxToView(p.viewport, annotBounds(list[k]));
    const pad = 4;
    if (v.x >= b.x - pad && v.x <= b.x + b.w + pad && v.y >= b.y - pad && v.y <= b.y + b.h + pad) return k;
  }
  return null;
}

function setSelected(sel) {
  const prev = state.selected;
  state.selected = sel;
  if (prev && prev.doc.pages[prev.page]) drawInk(prev.doc, prev.page);
  if (sel) drawInk(sel.doc, sel.page);
}

function deleteSelected() {
  const sel = state.selected;
  if (!sel) return;
  pushUndo(sel.doc);
  sel.doc.annots[sel.page].splice(sel.index, 1);
  state.selected = null;
  drawInk(sel.doc, sel.page);
  markDirty(sel.doc);
}

// ---------- text ----------
const TEXT_SIZES = { 1: 10, 2: 14, 4: 20 };

function openTextEditor(doc, i, index, at) {
  const p = doc.pages[i];
  const existing = index >= 0 ? doc.annots[i][index] : null;
  const size = existing ? existing.size : TEXT_SIZES[state.size] || 14;
  const color = existing ? existing.color : state.color;
  const el = document.createElement('textarea');
  el.className = 'text-editor';
  el.spellcheck = false;
  const px = size * doc.scale;
  el.style.fontSize = `${px}px`;
  el.style.lineHeight = String(TEXT_LINE_HEIGHT);
  el.style.color = color;
  let left, top;
  if (existing) {
    const b = boxToView(p.viewport, existing);
    left = b.x; top = b.y;
    el.value = existing.text;
  } else {
    left = at.x; top = at.y - px * TEXT_LINE_HEIGHT / 2;
  }
  el.style.left = `${left - 3}px`; el.style.top = `${top - 1}px`;
  const autosize = () => {
    el.style.width = '0px'; el.style.height = '0px';
    el.style.width = `${Math.max(60, el.scrollWidth + 8)}px`;
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener('input', autosize);
  el.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { editingText.cancel = true; commitTextEditor(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitTextEditor();
  });
  el.addEventListener('blur', () => setTimeout(commitTextEditor, 0));
  p.div.append(el);
  editingText = { doc, page: i, index, el, left, top, color, size };
  drawInk(doc, i);
  autosize();
  el.focus();
  requestAnimationFrame(() => { el.focus(); if (existing) el.select(); });
}

function commitTextEditor() {
  const t = editingText;
  if (!t) return;
  editingText = null;
  const { doc, page, index, el } = t;
  const text = el.value.replace(/\s+$/, '');
  el.remove();
  if (t.cancel) { drawInk(doc, page); return; }
  const p = doc.pages[page];
  if (!p) return;
  const list = doc.annots[page];
  if (!text) {
    if (index >= 0) { pushUndo(doc); list.splice(index, 1); markDirty(doc); }
    drawInk(doc, page);
    return;
  }
  const rotation = p.pageProxy.rotate || 0;
  const { w, h } = textBlockSize(text, t.size);
  // The box is laid out upright on screen, then converted back into page space.
  const vbox = { x: t.left, y: t.top, w: w * doc.scale, h: h * doc.scale };
  const box = viewBoxToUser(p.viewport, vbox);
  const a = { id: index >= 0 ? list[index].id : uid(), type: 'text', text, size: t.size, color: t.color, rotation, ...box };
  if (index >= 0 && list[index].text === text) { drawInk(doc, page); return; }
  pushUndo(doc);
  if (index >= 0) list[index] = a; else list.push(a);
  markDirty(doc);
  drawInk(doc, page);
}

// ---------- signature ----------
function placeImage(doc, i, v) {
  const p = doc.pages[i];
  const img = state.pendingImage;
  state.pendingImage = null;
  status('');
  const w = 180 * doc.scale, h = w * img.h / img.w;
  const box = viewBoxToUser(p.viewport, { x: v.x - w / 2, y: v.y - h / 2, w, h });
  pushUndo(doc);
  doc.annots[i].push({ id: uid(), type: 'image', src: img.src, rotation: p.pageProxy.rotate || 0, ...box });
  markDirty(doc);
  setTool('select');
  setSelected({ doc, page: i, index: doc.annots[i].length - 1 });
}

function setupSignaturePad() {
  const modal = $('#signModal');
  const pad = $('#signPad');
  const ctx = pad.getContext('2d');
  let drawing = false, last = null, empty = true;
  const reset = () => { ctx.clearRect(0, 0, pad.width, pad.height); empty = true; };
  const pos = e => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
  pad.addEventListener('pointerdown', e => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); });
  pad.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx.strokeStyle = SIGNATURE_INK;
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; empty = false;
  });
  pad.addEventListener('pointerup', () => { drawing = false; });
  $('#signClear').onclick = reset;
  $('#signCancel').onclick = () => { modal.hidden = true; };
  $('#signUse').onclick = () => {
    if (empty) { toast('Draw a signature first.'); return; }
    const cropped = cropCanvas(pad);
    state.pendingImage = cropped;
    modal.hidden = true;
    status('Click on a page to place your signature. Esc cancels.');
  };
  return () => {
    if (!state.active) { toast('Open a PDF first.'); return; }
    reset(); modal.hidden = false;
  };
}

function cropCanvas(c) {
  const { width, height } = c;
  const data = c.getContext('2d').getImageData(0, 0, width, height).data;
  let x1 = width, y1 = height, x2 = 0, y2 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 0) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  }
  const pad = 6;
  x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(width, x2 + pad); y2 = Math.min(height, y2 + pad);
  const out = document.createElement('canvas');
  out.width = x2 - x1; out.height = y2 - y1;
  out.getContext('2d').drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL('image/png'), w: out.width, h: out.height };
}

// ============================================================ thumbnails
let thumbObserver = null;
function buildThumbs(doc) {
  thumbObserver ||= new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) renderThumb(state.active, Number(e.target.dataset.index));
  }, { root: $('#sidebar'), rootMargin: '300px 0px' });
  for (const t of doc.thumbs.children) thumbObserver.unobserve(t);
  doc.thumbs.innerHTML = '';
  doc.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.index = i;
    t.draggable = true;
    const vp = p.pageProxy.getViewport({ scale: 1 });
    const w = 150, h = Math.round(w * vp.height / vp.width);
    t.innerHTML = `<canvas width="${w}" height="${h}" style="width:${w}px;height:${h}px"></canvas><span class="num">${i + 1}</span>`;
    t.addEventListener('click', () => scrollToPage(doc, i));
    t.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-pdf-page', String(i)); t.classList.add('dragging'); });
    t.addEventListener('dragend', () => t.classList.remove('dragging'));
    t.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-pdf-page')) { e.preventDefault(); t.classList.add('drop-before'); } });
    t.addEventListener('dragleave', () => t.classList.remove('drop-before'));
    t.addEventListener('drop', e => {
      t.classList.remove('drop-before');
      const from = Number(e.dataTransfer.getData('text/x-pdf-page'));
      if (Number.isNaN(from)) return;
      e.preventDefault(); e.stopPropagation();
      let to = i > from ? i - 1 : i;
      if (from !== to) reorderPage(doc, from, to);
    });
    doc.thumbs.append(t);
    thumbObserver.observe(t);
  });
  // Dropping below the last thumbnail moves the page to the end.
  doc.thumbs.ondragover = e => { if (e.target === doc.thumbs && e.dataTransfer.types.includes('text/x-pdf-page')) e.preventDefault(); };
  doc.thumbs.ondrop = e => {
    if (e.target !== doc.thumbs) return;
    const from = Number(e.dataTransfer.getData('text/x-pdf-page'));
    const to = doc.pages.length - 1;
    if (!Number.isNaN(from) && from !== to) reorderPage(doc, from, to);
  };
}

const thumbBase = new WeakMap();
async function renderThumb(doc, i) {
  if (!doc) return;
  const t = doc.thumbs.children[i];
  const p = doc.pages[i];
  if (!t || !p || t.dataset.done) return;
  t.dataset.done = '1';
  const c = t.querySelector('canvas');
  const vp = p.pageProxy.getViewport({ scale: c.width / p.pageProxy.getViewport({ scale: 1 }).width });
  const off = document.createElement('canvas'); off.width = c.width; off.height = c.height;
  try {
    await p.pageProxy.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    thumbBase.set(c, { off, vp });
    drawThumbInk(doc, i);
  } catch { delete t.dataset.done; }
}
function drawThumbInk(doc, i) {
  const t = doc.thumbs.children[i];
  const c = t?.querySelector('canvas');
  const base = c && thumbBase.get(c);
  if (!base) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(base.off, 0, 0);
  paintAnnots(ctx, base.vp, doc.annots[i], base.vp.scale);
}

// ============================================================ history
function pushUndo(doc) {
  doc.undoStack.push({ bytes: doc.bytes, annots: clone(doc.annots) });
  if (doc.undoStack.length > 100) doc.undoStack.shift();
  doc.redoStack = [];
  updateChrome();
}
async function restore(doc, from, to) {
  const snap = from.pop();
  if (!snap) return;
  commitTextEditor();
  to.push({ bytes: doc.bytes, annots: clone(doc.annots) });
  const structural = snap.bytes !== doc.bytes;
  doc.bytes = snap.bytes;
  doc.annots = snap.annots;
  state.selected = null;
  markDirty(doc);
  if (structural) await loadIntoDoc(doc, true);
  else doc.pages.forEach((_, i) => drawInk(doc, i));
}
const undo = () => state.active && restore(state.active, state.active.undoStack, state.active.redoStack);
const redo = () => state.active && restore(state.active, state.active.redoStack, state.active.undoStack);

function markDirty(doc, v = true) {
  doc.dirty = v;
  api.setDirty(state.docs.some(d => d.dirty));
  renderTabs();
  updateChrome();
}

// ============================================================ page operations
async function structural(doc, label, fn) {
  commitTextEditor();
  try {
    status(label + '…');
    pushUndo(doc);
    await fn();
    state.selected = null;
    markDirty(doc);
    await loadIntoDoc(doc, true);
    status('');
  } catch (err) {
    doc.undoStack.pop();
    console.error(err);
    status('');
    toast(`${label} failed: ${err.message || err}`, true);
  }
}

function rotateCurrent(delta) {
  const doc = state.active; if (!doc) return;
  const i = doc.currentPage;
  structural(doc, 'Rotating page', async () => { doc.bytes = await rotatePage(doc.bytes, i, delta); });
}
function deleteCurrent() {
  const doc = state.active; if (!doc) return;
  if (doc.pages.length <= 1) { toast('A PDF needs at least one page.'); return; }
  const i = doc.currentPage;
  structural(doc, 'Deleting page', async () => {
    doc.bytes = await deletePage(doc.bytes, i);
    doc.annots.splice(i, 1);
    doc.currentPage = Math.min(i, doc.annots.length - 1);
  });
}
function reorderPage(doc, from, to) {
  structural(doc, 'Moving page', async () => {
    doc.bytes = await movePage(doc.bytes, from, to);
    const [a] = doc.annots.splice(from, 1);
    doc.annots.splice(to, 0, a);
    doc.currentPage = to;
  });
}
async function mergeInto(picked) {
  const doc = state.active; if (!doc) { toast('Open a PDF first.'); return; }
  const files = picked || await api.openDialog();
  if (!files.length) return;
  let at = doc.currentPage + 1;
  structural(doc, 'Inserting pages', async () => {
    for (const f of files) {
      const r = await insertPdf(doc.bytes, f.data, at);
      doc.bytes = r.bytes;
      doc.annots.splice(at, 0, ...Array.from({ length: r.added }, () => []));
      at += r.added;
    }
  }).then(() => files.length && toast(`Inserted ${files.map(f => f.name).join(', ')}`));
}

// ============================================================ save & print
async function save(doc = state.active, forceAs = false) {
  if (!doc) return;
  commitTextEditor();
  try {
    status('Saving…');
    const out = await flatten(doc.bytes, doc.annots);
    if (doc.path && !forceAs) {
      await api.save(doc.path, out);
    } else {
      const r = await api.saveAs(doc.name.replace(/\.pdf$/i, '') + (doc.path ? ' (edited)' : '') + '.pdf', out);
      if (!r) { status(''); return; }
      doc.path = r.path; doc.name = r.name;
    }
    markDirty(doc, false);
    status('');
    toast(`Saved ${doc.name}`);
  } catch (err) {
    console.error(err);
    status('');
    toast(`Couldn't save: ${err.message || err}`, true);
  }
}

async function printDoc() {
  const doc = state.active; if (!doc) return;
  commitTextEditor();
  status('Preparing to print…');
  const area = $('#printArea');
  area.innerHTML = '';
  let tmp;
  try {
    const out = await flatten(doc.bytes, doc.annots);
    tmp = await pdfjsLib.getDocument({ data: out, ...PDFJS_OPTS }).promise;
    for (let n = 1; n <= tmp.numPages; n++) {
      const page = await tmp.getPage(n);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
      const img = new Image();
      img.src = c.toDataURL('image/jpeg', 0.92);
      await img.decode();
      area.append(img);
    }
    status('');
    await api.print();
  } catch (err) {
    console.error(err);
    toast(`Couldn't print: ${err.message || err}`, true);
  } finally {
    status('');
    area.innerHTML = '';
    tmp?.destroy();
  }
}

// ============================================================ search
let searchTimer;
async function runSearch(query) {
  const doc = state.active;
  if (!doc) return;
  doc.hits = []; doc.hitIndex = -1;
  const q = query.trim().toLowerCase();
  if (!q) { doc.pages.forEach((_, i) => drawHits(doc, i)); $('#searchCount').textContent = ''; return; }
  const token = (doc.searchToken = uid());
  for (let i = 0; i < doc.pages.length; i++) {
    let tc = doc.textCache.get(i);
    if (!tc) { tc = await doc.pages[i].pageProxy.getTextContent(); doc.textCache.set(i, tc); }
    if (doc.searchToken !== token) return;
    // Join text runs into one string, remembering which run each character came from.
    let full = '';
    const owner = [];
    tc.items.forEach((it, k) => {
      if (!it.str) return;
      for (let c = 0; c < it.str.length; c++) owner.push([k, c]);
      full += it.str;
      if (it.hasEOL) { full += ' '; owner.push(null); }
    });
    const lower = full.toLowerCase();
    let from = 0, at;
    while ((at = lower.indexOf(q, from)) !== -1) {
      const rects = new Map();
      for (let c = at; c < at + q.length; c++) {
        const o = owner[c]; if (!o) continue;
        const r = rects.get(o[0]) || { k: o[0], s: o[1], e: o[1] };
        r.e = o[1]; rects.set(o[0], r);
      }
      const boxes = [...rects.values()].map(({ k, s, e }) => {
        const it = tc.items[k];
        const [a, b, , , x, y] = it.transform;
        const fontH = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        const len = it.str.length || 1;
        const angle = Math.atan2(b, a);
        const x1 = x + it.width * (s / len) * Math.cos(angle);
        const x2 = x + it.width * ((e + 1) / len) * Math.cos(angle);
        return [x1, y - fontH * 0.22, x2, y + fontH * 0.85];
      });
      doc.hits.push({ page: i, boxes });
      from = at + q.length;
    }
  }
  doc.pages.forEach((_, i) => drawHits(doc, i));
  if (doc.hits.length) gotoHit(0);
  else { $('#searchCount').textContent = '0/0'; }
}
function drawHits(doc, i) {
  const p = doc.pages[i];
  if (!p?.viewport) return;
  p.hits.innerHTML = '';
  doc.hits.forEach((h, n) => {
    if (h.page !== i) return;
    for (const r of h.boxes) {
      const [x1, y1, x2, y2] = p.viewport.convertToViewportRectangle(r);
      const el = document.createElement('div');
      el.className = 'hit' + (n === doc.hitIndex ? ' current' : '');
      Object.assign(el.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
      p.hits.append(el);
    }
  });
}
function gotoHit(n) {
  const doc = state.active;
  if (!doc || !doc.hits.length) return;
  const prev = doc.hits[doc.hitIndex];
  doc.hitIndex = (n + doc.hits.length) % doc.hits.length;
  const h = doc.hits[doc.hitIndex];
  if (prev) drawHits(doc, prev.page);
  drawHits(doc, h.page);
  $('#searchCount').textContent = `${doc.hitIndex + 1}/${doc.hits.length}`;
  const el = doc.pages[h.page].hits.querySelector('.current');
  (el || doc.pages[h.page].div).scrollIntoView({ block: 'center', inline: 'nearest' });
}

// ============================================================ tabs & chrome
async function openFiles(files) {
  for (const f of files) {
    const existing = f.path && state.docs.find(d => d.path === f.path);
    if (existing) { activate(existing); continue; }
    const doc = new Doc(f);
    try {
      state.docs.push(doc);
      $('#viewer').append(doc.view);
      $('#sidebar').append(doc.thumbs);
      activate(doc);
      await loadIntoDoc(doc);
      activate(doc);
    } catch (err) {
      console.error(err);
      closeDoc(doc, true);
      const msg = err?.name === 'PasswordException' ? 'it is password-protected' : (err.message || err);
      toast(`Couldn't open ${f.name}: ${msg}`, true);
    }
  }
}
async function openPaths(paths) {
  const files = [];
  for (const p of paths) {
    try { files.push(await api.readPath(p)); }
    catch (err) { toast(`Couldn't open ${p}: ${err.message || err}`, true); }
  }
  if (files.length) openFiles(files);
}
async function openDialog() {
  try { const files = await api.openDialog(); if (files.length) openFiles(files); }
  catch (err) { toast(`Couldn't open: ${err.message || err}`, true); }
}

function activate(doc) {
  commitTextEditor();
  state.active = doc;
  state.selected = null;
  for (const d of state.docs) {
    d.view.hidden = d !== doc;
    d.thumbs.hidden = d !== doc;
  }
  if (doc) {
    const q = $('#searchInput').value;
    $('#searchCount').textContent = doc.hits.length ? `${doc.hitIndex + 1}/${doc.hits.length}` : '';
    if (q && !doc.hits.length) { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q), 50); }
    if (doc.pdf) requestAnimationFrame(() => rerenderAll(doc));
  }
  renderTabs();
  updateChrome();
}

function closeDoc(doc, force = false) {
  if (!force && doc.dirty && !confirm(`"${doc.name}" has unsaved changes. Close it anyway?`)) return;
  const idx = state.docs.indexOf(doc);
  state.docs.splice(idx, 1);
  doc.pages.forEach(p => { getObserver().unobserve(p.div); p.renderTask?.cancel(); });
  doc.view.remove(); doc.thumbs.remove();
  doc.pdf?.destroy();
  api.setDirty(state.docs.some(d => d.dirty));
  if (state.active === doc) activate(state.docs[Math.min(idx, state.docs.length - 1)] || null);
  else renderTabs();
  if (!state.docs.length) showHome();
}

function renderTabs() {
  const wrap = $('#tabs');
  wrap.innerHTML = '';
  for (const d of state.docs) {
    const t = document.createElement('div');
    t.className = 'tab' + (d === state.active ? ' active' : '');
    t.setAttribute('role', 'tab');
    t.title = d.path || d.name;
    t.innerHTML = `${d.dirty ? '<span class="dot" title="Unsaved changes"></span>' : ''}<span class="name"></span><button class="close" title="Close (Ctrl+W)">${icon('close')}</button>`;
    t.querySelector('.name').textContent = d.name;
    t.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeDoc(d); } });
    t.addEventListener('click', e => { if (e.target.closest('.close')) closeDoc(d); else if (d !== state.active) activate(d); });
    wrap.append(t);
  }
  $('#home').hidden = state.docs.length > 0;
  document.title = state.active ? `${state.active.name}${state.active.dirty ? ' •' : ''} — PDF Editor` : 'PDF Editor';
}

function updateChrome() {
  const doc = state.active;
  const has = !!(doc && doc.pdf);
  for (const id of ['btnSave', 'btnPrint', 'btnRotL', 'btnRotR', 'btnDelPage', 'btnMerge', 'btnZoomIn', 'btnZoomOut', 'btnSign'])
    $('#' + id).disabled = !has;
  $('#btnUndo').disabled = !doc || !doc.undoStack.length;
  $('#btnRedo').disabled = !doc || !doc.redoStack.length;
  $('#zoomLabel').textContent = has ? `${Math.round(doc.scale * 100)}%` : '—';
  $('#statusPage').textContent = has ? `Page ${doc.currentPage + 1} of ${doc.pages.length}` : 'No document';
  $('#pageTotal').textContent = has ? `· ${doc.pages.length}` : '';
  $('#statusSaved').textContent = has ? (doc.dirty ? 'Unsaved changes' : (doc.path ? 'Saved' : '')) : '';
  if (has) [...doc.thumbs.children].forEach((t, i) => t.classList.toggle('active', i === doc.currentPage));
}

function scrollToPage(doc, i) {
  const p = doc.pages[i];
  if (!p) return;
  doc.view.scrollTo({ top: p.div.offsetTop - 16, behavior: 'smooth' });
  doc.currentPage = i;
  updateChrome();
}

function trackCurrentPage() {
  const doc = state.active;
  if (!doc || !doc.pages.length) return;
  const top = doc.view.scrollTop + doc.view.clientHeight * 0.35;
  let cur = 0;
  for (let i = 0; i < doc.pages.length; i++) { if (doc.pages[i].div.offsetTop <= top) cur = i; else break; }
  if (cur !== doc.currentPage) {
    doc.currentPage = cur;
    updateChrome();
    doc.thumbs.children[cur]?.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- zoom ----------
function setZoom(doc, scale, anchor) {
  if (!doc) return;
  scale = Math.max(0.25, Math.min(4, scale));
  if (Math.abs(scale - doc.scale) < 0.001) return;
  commitTextEditor();
  const v = doc.view;
  const ax = anchor ? anchor.x : v.clientWidth / 2, ay = anchor ? anchor.y : v.clientHeight / 2;
  const fx = (v.scrollLeft + ax) / doc.scale, fy = (v.scrollTop + ay) / doc.scale;
  doc.scale = scale;
  rerenderAll(doc);
  v.scrollLeft = fx * scale - ax;
  v.scrollTop = fy * scale - ay;
  updateChrome();
}
const zoomStep = dir => {
  const doc = state.active; if (!doc) return;
  const s = doc.scale;
  const next = dir > 0 ? ZOOM_STEPS.find(z => z > s + 0.01) : [...ZOOM_STEPS].reverse().find(z => z < s - 0.01);
  setZoom(doc, next ?? s);
};
async function fitWidth() { const doc = state.active; if (doc?.pdf) setZoom(doc, await fitWidthScale(doc)); }

// ---------- tools ----------
function setTool(tool) {
  commitTextEditor();
  state.tool = tool;
  state.pendingImage = null;
  if (tool !== 'select') setSelected(null);
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  $('#viewer').dataset.tool = tool;
  setColor(state.colors[tool === 'highlight' ? 'highlight' : 'ink'], false);
}
function setColor(c, recolorSelection = true) {
  state.color = c;
  state.colors[state.tool === 'highlight' ? 'highlight' : 'ink'] = c;
  $$('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === c));
  const sel = state.selected;
  if (sel && recolorSelection) {
    const a = sel.doc.annots[sel.page][sel.index];
    if (a && a.type !== 'image' && a.type !== 'whiteout' && a.color !== c) {
      pushUndo(sel.doc); a.color = c; markDirty(sel.doc); drawInk(sel.doc, sel.page);
    }
  }
}

// ---------- theme ----------
let theme = 'system';
function applyTheme() {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#btnTheme').innerHTML = icon(dark ? 'sun' : 'moon');
}
async function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  theme = await api.setTheme(dark ? 'light' : 'dark');
  applyTheme();
}

// ---------- home ----------
async function showHome() {
  const s = await api.getSettings();
  const list = $('#recentList');
  list.innerHTML = '';
  const recent = s.recent || [];
  $('#recentWrap').hidden = !recent.length;
  for (const p of recent) {
    const li = document.createElement('li');
    const name = p.split(/[\\/]/).pop();
    li.innerHTML = `<span data-icon="file"></span><span class="r-name"></span><span class="r-path"></span><button class="icon-btn small r-remove" title="Remove from list">${icon('close')}</button>`;
    li.querySelector('.r-name').textContent = name;
    li.querySelector('.r-path').textContent = p;
    li.addEventListener('click', async e => {
      if (e.target.closest('.r-remove')) { e.stopPropagation(); await api.removeRecent(p); showHome(); return; }
      openPaths([p]);
    });
    list.append(li);
  }
  hydrateIcons(list);
}

// ============================================================ wiring
function wire() {
  hydrateIcons();
  const sw = $('#swatches');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.color = c; b.style.background = c; b.title = c;
    b.onclick = () => setColor(c);
    sw.append(b);
  }
  setColor(state.color);

  $('#btnOpen').onclick = openDialog;
  $('#btnNewTab').onclick = openDialog;
  $('#btnHomeOpen').onclick = openDialog;
  $('#btnSave').onclick = () => save();
  $('#btnPrint').onclick = printDoc;
  $('#btnSidebar').onclick = () => $('#sidebar').classList.toggle('collapsed');
  $$('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('#strokeSize').onchange = e => { state.size = Number(e.target.value); };
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnRotL').onclick = () => rotateCurrent(-90);
  $('#btnRotR').onclick = () => rotateCurrent(90);
  $('#btnDelPage').onclick = deleteCurrent;
  $('#btnMerge').onclick = () => mergeInto();
  $('#btnZoomIn').onclick = () => zoomStep(1);
  $('#btnZoomOut').onclick = () => zoomStep(-1);
  $('#zoomLabel').onclick = fitWidth;
  $('#btnTheme').onclick = toggleTheme;
  const openSign = setupSignaturePad();
  $('#btnSign').onclick = openSign;

  const si = $('#searchInput');
  si.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(si.value), 220); });
  si.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const d = state.active; if (d) gotoHit(d.hitIndex + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { si.value = ''; runSearch(''); si.blur(); }
  });
  $('#btnNextHit').onclick = () => state.active && gotoHit(state.active.hitIndex + 1);
  $('#btnPrevHit').onclick = () => state.active && gotoHit(state.active.hitIndex - 1);

  // Scroll tracking and ctrl+wheel zoom, delegated from the viewer to whichever document is showing.
  $('#viewer').addEventListener('scroll', trackCurrentPage, { capture: true, passive: true });
  $('#viewer').addEventListener('wheel', e => {
    if (!e.ctrlKey || !state.active) return;
    e.preventDefault();
    const r = state.active.view.getBoundingClientRect();
    setZoom(state.active, state.active.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.active && rerenderAll(state.active), 150); });

  document.addEventListener('keydown', e => {
    if (isTyping(e)) return;
    if (e.key === 'Escape') {
      if (!$('#signModal').hidden) { $('#signModal').hidden = true; return; }
      if (state.pendingImage) { state.pendingImage = null; status(''); return; }
      setSelected(null); setTool('select'); return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); deleteSelected(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (api.isBrowserShim) handleShortcut(e);
      return;
    }
    const map = { v: 'select', h: 'highlight', p: 'pen', t: 'text', r: 'rect', e: 'ellipse', a: 'line', w: 'whiteout' };
    const k = e.key.toLowerCase();
    if (map[k] && state.active) setTool(map[k]);
    else if (k === 's' && state.active) openSign();
    else if (e.key === 'PageDown' || e.key === 'PageUp') {
      const d = state.active; if (d) { e.preventDefault(); scrollToPage(d, Math.max(0, Math.min(d.pages.length - 1, d.currentPage + (e.key === 'PageDown' ? 1 : -1)))); }
    }
  });

  // Drag and drop PDFs from the file manager anywhere onto the window.
  const dz = $('#dropzone');
  window.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dz.classList.add('over'); }
  });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) dz.classList.remove('over'); });
  window.addEventListener('drop', async e => {
    dz.classList.remove('over');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => /\.pdf$/i.test(f.name));
    if (!files.length) { toast('Only PDF files can be opened.'); return; }
    const paths = files.map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length === files.length) openPaths(paths);
    else openFiles(await Promise.all(files.map(async f => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) }))));
  });

  api.onMenu(runCommand);
  api.onOpenPaths(openPaths);
}

function runCommand(name) {
  const doc = state.active;
  const cmds = {
    open: openDialog, save: () => save(), saveAs: () => save(doc, true), merge: () => mergeInto(), print: printDoc,
    closeTab: () => doc && closeDoc(doc), undo, redo,
    find: () => { $('#searchInput').focus(); $('#searchInput').select(); },
    zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1), fitWidth,
    sidebar: () => $('#sidebar').classList.toggle('collapsed'), theme: toggleTheme,
  };
  cmds[name]?.();
}
function handleShortcut(e) {
  const k = e.key.toLowerCase();
  const map = { o: 'open', s: e.shiftKey ? 'saveAs' : 'save', p: 'print', w: 'closeTab', z: 'undo', y: 'redo', f: 'find', '=': 'zoomIn', '-': 'zoomOut', '0': 'fitWidth', b: 'sidebar' };
  if (map[k]) { e.preventDefault(); runCommand(map[k]); }
}

// ============================================================ start
(async function start() {
  wire();
  setTool('select');
  try { await loadMetrics(); } catch (err) { console.warn('Font metrics unavailable', err); }
  const s = await api.getSettings();
  theme = s.theme || 'system';
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  renderTabs();
  updateChrome();
  showHome();
})();

// Exposed for automated tests only.
window.__pdfEditor = { state, openFiles, mergeInto, openTextEditor, commitTextEditor, placeImage, save, setTool, setZoom, runSearch, rotateCurrent, deleteCurrent, reorderPage, undo, redo, flatten };
