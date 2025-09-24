import { connect } from "cloudflare:sockets"

let proxyIP = ""

const ACC = [
  {
    email: "domenhotinger@send4.uk",
    apiKey: "4487d852c2f36cd37f2cac793e70e6446f525", // global API key
    accountId: "d1c415a8bf7fe3631e4c5240a1f431f6",
    zoneId: "eac65277f126023700b60a4beba4d92c", // specific zone ID to monitor
    workerName: "vl", // specific worker name to monitor
  },
  // Add more accounts as needed
]

const WS_READY_STATE_OPEN = 1
const WS_READY_STATE_CLOSING = 2

const CMD_TCP = 1
const CMD_UDP = 2
const ATYP_IPV4 = 1
const ATYP_DOMAIN = 2
const ATYP_IPV6 = 3

const buildString = (parts) => parts.map((p) => String.fromCharCode(p)).join("")
const protocolName = buildString([86, 76, 69, 83, 83])
const serviceTitle = buildString([83, 101, 99, 117, 114, 101, 32, 84, 114, 97, 110, 115, 112, 111, 114, 116]) // "Secure Transport"

async function getBwReqSpecific(period = "7d") {
  const results = []

  // Calculate date range based on period
  const getDateRange = (period) => {
    const now = new Date()
    const endDate = now.toISOString().split("T")[0]
    let startDate
    let periodLabel

    switch (period) {
      case "1d":
        startDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
        periodLabel = "1 day"
        break
      case "7d":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
        periodLabel = "7 days"
        break
      case "30d":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
        periodLabel = "30 days"
        break
      
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
        periodLabel = "7 days"
    }

    return { startDate, endDate, periodLabel }
  }

  const { startDate, endDate, periodLabel } = getDateRange(period)

  for (const account of ACC) {
    if (!account.email || !account.apiKey || !account.accountId || !account.zoneId || !account.workerName) {
      continue
    }

    try {
      // Coba beberapa endpoint API yang berbeda
      let totalBytes = 0
      let totalRequests = 0
      let apiUsed = "unknown"
        try {
          const queryBandwidth = `
  query getZoneAnalytics($zoneTag: string!, $since: string!, $until: string!) {
    viewer {
      zones(filter: {zoneTag: $zoneTag}) {
        httpRequests1dGroups(
          filter: {
            date_geq: $since
            date_leq: $until
          }
          limit: 1000
        ) {
          sum {
            bytes
          }
        }
      }
    }
  }
`

const queryRequests = `
  query getWorkersRequests($accountTag: string!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
    viewer {
      accounts(filter: {accountTag: $accountTag}) {
        workersInvocationsAdaptive(limit: 10000, filter: $filter) {
          sum {
            requests
          }
        }
      }
    }
  }
`

const [responseBandwidth, responseRequests] = await Promise.all([
  fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Email": account.email,
      "X-Auth-Key": account.apiKey,
    },
    body: JSON.stringify({
      query: queryBandwidth,
      variables: {
        zoneTag: account.zoneId,
        since: startDate,
        until: endDate,
      },
    }),
  }),
  fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Email": account.email,
      "X-Auth-Key": account.apiKey,
    },
    body: JSON.stringify({
      query: queryRequests,
      variables: {
        accountTag: account.accountId,
        filter: {
          date_geq: startDate,
          date_leq: endDate,
          scriptName: account.workerName
        },
      },
    }),
  })
])

if (responseBandwidth.ok) {
  const data = await responseBandwidth.json()
  const httpData = data.data.viewer.zones[0].httpRequests1dGroups || []
  httpData.forEach(group => {
    totalBytes += group.sum?.bytes || 0
  })
}

