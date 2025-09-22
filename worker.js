// VLESS Cloudflare Worker - Rebuilt and Enhanced
// Based on GAMFC version with improvements for reliability and maintainability

import { connect } from "cloudflare:sockets";

// Configuration
let proxyIP = '';

// Constants
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// Command types
const CMD_TCP = 1;
const CMD_UDP = 2;

// Address types
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 2;
const ATYP_IPV6 = 3;

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      const url = new URL(request.url);
      
      // Handle non-WebSocket requests
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return handleHttpRequest(request, url);
      }
      
      // Extract proxy IP from path if provided
      if (url.pathname.includes('/') && url.pathname.length > 1) {
        const pathSegments = url.pathname.split('/');
        if (pathSegments[1]) {
          proxyIP = pathSegments[1];
        }
      }
      
      return await handleWebSocketUpgrade(request);
      
    } catch (err) {
      console.error('Worker error:', err);
      return new Response(`Error: ${err.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },
};

/**
 * Handle HTTP requests (non-WebSocket)
 */
async function handleHttpRequest(request, url) {
  if (url.pathname === '/') {
    return new Response(getStatusPage(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      proxyIP: proxyIP || 'not set'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Fallback to original request
  return fetch(request);
}

/**
 * Handle WebSocket upgrade for VLESS tunnel
 */
async function handleWebSocketUpgrade(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = createReadableWebSocketStream(webSocket, earlyDataHeader, log);

  let remoteSocketWrapper = { value: null };
  let udpStreamWrite = null;
  let isDns = false;

  // Process incoming WebSocket data
  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      try {
        // Handle UDP DNS queries
        if (isDns && udpStreamWrite) {
          return udpStreamWrite(chunk);
        }

        // Handle existing TCP connection
        if (remoteSocketWrapper.value) {
          const writer = remoteSocketWrapper.value.writable.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
          return;
        }

        // Parse VLESS header
        const headerResult = parseVlessHeader(chunk);
        if (headerResult.hasError) {
          throw new Error(headerResult.message);
        }

        const {
          addressRemote,
          portRemote,
          rawDataIndex,
          tunVersion,
          isUDP
        } = headerResult;

        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random().toString(36).substr(2, 9)} ${isUDP ? 'udp' : 'tcp'}`;

        // Handle UDP (DNS only)
        if (isUDP) {
          if (portRemote === 53) {
            isDns = true;
          } else {
            throw new Error('UDP proxy only supported for DNS (port 53)');
          }
        }

        const tunResponseHeader = new Uint8Array([tunVersion[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isDns) {
          const { write } = await handleUDPOutbound(webSocket, tunResponseHeader, log);
          udpStreamWrite = write;
          udpStreamWrite(rawClientData);
          return;
        }

        // Handle TCP connection
        await handleTCPOutbound(
          remoteSocketWrapper, 
          addressRemote, 
          portRemote, 
          rawClientData, 
          webSocket, 
          tunResponseHeader, 
          log
        );

      } catch (error) {
        log('Write error:', error.message);
        controller.error(error);
      }
    },

    close() {
      log('ReadableWebSocketStream closed');
    },

    abort(reason) {
      log('ReadableWebSocketStream aborted:', JSON.stringify(reason));
    },
  })).catch((err) => {
    log('ReadableWebSocketStream pipeTo error:', err.message);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Handle TCP outbound connections
 */
async function handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, tunResponseHeader, log) {
  
  async function connectAndWrite(address, port) {
    try {
      const tcpSocket = connect({
        hostname: address,
        port: port,
      });
      
      remoteSocket.value = tcpSocket;
      log(`Connected to ${address}:${port}`);
      
      const writer = tcpSocket.writable.getWriter();
      await writer.write(rawClientData);
      writer.releaseLock();
      
      return tcpSocket;
    } catch (error) {
      log(`Connection failed to ${address}:${port}:`, error.message);
      throw error;
    }
  }

  async function retry() {
    try {
      const [retryAddress, retryPort] = parseProxyAddress(proxyIP, addressRemote, portRemote);
      const tcpSocket = await connectAndWrite(retryAddress, retryPort);
      
      tcpSocket.closed.catch(error => {
        log('Retry TCP socket closed with error:', error.message);
      }).finally(() => {
        safeCloseWebSocket(webSocket);
      });
      
      remoteSocketToWS(tcpSocket, webSocket, tunResponseHeader, null, log);
    } catch (error) {
      log('Retry failed:', error.message);
      safeCloseWebSocket(webSocket);
    }
  }

  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, tunResponseHeader, retry, log);
  } catch (error) {
    log('Initial connection failed, attempting retry');
    await retry();
  }
}

