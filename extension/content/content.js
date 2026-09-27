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
  let hoveredElement = null;

  let lastReportedCursor = 0;
  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    hoveredElement = e.target;

    const now = performance.now();
    if (now - lastReportedCursor > 120) {
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
    const target = getScrollTarget(pendingDy, pendingDx);

    if (!target || target === window || target === document.documentElement || target === document.body) {
      window.scrollBy({
        left: pendingDx,
        top: pendingDy,
        behavior: 'instant'
      });
    } else {
      target.scrollBy({
        left: pendingDx,
        top: pendingDy,
        behavior: 'instant'
      });
    }

    pendingDx = 0;
    pendingDy = 0;
  }

  // Find the appropriate scrollable element with intelligent scroll-chaining
  function getScrollTarget(dy, dx) {
    let el = hoveredElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollableY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      const isScrollableX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth;

      if (isScrollableY || isScrollableX) {
        // Check if container can actually receive more scroll in this direction
        const canScrollDown = dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
        const canScrollUp = dy < 0 && el.scrollTop > 1;
        const canScrollRight = dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        const canScrollLeft = dx < 0 && el.scrollLeft > 1;

        if (canScrollDown || canScrollUp || canScrollRight || canScrollLeft) {
          return el;
        }
      }
      el = el.parentElement;
    }
    return window;
  }

  // Handle Pinch to Zoom while 100% preserving native scrollbars and vector clarity
  function handleZoom(delta, scale, mode) {
    // Check if user is hovering over an interactive web canvas (Google Maps, Figma, Leaflet)
    const isCanvasApp = hoveredElement && (
      hoveredElement.tagName === 'CANVAS' ||
      hoveredElement.closest('canvas, .mapboxgl-map, .leaflet-container, [data-canvas]')
    );

    if (mode === 'wheel' || (isCanvasApp && visualScale <= 1.01)) {
      const targetX = lastMouseX || (window.innerWidth / 2);
      const targetY = lastMouseY || (window.innerHeight / 2);
      const targetEl = hoveredElement || document.elementFromPoint(targetX, targetY) || document.body;

      const wheelEvent = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        view: window,
        ctrlKey: true,
        deltaY: -delta * 120,
        clientX: targetX,
        clientY: targetY
      });
      targetEl.dispatchEvent(wheelEvent);
      showHud('Canvas Zoom', `${Math.round((scale || 1) * 100)}%`);
      return;
    }

    // --- Continuous Viewport Zoom (Preserves Native Window Scrollbar) ---
    const oldScale = visualScale;
    const zoomMultiplier = 1 + (delta * 1.6);
    let newScale = Math.min(Math.max(visualScale * zoomMultiplier, 1.0), 4.0);

    if (newScale <= 1.015) {
      newScale = 1.0;
    }

    if (Math.abs(newScale - oldScale) < 0.002) return;

    visualScale = newScale;

    if (visualScale === 1.0) {
      document.body.style.zoom = '';
      showHud('Zoom', '100%');
      return;
    }

    // Apply continuous CSS zoom on body: Native window scrollbars stay completely visible!
    document.body.style.zoom = visualScale.toFixed(3);

    // Keep focal point stationary relative to viewport
    const fx = lastMouseX || (window.innerWidth / 2);
    const fy = lastMouseY || (window.innerHeight / 2);
    const ratio = newScale / oldScale;
    const adjustX = (window.scrollX + fx) * (ratio - 1);
    const adjustY = (window.scrollY + fy) * (ratio - 1);
    window.scrollBy({ left: adjustX, top: adjustY, behavior: 'instant' });

    showHud('Zoom', `${Math.round(visualScale * 100)}%`);
  }

  // Reset Zoom
  function resetVisualZoom() {
    visualScale = 1.0;
    document.body.style.zoom = '';
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