if (responseRequests.ok) {
  const data = await responseRequests.json()
  const workersData = data.data.viewer.accounts[0].workersInvocationsAdaptive || []
  workersData.forEach(group => {
    totalRequests += group.sum?.requests || 0
  })
}
        } catch (e) {
          console.log("GraphQL API failed:", e.message)
        }
      if (totalBytes === 0 && totalRequests === 0) {
        throw new Error(`All API methods failed. Check API key permissions and zone ID.`)
      }

      const formatBytes = (bytes) => {
        if (bytes === 0) return "0 B"
        const k = 1024
        const sizes = ["B", "KB", "MB", "GB", "TB"]
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
      }

      const formatNumber = (num) => {
        return new Intl.NumberFormat().format(num)
      }

      results.push({
        accountId: account.accountId,
        zoneId: account.zoneId,
        workerName: account.workerName,
        totalBandwidth: formatBytes(totalBytes),
        totalRequests: formatNumber(totalRequests),
        rawBytes: totalBytes,
        rawRequests: totalRequests,
        period: periodLabel,
        dateRange: `${startDate} to ${endDate}`,
        note: `Zone analytics data via ${apiUsed}`,
      })
    } catch (error) {
      console.error(`Error fetching data for account ${account.accountId}:`, error)
      results.push({
        accountId: account.accountId,
        zoneId: account.zoneId || "N/A",
        workerName: account.workerName || "N/A",
        error: error.message,
        totalBandwidth: "0 B",
        totalRequests: "0",
        rawBytes: 0,
        rawRequests: 0,
        period: periodLabel,
        dateRange: `${startDate} to ${endDate}`,
      })
    }
  }

  return results
}

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get("Upgrade")
      const url = new URL(request.url)

      // Perbaikan: Menambahkan CORS headers untuk semua response
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }

      // Handle preflight requests
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 200,
          headers: corsHeaders
        })
      }

      if (!upgradeHeader || upgradeHeader !== "websocket") {
        const response = await handleApiRequest(request, url)
        // Perbaikan: Menambahkan CORS headers ke response
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value)
        })
        return response
      }

      // Extract proxy configuration from path
      if (url.pathname.includes("/") && url.pathname.length > 1) {
        const pathSegments = url.pathname.split("/")
        if (pathSegments[1]) {
          proxyIP = pathSegments[1]
        }
      }

      return await handleSecureUpgrade(request)
    } catch (err) {
      console.error("Service error:", err)
      return new Response(`Service temporarily unavailable: ${err.message}`, {
        status: 503,
        headers: { 
          "Content-Type": "text/plain",
          'Access-Control-Allow-Origin': '*'
        },
      })
    }
  },
}

