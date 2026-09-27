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
chrome.tabs.onActivated.addListener((activeInfo) => {
  cachedActiveTabId = activeInfo.tabId;
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If offscreen or popup wants to wake up or check state
  if (message.type === 'ENSURE_OFFSCREEN') {
    ensureOffscreenDocument().then(() => sendResponse({ ok: true }));
    return true;
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

// Pan handling
async function handlePan(dx, dy) {
  const tab = await getActiveTab();
  if (!tab) return;

  const storage = await chrome.storage.local.get('scroll_settings');
  const settings = storage.scroll_settings || DEFAULT_SETTINGS;

  let finalDx = dx * settings.panSensitivity;
  let finalDy = dy * settings.panSensitivity;

  if (settings.invertX) finalDx = -finalDx;
  if (settings.invertY) finalDy = -finalDy;

  chrome.tabs.sendMessage(tab.id, {
    action: 'APPLY_PAN',
    dx: finalDx,
    dy: finalDy
  }).catch(() => {
    // Tab might be in loading state or non-scriptable
  });
}

// Zoom handling: Pure Visual Viewport Pinch Zoom by default
async function handleZoom(delta, scale) {
  const tab = await getActiveTab();
  if (!tab) return;

  const storage = await chrome.storage.local.get('scroll_settings');
  const settings = storage.scroll_settings || DEFAULT_SETTINGS;
  const zoomMode = settings.zoomMode || 'visual';

  const adjustedDelta = delta * settings.zoomSensitivity;

  // Visual mode (True continuous pinch-to-zoom in content script)
  if (zoomMode === 'visual' || zoomMode === 'wheel') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'APPLY_ZOOM',
      delta: adjustedDelta,
      scale: scale,
      mode: zoomMode
    }).catch(() => {});
    return;
  }

  // Legacy page zoom mode (Ctrl + / - stepped layout zoom) only if explicitly enabled
  if (zoomMode === 'page') {
    try {
      const currentZoom = await chrome.tabs.getZoom(tab.id);
      let factor = 1 + (adjustedDelta * 0.12);
      let targetZoom = currentZoom * factor;
      targetZoom = Math.min(Math.max(targetZoom, 0.3), 3.0);
      await chrome.tabs.setZoom(tab.id, targetZoom);
    } catch (e) {
      console.warn('Tab zoom error:', e);
    }
  }
}

// Reset Zoom
async function handleResetZoom() {
  const tab = await getActiveTab();
  if (!tab) return;

  const storage = await chrome.storage.local.get('scroll_settings');
  const settings = storage.scroll_settings || DEFAULT_SETTINGS;

  if (settings.zoomMode === 'page') {
    try {
      await chrome.tabs.setZoom(tab.id, 1.0);
    } catch (e) {}
  }

  chrome.tabs.sendMessage(tab.id, {
    action: 'RESET_ZOOM'
  }).catch(() => {});
}

// Initial guarantee
ensureOffscreenDocument();
