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
  zoomMode: 'hybrid', // 'hybrid' | 'native' | 'wheel'
  hapticFeedback: true
};

// Ensure offscreen document is active for WebRTC
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['WEB_RTC'],
      justification: 'Maintain real-time WebRTC DataChannel connection with mobile trackpad'
    });
    console.log('[Scroll Background] Offscreen document created');
  } catch (err) {
    console.error('[Scroll Background] Failed to create offscreen document:', err);
  }
}

async function hasOffscreenDocument() {
  const matchedClients = await clients.matchAll();
  for (const client of matchedClients) {
    if (client.url.includes(OFFSCREEN_DOCUMENT_PATH)) {
      return true;
    }
  }
  return false;
}

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Scroll] Installed or updated.');
  const stored = await chrome.storage.local.get('scroll_settings');
  if (!stored.scroll_settings) {
    await chrome.storage.local.set({ scroll_settings: DEFAULT_SETTINGS });
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

// Zoom handling
async function handleZoom(delta, scale) {
  const tab = await getActiveTab();
  if (!tab) return;

  const storage = await chrome.storage.local.get('scroll_settings');
  const settings = storage.scroll_settings || DEFAULT_SETTINGS;
  const zoomMode = settings.zoomMode || 'hybrid';

  const adjustedDelta = delta * settings.zoomSensitivity;

  // Hybrid or native mode adjusts chrome.tabs zoom
  if (zoomMode === 'hybrid' || zoomMode === 'native') {
    try {
      const currentZoom = await chrome.tabs.getZoom(tab.id);
      // Smooth logarithmic/linear fractional step
      let factor = 1 + (adjustedDelta * 0.12);
      let targetZoom = currentZoom * factor;
      // Clamp between 0.3 (30%) and 3.0 (300%)
      targetZoom = Math.min(Math.max(targetZoom, 0.3), 3.0);
      await chrome.tabs.setZoom(tab.id, targetZoom);
    } catch (e) {
      console.warn('Tab zoom error:', e);
    }
  }

  // Forward to content script for synthetic wheel / canvas / maps zoom
  if (zoomMode === 'hybrid' || zoomMode === 'wheel') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'APPLY_ZOOM',
      delta: adjustedDelta,
      scale: scale
    }).catch(() => {});
  }
}

// Reset Zoom
async function handleResetZoom() {
  const tab = await getActiveTab();
  if (!tab) return;

  try {
    await chrome.tabs.setZoom(tab.id, 1.0);
  } catch (e) {}

  chrome.tabs.sendMessage(tab.id, {
    action: 'RESET_ZOOM'
  }).catch(() => {});
}

// Initial guarantee
ensureOffscreenDocument();
