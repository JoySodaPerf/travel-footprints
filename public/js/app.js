'use strict';

(function () {
  const POIS = window.POIS || [];
  const CHECKINS_KEY = 'tf:checkins:v1';
  const NOTIFIED_KEY = 'tf:notified:v1';

  /* ---------- state ---------- */
  let map = null;
  let userMarker = null;
  let userPos = null;          // { lat, lng, acc, alt }
  let watchId = null;
  let checkins = {};           // poiId -> { t, lat, lng, acc }
  let notified = new Set();
  let nearestId = null;
  let selectedId = null;
  let follow = true;
  let simMode = false;
  let deferredPrompt = null;
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
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000
    });
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
    renderList();
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
      showToast('已到达「' + inRangePoi.name + '」，可在详情中打卡');
    }
  }

  /* ---------- rendering ---------- */
  function renderProgress() {
    const done = POIS.filter(isChecked).length;
    const total = POIS.length;
    $('#progress-fill').style.width = (total ? (done / total * 100) : 0) + '%';
    $('#progress-text').textContent = done + ' / ' + total;
  }

  function renderList() {
    const body = $('#sheet-body');
    const done = POIS.filter(isChecked).length;
    const list = POIS.slice().sort(function (a, b) {
      const da = distToUser(a), db = distToUser(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });

    let html = '<div class="list-head">登山路线 · 共 ' + POIS.length + ' 个打卡点，已完成 ' + done + ' 个' + (userPos ? '（按距离排序）' : '') + '</div>';
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

  function openDetail(id) {
    const p = poiById(id);
    if (!p) return;
    selectedId = id;
    $('#sheet').classList.add('detail-mode');
    renderDetail(p);
  }

  function closeDetail() {
    selectedId = null;
    $('#sheet').classList.remove('detail-mode');
    renderList();
  }

  function renderDetail(p) {
    const body = $('#sheet-body');
    const d = distToUser(p);
    const ck = checkins[p.id];
    const reachable = !ck && inRange(p);

    let meta =
      '<div class="detail-meta">' +
        '<span><b>' + p.type + '</b></span>' +
        '<span>海拔 <b>' + p.alt + '</b> m</span>' +
        '<span>距我 <b>' + fmtDist(d) + '</b></span>' +
        '<span>打卡半径 <b>' + p.radius + '</b> 米</span>' +
      '</div>';
    let tip = p.tip ? '<div class="detail-tip">' + p.tip + '</div>' : '';
    let btn;
    if (ck) {
      btn = '<button class="checkin-btn done" disabled>已打卡 · ' + fmtTime(ck.t) + '</button>';
    } else if (d !== null && d <= p.radius) {
      btn = '<button class="checkin-btn" id="checkin-btn">到此打卡</button>';
    } else if (d !== null) {
      btn = '<button class="checkin-btn" disabled>距目标还有 ' + fmtDist(d) + '</button>';
    } else {
      btn = '<button class="checkin-btn" disabled>等待定位…</button>';
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
    if (selectedId === id) renderDetail(p);
    else renderList();
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
    $('#locate-btn').addEventListener('click', function () {
      follow = true;
      if (userPos) map.panTo([userPos.lat, userPos.lng], { animate: true, duration: 0.6 });
      else startGeo();
    });
    $('#sim-toggle').addEventListener('click', function () {
      simMode = !simMode;
      $('#sim-toggle').classList.toggle('active', simMode);
      $('#sim-banner').classList.toggle('hidden', !simMode);
      if (simMode) {
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        setGeoStatus('模拟定位中：点击地图放置位置');
      } else {
        setGeoStatus('已退出模拟，重新获取定位');
        startGeo();
      }
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

  function init() {
    checkins = store.get(CHECKINS_KEY, {});
    try { notified = new Set(store.get(NOTIFIED_KEY, [])); } catch (e) { notified = new Set(); }

    initMap();
    bindEvents();
    renderProgress();
    renderList();
    startGeo();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* offline optional */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
