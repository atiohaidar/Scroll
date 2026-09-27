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

  // Subpixel accumulator & RequestAnimationFrame loop
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

  // Handle Pinch to Zoom
  function handleZoom(delta, scale) {
    const targetX = lastMouseX || (window.innerWidth / 2);
    const targetY = lastMouseY || (window.innerHeight / 2);
    const targetEl = document.elementFromPoint(targetX, targetY) || document.body;

    // Dispatch synthetic WheelEvent with ctrlKey (macOS/Windows trackpad standard)
    const wheelEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: true,
      deltaY: -delta * 80,
      clientX: targetX,
      clientY: targetY
    });

    targetEl.dispatchEvent(wheelEvent);
    showHud('Zooming', `${Math.round((scale || 1) * 100)}%`);
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
      handleZoom(request.delta, request.scale);
      sendResponse({ status: 'ok' });
      return false;
    }

    if (request.action === 'RESET_ZOOM') {
      showHud('Zoom', '100%');
      sendResponse({ status: 'ok' });
      return false;
    }
  });

})();
