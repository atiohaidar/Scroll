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

  window.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    hoveredElement = e.target;
  }, { passive: true });

  // --- Visual Viewport & GPU Zoom Engine ---
  let visualScale = 1.0;
  let panX = 0;
  let panY = 0;
  let isZoomed = false;

  // Subpixel accumulator & RequestAnimationFrame loop for normal scrolling
  let pendingDx = 0;
  let pendingDy = 0;
  let isRafScheduled = false;

  function schedulePan(dx, dy) {
    // If the page is visually zoomed in, pan across the magnified viewport!
    if (isZoomed && visualScale > 1.01) {
      handleZoomedPan(dx, dy);
      return;
    }

    pendingDx += dx;
    pendingDy += dy;

    if (!isRafScheduled) {
      isRafScheduled = true;
      requestAnimationFrame(flushPan);
    }
  }

  function flushPan() {
    isRafScheduled = false;
    const target = getScrollTarget();

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

  // Find the appropriate scrollable element
  function getScrollTarget() {
    let el = hoveredElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollable = (
        (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight
      ) || (
        (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth
      );

      if (isScrollable) {
        return el;
      }
      el = el.parentElement;
    }
    return window;
  }

  // Pan across the magnified viewport when zoomed in
  function handleZoomedPan(dx, dy) {
    const oldPanX = panX;
    const oldPanY = panY;

    panX += dx;
    panY += dy;
    clampPan();
    applyVisualTransform();

    // If pan hit the edge of the zoomed viewport, overflow into regular page scroll
    const overflowX = dx - (panX - oldPanX);
    const overflowY = dy - (panY - oldPanY);
    if (Math.abs(overflowX) > 0.5 || Math.abs(overflowY) > 0.5) {
      window.scrollBy({
        left: overflowX,
        top: overflowY,
        behavior: 'instant'
      });
    }
  }

  function clampPan() {
    const maxShiftX = window.innerWidth * (visualScale - 1);
    const maxShiftY = window.innerHeight * (visualScale - 1);

    panX = Math.min(0, Math.max(-maxShiftX, panX));
    panY = Math.min(0, Math.max(-maxShiftY, panY));
  }

  function applyVisualTransform() {
    const html = document.documentElement;
    if (visualScale <= 1.01) {
      html.style.transform = '';
      html.style.transformOrigin = '';
      html.style.willChange = '';
      html.classList.remove('__scroll_zoomed__');
      isZoomed = false;
      return;
    }

    isZoomed = true;
    html.classList.add('__scroll_zoomed__');
    html.style.transformOrigin = '0 0';
    html.style.transform = `translate3d(${panX.toFixed(2)}px, ${panY.toFixed(2)}px, 0) scale(${visualScale.toFixed(4)})`;
    html.style.willChange = 'transform';
  }

  // Handle True Visual Viewport Pinch-to-Zoom
  function handleZoom(delta, scale, mode) {
    // Check if user is hovering over an interactive web canvas (Google Maps, Figma, Leaflet)
    const isCanvasApp = hoveredElement && (
      hoveredElement.tagName === 'CANVAS' ||
      hoveredElement.closest('canvas, .mapboxgl-map, .leaflet-container, [data-canvas]')
    );

    if (mode === 'wheel' || (isCanvasApp && visualScale <= 1.01)) {
      // Forward synthetic wheel event directly to interactive canvas
      const targetX = lastMouseX || (window.innerWidth / 2);
      const targetY = lastMouseY || (window.innerHeight / 2);
      const targetEl = hoveredElement || document.elementFromPoint(targetX, targetY) || document.body;

      const wheelEvent = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        view: window,
        ctrlKey: true,
        deltaY: -delta * 100,
        clientX: targetX,
        clientY: targetY
      });
      targetEl.dispatchEvent(wheelEvent);
      showHud('Canvas Zoom', `${Math.round((scale || 1) * 100)}%`);
      return;
    }

    // --- True GPU-Accelerated Visual Viewport Zoom ---
    const oldScale = visualScale;
    const zoomMultiplier = 1 + (delta * 2.2);
    let newScale = Math.min(Math.max(visualScale * zoomMultiplier, 1.0), 5.0);

    // Snap cleanly to 1.0 if very close
    if (newScale <= 1.015) {
      newScale = 1.0;
    }

    if (newScale === 1.0 && oldScale === 1.0) {
      return;
    }

    const fx = lastMouseX || (window.innerWidth / 2);
    const fy = lastMouseY || (window.innerHeight / 2);

    // Zoom focal-point camera formula: Keeps point under cursor visually anchored
    panX = fx - (fx - panX) * (newScale / oldScale);
    panY = fy - (fy - panY) * (newScale / oldScale);
    visualScale = newScale;

    clampPan();
    applyVisualTransform();

    showHud('Zoom', `${Math.round(visualScale * 100)}%`);
  }

  // Reset Zoom
  function resetVisualZoom() {
    const html = document.documentElement;
    if (isZoomed || visualScale > 1.01) {
      html.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
      html.style.transform = 'translate3d(0, 0, 0) scale(1)';
      setTimeout(() => {
        visualScale = 1.0;
        panX = 0;
        panY = 0;
        isZoomed = false;
        html.style.transition = '';
        html.style.transform = '';
        html.style.transformOrigin = '';
        html.style.willChange = '';
        html.classList.remove('__scroll_zoomed__');
      }, 230);
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
