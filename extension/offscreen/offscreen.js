/**
 * Scroll Offscreen Document - WebRTC P2P DataChannel Host
 * Handles low-latency direct connection between smartphone and laptop.
 */

let peer = null;
let activeConnection = null;
let currentPeerId = null;
let pingInterval = null;
let latestLatency = 0;

// Generate a clean, human-readable 6-character room code
function generateRoomCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars (l, 1, 0, o)
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `scr-${code}`;
}

// Initialize PeerJS
function initPeer(customId = null) {
  if (peer && !peer.destroyed) {
    peer.destroy();
  }

  const id = customId || generateRoomCode();
  currentPeerId = id;

  console.log('[Scroll Offscreen] Initializing Peer with ID:', id);

  try {
    peer = new Peer(id, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    peer.on('open', (assignedId) => {
      currentPeerId = assignedId;
      console.log('[Scroll Offscreen] Peer open, ID:', assignedId);
      broadcastState('ready');
    });

    peer.on('connection', (conn) => {
      console.log('[Scroll Offscreen] Incoming connection from:', conn.peer);
      handleConnection(conn);
    });

    peer.on('error', (err) => {
      console.warn('[Scroll Offscreen] Peer error:', err.type, err.message);
      if (err.type === 'unavailable-id') {
        // ID collision, retry with new random ID
        setTimeout(() => initPeer(), 500);
      } else {
        broadcastState('error', { error: err.message });
      }
    });

    peer.on('disconnected', () => {
      console.log('[Scroll Offscreen] Peer disconnected from signaling server, reconnecting...');
      if (!peer.destroyed) {
        peer.reconnect();
      }
    });

  } catch (e) {
    console.error('[Scroll Offscreen] Exception initializing Peer:', e);
    broadcastState('error', { error: e.message });
  }
}

function handleConnection(conn) {
  // If we already have an active connection, close the old one
  if (activeConnection && activeConnection.open) {
    activeConnection.close();
  }

  activeConnection = conn;

  conn.on('open', () => {
    console.log('[Scroll Offscreen] WebRTC DataChannel OPEN! Connected directly to mobile trackpad.');
    broadcastState('connected');
    startPingPong();
    relayToBackground({ type: 'CMD_REQUEST_TABS' });
  });

  conn.on('data', (packet) => {
    handlePacket(packet);
  });

  conn.on('close', () => {
    console.log('[Scroll Offscreen] WebRTC DataChannel closed');
    stopPingPong();
    activeConnection = null;
    broadcastState('ready');
  });

  conn.on('error', (err) => {
    console.warn('[Scroll Offscreen] Connection error:', err);
    stopPingPong();
    activeConnection = null;
    broadcastState('ready');
  });
}

function handlePacket(packet) {
  if (!packet) return;

  // Compact packet handling
  // Array format: [type, ...args]
  if (Array.isArray(packet)) {
    const type = packet[0];

    if (type === 'pan') {
      // ['pan', dx, dy]
      const dx = packet[1];
      const dy = packet[2];
      relayToBackground({ type: 'GESTURE_PAN', dx, dy });
    } else if (type === 'zoom') {
      // ['zoom', delta, currentScale]
      const delta = packet[1];
      const scale = packet[2];
      relayToBackground({ type: 'GESTURE_ZOOM', delta, scale });
    } else if (type === 'reset_zoom') {
      relayToBackground({ type: 'GESTURE_RESET_ZOOM' });
    } else if (type === 'switch_tab') {
      // ['switch_tab', tabId]
      relayToBackground({ type: 'CMD_SWITCH_TAB', tabId: packet[1] });
    } else if (type === 'close_tab') {
      // ['close_tab', tabId]
      relayToBackground({ type: 'CMD_CLOSE_TAB', tabId: packet[1] });
    } else if (type === 'new_tab') {
      relayToBackground({ type: 'CMD_NEW_TAB' });
    } else if (type === 'request_tabs') {
      relayToBackground({ type: 'CMD_REQUEST_TABS' });
    } else if (type === 'pong') {
      // ['pong', sentTimestamp]
      const rtt = Date.now() - packet[1];
      latestLatency = Math.max(1, Math.round(rtt / 2));
      broadcastLatency(latestLatency);
    }
    return;
  }

  // Object format fallback
  if (packet.type === 'pan') {
    relayToBackground({ type: 'GESTURE_PAN', dx: packet.dx, dy: packet.dy });
  } else if (packet.type === 'zoom') {
    relayToBackground({ type: 'GESTURE_ZOOM', delta: packet.delta, scale: packet.scale });
  } else if (packet.type === 'reset_zoom') {
    relayToBackground({ type: 'GESTURE_RESET_ZOOM' });
  } else if (packet.type === 'pong') {
    const rtt = Date.now() - packet.timestamp;
    latestLatency = Math.max(1, Math.round(rtt / 2));
    broadcastLatency(latestLatency);
  }
}

function startPingPong() {
  stopPingPong();
  pingInterval = setInterval(() => {
    if (activeConnection && activeConnection.open) {
      activeConnection.send(['ping', Date.now()]);
    }
  }, 1200);
}

function stopPingPong() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function relayToBackground(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Ignore runtime error if background service worker is idle or no listener
  });
}

function broadcastState(status, extra = {}) {
  const payload = {
    type: 'STATE_CHANGED',
    peerId: currentPeerId,
    status: status, // 'initializing' | 'ready' | 'connected' | 'error'
    latency: latestLatency,
    ...extra
  };
  chrome.runtime.sendMessage(payload).catch(() => {});
  // Also store in chrome.storage.local for popup instant recovery
  chrome.storage.local.set({
    scroll_peer_id: currentPeerId,
    scroll_status: status,
    scroll_latency: latestLatency
  });
}

function broadcastLatency(latency) {
  chrome.runtime.sendMessage({
    type: 'LATENCY_UPDATE',
    latency: latency
  }).catch(() => {});

  if (activeConnection && activeConnection.open) {
    // Let mobile know measured latency as well
    activeConnection.send(['latency', latency]);
  }
}

// Listen for messages from background/popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_OFFSCREEN_STATE') {
    sendResponse({
      peerId: currentPeerId,
      status: activeConnection && activeConnection.open ? 'connected' : (currentPeerId ? 'ready' : 'initializing'),
      latency: latestLatency
    });
    return true;
  }

  if (msg.type === 'RECONNECT_PEER') {
    initPeer(msg.customId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'BROADCAST_TABS') {
    if (activeConnection && activeConnection.open) {
      activeConnection.send(['tabs', msg.tabs]);
    }
    return false;
  }

  if (msg.type === 'DISCONNECT_ACTIVE') {
    if (activeConnection) {
      activeConnection.close();
      activeConnection = null;
    }
    broadcastState('ready');
    sendResponse({ ok: true });
    return true;
  }
});

// Kick off peer on start
initPeer();
