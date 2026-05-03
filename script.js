let CONFIG = null;
let CATS = [];
let VALUES = {};
let LEVELS = {};
let LEVEL_LABEL = {};
let LEVEL_COLOR = {};
let RULES = [];
let POSES_INFO = { poses: {} };

// Кэшированные индексы правил по типам — для скорости
let RULES_BLOCK = [];
let RULES_REQUIRE = [];
let RULES_WARN = [];

let state = null;

const STORAGE_KEY = 'ns_state_basic_v3';
const OLD_STORAGE_KEY = 'ns_state_basic';

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { }
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || JSON.parse(localStorage.getItem(OLD_STORAGE_KEY));
  } catch {
    return null;
  }
}

async function loadConfig() {
  const [configRes, posesRes] = await Promise.all([
    fetch('config.json', { cache: 'no-store' }),
    fetch('poses-info.json', { cache: 'no-store' }).catch(() => null)
  ]);
  if (!configRes.ok) throw new Error(`Не удалось загрузить config.json: ${configRes.status}`);
  if (posesRes && posesRes.ok) {
    POSES_INFO = await posesRes.json();
  } else {
    console.warn('poses-info.json не найден, описания поз недоступны');
  }
  return configRes.json();
}

function normalizeConfig(config) {
  LEVELS = config.levels || {
    easy: { label: 'Лёгкий', short: 'e', color: 'var(--green)' },
    medium: { label: 'Средний', short: 'm', color: 'var(--yellow)' },
  };

  LEVEL_LABEL = Object.fromEntries(Object.entries(LEVELS).map(([key, val]) => [key, val.label || key]));
  LEVEL_COLOR = Object.fromEntries(Object.entries(LEVELS).map(([key, val]) => [key, val.color || 'var(--accent)']));

  CATS = (config.categories || [])
    .filter(c => c.enabled !== false)
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));

  VALUES = config.values || {};
  RULES = (config.rules || []).filter(r => r.enabled !== false);

  // Индексируем правила по типу
  RULES_BLOCK = RULES.filter(r => (r.type || '').toUpperCase() === 'BLOCK');
  RULES_REQUIRE = RULES.filter(r => (r.type || '').toUpperCase() === 'REQUIRE');
  RULES_WARN = RULES.filter(r => (r.type || '').toUpperCase() === 'WARN');
}

function createDefaultState() {
  return {
    enabled: {}, values: {}, ranges: {}, current: {}, locked: {},
    levels: {}, safeWord: '', history: [], detailLevel: 'extended'
  };
}

function initState() {
  state = loadState() || createDefaultState();

  state.enabled ||= {};
  state.values ||= {};
  state.ranges ||= {};
  state.current ||= {};
  state.locked ||= {};
  state.levels ||= {};
  state.history ||= [];
  state.detailLevel ||= 'extended';

  Object.keys(LEVELS).forEach(level => {
    if (state.levels[level] === undefined) state.levels[level] = level !== 'extra';
  });

  CATS.forEach(c => {
    if (state.enabled[c.id] === undefined) state.enabled[c.id] = c.enabled !== false;

    if (c.type === 'chips' && !state.values[c.id]) state.values[c.id] = {};
    if (c.type === 'chips') {
      (VALUES[c.id] || []).forEach(v => {
        if (state.values[c.id][v.id] === undefined) state.values[c.id][v.id] = v.enabled !== false;
      });
    }

    if (c.type === 'range' && !state.ranges[c.id]) {
      state.ranges[c.id] = { min: c.defMin, max: c.defMax };
    }
  });

  saveState();
}

/* ============================================================
   ПАРСИНГ ССЫЛОК В ПРАВИЛАХ
   Формат: "категория:значение1,значение2"
   Спецзначения для range: "duration:45+", "duration:long", "duration:short"
============================================================ */
function parseRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const [cat, rawValue] = ref.split(':');
  if (!cat || !rawValue) return null;
  return { cat: cat.trim(), values: rawValue.split(',').map(v => v.trim()).filter(Boolean) };
}

