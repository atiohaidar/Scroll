/**
 * Scroll Content Script
 * Injected into active tabs to handle ultra-smooth subpixel panning and pinch-to-zoom.
 */

(function () {
  if (window.__SCROLL_INJECTED__) return;
  window.__SCROLL_INJECTED__ = true;

  // Track cursor position to direct scroll and zoom gestures
  let lastMouseX = window.innerWidth / 2;
  let lastMouseY = window.innerHeight / 2;
  let cachedScrollTarget = window;
  let lastCheckedHovered = null;

  // Non-blocking helper: resolves scrollable container only when hover target changes
  function resolveScrollContainer(el) {
    if (!el || el === document.body || el === document.documentElement) return window;
    let curr = el;
    let depth = 0;
    while (curr && curr !== document.body && curr !== document.documentElement && depth < 8) {
      if (curr.scrollHeight > curr.clientHeight || curr.scrollWidth > curr.clientWidth) {
        try {
          const style = window.getComputedStyle(curr);
          const oy = style.overflowY;
          const ox = style.overflowX;
          if (oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll') {
            return curr;
          }
        } catch (e) {}
      }
      curr = curr.parentElement;
      depth++;
    }
    return window;
  }

  let lastReportedCursor = 0;
  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    if (e.target !== lastCheckedHovered) {
      lastCheckedHovered = e.target;
      cachedScrollTarget = resolveScrollContainer(e.target);
    }

    const now = performance.now();
    if (now - lastReportedCursor > 150) {
      lastReportedCursor = now;
      chrome.runtime.sendMessage({
        type: 'CURSOR_MOVE',
        x: Math.round(e.clientX),
        y: Math.round(e.clientY)
      }).catch(() => {});
    }
  }, { passive: true });

  // --- Modern Trackpad & Viewport Engine ---
  let visualScale = 1.0;

  // Subpixel accumulator & RequestAnimationFrame loop for high-frequency scrolling
  let pendingDx = 0;
  let pendingDy = 0;
  let isRafScheduled = false;

  function schedulePan(dx, dy) {
    pendingDx += dx;
    pendingDy += dy;

    if (!isRafScheduled) {
      isRafScheduled = true;
      requestAnimationFrame(flushPan);
    }
  }

  function flushPan() {
    isRafScheduled = false;

    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;

    const target = cachedScrollTarget;

    // Fast check: if inner element can absorb the scroll
    if (target && target !== window && target !== document.body && target !== document.documentElement) {
      const canScrollY = (dy > 0 && target.scrollTop + target.clientHeight < target.scrollHeight - 1) ||
                         (dy < 0 && target.scrollTop > 0);
      const canScrollX = (dx > 0 && target.scrollLeft + target.clientWidth < target.scrollWidth - 1) ||
                         (dx < 0 && target.scrollLeft > 0);

      if (canScrollY || canScrollX) {
        target.scrollBy({
          left: dx,
          top: dy,
          behavior: 'instant'
        });
        return;
      }
    }

    // Direct hardware-accelerated window scroll (zero forced reflow)
    window.scrollBy({
      left: dx,
      top: dy,
      behavior: 'instant'
    });
  }

  // --- Full-Document Continuous Zoom Engine ---
  let targetScale = 1.0;
  let currentScale = 1.0;
  let zoomRafId = null;

  // Handle Pinch to Zoom (Scales full document so scrolling reaches top-to-bottom seamlessly)
  function handleZoom(delta, scale) {
    const zoomFactor = 1 + (delta * 1.4);
    targetScale = Math.min(Math.max(targetScale * zoomFactor, 1.0), 3.0);

    if (targetScale <= 1.015) {
      targetScale = 1.0;
    }

    if (!zoomRafId) {
      zoomRafId = requestAnimationFrame(animateZoom);
    }
  }

  function animateZoom() {
    // Silky smooth exponential interpolation (0.35 per frame)
    currentScale += (targetScale - currentScale) * 0.35;

    if (Math.abs(targetScale - currentScale) < 0.005) {
      currentScale = targetScale;
    }

    if (currentScale <= 1.015) {
      currentScale = 1.0;
      targetScale = 1.0;
      document.documentElement.style.zoom = '';
      document.body.style.transform = '';
      document.body.style.transformOrigin = '';
      zoomRafId = null;
      showHud('Zoom', '100%');
      return;
    }

    // Expand full document scale: Entire page remains scrollable to the very top and very bottom!
    document.documentElement.style.zoom = currentScale.toFixed(3);
    document.body.style.transform = '';
    document.body.style.transformOrigin = '';

    showHud('Zoom', `${Math.round(currentScale * 100)}%`);

    if (currentScale !== targetScale) {
      zoomRafId = requestAnimationFrame(animateZoom);
    } else {
      zoomRafId = null;
    }
  }

  // Reset Zoom
  function resetVisualZoom() {
    targetScale = 1.0;
    currentScale = 1.0;
    document.documentElement.style.zoom = '';
    document.body.style.transform = '';
    document.body.style.transformOrigin = '';
    if (zoomRafId) {
      cancelAnimationFrame(zoomRafId);
      zoomRafId = null;
    }
    showHud('Zoom', '100%');
  }

  // HUD Indicator Element
  let hudElement = null;
  let hudTimeout = null;

  function showHud(label, value) {
    if (!hudElement) {
      hudElement = document.createElement('div');
      hudElement.id = '__scroll_hud_indicator__';
      hudElement.innerHTML = `
        <svg class="scroll-hud-icon" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          <line x1="11" y1="8" x2="11" y2="14"></line>
          <line x1="8" y1="11" x2="14" y2="11"></line>
        </svg>
        <span class="scroll-hud-value">${value}</span>
      `;
      document.documentElement.appendChild(hudElement);
    }

    const valSpan = hudElement.querySelector('.scroll-hud-value');
    if (valSpan) valSpan.textContent = value;

    hudElement.classList.add('scroll-hud-visible');

    if (hudTimeout) clearTimeout(hudTimeout);
    hudTimeout = setTimeout(() => {
      if (hudElement) hudElement.classList.remove('scroll-hud-visible');
    }, 1000);
  }

  // Message receiver from background service worker
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'APPLY_PAN') {
      schedulePan(request.dx, request.dy);
      sendResponse({ status: 'ok' });
      return false;
    }

    if (request.action === 'APPLY_ZOOM') {
      handleZoom(request.delta, request.scale, request.mode);
      sendResponse({ status: 'ok' });
      return false;
    }

    if (request.action === 'RESET_ZOOM') {
      resetVisualZoom();
      sendResponse({ status: 'ok' });
      return false;
    }
  });

})();
