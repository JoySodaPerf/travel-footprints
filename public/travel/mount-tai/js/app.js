'use strict';

(function () {
  // Leaflet（CDN）未加载时给出明确提示，避免白屏/黑屏
  if (typeof L === 'undefined') {
    const sub = document.querySelector('.boot-sub');
    if (sub) sub.textContent = '加载失败：地图组件不可用，请检查网络后重试';
    return;
  }

  const POIS = window.POIS || [];
  const CHECKINS_KEY = 'tf:checkins:v1';
  const NOTIFIED_KEY = 'tf:notified:v1';
  const SETTINGS_KEY = 'tf:settings:v1';

  const SETTING_DEFAULTS = {
    accuracy: 'balanced',   // high | balanced | eco
    autoFollow: true,
    followIdle: 30,         // 秒
    notify: false
  };
  const GEO_PRESETS = {
    high:     { label: '高精度', freq: '约 1 秒', battery: '较耗电', enableHighAccuracy: true,  maximumAge: 5000,  timeout: 15000 },
    balanced: { label: '平衡',   freq: '约 5-15 秒', battery: '适中', enableHighAccuracy: false, maximumAge: 15000, timeout: 20000 },
    eco:      { label: '省电',   freq: '约 1 分钟', battery: '最省电', enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 }
  };

  /* ---------- state ---------- */
  let map = null;
  let userMarker = null;
  let userPos = null;          // { lat, lng, acc, alt }
  let watchId = null;
  let checkins = {};           // poiId -> { t, lat, lng, acc }
  let notified = new Set();
  let nearestId = null;
  let selectedId = null;
  let viewMode = 'list';       // list | detail | settings
  let follow = true;
  let followTimer = null;
  let simMode = false;
  let deferredPrompt = null;
  let settings = Object.assign({}, SETTING_DEFAULTS);
  const poiMarkers = {};
  const poiCircles = {};
  const store = {
    get: function (k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } },
    set: function (k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  };

  const $ = function (s) { return document.querySelector(s); };

  /* ---------- geo math ---------- */
  function haversine(a, b) {
    const R = 6371000;
    const rad = function (d) { return d * Math.PI / 180; };
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const fmtDist = function (m) {
    if (m == null || !isFinite(m)) return '--';
    return m < 1000 ? Math.round(m) + ' 米' : (m / 1000).toFixed(1) + ' 公里';
  };
  const fmtTime = function (ts) {
    const d = new Date(ts);
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  function routeStats() {
    let dist = 0, gain = 0;
    for (let i = 1; i < POIS.length; i++) {
      dist += haversine(POIS[i - 1], POIS[i]);
      const dAlt = POIS[i].alt - POIS[i - 1].alt;
      if (dAlt > 0) gain += dAlt;
    }
    return { dist: dist, gain: gain };
  }

  /* ---------- settings ---------- */
  function loadSettings() {
    settings = Object.assign({}, SETTING_DEFAULTS, store.get(SETTINGS_KEY, {}));
    if (!(settings.accuracy in GEO_PRESETS)) settings.accuracy = SETTING_DEFAULTS.accuracy;
    if (!(settings.followIdle >= 5)) settings.followIdle = SETTING_DEFAULTS.followIdle;
  }
  function saveSettings() { store.set(SETTINGS_KEY, settings); }

  /* ---------- follow / recenter ---------- */
  function userInteracted() {
    follow = false;
    restartFollowTimer();
  }
  function restartFollowTimer() {
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(function () {
      if (settings.autoFollow && userPos) {
        follow = true;
        map.panTo([userPos.lat, userPos.lng], { animate: true, duration: 0.8 });
      }
    }, Math.max(5, settings.followIdle) * 1000);
  }
  function centerOnUser() {
    follow = true;
    if (userPos) map.panTo([userPos.lat, userPos.lng], { animate: true, duration: 0.8 });
    restartFollowTimer();
  }

  /* ---------- poi helpers ---------- */
  function poiById(id) {
    for (let i = 0; i < POIS.length; i++) if (POIS[i].id === id) return POIS[i];
    return null;
  }
  function isChecked(p) { return !!checkins[p.id]; }
  function distToUser(p) {
    if (!userPos) return null;
    return haversine(userPos, p);
  }
  function inRange(p) {
    const d = distToUser(p);
    return d !== null && d <= p.radius;
  }

  /* ---------- map ---------- */
  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true, maxZoom: 19 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    const bounds = L.latLngBounds(POIS.map(function (p) { return [p.lat, p.lng]; }));
    bounds.extend([36.19, 117.075]);
    bounds.extend([36.27, 117.12]);
    map.fitBounds(bounds.pad(0.12));

    // 登山路线：白色描边 + 金色虚线，任何底图上都清晰
    const route = POIS.map(function (p) { return [p.lat, p.lng]; });
    L.polyline(route, {
      color: '#FFFFFF', weight: 6, opacity: 0.6,
      lineCap: 'round', lineJoin: 'round', interactive: false
    }).addTo(map);
    L.polyline(route, {
      color: '#C9A227', weight: 3, opacity: 0.95, dashArray: '6 8',
      lineCap: 'round', lineJoin: 'round', interactive: false
    }).addTo(map);

    POIS.forEach(function (p) {
      const circle = L.circle([p.lat, p.lng], {
        radius: p.radius,
        color: '#C9A227',
        weight: 1,
        dashArray: '4 6',
        fillColor: '#C9A227',
        fillOpacity: 0.05,
        interactive: false
      }).addTo(map);
      poiCircles[p.id] = circle;

      const marker = L.circleMarker([p.lat, p.lng], markerStyle(p)).addTo(map);
      marker.on('click', function () { openDetail(p.id); });
      poiMarkers[p.id] = marker;
    });

    map.on('click', function (e) {
      if (simMode) { setUserPos(e.latlng.lat, e.latlng.lng, 10); }
    });
    // 用户拖动/缩放地图后停止自动回中，空闲 N 秒后恢复
    map.on('dragstart zoomstart', userInteracted);
  }

  function markerStyle(p) {
    if (isChecked(p)) {
      return { radius: 9, color: '#2E7D32', weight: 2, fillColor: '#2E7D32', fillOpacity: 1 };
    }
    if (p.id === nearestId) {
      return { radius: 10, color: '#C9A227', weight: 2.5, fillColor: '#F5C542', fillOpacity: 1 };
    }
    return { radius: 8, color: '#C0392B', weight: 2, fillColor: '#F6F3EC', fillOpacity: 1 };
  }

  function refreshMarkers() {
    POIS.forEach(function (p) { poiMarkers[p.id].setStyle(markerStyle(p)); });
  }

  /* ---------- geolocation ---------- */
  function startGeo() {
    if (!('geolocation' in navigator)) {
      setGeoStatus('浏览器不支持定位，可开启模拟模式');
      return;
    }
    setGeoStatus('正在获取定位…');
    const cfg = GEO_PRESETS[settings.accuracy] || GEO_PRESETS.balanced;
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: cfg.enableHighAccuracy,
      maximumAge: cfg.maximumAge,
      timeout: cfg.timeout
    });
  }

  function restartGeoWatch() {
    if (simMode) return;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    startGeo();
  }

  function onPosition(pos) {
    const c = pos.coords;
    setUserPos(c.latitude, c.longitude, c.accuracy, c.altitude);
  }

  function onGeoError(err) {
    setGeoStatus('定位失败：' + (err.code === 1 ? '未授权' : '信号弱') + '，可开启模拟模式');
  }

  function setUserPos(lat, lng, acc, alt) {
    userPos = { lat: lat, lng: lng, acc: acc || 20, alt: alt || null };
    if (!userMarker) {
      userMarker = L.marker([lat, lng], { zIndexOffset: 1000 }).addTo(map);
      userMarker.bindPopup('我的位置');
    } else {
      userMarker.setLatLng([lat, lng]);
    }
    if (follow) map.panTo([lat, lng], { animate: true, duration: 0.6 });

    updateStatus();
    updateNearby();
    refreshSheet();
    refreshMarkers();
  }

  function updateStatus() {
    if (!userPos) return;
    let parts = [];
    if (userPos.acc != null) parts.push('精度 ±' + Math.round(userPos.acc) + 'm');
    if (userPos.alt != null && isFinite(userPos.alt)) parts.push('海拔 ' + Math.round(userPos.alt) + 'm');
    const near = nearestUnchecked();
    if (near && userPos) {
      const d = haversine(userPos, near);
      parts.push('距下一站 ' + near.name + ' ' + fmtDist(d));
    }
    setGeoStatus(simMode ? '模拟定位 · ' + parts.join(' · ') : parts.join(' · ') || '已定位');
  }

  function nearestUnchecked() {
    let best = null, bestD = Infinity;
    POIS.forEach(function (p) {
      if (isChecked(p)) return;
      const d = distToUser(p);
      if (d !== null && d < bestD) { bestD = d; best = p; }
    });
    return best;
  }

  function updateNearby() {
    let newNearest = null;
    let inRangePoi = null;
    POIS.forEach(function (p) {
      if (isChecked(p)) return;
      if (inRange(p)) {
        inRangePoi = p;
        if (newNearest === null) newNearest = p;
      }
    });
    if (!newNearest) newNearest = nearestUnchecked();
    if (newNearest) nearestId = newNearest.id;
    else nearestId = null;

    if (inRangePoi && !notified.has(inRangePoi.id)) {
      notified.add(inRangePoi.id);
      store.set(NOTIFIED_KEY, Array.from(notified));
      notifyArrival(inRangePoi);
    }
  }

  /* ---------- notification ---------- */
  function notifyArrival(p) {
    const msg = '已到达「' + p.name + '」，可在详情中打卡';
    showToast(msg);
    if (navigator.vibrate) { try { navigator.vibrate(90); } catch (e) {} }
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('泰山打卡 · 到达景点', {
          body: '已到达「' + p.name + '」，记得打卡哦',
          icon: 'icons/icon-192.png',
          tag: 'arrival-' + p.id
        });
      } catch (e) {}
    }
  }

  /* ---------- rendering ---------- */
  function renderProgress() {
    const done = POIS.filter(isChecked).length;
    const total = POIS.length;
    $('#progress-fill').style.width = (total ? (done / total * 100) : 0) + '%';
    $('#progress-text').textContent = done + ' / ' + total;
    updateSheetToggle();
  }

  function updateSheetToggle() {
    const sheet = $('#sheet');
    const collapsed = sheet.classList.contains('collapsed');
    const done = POIS.filter(isChecked).length;
    $('#sheet-toggle-text').textContent = collapsed
      ? '展开列表 · 已打卡 ' + done + '/' + POIS.length
      : '收起列表';
  }

  function renderList() {
    const body = $('#sheet-body');
    const done = POIS.filter(isChecked).length;
    const stats = routeStats();
    const list = POIS.slice().sort(function (a, b) {
      const da = distToUser(a), db = distToUser(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });

    let html = '<div class="list-head">登山路线 · 全程约 ' + fmtDist(stats.dist) + ' · 累计爬升约 ' + Math.round(stats.gain) + 'm · 已打卡 ' + done + '/' + POIS.length + (userPos ? '（按距离排序）' : '') + '</div>';
    list.forEach(function (p) {
      const d = distToUser(p);
      const ck = checkins[p.id];
      let dotCls = 'open', stText = '未打卡', stCls = 'open', sub;
      if (ck) { dotCls = 'checked'; stCls = 'checked'; stText = '已打卡'; sub = '打卡于 ' + fmtTime(ck.t); }
      else if (inRange(p)) { dotCls = 'near'; stCls = 'near'; stText = '可打卡'; sub = '就在附近（' + fmtDist(d) + '）'; }
      else { dotCls = 'open'; sub = d !== null ? '距此 ' + fmtDist(d) : '待定位'; }
      html +=
        '<div class="poi-item" data-id="' + p.id + '">' +
          '<span class="poi-dot ' + dotCls + '"></span>' +
          '<div class="poi-main">' +
            '<div class="poi-name">' + p.name + '<span class="badge">' + p.type + ' · 海拔 ' + p.alt + 'm</span></div>' +
            '<div class="poi-sub">' + sub + '</div>' +
          '</div>' +
          '<div class="poi-state"><div class="st ' + stCls + '">' + stText + '</div>' +
          (ck ? '<div class="time">' + fmtTime(ck.t) + '</div>' : '') + '</div>' +
        '</div>';
    });
    body.innerHTML = html;
    body.querySelectorAll('.poi-item').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.dataset.id); });
    });
  }

  /* ---------- views ---------- */
  function openDetail(id) {
    const p = poiById(id);
    if (!p) return;
    selectedId = id;
    viewMode = 'detail';
    detailState.id = null; // 强制完整渲染
    const sheet = $('#sheet');
    sheet.classList.remove('collapsed');
    sheet.classList.add('detail-mode');
    updateSheetToggle();
    renderDetail(p);
  }

  function closeDetail() {
    selectedId = null;
    viewMode = 'list';
    detailState.id = null;
    $('#sheet').classList.remove('detail-mode');
    renderList();
  }

  function openSettings() {
    selectedId = null;
    viewMode = 'settings';
    const sheet = $('#sheet');
    sheet.classList.remove('collapsed');
    sheet.classList.add('detail-mode');
    updateSheetToggle();
    renderSettings();
  }

  function closeSettings() {
    viewMode = 'list';
    $('#sheet').classList.remove('detail-mode');
    renderList();
  }

  /* 定位更新时按当前面板模式刷新：
   * 详情 -> 状态变化重建，否则原地更新距离；设置 -> 不刷新 */
  const detailState = { id: null, reachable: false, checked: false };
  function refreshSheet() {
    if (viewMode === 'detail' && selectedId) {
      const p = poiById(selectedId);
      if (!p) return;
      const ck = checkins[p.id];
      const reachable = !ck && inRange(p);
      if (detailState.id !== p.id || detailState.reachable !== reachable || detailState.checked !== !!ck) {
        detailState.id = p.id;
        detailState.reachable = reachable;
        detailState.checked = !!ck;
        renderDetail(p);
      } else {
        updateDetailDynamic(p);
      }
    } else if (viewMode === 'settings') {
      return;
    } else {
      renderList();
    }
  }

  function updateDetailDynamic(p) {
    const d = distToUser(p);
    const distEl = document.getElementById('detail-dist');
    if (distEl) distEl.textContent = fmtDist(d);
    const btn = document.getElementById('checkin-btn');
    if (btn && btn.disabled && !checkins[p.id]) {
      btn.textContent = d !== null ? '距目标还有 ' + fmtDist(d) : '等待定位…';
    }
  }

  function renderDetail(p) {
    const body = $('#sheet-body');
    const d = distToUser(p);
    const ck = checkins[p.id];
    const reachable = !ck && inRange(p);
    detailState.id = p.id;
    detailState.reachable = reachable;
    detailState.checked = !!ck;

    let meta =
      '<div class="detail-meta">' +
        '<span><b>' + p.type + '</b></span>' +
        '<span>海拔 <b>' + p.alt + '</b> m</span>' +
        '<span>距我 <b id="detail-dist">' + fmtDist(d) + '</b></span>' +
        '<span>打卡半径 <b>' + p.radius + '</b> 米</span>' +
      '</div>';
    let tip = p.tip ? '<div class="detail-tip">' + p.tip + '</div>' : '';
    let btn;
    if (ck) {
      btn = '<button class="checkin-btn done" disabled>已打卡 · ' + fmtTime(ck.t) + '</button>';
    } else if (d !== null && d <= p.radius) {
      btn = '<button class="checkin-btn" id="checkin-btn">到此打卡</button>';
    } else if (d !== null) {
      btn = '<button class="checkin-btn" id="checkin-btn" disabled>距目标还有 ' + fmtDist(d) + '</button>';
    } else {
      btn = '<button class="checkin-btn" id="checkin-btn" disabled>等待定位…</button>';
    }

    body.innerHTML =
      '<div class="detail-head">' +
        '<button class="back-btn" id="back-btn">返回列表</button>' +
        '<span class="detail-title">' + p.name + '</span>' +
      '</div>' +
      meta +
      '<p class="detail-intro">' + p.intro + '</p>' +
      tip +
      btn;

    $('#back-btn').addEventListener('click', closeDetail);
    const b = $('#checkin-btn');
    if (b) b.addEventListener('click', function () { doCheckin(p.id); });
    void reachable;
  }

  function renderSettings() {
    const body = $('#sheet-body');
    const idleOptions = [15, 30, 60];
    const accRadios = Object.keys(GEO_PRESETS).map(function (k) {
      const p = GEO_PRESETS[k];
      return '<label class="set-radio' + (settings.accuracy === k ? ' checked' : '') + '">' +
        '<input type="radio" name="set-acc" value="' + k + '"' + (settings.accuracy === k ? ' checked' : '') + '>' +
        '<span class="set-radio-main"><b>' + p.label + '</b>' +
        '<small>' + p.freq + ' 更新 · ' + p.battery + '</small></span>' +
      '</label>';
    }).join('');
    const idleOpts = idleOptions.map(function (v) {
      return '<option value="' + v + '"' + (settings.followIdle === v ? ' selected' : '') + '>' + v + ' 秒</option>';
    }).join('');

    body.innerHTML =
      '<div class="detail-head">' +
        '<button class="back-btn" id="settings-back">返回列表</button>' +
        '<span class="detail-title">设置</span>' +
      '</div>' +

      '<div class="set-group">' +
        '<div class="set-label">定位精度（决定刷新频率与耗电）</div>' +
        '<div class="set-radios">' + accRadios + '</div>' +
      '</div>' +

      '<div class="set-group">' +
        '<label class="set-switch-row">' +
          '<span class="set-switch-text"><b>拖动地图后自动回中</b>' +
          '<small>无操作 ' + settings.followIdle + ' 秒后，地图回到我的位置</small></span>' +
          '<input type="checkbox" class="switch" id="set-follow"' + (settings.autoFollow ? ' checked' : '') + '>' +
        '</label>' +
        '<div class="set-row">' +
          '<span>回中等待时间</span>' +
          '<select id="set-idle">' + idleOpts + '</select>' +
        '</div>' +
      '</div>' +

      '<div class="set-group">' +
        '<label class="set-switch-row">' +
          '<span class="set-switch-text"><b>到达景点系统通知</b>' +
          '<small>进入打卡范围时弹出通知并震动</small></span>' +
          '<input type="checkbox" class="switch" id="set-notify"' + (settings.notify ? ' checked' : '') + '>' +
        '</label>' +
        '<div class="set-note">应用在前台或后台（未关闭）时有效；屏幕锁定或被系统回收后，浏览器不再运行定位，无法触发。如需锁屏也能提醒，需接入服务端推送，可后续扩展。</div>' +
      '</div>' +

      '<div class="set-group">' +
        '<div class="set-label">耗电说明</div>' +
        '<div class="set-note">持续高精度 GPS 是主要耗电源。连续开启约一小时：高精度（每秒定位）约耗 20-40% 电量；平衡（5-15 秒）约 8-15%；省电（约 1 分钟）约 3-6%，视机型与信号而定。徒步中建议「平衡」，登顶休息时可切「省电」。</div>' +
      '</div>';

    $('#settings-back').addEventListener('click', closeSettings);

    body.querySelectorAll('input[name="set-acc"]').forEach(function (el) {
      el.addEventListener('change', function () {
        settings.accuracy = el.value;
        saveSettings();
        restartGeoWatch();
        renderSettings();
      });
    });
    $('#set-follow').addEventListener('change', function () {
      settings.autoFollow = this.checked;
      saveSettings();
      if (!settings.autoFollow) follow = false;
      else if (userPos) centerOnUser();
      renderSettings();
    });
    $('#set-idle').addEventListener('change', function () {
      settings.followIdle = parseInt(this.value, 10) || 30;
      saveSettings();
      restartFollowTimer();
    });
    $('#set-notify').addEventListener('change', function () {
      settings.notify = this.checked;
      saveSettings();
      if (settings.notify && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    });
  }

  /* ---------- check-in ---------- */
  function doCheckin(id) {
    const p = poiById(id);
    if (!p || !userPos) return;
    const d = haversine(userPos, p);
    if (d > p.radius) {
      showToast('距离目标还有 ' + fmtDist(d) + '，靠近后再打卡');
      return;
    }
    checkins[id] = { t: Date.now(), lat: userPos.lat, lng: userPos.lng, acc: userPos.acc };
    store.set(CHECKINS_KEY, checkins);
    renderProgress();
    refreshMarkers();
    showToast('打卡成功：' + p.name);
    if (viewMode === 'detail' && selectedId === id) renderDetail(p);
    else if (viewMode === 'list') renderList();
    updateStatus();
  }

  /* ---------- ui bits ---------- */
  let toastTimer = null;
  function showToast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function setGeoStatus(s) { $('#geo-status').textContent = s; }

  function bindEvents() {
    $('#locate-btn').addEventListener('click', centerOnUser);
    $('#settings-btn').addEventListener('click', openSettings);
    $('#sim-toggle').addEventListener('click', function () {
      simMode = !simMode;
      $('#sim-toggle').classList.toggle('active', simMode);
      if (simMode) {
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        setGeoStatus('模拟定位中：点击地图放置位置');
      } else {
        setGeoStatus('已退出模拟，重新获取定位');
        startGeo();
      }
    });
    $('#sheet-toggle').addEventListener('click', function () {
      $('#sheet').classList.toggle('collapsed');
      updateSheetToggle();
    });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      $('#install-btn').classList.remove('hidden');
    });
    $('#install-btn').addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('#install-btn').classList.add('hidden');
    });
  }

  function failBoot(msg) {
    const sub = document.querySelector('.boot-sub');
    if (sub) sub.textContent = msg;
  }

  function init() {
    checkins = store.get(CHECKINS_KEY, {});
    try { notified = new Set(store.get(NOTIFIED_KEY, [])); } catch (e) { notified = new Set(); }
    loadSettings();
    follow = settings.autoFollow;

    try {
      initMap();
      bindEvents();
      renderProgress();
      renderList();
      startGeo();
    } catch (e) {
      failBoot('加载失败：' + (e && e.message ? e.message : '未知错误'));
      return;
    }

    const boot = $('#boot-screen');
    if (boot) boot.classList.add('hidden');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline optional */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
