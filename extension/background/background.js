/**
 * Scroll Background Service Worker (Manifest V3)
 * Orchestrates offscreen WebRTC lifecycle, tab targeting, and gesture dispatch.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// Default settings
const DEFAULT_SETTINGS = {
  panSensitivity: 1.2,
  zoomSensitivity: 1.0,
  invertX: false,
  invertY: false,
  enableMomentum: true,
  momentumStrength: 0.94,
  zoomMode: 'visual', // 'visual' (true GPU pinch-to-zoom) | 'wheel' (canvas apps) | 'page' (browser Ctrl+/-)
  hapticFeedback: true
};

// In-flight mutex promise to prevent concurrent createDocument race conditions
let creatingOffscreenPromise = null;

// Ensure offscreen document is active for WebRTC
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  // If another call is already in progress, wait for it
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['WEB_RTC'],
        justification: 'Maintain real-time WebRTC DataChannel connection with mobile trackpad'
      });
      console.log('[Scroll Background] Offscreen document created');
    } catch (err) {
      // Benign race condition: document was already created by another call
      if (err && err.message && err.message.includes('Only a single offscreen document')) {
        return;
      }
      console.error('[Scroll Background] Failed to create offscreen document:', err);
    } finally {
      creatingOffscreenPromise = null;
    }
  })();

  await creatingOffscreenPromise;
}

async function hasOffscreenDocument() {
  // Use official Chrome 116+ API if available
  if ('hasDocument' in chrome.offscreen) {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (e) {}
  }

  // Fallback to clients API
  try {
    const matchedClients = await clients.matchAll();
    for (const client of matchedClients) {
      if (client.url && client.url.includes(OFFSCREEN_DOCUMENT_PATH)) {
        return true;
      }
    }
  } catch (e) {}

  return false;
}

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Scroll] Installed or updated.');
  const stored = await chrome.storage.local.get('scroll_settings');
  if (!stored.scroll_settings) {
    await chrome.storage.local.set({ scroll_settings: DEFAULT_SETTINGS });
  } else if (!stored.scroll_settings.zoomMode || stored.scroll_settings.zoomMode === 'hybrid') {
    // Migrate to visual mode for true pinch to zoom
    const updated = { ...stored.scroll_settings, zoomMode: 'visual' };
    await chrome.storage.local.set({ scroll_settings: updated });
  }
  await ensureOffscreenDocument();
});

// Startup hook
chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenDocument();
});

// Cache the active tab ID for rapid gesture dispatch
let cachedActiveTabId = null;

// Track cursor coordinates for hardware-accurate focal point
let lastCursorPos = { x: 600, y: 400 };

// Native Chromium CDP Debugger Manager
const attachedTabs = new Set();
let attachingTabPromise = null;

async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) return true;

  if (attachingTabPromise) {
    return await attachingTabPromise;
  }

  attachingTabPromise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.add(tabId);
      console.log('[Scroll Debugger] Attached to tab for native hardware gestures:', tabId);
      return true;
    } catch (err) {
      // User may have dismissed or tab is restricted (e.g. chrome://)
      return false;
    } finally {
      attachingTabPromise = null;
    }
  })();

  return await attachingTabPromise;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && source.tabId) {
    attachedTabs.delete(source.tabId);
    console.log('[Scroll Debugger] Detached from tab:', source.tabId, reason);
  }
});

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
      cachedActiveTabId = tab.id;
      return tab;
    }
  } catch (e) {}
  return null;
}

// Track active tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  cachedActiveTabId = activeInfo.tabId;
  // Detach previous tabs to keep Chrome banner clean
  for (const tid of attachedTabs) {
    if (tid !== activeInfo.tabId) {
      try {
        await chrome.debugger.detach({ tabId: tid });
      } catch (e) {}
      attachedTabs.delete(tid);
    }
  }
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If offscreen or popup wants to wake up or check state
  if (message.type === 'ENSURE_OFFSCREEN') {
    ensureOffscreenDocument().then(() => sendResponse({ ok: true }));
    return true;
  }

  // Update cursor position from content script
  if (message.type === 'CURSOR_MOVE') {
    if (message.x !== undefined && message.y !== undefined) {
      lastCursorPos.x = message.x;
      lastCursorPos.y = message.y;
    }
    return false;
  }

  // Handle incoming gesture: PAN
  if (message.type === 'GESTURE_PAN') {
    handlePan(message.dx, message.dy);
    return false;
  }

  // Handle incoming gesture: ZOOM
  if (message.type === 'GESTURE_ZOOM') {
    handleZoom(message.delta, message.scale);
    return false;
  }

  // Handle incoming gesture: RESET ZOOM
  if (message.type === 'GESTURE_RESET_ZOOM') {
    handleResetZoom();
    return false;
  }

  return false;
});

// Pan handling: Native Chromium Hardware Mouse Wheel
async function handlePan(dx, dy) {
  const tab = await getActiveTab();
  if (!tab) return;

  const storage = await chrome.storage.local.get('scroll_settings');
  const settings = storage.scroll_settings || DEFAULT_SETTINGS;

  let finalDx = dx * settings.panSensitivity;
  let finalDy = dy * settings.panSensitivity;

  if (settings.invertX) finalDx = -finalDx;
  if (settings.invertY) finalDy = -finalDy;

  // Try Native Hardware Wheel via Chromium Debugger
  const isAttached = await ensureDebuggerAttached(tab.id);
  if (isAttached) {
    try {
      // In CDP mouseWheel:
      // Negative finalDy (drag finger up) -> positive deltaY (scroll down)
      // Positive finalDy (drag finger down) -> negative deltaY (scroll up)
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: lastCursorPos.x,
        y: lastCursorPos.y,
        deltaX: Math.round(-finalDx),
        deltaY: Math.round(-finalDy)
      });
      return;
    } catch (e) {
      attachedTabs.delete(tab.id);
    }
  }

  // Resilient fallback to Content Script if debugger cannot attach
  chrome.tabs.sendMessage(tab.id, {
    action: 'APPLY_PAN',
    dx: finalDx,
    dy: finalDy
  }).catch(() => {});
}

// Zoom handling: Native Chromium Visual Viewport Pinch
async function handleZoom(delta, scale) {
  const tab = await getActiveTab();
  if (!tab) return;

  const storage = await chrome.storage.local.get('scroll_settings');
  const settings = storage.scroll_settings || DEFAULT_SETTINGS;
  const adjustedDelta = delta * settings.zoomSensitivity;

  // Try Native Chromium Visual Viewport Pinch Gesture
  const isAttached = await ensureDebuggerAttached(tab.id);
  if (isAttached) {
    try {
      // Relative scale factor for the camera gesture (>1 zooms in, <1 zooms out)
      const scaleFactor = Math.max(0.75, Math.min(1.0 + (adjustedDelta * 1.6), 1.45));
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.synthesizePinchGesture", {
        x: lastCursorPos.x,
        y: lastCursorPos.y,
        scaleFactor: scaleFactor,
        relativeSpeed: 1000,
        gestureSourceType: "touch"
      });
      return;
    } catch (e) {
      attachedTabs.delete(tab.id);
    }
  }

  // Resilient fallback to Content Script
  chrome.tabs.sendMessage(tab.id, {
    action: 'APPLY_ZOOM',
    delta: adjustedDelta,
    scale: scale,
    mode: settings.zoomMode || 'visual'
  }).catch(() => {});
}

// Reset Zoom
async function handleResetZoom() {
  const tab = await getActiveTab();
  if (!tab) return;

  chrome.tabs.sendMessage(tab.id, {
    action: 'RESET_ZOOM'
  }).catch(() => {});
}

// Initial guarantee
ensureOffscreenDocument();