async function handleApiRequest(request, url) {
  if (url.pathname === "/") {
    return new Response(getServicePage(), {
      headers: { "Content-Type": "text/html" },
    })
  }

  if (url.pathname === "/api/status") {
    try {
      const period = url.searchParams.get("period") || "7d"
      
      // Perbaikan: Menambahkan validasi period
      const validPeriods = ['1d', '7d', '30d', '365d']
      const selectedPeriod = validPeriods.includes(period) ? period : '7d'
      
      console.log(`Fetching bandwidth data for period: ${selectedPeriod}`)
      const bandwidthData = await getBwReqSpecific(selectedPeriod)

      return new Response(
        JSON.stringify({
          service: "active",
          timestamp: new Date().toISOString(),
          endpoint: proxyIP || "auto-detect",
          version: "2.1.0",
          period: selectedPeriod,
          bandwidth: bandwidthData,
          success: true
        }, null, 2),
        {
          headers: { "Content-Type": "application/json" },
        },
      )
    } catch (error) {
      console.error("Status API error:", error)
      return new Response(
        JSON.stringify({
          service: "active",
          timestamp: new Date().toISOString(),
          endpoint: proxyIP || "auto-detect",
          version: "2.1.0",
          bandwidth: [],
          error: error.message,
          success: false
        }, null, 2),
        {
          headers: { "Content-Type": "application/json" },
          status: 500
        },
      )
    }
  }

  if (url.pathname === "/api/config") {
    return new Response(
      JSON.stringify({
        transport: "websocket",
        encryption: "tls",
        compression: "auto",
        timestamp: new Date().toISOString(),
        success: true
      }, null, 2),
      {
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  // Perbaikan: Menambahkan endpoint untuk testing koneksi
  if (url.pathname === "/api/test") {
    return new Response(
      JSON.stringify({
        message: "API is working correctly",
        timestamp: new Date().toISOString(),
        success: true
      }, null, 2),
      {
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  // Endpoint untuk debug API permissions
  if (url.pathname === "/api/debug") {
    const results = []
    
    for (const account of ACC) {
      if (!account.email || !account.apiKey || !account.accountId || !account.zoneId) {
        continue
      }
      
      try {
        // Test basic zone access
        const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${account.zoneId}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Auth-Email": account.email,
            "X-Auth-Key": account.apiKey,
          },
        })
        
        const zoneData = await zoneResponse.json()
        
        results.push({
          accountId: account.accountId,
          zoneId: account.zoneId,
          zoneAccess: zoneResponse.ok,
          zoneName: zoneData.result?.name || "Unknown",
          zoneStatus: zoneData.result?.status || "Unknown",
          apiKeyValid: zoneResponse.ok,
          error: zoneResponse.ok ? null : `HTTP ${zoneResponse.status}: ${zoneData.errors?.[0]?.message || 'Unknown error'}`
        })
      } catch (error) {
        results.push({
          accountId: account.accountId,
          zoneId: account.zoneId,
          zoneAccess: false,
          apiKeyValid: false,
          error: error.message
        })
      }
    }
    
    return new Response(
      JSON.stringify({
        debug: results,
        timestamp: new Date().toISOString(),
        success: true
      }, null, 2),
      {
        headers: { "Content-Type": "application/json" },
      },
    )
  }
  return new Response("Not Found", { status: 404 })
}

async function handleSecureUpgrade(request) {
  const webSocketPair = new WebSocketPair()
  const [client, webSocket] = Object.values(webSocketPair)

  webSocket.accept()

  let address = ""
  let portWithRandomLog = ""

  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || "")
  }

  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || ""
  const readableWebSocketStream = createSecureStream(webSocket, earlyDataHeader, log)

  const remoteSocketWrapper = { value: null }
  let udpStreamWrite = null
  let isDns = false

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          try {
            // Perbaikan: Menambahkan validasi chunk
            if (!chunk || chunk.byteLength === 0) {
              log("Received empty chunk, skipping")
              return
            }

            if (isDns && udpStreamWrite) {
              return udpStreamWrite(chunk)
            }

            if (remoteSocketWrapper.value) {
              const writer = remoteSocketWrapper.value.writable.getWriter()
              await writer.write(chunk)
              writer.releaseLock()
              return
            }

            const headerResult = parseSecureHeader(chunk)
            if (headerResult.hasError) {
              throw new Error(headerResult.message)
            }

            const { addressRemote, portRemote, rawDataIndex, tunVersion, isUDP } = headerResult

            address = addressRemote
            portWithRandomLog = `${portRemote}--${Math.random().toString(36).substr(2, 9)} ${isUDP ? "udp" : "tcp"}`

            if (isUDP) {
              if (portRemote === 53) {
                isDns = true
              } else {
                throw new Error("UDP proxy only supported for DNS (port 53)")
              }
            }

            const tunResponseHeader = new Uint8Array([tunVersion[0], 0])
            const rawClientData = chunk.slice(rawDataIndex)

            if (isDns) {
              const { write } = await handleUDPOutbound(webSocket, tunResponseHeader, log)
              udpStreamWrite = write
              udpStreamWrite(rawClientData)
              return
            }

            await handleTCPOutbound(
              remoteSocketWrapper,
              addressRemote,
              portRemote,
              rawClientData,
              webSocket,
              tunResponseHeader,
              log,
            )
          } catch (error) {
            log("Processing error:", error.message)
            controller.error(error)
          }
        },

        close() {
          log("Secure stream closed")
        },

        abort(reason) {
          log("Secure stream aborted:", JSON.stringify(reason))
        },
      }),
    )
    .catch((err) => {
      log("Stream processing error:", err.message)
    })

  return new Response(null, {
    status: 101,
    webSocket: client,
  })
}

function createSecureStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false

  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) return
        
        // Perbaikan: Menambahkan validasi data
        if (!event.data) {
          log("Received empty message data")
          return
        }
        
        controller.enqueue(event.data)
      })

      webSocketServer.addEventListener("close", () => {
        safeCloseWebSocket(webSocketServer)
        if (!readableStreamCancel) {
          controller.close()
        }
      })

      webSocketServer.addEventListener("error", (err) => {
        log("WebSocket server error:", err.message)
        controller.error(err)
      })

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader)
      if (error) {
        controller.error(error)
      } else if (earlyData) {
        controller.enqueue(earlyData)
      }
    },

    pull(controller) {
      // No-op
    },

    cancel(reason) {
      if (readableStreamCancel) return
      log(`ReadableStream canceled: ${reason}`)
      readableStreamCancel = true
      safeCloseWebSocket(webSocketServer)
    },
  })

  return stream
}

