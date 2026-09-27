/**
 * Scroll Popup Controller
 * Manages pairing state, QR code generation, and gesture precision preferences.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const qrContainer = document.getElementById('qr-container');
  const roomCodeEl = document.getElementById('room-code');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const telemetryBar = document.getElementById('telemetry-bar');
  const telemetryLatency = document.getElementById('telemetry-latency');

  const panSlider = document.getElementById('pan-sensitivity');
  const panVal = document.getElementById('pan-val');
  const zoomSlider = document.getElementById('zoom-sensitivity');
  const zoomVal = document.getElementById('zoom-val');
  const naturalScrollCheck = document.getElementById('natural-scroll');
  const momentumCheck = document.getElementById('momentum-physics');
  const btnCopy = document.getElementById('btn-copy');
  const btnResetZoom = document.getElementById('btn-reset-zoom');
  const hostDisplay = document.getElementById('host-display');
  const btnEditHost = document.getElementById('btn-edit-host');

  let currentPeerId = null;
  let mobileBaseUrl = 'http://localhost:3000'; // Default local development server

  // Load stored settings & state
  const storage = await chrome.storage.local.get([
    'scroll_settings',
    'scroll_peer_id',
    'scroll_status',
    'scroll_latency',
    'scroll_mobile_url'
  ]);

  if (storage.scroll_mobile_url) {
    mobileBaseUrl = storage.scroll_mobile_url;
  }

  // Attempt auto-discovery from local companion server if running
  try {
    const res = await fetch('http://localhost:3000/api/info', { signal: AbortSignal.timeout(600) });
    if (res.ok) {
      const data = await res.json();
      if (data.mobileUrl) {
        mobileBaseUrl = data.mobileUrl;
        await chrome.storage.local.set({ scroll_mobile_url: mobileBaseUrl });
      }
    }
  } catch (e) {
    // Local server not running or unreachable, continue with default or stored URL
  }

  if (hostDisplay) {
    hostDisplay.textContent = mobileBaseUrl;
  }

  btnEditHost.addEventListener('click', async () => {
    const newUrl = prompt('Enter your smartphone controller base URL (e.g. http://192.168.1.50:3000):', mobileBaseUrl);
    if (newUrl && newUrl.trim()) {
      mobileBaseUrl = newUrl.trim().replace(/\/+$/, '');
      await chrome.storage.local.set({ scroll_mobile_url: mobileBaseUrl });
      if (hostDisplay) hostDisplay.textContent = mobileBaseUrl;
      if (currentPeerId) updatePeerDisplay(currentPeerId);
    }
  });

  // Restore Settings
  if (storage.scroll_settings) {
    const s = storage.scroll_settings;
    if (s.panSensitivity !== undefined) {
      panSlider.value = s.panSensitivity;
      panVal.textContent = `${Number(s.panSensitivity).toFixed(1)}x`;
    }
    if (s.zoomSensitivity !== undefined) {
      zoomSlider.value = s.zoomSensitivity;
      zoomVal.textContent = `${Number(s.zoomSensitivity).toFixed(1)}x`;
    }
    if (s.invertY !== undefined) {
      naturalScrollCheck.checked = !s.invertY;
    }
    if (s.enableMomentum !== undefined) {
      momentumCheck.checked = s.enableMomentum;
    }
  }

  // Initial State from storage
  if (storage.scroll_peer_id) {
    updatePeerDisplay(storage.scroll_peer_id);
  }
  if (storage.scroll_status) {
    updateStatusDisplay(storage.scroll_status, storage.scroll_latency || 0);
  }

  // Ensure offscreen document is running and ask for fresh state
  chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' });
  chrome.runtime.sendMessage({ type: 'GET_OFFSCREEN_STATE' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    if (response.peerId) {
      updatePeerDisplay(response.peerId);
    }
    if (response.status) {
      updateStatusDisplay(response.status, response.latency);
    }
  });

  // Listen for state changes from offscreen or background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_CHANGED') {
      if (msg.peerId) updatePeerDisplay(msg.peerId);
      updateStatusDisplay(msg.status, msg.latency);
    } else if (msg.type === 'LATENCY_UPDATE') {
      updateLatency(msg.latency);
    }
  });

  function getPairingUrl(peerId) {
    // If mobileBaseUrl already ends with a slash or index.html
    const base = mobileBaseUrl.replace(/\/+$/, '');
    return `${base}/?peer=${peerId}`;
  }

  function updatePeerDisplay(peerId) {
    currentPeerId = peerId;
    roomCodeEl.textContent = peerId;

    const pairingUrl = getPairingUrl(peerId);
    renderQrCode(pairingUrl);
  }

  function renderQrCode(url) {
    if (typeof qrcode === 'undefined') {
      qrContainer.innerHTML = '<span class="qr-loading">QR library loading...</span>';
      return;
    }

    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      // createSvgTag with scalable vector
      qrContainer.innerHTML = qr.createSvgTag({
        scalable: true,
        margin: 0
      });
    } catch (e) {
      console.error('Failed to render QR Code:', e);
      qrContainer.innerHTML = `<span class="qr-loading">Error generating QR</span>`;
    }
  }

  function updateStatusDisplay(status, latency) {
    statusBadge.className = 'badge';
    if (status === 'connected') {
      statusBadge.classList.add('badge-connected');
      statusText.textContent = 'Connected (P2P)';
      telemetryBar.classList.remove('hidden');
      updateLatency(latency || 2);
    } else if (status === 'ready') {
      statusBadge.classList.add('badge-ready');
      statusText.textContent = 'Ready to pair';
      telemetryBar.classList.add('hidden');
    } else {
      statusBadge.classList.add('badge-init');
      statusText.textContent = 'Initializing...';
      telemetryBar.classList.add('hidden');
    }
  }

  function updateLatency(latency) {
    if (telemetryLatency) {
      telemetryLatency.textContent = `${latency} ms`;
    }
  }

  // Settings Event Handlers
  panSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    panVal.textContent = `${val.toFixed(1)}x`;
    saveSetting('panSensitivity', val);
  });

  zoomSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    zoomVal.textContent = `${val.toFixed(1)}x`;
    saveSetting('zoomSensitivity', val);
  });

  naturalScrollCheck.addEventListener('change', (e) => {
    const isNatural = e.target.checked;
    // In natural scrolling, dragging finger up moves content down
    saveSetting('invertY', !isNatural);
    saveSetting('invertX', !isNatural);
  });

  momentumCheck.addEventListener('change', (e) => {
    saveSetting('enableMomentum', e.target.checked);
  });

  async function saveSetting(key, value) {
    const stored = await chrome.storage.local.get('scroll_settings');
    const settings = stored.scroll_settings || {};
    settings[key] = value;
    await chrome.storage.local.set({ scroll_settings: settings });
  }

  // Copy URL button
  btnCopy.addEventListener('click', async () => {
    if (!currentPeerId) return;
    const url = getPairingUrl(currentPeerId);
    try {
      await navigator.clipboard.writeText(url);
      const originalTitle = btnCopy.getAttribute('title');
      btnCopy.setAttribute('title', 'Copied to clipboard!');
      btnCopy.style.color = '#10B981';
      setTimeout(() => {
        btnCopy.setAttribute('title', originalTitle);
        btnCopy.style.color = '';
      }, 1500);
    } catch (e) {
      console.warn('Clipboard write error:', e);
    }
  });

  // Reset Zoom button
  btnResetZoom.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GESTURE_RESET_ZOOM' });
  });

});
