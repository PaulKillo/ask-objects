// Мини-приложение «Объекты АСК Групп»: карта участков для агентов партнёров.

const CONFIG = window.APP_CONFIG;
const WebApp = window.WebApp;
const inMax = Boolean(WebApp && WebApp.initData);

const $ = (id) => document.getElementById(id);
const AGENT_KEY = 'ask_agent';           // общий с ботом закрепления: данные агента подставятся сами
const REQUESTED_KEY = 'ask_objects_requested';
const OTHER = '__other__';
const TYUMEN = [57.153, 65.5343];

let objects = [];
let me = null;            // { lat, lon } — положение агента
let selectedId = null;
let map, markers = new Map(), meMarker = null;

// ---------- Утилиты ----------

const store = {
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
  remove(key) { try { localStorage.removeItem(key); } catch (_) {} },
};

function haptic(kind) {
  try {
    if (kind === 'light') WebApp?.HapticFeedback?.impactOccurred('light');
    else WebApp?.HapticFeedback?.notificationOccurred(kind);
  } catch (_) {}
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function show(screenId) {
  for (const id of ['screenStatus', 'screenRequest', 'screenRequested', 'screenMain']) $(id).hidden = id !== screenId;
}

const digitsOf = (s) => String(s || '').replace(/\D/g, '');
function formatPhone(raw) {
  let d = digitsOf(raw);
  if (!d) return '';
  if (d[0] === '8') d = `7${d.slice(1)}`;
  if (d[0] !== '7') d = `7${d}`;
  d = d.slice(0, 11);
  const p = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)];
  return `+7${p[0] ? ` ${p[0]}` : ''}${p[1] ? ` ${p[1]}` : ''}${p[2] ? `-${p[2]}` : ''}${p[3] ? `-${p[3]}` : ''}`;
}

// Расстояние по прямой, км
function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = (km) => (km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)) + ' км';

function openExternal(url) {
  try {
    if (inMax) { WebApp.openLink(url); return; }
  } catch (_) {}
  window.open(url, '_blank', 'noopener');
}

