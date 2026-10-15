// Document changes that rewrite the PDF itself, built on pdf-lib.
// Annotation coordinates are in PDF user space (points, origin bottom-left, page unrotated).
import { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } from './vendor/pdf-lib.esm.min.js';

export const TEXT_LINE_HEIGHT = 1.2;

let measureFont = null;
/** Helvetica metrics, so on-screen text boxes match what gets written to the file. */
export async function loadMetrics() {
  const doc = await PDFDocument.create();
  measureFont = await doc.embedFont(StandardFonts.Helvetica);
}
/** Replaces characters Helvetica can't encode (outside Windows-1252) with "?". */
export function sanitizeText(s) {
  if (!measureFont) return s;
  let out = '';
  for (const ch of s) {
    if (ch === '\n') { out += ch; continue; }
    try { measureFont.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}
export function textWidth(s, size) {
  if (!measureFont) return s.length * size * 0.55;
  return measureFont.widthOfTextAtSize(sanitizeText(s), size);
}
/** Size of a text annotation in its own (upright) frame. */
export function textBlockSize(text, size) {
  const lines = text.split('\n');
  return { w: Math.max(4, ...lines.map(l => textWidth(l, size))), h: lines.length * size * TEXT_LINE_HEIGHT };
}

const hex = c => {
  const n = parseInt(c.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/**
 * For content that should look upright on a page rotated by r degrees, returns where its
 * local origin sits in user space and the content's width/height in its own frame.
 */
export function orientedFrame(box, r) {
  const { x, y, w, h } = box;
  switch (((r % 360) + 360) % 360) {
    case 90: return { ox: x + w, oy: y, iw: h, ih: w, r: 90 };
    case 180: return { ox: x + w, oy: y + h, iw: w, ih: h, r: 180 };
    case 270: return { ox: x, oy: y + h, iw: h, ih: w, r: 270 };
    default: return { ox: x, oy: y, iw: w, ih: h, r: 0 };
  }
}
function localToUser(f, lx, ly) {
  const t = f.r * Math.PI / 180, c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  return { x: f.ox + lx * c - ly * s, y: f.oy + lx * s + ly * c };
}

function dataUrlBytes(url) {
  const b64 = url.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Writes every annotation permanently into the page content and returns the new file. */
export async function flatten(bytes, annotsByPage) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const images = new Map();
  const pages = doc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    for (const a of annotsByPage[i] || []) {
      const color = hex(a.color || '#000000');
      switch (a.type) {
        case 'highlight':
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color, opacity: 0.35, blendMode: 'Multiply' });
          break;
        case 'whiteout':
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb(1, 1, 1) });
          break;
        case 'rect':
          page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: color, borderWidth: a.width });
          break;
        case 'ellipse':
          page.drawEllipse({ x: a.x + a.w / 2, y: a.y + a.h / 2, xScale: a.w / 2, yScale: a.h / 2, borderColor: color, borderWidth: a.width });
          break;
        case 'line': {
          page.drawLine({ start: { x: a.x1, y: a.y1 }, end: { x: a.x2, y: a.y2 }, thickness: a.width, color, lineCap: LineCapStyle.Round });
          for (const [hx, hy] of arrowHead(a)) {
            page.drawLine({ start: { x: a.x2, y: a.y2 }, end: { x: hx, y: hy }, thickness: a.width, color, lineCap: LineCapStyle.Round });
          }
          break;
        }
        case 'pen':
          for (let k = 1; k < a.points.length; k++) {
            const [x1, y1] = a.points[k - 1], [x2, y2] = a.points[k];
            page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width, color, lineCap: LineCapStyle.Round });
          }
          break;
        case 'text': {
          const f = orientedFrame(a, a.rotation || 0);
          const lines = sanitizeText(a.text).split('\n');
          const lh = a.size * TEXT_LINE_HEIGHT;
          lines.forEach((line, n) => {
            const baseline = f.ih - (n + 1) * lh + (lh - a.size) / 2 + a.size * 0.22;
            const p = localToUser(f, 0, baseline);
            page.drawText(line, { x: p.x, y: p.y, size: a.size, font, color, rotate: degrees(f.r) });
          });
          break;
        }
        case 'image': {
          let img = images.get(a.src);
          if (!img) { img = await doc.embedPng(dataUrlBytes(a.src)); images.set(a.src, img); }
          const f = orientedFrame(a, a.rotation || 0);
          page.drawImage(img, { x: f.ox, y: f.oy, width: f.iw, height: f.ih, rotate: degrees(f.r) });
          break;
        }
      }
    }
  }
  return doc.save();
}

export function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = Math.max(8, a.width * 4);
  return [-0.45, 0.45].map(d => [a.x2 - len * Math.cos(ang + d), a.y2 - len * Math.sin(ang + d)]);
}

async function edit(bytes, fn) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  await fn(doc);
  return doc.save();
}

export const rotatePage = (bytes, index, delta) => edit(bytes, doc => {
  const p = doc.getPage(index);
  p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
});

export const deletePage = (bytes, index) => edit(bytes, doc => doc.removePage(index));

export const movePage = (bytes, from, to) => edit(bytes, async doc => {
  const [copy] = await doc.copyPages(doc, [from]);
  doc.removePage(from);
  doc.insertPage(to, copy);
});

/** Inserts every page of another PDF at the given position. Returns the new file and page count added. */
export async function insertPdf(bytes, otherBytes, at) {
  let added = 0;
  const out = await edit(bytes, async doc => {
    const src = await PDFDocument.load(otherBytes, { ignoreEncryption: true });
    const copies = await doc.copyPages(src, src.getPageIndices());
    copies.forEach((p, k) => doc.insertPage(at + k, p));
    added = copies.length;
  });
  return { bytes: out, added };
}