function parseSecureHeader(buffer) {
  if (buffer.byteLength < 24) {
    return {
      hasError: true,
      message: "Invalid data: buffer too short",
    }
  }

  try {
    const version = new Uint8Array(buffer.slice(0, 1))

    const optLength = new Uint8Array(buffer.slice(17, 18))[0]
    const command = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0]

    let isUDP = false
    if (command === CMD_TCP) {
      isUDP = false
    } else if (command === CMD_UDP) {
      isUDP = true
    } else {
      return {
        hasError: true,
        message: `Unsupported command: ${command}. Supported: 1(TCP), 2(UDP)`,
      }
    }

    const portIndex = 18 + optLength + 1
    const portBuffer = buffer.slice(portIndex, portIndex + 2)
    const portRemote = new DataView(portBuffer).getUint16(0)

    const addressIndex = portIndex + 2
    const addressType = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0]

    let addressLength = 0
    let addressValueIndex = addressIndex + 1
    let addressValue = ""

    switch (addressType) {
      case ATYP_IPV4:
        addressLength = 4
        addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".")
        break

      case ATYP_DOMAIN:
        addressLength = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 1))[0]
        addressValueIndex += 1
        addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength))
        break

      case ATYP_IPV6:
        addressLength = 16
        const dataView = new DataView(buffer.slice(addressValueIndex, addressValueIndex + addressLength))
        const ipv6 = []
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(i * 2).toString(16))
        }
        addressValue = ipv6.join(":")
        break

      default:
        return {
          hasError: true,
          message: `Invalid address type: ${addressType}`,
        }
    }

    if (!addressValue) {
      return {
        hasError: true,
        message: `Empty address value for type ${addressType}`,
      }
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      addressType,
      portRemote,
      rawDataIndex: addressValueIndex + addressLength,
      tunVersion: version,
      isUDP,
    }
  } catch (error) {
    return {
      hasError: true,
      message: `Header parsing error: ${error.message}`,
    }
  }
}

async function handleTCPOutbound(
  remoteSocket,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  tunResponseHeader,
  log,
) {
  async function connectAndWrite(address, port) {
    try {
      const tcpSocket = connect({
        hostname: address,
        port: port,
      })

      remoteSocket.value = tcpSocket
      log(`Connected to ${address}:${port}`)

      const writer = tcpSocket.writable.getWriter()
      await writer.write(rawClientData)
      writer.releaseLock()

      return tcpSocket
    } catch (error) {
      log(`Connection failed to ${address}:${port}:`, error.message)
      throw error
    }
  }

  async function retry() {
    try {
      const [retryAddress, retryPort] = parseProxyAddress(proxyIP, addressRemote, portRemote)
      const tcpSocket = await connectAndWrite(retryAddress, retryPort)

      tcpSocket.closed
        .catch((error) => {
          log("Retry TCP socket closed with error:", error.message)
        })
        .finally(() => {
          safeCloseWebSocket(webSocket)
        })

      remoteSocketToWS(tcpSocket, webSocket, tunResponseHeader, null, log)
    } catch (error) {
      log("Retry failed:", error.message)
      safeCloseWebSocket(webSocket)
    }
  }

  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote)
    remoteSocketToWS(tcpSocket, webSocket, tunResponseHeader, retry, log)
  } catch (error) {
    log("Initial connection failed, attempting retry")
    await retry()
  }
}

async function remoteSocketToWS(remoteSocket, webSocket, tunResponseHeader, retry, log) {
  let hasIncomingData = false
  let tunHeader = tunResponseHeader

  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          hasIncomingData = true

          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error("WebSocket is not open")
            return
          }

          if (tunHeader) {
            webSocket.send(await new Blob([tunHeader, chunk]).arrayBuffer())
            tunHeader = null
          } else {
            webSocket.send(chunk)
          }
        },

        close() {
          log(`Remote connection closed. Had incoming data: ${hasIncomingData}`)
        },

        abort(reason) {
          log("Remote connection aborted:", reason)
        },
      }),
    )
  } catch (error) {
    log("remoteSocketToWS error:", error.message)
    safeCloseWebSocket(webSocket)
  }

  if (!hasIncomingData && retry) {
    log("No incoming data received, attempting retry")
    retry()
  }
}

