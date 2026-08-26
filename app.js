'use strict';

const VERSION = 'v1';
const STORE = 'eesti-a2-state';

const el = {
  card: document.getElementById('card'),
  stats: document.getElementById('stats'),
  modes: document.getElementById('modes'),
  pad: document.getElementById('pad'),
  version: document.getElementById('version'),
  settings: document.getElementById('settings'),
  setNew: document.getElementById('set-new'),
  fileImport: document.getElementById('file-import'),
};

let DATA = null;      // words.json
let GRAMMAR = null;   // grammar.json
let CARDS = [];       // все возможные карточки
let state = null;     // прогресс
let mode = 'forms';
let queue = [];
let current = null;
let lastInput = null; // куда вставлять õäöü

/* ---------- состояние ---------- */

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 86400000);
}

function defaultState() {
  return { cards: {}, newDay: today(), newCount: 0, settings: { newPerDay: 12 }, seen: 0 };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    if (!s.cards) return defaultState();
    if (!s.settings) s.settings = { newPerDay: 12 };
    return s;
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch (e) {
    /* приватный режим Safari — молча продолжаем в памяти */
  }
}

/* ---------- построение карточек ---------- */

function buildCards() {
  const out = [];
  for (const n of DATA.nouns) {
    const fields = [
      { key: 'gen', label: 'omastav (кого/чего)', answer: n.gen },
      { key: 'part', label: 'osastav (кого/что)', answer: n.part },
    ];
    if (n.plpart) fields.push({ key: 'plpart', label: 'mitmuse osastav (мн. ч.)', answer: n.plpart });
    out.push({
      id: n.id + ':forms', kind: 'forms', deck: 'forms',
      tag: 'nimisõna · формы', prompt: n.nom, ru: n.ru, fields,
    });
    out.push({
      id: n.id + ':prod', kind: 'prod', deck: 'vocab',
      tag: 'слово · ru → et', prompt: n.ru, ru: '', answer: n.nom,
      extra: n.gen + ' · ' + n.part,
    });
    out.push({
      id: n.id + ':recog', kind: 'recog', deck: 'vocab',
      tag: 'слово · et → ru', prompt: n.nom, answer: n.ru,
      extra: n.gen + ' · ' + n.part,
    });
  }
  for (const v of DATA.verbs) {
    out.push({
      id: v.id + ':forms', kind: 'forms', deck: 'forms',
      tag: 'tegusõna · формы', prompt: v.ma, ru: v.ru,
      fields: [
        { key: 'da', label: 'da-infinitiiv', answer: v.da },
        { key: 'b', label: '3. pööre (ta ...)', answer: v.b },
      ],
    });
    out.push({
      id: v.id + ':prod', kind: 'prod', deck: 'vocab',
      tag: 'слово · ru → et', prompt: v.ru, answer: v.ma,
      extra: v.da + ' · ' + v.b,
    });
    out.push({
      id: v.id + ':recog', kind: 'recog', deck: 'vocab',
      tag: 'слово · et → ru', prompt: v.ma, answer: v.ru,
      extra: v.da + ' · ' + v.b,
    });
  }
  return out;
}

/* ---------- планировщик (SM-2 lite) ---------- */

function sched(id) {
  return state.cards[id] || null;
}

function grade(id, ok) {
  const t = today();
  let c = state.cards[id];
  if (!c) c = state.cards[id] = { i: 0, e: 2.3, r: 0, l: 0, d: t };
  if (ok) {
    c.r += 1;
    c.i = c.i === 0 ? 1 : c.i === 1 ? 3 : Math.round(c.i * c.e);
    c.e = Math.min(2.8, c.e + 0.1);
    c.d = t + c.i;
  } else {
    c.l += 1;
    c.i = 0;
    c.e = Math.max(1.3, c.e - 0.2);
    c.d = t;
  }
  state.seen = (state.seen || 0) + 1;
  saveState();
}

function decksFor(m) {
  if (m === 'forms') return ['forms'];
  if (m === 'vocab') return ['vocab'];
  return ['forms', 'vocab'];
}

