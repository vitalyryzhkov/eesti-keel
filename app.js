'use strict';

const VERSION = 'v9';
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

let BASE = null;      // words.json как он есть в репозитории
let DATA = null;      // BASE + слова, добавленные пользователем
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
    return true;
  } catch (e) {
    // приватный режим Safari или кончилась квота: продолжаем в памяти,
    // но врать пользователю «сохранено» нельзя — вызывающий решает, что сказать
    return false;
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
      tag: (n.pos === 'adj' ? 'omadussõna' : 'nimisõna') + ' · формы',
      prompt: n.nom, ru: n.ru, fields, ex: n.ex,
    });
    out.push({
      id: n.id + ':prod', kind: 'prod', deck: 'vocab',
      tag: 'слово · ru → et', prompt: n.ru, ru: '', answer: n.nom,
      extra: n.gen + ' · ' + n.part, ex: n.ex,
    });
    out.push({
      id: n.id + ':recog', kind: 'recog', deck: 'vocab',
      tag: 'слово · et → ru', prompt: n.nom, answer: n.ru,
      extra: n.gen + ' · ' + n.part, ex: n.ex,
    });
  }
  for (const v of DATA.verbs) {
    const vFields = [
      { key: 'da', label: 'da-infinitiiv', answer: v.da },
      { key: 'b', label: '3. pööre (ta ...)', answer: v.b },
    ];
    // основа отрицания: ei + эта форма, одна на все лица
    if (v.neg) vFields.push({ key: 'neg', label: 'eitus (ta ei ...)', answer: v.neg });
    out.push({
      id: v.id + ':forms', kind: 'forms', deck: 'forms',
      tag: 'tegusõna · формы', prompt: v.ma,
      ru: v.ru + (v.rek ? ' · ' + v.rek : ''),   // рекция из словаря: aitama keda, helistama kellele
      fields: vFields, ex: v.ex,
    });
    out.push({
      id: v.id + ':prod', kind: 'prod', deck: 'vocab',
      tag: 'слово · ru → et', prompt: v.ru, answer: v.ma,
      extra: v.da + ' · ' + v.b, ex: v.ex,
    });
    out.push({
      id: v.id + ':recog', kind: 'recog', deck: 'vocab',
      tag: 'слово · et → ru', prompt: v.ma, answer: v.ru,
      extra: v.da + ' · ' + v.b, ex: v.ex,
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
    showExample();
    el.card.querySelector('.actions').innerHTML =
      '<button class="bad" id="no">Не знал</button><button class="ok" id="yes">Знал</button>';
    document.getElementById('no').onclick = () => finish(false, true);
    document.getElementById('yes').onclick = () => finish(true, true);
  };
}

function showExample() {
  const c = current;
  if (!c.ex || el.card.querySelector('.example')) return;
  const node = document.createElement('div');
  node.className = 'example';
  node.lang = 'et';
  node.textContent = c.ex;
  const actions = el.card.querySelector('.actions');
  el.card.insertBefore(node, actions);
}

function finish(ok, immediate) {
  const c = current;
  showExample();
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
      rebuild();
      render();
    } catch (e) {
      alert('Не похоже на файл прогресса: ' + e.message);
    }
    el.fileImport.value = '';
  };
  r.readAsText(f);
};

document.getElementById('btn-reset').onclick = () => {
  const mine = (state.words && (state.words.nouns.length + state.words.verbs.length)) || 0;
  const warn = mine
    ? 'Стереть весь прогресс? Вместе с ним удалятся ' + mine + ' слов, добавленных вручную.'
    : 'Стереть весь прогресс?';
  if (!confirm(warn)) return;
  state = defaultState();
  saveState();
  rebuild();
  render();
};

/* ---------- старт ---------- */

