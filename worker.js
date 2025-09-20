import { connect } from "cloudflare:sockets"

let proxyIP = ""

const ACC = [
  {
    email: "rmtq@uma3.be",
    apiKey: "f472373dd6095b4a1fb25745589d7fde63d89", // global API key
    accountId: "58a8d77398a096cf15d2b8e39e2ad9c3",
    zoneId: "eecd039818d269c07ec5c0bd168dd1c5", // specific zone ID to monitor
    workerName: "cloudflared", // specific worker name to monitor
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

      // Method 1: Coba Analytics API v1
      try {
        const analyticsUrl = `https://api.cloudflare.com/client/v4/zones/${account.zoneId}/analytics/colos`
        const params = new URLSearchParams({
          since: `${startDate}T00:00:00Z`,
          until: `${endDate}T23:59:59Z`,
        })

        const response = await fetch(`${analyticsUrl}?${params}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Auth-Email": account.email,
            "X-Auth-Key": account.apiKey,
          },
        })

        if (response.ok) {
          const data = await response.json()
          if (data.success && data.result) {
            const totals = data.result.totals || {}
            totalBytes = totals.bytes?.all || 0
            totalRequests = totals.requests?.all || 0
            apiUsed = "Analytics API v1"
          }
        }
      } catch (e) {
        console.log("Analytics API v1 failed:", e.message)
      }

      // Method 2: Jika method 1 gagal, coba GraphQL
      if (totalBytes === 0 && totalRequests === 0) {
        try {
          const query = `
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
                      requests
                    }
                  }
                }
              }
            }
          `

          const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Auth-Email": account.email,
              "X-Auth-Key": account.apiKey,
            },
            body: JSON.stringify({
              query,
              variables: {
                zoneTag: account.zoneId,
                since: startDate,
                until: endDate,
              },
            }),
          })

          if (response.ok) {
            const data = await response.json()
            if (!data.errors && data.data?.viewer?.zones?.[0]) {
              const zoneData = data.data.viewer.zones[0]
              const httpData = zoneData.httpRequests1dGroups || []
              
              httpData.forEach(group => {
                if (group.sum) {
                  totalBytes += group.sum.bytes || 0
                  totalRequests += group.sum.requests || 0
                }
              })
              apiUsed = "GraphQL API"
            }
          }
        } catch (e) {
          console.log("GraphQL API failed:", e.message)
        }
      }

      // Method 3: Jika semua gagal, coba endpoint zone stats
      if (totalBytes === 0 && totalRequests === 0) {
        try {
          const statsUrl = `https://api.cloudflare.com/client/v4/zones/${account.zoneId}/analytics/dashboard`
          const params = new URLSearchParams({
            since: startDate,
            until: endDate,
          })

          const response = await fetch(`${statsUrl}?${params}`, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "X-Auth-Email": account.email,
              "X-Auth-Key": account.apiKey,
            },
          })

          if (response.ok) {
            const data = await response.json()
            if (data.success && data.result) {
              const timeseries = data.result.timeseries || []
              const totals = data.result.totals || {}
              
              if (timeseries.length > 0) {
                totalBytes = timeseries.reduce((sum, item) => sum + (item.bandwidth?.all || 0), 0)
                totalRequests = timeseries.reduce((sum, item) => sum + (item.requests?.all || 0), 0)
              } else {
                totalBytes = totals.bandwidth?.all || 0
                totalRequests = totals.requests?.all || 0
              }
              apiUsed = "Dashboard API"
            }
          }
        } catch (e) {
          console.log("Dashboard API failed:", e.message)
        }
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
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Secure Transport API</title>
    <style>
        :root {
            --primary-color: #3498db;
            --primary-dark: #2980b9;
            --bg-color: #f4f7f9;
            --card-bg: #ffffff;
            --text-color: #2c3e50;
            --muted-text: #7f8c8d;
            --success-color: #2ecc71;
            --error-color: #e74c3c;
            --border-color: #e1e1e1;
            --shadow: 0 4px 12px rgba(0,0,0,0.06);
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.6;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        h1 {
            text-align: center;
            color: var(--primary-dark);
            margin-bottom: 5px;
            font-size: 1.8em;
        }
        p.subtitle {
            text-align: center;
            color: var(--muted-text);
            margin-top: 0;
            margin-bottom: 20px;
        }
        .card {
            background-color: var(--card-bg);
            padding: 20px;
            border-radius: 12px;
            box-shadow: var(--shadow);
        }
        .status {
            padding: 15px;
            border-radius: 8px;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status.active {
            background-color: rgba(46, 204, 113, 0.1);
            color: var(--success-color);
            border: 1px solid rgba(46, 204, 113, 0.3);
        }
        .status.error {
            background-color: rgba(231, 76, 60, 0.1);
            color: var(--error-color);
            border: 1px solid rgba(231, 76, 60, 0.3);
        }
        .header-controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .period-selector {
            display: flex;
            justify-content: center;
            gap: 5px;
            margin-bottom: 15px;
        }
        .period-selector button {
            background-color: transparent;
            color: var(--muted-text);
            border: 1px solid var(--border-color);
            padding: 8px 12px;
            border-radius: 5px;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 0.9em;
        }
        .period-selector button.active {
            background-color: var(--primary-color);
            color: white;
            border-color: var(--primary-color);
        }
        .period-selector button:hover:not(.active) {
            background-color: #f5f5f5;
        }
        .bandwidth-item {
            border: 1px solid var(--border-color);
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .bandwidth-item .item-header {
            background-color: #f8f9fa;
            padding: 12px 15px;
            font-weight: 600;
            border-bottom: 1px solid var(--border-color);
            border-top-left-radius: 8px;
            border-top-right-radius: 8px;
        }
        .bandwidth-item .item-body {
            padding: 15px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            font-size: 0.95em;
        }
        .metric strong {
            color: var(--primary-dark);
            font-weight: 600;
        }
        .action-btn {
            background-color: var(--primary-color);
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: 600;
            transition: background-color 0.2s ease;
        }
        .action-btn:hover {
            background-color: var(--primary-dark);
        }
        #loading {
            display: none;
            text-align: center;
            color: var(--muted-text);
            font-style: italic;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Secure Transport Service</h1>
        <p class="subtitle">Pemantauan Bandwidth & Permintaan Worker</p>

        <div class="card">
            <h2>Status Layanan</h2>
            <div id="status" class="status active">
                <span style="font-size: 1.5em;">✅</span> Layanan Aktif
            </div>
        </div>
        
        <div class="card">
            <div class="header-controls">
                <h2>Data Bandwidth</h2>
                <button class="action-btn" onclick="loadBandwidth()">Refresh</button>
            </div>
            
            <div class="period-selector">
                <button onclick="loadBandwidth('1d')" id="btn-1d">1 Hari</button>
                <button onclick="loadBandwidth('7d')" id="btn-7d">7 Hari</button>
                <button onclick="loadBandwidth('30d')" id="btn-30d">30 Hari</button>
            </div>
            
            <div id="loading">Memuat data...</div>
            <div id="bandwidth-data"></div>
        </div>
    </div>

    <script>
        let currentPeriod = '1d';
        
        async function loadBandwidth(period = currentPeriod) {
            currentPeriod = period;
            
            document.querySelectorAll('.period-selector button').forEach(btn => {
                btn.classList.remove('active');
            });
            document.getElementById(\`btn-\${period}\`).classList.add('active');
            
            const loading = document.getElementById('loading');
            const dataDiv = document.getElementById('bandwidth-data');
            
            loading.style.display = 'block';
            dataDiv.innerHTML = '';
            
            try {
                const response = await fetch(\`/api/status?period=\${period}\`);
                const data = await response.json();
                
                loading.style.display = 'none';
                
                if (data.success && data.bandwidth && data.bandwidth.length > 0) {
                    data.bandwidth.forEach(item => {
                        const div = document.createElement('div');
                        div.className = 'bandwidth-item';
                        
                        if (item.error) {
                            div.innerHTML = \`
                                <div class="item-header">Worker: \${item.workerName || 'Tidak Diketahui'}</div>
                                <div class="item-body">
                                    <div class="status error">❌ Error: \${item.error}</div>
                                </div>
                            \`;
                        } else {
                            div.innerHTML = \`
                                <div class="item-header">Worker: \${item.workerName}</div>
                                <div class="item-body">
                                    <div class="metric"><span><strong>Bandwidth:</strong></span> <span>\${item.totalBandwidth}</span></div>
                                    <div class="metric"><span><strong>Permintaan:</strong></span> <span>\${item.totalRequests}</span></div>
                                    <div class="metric"><span><strong>Periode:</strong></span> <span>\${item.period}</span></div>
                                    <div class="metric"><span><strong>Rentang Tanggal:</strong></span> <span>\${item.dateRange}</span></div>
                                </div>
                            \`;
                        }
                        dataDiv.appendChild(div);
                    });
                } else {
                    const errorMsg = data.error ? \`Error: \${data.error}\` : 'Tidak ada data bandwidth tersedia. Silakan cek konfigurasi Anda.';
                    dataDiv.innerHTML = \`<div class="status error">❌ \${errorMsg}</div>\`;
                }
                
            } catch (error) {
                loading.style.display = 'none';
                dataDiv.innerHTML = \`<div class="status error">❌ Error memuat data: \${error.message}</div>\`;
            }
        }
        
        // Load data on page load with 1d default
        window.addEventListener('load', () => {
            loadBandwidth('1d');
        });
    </script>
</body>
</html>
  `
}