function buildQueue() {
  const t = today();
  if (state.newDay !== t) { state.newDay = t; state.newCount = 0; saveState(); }

  const decks = decksFor(mode);
  const pool = CARDS.filter((c) => decks.includes(c.deck));

  const due = [];
  const fresh = [];
  for (const c of pool) {
    const s = sched(c.id);
    if (!s) fresh.push(c);
    else if (s.d <= t) due.push(c);
  }
  shuffle(due);
  shuffle(fresh);

  const room = Math.max(0, (state.settings.newPerDay || 0) - (state.newCount || 0));
  queue = due.concat(fresh.slice(0, room));
  shuffle(queue);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

/* ---------- проверка ответа ---------- */

function norm(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matches(given, expected) {
  const g = norm(given);
  // допускаем любой из вариантов через запятую/точку с запятой
  return expected
    .split(/[;,]/)
    .map((x) => norm(x))
    .filter(Boolean)
    .some((x) => x === g || x.replace(/\s*\(.*?\)\s*/g, '') === g);
}

/* ---------- отрисовка ---------- */

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  if (mode === 'cheat') return renderCheat();
  el.pad.hidden = true;

  if (!current) {
    if (!queue.length) buildQueue();
    current = queue.shift() || null;
  }
  if (!current) return renderDone();

  const c = current;
  if (c.kind === 'forms') return renderForms(c);
  if (c.kind === 'prod') return renderProd(c);
  return renderRecog(c);
}

function renderForms(c) {
  el.card.innerHTML =
    '<div class="tag">' + esc(c.tag) + '</div>' +
    '<div class="prompt" lang="et">' + esc(c.prompt) + '</div>' +
    '<div class="prompt-ru">' + esc(c.ru || '') + '</div>' +
    '<div class="fields">' +
      c.fields.map((f, i) =>
        '<div class="field" data-i="' + i + '">' +
          '<label for="f' + i + '">' + esc(f.label) + '</label>' +
          input('f' + i) +
        '</div>').join('') +
    '</div>' +
    '<div class="actions"><button class="primary" id="check">Проверить</button></div>';

  el.pad.hidden = false;
  wireInputs();
  document.getElementById('check').onclick = checkForms;
  const first = el.card.querySelector('input');
  if (first) first.focus();
}

function input(id) {
  return '<input id="' + id + '" type="text" lang="et" autocomplete="off" ' +
    'autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">';
}

function checkForms() {
  const c = current;
  const fields = [...el.card.querySelectorAll('.field')];
  let allOk = true;

  fields.forEach((node, i) => {
    const inp = node.querySelector('input');
    const spec = c.fields[i];
    const ok = matches(inp.value, spec.answer);
    if (!ok) allOk = false;
    node.classList.add(ok ? 'ok' : 'bad');
    inp.disabled = true;
    if (!ok) {
      const p = document.createElement('div');
      p.className = 'right';
      p.innerHTML = (inp.value.trim() ? '<s>' + esc(inp.value.trim()) + '</s>' : '') + esc(spec.answer);
      node.appendChild(p);
    }
  });

  finish(allOk);
}

function renderProd(c) {
  el.card.innerHTML =
    '<div class="tag">' + esc(c.tag) + '</div>' +
    '<div class="prompt">' + esc(c.prompt) + '</div>' +
    '<div class="fields"><div class="field">' +
      '<label for="f0">по-эстонски</label>' + input('f0') +
    '</div></div>' +
    '<div class="actions"><button class="primary" id="check">Проверить</button></div>';

  el.pad.hidden = false;
  wireInputs();
  document.getElementById('check').onclick = () => {
    const node = el.card.querySelector('.field');
    const inp = node.querySelector('input');
    const ok = matches(inp.value, c.answer);
    node.classList.add(ok ? 'ok' : 'bad');
    inp.disabled = true;
    const p = document.createElement('div');
    p.className = 'right';
    p.innerHTML = (!ok && inp.value.trim() ? '<s>' + esc(inp.value.trim()) + '</s>' : '') +
      esc(c.answer) + (c.extra ? ' <span style="opacity:.65">— ' + esc(c.extra) + '</span>' : '');
    node.appendChild(p);
    finish(ok);
  };
  el.card.querySelector('input').focus();
}

function renderRecog(c) {
  el.card.innerHTML =
    '<div class="tag">' + esc(c.tag) + '</div>' +
    '<div class="prompt" lang="et">' + esc(c.prompt) + '</div>' +
    '<div id="reveal"></div>' +
    '<div class="actions"><button class="primary" id="show">Показать</button></div>';

  document.getElementById('show').onclick = () => {
    document.getElementById('reveal').innerHTML =
      '<div class="answer">' + esc(c.answer) +
      (c.extra ? '<span class="sub" lang="et">' + esc(c.extra) + '</span>' : '') + '</div>';
    el.card.querySelector('.actions').innerHTML =
      '<button class="bad" id="no">Не знал</button><button class="ok" id="yes">Знал</button>';
    document.getElementById('no').onclick = () => finish(false, true);
    document.getElementById('yes').onclick = () => finish(true, true);
  };
}

function finish(ok, immediate) {
  const c = current;
  const wasNew = !sched(c.id);
  grade(c.id, ok);
  if (wasNew) { state.newCount = (state.newCount || 0) + 1; saveState(); }
  if (!ok) queue.splice(Math.min(3, queue.length), 0, c);

  const next = () => { current = null; render(); updateStats(); };

  if (immediate) return next();

  const actions = el.card.querySelector('.actions');
  actions.innerHTML = '<button class="primary" id="next">' +
    (ok ? 'Дальше' : 'Понял, дальше') + '</button>';
  const btn = document.getElementById('next');
  btn.onclick = next;
  btn.focus();
  updateStats();
}

function renderDone() {
  el.card.innerHTML =
    '<div class="done"><span class="big">✔</span>' +
    'На сегодня всё.<br>Возвращайся завтра — или подними лимит новых слов в настройках.</div>';
  el.pad.hidden = true;
}

function renderCheat() {
  el.pad.hidden = true;
  if (!GRAMMAR) { el.card.innerHTML = '<div class="done">Загружаю…</div>'; return; }
  el.card.innerHTML = GRAMMAR.sections.map((s) =>
    '<section class="cheat">' +
      '<h2>' + esc(s.title) + '</h2>' +
      (s.note ? '<p class="note">' + esc(s.note) + '</p>' : '') +
      s.rows.map((r) =>
        '<div class="ex">' +
          '<div class="et" lang="et">' + esc(r.et) + '</div>' +
          (r.ru ? '<div class="ru">' + esc(r.ru) + '</div>' : '') +
          (r.hint ? '<div class="hint">' + esc(r.hint) + '</div>' : '') +
        '</div>').join('') +
    '</section>').join('');
  el.card.scrollTop = 0;
}

/* ---------- ввод ---------- */

function wireInputs() {
  const inputs = [...el.card.querySelectorAll('input')];
  inputs.forEach((inp, i) => {
    inp.addEventListener('focus', () => { lastInput = inp; });
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const nextInp = inputs[i + 1];
      if (nextInp && !nextInp.disabled) nextInp.focus();
      else {
        const check = document.getElementById('check');
        if (check) check.click();
      }
    });
  });
  lastInput = inputs[0] || null;
}

