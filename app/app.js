/* TV-first UI. No provider credentials are stored in browser storage. */
const API = location.port === '8080' || location.port === '8081' ? 'http://localhost:8090' : location.origin;
const $ = (id) => document.getElementById(id);
let demo = false, current = null, items = [], page = 0, requestVersion = 0, hls = null;
let favorites = {};
try { favorites = JSON.parse(localStorage.getItem('brew-favorites') || '{}'); } catch (_) {}
const pageSize = 30;
const demoCategories = [{ category_id: '1', category_name: 'Descubrir' },{ category_id: '2', category_name: 'Noticias' },{ category_id: '3', category_name: 'Cultura' },{ category_id: '4', category_name: 'Deportes' }];
const demoChannels = ['Horizonte','Mundo 24','Atlas','Cultura abierta','Arena','Viajes','Sonido','Documental'].map((name,i) => ({stream_id:i+1,name:name+' · Demo'}));
async function api(path, options) {
  const response = await fetch(API + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error de conexión');
  return data;
}
function button(label, action) {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
  el.onclick = action; return el;
}
function showSetup() {
  $('browser').hidden = true; $('setup').hidden = false;
  $('base-url').focus();
}
function saveFavorites() { try { localStorage.setItem('brew-favorites', JSON.stringify(favorites)); } catch (_) {} }
function favoriteKey(channel) { return (demo ? 'demo:' : 'live:') + channel.stream_id; }
function renderChannels() {
  const focusedId = document.activeElement && document.activeElement.getAttribute('data-channel');
  const query = $('search').value.toLowerCase();
  const filtered = items.filter(c => c.name.toLowerCase().indexOf(query) >= 0);
  page = Math.max(0, Math.min(page, Math.ceil(filtered.length/pageSize)-1));
  $('channels').textContent = '';
  filtered.slice(page*pageSize, (page+1)*pageSize).forEach((channel,i) => {
    const el = button('', () => playChannel(channel));
    el.className = 'channel' + (current && current.stream_id === channel.stream_id ? ' selected' : '');
    el.setAttribute('data-channel', String(channel.stream_id));
    const number = document.createElement('span'); number.className = 'number';
    number.textContent = favorites[favoriteKey(channel)] ? '★' : String(page*pageSize+i+1).padStart(2,'0');
    const name = document.createElement('strong'); name.textContent = channel.name;
    el.appendChild(number); el.appendChild(name); $('channels').appendChild(el);
  });
  if (!filtered.length) $('channels').textContent = 'No hay canales para mostrar.';
  $('channel-count').textContent = filtered.length + ' canales';
  $('page-label').textContent = filtered.length ? (page+1)+' / '+Math.ceil(filtered.length/pageSize) : '0';
  $('previous').disabled = page === 0; $('next').disabled = (page+1)*pageSize >= filtered.length;
  if (focusedId) {
    const replacement = Array.prototype.find.call($('channels').children, el => el.getAttribute('data-channel') === focusedId);
    if (replacement) replacement.focus();
  }
}
async function loadChannels(category, el) {
  const version = ++requestVersion;
  $('channel-heading').textContent = category.category_name;
  Array.prototype.forEach.call($('categories').children, b => b.classList.remove('selected'));
  if (el) el.classList.add('selected');
  $('channels').textContent = 'Cargando canales…';
  try {
    const result = demo ? demoChannels : await api('/api/xtream/channels?categoryId='+encodeURIComponent(category.category_id));
    if (version !== requestVersion) return;
    if (!Array.isArray(result)) throw new Error('El proveedor no devolvió una lista de canales.');
    items = result.filter(c => c && /^\d+$/.test(String(c.stream_id))).map(c => ({stream_id:c.stream_id,name:String(c.name || 'Canal')}));
    page = 0; $('search').value = ''; renderChannels();
  } catch (error) { if (version === requestVersion) $('channels').textContent = error.message; }
}
function stopPlayer() {
  if (hls) { hls.destroy(); hls = null; }
  $('player').pause(); $('player').removeAttribute('src'); $('player').load();
}
function playChannel(channel) {
  current = channel; stopPlayer();
  $('placeholder').hidden = false; $('now-playing').textContent = channel.name;
  $('player-error').textContent = '';
  $('favorite-toggle').textContent = favorites[favoriteKey(channel)] ? '★' : '☆';
  if (demo) { $('playback-status').textContent = 'Demostración visual: este canal es ficticio.'; renderChannels(); return; }
  $('playback-status').textContent = 'Conectando al canal…';
  const url = API + '/api/xtream/stream/' + encodeURIComponent(channel.stream_id);
  const video = $('player');
  const begin = () => { const promise = video.play(); if (promise) promise.catch(() => { $('playback-status').textContent = 'Pulsa Reproducir para comenzar.'; }); };
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url; begin();
  } else if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40 });
    hls.loadSource(url); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, begin);
    hls.on(Hls.Events.ERROR, (_event,data) => {
      if (data.fatal) { $('player-error').textContent = 'No se pudo reproducir el canal. Prueba Reintentar u otro canal.'; $('playback-status').textContent = 'Reproducción interrumpida'; }
    });
  } else $('player-error').textContent = 'Este navegador no ofrece reproducción HLS compatible.';
  renderChannels();
}
async function showBrowser() {
  $('setup').hidden = true; $('browser').hidden = false;
  $('service-status').textContent = demo ? '● Demostración' : '● Conectado';
  try {
    const result = demo ? demoCategories : await api('/api/xtream/categories');
    if (!Array.isArray(result)) throw new Error('No se pudieron cargar las categorías');
    $('categories').textContent = '';
    result.forEach(category => {
      const el = button(category.category_name, () => loadChannels(category,el));
      $('categories').appendChild(el);
    });
    if (result.length) { await loadChannels(result[0],$('categories').firstChild); $('categories').firstChild.focus(); }
    else $('channels').textContent = 'Esta cuenta no contiene categorías de TV en directo.';
  } catch(error) { $('channels').textContent = error.message; }
}
$('config-form').onsubmit = async event => {
  event.preventDefault(); const submit = $('config-form').querySelector('button'); submit.disabled = true;
  $('config-error').textContent = '';
  try {
    await api('/api/xtream/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:$('base-url').value,username:$('username').value,password:$('password').value})});
    $('password').value = ''; demo = false; await showBrowser();
  } catch(error) { $('config-error').textContent = error.message; }
  finally { submit.disabled = false; }
};
$('demo').onclick = () => { demo = true; showBrowser(); };
$('settings').onclick = () => { stopPlayer(); showSetup(); };
$('search').oninput = () => { page = 0; renderChannels(); };
function focusChannel() { const first = $('channels').querySelector('button'); if (first) first.focus(); }
$('previous').onclick = () => { page--; renderChannels(); focusChannel(); };
$('next').onclick = () => { page++; renderChannels(); focusChannel(); };
$('favorites').onclick = () => {
  ++requestVersion; items = Object.keys(favorites).filter(k => k.indexOf(demo ? 'demo:' : 'live:') === 0).map(k => favorites[k]);
  $('channel-heading').textContent = 'Favoritos'; $('search').value = ''; page = 0; renderChannels();
};
$('favorite-toggle').onclick = () => {
  if (!current) return; const key = favoriteKey(current);
  if (favorites[key]) delete favorites[key]; else favorites[key] = current;
  saveFavorites(); $('favorite-toggle').textContent = favorites[key] ? '★' : '☆'; renderChannels();
};
$('retry').onclick = () => { if (current) playChannel(current); };
function toggle() {
  if (!current || demo) return;
  if ($('player').paused) { const p = $('player').play(); if (p) p.catch(() => { $('player-error').textContent = 'No se pudo reanudar. Prueba Reintentar.'; }); }
  else $('player').pause();
}
$('toggle').onclick = toggle;
$('fullscreen').onclick = () => { if (current && !demo) document.body.classList.toggle('cinema'); };
$('player').onplaying = () => { $('placeholder').hidden = true; $('playback-status').textContent = 'Reproduciendo en directo'; $('player-error').textContent = ''; };
$('player').onwaiting = () => { $('playback-status').textContent = 'Cargando vídeo…'; };
$('player').onerror = () => { if (current && !demo) $('player-error').textContent = 'El canal no está disponible o su formato no es compatible.'; };
document.addEventListener('keydown', event => {
  const code = event.keyCode;
  if (code === 10009 || event.key === 'Escape') {
    event.preventDefault();
    if (document.body.classList.contains('cinema')) document.body.classList.remove('cinema');
    else if (!$('setup').hidden && current) { $('setup').hidden=true; $('browser').hidden=false; $('settings').focus(); }
    else $('settings').focus();
    return;
  }
  if ([10252,415,19,413].indexOf(code)>=0) {
    event.preventDefault();
    if (code===413) {stopPlayer();$('placeholder').hidden=false;}
    else if (code===19) $('player').pause();
    else if (code===415) { if ($('player').paused) toggle(); }
    else toggle();
    return;
  }
  if (document.body.classList.contains('cinema')) { if (code===13) {event.preventDefault();toggle();} return; }
  if ([37,38,39,40].indexOf(code)<0) return;
  const active = document.activeElement;
  if (active && active.tagName==='INPUT' && (code===37 || code===39)) return;
  event.preventDefault();
  const targets = Array.prototype.filter.call(document.querySelectorAll('button,input'), el => !el.disabled && el.getClientRects().length);
  if (!active || targets.indexOf(active)<0) { if(targets[0]) targets[0].focus(); return; }
  const rect=active.getBoundingClientRect(), x=rect.left+rect.width/2,y=rect.top+rect.height/2;
  let best=null,score=Infinity;
  targets.forEach(el => {
    if(el===active) return; const r=el.getBoundingClientRect(), dx=r.left+r.width/2-x,dy=r.top+r.height/2-y;
    const primary=code===37?-dx:code===39?dx:code===38?-dy:dy,secondary=(code===37||code===39)?Math.abs(dy):Math.abs(dx);
    if(primary>1 && primary+secondary*3<score) {score=primary+secondary*3;best=el;}
  });
  if(best) {best.focus();best.scrollIntoView({block:'nearest'});}
});
function clock() { $('clock').textContent = new Date().toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'}); }
clock(); setInterval(clock,60000);
(async () => {
  try {
    await api('/health'); const config=await api('/api/xtream/config');
    if(config.configured) { const status=await api('/api/xtream/status'); if(status.connected) {await showBrowser();return;} }
    $('service-status').textContent='● Servicio disponible'; showSetup();
  } catch(error) { $('service-status').textContent='Servicio no disponible'; showSetup(); $('config-error').textContent='Inicia el servicio y vuelve a cargar la página.'; }
})();
