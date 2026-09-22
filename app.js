'use strict';

const VERSION = 'v38';
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
  actions: document.getElementById('actions'),
};

// Кнопки живут ОТДЕЛЬНО от карточки. Пока они были внутри неё и липли к низу,
// при клавиатуре кнопка ложилась поверх поля ввода: тап по полю попадал в неё
// и засчитывал карточку с пустым ответом.
function setActions(html) {
  el.actions.innerHTML = html || '';
  el.actions.hidden = !html;
}

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

// Схема изменения слова: общее начало всех форм отбрасываем, буквы хвоста
// заглавной формы заменяем метками A, B, C…, последнюю букву второй формы
// (гласную основы, её в заглавной нет) — «*». Пустая форма — «-».
// raamat → raamatu, raamatut и tänav → tänava, tänavat дают одну схему,
// kool → kooli и pood → poe — разные.
function kinPattern(forms) {
  const fs = forms.map((f) => String(f || '').split(',')[0].trim());
  const full = fs.filter(Boolean);
  let p = 0;
  while (full.length && full.every((f) => f.length > p) && new Set(full.map((f) => f[p])).size === 1) p++;
  const tails = fs.map((f) => (f ? [...f.slice(p)] : null));
  const sym = new Map();
  for (const ch of tails[0] || []) if (!sym.has(ch)) sym.set(ch, String.fromCharCode(65 + sym.size));
  const t1 = tails[1];
  if (t1 && t1.length && !sym.has(t1[t1.length - 1])) sym.set(t1[t1.length - 1], '*');
  return tails.map((t) => (t ? t.map((ch) => sym.get(ch) || ch).join('') : '-')).join('|');
}

// id слова → его группа: слова колоды с тем же типом EKI и той же схемой форм.
// Слова без eki_type (добавленные до v36) ни в какую группу не попадают
function kinGroups() {
  const groups = new Map();
  const put = (kind, w, forms) => {
    if (!w.eki_type) return;
    // номер типа — строго как у EKI: «02» и «2» не склеиваем. На показанных
    // формах они совпадают, но в полной парадигме бывают различия (у röster,
    // 02e, лишние варианты мн. ч., которых нет у kelder, 2e), а что значит ноль,
    // мы не знаем
    const key = kind + ':' + w.eki_type + ':' + kinPattern(forms);
    if (!groups.has(key)) groups.set(key, []);
    const first = (f) => String(f || '').split(',')[0].trim();
    groups.get(key).push({ id: w.id, head: forms[0], a: first(forms[1]), b: first(forms[2]) });
  };
  for (const n of DATA.nouns) put('n', n, [n.nom, n.gen, n.part, n.plpart]);
  for (const v of DATA.verbs) put('v', v, [v.ma, v.da, v.b, v.neg]);
  const byId = new Map();
  for (const list of groups.values()) for (const w of list) byId.set(w.id, list);
  return byId;
}

// варианты перевода по отдельности: «картина, фото» → ['картина', 'фото']
function ruParts(w) {
  return String(w.ru || '').split(/[;,]/).map((v) => norm(v)).filter(Boolean);
}

