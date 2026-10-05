// Name Puzzle Maker: page controller. Reads the form, keeps a live layout
// and preview up to date, sends builds to the OpenSCAD worker and offers the
// resulting files for download.
import { prepareJob, fileStem, GLYPH_DATA } from './lib/job.js';
import { DEFAULTS, MAX_LETTERS, PRINTERS, HEIGHT_MIN_MM, HEIGHT_MAX_MM, sanitizeName, inchesToMm } from './lib/layout.js';
import { makeZip } from './lib/zip.js';
import { createViewer, LETTER_COLORS } from './lib/viewer.js';

const $ = (id) => document.getElementById(id);
const form = $('controls');
const ADV_KEYS = ['fit_clearance', 'letter_thickness', 'pocket_depth', 'corner_chamfer', 'edge_chamfer', 'letter_chamfer'];
const EXAMPLE_NAME = 'Emma';
// Darker shade of the letter blue for text on light backgrounds (AA for large text).
const TEXT_COLORS = ['#007eb0'];

const state = {
  job: null, // live job for the current inputs (no .scad)
  built: null, // { job, result, key, seconds }
  building: null, // { id, job, key, started }
  error: '',
  triedEmpty: false,
};
let viewer = null;
let worker = null;
let buildSeq = 0;
let warmedUp = false;

// ---------------------------------------------------------------- inputs

function readInputs() {
  const advanced = {};
  for (const k of ADV_KEYS) advanced[k] = $(k).value;
  return {
    rawName: $('name').value,
    caseStyle: form.elements.caseStyle.value,
    heightMm: Number($('height').value),
    printer: form.elements.printer.value,
    customBed: { width: $('bed-w').value, depth: $('bed-d').value },
    advanced,
  };
}

const jobKey = (j) => (j && j.status === 'ready' ? JSON.stringify([j.text, j.params, j.bed]) : '');
const fmt = (v, d = 1) => String(+v.toFixed(d));
const inOf = (mm) => (mm / 25.4).toFixed(2);

// --------------------------------------------------------------- update

let debounce = 0;
function scheduleUpdate(immediate = false) {
  clearTimeout(debounce);
  if (immediate) update();
  else debounce = setTimeout(update, 90);
}

function update() {
  const input = readInputs();
  state.job = prepareJob({ ...input, withScad: false });
  renderName(input);
  renderCaseLabels();
  renderHeight();
  renderPrinter();
  renderAdvanced();
  renderNotice();
  renderBuildButton();
  renderPhase();
  renderPreview();
  renderResults();
}

function renderName(input) {
  const clean = sanitizeName(input.rawName);
  const n = clean.name.length;
  const counter = $('counter');
  counter.textContent = `${n}/${MAX_LETTERS}`;
  counter.classList.toggle('over', n > MAX_LETTERS);
  const help = $('name-help');
  help.textContent = clean.message || 'Letters A–Z only. Spaces, numbers and symbols are removed.';
  help.classList.toggle('changed', !!clean.message);
  const err = $('name-error');
  const showErr = state.job.status === 'invalid-name' && (n > 0 || state.triedEmpty);
  err.hidden = !showErr;
  err.textContent = showErr ? state.job.nameError : '';
  $('name-box').classList.toggle('invalid', showErr);
  $('name').setAttribute('aria-invalid', String(showErr));

  const strip = $('live-strip');
  strip.replaceChildren(...[...state.job.text].slice(0, MAX_LETTERS).map((ch, i) => {
    const s = document.createElement('span');
    s.textContent = ch;
    s.style.color = TEXT_COLORS[i % TEXT_COLORS.length];
    return s;
  }));
  const len = state.job.text.length;
  strip.style.fontSize = len > 8 ? '28px' : len > 5 ? '34px' : '';
}

function renderCaseLabels() {
  const base = sanitizeName($('name').value).name || EXAMPLE_NAME;
  $('case-caps').textContent = base.toUpperCase();
  $('case-first').textContent = base[0].toUpperCase() + base.slice(1).toLowerCase();
}

function renderHeight() {
  const v = Number($('height').value);
  $('height-out').innerHTML = `<b>${fmt(v)} mm</b> · ${inOf(v)} in`;
  $('height').setAttribute('aria-valuetext', `${fmt(v)} millimetres, ${inOf(v)} inches`);
  $('height').style.setProperty('--fill', `${((v - HEIGHT_MIN_MM) / (HEIGHT_MAX_MM - HEIGHT_MIN_MM)) * 100}%`);
}

function renderPrinter() {
  $('custom-bed').hidden = form.elements.printer.value !== 'custom';
}