// Проверяет — попадает ли число под спецификацию вроде "45+", "long", "short"
function rangeMatchesSpec(catId, numericValue, spec) {
  // "45+" — больше или равно 45
  const plusMatch = spec.match(/^(\d+)\+$/);
  if (plusMatch) return numericValue >= parseInt(plusMatch[1]);

  // "30+" с плюсом
  const exactMatch = spec.match(/^(\d+)$/);
  if (exactMatch) return numericValue === parseInt(exactMatch[1]);

  // "long" / "short" — относительные категории
  const cat = CATS.find(c => c.id === catId);
  if (!cat || cat.type !== 'range') return false;

  const range = cat.max - cat.min;
  const lowThreshold = cat.min + range * 0.4;   // нижняя треть
  const highThreshold = cat.min + range * 0.6;  // верхняя треть

  if (spec === 'short') return numericValue <= lowThreshold;
  if (spec === 'long') return numericValue >= highThreshold;

  return false;
}

// Извлекает числовое значение из текущего пика категории-range
function getRangeNumeric(item) {
  if (!item || !item.text) return null;
  const m = String(item.text).match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function pickedHasRef(picked, ref) {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  const item = picked[parsed.cat];
  if (!item) return false;

  // Для range — проверяем числовую спецификацию
  const cat = CATS.find(c => c.id === parsed.cat);
  if (cat && cat.type === 'range') {
    const num = getRangeNumeric(item);
    if (num === null) return false;
    return parsed.values.some(v => rangeMatchesSpec(parsed.cat, num, v));
  }

  // Обычная проверка по id
  const ids = item.ids || (item.id ? [item.id] : []);
  return parsed.values.some(v => ids.includes(v));
}

function candidateMatchesRef(catId, candidateIds, ref) {
  const parsed = parseRef(ref);
  if (!parsed || parsed.cat !== catId) return false;
  return parsed.values.some(v => candidateIds.includes(v));
}

/* ============================================================
   BLOCK — кандидат не должен конфликтовать с уже выбранным
============================================================ */
function violatesBlockRules(catId, candidateIds, picked) {
  return RULES_BLOCK.some(rule => {
    const a = rule.if;
    const b = rule.then;

    const candidateIsA = candidateMatchesRef(catId, candidateIds, a);
    const candidateIsB = candidateMatchesRef(catId, candidateIds, b);

    return (candidateIsA && pickedHasRef(picked, b)) || (candidateIsB && pickedHasRef(picked, a));
  });
}

/* ============================================================
   REQUIRE — собирает ограничения для кандидата
   Если выпало X (есть в picked), и есть правило "X → Y:список",
   то категория Y может выбирать ТОЛЬКО из этого списка.
   
   Возвращает { catId: Set(допустимые id) } — пересечение всех ограничений.
   Если для категории нет ограничений — её нет в результате.
============================================================ */
function collectRequireConstraints(picked) {
  const constraints = {}; // catId -> Set ids

  RULES_REQUIRE.forEach(rule => {
    const ifRef = parseRef(rule.if);
    const thenRef = parseRef(rule.then);
    if (!ifRef || !thenRef) return;

    // Сработало ли условие "if"?
    if (!pickedHasRef(picked, rule.if)) return;

    // Накладываем ограничение на категорию из "then"
    const allowedSet = new Set(thenRef.values);
    if (!constraints[thenRef.cat]) {
      constraints[thenRef.cat] = allowedSet;
    } else {
      // Пересечение — если несколько правил требуют разное, остаётся общее
      const intersection = new Set();
      constraints[thenRef.cat].forEach(v => {
        if (allowedSet.has(v)) intersection.add(v);
      });
      constraints[thenRef.cat] = intersection;
    }
  });

  return constraints;
}

// Фильтрует пул категории по REQUIRE-ограничениям
function applyRequireConstraints(catId, pool, constraints) {
  const allowed = constraints[catId];
  if (!allowed || allowed.size === 0) return pool;

  // Для range категорий — фильтруем по спецификациям
  const cat = CATS.find(c => c.id === catId);
  if (cat && cat.type === 'range') {
    // Range нельзя так просто отфильтровать — это будет учтено в rollOne для range
    return pool;
  }

  // Спец-значения вроде "long", "short", "45+" — пропускаем для chips
  // (они работают только с range)
  const validIds = new Set();
  allowed.forEach(v => {
    if (!v.match(/^\d+\+?$/) && v !== 'long' && v !== 'short') {
      validIds.add(v);
    }
  });

  if (validIds.size === 0) return pool;

  return pool.filter(v => validIds.has(v.id));
}

/* ============================================================
   ВЗВЕШЕННЫЙ ВЫБОР
============================================================ */
function weightedPick(pool) {
  const total = pool.reduce((sum, v) => sum + Math.max(0, Number(v.weight || 1)), 0);
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];

  let r = Math.random() * total;
  for (const item of pool) {
    r -= Math.max(0, Number(item.weight || 1));
    if (r <= 0) return item;
  }
  return pool[pool.length - 1];
}

