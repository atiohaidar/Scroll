/**
 * Scroll Mobile Touchpad Engine
 * High-precision multi-touch gesture processing with sub-5ms WebRTC UDP transmission.
 */

(function () {
  'use strict';

  // DOM Elements
  const trackpad = document.getElementById('trackpad');
  const touchOverlay = document.getElementById('touch-overlay');
  const watermark = document.getElementById('watermark');
  const statusIndicator = document.getElementById('status-indicator');
  const statusLabel = document.getElementById('status-label');
  const latencyLabel = document.getElementById('latency-label');
  const gestureModeBadge = document.getElementById('gesture-mode');
  const btnResetZoom = document.getElementById('btn-reset-zoom');
  const btnHaptic = document.getElementById('btn-haptic');
  const speedButtons = document.querySelectorAll('.speed-btn');
  const pairModal = document.getElementById('pair-modal');
  const manualCodeInput = document.getElementById('manual-code');
  const btnManualConnect = document.getElementById('btn-manual-connect');

  // State
  let peer = null;
  let conn = null;
  let targetPeerId = null;
  let isConnected = false;
  let hapticEnabled = true;
  let speedMultiplier = 1.4;
  let currentZoomScale = 1.0;

  // Active touches map: identifier -> { x, y, lastX, lastY, vx, vy, time }
  const activeTouches = new Map();
  let initialPinchDistance = 0;
  let lastPinchDistance = 0;

  // Momentum loop state
  let momentumRaf = null;
  let momentumVx = 0;
  let momentumVy = 0;

  // Haptic helper
  function triggerHaptic(duration = 6) {
    if (hapticEnabled && navigator.vibrate) {
      try {
        navigator.vibrate(duration);
      } catch (e) {}
    }
  }

  // --- Network & WebRTC Connection ---

  function parseTargetPeerId() {
    const params = new URLSearchParams(window.location.search);
    const peerParam = params.get('peer');
    if (peerParam) {
      return peerParam.trim();
    }
    return localStorage.getItem('scroll_last_peer') || null;
  }

  function initWebRTC(peerId) {
    if (!peerId) {
      showPairModal();
      return;
    }

    targetPeerId = peerId;
    localStorage.setItem('scroll_last_peer', peerId);
    hidePairModal();

    updateStatus('connecting', 'Connecting...');

    if (peer && !peer.destroyed) {
      peer.destroy();
    }

    try {
      peer = new Peer({
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      peer.on('open', (myId) => {
        console.log('[Touchpad] Mobile peer open:', myId);
        connectToBrowser(targetPeerId);
      });

      peer.on('error', (err) => {
        console.warn('[Touchpad] Peer error:', err);
        updateStatus('disconnected', 'Error: ' + (err.type || 'Connection failed'));
        // Retry in 3 seconds
        setTimeout(() => {
          if (!isConnected && targetPeerId) {
            connectToBrowser(targetPeerId);
          }
        }, 3000);
      });

    } catch (e) {
      console.error('[Touchpad] Peer init exception:', e);
      updateStatus('disconnected', 'Failed to start');
    }
  }

  function connectToBrowser(destId) {
    if (!peer || peer.destroyed) return;

    console.log('[Touchpad] Connecting to browser peer:', destId);
    updateStatus('connecting', 'Handshaking...');

    try {
      conn = peer.connect(destId, {
        reliable: false // Ultra low-latency UDP unordered mode
      });

      conn.on('open', () => {
        console.log('[Touchpad] WebRTC DataChannel OPEN! Connected directly to browser.');
        isConnected = true;
        updateStatus('connected', 'Connected');
        triggerHaptic(20);
      });

      conn.on('data', (packet) => {
        if (!packet || !Array.isArray(packet)) return;
        const type = packet[0];

        if (type === 'ping') {
          // Reply with pong for RTT
          if (conn && conn.open) {
            conn.send(['pong', packet[1]]);
          }
        } else if (type === 'latency') {
          latencyLabel.textContent = `${packet[1]} ms`;
        }
      });

      conn.on('close', () => {
        console.log('[Touchpad] Connection closed');
        isConnected = false;
        updateStatus('disconnected', 'Disconnected');
        // Auto-reconnect
        setTimeout(() => {
          if (targetPeerId) connectToBrowser(targetPeerId);
        }, 2000);
      });

      conn.on('error', (err) => {
        console.warn('[Touchpad] Conn error:', err);
        isConnected = false;
        updateStatus('disconnected', 'Conn error');
      });

    } catch (e) {
      console.error('[Touchpad] Exception connecting:', e);
      updateStatus('disconnected', 'Failed');
    }
  }

  function sendPacket(data) {
    if (conn && conn.open) {
      conn.send(data);
    }
  }

  function updateStatus(state, label) {
    statusIndicator.className = 'status-dot ' + state;
    statusLabel.textContent = label;
  }

  // --- Touch & Gesture Engine ---

  trackpad.addEventListener('touchstart', onTouchStart, { passive: false });
  trackpad.addEventListener('touchmove', onTouchMove, { passive: false });
  trackpad.addEventListener('touchend', onTouchEnd, { passive: false });
  trackpad.addEventListener('touchcancel', onTouchEnd, { passive: false });

  function onTouchStart(e) {
    e.preventDefault();

    // Cancel running momentum instantly upon finger contact
    cancelMomentum();

    const now = performance.now();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      activeTouches.set(t.identifier, {
        x: t.clientX,
        y: t.clientY,
        lastX: t.clientX,
        lastY: t.clientY,
        startX: t.clientX,
        startY: t.clientY,
        vx: 0,
        vy: 0,
        time: now
      });
    }

    if (activeTouches.size > 0 && watermark) {
      watermark.classList.add('hidden');
    }

    if (activeTouches.size === 2) {
      // Initialize 2-finger pinch
      const touches = Array.from(activeTouches.values());
      initialPinchDistance = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y);
      lastPinchDistance = initialPinchDistance;
      gestureModeBadge.textContent = 'Pinch Zoom';
      triggerHaptic(8);
    } else if (activeTouches.size === 1) {
      gestureModeBadge.textContent = '1-Finger Pan';
    }

    renderVisualizers();
  }

  function onTouchMove(e) {
    e.preventDefault();

    const now = performance.now();

    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const entry = activeTouches.get(t.identifier);
      if (entry) {
        const dt = Math.max(1, now - entry.time);
        const dx = t.clientX - entry.x;
        const dy = t.clientY - entry.y;

        // Exponential moving average for velocity calculation
        entry.vx = entry.vx * 0.4 + (dx / dt) * 0.6;
        entry.vy = entry.vy * 0.4 + (dy / dt) * 0.6;

        entry.lastX = entry.x;
        entry.lastY = entry.y;
        entry.x = t.clientX;
        entry.y = t.clientY;
        entry.time = now;
      }
    }

    // 1-Finger Mode: 2D Omnidirectional Pan
    if (activeTouches.size === 1) {
      const t = activeTouches.values().next().value;
      const dx = (t.x - t.lastX) * speedMultiplier;
      const dy = (t.y - t.lastY) * speedMultiplier;

      // Natural drag: dragging up moves page down or up depending on natural config
      sendPacket(['pan', dx, dy]);
    }
    // 2-Finger Mode: Pinch-to-Zoom
    else if (activeTouches.size === 2) {
      const touches = Array.from(activeTouches.values());
      const currentDist = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y);
      const distDelta = currentDist - lastPinchDistance;

      if (Math.abs(distDelta) > 0.4) {
        // Normalized zoom delta (smooth & proportional)
        const delta = (distDelta / 140) * speedMultiplier;

        const prevScale = currentZoomScale;
        currentZoomScale = Math.min(Math.max(currentZoomScale * (1 + delta), 1.0), 5.0);

        // Haptic feedback when crossing 100% boundary
        if ((prevScale <= 1.02 && currentZoomScale > 1.02) || (prevScale >= 1.02 && currentZoomScale <= 1.02)) {
          triggerHaptic(18);
        }

        sendPacket(['zoom', delta, currentZoomScale]);
        lastPinchDistance = currentDist;
      }
    }

    renderVisualizers();
  }

  function onTouchEnd(e) {
    e.preventDefault();

    let lastReleasedEntry = null;

    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (activeTouches.has(t.identifier)) {
        lastReleasedEntry = activeTouches.get(t.identifier);
        activeTouches.delete(t.identifier);
      }
    }

    if (activeTouches.size === 0) {
      gestureModeBadge.textContent = 'Ready';
      if (watermark) watermark.classList.remove('hidden');

      // Trigger momentum fling if velocity is substantial
      if (lastReleasedEntry) {
        const speed = Math.hypot(lastReleasedEntry.vx, lastReleasedEntry.vy);
        if (speed > 0.4) {
          startMomentum(lastReleasedEntry.vx * 16 * speedMultiplier, lastReleasedEntry.vy * 16 * speedMultiplier);
        }
      }
    } else if (activeTouches.size === 1) {
      gestureModeBadge.textContent = '1-Finger Pan';
    }

    renderVisualizers();
  }

  // --- Momentum Physics ---

  function startMomentum(vx, vy) {
    cancelMomentum();
    momentumVx = vx;
    momentumVy = vy;

    function step() {
      // Friction coefficient (0.94 creates authentic Apple Magic Trackpad glide)
      momentumVx *= 0.94;
      momentumVy *= 0.94;

      if (Math.hypot(momentumVx, momentumVy) < 0.25) {
        momentumRaf = null;
        return;
      }

      sendPacket(['pan', momentumVx, momentumVy]);
      momentumRaf = requestAnimationFrame(step);
    }

    momentumRaf = requestAnimationFrame(step);
  }

  function cancelMomentum() {
    if (momentumRaf) {
      cancelAnimationFrame(momentumRaf);
      momentumRaf = null;
    }
  }

  // --- Visual Feedback Rendering (Ripples & Pinch Line) ---

  function renderVisualizers() {
    touchOverlay.innerHTML = '';

    const touches = Array.from(activeTouches.values());

    // Render individual touch rings
    for (const t of touches) {
      const ring = document.createElement('div');
      ring.className = 'touch-ring';
      ring.style.left = `${t.x}px`;
      ring.style.top = `${t.y}px`;

      const core = document.createElement('div');
      core.className = 'touch-ring-core';
      ring.appendChild(core);

      touchOverlay.appendChild(ring);
    }

    // Render 2-finger pinch line and distance badge
    if (touches.length === 2) {
      const [t1, t2] = touches;
      const midX = (t1.x + t2.x) / 2;
      const midY = (t1.y + t2.y) / 2;
      const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      const angle = Math.atan2(t2.y - t1.y, t2.x - t1.x);

      const line = document.createElement('div');
      line.className = 'pinch-line';
      line.style.left = `${t1.x}px`;
      line.style.top = `${t1.y}px`;
      line.style.width = `${dist}px`;
      line.style.transform = `rotate(${angle}rad)`;
      touchOverlay.appendChild(line);

      const badge = document.createElement('div');
      badge.className = 'pinch-badge';
      badge.style.left = `${midX}px`;
      badge.style.top = `${midY}px`;
      badge.textContent = `${Math.round(currentZoomScale * 100)}%`;
      touchOverlay.appendChild(badge);
    }
  }

  // --- UI Controls ---

  // Reset Zoom
  btnResetZoom.addEventListener('click', () => {
    currentZoomScale = 1.0;
    sendPacket(['reset_zoom']);
    triggerHaptic(15);
  });

  // Toggle Haptic
  btnHaptic.addEventListener('click', () => {
    hapticEnabled = !hapticEnabled;
    btnHaptic.classList.toggle('active', hapticEnabled);
    if (hapticEnabled) triggerHaptic(20);
  });

  // Speed Presets
  speedButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      speedButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      speedMultiplier = parseFloat(btn.dataset.speed);
      triggerHaptic(6);
    });
  });

  // Manual Pairing Modal
  function showPairModal() {
    pairModal.classList.remove('hidden');
    manualCodeInput.focus();
  }

  function hidePairModal() {
    pairModal.classList.add('hidden');
  }

  btnManualConnect.addEventListener('click', () => {
    const val = manualCodeInput.value.trim().toLowerCase();
    if (!val) return;
    const fullId = val.startsWith('scr-') ? val : `scr-${val}`;
    initWebRTC(fullId);
  });

  manualCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnManualConnect.click();
    }
  });

  // Start initialization
  const initialPeer = parseTargetPeerId();
  initWebRTC(initialPeer);

})();
