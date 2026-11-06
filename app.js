// Lightweight PDF editor. Everything runs in the browser.
//
// How it works:
// - pdf.js draws each page on a canvas.
// - Our edits ("annotations") are kept in memory in PDF coordinates and drawn
//   on a second canvas on top of each page.
// - Page changes (rotate, delete, move, add) are applied right away with pdf-lib.
// - On Download, pdf-lib draws all edits into the real PDF and saves it.
//
// Fonts: when you edit existing text, we take the font file that is inside the PDF
// and use it again, so the new text looks the same. If that font is missing a letter
// you typed (PDFs often keep only the letters they use), we use the closest standard font.

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { icon } from './icons.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = window.PDFLib;

const LINE_HEIGHT = 1.2;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const THUMB_WIDTH = 120;

// The 3 font families every PDF reader has built in.
// Keys of "pdf": '' = regular, b = bold, i = italic, bi = bold italic.
const STANDARD = {
  Helvetica: {
    css: 'Helvetica, Arial, sans-serif',
    pdf: { '': StandardFonts.Helvetica, b: StandardFonts.HelveticaBold, i: StandardFonts.HelveticaOblique, bi: StandardFonts.HelveticaBoldOblique },
  },
  Times: {
    css: '"Times New Roman", Times, serif',
    pdf: { '': StandardFonts.TimesRoman, b: StandardFonts.TimesRomanBold, i: StandardFonts.TimesRomanItalic, bi: StandardFonts.TimesRomanBoldItalic },
  },
  Courier: {
    css: '"Courier New", Courier, monospace',
    pdf: { '': StandardFonts.Courier, b: StandardFonts.CourierBold, i: StandardFonts.CourierOblique, bi: StandardFonts.CourierBoldOblique },
  },
};

const HINTS = {
  select: 'Click an item you added to select it. Drag to move it. Press Delete to remove it. Double-click text to edit it.',
  edittext: 'Click on any text in the PDF to change it. The original font is used when possible.',
  text: 'Click anywhere on a page to add new text.',
  draw: 'Drag on a page to draw with the pen.',
  rect: 'Drag on a page to draw a filled box.',
  highlight: 'Drag over text to highlight it.',
  whiteout: 'Drag over any part of the page to hide it with white.',
  image: 'Click on a page to place the image.',
};

const state = {
  bytes: null,        // current PDF bytes (pages only, without our edits)
  fileName: 'document.pdf',
  pdf: null,          // pdf.js document used for display
  annots: [],         // annots[pageIndex] = list of edits on that page
  views: [],          // views[pageIndex] = what is shown on screen for that page
  scale: 1.25,
  tool: 'select',
  selected: null,     // { page, annot }
  editing: null,      // text annotation open in the text box
  drag: null,         // current mouse action
  pendingImage: null, // image id waiting to be placed
  undo: [],
  redo: [],
};

const images = new Map();   // image id -> { bytes, mime, el }
const pdfFonts = new Map(); // font key -> { key, name, css, bytes, glyphs }
const fontLoads = new Map(); // font key -> promise, so each font is loaded once
let nextId = 1;
let renderToken = 0;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const measureCtx = document.createElement('canvas').getContext('2d');

// ---------- Small helpers ----------

// Move from an item's own frame (rotated around its x, y) to page coordinates.
function toPage(frame, lx, ly) {
  const r = ((frame.rot || 0) * Math.PI) / 180;
  return {
    x: (frame.x || 0) + lx * Math.cos(r) - ly * Math.sin(r),
    y: (frame.y || 0) + lx * Math.sin(r) + ly * Math.cos(r),
  };
}

// Move from page coordinates to an item's own frame.
function toLocal(frame, pt) {
  const r = (-(frame.rot || 0) * Math.PI) / 180;
  const dx = pt.x - (frame.x || 0);
  const dy = pt.y - (frame.y || 0);
  return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
}

function textWidth(a, line) {
  measureCtx.font = cssFont(a);
  return lineRuns(a, line, (text) => measureCtx.measureText(text).width).width;
}

// Box of an item in its own frame: [left, bottom, right, top]. Y goes up.
function boxOf(a) {
  if (a.type === 'text') {
    const lines = a.text.split('\n');
    const width = Math.max(a.size * 0.5, ...lines.map((line) => textWidth(a, line)));
    return [0, -(lines.length - 1) * a.size * LINE_HEIGHT - a.size * 0.25, width, a.size];
  }
  if (a.type === 'rect' || a.type === 'image') {
    return [0, -a.h, a.w, 0];
  }
  if (a.type === 'draw') {
    const xs = a.points.map((p) => p[0]);
    const ys = a.points.map((p) => p[1]);
    const pad = a.width / 2;
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  }
  return [0, 0, 0, 0];
}

function itemBox(item) {
  return [0, -item.size * 0.25, item.w, item.size];
}