function getActiveLevels() {
  return Object.keys(LEVELS).filter(level => state.levels[level]);
}

function normalizeCurrentItem(v) {
  if (!v) return null;
  if (v.ids) return v;
  return { ...v, ids: v.id ? [v.id] : [] };
}

function getVisibleCats() {
  const level = state.detailLevel || 'extended';
  return CATS.filter(c => {
    const d = c.detail || 'full';
    if (level === 'base') return d === 'base';
    if (level === 'extended') return d === 'base' || d === 'extended';
    return true;
  });
}

const list = document.getElementById('criteriaList');
const resultBox = document.getElementById('result');
const sw = document.getElementById('safeWord');
const modal = document.getElementById('adminModal');
const adminContent = document.getElementById('adminContent');
const titleEl = document.getElementById('title');

function renderCriteria() {
  let html = '';
  getVisibleCats().forEach((c, i) => {
    const delay = (i * 0.02) + 's';
    if (c.type === 'chips') {
      html += `
        <div class="crit animate-once${state.enabled[c.id] ? '' : ' disabled'}" style="animation-delay:${delay}" data-cat="${c.id}">
          <div class="crit-text">
            <div class="crit-name">${c.name}</div>
            <div class="crit-sub">${c.sub || ''}</div>
          </div>
          <div class="toggle ${state.enabled[c.id] ? 'on' : ''}" data-toggle="${c.id}"></div>
        </div>`;
    } else {
      const r = state.ranges[c.id];
      const unit = c.unit || 'мин';
      html += `
        <div class="crit-range animate-once${state.enabled[c.id] ? '' : ' disabled'}" style="animation-delay:${delay}" data-cat="${c.id}">
          <div class="range-head">
            <div class="crit-text">
              <div class="crit-name">${c.name}</div>
              <div class="crit-sub">${c.sub || ''}</div>
            </div>
            <div class="toggle ${state.enabled[c.id] ? 'on' : ''}" data-toggle="${c.id}"></div>
          </div>
          <div class="range-vals">
            <span>от <strong data-vmin>${r.min}</strong> ${unit}</span>
            <span>до <strong data-vmax>${r.max}</strong> ${unit}</span>
          </div>
          <div class="range-row">
            <input type="range" data-rmin="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${r.min}">
            <input type="range" data-rmax="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${r.max}">
          </div>
        </div>`;
    }
  });
  list.innerHTML = html;
}