async function handleUDPOutbound(webSocket, tunResponseHeader, log) {
  let isTunHeaderSent = false

  const dnsProviders = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query", "https://dns.google/dns-query"]

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2)
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0)
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength))
        index = index + 2 + udpPacketLength
        controller.enqueue(udpData)
      }
    },
  })

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          try {
            const dnsProvider = dnsProviders[Math.floor(Math.random() * dnsProviders.length)]

            const response = await fetch(dnsProvider, {
              method: "POST",
              headers: {
                "content-type": "application/dns-message",
              },
              body: chunk,
            })

            if (!response.ok) {
              throw new Error(`DNS query failed: ${response.status}`)
            }

            const dnsQueryResult = await response.arrayBuffer()
            const udpSize = dnsQueryResult.byteLength
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff])

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
              log(`DNS query successful, response length: ${udpSize}`)

              if (isTunHeaderSent) {
                webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer())
              } else {
                webSocket.send(await new Blob([tunResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer())
                isTunHeaderSent = true
              }
            }
          } catch (error) {
            log("DNS query error:", error.message)
          }
        },
      }),
    )
    .catch((error) => {
      log("UDP outbound error:", error.message)
    })

  const writer = transformStream.writable.getWriter()

  return {
    write(chunk) {
      writer.write(chunk)
    },
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null }
  }

  try {
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/")
    const decode = atob(base64Str)
    const arrayBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0))
    return { earlyData: arrayBuffer.buffer, error: null }
  } catch (error) {
    return { error }
  }
}

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close()
    }
  } catch (error) {
    console.error("Error closing WebSocket:", error)
  }
}

function parseProxyAddress(proxyIP, defaultAddress, defaultPort) {
  if (!proxyIP) {
    return [defaultAddress, defaultPort]
  }

  const parts = proxyIP.split(/[:=]/)
  const address = parts[0] || defaultAddress
  const port = parts[1] ? Number.parseInt(parts[1], 10) : defaultPort

  return [address, port]
}

