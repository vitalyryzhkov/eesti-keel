'use strict';

const VERSION = 'v14';
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
  el.card.onscroll = null;
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
    '</section>').join('') +
    '<button type="button" class="to-top" id="to-top">↑ наверх</button>';
  el.card.scrollTop = 0;

  const top = document.getElementById('to-top');
  top.hidden = true;                                  // пока не прокрутили — не мешаем
  const onScroll = () => { top.hidden = el.card.scrollTop < 300; };
  el.card.onscroll = onScroll;
  top.onclick = () => {
    el.card.scrollTo({ top: 0, behavior: 'smooth' });
    // часть движков молча игнорирует smooth — подстраховываемся мгновенным сбросом
    setTimeout(() => { if (el.card.scrollTop > 0) el.card.scrollTop = 0; }, 350);
    top.hidden = true;
  };
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
  if (exam) return;                     // идёт попытка — ничего не перерисовываем
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
      if (exam) stopExam();             // импорт посреди попытки — попытка закрывается
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
  if (exam) stopExam();
  rebuild();
  render();
};

/* ---------- старт ---------- */

async function boot() {
  state = loadState();
  el.version.textContent = VERSION;
  const [w, g, ex] = await Promise.all([
    fetch('data/words.json').then((r) => r.json()),
    fetch('data/grammar.json').then((r) => r.json()).catch(() => null),
    fetch('data/exam.json').then((r) => r.json()).catch(() => null),
  ]);
  EXAMBANK = ex;
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
async function translate(text, src, tgt) {
  try {
    const r = await fetch(MT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, src, tgt }),
    });
    if (!r.ok) return '';
    const d = await r.json();
    return (d && d.result) || '';
  } catch (e) {
    return '';                     // офлайн или сервис лёг — вызывающий объяснит пользователю
  }
}

function alreadyHave(entry, isVerb) {
  const head = isVerb ? entry.ma : entry.nom;
  return (isVerb ? DATA.verbs : DATA.nouns).some((w) => (isVerb ? w.ma : w.nom) === head);
}