function inBox(frame, box, pt, tol = 0) {
  const p = toLocal(frame, pt);
  return p.x >= box[0] - tol && p.x <= box[2] + tol && p.y >= box[1] - tol && p.y <= box[3] + tol;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function pageOf(a) {
  return state.annots.findIndex((list) => list.includes(a));
}

function pageRotation(i) {
  return state.views[i]?.page.rotate || 0;
}

function toast(message, ms = 4000) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Optional usage counting. It does nothing unless a counter script is added (see DEPLOY.md).
// Only the event name is sent, never any file data.
function track(name) {
  window.goatcounter?.count?.({ path: name, title: name, event: true });
}

// ---------- Fonts ----------

// Find out which font a piece of PDF text uses.
async function detectFont(page, fontName, style) {
  let obj = null;
  try {
    obj = page.commonObjs.get(fontName);
  } catch {
    // Font not loaded. We still have the style info.
  }
  const name = (obj?.name || '').replace(/^[A-Z]{6}\+/, ''); // drop the "ABCDEF+" subset tag
  const text = (name + ' ' + (style?.fontFamily || '')).toLowerCase();

  let family = 'Helvetica';
  if (obj?.isMonospace || /mono|courier|consol|menlo/.test(text)) family = 'Courier';
  else if (obj?.isSerifFont || (/times|serif|georgia|garamond|cambria|minion|roman/.test(text) && !/sans/.test(text))) family = 'Times';

  const result = {
    name: name || family,
    family,
    bold: !!(obj?.bold || obj?.black) || /bold|black|heavy|semibold|demi/.test(text),
    italic: !!obj?.italic || /italic|oblique/.test(text),
    key: null,
  };

  // Use the real font file when the PDF has one.
  if (obj?.data && !obj.missingFile && !obj.isType3Font) {
    result.key = await registerPdfFont(result.name, obj);
  }
  return result;
}

function registerPdfFont(name, obj) {
  const key = `pdf:${name}:${obj.data.length}`;
  if (!fontLoads.has(key)) fontLoads.set(key, loadPdfFont(key, name, obj));
  return fontLoads.get(key);
}

async function loadPdfFont(key, name, obj) {
  try {
    const bytes = new Uint8Array(obj.data);
    const glyphs = window.fontkit.create(bytes); // tells us which letters the font has

    // pdf.js stores some letters (often the space) under private codes in the font.
    // Build a map from the real letter to that private code, so we can still use them.
    const extra = new Map();
    const toUnicode = obj.toUnicode?._map || [];
    const toFontChar = obj.toFontChar || [];
    toUnicode.forEach((letter, code) => {
      if (typeof letter !== 'string' || [...letter].length !== 1) return;
      const fontChar = toFontChar[code];
      if (fontChar === undefined || glyphs.hasGlyphForCodePoint(letter.codePointAt(0))) return;
      if (glyphs.hasGlyphForCodePoint(fontChar)) extra.set(letter, String.fromCodePoint(fontChar));
    });

    // If the font has no space letter, remember how wide a space is (as part of the font size).
    let spaceWidth = null;
    if (!glyphs.hasGlyphForCodePoint(32) && !extra.has(' ')) {
      const code = toUnicode.indexOf(' ');
      spaceWidth = ((code >= 0 && obj.widths?.[code]) || 250) / 1000;
    }

    const family = `pdffont-${pdfFonts.size + 1}`;
    const face = new FontFace(family, bytes);
    await face.load();
    document.fonts.add(face);
    pdfFonts.set(key, { key, name, css: `"${family}"`, bytes, glyphs, extra, spaceWidth });
    updateFontOptions();
    return key;
  } catch (err) {
    console.warn('Cannot reuse the font from the PDF:', name, err);
    return null;
  }
}

function missingChars(pdfFont, text) {
  const missing = new Set();
  for (const ch of text) {
    if (ch === '\n' || pdfFont.extra.has(ch)) continue;
    if (ch === ' ' && pdfFont.spaceWidth !== null) continue; // spaces are left as gaps
    if (!pdfFont.glyphs.hasGlyphForCodePoint(ch.codePointAt(0))) missing.add(ch);
  }
  return [...missing];
}

// The text as the font file needs it (with the private codes from above).
function fontText(pdfFont, text) {
  return [...text].map((ch) => pdfFont.extra.get(ch) || ch).join('');
}

// Split one line into pieces, each with its x position.
// Many PDF fonts have no space letter. Then we draw word by word and leave a gap
// of the right size, just like the original PDF does.
function lineRuns(a, line, measure) {
  const pdfFont = resolveFont(a).pdfFont;
  if (!pdfFont) return { runs: [{ text: line, x: 0 }], width: measure(line) };
  if (pdfFont.spaceWidth === null) {
    const text = fontText(pdfFont, line);
    return { runs: [{ text, x: 0 }], width: measure(text) };
  }
  const runs = [];
  let x = 0;
  line.split(' ').forEach((word, k) => {
    if (k > 0) x += pdfFont.spaceWidth * a.size;
    if (!word) return;
    const text = fontText(pdfFont, word);
    runs.push({ text, x });
    x += measure(text);
  });
  return { runs, width: x };
}

// pdf-lib writes a "copy text" table based on the font file, which would give the
// private codes. Replace it with one that gives the real letters, so copy and search work.
async function fixCopyText(doc, font, pdfFont) {
  const { PDFName } = window.PDFLib;
  await font.embed();
  const pairs = new Map(); // glyph id -> letter
  for (const code of pdfFont.glyphs.characterSet) {
    if (code < 0xe000 || code > 0xf8ff) pairs.set(pdfFont.glyphs.glyphForCodePoint(code).id, String.fromCodePoint(code));
  }
  for (const [letter, fontChar] of pdfFont.extra) {
    pairs.set(pdfFont.glyphs.glyphForCodePoint(fontChar.codePointAt(0)).id, letter);
  }

  const hex4 = (n) => n.toString(16).padStart(4, '0');
  const utf16 = (s) => [...s].map((ch) => {
    const cp = ch.codePointAt(0);
    if (cp < 0x10000) return hex4(cp);
    const v = cp - 0x10000;
    return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
  }).join('');

  const lines = [...pairs].map(([gid, letter]) => `<${hex4(gid)}> <${utf16(letter)}>`);
  const blocks = [];
  for (let k = 0; k < lines.length; k += 100) {
    const part = lines.slice(k, k + 100);
    blocks.push(`${part.length} beginbfchar\n${part.join('\n')}\nendbfchar`);
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000><ffff>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');

  const fontDict = doc.context.lookup(font.ref);
  fontDict.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.flateStream(cmap)));
}