function getServicePage() {
  return `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AFRCloud - NET || Home</title>
    <link rel="icon" href="https://raw.githubusercontent.com/AFRcloud/BG/main/icons8-film-noir-80.png">
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Rajdhani:wght@400;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {--primary-color: #6a11cb; --secondary-color: #2575fc; --accent-color: #ff6b6b; --success-color: #38ef7d; --dark-bg: #0f0c29; --dark-bg-gradient-1: #302b63; --dark-bg-gradient-2: #24243e; --card-bg: rgba(15, 14, 32, 0.8); --text-primary: #ffffff; --text-secondary: #a0a0ff; --border-color: rgba(255, 255, 255, 0.1); --border-radius-md: 12px; --border-radius-lg: 16px; --glow-primary: 0 0 10px rgba(106, 17, 203, 0.5), 0 0 20px rgba(106, 17, 203, 0.2); --transition-normal: all 0.3s ease;}
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {font-family: "Rajdhani", sans-serif; color: var(--text-primary); background: linear-gradient(135deg, var(--dark-bg), var(--dark-bg-gradient-1), var(--dark-bg-gradient-2)); background-attachment: fixed; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 1rem 0; overflow-x: hidden; position: relative;}
        body::before {content: ""; position: fixed; inset: 0; background: radial-gradient(circle at 20% 30%, rgba(106, 17, 203, 0.15) 0%, transparent 40%), radial-gradient(circle at 80% 70%, rgba(37, 117, 252, 0.15) 0%, transparent 40%); z-index: -1;}
        a { text-decoration: none; color: inherit; } button { cursor: pointer; border: none; background: none; }
        .container {width: 100%; max-width: 480px; padding: 0 0.75rem; margin-bottom: 1rem;}
        .card {background: var(--card-bg); border-radius: var(--border-radius-md); padding: 1.5rem; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5); border: 1px solid rgba(106, 17, 203, 0.1); position: relative; overflow: hidden;}
        .card::before {content: ""; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: linear-gradient(90deg, var(--primary-color), var(--secondary-color), var(--accent-color));}
        .title {font-family: "Orbitron", sans-serif; font-weight: 700; font-size: 1.8rem; text-align: center; margin-bottom: 1.5rem; background: linear-gradient(90deg, var(--primary-color), var(--secondary-color)); -webkit-background-clip: text; background-clip: text; color: transparent;}
        .profile-container {display: flex; flex-direction: column; align-items: center; margin-bottom: 1rem;}
        .profile-img {width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 3px solid transparent; background: linear-gradient(145deg, var(--primary-color), var(--secondary-color)) border-box; box-shadow: 0 0 20px rgba(106, 17, 203, 0.5); margin-bottom: 1rem;}
        .status-badge {background: linear-gradient(45deg, #11998e, var(--success-color)); color: white; padding: 6px 15px; border-radius: 20px; font-size: 0.9rem; font-weight: 600; box-shadow: 0 5px 15px rgba(56, 239, 125, 0.3); display: flex; align-items: center; gap: 8px;}
        .status-badge i { font-size: 0.8rem; animation: blink 2s infinite; }
        .info-list {display: flex; flex-direction: column; gap: 12px; margin-top: 1.5rem;}
        .info-item {background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center;}
        .info-label {display: flex; align-items: center; gap: 10px; font-size: 0.9rem; color: var(--text-secondary);}
        .info-label .icon {font-size: 0.9rem; opacity: 0.7; width: 16px; text-align: center;}
        .info-value {font-family: "Share Tech Mono", monospace; font-weight: 600; font-size: 1rem; color: var(--text-primary); background: rgba(106, 17, 203, 0.1); padding: 4px 8px; border-radius: 4px;}
        .footer {width: 100%; max-width: 480px; background: var(--card-bg); border-radius: var(--border-radius-md); padding: 1.2rem; border: 1px solid rgba(106, 17, 203, 0.1); box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3); text-align: center; margin: 0 0.75rem;}
        .footer-logo {font-family: "Orbitron", sans-serif; font-size: 1.1rem; margin-bottom: 0.4rem; background: linear-gradient(90deg, var(--primary-color), var(--secondary-color)); -webkit-background-clip: text; background-clip: text; color: transparent;}
        .footer-powered {font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.6rem; font-family: "Share Tech Mono", monospace;}
        .footer-social {display: flex; justify-content: center; gap: 0.8rem; margin-bottom: 0.6rem; flex-wrap: wrap;}
        .social-link {color: var(--primary-color); font-family: "Share Tech Mono", monospace; font-size: 0.8rem; padding: 0.25rem 0.6rem; border-radius: 4px; background: rgba(106, 17, 203, 0.05); border: 1px solid rgba(106, 17, 203, 0.1); transition: var(--transition-normal); display: flex; align-items: center; gap: 0.3rem;}
        .social-link:hover {background: rgba(106, 17, 203, 0.1); box-shadow: var(--glow-primary); transform: translateY(-2px);}
        .social-icon { font-size: 14px; }
        .footer-year {font-family: "Orbitron", sans-serif; font-size: 0.8rem; color: var(--accent-color); margin-top: 0.4rem;}
        .donate-btn {position: fixed; bottom: 30px; right: 30px; width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(45deg, var(--primary-color), var(--secondary-color)); display: flex; align-items: center; justify-content: center; color: white; font-size: 1.5rem; box-shadow: 0 5px 20px rgba(106, 17, 203, 0.5); z-index: 100; transition: var(--transition-normal); animation: pulse-donate 2s infinite;}
        .donate-btn:hover { transform: scale(1.1); }
        .donation-modal {position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 1001; opacity: 0; visibility: hidden; transition: opacity 0.3s ease;}
        .donation-modal.active { opacity: 1; visibility: visible; }
        .donation-backdrop {position: absolute; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(5px);}
        .donation-content {position: relative; background: linear-gradient(to bottom right, #1e1e3f, var(--dark-bg)); border-radius: var(--border-radius-lg); padding: 1px; width: 90%; max-width: 400px; transform: scale(0.9); transition: transform 0.3s ease;}
        .donation-modal.active .donation-content { transform: scale(1); }
        .donation-body {position: relative; background: var(--dark-bg); border-radius: calc(var(--border-radius-lg) - 1px); padding: 24px; text-align: center;}
        .close-donation {position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; color: var(--text-secondary); background: rgba(255, 255, 255, 0.1); border-radius: 50%; transition: var(--transition-normal); display: flex; align-items: center; justify-content: center;}
        .close-donation:hover { transform: rotate(90deg); }
        .donation-title {font-size: 1.5rem; margin-bottom: 8px; background: linear-gradient(to right, var(--primary-color), var(--secondary-color)); -webkit-background-clip: text; background-clip: text; color: transparent;}
        .donation-text { color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 20px; }
        .qris-image {display: block; max-width: 100%; background: white; padding: 10px; border-radius: var(--border-radius-md);}
        @keyframes blink { 50% { opacity: 0.5; } }
        @keyframes pulse-donate {0% { box-shadow: 0 0 0 0 rgba(106, 17, 203, 0.7); transform: scale(1); } 70% { box-shadow: 0 0 0 15px rgba(106, 17, 203, 0); transform: scale(1.05); } 100% { box-shadow: 0 0 0 0 rgba(106, 17, 203, 0); transform: scale(1); }}
        @media (max-width: 480px) {body { padding: 0.5rem 0; } .container { padding: 0 0.5rem; } .title { font-size: 1.5rem; } .profile-img { width: 100px; height: 100px; } .donate-btn { width: 50px; height: 50px; font-size: 1.2rem; bottom: 20px; right: 20px; }}
    </style>
</head>
<body>
    <main class="container">
        <div class="card">
            <h1 class="title">AFRCloud - NET</h1>
            <div class="profile-container">
                <img src="https://raw.githubusercontent.com/akulelaki696/bg/refs/heads/main/20250106_010158.jpg" alt="Incognito Mode Profile" class="profile-img">
                <div class="status-badge"><i class="fas fa-circle"></i> Active Services</div>
            </div>
            <div class="info-list">
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-bolt icon"></i> Protokol</span>
                    <span class="info-value">VLESS</span>
                </div>
                <div class="info-item">
                    <span class="info-label"><i class="fas fa-server icon"></i> Proxy IP</span>
                    <span class="info-value">1.1.1.1</span>
                </div>
            </div>
        </div>
    </main>
    <footer class="footer">
        <div class="footer-logo">AFRCloud - NET</div>
        <div class="footer-powered">POWERED BY SECURE TECHNOLOGY</div>
        <div class="footer-social">
            <a href="https://t.me/Noir7R" class="social-link" target="_blank"><i class="fab fa-telegram social-icon"></i> @Noir7R</a>
            <a href="https://t.me/inconigto_Mode" class="social-link" target="_blank"><i class="fab fa-telegram social-icon"></i> @inconigto_Mode</a>
            <a href="https://t.me/InconigtoMode" class="social-link" target="_blank"><i class="fab fa-telegram social-icon"></i> @InconigtoMode</a>
        </div>    
        <div class="footer-year">© <span id="current-year"></span></div>
    </footer>
    <button id="donation-button" class="donate-btn" aria-label="Donasi"><i class="fas fa-hand-holding-heart"></i></button>
    <div id="donation-modal" class="donation-modal">
        <div class="donation-backdrop" id="donation-backdrop"></div>
        <div class="donation-content">
            <div class="donation-body">
                <button id="close-donation" class="close-donation" aria-label="Tutup"><i class="fas fa-times"></i></button>
                <h3 class="donation-title">Support AFRCloud-NET</h3>
                <p class="donation-text">Donasi Anda membantu layanan kami tetap berjalan.</p>
                <img src="https://raw.githubusercontent.com/AFRcloud/SirenWeb/refs/heads/main/qrcode-0002010102%20(3).jpeg" alt="Donation QR Code" class="qris-image">
            </div>
        </div>
    </div>
    <script>
        document.addEventListener("DOMContentLoaded", () => {
            const yearSpan = document.getElementById('current-year');
            if (yearSpan) { yearSpan.textContent = new Date().getFullYear(); }
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
  `
}