async function lookup() {
  const raw = document.getElementById('add-word').value.trim();
  const box = document.getElementById('add-result');
  const save = document.getElementById('btn-add-save');
  pending = null;
  save.disabled = true;
  document.getElementById('add-ru-wrap').hidden = true;

  if (!raw) return;
  box.textContent = 'Перевожу…';
  box.className = 'add-result';

  const cyrillic = /[а-яёА-ЯЁ]/.test(raw);
  const oneWord = !cyrillic && /^[\wõäöüšžÕÄÖÜŠŽ-]+$/.test(raw);

  // одно эстонское слово — сначала словарь: он даёт формы, а не только перевод
  if (oneWord) {
    const word = raw.toLowerCase();
    let data = null;
    try {
      const r = await fetch(API + encodeURIComponent(word), { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch (e) { /* сети нет — ниже отработает машинный перевод или сообщение */ }

    if (data) {
      const parsed = parseEntry(data, word);
      if (!parsed.error) return showEntry(parsed, box, save);
      if (parsed.error === 'nodecl') {
        box.className = 'add-result';
        box.innerHTML = '<div class="dir">словарь</div>' +
          '<div class="translation">' + esc(parsed.ru || parsed.en || '—') + '</div>' +
          '<div class="sub">Слово не склоняется и не спрягается (наречие, частица, союз), ' +
          'карточку на формы из него не собрать.</div>';
        return;
      }
    }
  }

  // всё остальное — предложения, фразы, русский текст — идёт в машинный перевод
  const src = cyrillic ? 'rus' : 'est';
  const tgt = cyrillic ? 'est' : 'rus';
  const out = await translate(raw, src, tgt);
  if (!out) {
    box.className = 'add-result bad';
    box.textContent = navigator.onLine
      ? 'Переводчик не ответил. Попробуй ещё раз.'
      : 'Нет сети. Перевод и словарь работают только онлайн.';
    return;
  }
  box.className = 'add-result ok';
  box.innerHTML =
    '<div class="dir">' + (cyrillic ? 'русский → эстонский' : 'эстонский → русский') + '</div>' +
    '<div class="translation" lang="' + (cyrillic ? 'et' : 'ru') + '">' + esc(out) + '</div>' +
    '<div class="sub mt">машинный перевод Neurotõlge — на редких словах ошибается</div>';
}

// показ словарной статьи: формы, перевод, пример, возможность завести карточку
function showEntry(parsed, box, save) {
  pending = parsed;
  const e = parsed.entry;
  const line = parsed.isVerb
    ? [e.ma, e.da, e.b, e.neg && 'ei ' + e.neg].filter(Boolean).join(' · ')
    : [e.nom, e.gen, e.part, e.plpart].filter(Boolean).join(' · ');

  box.className = 'add-result ok';
  box.innerHTML = '<div class="dir">словарь EKI</div>' +
    '<div class="found" lang="et">' + esc(line) + '</div>' +
    (parsed.ru ? '<div class="translation">' + esc(parsed.ru) + '</div>' : '') +
    (e.rek ? '<div class="sub">рекция: ' + esc(e.rek) + '</div>' : '') +
    (e.ex ? '<div class="sub" lang="et">' + esc(e.ex) + '</div>' : '');

  if (alreadyHave(e, parsed.isVerb)) {
    box.innerHTML += '<div class="sub">Это слово уже в колоде.</div>';
    pending = null;
    return;
  }

  document.getElementById('add-ru-wrap').hidden = false;
  const ruInput = document.getElementById('add-ru');
  save.disabled = false;

  if (parsed.ru) {
    ruInput.value = parsed.ru.split(',')[0].trim();
    return;
  }
  // русского в словаре нет — подставим машинный и честно это пометим
  translate(parsed.isVerb ? e.ma : e.nom, 'est', 'rus').then((ru) => {
    if (!ru || pending !== parsed) return;
    const line2 = document.createElement('div');
    line2.className = 'sub mt';
    line2.textContent = 'машинный перевод: ' + ru + ' — проверь его';
    box.appendChild(line2);
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); lookup(); }
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

/* ---------- экзамен: лексика и грамматика ---------- */

const EXAM_COUNT = 20;         // столько же заданий, сколько баллов в части экзамена
const EXAM_SECONDS = 15 * 60;
const EXAM_PASS = 0.6;         // порог на настоящем экзамене — 60%

let EXAMBANK = null;           // авторские задания из data/exam.json
let exam = null;               // текущая попытка
let examTimer = null;          // ровно один на модуль: иначе утёкшие интервалы
                               // начинают крутить счётчик новой попытки вдвое быстрее

function clearExamTimer() {
  if (examTimer !== null) { clearInterval(examTimer); examTimer = null; }
}

// Дистрактор должен быть похож на правду: берём реальные формы того же слова,
// иначе задание решается угадыванием, не зная языка
function distractors(correct, pool, need) {
  const out = [];
  const seen = new Set([norm(correct)]);
  const bag = pool.filter(Boolean).slice();
  shuffle(bag);
  for (const v of bag) {
    const k = norm(v);
    if (k && !seen.has(k)) { seen.add(k); out.push(v); }
    if (out.length === need) break;
  }
  return out;
}

function firstVariant(s) {
  return String(s || '').split(',')[0].trim();
}

function pickRandom(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function generatedItems(n) {
  const items = [];
  const nouns = DATA.nouns.filter((w) => w.gen && w.part);
  const verbs = DATA.verbs.filter((w) => w.neg && w.b);
  const allNoms = DATA.nouns.map((w) => w.nom);

  const makers = [
    // какая это форма — ровно та путаница, которую проверяет экзамен
    () => {
      const w = pickRandom(nouns);
      if (!w) return null;
      const correct = firstVariant(w.part);
      const wrong = distractors(correct, [w.nom, firstVariant(w.gen), firstVariant(w.plpart)], 3);
      if (wrong.length < 3) return null;
      return { q: w.nom + ' → ainsuse osastav?', ru: w.ru, correct, options: [correct].concat(wrong),
               why: 'Осторожно: ' + firstVariant(w.plpart) + ' — это osastav множественного числа. '
                    + 'Единственного у ' + w.nom + ' — ' + w.part + '.' };
    },
    () => {
      const w = pickRandom(nouns);
      if (!w) return null;
      const correct = firstVariant(w.gen);
      const wrong = distractors(correct, [w.nom, firstVariant(w.part), firstVariant(w.plpart)], 3);
      if (wrong.length < 3) return null;
      return { q: w.nom + ' → ainsuse omastav?', ru: w.ru, correct, options: [correct].concat(wrong),
               why: 'omastav единственного числа у ' + w.nom + ' — ' + w.gen + '.' };
    },
    // основа отрицания
    () => {
      const w = pickRandom(verbs);
      if (!w) return null;
      const correct = firstVariant(w.neg);
      const wrong = distractors(correct, [w.b, w.ma, w.da, w.nud], 3);
      if (wrong.length < 3) return null;
      return { q: 'Ta ' + w.b + '. → Ta ei ___', ru: w.ru, correct, options: [correct].concat(wrong),
               why: 'Отрицание: ei + основа без -b. ' + w.b + ' → ei ' + w.neg + '.' };
    },
    // перевод: слово целиком, без формы
    () => {
      const w = pickRandom(nouns);
      if (!w) return null;
      const wrong = distractors(w.nom, allNoms, 3);
      if (wrong.length < 3) return null;
      return { q: w.ru, ru: '', correct: w.nom, options: [w.nom].concat(wrong),
               why: w.ru + ' — ' + w.nom + '.' };
    },
  ];

  let guard = 0;
  const seenQ = new Set();
  while (items.length < n && guard++ < n * 40) {
    const it = makers[Math.floor(Math.random() * makers.length)]();
    if (!it || seenQ.has(it.q)) continue;
    seenQ.add(it.q);
    items.push(it);
  }
  return items;
}

function buildExam() {
  const authored = (EXAMBANK && EXAMBANK.items ? EXAMBANK.items : []).map((it) => ({
    q: it.q, ru: it.ru, correct: it.options[it.answer], options: it.options.slice(), why: it.why,
  }));
  shuffle(authored);

  const wantAuthored = Math.min(12, authored.length);
  const picked = authored.slice(0, wantAuthored)
    .concat(generatedItems(EXAM_COUNT - wantAuthored));

  shuffle(picked);
  for (const it of picked) shuffle(it.options);   // верный ответ не должен всегда стоять первым
  return picked.slice(0, EXAM_COUNT);
}

function fmtClock(sec) {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function startExam() {
  clearExamTimer();
  // время считаем по дедлайну, а не тиками: браузер усыпляет интервалы в
  // свёрнутой вкладке, и на телефоне экзамен вставал бы на паузу
  exam = {
    items: buildExam(), idx: 0, answers: [], done: false,
    endsAt: Date.now() + EXAM_SECONDS * 1000,
  };
  exam.left = EXAM_SECONDS;
  examTimer = setInterval(() => {
    if (!exam) { clearExamTimer(); return; }
    exam.left = Math.max(0, Math.round((exam.endsAt - Date.now()) / 1000));
    const clock = document.getElementById('exam-clock');
    if (clock) {
      clock.textContent = fmtClock(exam.left);
      clock.classList.toggle('low', exam.left <= 60);
    }
    if (exam.left <= 0) finishExam();     // время вышло — засчитываем как есть
  }, 1000);
  renderExamQuestion();
}

function stopExam() {
  clearExamTimer();
  exam = null;
  showChrome(true);
  // карточка, на которую уже ответили, не должна вернуться неотвеченной:
  // иначе повторный ответ градуирует её второй раз и интервал уедет вперёд
  current = null;
  render();
  updateStats();
}

// во время попытки прячем всю навигацию: иначе из настроек или «Перевода»
// можно подменить экран, а попытка продолжит идти невидимо
function showChrome(visible) {
  el.modes.hidden = !visible;
  for (const id of ['btn-exam', 'btn-add', 'btn-settings']) {
    const b = document.getElementById(id);
    if (b) b.hidden = !visible;
  }
}

function renderExamIntro() {
  el.pad.hidden = true;
  showChrome(false);
  el.card.innerHTML =
    '<div class="tag">экзамен · лексика и грамматика</div>' +
    '<div class="exam-q">' + EXAM_COUNT + ' заданий, ' + (EXAM_SECONDS / 60) + ' минут</div>' +
    '<div class="exam-note">Счёт из ' + EXAM_COUNT + ' баллов, порог — 60% как на настоящем экзамене. ' +
      'Подсказок нет, вернуться к заданию нельзя, разбор ошибок — в конце.</div>' +
    '<div class="exam-note">Это <b>две части из четырёх</b>: лексика и грамматика, на которых держится чтение. ' +
      'Аудирование и говорение сюда не входят — для них нужны материалы Harno.</div>' +
    lastRuns() +
    '<div class="actions">' +
      '<button id="exam-back">Назад</button>' +
      '<button class="primary" id="exam-start">Начать</button>' +
    '</div>';
  document.getElementById('exam-start').onclick = startExam;
  document.getElementById('exam-back').onclick = stopExam;
}

function lastRuns() {
  const runs = (state.exam || []).slice(-5).reverse();
  if (!runs.length) return '';
  return '<div class="exam-note">Прошлые попытки: ' +
    runs.map((r) => r.score + '/' + r.total).join(' · ') + '</div>';
}

function renderExamQuestion() {
  const it = exam.items[exam.idx];
  el.pad.hidden = true;
  el.card.innerHTML =
    '<div class="exam-head">' +
      '<span class="exam-progress">задание ' + (exam.idx + 1) + ' из ' + exam.items.length + '</span>' +
      '<span class="exam-clock" id="exam-clock">' + fmtClock(exam.left) + '</span>' +
    '</div>' +
    '<div class="exam-q" lang="et">' + esc(it.q) + '</div>' +
    (it.ru ? '<div class="exam-ru">' + esc(it.ru) + '</div>' : '') +
    '<div class="exam-options">' +
      it.options.map((o, i) =>
        '<button type="button" data-i="' + i + '" lang="et">' + esc(o) + '</button>').join('') +
    '</div>';

  el.card.querySelector('.exam-options').onclick = (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    answerExam(it.options[+btn.dataset.i]);
  };
}

function answerExam(chosen) {
  const it = exam.items[exam.idx];
  exam.answers.push({ it, chosen, ok: norm(chosen) === norm(it.correct) });
  exam.idx += 1;
  if (exam.idx >= exam.items.length) finishExam();
  else renderExamQuestion();
}

function finishExam() {
  if (!exam || exam.done) return;
  exam.done = true;
  clearExamTimer();

  const score = exam.answers.filter((a) => a.ok).length;
  const total = exam.items.length;
  const passed = score / total >= EXAM_PASS;
  const wrong = exam.answers.filter((a) => !a.ok);
  const unanswered = total - exam.answers.length;

  // результат кладём в прогресс — видно динамику между попытками
  state.exam = state.exam || [];
  state.exam.push({ d: today(), score, total });
  if (state.exam.length > 50) state.exam = state.exam.slice(-50);
  const saved = saveState();

  el.card.innerHTML =
    '<div class="tag">результат</div>' +
    '<div class="exam-score">' + score + ' / ' + total + '</div>' +
    '<div class="exam-verdict ' + (passed ? 'pass' : 'fail') + '">' +
      (passed ? 'Порог 60% пройден.' : 'Порог 60% не пройден — нужно ' + Math.ceil(total * EXAM_PASS) + '.') +
    '</div>' +
    (unanswered ? '<div class="exam-note">Время вышло, без ответа осталось ' + unanswered + '.</div>' : '') +
    (saved ? '' : '<div class="exam-note">Результат не сохранился — браузер не даёт запись.</div>') +
    (wrong.length
      ? '<div class="exam-review">' + wrong.map((a) =>
          '<div class="item">' +
            '<div class="qq" lang="et">' + esc(a.it.q) + '</div>' +
            '<div><span class="mine">' + esc(a.chosen) + '</span> → ' +
              '<span class="right">' + esc(a.it.correct) + '</span></div>' +
            (a.it.why ? '<div class="why">' + esc(a.it.why) + '</div>' : '') +
          '</div>').join('') + '</div>'
      : '<div class="exam-note">Без ошибок.</div>') +
    '<div class="actions">' +
      '<button id="exam-again">Ещё раз</button>' +
      '<button class="primary" id="exam-exit">К карточкам</button>' +
    '</div>';

  document.getElementById('exam-again').onclick = () => { clearExamTimer(); exam = null; renderExamIntro(); };
  document.getElementById('exam-exit').onclick = stopExam;
}

on('btn-exam', () => { clearExamTimer(); exam = null; renderExamIntro(); });
