// VLESS Cloudflare Worker - Rebuilt and Enhanced
// Based on GAMFC version with improvements for reliability and maintainability

import { connect } from "cloudflare:sockets";

// Configuration
let proxyIP = '172.232.238.56';

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
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Worker Status</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #333;
        }
        .container {
            background: rgba(255, 255, 255, 0.95);
            padding: 30px;
            border-radius: 15px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            backdrop-filter: blur(10px);
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 30px;
            font-size: 2.5em;
        }
        .status-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            border-left: 4px solid #28a745;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .info-item {
            background: #e9ecef;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        .info-label {
            font-weight: bold;
            color: #495057;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .info-value {
            font-size: 1.2em;
            color: #007bff;
            margin-top: 5px;
        }
        .endpoint {
            background: #d1ecf1;
            border-left-color: #17a2b8;
            font-family: monospace;
            font-size: 0.9em;
        }
        .feature-list {
            list-style: none;
            padding: 0;
        }
        .feature-list li {
            padding: 8px 0;
            border-bottom: 1px solid #dee2e6;
        }
        .feature-list li:before {
            content: "✓";
            color: #28a745;
            font-weight: bold;
            margin-right: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 VLESS Worker</h1>
        
        <div class="status-card">
            <h3>✅ Worker Status: Active</h3>
            <p>Your VLESS proxy worker is running and ready to handle connections.</p>
        </div>
        
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Protocol</div>
                <div class="info-value">VLESS</div>
            </div>
            <div class="info-item">
                <div class="info-label">Transport</div>
                <div class="info-value">WebSocket</div>
            </div>
            <div class="info-item">
                <div class="info-label">Proxy IP</div>
                <div class="info-value">${proxyIP || 'Auto'}</div>
            </div>
            <div class="info-item">
                <div class="info-label">DNS Support</div>
                <div class="info-value">UDP Port 53</div>
            </div>
        </div>
        
        <div class="status-card">
            <h3>🔧 Features</h3>
            <ul class="feature-list">
                <li>TCP and UDP (DNS) proxy support</li>
                <li>WebSocket transport with early data</li>
                <li>Automatic connection retry</li>
                <li>IPv4, IPv6, and domain name resolution</li>
                <li>DNS over HTTPS integration</li>
                <li>Comprehensive error handling and logging</li>
            </ul>
        </div>
        
        <div class="status-card endpoint">
            <h3>📡 Endpoints</h3>
            <p><strong>WebSocket:</strong> wss://your-worker-domain.workers.dev/</p>
            <p><strong>Health Check:</strong> https://your-worker-domain.workers.dev/health</p>
            <p><strong>With Proxy IP:</strong> wss://your-worker-domain.workers.dev/proxy-ip:port</p>
        </div>
        
        <div class="status-card">
            <h3>⚡ Performance</h3>
            <p>This worker is optimized for:</p>
            <ul class="feature-list">
                <li>Low latency connections</li>
                <li>Efficient memory usage</li>
                <li>Automatic error recovery</li>
                <li>Scalable concurrent connections</li>
            </ul>
        </div>
    </div>
</body>
</html>
  `;
}
