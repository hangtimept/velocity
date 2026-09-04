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
    targetColor: { r: 50, g: 200, b: 50 }, // default neon green
    colorTol: 45,
    minBlob: 80,
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

  // ---------- Color tracking ----------
  function colorDistance(r, g, b, tr, tg, tb) {
    return Math.sqrt((r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2);
  }

  function findBlob(imageData, width, height) {
    const data = imageData.data;
    const tol = state.colorTol;
    const tr = state.targetColor.r;
    const tg = state.targetColor.g;
    const tb = state.targetColor.b;

    let sumX = 0, sumY = 0, count = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;

    // Sample every 2nd pixel for performance on mobile
    const step = 2;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (colorDistance(r, g, b, tr, tg, tb) < tol) {
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

    // Calibration hint
    if (!state.calibrated && blob) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(10, h - 50, 220, 36);
      ctx.fillStyle = '#fff';
      ctx.font = '13px Inter, sans-serif';
      ctx.fillText('Calibrating scale… hold still', 20, h - 28);
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

    // Match canvas size to video
    if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    }

    // Throttle processing a bit on low-end devices (~30 fps analysis)
    if (now - lastFrame < 28) {
      // still redraw trajectory if needed
      return;
    }
    lastFrame = now;

    // Draw current frame to temp canvas for pixel access
    const w = video.videoWidth;
    const h = video.videoHeight;
    ctx.drawImage(video, 0, 0, w, h);
    let blob = null;
    try {
      const imageData = ctx.getImageData(0, 0, w, h);
      blob = findBlob(imageData, w, h);
    } catch (e) {
      // Security or other issues
    }

    // Clear and redraw clean overlay
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
  }

  function sampleColorAt(clientX, clientY) {
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;
    const x = Math.floor((clientX - rect.left) * scaleX);
    const y = Math.floor((clientY - rect.top) * scaleY);

    ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    state.targetColor = { r: pixel[0], g: pixel[1], b: pixel[2] };
    $('#color-preview').style.background = `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`;

    // Average a small neighborhood for robustness
    let r = 0, g = 0, b = 0, n = 0;
    const rad = 6;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const px = clamp(x + dx, 0, overlay.width - 1);
        const py = clamp(y + dy, 0, overlay.height - 1);
        const d = ctx.getImageData(px, py, 1, 1).data;
        r += d[0]; g += d[1]; b += d[2]; n++;
      }
    }
    state.targetColor = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    $('#color-preview').style.background = `rgb(${state.targetColor.r},${state.targetColor.g},${state.targetColor.b})`;

    setTimeout(() => {
      state.samplingColor = false;
      $('#color-mode').classList.add('hidden');
      overlay.style.pointerEvents = 'none';
      state.calibrated = false; // force re-scale
    }, 600);
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
  $('#color-tol').addEventListener('input', (e) => {
    state.colorTol = parseInt(e.target.value, 10);
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