/**
 * Create readable stream from WebSocket
 */
function createReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (!readableStreamCancel) {
          controller.close();
        }
      });

      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket server error:', err.message);
        controller.error(err);
      });

      // Handle early data
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    pull(controller) {
      // No-op
    },

    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream canceled: ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });

  return stream;
}

/**
 * Parse VLESS protocol header
 */
function parseVlessHeader(buffer) {
  if (buffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'Invalid data: buffer too short',
    };
  }

  try {
    const version = new Uint8Array(buffer.slice(0, 1));
    
    // Skip UUID validation for now (16 bytes from offset 1-17)
    const optLength = new Uint8Array(buffer.slice(17, 18))[0];
    const command = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
    
    let isUDP = false;
    if (command === CMD_TCP) {
      isUDP = false;
    } else if (command === CMD_UDP) {
      isUDP = true;
    } else {
      return {
        hasError: true,
        message: `Unsupported command: ${command}. Supported: 1(TCP), 2(UDP)`,
      };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = buffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressType = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0];
    
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
      case ATYP_IPV4:
        addressLength = 4;
        addressValue = new Uint8Array(
          buffer.slice(addressValueIndex, addressValueIndex + addressLength)
        ).join('.');
        break;
        
      case ATYP_DOMAIN:
        addressLength = new Uint8Array(
          buffer.slice(addressValueIndex, addressValueIndex + 1)
        )[0];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(
          buffer.slice(addressValueIndex, addressValueIndex + addressLength)
        );
        break;
        
      case ATYP_IPV6:
        addressLength = 16;
        const dataView = new DataView(
          buffer.slice(addressValueIndex, addressValueIndex + addressLength)
        );
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(i * 2).toString(16));
        }
        addressValue = ipv6.join(':');
        break;
        
      default:
        return {
          hasError: true,
          message: `Invalid address type: ${addressType}`,
        };
    }

    if (!addressValue) {
      return {
        hasError: true,
        message: `Empty address value for type ${addressType}`,
      };
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      addressType,
      portRemote,
      rawDataIndex: addressValueIndex + addressLength,
      tunVersion: version,
      isUDP,
    };
  } catch (error) {
    return {
      hasError: true,
      message: `Header parsing error: ${error.message}`,
    };
  }
}

/**
 * Relay data from remote socket to WebSocket
 */
async function remoteSocketToWS(remoteSocket, webSocket, tunResponseHeader, retry, log) {
  let hasIncomingData = false;
  let tunHeader = tunResponseHeader;

  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          hasIncomingData = true;
          
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error('WebSocket is not open');
            return;
          }

          if (tunHeader) {
            webSocket.send(await new Blob([tunHeader, chunk]).arrayBuffer());
            tunHeader = null;
          } else {
            webSocket.send(chunk);
          }
        },

        close() {
          log(`Remote connection closed. Had incoming data: ${hasIncomingData}`);
        },

        abort(reason) {
          log('Remote connection aborted:', reason);
        },
      })
    );
  } catch (error) {
    log('remoteSocketToWS error:', error.message);
    safeCloseWebSocket(webSocket);
  }

  // Retry if no data was received and retry function is available
  if (!hasIncomingData && retry) {
    log('No incoming data received, attempting retry');
    retry();
  }
}

/**
 * Handle UDP outbound (DNS queries)
 */
async function handleUDPOutbound(webSocket, tunResponseHeader, log) {
  let isTunHeaderSent = false;
  
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      // Parse UDP packets
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPacketLength)
        );
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      try {
        // Use Cloudflare's DNS over HTTPS
        const response = await fetch('https://1.1.1.1/dns-query', {
          method: 'POST',
          headers: {
            'content-type': 'application/dns-message',
          },
          body: chunk,
        });

        if (!response.ok) {
          throw new Error(`DNS query failed: ${response.status}`);
        }

        const dnsQueryResult = await response.arrayBuffer();
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

        if (webSocket.readyState === WS_READY_STATE_OPEN) {
          log(`DNS query successful, response length: ${udpSize}`);
          
          if (isTunHeaderSent) {
            webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
          } else {
            webSocket.send(await new Blob([tunResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            isTunHeaderSent = true;
          }
        }
      } catch (error) {
        log('DNS query error:', error.message);
      }
    }
  })).catch((error) => {
    log('UDP outbound error:', error.message);
  });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
}

/**
 * Utility functions
 */
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null };
  }
  
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arrayBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('Error closing WebSocket:', error);
  }
}