function renderLevels() {
  const grid = document.querySelector('.intensity-grid');
  if (!grid) return;

  grid.innerHTML = Object.entries(LEVELS).map(([level, meta]) => `
    <button class="level-btn ${state.levels[level] ? 'active' : ''}" data-level="${level}">
      <span class="dot" style="background:${meta.color || 'var(--accent)'}"></span>${meta.label || level}
    </button>
  `).join('');

  grid.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = btn.dataset.level;
      state.levels[lvl] = !state.levels[lvl];
      if (getActiveLevels().length === 0) state.levels[lvl] = true;
      btn.classList.toggle('active', state.levels[lvl]);
      saveState();
    });
  });
}

function renderDetailLevels() {
  const grid = document.querySelector('.detail-grid');
  if (!grid) return;

  const levels = [
    { id: 'base', label: 'База' },
    { id: 'extended', label: 'Расширенно' },
    { id: 'full', label: 'Полно' },
  ];

  grid.innerHTML = levels.map(l => `
    <button class="level-btn ${state.detailLevel === l.id ? 'active' : ''}" data-detail="${l.id}">${l.label}</button>
  `).join('');

  grid.querySelectorAll('[data-detail]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.detailLevel = btn.dataset.detail;
      const visibleIds = new Set(getVisibleCats().map(c => c.id));
      Object.keys(state.current).forEach(k => {
        if (!visibleIds.has(k)) delete state.current[k];
      });
      saveState();
      renderDetailLevels();
      renderCriteria();
      renderResult();
    });
  });
}

/* ============================================================
   ROLL ONE — генерация одной категории с учётом BLOCK + REQUIRE
============================================================ */
function rollOne(c, picked = {}, constraints = {}) {
  if (!state.enabled[c.id]) return null;

  // === RANGE ===
  if (c.type === 'range') {
    const r = state.ranges[c.id];
    let validValues = [];
    for (let v = r.min; v <= r.max; v += c.step) validValues.push(v);

    // Применяем REQUIRE для range — фильтруем числовые значения по специф.
    if (constraints[c.id] && constraints[c.id].size > 0) {
      const filtered = validValues.filter(num =>
        [...constraints[c.id]].some(spec => rangeMatchesSpec(c.id, num, spec))
      );
      if (filtered.length > 0) validValues = filtered;
    }

    if (validValues.length === 0) {
      // fallback — если REQUIRE не пересекся с диапазоном, всё равно генерим
      for (let v = r.min; v <= r.max; v += c.step) validValues.push(v);
    }

    const v = validValues[Math.floor(Math.random() * validValues.length)];
    return { text: v + ' ' + (c.unit || 'мин'), level: null, ids: [], numeric: v };
  }

  // === CHIPS ===
  const activeLevels = getActiveLevels();
  const ev = state.values[c.id] || {};
  let pool = (VALUES[c.id] || []).filter(v => ev[v.id] && activeLevels.includes(v.level));

  if (pool.length === 0) {
    pool = (VALUES[c.id] || []).filter(v => ev[v.id]);
    if (pool.length === 0) return null;
  }

  // BLOCK
  pool = pool.filter(v => !violatesBlockRules(c.id, [v.id], picked));
  if (pool.length === 0) return null;

  // REQUIRE — сужаем до разрешённых, если есть ограничения
  const constrainedPool = applyRequireConstraints(c.id, pool, constraints);
  // Если после REQUIRE пусто — берём исходный пул (REQUIRE мягко игнорируется,
  // лучше показать что-то, чем сломать генерацию)
  if (constrainedPool.length > 0) pool = constrainedPool;

  // Множественный выбор (позы, прелюдия)
  if (c.multi && c.multi > 1) {
    const selected = [];
    const localPicked = { ...picked };
    const n = Math.min(c.multi, pool.length);

    for (let i = 0; i < n; i++) {
      const selectedIds = selected.map(v => v.id);
      const available = pool.filter(v =>
        !selectedIds.includes(v.id) &&
        !violatesBlockRules(c.id, [...selectedIds, v.id], localPicked)
      );
      if (!available.length) break;
      selected.push(weightedPick(available));
    }

    if (!selected.length) return null;

    const levels = selected.map(v => v.level);
    const top = Object.keys(LEVELS).slice().reverse().find(level => levels.includes(level)) || levels[0];
    return {
      text: selected.map(v => v.text).join(' → '),
      level: top,
      ids: selected.map(v => v.id)
    };
  }

  const pick = weightedPick(pool);
  return { text: pick.text, level: pick.level, ids: [pick.id] };
}

