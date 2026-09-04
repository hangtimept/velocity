/**
 * BarVelocity — Professional Barbell Velocity Tracker
 * Pure client-side VBT using color blob tracking + camera.
 */

(() => {
  'use strict';

  // ---------- State ----------
  const state = {
    stream: null,
    tracking: false,
    samplingColor: false,
    // HSV target (more robust than RGB under changing light)
    targetHSV: { h: 30, s: 0.75, v: 0.85 }, // default orange-ish
    targetColor: { r: 230, g: 120, b: 30 },  // for preview only
    hueTol: 25,        // degrees (±)
    satMin: 0.25,      // ignore gray/washed pixels
    valMin: 0.15,
    valMax: 1.0,
    minBlob: 40,       // lower default so small markers work
    scale: null, // meters per pixel (set after calibration)
    markerDiameterCm: 5.0,
    unit: 'metric',
    exercise: 'squat',
    loadKg: 100,
    targetVel: 0.5,
    velLossCutoff: 20,
    audioEnabled: true,

    // tracking buffers
    positions: [], // {t, y, x} in meters relative
    lastPos: null,
    lastTime: 0,
    velocity: 0,
    trajectory: [],

    // rep detection
    phase: 'idle', // idle | ecc | conc
    currentRep: null,
    reps: [],
    bestMean: 0,
    setActive: false,

    // calibration
    calibrated: false,
    blobRadiusPx: 0,

    // debug
    lastMatchCount: 0,
  };

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    splash: $('#splash'),
    setup: $('#setup'),
    tracker: $('#tracker'),
  };
  const video = $('#video');
  const overlay = $('#overlay');
  const ctx = overlay.getContext('2d');

  // ---------- Helpers ----------
  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // ---------- Audio (simple beeps) ----------
  let audioCtx = null;
  function beep(freq = 880, duration = 0.08, type = 'sine') {
    if (!state.audioEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + duration);
    } catch (_) {}
  }

  // ---------- Color tracking (HSV — robust for orange/green) ----------
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        case b: h = ((r - g) / d + 4); break;
      }
      h *= 60;
    }
    return { h, s, v };
  }

  function hueDist(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
  }

  function matchesTarget(r, g, b) {
    const { h, s, v } = rgbToHsv(r, g, b);
    if (s < state.satMin || v < state.valMin || v > state.valMax) return false;
    return hueDist(h, state.targetHSV.h) <= state.hueTol;
  }

  function findBlob(imageData, width, height) {
    const data = imageData.data;
    let sumX = 0, sumY = 0, count = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;

    // Sample every 2nd pixel for mobile performance
    const step = 2;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (matchesTarget(r, g, b)) {
          sumX += x;
          sumY += y;
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    state.lastMatchCount = count;
    if (count < state.minBlob / (step * step)) return null;

    const cx = sumX / count;
    const cy = sumY / count;
    const radius = Math.max(maxX - minX, maxY - minY) / 2;
    return { x: cx, y: cy, radius, count };
  }

  // ---------- Calibration & scale ----------
  function updateScale(blob) {
    if (!blob || blob.radius < 5) return;
    // Marker diameter in meters / diameter in pixels
    const diameterM = state.markerDiameterCm / 100;
    state.scale = diameterM / (blob.radius * 2);
    state.blobRadiusPx = blob.radius;
    state.calibrated = true;
  }

  // ---------- Velocity & rep logic ----------
  function processPosition(blob, now) {
    if (!state.scale) return;

    // Convert to meters. Origin at top of frame, positive y downward in image → flip for physical up.
    const yM = blob.y * state.scale; // distance from top
    const xM = blob.x * state.scale;

    const pos = { t: now, y: yM, x: xM, px: blob.x, py: blob.y };

    if (state.lastPos && state.lastTime) {
      const dt = (now - state.lastTime) / 1000;
      if (dt > 0.008 && dt < 0.2) {
        // Vertical velocity: negative dy means moving up (concentric for most lifts)
        const dy = state.lastPos.y - yM; // positive when bar rises
        state.velocity = dy / dt; // m/s upward positive
      }
    }

    state.lastPos = pos;
    state.lastTime = now;
    state.positions.push(pos);
    if (state.positions.length > 300) state.positions.shift();

    // Keep trajectory for drawing
    state.trajectory.push({ x: blob.x, y: blob.y });
    if (state.trajectory.length > 120) state.trajectory.shift();

    if (state.setActive) detectRep(pos);
  }

  function detectRep(pos) {
    // Simple state machine based on vertical direction + extrema
    // For squat/deadlift/bench: concentric = upward (negative image y change)
    const vel = state.velocity;
    const threshold = 0.08; // m/s noise floor

    if (state.phase === 'idle') {
      if (vel < -threshold) { // starting to go down (eccentric)
        state.phase = 'ecc';
        state.currentRep = {
          startT: pos.t,
          minY: pos.y,
          maxY: pos.y,
          positions: [pos],
          peakVel: 0,
        };
      }
    } else if (state.phase === 'ecc') {
      state.currentRep.positions.push(pos);
      if (pos.y > state.currentRep.maxY) state.currentRep.maxY = pos.y; // deeper
      if (vel > threshold) { // turned around → concentric
        state.phase = 'conc';
        state.currentRep.concStartT = pos.t;
        state.currentRep.concStartY = pos.y;
      }
    } else if (state.phase === 'conc') {
      state.currentRep.positions.push(pos);
      if (pos.y < state.currentRep.minY) state.currentRep.minY = pos.y;
      if (vel > state.currentRep.peakVel) state.currentRep.peakVel = vel;

      // End of concentric when velocity drops near zero or starts going down again
      if (vel < threshold * 0.5 && (pos.t - state.currentRep.concStartT) > 150) {
        finishRep(pos);
      }
    }
  }

  function finishRep(pos) {
    const r = state.currentRep;
    if (!r || !r.concStartT) {
      state.phase = 'idle';
      state.currentRep = null;
      return;
    }

    const concPositions = r.positions.filter(p => p.t >= r.concStartT);
    if (concPositions.length < 4) {
      state.phase = 'idle';
      state.currentRep = null;
      return;
    }

    const duration = (pos.t - r.concStartT) / 1000;
    const displacement = r.concStartY - Math.min(...concPositions.map(p => p.y)); // upward distance
    if (displacement < 0.05 || duration < 0.15) { // ignore tiny/noise
      state.phase = 'idle';
      state.currentRep = null;
      return;
    }

    const meanVel = displacement / duration;
    const peakVel = r.peakVel || meanVel;

    const rep = {
      index: state.reps.length + 1,
      meanVel,
      peakVel,
      rom: displacement,
      duration,
      timestamp: Date.now(),
    };

    state.reps.push(rep);
    if (meanVel > state.bestMean) state.bestMean = meanVel;

    // Audio feedback
    const loss = state.bestMean > 0 ? ((state.bestMean - meanVel) / state.bestMean) * 100 : 0;
    if (loss >= state.velLossCutoff) {
      beep(220, 0.25, 'square'); // cutoff warning
    } else if (meanVel >= state.targetVel * 0.95) {
      beep(880, 0.07);
    } else {
      beep(440, 0.1);
    }

    state.phase = 'idle';
    state.currentRep = null;
    updateHUD();
  }

  // ---------- Rendering ----------
  function drawOverlay(blob) {
    const w = overlay.width;
    const h = overlay.height;
    ctx.clearRect(0, 0, w, h);

    // Trajectory
    if (state.trajectory.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.55)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      state.trajectory.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }

    if (blob) {
      // Tracking circle
      ctx.beginPath();
      ctx.arc(blob.x, blob.y, Math.max(blob.radius, 12), 0, Math.PI * 2);
      ctx.strokeStyle = state.tracking ? '#22c55e' : '#22d3ee';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Center crosshair
      ctx.beginPath();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      const s = 8;
      ctx.moveTo(blob.x - s, blob.y);
      ctx.lineTo(blob.x + s, blob.y);
      ctx.moveTo(blob.x, blob.y - s);
      ctx.lineTo(blob.x, blob.y + s);
      ctx.stroke();

      // Live velocity arrow (up = positive)
      if (state.tracking && Math.abs(state.velocity) > 0.05) {
        const arrowLen = clamp(state.velocity * 40, -60, 60);
        ctx.beginPath();
        ctx.strokeStyle = state.velocity > 0 ? '#22c55e' : '#f59e0b';
        ctx.lineWidth = 3;
        ctx.moveTo(blob.x + blob.radius + 16, blob.y);
        ctx.lineTo(blob.x + blob.radius + 16, blob.y - arrowLen);
        ctx.stroke();
      }
    }

    // Status / calibration hints
    ctx.font = '13px Inter, system-ui, sans-serif';
    if (blob) {
      if (!state.calibrated) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(10, h - 50, 230, 36);
        ctx.fillStyle = '#22c55e';
        ctx.fillText('Marker locked — calibrating scale…', 20, h - 28);
      }
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(10, h - 50, 280, 36);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('No marker — tap Color then tap the ball', 20, h - 28);
    }
  }

  function updateHUD() {
    const unit = state.unit === 'metric' ? 'm/s' : 'ft/s';
    const factor = state.unit === 'metric' ? 1 : 3.28084;

    const live = Math.abs(state.velocity) * factor;
    $('#live-vel').textContent = live.toFixed(2);
    $('#vel-unit').textContent = unit;

    const statusEl = $('#vel-status');
    if (!state.tracking) {
      statusEl.textContent = state.calibrated ? 'Ready' : 'Calibrating';
      statusEl.className = 'vel-status';
    } else if (state.phase === 'conc') {
      statusEl.textContent = 'Concentric';
      statusEl.className = 'vel-status good';
    } else if (state.phase === 'ecc') {
      statusEl.textContent = 'Eccentric';
      statusEl.className = 'vel-status';
    } else {
      statusEl.textContent = 'Tracking';
      statusEl.className = 'vel-status';
    }

    $('#hud-reps').textContent = state.reps.length;

    if (state.reps.length) {
      const last = state.reps[state.reps.length - 1];
      $('#hud-mean').textContent = (last.meanVel * factor).toFixed(2);
      $('#hud-peak').textContent = (last.peakVel * factor).toFixed(2);
      $('#hud-rom').textContent = (last.rom * (state.unit === 'metric' ? 100 : 39.37)).toFixed(1) + (state.unit === 'metric' ? ' cm' : ' in');

      const loss = state.bestMean > 0 ? ((state.bestMean - last.meanVel) / state.bestMean) * 100 : 0;
      $('#hud-loss').textContent = loss.toFixed(0) + '%';
      $('#loss-bar').style.width = clamp(loss, 0, 100) + '%';

      // Approx power: F ≈ m*g, P = F * v (mean)
      const mass = state.loadKg;
      const power = mass * 9.81 * last.meanVel;
      $('#hud-power').textContent = Math.round(power) + ' W';
    } else {
      $('#hud-mean').textContent = '—';
      $('#hud-peak').textContent = '—';
      $('#hud-rom').textContent = '—';
      $('#hud-loss').textContent = '—';
      $('#hud-power').textContent = '—';
      $('#loss-bar').style.width = '0%';
    }
  }

  // ---------- Main loop ----------
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!video.videoWidth) return;
    // Don't fight with color sampling mode
    if (state.samplingColor) return;

    // Match canvas size to video
    if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    }

    // Throttle processing a bit on low-end devices (~30 fps analysis)
    if (now - lastFrame < 28) return;
    lastFrame = now;

    const w = video.videoWidth;
    const h = video.videoHeight;
    ctx.drawImage(video, 0, 0, w, h);
    let blob = null;
    try {
      const imageData = ctx.getImageData(0, 0, w, h);
      blob = findBlob(imageData, w, h);
    } catch (e) {
      // Security or other issues (e.g. tainted canvas)
    }

    // Clear and redraw clean overlay only
    ctx.clearRect(0, 0, w, h);

    if (blob) {
      if (!state.calibrated || Math.abs(blob.radius - state.blobRadiusPx) > state.blobRadiusPx * 0.4) {
        updateScale(blob);
      }
      if (state.tracking) {
        processPosition(blob, now);
      }
    }

    drawOverlay(blob);
    if (state.tracking) updateHUD();
  }

  // ---------- Camera ----------
  async function startCamera() {
    try {
      if (state.stream) {
        state.stream.getTracks().forEach(t => t.stop());
      }
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      };
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = state.stream;
      await video.play();
      requestAnimationFrame(loop);
    } catch (err) {
      alert('Camera access failed. Please allow camera permissions and use HTTPS (or localhost).');
      console.error(err);
    }
  }

  // ---------- Color sampling ----------
  function enableColorSample() {
    state.samplingColor = true;
    $('#color-mode').classList.remove('hidden');
    overlay.style.pointerEvents = 'auto';
    // Make sure video is drawn so we can read pixels
    if (video.videoWidth) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
    }
  }

  function sampleColorAt(clientX, clientY) {
    if (!video.videoWidth) return;

    // Ensure canvas matches video resolution
    if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0, overlay.width, overlay.height);

    const rect = overlay.getBoundingClientRect();
    // object-fit: cover means we need to account for letterboxing/cropping
    const videoAspect = video.videoWidth / video.videoHeight;
    const viewAspect = rect.width / rect.height;
    let drawW, drawH, offsetX, offsetY;

    if (videoAspect > viewAspect) {
      // video is wider → cropped left/right
      drawH = rect.height;
      drawW = rect.height * videoAspect;
      offsetX = (rect.width - drawW) / 2;
      offsetY = 0;
    } else {
      // video is taller → cropped top/bottom
      drawW = rect.width;
      drawH = rect.width / videoAspect;
      offsetX = 0;
      offsetY = (rect.height - drawH) / 2;
    }

    const scaleX = video.videoWidth / drawW;
    const scaleY = video.videoHeight / drawH;
    const x = Math.floor((clientX - rect.left - offsetX) * scaleX);
    const y = Math.floor((clientY - rect.top - offsetY) * scaleY);

    if (x < 0 || y < 0 || x >= video.videoWidth || y >= video.videoHeight) {
      console.warn('Tap outside video area');
      return;
    }

    // Average a neighborhood for robustness
    let rSum = 0, gSum = 0, bSum = 0, n = 0;
    const rad = 8;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const px = clamp(x + dx, 0, video.videoWidth - 1);
        const py = clamp(y + dy, 0, video.videoHeight - 1);
        const d = ctx.getImageData(px, py, 1, 1).data;
        rSum += d[0]; gSum += d[1]; bSum += d[2]; n++;
      }
    }
    const r = Math.round(rSum / n);
    const g = Math.round(gSum / n);
    const b = Math.round(bSum / n);

    state.targetColor = { r, g, b };
    state.targetHSV = rgbToHsv(r, g, b);

    // Auto-tune tolerance a bit looser for the sampled color
    state.hueTol = 28;
    state.satMin = Math.max(0.15, state.targetHSV.s * 0.35);
    state.valMin = Math.max(0.12, state.targetHSV.v * 0.25);

    $('#color-preview').style.background = `rgb(${r},${g},${b})`;
    console.log('Sampled HSV:', state.targetHSV, 'RGB:', r, g, b);

    // Visual confirmation
    beep(720, 0.06);

    setTimeout(() => {
      state.samplingColor = false;
      $('#color-mode').classList.add('hidden');
      overlay.style.pointerEvents = 'none';
      state.calibrated = false; // force re-scale with new color
    }, 500);
  }

  // ---------- Set summary ----------
  function showSummary() {
    state.tracking = false;
    state.setActive = false;
    $('#track-label').textContent = 'Start Tracking';

    const factor = state.unit === 'metric' ? 1 : 3.28084;
    const reps = state.reps;

    $('#sum-reps').textContent = reps.length;
    if (reps.length === 0) {
      $('#sum-best').textContent = '—';
      $('#sum-avg').textContent = '—';
      $('#sum-loss').textContent = '—';
      $('#sum-peak').textContent = '—';
      $('#sum-rom').textContent = '—';
    } else {
      const best = Math.max(...reps.map(r => r.meanVel));
      const avg = reps.reduce((s, r) => s + r.meanVel, 0) / reps.length;
      const last = reps[reps.length - 1];
      const loss = best > 0 ? ((best - last.meanVel) / best) * 100 : 0;
      const peak = Math.max(...reps.map(r => r.peakVel));
      const avgRom = reps.reduce((s, r) => s + r.rom, 0) / reps.length;

      $('#sum-best').textContent = (best * factor).toFixed(2);
      $('#sum-avg').textContent = (avg * factor).toFixed(2);
      $('#sum-loss').textContent = loss.toFixed(0) + '%';
      $('#sum-peak').textContent = (peak * factor).toFixed(2);
      $('#sum-rom').textContent = (avgRom * (state.unit === 'metric' ? 100 : 39.37)).toFixed(1);
    }

    // Rep list
    const list = $('#rep-list');
    list.innerHTML = '';
    reps.forEach(r => {
      const div = document.createElement('div');
      div.className = 'rep-item';
      div.innerHTML = `
        <span class="rep-num">Rep ${r.index}</span>
        <span class="rep-vel">${(r.meanVel * factor).toFixed(2)} ${state.unit === 'metric' ? 'm/s' : 'ft/s'}</span>
        <span>${(r.rom * 100).toFixed(0)} cm</span>
      `;
      list.appendChild(div);
    });

    // Simple bar chart
    drawChart(reps, factor);

    $('#summary').classList.remove('hidden');
  }

  function drawChart(reps, factor) {
    const canvas = $('#summary-chart');
    const c = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    c.scale(dpr, dpr);
    c.clearRect(0, 0, w, h);

    if (reps.length === 0) return;

    const maxV = Math.max(...reps.map(r => r.meanVel * factor), state.targetVel * factor) * 1.15;
    const barW = Math.min(36, (w - 40) / reps.length - 8);
    const gap = 8;
    const startX = (w - (reps.length * (barW + gap) - gap)) / 2;

    // Target line
    const targetY = h - 30 - ((state.targetVel * factor) / maxV) * (h - 50);
    c.strokeStyle = 'rgba(34, 197, 94, 0.5)';
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(20, targetY);
    c.lineTo(w - 20, targetY);
    c.stroke();
    c.setLineDash([]);

    reps.forEach((r, i) => {
      const v = r.meanVel * factor;
      const bh = (v / maxV) * (h - 50);
      const x = startX + i * (barW + gap);
      const y = h - 30 - bh;
      const loss = state.bestMean > 0 ? ((state.bestMean - r.meanVel) / state.bestMean) * 100 : 0;
      c.fillStyle = loss >= state.velLossCutoff ? '#ef4444' : '#22c55e';
      c.beginPath();
      c.roundRect(x, y, barW, bh, 4);
      c.fill();
      c.fillStyle = '#a1a1aa';
      c.font = '11px Inter';
      c.textAlign = 'center';
      c.fillText(String(r.index), x + barW / 2, h - 12);
    });
  }

  // ---------- Persistence ----------
  function saveSession() {
    const sessions = JSON.parse(localStorage.getItem('bv_sessions') || '[]');
    sessions.unshift({
      date: new Date().toISOString(),
      exercise: state.exercise,
      loadKg: state.loadKg,
      reps: state.reps,
      bestMean: state.bestMean,
    });
    if (sessions.length > 50) sessions.length = 50;
    localStorage.setItem('bv_sessions', JSON.stringify(sessions));
    renderSessionList();
  }

  function renderSessionList() {
    const sessions = JSON.parse(localStorage.getItem('bv_sessions') || '[]');
    const el = $('#session-list');
    el.innerHTML = '';
    if (!sessions.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No saved sets yet.</p>';
      return;
    }
    sessions.slice(0, 10).forEach(s => {
      const div = document.createElement('div');
      div.className = 'session-item';
      const d = new Date(s.date);
      div.innerHTML = `
        <div class="ex">${s.exercise} · ${s.loadKg} kg</div>
        <div class="meta">${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · ${s.reps.length} reps · best ${(s.bestMean || 0).toFixed(2)} m/s</div>
      `;
      el.appendChild(div);
    });
  }

  // ---------- Event listeners ----------
  $('#btn-start').addEventListener('click', () => showScreen('setup'));
  $('#btn-back-setup').addEventListener('click', () => showScreen('splash'));

  $('#btn-open-camera').addEventListener('click', async () => {
    state.markerDiameterCm = parseFloat($('#marker-diameter').value) || 5;
    state.unit = $('#unit-pref').value;
    state.exercise = $('#exercise').value;
    state.loadKg = parseFloat($('#load').value) || 100;
    if (state.unit === 'imperial') {
      // convert lb to kg for power calc
      state.loadKg = state.loadKg * 0.453592;
    }
    state.targetVel = parseFloat($('#target-vel').value) || 0.5;
    state.velLossCutoff = parseFloat($('#vel-loss').value) || 20;
    $('#load-unit').textContent = state.unit === 'metric' ? 'kg' : 'lb';
    showScreen('tracker');
    await startCamera();
  });

  $('#btn-toggle-track').addEventListener('click', () => {
    if (!state.calibrated) {
      alert('Point the camera at the marker so it is clearly visible. Scale will calibrate automatically.');
      return;
    }
    state.tracking = !state.tracking;
    state.setActive = state.tracking;
    if (state.tracking) {
      state.reps = [];
      state.bestMean = 0;
      state.phase = 'idle';
      state.currentRep = null;
      state.positions = [];
      state.trajectory = [];
      $('#track-label').textContent = 'Stop';
      beep(660, 0.05);
    } else {
      $('#track-label').textContent = 'Start Tracking';
    }
    updateHUD();
  });

  $('#btn-end-set').addEventListener('click', () => {
    if (state.reps.length || state.tracking) {
      showSummary();
    }
  });

  $('#btn-sample-color').addEventListener('click', enableColorSample);
  $('#btn-cancel-sample').addEventListener('click', () => {
    state.samplingColor = false;
    $('#color-mode').classList.add('hidden');
    overlay.style.pointerEvents = 'none';
  });

  overlay.addEventListener('click', (e) => {
    if (state.samplingColor) sampleColorAt(e.clientX, e.clientY);
  });
  overlay.addEventListener('touchstart', (e) => {
    if (state.samplingColor && e.touches[0]) {
      e.preventDefault();
      sampleColorAt(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  $('#btn-new-set').addEventListener('click', () => {
    $('#summary').classList.add('hidden');
    state.reps = [];
    state.bestMean = 0;
    state.phase = 'idle';
    updateHUD();
  });

  $('#btn-save-session').addEventListener('click', () => {
    saveSession();
    $('#summary').classList.add('hidden');
    state.reps = [];
    state.bestMean = 0;
    updateHUD();
  });

  $('#btn-settings').addEventListener('click', () => {
    renderSessionList();
    $('#drawer').classList.remove('hidden');
  });
  $('#btn-close-drawer').addEventListener('click', () => {
    $('#drawer').classList.add('hidden');
  });
  $('#drawer').addEventListener('click', (e) => {
    if (e.target === $('#drawer')) $('#drawer').classList.add('hidden');
  });

  $('#audio-enabled').addEventListener('change', (e) => {
    state.audioEnabled = e.target.checked;
  });
  $('#min-blob').addEventListener('input', (e) => {
    state.minBlob = parseInt(e.target.value, 10);
  });
  $('#hue-tol').addEventListener('input', (e) => {
    state.hueTol = parseInt(e.target.value, 10);
  });
  $('#sat-min').addEventListener('input', (e) => {
    state.satMin = parseInt(e.target.value, 10) / 100;
  });
  $('#btn-clear-history').addEventListener('click', () => {
    if (confirm('Clear all saved sessions?')) {
      localStorage.removeItem('bv_sessions');
      renderSessionList();
    }
  });

  // Unit label sync
  $('#unit-pref').addEventListener('change', () => {
    $('#load-unit').textContent = $('#unit-pref').value === 'metric' ? 'kg' : 'lb';
  });

  // Prevent pull-to-refresh etc.
  document.addEventListener('touchmove', (e) => {
    if (e.target.closest('.setup-scroll, .drawer-body, .modal-sheet')) return;
    e.preventDefault();
  }, { passive: false });

  // Kick off
  showScreen('splash');
})();