function parseProxyAddress(proxyIP, defaultAddress, defaultPort) {
  if (!proxyIP) {
    return [defaultAddress, defaultPort];
  }
  
  const parts = proxyIP.split(/[:=]/);
  const address = parts[0] || defaultAddress;
  const port = parts[1] ? parseInt(parts[1], 10) : defaultPort;
  
  return [address, port];
}

function getStatusPage() {
  return `
  <!DOCTYPE html>
  <html lang="id">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AFRCloud - NET || Home</title>
      
      <link rel="icon" href="https://raw.githubusercontent.com/AFRcloud/BG/main/icons8-film-noir-80.png">
      
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Rajdhani:wght@400;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
      
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      
      <style>
          /* --- Variabel Global --- */
          :root {
              /* Warna */
              --primary-color: #6a11cb;
              --secondary-color: #2575fc;
              --accent-color: #ff6b6b;
              --success-color: #38ef7d;
              --dark-bg: #0f0c29;
              --dark-bg-gradient-1: #302b63;
              --dark-bg-gradient-2: #24243e;
              --card-bg: rgba(15, 14, 32, 0.8);
              --text-primary: #ffffff;
              --text-secondary: #a0a0ff;
              --border-color: rgba(255, 255, 255, 0.1);
  
              /* UI & Efek */
              --border-radius-md: 12px;
              --border-radius-lg: 16px;
              --glow-primary: 0 0 10px rgba(106, 17, 203, 0.5), 0 0 20px rgba(106, 17, 203, 0.2);
              --transition-normal: all 0.3s ease;
          }
  
          /* --- Reset & Gaya Dasar --- */
          * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
          }
          body {
              font-family: "Rajdhani", sans-serif;
              color: var(--text-primary);
              background: linear-gradient(135deg, var(--dark-bg), var(--dark-bg-gradient-1), var(--dark-bg-gradient-2));
              background-attachment: fixed;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              padding: 1rem 0;
              overflow-x: hidden;
              position: relative;
          }
          body::before {
              content: "";
              position: fixed;
              inset: 0;
              background: radial-gradient(circle at 20% 30%, rgba(106, 17, 203, 0.15) 0%, transparent 40%),
                          radial-gradient(circle at 80% 70%, rgba(37, 117, 252, 0.15) 0%, transparent 40%);
              z-index: -1;
          }
          a {
              text-decoration: none;
              color: inherit;
          }
          button {
              cursor: pointer;
              border: none;
              background: none;
          }
  
          /* --- Layout Utama --- */
          .container {
              width: 100%;
              max-width: 480px;
              padding: 0 0.75rem;
              margin-bottom: 1rem;
          }
  
          /* --- Kartu Utama --- */
          .card {
              background: var(--card-bg);
              border-radius: var(--border-radius-md);
              padding: 1.5rem;
              box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
              border: 1px solid rgba(106, 17, 203, 0.1);
              position: relative;
              overflow: hidden;
          }
          .card::before {
              content: "";
              position: absolute;
              top: 0;
              left: 0;
              width: 100%;
              height: 3px;
              background: linear-gradient(90deg, var(--primary-color), var(--secondary-color), var(--accent-color));
          }
          .title {
              font-family: "Orbitron", sans-serif;
              font-weight: 700;
              font-size: 1.8rem;
              text-align: center;
              margin-bottom: 1.5rem;
              background: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
              -webkit-background-clip: text;
              background-clip: text;
              color: transparent;
          }
          .profile-container {
              display: flex;
              flex-direction: column;
              align-items: center;
              margin-bottom: 1rem;
          }
          .profile-img {
              width: 120px;
              height: 120px;
              border-radius: 50%;
              object-fit: cover;
              border: 3px solid transparent;
              background: linear-gradient(145deg, var(--primary-color), var(--secondary-color)) border-box;
              box-shadow: 0 0 20px rgba(106, 17, 203, 0.5);
              margin-bottom: 1rem;
          }
          .status-badge {
              background: linear-gradient(45deg, #11998e, var(--success-color));
              color: white;
              padding: 6px 15px;
              border-radius: 20px;
              font-size: 0.9rem;
              font-weight: 600;
              box-shadow: 0 5px 15px rgba(56, 239, 125, 0.3);
              display: flex;
              align-items: center;
              gap: 8px;
          }
          .status-badge i {
              font-size: 0.8rem;
              animation: blink 2s infinite;
          }
          
          /* --- Daftar Info Protokol (BARU) --- */
          .info-list {
              display: flex;
              flex-direction: column;
              gap: 12px;
              margin-top: 1.5rem;
          }
          .info-item {
              background: rgba(0, 0, 0, 0.2);
              border: 1px solid rgba(255, 255, 255, 0.05);
              border-radius: 8px;
              padding: 12px 16px;
              display: flex;
              justify-content: space-between;
              align-items: center;
          }
          .info-label {
              display: flex;
              align-items: center;
              gap: 10px;
              font-size: 0.9rem;
              color: var(--text-secondary);
          }
          .info-label .icon {
              font-size: 0.9rem;
              opacity: 0.7;
              width: 16px;
              text-align: center;
          }
          .info-value {
              font-family: "Share Tech Mono", monospace;
              font-weight: 600;
              font-size: 1rem;
              color: var(--text-primary);
              background: rgba(106, 17, 203, 0.1);
              padding: 4px 8px;
              border-radius: 4px;
          }
  
          /* --- Footer --- */
          .footer {
              width: 100%;
              max-width: 480px;
              background: var(--card-bg);
              border-radius: var(--border-radius-md);
              padding: 1.2rem;
              border: 1px solid rgba(106, 17, 203, 0.1);
              box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
              text-align: center;
              margin: 0 0.75rem;
          }
          .footer-logo {
              font-family: "Orbitron", sans-serif;
              font-size: 1.1rem;
              margin-bottom: 0.4rem;
              background: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
              -webkit-background-clip: text;
              background-clip: text;
              color: transparent;
          }
          .footer-powered {
              font-size: 0.8rem;
              color: var(--text-secondary);
              margin-bottom: 0.6rem;
              font-family: "Share Tech Mono", monospace;
          }
          .footer-social {
              display: flex;
              justify-content: center;
              gap: 0.8rem;
              margin-bottom: 0.6rem;
              flex-wrap: wrap;
          }
          .social-link {
              color: var(--primary-color);
              font-family: "Share Tech Mono", monospace;
              font-size: 0.8rem;
              padding: 0.25rem 0.6rem;
              border-radius: 4px;
              background: rgba(106, 17, 203, 0.05);
              border: 1px solid rgba(106, 17, 203, 0.1);
              transition: var(--transition-normal);
              display: flex;
              align-items: center;
              gap: 0.3rem;
          }
          .social-link:hover {
              background: rgba(106, 17, 203, 0.1);
              box-shadow: var(--glow-primary);
              transform: translateY(-2px);
          }
          .social-icon {
              font-size: 14px;
          }
          .footer-year {
              font-family: "Orbitron", sans-serif;
              font-size: 0.8rem;
              color: var(--accent-color);
              margin-top: 0.4rem;
          }
  
          /* --- Tombol & Modal Donasi --- */
          .donate-btn {
              position: fixed;
              bottom: 30px;
              right: 30px;
              width: 60px;
              height: 60px;
              border-radius: 50%;
              background: linear-gradient(45deg, var(--primary-color), var(--secondary-color));
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font-size: 1.5rem;
              box-shadow: 0 5px 20px rgba(106, 17, 203, 0.5);
              z-index: 100;
              transition: var(--transition-normal);
              animation: pulse-donate 2s infinite;
          }
          .donate-btn:hover {
              transform: scale(1.1);
          }
          .donation-modal {
              position: fixed;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 1001;
              opacity: 0;
              visibility: hidden;
              transition: opacity 0.3s ease;
          }
          .donation-modal.active {
              opacity: 1;
              visibility: visible;
          }
          .donation-backdrop {
              position: absolute;
              inset: 0;
              background: rgba(0, 0, 0, 0.7);
              backdrop-filter: blur(5px);
          }
          .donation-content {
              position: relative;
              background: linear-gradient(to bottom right, #1e1e3f, var(--dark-bg));
              border-radius: var(--border-radius-lg);
              padding: 1px;
              width: 90%;
              max-width: 400px;
              transform: scale(0.9);
              transition: transform 0.3s ease;
          }
          .donation-modal.active .donation-content {
              transform: scale(1);
          }
          .donation-body {
              position: relative;
              background: var(--dark-bg);
              border-radius: calc(var(--border-radius-lg) - 1px);
              padding: 24px;
              text-align: center;
          }
          .close-donation {
              position: absolute;
              top: 10px;
              right: 10px;
              width: 30px;
              height: 30px;
              color: var(--text-secondary);
              background: rgba(255, 255, 255, 0.1);
              border-radius: 50%;
              transition: var(--transition-normal);
              display: flex;
              align-items: center;
              justify-content: center;
          }
          .close-donation:hover {
              transform: rotate(90deg);
          }
          .donation-title {
              font-size: 1.5rem;
              margin-bottom: 8px;
              background: linear-gradient(to right, var(--primary-color), var(--secondary-color));
              -webkit-background-clip: text;
              background-clip: text;
              color: transparent;
          }
          .donation-text {
              color: var(--text-secondary);
              font-size: 0.9rem;
              margin-bottom: 20px;
          }
          .qris-image {
              display: block;
              max-width: 100%;
              background: white;
              padding: 10px;
              border-radius: var(--border-radius-md);
          }
  
          /* --- Animasi --- */
          @keyframes blink {
              50% { opacity: 0.5; }
          }
          @keyframes pulse-donate {
              0% { box-shadow: 0 0 0 0 rgba(106, 17, 203, 0.7); transform: scale(1); }
              70% { box-shadow: 0 0 0 15px rgba(106, 17, 203, 0); transform: scale(1.05); }
              100% { box-shadow: 0 0 0 0 rgba(106, 17, 203, 0); transform: scale(1); }
          }
  
          /* --- Desain Responsif --- */
          @media (max-width: 480px) {
              body { padding: 0.5rem 0; }
              .container { padding: 0 0.5rem; }
              .title { font-size: 1.5rem; }
              .profile-img { width: 100px; height: 100px; }
              .donate-btn { width: 50px; height: 50px; font-size: 1.2rem; bottom: 20px; right: 20px; }
          }
      </style>
  </head>
  <body>
  
      <main class="container">
          <div class="card">
              <h1 class="title">AFRCloud - NET</h1>
              <div class="profile-container">
                  <img src="https://raw.githubusercontent.com/akulelaki696/bg/refs/heads/main/20250106_010158.jpg" alt="Incognito Mode Profile" class="profile-img">
                  <div class="status-badge">
                      <i class="fas fa-circle"></i> Active Services
                  </div>
              </div>
              
              <div class="info-list">
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-bolt icon"></i> Protokol</span>
                      <span class="info-value">VLESS</span>
                  </div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-server icon"></i> Proxy IP</span>
                      <span class="info-value">${proxyIP || 'Auto'}</span>
                  </div>
              </div>
  
          </div>
      </main>
      
      <footer class="footer">
          <div class="footer-logo">AFRCloud - NET</div>
          <div class="footer-powered">POWERED BY SECURE TECHNOLOGY</div>
          <div class="footer-social">
              <a href="https://t.me/Noir7R" class="social-link" target="_blank">
                  <i class="fab fa-telegram social-icon"></i> @Noir7R
              </a>
              <a href="https://t.me/inconigto_Mode" class="social-link" target="_blank">
                  <i class="fab fa-telegram social-icon"></i> @inconigto_Mode
              </a>
              <a href="https://t.me/InconigtoMode" class="social-link" target="_blank">
                  <i class="fab fa-telegram social-icon"></i> @InconigtoMode
              </a>
          </div>    
          <div class="footer-year">© <span id="current-year"></span></div>
      </footer>
      
      <button id="donation-button" class="donate-btn" aria-label="Donasi">
          <i class="fas fa-hand-holding-heart"></i>
      </button>
      
      <div id="donation-modal" class="donation-modal">
          <div class="donation-backdrop" id="donation-backdrop"></div>
          <div class="donation-content">
              <div class="donation-body">
                  <button id="close-donation" class="close-donation" aria-label="Tutup">
                      <i class="fas fa-times"></i>
                  </button>
                  <h3 class="donation-title">Support AFRCloud-NET</h3>
                  <p class="donation-text">Donasi Anda membantu layanan kami tetap berjalan.</p>
                  <img src="https://raw.githubusercontent.com/AFRcloud/SirenWeb/refs/heads/main/qrcode-0002010102%20(3).jpeg" alt="Donation QR Code" class="qris-image">
              </div>
          </div>
      </div>
      
      <script>
          document.addEventListener("DOMContentLoaded", () => {
              // Update tahun saat ini
              const yearSpan = document.getElementById('current-year');
              if (yearSpan) {
                  yearSpan.textContent = new Date().getFullYear();
              }
  
              // Logika untuk modal donasi
              const donationModal = document.getElementById('donation-modal');
              const openBtn = document.getElementById('donation-button');
              const closeBtn = document.getElementById('close-donation');
              const backdrop = document.getElementById('donation-backdrop');
  
              const openModal = () => donationModal.classList.add('active');
              const closeModal = () => donationModal.classList.remove('active');
  
              if (donationModal && openBtn && closeBtn && backdrop) {
                  openBtn.addEventListener('click', openModal);
                  closeBtn.addEventListener('click', closeModal);
                  backdrop.addEventListener('click', closeModal);
              }
          });
      </script>
  </body>
  </html>
  `;
}
