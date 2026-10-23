// v3.3 screenshot import: the image side. Decode (EXIF orientation applied), downscale on a
// canvas, re-encode, and a full-screen viewer for comparing the draft with the screenshot.
// Nothing here stores the image: it lives in memory (a Blob, a data URL, one object URL that
// the composer revokes) and only goes to POST /reddit/import.
import { h, ICONS } from '/agent-reddit/ui.js';
import { downscaleSize, IMPORT_MAX_EDGE } from '/agent-reddit/tree.js';

const fail = code => Object.assign(new Error(code), { code });

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(file, { imageOrientation: 'from-image' }); return { src: b, w: b.width, h: b.height, done: () => b.close?.() }; } catch { /* option unsupported or not decodable */ }
    try { const b = await createImageBitmap(file); return { src: b, w: b.width, h: b.height, done: () => b.close?.() }; } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw fail('type');
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw fail('type');
  }
}

const toBlob = (canvas, type, q) => new Promise(res => { try { canvas.toBlob(b => res(b), type, q); } catch { res(null); } });
const toDataUrl = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(fail('type'));
  r.readAsDataURL(blob);
});

// File -> { blob, dataUrl, width, height }: long edge <= 1600 px, JPEG 0.85 unless a PNG of
// the same pixels is smaller (flat screenshots often are). Throws { code: 'type' } when the
// browser cannot decode it (e.g. a HEIC it does not support).
export async function prepareImage(file) {
  const d = await decode(file);
  const { width, height } = downscaleSize(d.w, d.h, IMPORT_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const cx = canvas.getContext('2d');
  if (!cx) { d.done(); throw fail('type'); }
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, width, height);
  cx.imageSmoothingQuality = 'high';
  try { cx.drawImage(d.src, 0, 0, width, height); } finally { d.done(); }
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.85);
  const png = file.type === 'image/png' || !jpeg ? await toBlob(canvas, 'image/png') : null;
  const blob = png && (!jpeg || png.size < jpeg.size) ? png : jpeg;
  canvas.width = canvas.height = 0;
  if (!blob) throw fail('type');
  return { blob, dataUrl: await toDataUrl(blob), width, height };
}

// Full-screen viewer: the screenshot at full width, scrollable; pinch-zoom is the browser's
// own. Close button, Esc or a tap outside the image closes it and focus goes back.
let OPEN = null;
export function openViewer(url, { label = 'Your screenshot' } = {}) {
  closeViewer();
  const back = document.activeElement;
  const close = h('button', { class: 'imp-viewer-close', type: 'button', id: 'imp-viewer-close', 'aria-label': 'Close screenshot' }, ICONS.close(), h('span', { text: 'Close' }));
  const img = h('img', { class: 'imp-viewer-img', src: url, alt: label });
  const box = h('div', { class: 'imp-viewer', id: 'imp-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
    h('div', { class: 'imp-viewer-bar' }, h('strong', { text: label }), close),
    h('div', { class: 'imp-viewer-scroll' }, img));
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); closeViewer(); } };
  close.addEventListener('click', () => closeViewer());
  box.addEventListener('click', e => { if (e.target === box || e.target.classList.contains('imp-viewer-scroll')) closeViewer(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  document.documentElement.classList.add('has-viewer');
  OPEN = { box, onKey, back };
  close.focus({ preventScroll: true });
  return box;
}
export function closeViewer() {
  if (!OPEN) return;
  const { box, onKey, back } = OPEN;
  OPEN = null;
  document.removeEventListener('keydown', onKey, true);
  box.remove();
  document.documentElement.classList.remove('has-viewer');
  if (back && document.contains(back)) back.focus?.({ preventScroll: true });
}
