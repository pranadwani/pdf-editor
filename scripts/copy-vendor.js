// Copies the PDF libraries into src/renderer/vendor so the packaged app
// does not need node_modules at runtime.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['node_modules/pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js'],
];
for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, from), path.join(out, to));
}
// Standard fonts and character maps let PDF.js render PDFs that do not embed their fonts.
for (const dir of ['standard_fonts', 'cmaps']) {
  fs.cpSync(path.join(root, 'node_modules/pdfjs-dist', dir), path.join(out, dir), { recursive: true });
}
console.log('Vendor files copied to', path.relative(root, out));