/* ============================================================
   СОРТИРОВКА КАТЕГОРИЙ ДЛЯ ГЕНЕРАЦИИ
   Категории, которые в REQUIRE-правилах являются "источником"
   (стороной "if"), генерим первыми. Чтобы их зависимости знали
   ограничения сразу.
============================================================ */
function buildGenerationOrder(activeCats) {
  // Считаем для каждой категории — сколько раз она выступает источником в REQUIRE
  const sourceWeight = {};
  const targetWeight = {};

  RULES_REQUIRE.forEach(rule => {
    const ifRef = parseRef(rule.if);
    const thenRef = parseRef(rule.then);
    if (ifRef) sourceWeight[ifRef.cat] = (sourceWeight[ifRef.cat] || 0) + 1;
    if (thenRef) targetWeight[thenRef.cat] = (targetWeight[thenRef.cat] || 0) + 1;
  });

  // Источники идут первыми, цели — после
  return [...activeCats].sort((a, b) => {
    const aScore = (sourceWeight[a.id] || 0) - (targetWeight[a.id] || 0);
    const bScore = (sourceWeight[b.id] || 0) - (targetWeight[b.id] || 0);
    if (aScore !== bScore) return bScore - aScore; // больший score первым
    return (a.order ?? 9999) - (b.order ?? 9999);
  });
}

/* ============================================================
   ROLL ALL — полный расклад с учётом всех правил
   + сбор WARN-предупреждений в state.currentWarnings
============================================================ */
function rollAll(onlyUnlocked = false) {
  const visibleCats = getVisibleCats();

  // draft = текущее состояние (включая залоченные)
  const draft = { ...Object.fromEntries(Object.entries(state.current).map(([k, v]) => [k, normalizeCurrentItem(v)])) };

  // Замки всегда уважаются — не перебрасываем залоченные категории
  const toRoll = visibleCats.filter(c => !state.locked[c.id]);

  // Вычищаем из draft только те, что будем перебрасывать
  toRoll.forEach(c => { delete draft[c.id]; });

  // Генерим в правильном порядке (источники REQUIRE первыми)
  const orderedCats = buildGenerationOrder(toRoll);

  // Делаем 2 прохода: первый — пытаемся учесть REQUIRE сразу,
  // второй — если кто-то промахнулся, может добиться корректности
  const MAX_PASSES = 2;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const constraints = collectRequireConstraints(draft);

    let anyChange = false;
    orderedCats.forEach(c => {
      // На втором проходе — пересоздаём только если текущий пик нарушает REQUIRE
      if (pass > 0 && draft[c.id]) {
        const allowed = constraints[c.id];
        if (!allowed || allowed.size === 0) return; // нет ограничений — оставляем

        // Проверим, удовлетворяет ли текущий пик ограничению
        const currentIds = draft[c.id].ids || [];
        const currentNumeric = draft[c.id].numeric;

        let ok = false;
        if (c.type === 'range' && currentNumeric != null) {
          ok = [...allowed].some(spec => rangeMatchesSpec(c.id, currentNumeric, spec));
        } else {
          ok = currentIds.some(id => allowed.has(id));
        }

        if (ok) return; // пик ок — оставляем
        // Иначе перегенерим
      }

      const v = rollOne(c, draft, constraints);
      if (v) {
        if (!draft[c.id] || JSON.stringify(draft[c.id].ids) !== JSON.stringify(v.ids) || draft[c.id].numeric !== v.numeric) {
          anyChange = true;
        }
        draft[c.id] = v;
      } else {
        if (draft[c.id]) anyChange = true;
        delete draft[c.id];
      }
    });

    if (pass > 0 && !anyChange) break;
  }

  // Записываем результат (только видимые категории)
  state.current = {};
  visibleCats.forEach(c => {
    if (draft[c.id]) state.current[c.id] = draft[c.id];
  });

  // Собираем WARN-предупреждения
  state.currentWarnings = collectWarnings(state.current);

  pushHistory();
  saveState();
  renderResult();
  document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============================================================
   WARN — собираем предупреждения о мягких конфликтах
