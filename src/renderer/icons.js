// Simple 24px stroke icons. Each value is the inner SVG markup.
const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  cursor: '<path d="M5 3l14 7-6 2-2 6z"/>',
  highlight: '<path d="M4 20h7"/><path d="M14.5 4.5l5 5L11 18H6v-5z"/>',
  pen: '<path d="M3 21c3-1 4-4 7-4s3 3 6 2 4-5 5-8"/><path d="M15 3l4 4"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  square: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  circle: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  redact: '<rect x="3" y="7" width="18" height="10" rx="1" fill="currentColor" fill-opacity=".25"/><path d="M3 7h18v10H3z"/>',
  sign: '<path d="M3 17c2-6 4-9 5-9s-1 9 1 9 3-5 4-5 0 4 2 4 3-2 5-2"/><path d="M3 21h18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>',
  rotl: '<path d="M3 4v5h5"/><path d="M3.5 9A8.5 8.5 0 1 1 6 17"/>',
  rotr: '<path d="M21 4v5h-5"/><path d="M20.5 9A8.5 8.5 0 1 0 18 17"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  merge: '<rect x="3" y="3" width="11" height="14" rx="1.5"/><path d="M10 7h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2M17 12v6M14 15h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
}