function renderAdvanced() {
  const { params, notes } = state.job;
  for (const k of ADV_KEYS) {
    const note = $(`note-${k}`);
    note.hidden = !notes[k];
    note.textContent = notes[k] || '';
    $(k).classList.toggle('clamped', !!notes[k]);
  }
  $('adv-summary').textContent = `Fit ${fmt(params.fit_clearance, 2)} · ${fmt(params.letter_thickness)} / ${fmt(params.pocket_depth)} mm · chamfers`;
}

// ---------------------------------------------------------- notices

function button(label, cls, onClick, extra = {}) {
  const b = document.createElement(extra.href ? 'a' : 'button');
  if (extra.href) b.href = extra.href; else b.type = 'button';
  b.className = `btn ${cls}`;
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function otherPrinterThatFits() {
  const input = readInputs();
  for (const id of ['a1', 'mk4']) {
    if (id === input.printer) continue;
    const j = prepareJob({ ...input, printer: id, withScad: false });
    if (j.status === 'ready') return PRINTERS[id];
  }
  return null;
}

function setPrinter(id) {
  form.elements.printer.value = id;
  scheduleUpdate(true);
}

function useCustomBed() {
  setPrinter('custom');
  const w = $('bed-w');
  const need = Math.ceil((state.job.layout?.base.width || 300) + 2 * DEFAULTS.bed_margin + 1);
  if (Number(w.value) < need) w.value = Math.min(1000, need);
  scheduleUpdate(true);
  w.focus();
}

function renderNotice() {
  const box = $('fit-notice');
  const j = state.job;
  const orderHref = $('order-link').getAttribute('href');
  box.className = 'notice';
  box.replaceChildren();
  if (state.error) {
    box.classList.add('error');
    box.append(el('h2', 'Something went wrong while building'), el('p', state.error));
    box.append(Object.assign(el('div', '', 'actions'), {}));
    box.lastChild.append(button('Try again', 'primary', () => startBuild()));
  } else if (j.status === 'too-big') {
    const over = Math.ceil(j.plan.over);
    box.append(
      el('h2', `At ${fmt(j.heightMm)} mm, “${j.text}” is ${over} mm too big for the ${j.bed.label}`),
      Object.assign(el('p'), { innerHTML: `Even turned 45° on the bed, the base doesn't fit. The largest letter height that fits is <strong>${fmt(j.maxHeightMm)} mm (${inOf(j.maxHeightMm)} in)</strong>. We won't make a file that can't print.` }),
    );
    const actions = el('div', '', 'actions');
    actions.append(button(`Use ${fmt(j.maxHeightMm)} mm, the max that fits`, 'primary', () => {
      $('height').value = j.maxHeightMm;
      scheduleUpdate(true);
      $('height').focus();
    }));
    const other = otherPrinterThatFits();
    if (other) actions.append(button(`Switch to ${other.label.split(' ')[1]}`, 'secondary', () => setPrinter(other.id)));
    actions.append(button('Custom bed', 'secondary', useCustomBed));
    box.append(actions);
  } else if (j.status === 'nothing-fits') {
    box.append(
      el('p', 'Nothing fits', 'kicker'),
      el('h2', `“${j.text}” needs ≈ ${Math.round(j.widthAtMin)} mm, even at the smallest size (${fmt(j.minHeightMm)} mm)`),
      el('p', `That is wider than the ${j.bed.label} bed (${j.bed.width} mm). Try a shorter name or a nickname, or set a larger custom bed.`),
    );
    const actions = el('div', '', 'actions');
    actions.append(button('Edit name', 'secondary', () => { $('name').focus(); $('name').select(); }));
    actions.append(button('Custom bed', 'secondary', useCustomBed));
    if (orderHref) actions.append(button('Order it printed', 'teal', null, { href: orderHref }));
    box.append(actions);
  } else if (j.status === 'ready' && j.plan.plates.length > 1) {
    box.classList.add('info');
    const turned = isTurned(j)
      ? `“${j.text}” is long for the ${j.bed.label}, so the base is turned 45° to fit and gets a plate to itself. The letters go on their own plate. `
      : '';
    box.append(el('p', `${turned}${plateSummary(j)} Each plate is its own STL, and you can download them all as a ZIP.`));
  } else {
    box.hidden = true;
    return;
  }
  box.hidden = false;
}

const isTurned = (j) => j.plan.plates[0].placements.some((q) => q.kind === 'base' && q.rot === 45);

function plateSummary(j) {
  const parts = j.plan.plates.map((pl) => {
    const letters = `${pl.letterCount} letter${pl.letterCount === 1 ? '' : 's'}`;
    const what = pl.hasBase ? (pl.letterCount ? `Base and ${letters}` : 'Base') : letters[0].toUpperCase() + letters.slice(1);
    return `${what} on plate ${pl.number}`;
  });
  return `${parts.join(', ')}.`;
}

// ------------------------------------------------------- build button

function renderBuildButton() {
  const j = state.job;
  const btn = $('build');
  const reason = $('build-reason');
  btn.textContent = state.built || state.building ? 'Rebuild puzzle' : 'Build my puzzle';
  let why = '';
  if (j.status === 'invalid-name') why = state.triedEmpty || j.text ? j.nameError : '';
  if (j.status === 'too-big') why = 'Pick a height that fits your bed to build.';
  if (j.status === 'nothing-fits') why = 'This name is too long for your bed.';
  const blocked = j.status !== 'ready' && !(j.status === 'invalid-name' && !j.text && !state.triedEmpty);
  btn.disabled = blocked;
  reason.hidden = !why;
  reason.textContent = why;
}

function renderPhase() {
  const stale = isStale();
  const status = $('status');
  status.className = 'status-pill';
  if (state.building) {
    status.textContent = 'Building your puzzle… usually 5–20 seconds';
    status.classList.add('busy');
  } else if (state.error) {
    status.textContent = 'Build failed';
    status.classList.add('bad');
  } else if (state.built && !stale) {
    status.textContent = `Ready · built in ${state.built.seconds.toFixed(1)} s`;
  } else if (state.built) {
    status.textContent = 'Settings changed · rebuild to update';
  } else if (state.job.status === 'too-big' || state.job.status === 'nothing-fits') {
    status.textContent = 'Too big for this bed';
    status.classList.add('bad');
  } else {
    status.textContent = state.job.text ? 'Live preview' : 'Example preview';
  }
}

const isStale = () => !!state.built && state.built.key !== jobKey(state.job);

// ------------------------------------------------------------- preview

function previewJob() {
  if (state.built && !isStale()) return { job: state.built.job, built: state.built.result };
  const j = state.job;
  if (j.layout) return { job: j, built: null };
  // No name yet: show an example so the page never looks empty.
  return { job: prepareJob({ ...readInputs(), rawName: EXAMPLE_NAME, withScad: false }), built: null };
}

function renderPreview() {
  const view = document.querySelector('input[name=view]:checked').value;
  const { job, built } = previewJob();
  const plateView = view === 'plate' && job.plan && job.plan.ok;
  const proud = fmt(job.params.letter_thickness - job.params.pocket_depth);
  $('foot-left').textContent = plateView
    ? `${job.bed.label} · ${fmt(job.bed.width, 0)} × ${fmt(job.bed.depth, 0)} mm bed · everything flat at Z = 0, ${job.params.part_spacing} mm apart${job.plan.plates.length > 1 ? ` · ${job.plan.plates.length} plates` : ''}`
    : `Letters seated in the base · ${proud} mm stand proud for small hands`;
  if (!viewer) return;
  viewer.show({
    view: plateView ? 'plate' : 'assembled',
    layout: job.layout,
    params: job.params,
    bed: job.bed,
    plan: job.plan,
    glyphs: GLYPH_DATA.GLYPHS,
    built,
    tooBig: job.status === 'too-big' || job.status === 'nothing-fits',
    resetCamera: renderPreview.lastView !== view,
  });
  renderPreview.lastView = view;
}

// -------------------------------------------------------------- results

function renderResults() {
  const b = state.built;
  $('stats').hidden = !b;
  $('downloads').hidden = !b;
  if (!b) return;
  const { job, result } = b;
  const { width, depth, thickness } = job.layout.base;
  $('stat-base').textContent = `${Math.round(width)} × ${Math.round(depth)} × ${fmt(thickness)} mm`;
  $('stat-base-in').textContent = `${(width / 25.4).toFixed(1)} × ${(depth / 25.4).toFixed(1)} in`;
  const plates = job.plan.plates.length;
  $('stat-plates').textContent = String(plates);
  const short = job.bed.id === 'custom' ? 'your bed' : `the ${job.bed.label.split(' ')[1]}`;
  $('stat-plates-sub').textContent = plates === 1 ? `Base + ${job.text.length} letters fit ${short}` : `${isTurned(job) ? 'Base turned 45°. ' : ''}${plateSummary(job).replace(/\.$/, '')}`;
  $('stat-grams').textContent = `≈ ${Math.round(result.grams)} g PLA`;

  const stale = isStale();
  $('downloads').classList.toggle('stale', stale);
  $('stale-note').hidden = !stale;
  renderDownloadButtons();
}

let lastButtonsFor = null;
function renderDownloadButtons() {
  if (lastButtonsFor === state.built) return;
  lastButtonsFor = state.built;
  const { job, result } = state.built;
  const box = $('dl-buttons');
  box.replaceChildren();
  const stem = fileStem(job.text);
  box.append(button('.scad source', 'secondary', () => save(`${stem}.scad`, job.scad, 'text/plain')));
  const n = result.plates.length;
  for (const pl of result.plates) {
    const b = button(pl.label, n === 1 ? 'primary' : 'secondary', () => save(pl.file, pl.stl, 'model/stl'));
    b.append(el('span', pl.file, 'fname'));
    box.append(b);
  }
  if (n > 1) {
    const zipName = `${stem}.zip`;
    const z = button('Download all (ZIP)', 'primary', () => {
      save(zipName, makeZip(result.plates.map((pl) => ({ name: pl.file, data: pl.stl }))), 'application/zip');
    });
    z.append(el('span', zipName, 'fname'));
    box.append(z);
  }
}

function save(name, data, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------- worker

function createWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = onWorkerMessage;
  w.onerror = (e) => {
    if (!state.building) return;
    state.building = null;
    state.error = `The build worker stopped: ${e.message || 'unknown error'}.`;
    $('building').hidden = true;
    update();
  };
  return w;
}

function warmUp() {
  if (warmedUp) return;
  warmedUp = true;
  worker ??= createWorker();
  worker.postMessage({ type: 'warmup' });
}

function startBuild() {
  const input = readInputs();
  const full = prepareJob({ ...input, generatedOn: new Date().toISOString().slice(0, 10) });
  if (full.status !== 'ready') {
    if (full.status === 'invalid-name') { state.triedEmpty = true; update(); $('name').focus(); }
    return;
  }
  if (state.building) cancelBuild();
  worker ??= createWorker();
  const id = ++buildSeq;
  state.building = { id, job: full, key: jobKey(full), started: performance.now() };
  state.error = '';
  for (const li of document.querySelectorAll('.build-steps li')) li.className = '';
  $('step-clearance').textContent = fmt(full.params.fit_clearance, 2);
  $('building').hidden = false;
  worker.postMessage({ type: 'build', id, job: full });
  update();
  if (window.matchMedia('(max-width: 899px)').matches) {
    document.querySelector('.preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function cancelBuild() {
  if (!state.building) return;
  worker?.terminate();
  worker = null;
  warmedUp = false;
  state.building = null;
  $('building').hidden = true;
}

function onWorkerMessage({ data }) {
  if (data.type === 'ready') return;
  if (!state.building || data.id !== state.building.id) return;
  if (data.type === 'step') {
    const order = ['letters', 'base', 'plates'];
    const at = order.indexOf(data.step);
    for (const li of document.querySelectorAll('.build-steps li')) {
      const i = order.indexOf(li.dataset.step);
      li.className = i < at ? 'done' : i === at ? 'active' : '';
    }
    return;
  }
  const b = state.building;
  state.building = null;
  $('building').hidden = true;
  if (data.type === 'error') {
    state.error = data.message;
    console.warn('Build failed:', data.message);
  } else if (data.type === 'done') {
    state.built = { job: b.job, result: data.result, key: b.key, seconds: (performance.now() - b.started) / 1000 };
    if (data.result.warnings.length) console.info('OpenSCAD warnings:', data.result.warnings);
  }
  update();
}

// ----------------------------------------------------------------- events

$('name').addEventListener('input', () => { warmUp(); scheduleUpdate(); });
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startBuild(); } });
form.addEventListener('submit', (e) => { e.preventDefault(); startBuild(); });
form.addEventListener('change', (e) => { if (e.target.id !== 'name') scheduleUpdate(true); });
$('height').addEventListener('input', () => scheduleUpdate(true));
for (const id of [...ADV_KEYS, 'bed-w', 'bed-d']) $(id).addEventListener('input', () => scheduleUpdate());
$('reset-advanced').addEventListener('click', () => {
  for (const k of ADV_KEYS) $(k).value = DEFAULTS[k];
  scheduleUpdate(true);
});
for (const r of document.querySelectorAll('input[name=view]')) r.addEventListener('change', () => renderPreview());
$('cancel').addEventListener('click', () => { cancelBuild(); update(); $('build').focus(); });
$('zoom-in').addEventListener('click', () => viewer?.zoomIn());
$('zoom-out').addEventListener('click', () => viewer?.zoomOut());

if ($('order-link').getAttribute('href')) $('order-wrap').hidden = false;

// Prefill from ?name=... so a puzzle can be shared as a link.
const preset = new URLSearchParams(location.search).get('name');
if (preset) $('name').value = preset.slice(0, 40);

update();
createViewer($('viewport')).then((v) => {
  if (v.error) {
    const msg = $('viewport-msg');
    msg.hidden = false;
    msg.textContent = v.error === 'webgl'
      ? 'The 3D preview needs WebGL, which is not available in this browser. You can still build and download your puzzle.'
      : 'The 3D preview could not load (check your connection). You can still build and download your puzzle.';
    document.querySelector('.zoom-btns').hidden = true;
    return;
  }
  viewer = v;
  renderPreview();
});

// Expose for debugging in the console.
window.namePuzzle = { state, inchesToMm, LETTER_COLORS, get viewer() { return viewer; }, update };