async function boot() {
  state = loadState();
  el.version.textContent = VERSION;
  const [w, g] = await Promise.all([
    fetch('data/words.json').then((r) => r.json()),
    fetch('data/grammar.json').then((r) => r.json()).catch(() => null),
  ]);
  BASE = { nouns: w.nouns, verbs: w.verbs };
  GRAMMAR = g;
  mergeUserWords();          // слова, добавленные с телефона
  CARDS = buildCards();
  buildQueue();
  render();
  updateStats();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Перезагрузку обслуживает СТАРЫЙ воркер — он контроллер на момент навигации.
    // Без этого новая версия появлялась бы только со второй перезагрузки, и
    // выглядело бы как «деплой не доехал». Ждём смены контроллера и обновляемся.
    // при самой первой установке контроллера ещё не было — там перезагружаться не за чем
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;   // защита от петли перезагрузок
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot().catch((e) => {
  el.card.innerHTML = '<div class="done">Не загрузились данные.<br>' + esc(e.message) + '</div>';
});

/* ---------- добавление слова из словаря EKI ---------- */

const API = 'https://api.sonapi.ee/v2/';
const MT = 'https://api.tartunlp.ai/translation/v2';   // Neurotõlge, госпереводчик
const NOUN_MAP = [['nom', 'SgN'], ['gen', 'SgG'], ['part', 'SgP'], ['plpart', 'PlP']];
const VERB_MAP = [['ma', 'Sup'], ['da', 'Inf'], ['b', 'IndPrSg3'], ['neg', 'IndPrPs_']];

let pending = null;   // разобранная словарная статья, ждёт подтверждения

function userWords() {
  if (!state.words) state.words = { nouns: [], verbs: [] };
  return state.words;
}

// слова, добавленные с телефона, живут в прогрессе — значит попадают в бэкап.
// Пересобираем из BASE, а не дописываем в DATA: иначе повторный вызов
// (после импорта бэкапа) продублировал бы всю пользовательскую колоду
function mergeUserWords() {
  const u = userWords();
  DATA = {
    nouns: BASE.nouns.concat(u.nouns || []),
    verbs: BASE.verbs.concat(u.verbs || []),
  };
}

// пересобрать всё, что зависит от словаря: после импорта, сброса, добавления слова
function rebuild() {
  mergeUserWords();
  CARDS = buildCards();
  current = null;
  queue = [];
  buildQueue();
  updateStats();
}

function formsFromApi(res) {
  const out = {};
  for (const f of res.wordForms || []) {
    const v = (f.value || '').trim();
    if (v && v !== '-' && !(f.code in out)) out[f.code] = v;
  }
  return out;
}

function parseEntry(data, word) {
  const results = (data && data.searchResult) || [];
  if (!results.length) return { error: 'absent' };

  const res = results.find((r) => (r.wordClasses || []).some((c) => c && c.toLowerCase() === 'verb'))
    || results[0];
  const classes = (res.wordClasses || []).filter(Boolean).map((c) => c.toLowerCase());
  const api = formsFromApi(res);
  const meanings = res.meanings || [];

  let rek = '';
  let ex = '';
  let pos = 'n';
  for (const m of meanings) {
    if (!rek && m.rection) rek = m.rection;
    for (const p of m.partOfSpeech || []) {
      if ((p.code || '').toLowerCase().startsWith('adj')) pos = 'adj';
    }
    for (const e of m.examples || []) {
      const t = (e || '').trim();
      if (t.split(/\s+/).length >= 3 && t.length <= 70 && (!ex || t.length < ex.length)) ex = t;
    }
  }

  const isVerb = classes.includes('verb');
  const map = isVerb ? VERB_MAP : NOUN_MAP;
  const entry = { id: 'u_' + word.replace(/[^\wõäöüšž]/gi, ''), ru: '' };
  for (const [field, code] of map) entry[field] = api[code] || '';
  if (ex) entry.ex = ex;
  if (isVerb && rek) entry.rek = rek;
  if (!isVerb && pos === 'adj') entry.pos = 'adj';

  const required = isVerb ? ['ma', 'da', 'b'] : ['nom', 'gen', 'part'];
  // наречия, частицы, союзы (ka, väga) в словаре есть, но форм у них нет —
  // это не «слова не существует», и советовать «проверь начальную форму» тут вредно
  if (required.some((f) => !entry[f])) return { error: 'nodecl', ru: glosses(res, 'rus'), en: glosses(res, 'eng') };

  return { entry, isVerb, ru: glosses(res, 'rus'), en: glosses(res, 'eng') };
}

// EKI держит переводы внутри значений, словарём по языкам: {"rus": [{words: "книга"}], ...}
function glosses(res, lang) {
  const out = [];
  for (const m of res.meanings || []) {
    const byLang = m.translations;
    if (!byLang || typeof byLang !== 'object' || Array.isArray(byLang)) continue;
    for (const item of byLang[lang] || []) {
      const w = (item && item.words) || '';
      for (const part of String(w).split(',')) {
        const v = part.trim();
        if (v && !out.includes(v)) out.push(v);
      }
    }
  }
  return out.slice(0, 5).join(', ');
}

// Neurotõlge переводит предложения хорошо, а редкие отдельные слова путает
// (sügavkülmik -> «каучуковая бревна»), поэтому результат идёт как ПОДСКАЗКА,
// которую пользователь подтверждает, а не как готовый перевод
async function suggestRu(word, sentence) {
  const text = sentence || word;
  try {
    const r = await fetch(MT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, src: 'est', tgt: 'rus' }),
    });
    if (!r.ok) return '';
    const d = await r.json();
    return (d && d.result) || '';
  } catch (e) {
    return '';                     // офлайн или сервис лёг — просто нет подсказки
  }
}