// Which font is really used for this text: the PDF's own font, or a standard one.
function resolveFont(a) {
  const pdfFont = pdfFonts.get(a.font);
  if (pdfFont && missingChars(pdfFont, a.text).length === 0) {
    return { css: pdfFont.css, bold: false, italic: false, pdfFont };
  }
  const family = STANDARD[a.font] ? a.font : a.fallback || 'Helvetica';
  return { css: STANDARD[family].css, bold: a.bold, italic: a.italic, family };
}

function cssFont(a, size = a.size) {
  const f = resolveFont(a);
  return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${size}px ${f.css}`;
}

function standardLabel(family, bold, italic) {
  return family + (bold ? ' Bold' : '') + (italic ? ' Italic' : '');
}

function updateFontOptions() {
  const select = $('font');
  const value = select.value;
  select.innerHTML = '';
  if (pdfFonts.size) {
    const group = document.createElement('optgroup');
    group.label = 'Fonts in this PDF';
    for (const f of pdfFonts.values()) group.appendChild(new Option(f.name, f.key));
    select.appendChild(group);
  }
  const group = document.createElement('optgroup');
  group.label = 'Standard fonts';
  for (const name of Object.keys(STANDARD)) group.appendChild(new Option(name, name));
  select.appendChild(group);
  select.value = [...select.options].some((o) => o.value === value) ? value : 'Helvetica';
  updateStyleToggles();
}

// A font taken from the PDF already has its own style, so bold and italic do not apply.
function updateStyleToggles() {
  const fromPdf = pdfFonts.has($('font').value);
  $('bold').disabled = fromPdf;
  $('italic').disabled = fromPdf;
}

// Show which font is used for the selected text, and warn if we had to switch.
function updateFontInfo() {
  const info = $('fontInfo');
  const a = state.selected?.annot;
  info.classList.remove('warn');
  info.textContent = '';
  if (!a || a.type !== 'text') return;

  const used = resolveFont(a);
  const pdfFont = pdfFonts.get(a.font);
  if (used.pdfFont) {
    info.textContent = a.src !== undefined ? `Original font: ${used.pdfFont.name}` : `Font from PDF: ${used.pdfFont.name}`;
  } else if (pdfFont) {
    const missing = missingChars(pdfFont, a.text).join(' ');
    info.textContent = `"${pdfFont.name}" has no ${missing} — using ${standardLabel(used.family, used.bold, used.italic)}`;
    info.classList.add('warn');
  } else if (a.detected) {
    info.textContent = `Original font: ${a.detected} (not inside the PDF) — using ${standardLabel(used.family, used.bold, used.italic)}`;
  }
  info.title = info.textContent;
}

// ---------- Loading ----------

async function openFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Make sure pdf-lib can read it too, so that saving will work later.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    state.fileName = file.name;
    state.undo = [];
    state.redo = [];
    state.annots = doc.getPages().map(() => []);
    $('fileName').textContent = file.name;
    $('viewer').scrollTop = 0;
    setTool('select');
    await showPdf(bytes);
    track('open-pdf');
  } catch (err) {
    console.error(err);
    toast('Could not open this PDF. ' + err.message);
  }
}

async function showPdf(bytes) {
  state.bytes = bytes;
  state.selected = null;
  state.editing = null;
  if (state.pdf) state.pdf.destroy();
  // pdf.js takes ownership of the data, so give it a copy.
  state.pdf = await pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
    isEvalSupported: false,
    fontExtraProperties: true, // keep the font files, so we can reuse them
  }).promise;
  $('empty').hidden = true;
  updateButtons();
  await renderAll();
}

// ---------- Rendering ----------

async function renderAll() {
  const token = ++renderToken;
  const scrollTop = $('viewer').scrollTop;
  $('pages').innerHTML = '';
  $('thumbs').innerHTML = '';
  state.views = [];
  const dpr = window.devicePixelRatio || 1;
  const count = state.pdf.numPages;

  // First create all pages with the right size, so the layout does not jump.
  for (let i = 0; i < count; i++) {
    const page = await state.pdf.getPage(i + 1);
    if (token !== renderToken) return;
    const viewport = page.getViewport({ scale: state.scale });

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.style.width = viewport.width + 'px';
    pageEl.style.height = viewport.height + 'px';
    const canvas = makeCanvas(viewport.width, viewport.height, dpr);
    const overlay = makeCanvas(viewport.width, viewport.height, dpr);
    overlay.className = 'overlay';
    pageEl.append(canvas, overlay);
    $('pages').appendChild(pageEl);

    const thumb = makeThumb(i, count, page);
    $('thumbs').appendChild(thumb.el);

    state.views[i] = { page, viewport, canvas, overlay, pageEl, dpr, items: [], thumb };
    addPageEvents(i, overlay);
  }
  $('viewer').scrollTop = scrollTop;
  updateCurrentPage();

  // Then draw them one by one.
  for (let i = 0; i < count; i++) {
    const view = state.views[i];
    await view.page.render({
      canvasContext: view.canvas.getContext('2d'),
      viewport: view.viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    if (token !== renderToken) return;
    view.items = await loadTextItems(view.page);
    drawPage(i);
    await renderThumb(view);
    if (token !== renderToken) return;
  }
}

function makeCanvas(width, height, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.floor(width * dpr);
  c.height = Math.floor(height * dpr);
  c.style.width = width + 'px';
  c.style.height = height + 'px';
  return c;
}

function makeThumb(i, count, page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
  const el = document.createElement('div');
  el.className = 'thumb';
  const canvas = makeCanvas(viewport.width, viewport.height, window.devicePixelRatio || 1);
  const label = document.createElement('div');
  label.className = 'thumb-label';
  label.textContent = i + 1;

  const actions = document.createElement('div');
  actions.className = 'thumb-actions';
  const buttons = [
    ['up', 'Move page up', () => movePage(i, i - 1), i === 0],
    ['down', 'Move page down', () => movePage(i, i + 1), i === count - 1],
    ['rotate', 'Rotate page', () => rotatePage(i), false],
    ['plus', 'Add a blank page after this one', () => addBlankPage(i), false],
    ['trash', 'Delete page', () => deletePage(i), count === 1],
  ];
  for (const [name, title, onClick, disabled] of buttons) {
    const btn = document.createElement('button');
    btn.className = 'icon-btn small' + (name === 'trash' ? ' danger' : '');
    btn.innerHTML = icon(name);
    btn.title = title;
    btn.disabled = disabled;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    actions.appendChild(btn);
  }

  el.append(canvas, actions, label);
  el.addEventListener('click', () => state.views[i].pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  return { el, canvas, viewport };
}

async function renderThumb(view) {
  const { canvas, viewport } = view.thumb;
  const dpr = window.devicePixelRatio || 1;
  await view.page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;
}

// Mark the page that is at the top of the screen.
function updateCurrentPage() {
  const viewerTop = $('viewer').getBoundingClientRect().top;
  let current = 0;
  state.views.forEach((view, i) => {
    if (view.pageEl.getBoundingClientRect().top - viewerTop < 120) current = i;
  });
  state.views.forEach((view, i) => view.thumb.el.classList.toggle('current', i === current));
  $('pageInfo').textContent = state.views.length ? `Page ${current + 1} of ${state.views.length}` : '';
}

// Read the text on a page so the user can click on it and edit it.
async function loadTextItems(page) {
  const content = await page.getTextContent();
  const items = [];
  for (const [index, it] of content.items.entries()) {
    if (!it.str || !it.str.trim() || !(it.width > 0)) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d);
    if (!size) continue;
    const font = await detectFont(page, it.fontName, content.styles[it.fontName]);
    items.push({
      index,
      str: it.str,
      x: e,
      y: f,
      w: it.width,
      size,
      rot: (Math.atan2(b, a) * 180) / Math.PI,
      font,
    });
  }
  return items;
}

function drawPage(i) {
  const view = state.views[i];
  if (!view) return;
  const ctx = view.overlay.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.overlay.width, view.overlay.height);
  // After this, we can draw using PDF coordinates directly.
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.transform(...view.viewport.transform);

  const onePixel = 1 / state.scale;

  if (state.tool === 'edittext') {
    ctx.strokeStyle = 'rgba(79, 70, 229, 0.45)';
    ctx.fillStyle = 'rgba(79, 70, 229, 0.05)';
    ctx.lineWidth = onePixel;
    for (const item of view.items) {
      if (isReplaced(i, item)) continue;
      inFrame(ctx, item, () => {
        const [x0, y0, x1, y1] = itemBox(item);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      });
    }
  }

  for (const a of state.annots[i] || []) drawAnnot(ctx, a);

  if (state.selected && state.selected.page === i) {
    const a = state.selected.annot;
    inFrame(ctx, a, () => {
      const [x0, y0, x1, y1] = boxOf(a);
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = onePixel;
      ctx.setLineDash([4 * onePixel, 3 * onePixel]);
      ctx.strokeRect(x0 - 2 * onePixel, y0 - 2 * onePixel, x1 - x0 + 4 * onePixel, y1 - y0 + 4 * onePixel);
      ctx.setLineDash([]);
      if (a.type === 'rect' || a.type === 'image') {
        const s = 8 * onePixel;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(a.w - s / 2, -a.h - s / 2, s, s);
        ctx.strokeRect(a.w - s / 2, -a.h - s / 2, s, s);
      }
    });
  }
}

function drawAll() {
  state.views.forEach((_, i) => drawPage(i));
}

// Run fn with the canvas moved and rotated into the item's own frame.
function inFrame(ctx, frame, fn) {
  ctx.save();
  ctx.translate(frame.x || 0, frame.y || 0);
  ctx.rotate(((frame.rot || 0) * Math.PI) / 180);
  fn();
  ctx.restore();
}

function drawAnnot(ctx, a) {
  if (a.cover) {
    inFrame(ctx, a.cover, () => {
      ctx.fillStyle = a.cover.color;
      ctx.fillRect(0, 0, a.cover.w, a.cover.h);
    });
  }

  if (a.type === 'text') {
    if (state.editing === a) return; // the text box shows it instead
    inFrame(ctx, a, () => {
      ctx.scale(1, -1); // canvas text needs y going down
      ctx.font = cssFont(a);
      ctx.fillStyle = a.color;
      a.text.split('\n').forEach((line, k) => {
        const { runs } = lineRuns(a, line, (text) => ctx.measureText(text).width);
        for (const run of runs) ctx.fillText(run.text, run.x, k * a.size * LINE_HEIGHT);
      });
    });
  } else if (a.type === 'rect') {
    inFrame(ctx, a, () => {
      ctx.globalAlpha = a.opacity;
      ctx.fillStyle = a.color;
      ctx.fillRect(0, -a.h, a.w, a.h);
    });
  } else if (a.type === 'image') {
    inFrame(ctx, a, () => {
      ctx.scale(1, -1);
      ctx.drawImage(images.get(a.imageId).el, 0, 0, a.w, a.h);
    });
  } else if (a.type === 'draw') {
    ctx.beginPath();
    a.points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

// ---------- Mouse actions on a page ----------

function addPageEvents(i, overlay) {
  overlay.addEventListener('pointerdown', (e) => onPointerDown(e, i));
  overlay.addEventListener('pointermove', (e) => onPointerMove(e, i));
  overlay.addEventListener('pointerup', (e) => onPointerUp(e, i));
  overlay.addEventListener('dblclick', (e) => {
    const hit = findAnnot(i, eventPoint(e, i));
    if (hit && hit.type === 'text') openEditor(i, hit);
  });
}

function eventPoint(e, i) {
  const view = state.views[i];
  const rect = view.overlay.getBoundingClientRect();
  const [x, y] = view.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
  return { x, y };
}

function findAnnot(i, pt) {
  const list = state.annots[i] || [];
  const tol = 3 / state.scale;
  for (let k = list.length - 1; k >= 0; k--) {
    if (inBox(list[k], boxOf(list[k]), pt, tol)) return list[k];
  }
  return null;
}

function findTextItem(i, pt) {
  const items = state.views[i].items;
  for (let k = items.length - 1; k >= 0; k--) {
    if (!isReplaced(i, items[k]) && inBox(items[k], itemBox(items[k]), pt)) return items[k];
  }
  return null;
}

function isReplaced(i, item) {
  return (state.annots[i] || []).some((a) => a.src === item.index);
}

function onResizeHandle(a, pt) {
  if (a.type !== 'rect' && a.type !== 'image') return false;
  const p = toLocal(a, pt);
  const tol = 6 / state.scale;
  return Math.abs(p.x - a.w) <= tol && Math.abs(p.y + a.h) <= tol;
}

function select(i, a) {
  state.selected = a ? { page: i, annot: a } : null;
  if (a) syncProps(a);
  updateProps();
  drawAll();
}

function addAnnot(i, a) {
  a.id = nextId++;
  state.annots[i].push(a);
  return a;
}

function onPointerDown(e, i) {
  if (e.button !== 0) return;
  e.preventDefault();
  closeEditor();
  const pt = eventPoint(e, i);
  const hit = findAnnot(i, pt);
  const props = readProps();
  const rot = pageRotation(i);
  // Keep getting mouse moves even if the mouse leaves the page while dragging.
  try { e.target.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }

  switch (state.tool) {
    case 'select': {
      const sel = state.selected;
      if (sel && sel.page === i && onResizeHandle(sel.annot, pt)) {
        state.drag = { mode: 'resize', annot: sel.annot, moved: false };
      } else if (hit) {
        select(i, hit);
        state.drag = { mode: 'move', annot: hit, last: pt, moved: false };
      } else {
        select(i, null);
      }
      break;
    }

    case 'text': {
      if (hit && hit.type === 'text') {
        openEditor(i, hit);
        break;
      }
      pushUndo();
      // Put the click point near the top of the first line.
      const anchor = toPage({ x: pt.x, y: pt.y, rot }, 0, -props.size * 0.8);
      const a = addAnnot(i, {
        type: 'text', x: anchor.x, y: anchor.y, rot, text: '',
        font: props.font, fallback: 'Helvetica', size: props.size, bold: props.bold, italic: props.italic, color: props.color,
      });
      openEditor(i, a);
      break;
    }

    case 'edittext': {
      if (hit && hit.type === 'text') {
        openEditor(i, hit);
        break;
      }
      const item = findTextItem(i, pt);
      if (item) {
        pushUndo();
        openEditor(i, addAnnot(i, makeReplacement(i, item)));
      }
      break;
    }

    case 'draw': {
      pushUndo();
      const a = addAnnot(i, { type: 'draw', points: [[pt.x, pt.y]], color: props.penColor, width: props.width });
      state.drag = { mode: 'draw', annot: a };
      break;
    }

    case 'rect':
    case 'highlight':
    case 'whiteout': {
      pushUndo();
      const look = {
        rect: { color: props.fill, opacity: 1 },
        highlight: { color: '#ffeb3b', opacity: 0.4 },
        whiteout: { color: '#ffffff', opacity: 1 },
      }[state.tool];
      const a = addAnnot(i, { type: 'rect', kind: state.tool, x: pt.x, y: pt.y, w: 0, h: 0, rot, ...look });
      state.drag = { mode: 'rect', annot: a, start: { x: pt.x, y: pt.y, rot } };
      break;
    }

    case 'image': {
      if (!state.pendingImage) break;
      const img = images.get(state.pendingImage).el;
      // Fit the image inside 200 x 200 points, keeping its shape.
      const fit = Math.min(1, 200 / img.naturalWidth, 200 / img.naturalHeight);
      pushUndo();
      const a = addAnnot(i, {
        type: 'image', imageId: state.pendingImage, x: pt.x, y: pt.y, rot,
        w: img.naturalWidth * fit, h: img.naturalHeight * fit,
      });
      state.pendingImage = null;
      setTool('select');
      select(i, a);
      break;
    }
  }
}

function onPointerMove(e, i) {
  const pt = eventPoint(e, i);
  const drag = state.drag;

  if (!drag) {
    // Just hovering: show a helpful cursor.
    let cursor = 'crosshair';
    if (state.tool === 'edittext') cursor = findAnnot(i, pt) || findTextItem(i, pt) ? 'text' : 'default';
    else if (state.tool === 'select') cursor = findAnnot(i, pt) ? 'move' : 'default';
    else if (state.tool === 'text') cursor = 'text';
    e.target.style.cursor = cursor;
    return;
  }

  const a = drag.annot;
  if (drag.mode === 'move') {
    if (!drag.moved) pushUndo();
    drag.moved = true;
    const dx = pt.x - drag.last.x;
    const dy = pt.y - drag.last.y;
    if (a.type === 'draw') a.points.forEach((p) => { p[0] += dx; p[1] += dy; });
    else { a.x += dx; a.y += dy; } // a cover stays where the old text was
    drag.last = pt;
  } else if (drag.mode === 'resize') {
    if (!drag.moved) pushUndo();
    drag.moved = true;
    const p = toLocal(a, pt);
    const ratio = a.h / a.w;
    a.w = Math.max(5, p.x);
    a.h = a.type === 'image' ? a.w * ratio : Math.max(5, -p.y);
  } else if (drag.mode === 'draw') {
    a.points.push([pt.x, pt.y]);
  } else if (drag.mode === 'rect') {
    const p = toLocal(drag.start, pt);
    const topLeft = toPage(drag.start, Math.min(0, p.x), Math.max(0, p.y));
    a.x = topLeft.x;
    a.y = topLeft.y;
    a.w = Math.abs(p.x);
    a.h = Math.abs(p.y);
  }
  drawPage(i);
}

function onPointerUp(e, i) {
  const drag = state.drag;
  state.drag = null;
  if (!drag) return;
  const a = drag.annot;
  if (drag.mode === 'rect' && (a.w < 2 || a.h < 2)) {
    // Too small, the user just clicked. Throw it away.
    removeAnnot(a);
    state.undo.pop();
  }
  drawPage(i);
  updateButtons();
}

function removeAnnot(a) {
  const i = pageOf(a);
  if (i < 0) return;
  state.annots[i] = state.annots[i].filter((x) => x !== a);
  if (state.selected?.annot === a) state.selected = null;
}

// Turn a piece of existing PDF text into editable text.
// A box with the background color hides the old text, and new text is drawn on top.
function makeReplacement(i, item) {
  const colors = sampleColors(i, item);
  const pad = 0.5;
  const corner = toPage(item, -pad, -item.size * 0.3);
  return {
    type: 'text',
    src: item.index,
    x: item.x,
    y: item.y,
    rot: item.rot,
    text: item.str,
    font: item.font.key || item.font.family,
    fallback: item.font.family,
    detected: item.font.name,
    bold: item.font.bold,
    italic: item.font.italic,
    size: Math.round(item.size * 10) / 10,
    color: colors.text,
    cover: { x: corner.x, y: corner.y, rot: item.rot, w: item.w + pad * 2, h: item.size * 1.3, color: colors.background },
  };
}

// Look at the rendered pixels to guess the text color and background color.
function sampleColors(i, item) {
  const view = state.views[i];
  const [x0, y0, x1, y1] = itemBox(item);
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
    .map(([lx, ly]) => toPage(item, lx, ly))
    .map((p) => view.viewport.convertToViewportPoint(p.x, p.y));
  const left = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])) * view.dpr));
  const top = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])) * view.dpr));
  const right = Math.min(view.canvas.width, Math.ceil(Math.max(...corners.map((c) => c[0])) * view.dpr));
  const bottom = Math.min(view.canvas.height, Math.ceil(Math.max(...corners.map((c) => c[1])) * view.dpr));
  if (right <= left || bottom <= top) return { text: '#000000', background: '#ffffff' };

  const data = view.canvas.getContext('2d').getImageData(left, top, right - left, bottom - top).data;
  let dark = null;
  let light = null;
  for (let k = 0; k < data.length; k += 4) {
    const px = [data[k], data[k + 1], data[k + 2]];
    const lum = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
    if (!dark || lum < dark.lum) dark = { lum, px };
    if (!light || lum > light.lum) light = { lum, px };
  }
  return { text: toHex(...dark.px), background: toHex(...light.px) };
}

// ---------- Text box for typing ----------

function openEditor(i, a) {
  closeEditor();
  const view = state.views[i];
  state.editing = a;
  state.selected = { page: i, annot: a };
  syncProps(a);
  updateProps();

  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = a.text;
  ta.spellcheck = false;
  const topLeft = toPage(a, 0, a.size);
  const [sx, sy] = view.viewport.convertToViewportPoint(topLeft.x, topLeft.y);
  ta.style.left = sx + 'px';
  ta.style.top = sy + 'px';
  ta.style.transform = `rotate(${pageRotation(i) - a.rot}deg)`;
  styleEditor(ta, a);
  view.pageEl.appendChild(ta);

  ta.addEventListener('input', () => {
    a.text = ta.value;
    styleEditor(ta, a); // the font may change if a letter is missing
    updateFontInfo();
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      closeEditor();
    }
  });
  ta.addEventListener('blur', () => closeEditor());

  drawPage(i);
  // Focus after the mouse event is done, so the click does not steal focus.
  setTimeout(() => {
    ta.focus();
    ta.select();
  }, 0);
}

function styleEditor(ta, a) {
  ta.style.font = cssFont(a, a.size * state.scale);
  ta.style.lineHeight = String(LINE_HEIGHT);
  ta.style.color = a.color;
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.width = ta.scrollWidth + 8 + 'px';
  ta.style.height = ta.scrollHeight + 'px';
}

function closeEditor() {
  const a = state.editing;
  if (!a) return;
  state.editing = null;
  document.querySelector('.text-editor')?.remove();
  const i = pageOf(a);
  // Empty new text is removed. Empty replaced text stays, which hides the old text.
  if (!a.text.trim() && !a.cover) {
    removeAnnot(a);
    updateProps();
  }
  drawPage(i);
  updateButtons();
}

// ---------- Properties bar ----------

function readProps() {
  return {
    font: $('font').value,
    size: Math.max(4, Number($('size').value) || 14),
    bold: $('bold').checked,
    italic: $('italic').checked,
    color: $('color').value,
    penColor: $('penColor').value,
    fill: $('fill').value,
    width: Math.max(1, Number($('width').value) || 2),
  };
}

function syncProps(a) {
  if (a.type === 'text') {
    $('font').value = a.font;
    if ($('font').value !== a.font) $('font').value = a.fallback || 'Helvetica';
    $('size').value = a.size;
    $('bold').checked = a.bold;
    $('italic').checked = a.italic;
    $('color').value = a.color;
    updateStyleToggles();
  } else if (a.type === 'draw') {
    $('penColor').value = a.color;
    $('width').value = a.width;
  } else if (a.type === 'rect' && a.kind === 'rect') {
    $('fill').value = a.color;
  }
}

// Show only the settings that fit the current tool or the selected item.
function updateProps() {
  const a = state.selected?.annot;
  let group = { text: 'text', edittext: 'text', draw: 'draw', rect: 'rect' }[state.tool] || null;
  if (a) group = a.type === 'rect' ? (a.kind === 'rect' ? 'rect' : null) : a.type === 'image' ? null : a.type;
  document.querySelectorAll('.prop-group').forEach((el) => { el.hidden = el.dataset.for !== group; });
  updateFontInfo();
}

// When a setting changes, apply it to the selected item.
function onPropChange() {
  updateStyleToggles();
  const a = state.selected?.annot;
  if (!a) return;
  const props = readProps();
  pushUndo();
  if (a.type === 'text') {
    Object.assign(a, { font: props.font, size: props.size, color: props.color });
    if (!pdfFonts.has(props.font)) Object.assign(a, { bold: props.bold, italic: props.italic, fallback: props.font });
    const ta = document.querySelector('.text-editor');
    if (ta && state.editing === a) styleEditor(ta, a);
    updateFontInfo();
  } else if (a.type === 'draw') {
    Object.assign(a, { color: props.penColor, width: props.width });
  } else if (a.type === 'rect' && a.kind === 'rect') {
    a.color = props.fill;
  }
  drawPage(state.selected.page);
}

// ---------- Page changes ----------

async function changePages(change) {
  closeEditor();
  pushUndo();
  try {
    const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    await change(doc);
    await showPdf(await doc.save());
  } catch (err) {
    console.error(err);
    toast('Something went wrong. ' + err.message);
    await restore(state.undo.pop());
  }
}

function rotatePage(i) {
  changePages((doc) => {
    const page = doc.getPage(i);
    const angle = (((page.getRotation().angle + 90) % 360) + 360) % 360;
    page.setRotation(degrees(angle));
  });
}

function deletePage(i) {
  if (!confirm(`Delete page ${i + 1}?`)) return;
  changePages((doc) => {
    doc.removePage(i);
    state.annots.splice(i, 1);
  });
}

function movePage(from, to) {
  changePages((doc) => {
    const page = doc.getPage(from);
    doc.removePage(from);
    doc.insertPage(to, page);
    const [list] = state.annots.splice(from, 1);
    state.annots.splice(to, 0, list);
  });
}

function addBlankPage(i) {
  changePages((doc) => {
    const { width, height } = doc.getPage(i).getSize();
    doc.insertPage(i + 1, [width, height]);
    state.annots.splice(i + 1, 0, []);
  });
}

function mergeFile(file) {
  changePages(async (doc) => {
    const other = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()), { ignoreEncryption: true });
    const pages = await doc.copyPages(other, other.getPageIndices());
    for (const page of pages) {
      doc.addPage(page);
      state.annots.push([]);
    }
  });
}

// ---------- Undo and redo ----------

function snapshot() {
  return { bytes: state.bytes, annots: structuredClone(state.annots) };
}

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 50) state.undo.shift();
  state.redo = [];
  updateButtons();
}

async function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  await restore(state.undo.pop());
}

async function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  await restore(state.redo.pop());
}

async function restore(snap) {
  if (!snap) return;
  state.editing = null;
  document.querySelector('.text-editor')?.remove();
  state.annots = snap.annots;
  state.selected = null;
  if (snap.bytes !== state.bytes) await showPdf(snap.bytes);
  else drawAll();
  updateProps();
  updateButtons();
}

// ---------- Images ----------

async function loadImage(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let mime = file.type;
  const el = new Image();
  el.src = URL.createObjectURL(file);
  await el.decode();
  // pdf-lib only supports PNG and JPEG. Convert anything else to PNG.
  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    const c = document.createElement('canvas');
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    c.getContext('2d').drawImage(el, 0, 0);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    bytes = new Uint8Array(await blob.arrayBuffer());
    mime = 'image/png';
  }
  const id = nextId++;
  images.set(id, { bytes, mime, el });
  return id;
}

// ---------- Saving ----------

async function download() {
  closeEditor();
  try {
    const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    doc.registerFontkit(window.fontkit);
    const fonts = {};
    const usedPdfFonts = new Map(); // pdf-lib font -> font taken from the PDF
    const embeddedImages = {};
    const pages = doc.getPages();

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      for (const a of state.annots[i] || []) {
        if (a.cover) {
          page.drawRectangle({
            x: a.cover.x, y: a.cover.y, width: a.cover.w, height: a.cover.h,
            rotate: degrees(a.cover.rot), color: hexToRgb(a.cover.color),
          });
        }

        if (a.type === 'text' && a.text.trim()) {
          const used = resolveFont(a);
          const look = { size: a.size, color: hexToRgb(a.color), rotate: degrees(a.rot) };
          if (used.pdfFont) {
            // Same font file as the original text. Draw piece by piece, like on screen.
            fonts[used.pdfFont.key] ??= await doc.embedFont(used.pdfFont.bytes, { subset: false });
            const font = fonts[used.pdfFont.key];
            usedPdfFonts.set(font, used.pdfFont);
            a.text.split('\n').forEach((line, k) => {
              const { runs } = lineRuns(a, line, (text) => font.widthOfTextAtSize(text, a.size));
              for (const run of runs) {
                const p = toPage(a, run.x, -k * a.size * LINE_HEIGHT);
                page.drawText(run.text, { ...look, x: p.x, y: p.y, font });
              }
            });
          } else {
            const name = STANDARD[used.family].pdf[(used.bold ? 'b' : '') + (used.italic ? 'i' : '')];
            fonts[name] ??= await doc.embedFont(name);
            const font = fonts[name];
            page.drawText(cleanText(a.text, font), { ...look, x: a.x, y: a.y, font, lineHeight: a.size * LINE_HEIGHT });
          }
        } else if (a.type === 'rect') {
          const corner = toPage(a, 0, -a.h); // pdf-lib wants the bottom-left corner
          page.drawRectangle({
            x: corner.x, y: corner.y, width: a.w, height: a.h,
            rotate: degrees(a.rot), color: hexToRgb(a.color), opacity: a.opacity,
          });
        } else if (a.type === 'image') {
          const img = images.get(a.imageId);
          embeddedImages[a.imageId] ??= img.mime === 'image/png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
          const corner = toPage(a, 0, -a.h);
          page.drawImage(embeddedImages[a.imageId], {
            x: corner.x, y: corner.y, width: a.w, height: a.h, rotate: degrees(a.rot),
          });
        } else if (a.type === 'draw') {
          // pdf-lib's SVG paths have y going down, so flip y.
          const path = a.points.map(([x, y], k) => `${k === 0 ? 'M' : 'L'} ${x} ${-y}`).join(' ');
          page.drawSvgPath(path, {
            x: 0, y: 0, borderColor: hexToRgb(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round,
          });
        }
      }
    }

    for (const [font, pdfFont] of usedPdfFonts) await fixCopyText(doc, font, pdfFont);

    const bytes = await doc.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = state.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    track('download-pdf');
  } catch (err) {
    console.error(err);
    toast('Could not save the PDF. ' + err.message);
  }
}

// Standard PDF fonts only know basic Latin letters. Replace any other letter with "?".
function cleanText(text, font) {
  const known = new Set(font.getCharacterSet());
  return [...text.replace(/\t/g, '    ')]
    .map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)) ? ch : '?'))
    .join('');
}

// ---------- Toolbar ----------

function setTool(tool) {
  closeEditor();
  state.tool = tool;
  state.selected = null;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('imageBtn').classList.toggle('active', tool === 'image');
  $('hint').textContent = HINTS[tool];
  updateProps();
  drawAll();
}

function updateButtons() {
  const hasPdf = !!state.pdf;
  document.querySelectorAll('[data-needs-pdf]').forEach((el) => { el.disabled = !hasPdf; });
  $('undoBtn').disabled = !hasPdf || state.undo.length === 0;
  $('redoBtn').disabled = !hasPdf || state.redo.length === 0;
  $('zoomLabel').textContent = Math.round(state.scale * 100) + '%';
}

async function zoom(step) {
  closeEditor();
  state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale + step));
  state.selected = null;
  updateButtons();
  await renderAll();
}

function pickFile(input, onFile) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (file) onFile(file);
  });
}

// Put the icons into the page.
document.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });

$('openBtn').addEventListener('click', () => $('fileInput').click());
$('emptyOpenBtn').addEventListener('click', () => $('fileInput').click());
$('mergeBtn').addEventListener('click', () => $('mergeInput').click());
$('imageBtn').addEventListener('click', () => $('imageInput').click());
$('downloadBtn').addEventListener('click', download);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('zoomIn').addEventListener('click', () => zoom(0.25));
$('zoomOut').addEventListener('click', () => zoom(-0.25));
$('viewer').addEventListener('scroll', updateCurrentPage);
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
['font', 'size', 'bold', 'italic', 'color', 'penColor', 'fill', 'width'].forEach((id) => $(id).addEventListener('change', onPropChange));

pickFile($('fileInput'), openFile);
pickFile($('mergeInput'), mergeFile);
pickFile($('imageInput'), async (file) => {
  try {
    state.pendingImage = await loadImage(file);
    setTool('image');
  } catch {
    toast('Could not read this image.');
  }
});

// Drag and drop a PDF anywhere on the page.
const viewer = $('viewer');
viewer.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewer.classList.add('dragging');
});
viewer.addEventListener('dragleave', () => viewer.classList.remove('dragging'));
viewer.addEventListener('drop', (e) => {
  e.preventDefault();
  viewer.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('Please drop a PDF file.');
  } else if (!state.pdf) {
    openFile(file);
  } else if (confirm('Add this PDF to the end of the current one?\n\nPress Cancel to open it as a new file instead.')) {
    mergeFile(file);
  } else {
    openFile(file);
  }
});

// Keyboard shortcuts.
const TOOL_KEYS = { v: 'select', e: 'edittext', t: 'text', p: 'draw', r: 'rect', h: 'highlight', w: 'whiteout' };
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
  const key = e.key.toLowerCase();
  const mod = e.metaKey || e.ctrlKey;
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    e.preventDefault();
    pushUndo();
    const i = state.selected.page;
    removeAnnot(state.selected.annot);
    updateProps();
    drawPage(i);
  } else if (e.key === 'Escape') {
    select(null, null);
  } else if (!mod && !e.altKey && state.pdf && TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  }
});

updateFontOptions();
updateButtons();
