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
  const btnScrollDir = document.getElementById('btn-scroll-dir');
  const scrollDirText = document.getElementById('scroll-dir-text');
  const btnResetZoom = document.getElementById('btn-reset-zoom');
  const btnHaptic = document.getElementById('btn-haptic');
  const speedButtons = document.querySelectorAll('.speed-btn');
  const pairModal = document.getElementById('pair-modal');
  const manualCodeInput = document.getElementById('manual-code');
  const btnManualConnect = document.getElementById('btn-manual-connect');

  // Tab Manager Elements
  const btnTabs = document.getElementById('btn-tabs');
  const tabCountBadge = document.getElementById('tab-count-badge');
  const tabsStrip = document.getElementById('tabs-strip');
  const tabsStripList = document.getElementById('tabs-strip-list');
  const btnNewTabStrip = document.getElementById('btn-new-tab-strip');
  const tabsDrawer = document.getElementById('tabs-drawer');
  const drawerCount = document.getElementById('drawer-count');
  const drawerTabsList = document.getElementById('drawer-tabs-list');
  const btnNewTabDrawer = document.getElementById('btn-new-tab-drawer');
  const btnCloseDrawer = document.getElementById('btn-close-drawer');

  // State
  let peer = null;
  let conn = null;
  let targetPeerId = null;
  let isConnected = false;
  let hapticEnabled = true;
  let speedMultiplier = 1.4;
  let currentZoomScale = 1.0;
  let openTabs = [];
  let isNaturalScroll = localStorage.getItem('scroll_natural') !== '0'; // default true

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

  // Update Natural Scroll UI state
  function updateScrollDirUI() {
    if (scrollDirText) {
      scrollDirText.textContent = isNaturalScroll ? 'Nat ↕' : 'Wheel ↕';
    }
    if (btnScrollDir) {
      if (isNaturalScroll) {
        btnScrollDir.classList.add('active');
        btnScrollDir.title = 'Scroll: Natural (Finger moves content)';
      } else {
        btnScrollDir.classList.remove('active');
        btnScrollDir.title = 'Scroll: Wheel / Inverted (Traditional)';
      }
    }
  }
  updateScrollDirUI();

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
        sendPacket(['request_tabs']);
        sendPacket(['request_settings']);
        sendPacket(['set_natural_scroll', isNaturalScroll]);
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
        } else if (type === 'tabs') {
          openTabs = packet[1] || [];
          renderTabsUI(openTabs);
        } else if (type === 'settings') {
          const s = packet[1];
          if (s && s.naturalScroll !== undefined) {
            isNaturalScroll = !!s.naturalScroll;
            localStorage.setItem('scroll_natural', isNaturalScroll ? '1' : '0');
            updateScrollDirUI();
          }
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

    // 1-Finger Mode: 2D Omnidirectional Pan with Modern Trackpad Ballistics
    if (activeTouches.size === 1) {
      const t = activeTouches.values().next().value;
      const rawDx = t.x - t.lastX;
      const rawDy = t.y - t.lastY;

      // Trackpad Ballistics Curve: Precision at low speeds, swift distance on natural swipes
      const dist = Math.hypot(rawDx, rawDy);
      const accel = 1.0 + Math.min(dist * 0.07, 2.6);
      const gain = 2.0 * speedMultiplier;

      const dx = rawDx * accel * gain;
      const dy = rawDy * accel * gain;

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
        currentZoomScale = Math.min(Math.max(currentZoomScale * (1 + delta), 1.0), 4.0);

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

      // Authentic Trackpad Momentum: Fling with silky deceleration
      if (lastReleasedEntry) {
        const speed = Math.hypot(lastReleasedEntry.vx, lastReleasedEntry.vy);
        // Low threshold so natural flick always glides
        if (speed > 0.08) {
          const impulse = Math.min(speed * 28 * speedMultiplier, 95);
          const angle = Math.atan2(lastReleasedEntry.vy, lastReleasedEntry.vx);
          const initVx = Math.cos(angle) * impulse;
          const initVy = Math.sin(angle) * impulse;
          startMomentum(initVx, initVy);
        }
      }
    } else if (activeTouches.size === 1) {
      gestureModeBadge.textContent = '1-Finger Pan';
    }

    renderVisualizers();
  }

  // --- Modern Trackpad Momentum Physics ---

  function startMomentum(vx, vy) {
    cancelMomentum();
    momentumVx = vx;
    momentumVy = vy;

    function step() {
      // 0.955 friction constant matches Windows Precision Touchpad / DirectManipulation glide
      momentumVx *= 0.955;
      momentumVy *= 0.955;

      if (Math.hypot(momentumVx, momentumVy) < 0.18) {
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

  // Default globe favicon SVG for tabs without icon
  const DEFAULT_FAVICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%238E8E93" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

  function renderTabsUI(tabs) {
    if (!Array.isArray(tabs)) return;

    // Badges
    if (tabCountBadge) tabCountBadge.textContent = tabs.length;
    if (drawerCount) drawerCount.textContent = `${tabs.length} open tab${tabs.length === 1 ? '' : 's'}`;

    // Render Quick Strip
    if (tabsStripList) {
      tabsStripList.innerHTML = '';
      tabs.forEach(tab => {
        const pill = document.createElement('div');
        pill.className = `tab-strip-pill ${tab.active ? 'active' : ''}`;
        pill.title = tab.title;

        const img = document.createElement('img');
        img.className = 'tab-strip-favicon';
        img.src = tab.favIconUrl || DEFAULT_FAVICON;
        img.onerror = () => { img.src = DEFAULT_FAVICON; };
        pill.appendChild(img);

        const span = document.createElement('span');
        span.className = 'tab-strip-title';
        span.textContent = tab.title || 'Untitled';
        pill.appendChild(span);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-strip-close';
        closeBtn.innerHTML = '&#215;';
        closeBtn.title = 'Close Tab';
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          sendPacket(['close_tab', tab.id]);
          triggerHaptic(8);
        };
        pill.appendChild(closeBtn);

        pill.onclick = () => {
          sendPacket(['switch_tab', tab.id]);
          triggerHaptic(12);
        };

        tabsStripList.appendChild(pill);
      });
    }

    // Render Expanded Drawer List
    if (drawerTabsList) {
      drawerTabsList.innerHTML = '';
      tabs.forEach(tab => {
        const item = document.createElement('div');
        item.className = `drawer-item ${tab.active ? 'active' : ''}`;

        const img = document.createElement('img');
        img.className = 'drawer-item-fav';
        img.src = tab.favIconUrl || DEFAULT_FAVICON;
        img.onerror = () => { img.src = DEFAULT_FAVICON; };
        item.appendChild(img);

        const info = document.createElement('div');
        info.className = 'drawer-item-info';

        const title = document.createElement('span');
        title.className = 'drawer-item-title';
        title.textContent = tab.title || 'Untitled';
        info.appendChild(title);

        if (tab.url) {
          const urlSpan = document.createElement('span');
          urlSpan.className = 'drawer-item-url';
          try {
            const parsed = new URL(tab.url);
            urlSpan.textContent = parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname);
          } catch (e) {
            urlSpan.textContent = tab.url;
          }
          info.appendChild(urlSpan);
        }

        item.appendChild(info);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'drawer-item-close';
        closeBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        `;
        closeBtn.title = 'Close tab';
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          sendPacket(['close_tab', tab.id]);
          triggerHaptic(8);
        };
        item.appendChild(closeBtn);

        item.onclick = () => {
          sendPacket(['switch_tab', tab.id]);
          if (tabsDrawer) tabsDrawer.classList.add('hidden');
          triggerHaptic(12);
        };

        drawerTabsList.appendChild(item);
      });
    }
  }

  // Tab Drawer Toggle Handlers
  if (btnTabs) {
    btnTabs.addEventListener('click', () => {
      if (tabsDrawer) tabsDrawer.classList.toggle('hidden');
      triggerHaptic(8);
    });
  }

  if (btnCloseDrawer) {
    btnCloseDrawer.addEventListener('click', () => {
      if (tabsDrawer) tabsDrawer.classList.add('hidden');
      triggerHaptic(6);
    });
  }

  if (btnNewTabStrip) {
    btnNewTabStrip.addEventListener('click', () => {
      sendPacket(['new_tab']);
      triggerHaptic(15);
    });
  }

  if (btnNewTabDrawer) {
    btnNewTabDrawer.addEventListener('click', () => {
      sendPacket(['new_tab']);
      if (tabsDrawer) tabsDrawer.classList.add('hidden');
      triggerHaptic(15);
    });
  }

  // Natural Scroll Direction Toggle
  if (btnScrollDir) {
    btnScrollDir.addEventListener('click', () => {
      isNaturalScroll = !isNaturalScroll;
      localStorage.setItem('scroll_natural', isNaturalScroll ? '1' : '0');
      updateScrollDirUI();
      triggerHaptic(18);
      sendPacket(['set_natural_scroll', isNaturalScroll]);
    });
  }

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