function alreadyHave(entry, isVerb) {
  const head = isVerb ? entry.ma : entry.nom;
  return (isVerb ? DATA.verbs : DATA.nouns).some((w) => (isVerb ? w.ma : w.nom) === head);
}

async function lookup() {
  const word = document.getElementById('add-word').value.trim().toLowerCase();
  const box = document.getElementById('add-result');
  const save = document.getElementById('btn-add-save');
  pending = null;
  save.disabled = true;
  document.getElementById('add-ru-wrap').hidden = true;

  if (!word) return;
  box.textContent = 'Спрашиваю словарь…';
  box.className = 'add-result';

  let data;
  try {
    const r = await fetch(API + encodeURIComponent(word), { cache: 'no-store' });
    if (!r.ok) throw new Error('словарь ответил ' + r.status);
    data = await r.json();
  } catch (e) {
    // офлайн — это норма для этого приложения, объясняем прямо
    box.className = 'add-result bad';
    box.textContent = navigator.onLine
      ? 'Словарь недоступен: ' + e.message
      : 'Нет сети. Формы берутся из словаря EKI, офлайн слово добавить нельзя.';
    return;
  }

  const parsed = parseEntry(data, word);
  if (parsed.error === 'absent') {
    box.className = 'add-result bad';
    box.textContent = 'В словаре нет такого слова. Проверь начальную форму: ' +
      'существительные — nimetav (raamat), глаголы — ma-инфинитив (lugema).';
    return;
  }
  if (parsed.error === 'nodecl') {
    box.className = 'add-result bad';
    box.textContent = 'Слово в словаре есть, но оно не склоняется и не спрягается ' +
      '(наречие, частица, союз)' + (parsed.ru ? ' — это ' + parsed.ru : '') +
      '. Карточку на формы из него не собрать; такие слова — в шпаргалку.';
    return;
  }
  if (alreadyHave(parsed.entry, parsed.isVerb)) {
    box.className = 'add-result';
    box.textContent = 'Это слово уже в колоде.';
    return;
  }

  pending = parsed;
  const e = parsed.entry;
  const line = parsed.isVerb
    ? [e.ma, e.da, e.b, e.neg && 'ei ' + e.neg].filter(Boolean).join(' · ')
    : [e.nom, e.gen, e.part, e.plpart].filter(Boolean).join(' · ');
  box.className = 'add-result ok';
  box.innerHTML = '<div class="found" lang="et">' + esc(line) + '</div>' +
    (e.rek ? '<div class="sub">рекция: ' + esc(e.rek) + '</div>' : '') +
    (e.ex ? '<div class="sub" lang="et">' + esc(e.ex) + '</div>' : '');

  document.getElementById('add-ru-wrap').hidden = false;
  const ruInput = document.getElementById('add-ru');
  ruInput.focus();
  save.disabled = false;

  // Перевод берём из словаря EKI — он нормативный. Подставляем в поле,
  // пользователь правит под себя (в словаре часто целый ряд синонимов)
  if (parsed.ru) {
    const hint = document.createElement('div');
    hint.className = 'sub';
    hint.textContent = 'словарь: ' + parsed.ru + (parsed.en ? '  ·  ' + parsed.en : '');
    box.appendChild(hint);
    ruInput.value = parsed.ru.split(',')[0].trim();
    return;
  }

  // русского в словаре нет — только тогда зовём машинный перевод, и честно
  // помечаем его как машинный: на редких словах он врёт (sügavkülmik)
  suggestRu(parsed.isVerb ? e.ma : e.nom, e.ex).then((ru) => {
    if (!ru || pending !== parsed) return;      // пока ждали, пользователь ушёл дальше
    const line = document.createElement('div');
    line.className = 'sub mt';
    line.textContent = 'машинный перевод: ' + ru + ' — проверь его';
    box.appendChild(line);
    if (!ruInput.value) ruInput.value = ru;
  });
}