const routeUrl = (lat, lon) => `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (__) {}
    ta.remove();
  }
  toast('Кадастровый номер скопирован');
  haptic('light');
}

// ---------- Сервер ----------

async function callApi(body) {
  const res = await fetch(CONFIG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: WebApp?.initData || '', ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

async function load() {
  show('screenStatus');
  $('spinner').hidden = false;
  $('retry').hidden = true;
  $('statusText').textContent = 'Загружаем объекты…';

  if (!inMax) {
    $('spinner').hidden = true;
    $('statusText').textContent = 'Карта открывается только из бота АСК Групп в MAX.';
    return;
  }

  try {
    const data = await callApi({ action: 'objects' });
    if (data.access) {
      store.remove(REQUESTED_KEY);
      objects = data.objects;
      showMain();
    } else if (store.get(REQUESTED_KEY)) {
      show('screenRequested');
    } else {
      showRequestForm();
    }
  } catch (e) {
    $('spinner').hidden = true;
    $('statusText').textContent = e instanceof TypeError
      ? 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'
      : e.message;
    $('retry').hidden = false;
  }
}

// ---------- Запрос доступа ----------

function showRequestForm() {
  const form = $('requestForm');
  const select = form.elements.agency;
  if (select.options.length === 1) {
    for (const name of CONFIG.agencies) select.add(new Option(name, name));
    select.add(new Option('Другое агентство', OTHER));
  }

  let saved = null;
  try { saved = JSON.parse(store.get(AGENT_KEY)); } catch (_) {}
  if (saved) {
    form.elements.name.value = saved.name || '';
    form.elements.phone.value = saved.phone || '';
    if (saved.agencyListed && CONFIG.agencies.includes(saved.agency)) select.value = saved.agency;
    else if (saved.agency) { select.value = OTHER; form.elements.agencyOther.value = saved.agency; }
  } else {
    const u = WebApp?.initDataUnsafe?.user;
    form.elements.name.value = [u?.last_name, u?.first_name].filter(Boolean).join(' ');
  }
  $('agencyOtherField').hidden = select.value !== OTHER;
  show('screenRequest');
}

async function submitRequest(event) {
  event.preventDefault();
  const form = $('requestForm');
  const listed = form.elements.agency.value !== OTHER;
  const agent = {
    name: form.elements.name.value.trim(),
    phone: formatPhone(form.elements.phone.value),
    agency: listed ? form.elements.agency.value : form.elements.agencyOther.value.trim(),
    agencyListed: listed,
  };

  const bad = [];
  const mark = (el, ok) => { el.classList.toggle('invalid', !ok); if (!ok) bad.push(el); };
  mark(form.elements.name, Boolean(agent.name));
  mark(form.elements.phone, digitsOf(agent.phone).length === 11);
  mark(form.elements.agency, Boolean(form.elements.agency.value));
  if (!listed) mark(form.elements.agencyOther, Boolean(agent.agency));

  const err = $('requestError');
  if (bad.length) {
    err.textContent = 'Заполните отмеченные поля.';
    err.hidden = false;
    haptic('error');
    return;
  }
  err.hidden = true;

  const btn = $('requestSubmit');
  btn.disabled = true;
  btn.textContent = 'Отправляем…';
  try {
    const data = await callApi({ action: 'request', agent });
    store.set(AGENT_KEY, JSON.stringify(agent));
    haptic('success');
    if (data.access) { load(); return; }
    store.set(REQUESTED_KEY, '1');
    show('screenRequested');
  } catch (e) {
    err.textContent = e instanceof TypeError ? 'Нет связи с сервером. Попробуйте ещё раз.' : e.message;
    err.hidden = false;
    haptic('error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Запросить доступ';
  }
}

// ---------- Карта и список ----------

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const tract = $('tractFilter').value;
  return objects.filter((o) => (!tract || o.tract === tract)
    && (!q || `${o.place} ${o.address} ${o.cadastral}`.toLowerCase().includes(q)));
}

const sortKey = (o) => (me ? distanceKm(me, o) : o.km);

function renderList() {
  const items = filtered().sort((a, b) => sortKey(a) - sortKey(b));
  const list = $('list');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Ничего не найдено';
    list.append(empty);
    return;
  }
  for (const o of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item';
    btn.innerHTML = '<div class="item-top"><span class="item-place"></span><span class="item-dist"></span></div>'
      + '<div class="item-sub"></div>';
    btn.querySelector('.item-place').textContent = o.place;
    btn.querySelector('.item-dist').textContent = me ? fmtKm(distanceKm(me, o)) : `${fmtKm(o.km)} от Тюмени`;
    btn.querySelector('.item-sub').textContent = `${o.tract} · ${o.address}`;
    btn.addEventListener('click', () => openSheet(o.id));
    list.append(btn);
  }
}

function renderMarkers() {
  const visible = new Set(filtered().map((o) => o.id));
  for (const [id, m] of markers) {
    if (visible.has(id)) m.addTo(map); else m.remove();
  }
}

function pinIcon(selected) {
  return L.divIcon({ className: '', html: `<div class="pin${selected ? ' selected' : ''}"></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(TYUMEN, 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  for (const o of objects) {
    const m = L.marker([o.lat, o.lon], { icon: pinIcon(false), title: o.place });
    m.on('click', () => openSheet(o.id));
    markers.set(o.id, m);
  }
  renderMarkers();
  const bounds = L.latLngBounds(objects.map((o) => [o.lat, o.lon]));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
}

function setView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('map').hidden = view !== 'map';
  $('list').hidden = view !== 'list';
  $('locate').hidden = view !== 'map';
  if (view === 'map') setTimeout(() => map.invalidateSize(), 0);
  else renderList();
}