el.pad.addEventListener('mousedown', (e) => e.preventDefault());
el.pad.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ch]');
  if (!btn || !lastInput || lastInput.disabled) return;
  const inp = lastInput;
  const s = inp.selectionStart ?? inp.value.length;
  const t = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, s) + btn.dataset.ch + inp.value.slice(t);
  inp.focus();
  inp.setSelectionRange(s + 1, s + 1);
});

/* ---------- статистика и режимы ---------- */

function updateStats() {
  if (mode === 'cheat') { el.stats.textContent = GRAMMAR ? GRAMMAR.sections.length + ' тем' : ''; return; }
  const t = today();
  const decks = decksFor(mode);
  let due = 0, learned = 0, fresh = 0;
  for (const c of CARDS) {
    if (!decks.includes(c.deck)) continue;
    const s = sched(c.id);
    if (!s) fresh++;
    else { if (s.d <= t) due++; if (s.i >= 7) learned++; }
  }
  el.stats.innerHTML =
    'сегодня <b>' + (due + Math.min(fresh, Math.max(0, (state.settings.newPerDay || 0) - (state.newCount || 0)))) + '</b>' +
    ' · новых <b>' + fresh + '</b>' +
    ' · выучено <b>' + learned + '</b>';
}

el.modes.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  [...el.modes.children].forEach((b) => b.classList.toggle('active', b === btn));
  mode = btn.dataset.mode;
  current = null;
  queue = [];
  if (mode !== 'cheat') buildQueue();
  render();
  updateStats();
});

/* ---------- настройки ---------- */

document.getElementById('btn-settings').onclick = () => {
  el.setNew.value = state.settings.newPerDay;
  el.settings.showModal();
};
el.settings.addEventListener('close', () => {
  const v = parseInt(el.setNew.value, 10);
  if (!isNaN(v) && v >= 0) { state.settings.newPerDay = v; saveState(); }
  if (mode !== 'cheat') { buildQueue(); if (!current) render(); }
  updateStats();
});

document.getElementById('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'eesti-progress-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

document.getElementById('btn-import').onclick = () => el.fileImport.click();
el.fileImport.onchange = () => {
  const f = el.fileImport.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const s = JSON.parse(r.result);
      if (!s.cards) throw new Error('нет поля cards');
      state = s;
      if (!state.settings) state.settings = { newPerDay: 12 };
      saveState();
      current = null;
      buildQueue();
      render();
      updateStats();
    } catch (e) {
      alert('Не похоже на файл прогресса: ' + e.message);
    }
  };
  r.readAsText(f);
};

document.getElementById('btn-reset').onclick = () => {
  if (!confirm('Стереть весь прогресс?')) return;
  state = defaultState();
  saveState();
  current = null;
  buildQueue();
  render();
  updateStats();
};

/* ---------- старт ---------- */

async function boot() {
  state = loadState();
  el.version.textContent = VERSION;
  const [w, g] = await Promise.all([
    fetch('data/words.json').then((r) => r.json()),
    fetch('data/grammar.json').then((r) => r.json()).catch(() => null),
  ]);
  DATA = w;
  GRAMMAR = g;
  CARDS = buildCards();
  buildQueue();
  render();
  updateStats();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot().catch((e) => {
  el.card.innerHTML = '<div class="done">Не загрузились данные.<br>' + esc(e.message) + '</div>';
});