function saveWord() {
  if (!pending) return;
  const ruInput = document.getElementById('add-ru');
  const ru = ruInput.value.trim();
  if (!ru) {
    const box = document.getElementById('add-result');
    box.className = 'add-result bad';
    box.textContent = 'Впиши перевод — без него карточка «слово → перевод» бессмысленна.';
    ruInput.focus();
    return;
  }
  pending.entry.ru = ru;
  const u = userWords();
  (pending.isVerb ? u.verbs : u.nouns).push(pending.entry);
  const saved = saveState();
  rebuild();

  const box = document.getElementById('add-result');
  box.className = saved ? 'add-result ok' : 'add-result bad';
  box.textContent = saved
    ? 'Добавлено. Слово попадёт в очередь как новое.'
    : 'Слово добавлено, но СОХРАНИТЬ НЕ УДАЛОСЬ — браузер не даёт запись ' +
      '(приватный режим или кончилось место). После перезагрузки оно пропадёт.';
  document.getElementById('add-word').value = '';
  document.getElementById('add-ru').value = '';
  document.getElementById('add-ru-wrap').hidden = true;
  document.getElementById('btn-add-save').disabled = true;
  pending = null;
  document.getElementById('add-word').focus();
}

const on = (id, handler) => {
  const node = document.getElementById(id);
  if (node) node.onclick = handler;         // старый index.html не должен ронять весь скрипт
};

on('btn-add', () => {
  document.getElementById('add-result').textContent = '';
  document.getElementById('add-result').className = 'add-result';
  document.getElementById('add-ru-wrap').hidden = true;
  document.getElementById('btn-add-save').disabled = true;
  pending = null;
  document.getElementById('adder').showModal();
  document.getElementById('add-word').focus();
});
on('btn-lookup', lookup);
on('btn-add-save', saveWord);
on('btn-add-cancel', () => document.getElementById('adder').close());

const addWord = document.getElementById('add-word');
const addPad = document.getElementById('add-pad');
if (addWord) {
  addWord.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); lookup(); }
  });
  addWord.addEventListener('focus', function () { lastInput = this; });
  document.getElementById('add-ru').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveWord(); }
  });
}
if (addPad) {
  addPad.addEventListener('mousedown', (e) => e.preventDefault());
  addPad.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ch]');
  if (!btn) return;
  const inp = document.getElementById('add-word');
  const s = inp.selectionStart ?? inp.value.length;
  const t = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, s) + btn.dataset.ch + inp.value.slice(t);
  inp.focus();
  inp.setSelectionRange(s + 1, s + 1);
  });
}