function showMain() {
  const tracts = [...new Set(objects.map((o) => o.tract))].sort((a, b) => a.localeCompare(b, 'ru'));
  const sel = $('tractFilter');
  sel.length = 1;
  for (const t of tracts) sel.add(new Option(t, t));

  show('screenMain');
  if (!map) initMap(); else map.invalidateSize();
  renderList();
  locate(false);
}

// ---------- Местоположение агента ----------

function locate(centerMap) {
  const note = $('geoNote');
  if (!navigator.geolocation) {
    note.textContent = 'Расстояние считается от центра Тюмени: телефон не передаёт местоположение.';
    note.hidden = false;
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    note.hidden = true;
    const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    if (meMarker) meMarker.setLatLng([me.lat, me.lon]);
    else meMarker = L.marker([me.lat, me.lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    if (centerMap) map.setView([me.lat, me.lon], 11);
    renderList();
    if (selectedId != null) fillSheet(objects.find((o) => o.id === selectedId));
  }, () => {
    note.textContent = 'Разрешите доступ к местоположению, чтобы видеть расстояние от вас. Пока считаем от центра Тюмени.';
    note.hidden = false;
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 });
}

// ---------- Карточка объекта ----------

function fillSheet(o) {
  $('sheetPlace').textContent = o.place;
  $('sheetAddress').textContent = o.address;
  $('sheetTract').textContent = o.tract;
  $('sheetFromCity').textContent = `${fmtKm(o.km)} по дорогам, ~${o.min} мин`;
  $('sheetFromMeLabel').hidden = !me;
  $('sheetFromMe').hidden = !me;
  if (me) $('sheetFromMe').textContent = `≈ ${fmtKm(distanceKm(me, o))} по прямой`;
  $('sheetCad').textContent = o.cadastral;

  const extra = $('extraRoutes');
  extra.replaceChildren();
  (o.extra || []).forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn secondary';
    b.textContent = `Маршрут ко ${i + 2}-му участку`;
    b.addEventListener('click', () => openExternal(routeUrl(p.lat, p.lon)));
    extra.append(b);
  });
}

function openSheet(id) {
  const o = objects.find((x) => x.id === id);
  if (!o) return;
  if (selectedId != null) markers.get(selectedId)?.setIcon(pinIcon(false));
  selectedId = id;
  markers.get(id)?.setIcon(pinIcon(true));
  fillSheet(o);
  $('sheet').hidden = false;
  $('sheetBackdrop').hidden = false;
  haptic('light');
  try { WebApp?.BackButton?.show(); } catch (_) {}
}

function closeSheet() {
  if (selectedId != null) markers.get(selectedId)?.setIcon(pinIcon(false));
  selectedId = null;
  $('sheet').hidden = true;
  $('sheetBackdrop').hidden = true;
  try { WebApp?.BackButton?.hide(); } catch (_) {}
}

// ---------- Инициализация ----------

function init() {
  $('retry').addEventListener('click', load);
  $('checkAgain').addEventListener('click', () => { store.remove(REQUESTED_KEY); load(); });

  const form = $('requestForm');
  form.addEventListener('submit', submitRequest);
  form.elements.phone.addEventListener('input', (e) => { e.target.value = formatPhone(e.target.value); });
  form.elements.agency.addEventListener('change', () => { $('agencyOtherField').hidden = form.elements.agency.value !== OTHER; });
  form.addEventListener('input', (e) => e.target.classList.remove('invalid'));

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('search').addEventListener('input', () => { renderMarkers(); renderList(); });
  $('tractFilter').addEventListener('change', () => { renderMarkers(); renderList(); });
  $('locate').addEventListener('click', () => locate(true));

  $('sheetBackdrop').addEventListener('click', closeSheet);
  try { WebApp?.BackButton?.onClick(closeSheet); } catch (_) {}
  $('copyCad').addEventListener('click', () => copyText($('sheetCad').textContent));
  $('routeBtn').addEventListener('click', () => {
    const o = objects.find((x) => x.id === selectedId);
    if (o) openExternal(routeUrl(o.lat, o.lon));
  });

  WebApp?.ready?.();
  load();
}

init();