function buildCards() {
  const out = [];
  const kin = kinGroups();
  // «магазин» — это и pood, и kauplus. Карточка ru → et принимает любое слово
  // колоды с таким же переводом: иначе верный ответ идёт в ошибки и портит
  // интервал повторения. Сравниваем по отдельным вариантам перевода, а не по
  // строке целиком: у pilt «картина, фото», у foto «фото, фотография» — общее
  // «фото» делает их синонимами
  const byRu = new Map();
  for (const w of DATA.nouns.concat(DATA.verbs)) {
    for (const v of ruParts(w)) {
      if (!byRu.has(v)) byRu.set(v, []);
      byRu.get(v).push(w.nom || w.ma);
    }
  }
  // показываем слово самой карточки (рядом с ним стоят ЕГО формы), а принимаем
  // и синоним: accept — то, что сверяется, answer — то, что видно
  const accepts = (w, head) => {
    const out = [head];
    for (const v of ruParts(w)) {
      for (const h of byRu.get(v) || []) if (!out.includes(h)) out.push(h);
    }
    return out.join(', ');
  };
  for (const n of DATA.nouns) {
    const fields = [
      { key: 'gen', label: 'omastav (кого/чего)', answer: n.gen },
      { key: 'part', label: 'osastav (кого/что)', answer: n.part },
    ];
    if (n.plpart) fields.push({ key: 'plpart', label: 'mitmuse osastav (мн. ч.)', answer: n.plpart });
    out.push({
      id: n.id + ':forms', kind: 'forms', deck: 'forms',
      tag: ({ adj: 'omadussõna', num: 'arvsõna' }[n.pos] || 'nimisõna') + ' · формы',
      prompt: n.nom, ru: n.ru, fields, ex: n.ex, wid: n.id, kin: kin.get(n.id),
    });
    out.push({
      id: n.id + ':prod', kind: 'prod', deck: 'vocab',
      tag: 'слово · ru → et', prompt: n.ru, ru: '', answer: n.nom, accept: accepts(n, n.nom),
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
      fields: vFields, ex: v.ex, wid: v.id, kin: kin.get(v.id),
    });
    out.push({
      id: v.id + ':prod', kind: 'prod', deck: 'vocab',
      tag: 'слово · ru → et', prompt: v.ru, answer: v.ma, accept: accepts(v, v.ma),
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
    '<div class="card-head">' +
      '<div class="tag">' + esc(c.tag) + '</div>' +
      '<div class="prompt" lang="et">' + esc(c.prompt) + '</div>' +
      '<div class="prompt-ru">' + esc(c.ru || '') + '</div>' +
    '</div>' +
    '<div class="card-scroll"><div class="fields">' +
      c.fields.map((f, i) =>
        '<div class="field" data-i="' + i + '">' +
          '<label for="f' + i + '">' + esc(f.label) + '</label>' +
          input('f' + i) +
        '</div>').join('') +
    '</div></div>';
  setActions('<button class="primary" id="check">Проверить</button>');

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
    '<div class="card-head">' +
      '<div class="tag">' + esc(c.tag) + '</div>' +
      '<div class="prompt">' + esc(c.prompt) + '</div>' +
    '</div>' +
    '<div class="card-scroll"><div class="fields"><div class="field">' +
      '<label for="f0">по-эстонски</label>' + input('f0') +
    '</div></div></div>';
  setActions('<button class="primary" id="check">Проверить</button>');

  el.pad.hidden = false;
  wireInputs();
  document.getElementById('check').onclick = () => {
    const node = el.card.querySelector('.field');
    const inp = node.querySelector('input');
    const ok = matches(inp.value, c.accept || c.answer);
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
    '<div class="card-head">' +
      '<div class="tag">' + esc(c.tag) + '</div>' +
      '<div class="prompt" lang="et">' + esc(c.prompt) + '</div>' +
    '</div>' +
    '<div class="card-scroll"><div id="reveal"></div></div>';
  setActions('<button class="primary" id="show">Показать</button>');

  document.getElementById('show').onclick = () => {
    document.getElementById('reveal').innerHTML =
      '<div class="answer">' + esc(c.answer) +
      (c.extra ? '<span class="sub" lang="et">' + esc(c.extra) + '</span>' : '') + '</div>';
    showExample();
    setActions('<button class="bad" id="no">Не знал</button><button class="ok" id="yes">Знал</button>');
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
  (el.card.querySelector('.card-scroll') || el.card).appendChild(node);
}

// «Так же»: до трёх слов колоды, которые меняются по той же схеме. Номер типа
// не показываем — внутри одного номера слова меняются по-разному, а готовые
// формы соседа и есть образец. Сначала уже знакомые слова; три показанных
// по возможности кончаются по-разному, чтобы образцы не повторяли друг друга
function showKin() {
  const c = current;
  if (c.kind !== 'forms' || !c.kin || el.card.querySelector('.kin')) return;
  const isVerb = c.fields.some((f) => f.key === 'da');
  // Родство слов по написанию не угадать: общий кусок бывает корнем (lennujaam,
  // bussijaam), а бывает суффиксом (roheline, tavaline). Поэтому не ищем корни,
  // а следим, чтобы три показанных слова не кончались одинаково — иначе строка
  // «raudteejaam · lennujaam · bussijaam» даёт один образец вместо трёх.
  // Сравниваем последние 4 буквы (у глаголов — без -ma).
  const stem = (h) => (isVerb ? h.replace(/ma$/, '') : h);
  const end = (h) => stem(h).slice(-4);
  // короткое слово целиком внутри длинного — тоже одно окончание: ema и vanaema.
  // Сравниваем основы с основами: иначе у глаголов koristama не «кончается» на ista
  const sameEnd = (x, y) => stem(x).endsWith(end(y)) || stem(y).endsWith(end(x));
  // знакомое — слово, по которому есть прогресс в любой из трёх карточек
  const known = (w) => ['forms', 'prod', 'recog'].some((k) => sched(w.id + ':' + k));
  const pool = c.kin.filter((w) => w.id !== c.wid);
  const others = [];
  // сложное слово на уже показанное (vanaema при ema, ebaviisakas при viisakas)
  const compound = (x, y) => x !== y && (x.endsWith(y) || y.endsWith(x));
  // уровни: 2 — окончания разные; 1 — окончание общее, но не сложное слово
  // на показанное (kiilakas при viisakas: общий только суффикс); 0 — что осталось
  const take = (list, level) => {
    for (const w of list) {
      if (others.length >= 3 || others.includes(w)) continue;
      if (level >= 2 && others.some((o) => sameEnd(o.head, w.head))) continue;
      if (level >= 1 && others.some((o) => compound(o.head, w.head))) continue;
      others.push(w);
    }
  };
  const fam = pool.filter(known);
  const fresh = pool.filter((w) => !known(w));
  // знакомые вперёд; незнакомое слово вытесняет знакомое только ради разных окончаний
  for (const level of [2, 1, 0]) {
    take(fam, level);
    take(fresh, level);
  }
  // в строке знакомые тоже впереди, даже если добраны последними
  others.sort((x, y) => Number(known(y)) - Number(known(x)));
  if (!others.length) return;
  const node = document.createElement('div');
  node.className = 'kin';
  node.innerHTML = '<span class="kin-lbl">так же</span> <span lang="et">' +
    // пара «слово → формы» не должна рваться между строками на узком экране
    others.map((w) => '<span class="kin-w">' + esc(w.head + ' → ' + w.a + ', ' + w.b) + '</span>').join(' · ') +
    '</span>';
  (el.card.querySelector('.card-scroll') || el.card).appendChild(node);
}

function finish(ok, immediate) {
  const c = current;
  showExample();
  showKin();
  const wasNew = !sched(c.id);
  grade(c.id, ok);
  if (wasNew) { state.newCount = (state.newCount || 0) + 1; saveState(); }
  if (!ok) queue.splice(Math.min(3, queue.length), 0, c);

  const next = () => { current = null; render(); updateStats(); };

  if (immediate) return next();

  setActions('<button class="primary" id="next">' +
    (ok ? 'Дальше' : 'Понял, дальше') + '</button>');
  const btn = document.getElementById('next');
  btn.onclick = next;
  btn.focus();
  updateStats();
}

function renderDone() {
  setActions('');
  el.card.innerHTML =
    '<div class="done"><span class="big">✔</span>' +
    'На сегодня всё.<br>Возвращайся завтра — или подними лимит новых слов в настройках.</div>';
  el.pad.hidden = true;
}

function renderCheat() {
  setActions('');
  el.pad.hidden = true;
  if (!GRAMMAR) { el.card.innerHTML = '<div class="done">Загружаю…</div>'; return; }
  el.card.innerHTML = GRAMMAR.sections.map((s, i) =>
    '<section class="cheat">' +
      '<h2><span class="num">' + (i + 1) + '</span>' + esc(s.title) + '</h2>' +
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
    inp.addEventListener('focus', () => {
      lastInput = inp;
      // карточка прокручивается внутри себя: если поле осталось за её краем,
      // подтянем — но только если это правда нужно, иначе экран прыгает
      ensureVisible(inp);
    });
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
let mtNote = '';      // пометка «перевод машинный» — переживает перерисовку окна

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

// Выбор значения, примера и рекции — ТА ЖЕ логика, что meaning_keys /
// ranked_meanings / example / rection в tools/sonaveeb.py. Раньше здесь
// брался самый короткий пример из любого значения и первая рекция статьи —
// ровно тот способ, который дал «tõusma — вставать» фразу из чужого значения
// и «magama — спать» рекцию «kellega». Слово, заведённое в приложении, должно
// получать пример так же, как слова колоды.

// ключ варианта перевода — последнее слово, 4 буквы; короче трёх букв не участвует
function meaningKeys(text) {
  const keys = new Set();
  for (const part of String(text || '').split(/[,;()]/)) {
    const words = part.toLowerCase().match(/[а-яёa-zõäöüšž]+/g);
    if (words && words[words.length - 1].length >= 3) keys.add(words[words.length - 1].slice(0, 4));
  }
  return keys;
}

// значения, совпавшие с переводом, — в порядке самой статьи
function rankedMeanings(res, ru) {
  const mine = meaningKeys(ru);
  if (!mine.size) return [];
  return (res.meanings || []).filter((m) => {
    const tr = m.translations;
    if (!tr || typeof tr !== 'object' || Array.isArray(tr)) return false;
    const gl = [];
    for (const it of tr.rus || []) {
      for (const g of String((it && it.words) || '').split(',')) if (g.trim()) gl.push(g);
    }
    return gl.some((g) => [...meaningKeys(g)].some((k) => mine.has(k)));
  });
}

// рекция — строго из первого совпавшего значения, без заимствования у соседних
function pickRection(res, ru) {
  const ranked = rankedMeanings(res, ru);
  const target = ranked[0] || (res.meanings || [])[0];
  return (target && target.rection) || '';
}

// пример — из первого совпавшего значения, где есть годный: от 3 слов и до 70 знаков
function pickExample(res, ru) {
  const ranked = rankedMeanings(res, ru);
  const order = ranked.length ? ranked : (res.meanings || []).slice(0, 1);
  for (const m of order) {
    let best = '';
    for (const e of m.examples || []) {
      const t = (e || '').trim();
      if (!t || t.length > 70 || t.split(/\s+/).length < 3) continue;
      if (!best || t.length < best.length) best = t;
    }
    if (best) return best;
  }
  return '';
}

// Статья среди омонимов — как pick_best в tools/sonaveeb.py: первая, где есть
// значение с нашим переводом. У kiilakas две статьи, «лысый» и «затрещина»:
// без этого карточка «лысый» получала пример про затрещину, у hall «иней» —
// «небо серое». Перевода нет или он ни с чем не совпал — глагол, иначе первая.
function pickArticle(results, ru) {
  const mine = meaningKeys(ru);
  if (results.length > 1 && mine.size) {
    const hit = results.find((r) => [...meaningKeys(glosses(r, 'rus', Infinity))].some((k) => mine.has(k)));
    if (hit) return hit;
  }
  return results.find((r) => (r.wordClasses || []).some((c) => c && c.toLowerCase() === 'verb'))
    || results[0];
}

// Часть речи — как pos_of в tools/sonaveeb.py: решает ПЕРВАЯ пометка статьи.
// Раньше хватало пометки adj в любом значении, и существительное lörts
// «плевок» подписывалось как omadussõna
function posOf(res) {
  for (const m of res.meanings || []) {
    for (const p of m.partOfSpeech || []) {
      const code = ((p && p.code) || '').toLowerCase();
      if (code.startsWith('adj')) return 'adj';
      if (code.startsWith('num')) return 'num';
      if (code === 's' || code === 'n' || code === 'noun') return 'n';
    }
  }
  return 'n';
}

// ru — перевод, под который собираем карточку. При поиске его ещё нет: берём
// первый словарный, тот, что подставится в поле; при правке поля и при
// сохранении статья, пример и рекция пересчитываются (refreshEntry, saveWord)
function parseEntry(data, word, ru) {
  const results = (data && data.searchResult) || [];
  if (!results.length) return { error: 'absent' };

  const res = pickArticle(results, ru);
  const classes = (res.wordClasses || []).filter(Boolean).map((c) => c.toLowerCase());
  const api = formsFromApi(res);

  const pos = posOf(res);
  const hint = ru || (glosses(res, 'rus').split(',')[0] || '').trim();
  const ex = pickExample(res, hint);
  const rek = pickRection(res, hint);

  const isVerb = classes.includes('verb');
  const map = isVerb ? VERB_MAP : NOUN_MAP;
  const entry = { id: 'u_' + word.replace(/[^\wõäöüšž]/gi, ''), ru: '' };
  for (const [field, code] of map) entry[field] = api[code] || '';
  // тип словоизменения — для подсказки «так же», как eki_type в words.json
  // тип — у заглавной формы (SgN / Sup), как eki_type() в tools/sonaveeb.py
  const typedForms = (res.wordForms || []).filter((f) => f && f.inflectionType &&
    !['', '-'].includes(String(f.value || '').trim()));
  const typed = typedForms.find((f) => f.code === 'SgN' || f.code === 'Sup') || typedForms[0];
  if (typed) entry.eki_type = String(typed.inflectionType);
  if (ex) entry.ex = ex;
  if (isVerb && rek) entry.rek = rek;
  if (!isVerb && pos !== 'n') entry.pos = pos;

  const required = isVerb ? ['ma', 'da', 'b'] : ['nom', 'gen', 'part'];
  // наречия, частицы, союзы (ka, väga) в словаре есть, но форм у них нет —
  // это не «слова не существует», и советовать «проверь начальную форму» тут вредно
  if (required.some((f) => !entry[f])) return { error: 'nodecl', ru: glosses(res, 'rus'), en: glosses(res, 'eng') };

  return { entry, isVerb, data, word, ru: glosses(res, 'rus'), en: glosses(res, 'eng') };
}

// EKI держит переводы внутри значений, словарём по языкам: {"rus": [{words: "книга"}], ...}
function glosses(res, lang, limit = 5) {
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
  return out.slice(0, limit).join(', ');
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
  mtNote = '';
  save.disabled = true;
  document.getElementById('add-ru-wrap').hidden = true;
  // перевод от прошлого слова не должен уехать в карточку нового
  document.getElementById('add-ru').value = '';

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
function drawEntry(parsed, box, save) {
  const e = parsed.entry;
  const line = parsed.isVerb
    ? [e.ma, e.da, e.b, e.neg && 'ei ' + e.neg].filter(Boolean).join(' · ')
    : [e.nom, e.gen, e.part, e.plpart].filter(Boolean).join(' · ');

  box.className = 'add-result ok';
  box.innerHTML = '<div class="dir">словарь EKI</div>' +
    '<div class="found" lang="et">' + esc(line) + '</div>' +
    (parsed.ru ? '<div class="translation">' + esc(parsed.ru) + '</div>' : '') +
    (e.rek ? '<div class="sub">рекция: ' + esc(e.rek) + '</div>' : '') +
    (e.ex ? '<div class="sub" lang="et">' + esc(e.ex) + '</div>' : '') +
    (mtNote ? '<div class="sub mt">' + esc(mtNote) + '</div>' : '');

  parsed.dup = alreadyHave(e, parsed.isVerb);
  if (parsed.dup) box.innerHTML += '<div class="sub">Это слово уже в колоде.</div>';
  save.disabled = parsed.dup;
}

function showEntry(parsed, box, save) {
  pending = parsed;
  const e = parsed.entry;
  const wrap = document.getElementById('add-ru-wrap');
  const ruInput = document.getElementById('add-ru');
  // подставленный перевод сам по себе выбирает статью, поэтому окно сразу
  // пересобираем под него: иначе показан один омоним, а сохранится другой
  if (parsed.ru) ruInput.value = parsed.ru.split(',')[0].trim();
  refreshEntry();
  if (!pending || pending.dup) {
    pending = null;
    return;
  }
  wrap.hidden = false;
  if (parsed.ru) return;

  // русского в словаре нет — подставим машинный и честно это пометим
  translate(parsed.isVerb ? e.ma : e.nom, 'est', 'rus').then((ru) => {
    if (!ru || !pending || pending.data !== parsed.data) return;
    mtNote = 'машинный перевод: ' + ru + ' — проверь его';
    if (!ruInput.value) ruInput.value = ru;
    refreshEntry();
  });
}

// перевод в поле поменялся — пересобираем карточку под него, чтобы в окне было
// видно ровно то, что сохранится: статью-омоним, пример, рекцию
function refreshEntry() {
  if (!pending) return;
  const ru = document.getElementById('add-ru').value.trim();
  const box = document.getElementById('add-result');
  const save = document.getElementById('btn-add-save');
  const next = parseEntry(pending.data, pending.word, ru);
  if (next.error) {
    // перевод указал на омоним без форм (у minema «уехать» — это наречие):
    // собрать под него нечего, а молча сохранить карточку прошлого перевода нельзя
    pending = { data: pending.data, word: pending.word, error: next.error };
    box.className = 'add-result bad';
    box.textContent = 'С переводом «' + ru + '» это слово не склоняется и не спрягается ' +
      '(наречие, частица) — карточку на формы не собрать. Поправь перевод.';
    save.disabled = true;
    return;
  }
  pending = next;
  drawEntry(next, box, save);
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
  // статью, пример и рекцию — по окончательному переводу: от него зависит,
  // какой омоним и какое значение имелись в виду
  refreshEntry();
  if (!pending || pending.error || pending.dup) return;
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
  mtNote = '';
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
{
  const ruField = document.getElementById('add-ru');
  if (ruField) ruField.addEventListener('input', refreshEntry);
}
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
  // слово-синоним не должно попасть в неверные варианты: с переводом «магазин»
  // и pood, и kauplus верны, а помечен верным был бы только один. Хватает
  // одного общего варианта перевода: pilt «картина, фото» и foto «фото, …»
  const otherNoms = (w) => {
    const mine = new Set(ruParts(w));
    return DATA.nouns.filter((x) => !ruParts(x).some((v) => mine.has(v))).map((x) => x.nom);
  };

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
      const wrong = distractors(w.nom, otherNoms(w), 3);
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
    lastRuns();
  setActions('<button id="exam-back">Назад</button>' +
             '<button class="primary" id="exam-start">Начать</button>');
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

  setActions('');
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
      : '<div class="exam-note">Без ошибок.</div>');
  setActions('<button id="exam-again">Ещё раз</button>' +
             '<button class="primary" id="exam-exit">К карточкам</button>');

  document.getElementById('exam-again').onclick = () => { clearExamTimer(); exam = null; renderExamIntro(); };
  document.getElementById('exam-exit').onclick = stopExam;
}

on('btn-exam', () => { clearExamTimer(); exam = null; renderExamIntro(); });

/* ---------- высота под экранную клавиатуру ---------- */

// Android сжимает разметку сам (interactive-widget=resizes-content в мета-теге),
// а iOS клавиатурой только накрывает страницу: layout-вьюпорт остаётся прежним.
// Реальную видимую высоту там знает только visualViewport — отдаём её в CSS.
let lastHeight = 0;
// обычная высота без клавиатуры — СВОЯ для каждой ориентации. Один общий baseline
// портился при повороте с уже открытой клавиатурой: в него попадала высота с ней
// храним и ширину: поворот меняет их местами, поэтому обычную высоту в новой
// ориентации можно оценить как ширину в старой — это надёжнее, чем screen.*
const baselines = { portrait: null, landscape: null };

function orientationKey() {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

// Прятать шапку и вкладки можно ТОЛЬКО когда открыта клавиатура. Ни высота сама
// по себе, ни фокус в поле признаком не годятся: айфон в альбоме — это 844x390,
// и по одной высоте навигация исчезала просто от поворота телефона; а фокус
// приложение ставит само при показе карточки, и клавиатуру это не открывает.
// Настоящий признак — просадка высоты относительно обычной для этой ориентации.
function expectedHeight() {
  const key = orientationKey();
  const own = baselines[key];
  if (own) return own.h;

  // Эту ориентацию без клавиатуры ещё не видели — например, повернули телефон,
  // не закрыв её. Тогда высоту можно взять из ширины другой ориентации: при
  // повороте они меняются местами. Но это верно ТОЛЬКО если окно занимает весь
  // экран. В окне браузера на компьютере ширина и высота не связаны поворотом,
  // и такая оценка однажды спрятала навигацию вообще без клавиатуры.
  // Признак настоящего поворота: нынешняя ширина совпадает с прежней высотой.
  const other = baselines[key === 'landscape' ? 'portrait' : 'landscape'];
  if (other && Math.abs(window.innerWidth - other.h) < 50) return other.w;
  return 0;
}

function keyboardOpen(h) {
  if (window.innerHeight - h > 100) return true;    // iOS: клавиатура накрывает layout
  const expected = expectedHeight();                // Android: сжимается сам layout
  // Не знаем нормы — считаем, что клавиатуры нет. Ошибиться в эту сторону
  // безобидно (тесновато), в обратную — значит спрятать навигацию на ровном месте
  return expected > 0 && h < expected - 100;
}

function updateChrome() {
  const h = lastHeight || window.innerHeight;
  const kb = keyboardOpen(h);
  const key = orientationKey();
  if (!kb && (!baselines[key] || h >= baselines[key].h)) {
    baselines[key] = { w: window.innerWidth, h };          // «спокойные» размеры
  }
  const root = document.documentElement;
  // если клавиатура открыта — обвязка не нужна в любом случае: человек печатает.
  // Порог по высоте оставлял полосу 460-560 (портрет iPhone с клавиатурой) без сжатия
  root.classList.toggle('short', kb);
  root.classList.toggle('tiny', kb && h < 300);
}

// Подтягиваем поле, ТОЛЬКО если оно действительно вышло за края своей области.
// Безусловный scrollIntoView на каждое событие заставлял экран прыгать
function ensureVisible(node) {
  const box = node.closest('.card-scroll') || node.closest('dialog');
  if (!box) return;
  const b = node.getBoundingClientRect();
  const c = box.getBoundingClientRect();
  if (b.top < c.top + 2 || b.bottom > c.bottom - 2) node.scrollIntoView({ block: 'nearest' });
}

function focusIntoView() {
  const node = document.activeElement;
  if (node && node.matches && node.matches('input, textarea')) ensureVisible(node);
}

// поворот меняет «обычную» высоту — старую забываем, иначе она соврёт
window.addEventListener('orientationchange', () => setTimeout(updateChrome, 300));
document.addEventListener('focusin', () => { updateChrome(); focusIntoView(); });

// Нашей разметке прокрутка документа не нужна: высота задана, содержимое
// скроллится внутри своих областей. Но iOS при фокусе уводит страницу вверх
// сам — и экран «запрыгивает» выше, чем нужно. Возвращаем на место.
window.addEventListener('scroll', () => {
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}, { passive: true });
document.addEventListener('focusout', () => setTimeout(updateChrome, 0));

(function trackViewportHeight() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const h = Math.round(vv.height);
    // в момент запуска скрипта высота бывает нулевой — записав её,
    // мы схлопнули бы разметку в ноль
    if (h <= 0) return;
    const changed = h !== lastHeight;
    document.documentElement.style.setProperty('--app-vh', h + 'px');
    lastHeight = h;
    updateChrome();
    // только когда высота реально изменилась: на прокрутку самой видимой области
    // подтягивать поле нельзя, иначе спорим с пальцем пользователя
    if (changed) focusIntoView();
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);   // не во всех движках приходит событие vv
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  window.addEventListener('load', apply);
  apply();
})();