============================================================ */
function collectWarnings(picked) {
  const warnings = [];
  const seen = new Set();

  RULES_WARN.forEach(rule => {
    const ifRef = parseRef(rule.if);
    const thenRef = parseRef(rule.then);
    if (!ifRef || !thenRef) return;

    if (pickedHasRef(picked, rule.if) && pickedHasRef(picked, rule.then)) {
      const key = `${rule.if}|${rule.then}`;
      if (seen.has(key)) return;
      seen.add(key);

      warnings.push({
        cats: [ifRef.cat, thenRef.cat],
        description: rule.description || `${ifRef.cat} ↔ ${thenRef.cat}`
      });
    }
  });

  return warnings;
}

/* ============================================================
   РЕНДЕР РЕЗУЛЬТАТА
============================================================ */
function renderResult() {
  const has = Object.keys(state.current).length > 0;
  if (!has) {
    resultBox.className = 'result empty';
    resultBox.innerHTML = 'Нажмите «Бросить» — и узнаете, какой будет эта ночь';
    return;
  }

  resultBox.className = 'result';
  let html = '<div class="result-title">Сценарий на сегодня</div><div class="result-list">';
  CATS.forEach(c => {
    const v = state.current[c.id];
    if (!v) return;
    const locked = !!state.locked[c.id];

    let valHtml;
    if (c.id === 'poses') {
      const texts = v.text.split(' → ');
      const ids = v.ids || [];
      valHtml = texts.map((text, i) => {
        const id = ids[i] || '';
        return `<span class="pose-row">${text}<button class="pose-info" data-pose-id="${id}" aria-label="Описание позы">ⓘ</button></span>`;
      }).join('');
    } else {
      const tag = v.level ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle;background:${LEVEL_COLOR[v.level] || 'var(--accent)'}"></span>` : '';
      valHtml = `${tag}${v.text}`;
    }

    html += `
      <div class="result-item ${locked ? 'locked' : ''}">
        <div class="body">
          <div class="key">${c.name}</div>
          <div class="val">${valHtml}</div>
        </div>
        <button class="lock" data-lock="${c.id}">${locked ? '◆' : '○'}</button>
      </div>`;
  });
  html += '</div>';

  // Блок предупреждений
  const warnings = state.currentWarnings || [];
  if (warnings.length > 0) {
    html += `
      <div class="result-warnings">
        <div class="warn-title">Обратите внимание</div>
        <ul>
          ${warnings.map(w => `<li>${w.description}</li>`).join('')}
        </ul>
      </div>`;
  }

  resultBox.innerHTML = html;

  resultBox.querySelectorAll('[data-lock]').forEach(b => {
    b.onclick = () => {
      const id = b.getAttribute('data-lock');
      state.locked[id] = !state.locked[id];
      saveState();
      const item = b.closest('.result-item');
      item.classList.toggle('locked', state.locked[id]);
      b.textContent = state.locked[id] ? '◆' : '○';
    };
  });
}

function openPoseModal(poseId) {
  const info = (POSES_INFO.poses || {})[poseId];
  document.getElementById('poseModalTitle').textContent = info ? info.name : poseId;
  document.getElementById('poseModalDescription').textContent = info ? (info.description || '') : 'Описание не добавлено';
  const tipBlock = document.getElementById('poseModalTip');
  if (info && info.tip) {
    document.getElementById('poseModalTipText').textContent = info.tip;
    tipBlock.style.display = 'block';
  } else {
    tipBlock.style.display = 'none';
  }
  document.getElementById('poseModal').classList.add('open');
}

function closePoseModal() {
  document.getElementById('poseModal').classList.remove('open');
}

function pushHistory() {
  if (Object.keys(state.current).length === 0) return;
  const summaryCats = ['mood', 'tempo', 'place', 'poses'];
  const summary = summaryCats.map(k => state.current[k]?.text).filter(Boolean).join(' · ');

  state.history.unshift({
    summary,
    snap: JSON.parse(JSON.stringify(state.current)),
    warnings: JSON.parse(JSON.stringify(state.currentWarnings || [])),
    date: new Date().toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  });

  if (state.history.length > 10) state.history.length = 10;
  renderHistory();
}

function renderHistory() {
  const lst = document.getElementById('histList');
  const lbl = document.getElementById('histLabel');
  if (!state.history || !state.history.length) {
    lst.innerHTML = '';
    lbl.style.display = 'none';
    return;
  }

  lbl.style.display = 'flex';
  lst.innerHTML = state.history.map((h, i) => `
    <div class="saved-item">
      <div class="info">${h.summary || 'Сценарий'}</div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="date">${h.date}</div>
        <button class="icon-btn" data-loadh="${i}">↺</button>
      </div>
    </div>`).join('');

  lst.querySelectorAll('[data-loadh]').forEach(b => {
    b.onclick = () => {
      const h = state.history[+b.getAttribute('data-loadh')];
      state.current = JSON.parse(JSON.stringify(h.snap));
      state.currentWarnings = JSON.parse(JSON.stringify(h.warnings || []));
      state.locked = {};
      saveState();
      renderResult();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  });
}

function openAdmin() {
  renderAdmin();
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeAdmin() {
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

function renderAdmin() {
  let html = '';
  CATS.forEach(c => {
    if (c.type === 'range') {
      const r = state.ranges[c.id];
      html += `
        <div class="admin-cat">
          <div class="admin-cat-head" data-toggle-cat="${c.id}">
            <div class="name">${c.name}</div>
            <div class="count">${r.min}–${r.max} ${c.unit || 'мин'}</div>
          </div>
        </div>`;
      return;
    }

    const all = VALUES[c.id] || [];
    const ev = state.values[c.id] || {};
    const onCount = all.filter(v => ev[v.id]).length;
    html += `
      <div class="admin-cat">
        <div class="admin-cat-head" data-toggle-cat="${c.id}">
          <div class="name">${c.name}</div>
          <div class="count">${onCount}/${all.length}</div>
          <div class="chev">›</div>
        </div>
        <div class="admin-cat-body">
          ${all.map(v => `
            <div class="admin-val ${ev[v.id] ? 'active' : ''}" data-cat="${c.id}" data-val="${v.id}">
              <span class="level-pill" data-level="${v.level}">${LEVEL_LABEL[v.level] || v.level}</span>
              <div class="val-name">${v.text}</div>
              <div class="toggle ${ev[v.id] ? 'on' : ''}"></div>
            </div>`).join('')}
        </div>
      </div>`;
  });
  adminContent.innerHTML = html;
}

function bindEvents() {
  list.addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    const id = t.getAttribute('data-toggle');
    state.enabled[id] = !state.enabled[id];
    t.classList.toggle('on', state.enabled[id]);
    const card = t.closest('.crit, .crit-range');
    if (card) card.classList.toggle('disabled', !state.enabled[id]);
    saveState();
  });

  list.addEventListener('input', e => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    const minId = target.getAttribute('data-rmin');
    const maxId = target.getAttribute('data-rmax');
    if (!minId && !maxId) return;

    const id = minId || maxId;
    const r = state.ranges[id];
    const card = target.closest('.crit-range');
    let v = +target.value;

    if (minId) {
      if (v > r.max) { v = r.max; target.value = v; }
      r.min = v;
      card.querySelector('[data-vmin]').textContent = v;
    } else {
      if (v < r.min) { v = r.min; target.value = v; }
      r.max = v;
      card.querySelector('[data-vmax]').textContent = v;
    }

    clearTimeout(window.__rangeSave);
    window.__rangeSave = setTimeout(saveState, 200);
  });

  document.getElementById('rollAll').onclick = () => rollAll(false);
  document.getElementById('rollUnlocked').onclick = () => rollAll(true);

  sw.value = state.safeWord || '';
  sw.addEventListener('input', () => {
    state.safeWord = sw.value;
    clearTimeout(window.__swSave);
    window.__swSave = setTimeout(saveState, 300);
  });

  document.getElementById('adminBtn').onclick = openAdmin;
  document.getElementById('closeAdmin').onclick = closeAdmin;
  modal.addEventListener('click', e => { if (e.target === modal) closeAdmin(); });

  let pressTimer = null;
  titleEl.addEventListener('pointerdown', () => { pressTimer = setTimeout(openAdmin, 700); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
    titleEl.addEventListener(ev, () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    })
  );

  adminContent.addEventListener('click', e => {
    const head = e.target.closest('[data-toggle-cat]');
    if (head) {
      const cat = head.parentElement;
      if (cat.querySelector('.admin-cat-body')) cat.classList.toggle('open');
      return;
    }

    const val = e.target.closest('.admin-val');
    if (val) {
      const catId = val.getAttribute('data-cat');
      const valId = val.getAttribute('data-val');
      state.values[catId][valId] = !state.values[catId][valId];
      val.classList.toggle('active', state.values[catId][valId]);
      val.querySelector('.toggle').classList.toggle('on', state.values[catId][valId]);
      const all = VALUES[catId] || [];
      const onCount = all.filter(v => state.values[catId][v.id]).length;
      val.closest('.admin-cat').querySelector('.count').textContent = `${onCount}/${all.length}`;
      saveState();
    }
  });

  document.getElementById('enableAll').onclick = () => {
    CATS.forEach(c => {
      if (c.type !== 'chips') return;
      (VALUES[c.id] || []).forEach(v => state.values[c.id][v.id] = true);
    });
    saveState();
    renderAdmin();
  };

  document.getElementById('onlyEasy').onclick = () => {
    CATS.forEach(c => {
      if (c.type !== 'chips') return;
      (VALUES[c.id] || []).forEach(v => state.values[c.id][v.id] = v.level === 'easy');
    });
    Object.keys(state.levels).forEach(level => state.levels[level] = level === 'easy');
    saveState();
    renderLevels();
    renderAdmin();
  };

  document.getElementById('resetSettings').onclick = () => {
    if (!confirm('Сбросить настройки и историю?')) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(OLD_STORAGE_KEY);
    location.reload();
  };

  resultBox.addEventListener('click', e => {
    const btn = e.target.closest('.pose-info');
    if (btn) openPoseModal(btn.dataset.poseId);
  });

  document.getElementById('closePoseModal').onclick = closePoseModal;
  document.getElementById('poseModal').addEventListener('click', e => {
    if (e.target === document.getElementById('poseModal')) closePoseModal();
  });
}

async function initApp() {
  try {
    CONFIG = await loadConfig();
    normalizeConfig(CONFIG);
    initState();
    bindEvents();
    renderLevels();
    renderDetailLevels();
    renderCriteria();
    renderResult();
    renderHistory();
  } catch (error) {
    console.error(error);
    resultBox.className = 'result empty';
    resultBox.innerHTML = 'Не удалось загрузить config.json. Проверьте, что файл лежит рядом с index.html и сайт открыт через локальный сервер.';
  }
}

initApp();
