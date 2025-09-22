let proxyIP = ""

const WS_READY_STATE_OPEN = 1
const WS_READY_STATE_CLOSING = 2

const CMD_TCP = 1
const CMD_UDP = 2
const ATYP_IPV4 = 1
const ATYP_DOMAIN = 2
const ATYP_IPV6 = 3

const buildString = (parts) => parts.map((p) => String.fromCharCode(p)).join("")
const protocolName = buildString([86, 76, 69, 83, 83])
const serviceTitle = buildString([83, 101, 99, 117, 114, 101, 32, 84, 114, 97, 110, 115, 112, 111, 114, 116])

const DEFAULT_DOMAINS = ["sub.afrcloudnet1.dpdns.org"]

function generateUUIDv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c == "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function getRandomDomain() {
  return DEFAULT_DOMAINS[Math.floor(Math.random() * DEFAULT_DOMAINS.length)]
}


export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get("Upgrade")
      const url = new URL(request.url)
      const path = url.pathname

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
      }

      if (path === "/subscription" || path === "/sub") {
        return handleSubscription(request, corsHeaders)
      } else if (path.startsWith("/sub/v2rayng")) {
        return handleParameterizedSubscription(request, corsHeaders, "v2rayng")
      } else if (path.startsWith("/sub/v2ray")) {
        return handleParameterizedSubscription(request, corsHeaders, "v2ray")
      } else if (path.startsWith("/sub/yaml")) {
        return handleParameterizedSubscription(request, corsHeaders, "yaml")
      } else if (path.startsWith("/sub/json")) {
        return handleParameterizedSubscription(request, corsHeaders, "json")
      } else if (path === "/config") {
        return handleConfig(request, corsHeaders)
      }      
    
       if (!upgradeHeader || upgradeHeader !== "websocket") {
        return handleApiRequest(request, url)
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
        headers: { "Content-Type": "text/plain" },
      })
    }
  },
}

async function handleApiRequest(request, url) {
  if (url.pathname === "/") {
    return handleHome({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    })
  }

  if (url.pathname === "/api/status") {
    return new Response(
      JSON.stringify({
        service: "active",
        timestamp: new Date().toISOString(),
        endpoint: proxyIP || "auto-detect",
        version: "2.1.0",
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  if (url.pathname === "/api/config") {
    return new Response(
      JSON.stringify({
        transport: "websocket",
        encryption: "tls",
        compression: "auto",
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  return fetch(request)
}

async function handleParameterizedSubscription(request, corsHeaders, format) {
  const url = new URL(request.url)

  const type = url.searchParams.get("type")
  const server = url.searchParams.get("server")
  const wildcard = url.searchParams.get("wildcard") === "true"
  const tls = url.searchParams.get("tls") === "true"
  const country = url.searchParams.get("country")
  const limit = Number.parseInt(url.searchParams.get("limit")) || 10
  const selectedDomain = url.searchParams.get("domain")

  try {
    const proxyListUrl = "https://raw.githubusercontent.com/AFRcloud/ProxyList/refs/heads/main/ProxyList.txt"
    const response = await fetch(proxyListUrl)
    const proxyData = await response.text()

    let proxies = proxyData
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => {
        const [ip, port, countryCode, provider] = line.split(",")
        return { ip: ip?.trim(), port: port?.trim(), country: countryCode?.trim(), provider: provider?.trim() }
      })
      .filter((proxy) => proxy.ip && proxy.port && proxy.country && proxy.provider)

    if (country) {
      proxies = proxies.filter((proxy) => proxy.country.toUpperCase() === country.toUpperCase())
    }

    proxies = proxies.slice(0, limit)

    const port = tls ? 443 : 80
    const security = tls ? "tls" : "none"
    const defaultDomain = selectedDomain && selectedDomain !== "random" ? selectedDomain : getRandomDomain()

    const configs = []

    proxies.forEach((proxy, index) => {
      const uuid = generateUUIDv4()
      const serverName = `${proxy.country} - ${proxy.provider}`
      const path = `/${proxy.ip}-${proxy.port}`

      let serverAddress, hostValue, sniValue

      if (server) {
        if (wildcard) {
          serverAddress = server
          hostValue = `${server}.${defaultDomain}`
          sniValue = tls ? `${server}.${defaultDomain}` : ""
        } else {
          serverAddress = server
          hostValue = defaultDomain
          sniValue = tls ? defaultDomain : ""
        }
      } else {
        serverAddress = defaultDomain
        hostValue = defaultDomain
        sniValue = tls ? defaultDomain : ""
      }

      if (format === "yaml") {
        
        if (!type || type === "mix" || type === "vless") {
          configs.push({
            name: `[${index + 1}] ${serverName} [VLESS]`,
            type: "vless",
            server: serverAddress,
            port: port,
            uuid: uuid,
            network: "ws",
            tls: tls,
            servername: sniValue,
            "skip-cert-verify": false,
            "ws-opts": {
              path: path,
              headers: {
                Host: hostValue,
              },
            },
          })
        }
        
      } else if (format === "json") {
        
        if (!type || type === "mix" || type === "vless") {
          configs.push({
            type: "vless",
            tag: `[${configs.length + 1}] ${proxy.country} - ${proxy.provider} [VLESS${tls ? "-TLS" : ""}]`,
            server: serverAddress,
            server_port: port,
            uuid: uuid,
            tls: {
              enabled: tls,
              server_name: sniValue,
              insecure: true,
            },
            transport: {
              type: "ws",
              path: path,
              headers: {
                Host: hostValue,
              },
            },
          })
        }
        
      } else {
        

        if (!type || type === "mix" || type === "vless") {
          const vlessConfig = `vless://${uuid}@${serverAddress}:${port}?encryption=none&security=${security}&type=ws&host=${hostValue}&path=${encodeURIComponent(path)}&sni=${sniValue}#[${configs.length + 1}] ${serverName} [VLESS${tls ? "-TLS" : ""}]`
          configs.push(vlessConfig)
        }

        
      }
    })

    let responseContent
    let contentType

    if (format === "yaml") {
      const yamlHeader = `# Clash Configuration
# Generated: ${new Date().toISOString()}
# Server: ${server || "default"}
# Wildcard: ${wildcard}
# Country: ${country || "ALL"}
# Type: ${type || "ALL"}
# Limit: ${limit}

proxies:`

      const yamlProxies = configs
        .map((config) => {
          const yamlLines = []
          yamlLines.push(`  - name: "${config.name}"`)
          yamlLines.push(`    type: ${config.type}`)
          yamlLines.push(`    server: ${config.server}`)
          yamlLines.push(`    port: ${config.port}`)

          if (config.type === "vless") {
            yamlLines.push(`    uuid: ${config.uuid}`)
            yamlLines.push(`    network: ${config.network}`)
            if (config.tls) yamlLines.push(`    tls: ${config.tls}`)
            if (config.servername) yamlLines.push(`    servername: ${config.servername}`)
            yamlLines.push(`    skip-cert-verify: ${config["skip-cert-verify"]}`)
            yamlLines.push(`    ws-opts:`)
            yamlLines.push(`      path: ${config["ws-opts"].path}`)
            yamlLines.push(`      headers:`)
            yamlLines.push(`        Host: ${config["ws-opts"].headers.Host}`)
          } 

          return yamlLines.join("\n")
        })
        .join("\n")

      responseContent = yamlHeader + "\n" + yamlProxies
      contentType = "text/yaml; charset=utf-8"
    } else if (format === "json") {
      const jsonConfig = {
        outbounds: configs,
      }
      responseContent = JSON.stringify(jsonConfig, null, 2)
      contentType = "application/json; charset=utf-8"
    } else {
      const configContent = configs.join("\n")
      if (format === "v2rayng") {
        responseContent = btoa(configContent)
      } else {
        responseContent = configContent
      }
      contentType = "text/plain; charset=utf-8"
    }

    return new Response(responseContent, {
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "Subscription-Userinfo": `upload=0; download=0; total=107374182400; expire=1735689600`,
      },
    })
  } catch (error) {
    return new Response(`Error fetching proxy list: ${error.message}`, {
      status: 500,
      headers: corsHeaders,
    })
  }
}

async function handleSubscription(request, corsHeaders) {
  const url = new URL(request.url)
  const userToken = url.searchParams.get("token") || url.searchParams.get("user")

  if (!userToken) {
    return new Response("Missing token parameter", {
      status: 400,
      headers: corsHeaders,
    })
  }

  try {
    const proxyListUrl = "https://raw.githubusercontent.com/AFRcloud/ProxyList/refs/heads/main/ProxyList.txt"
    const response = await fetch(proxyListUrl)
    const proxyData = await response.text()

    const proxies = proxyData
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => {
        const [ip, port, country, provider] = line.split(",")
        return { ip: ip?.trim(), port: port?.trim(), country: country?.trim(), provider: provider?.trim() }
      })
      .filter((proxy) => proxy.ip && proxy.port && proxy.country && proxy.provider)

    const domain = getRandomDomain()
    const port = 443
    const security = "tls"

    const allConfigs = []

    proxies.forEach((proxy, index) => {
      const uuid = generateUUIDv4()
      const serverName = `${proxy.country} - ${proxy.provider}`
      const path = `/${proxy.ip}-${proxy.port}`


      const vlessConfig = `vless://${uuid}@${domain}:${port}?encryption=none&security=${security}&type=ws&host=${domain}&path=${encodeURIComponent(path)}&sni=${domain}#[${index * 3 + 2}] ${serverName} [VLESS-TLS]`


      allConfigs.push(vlessConfig)
    })

    const configContent = allConfigs.join("\n")
    const subscriptionContent = btoa(configContent)

    return new Response(subscriptionContent, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "Subscription-Userinfo": `upload=0; download=0; total=107374182400; expire=1735689600`,
      },
    })
  } catch (error) {
    return new Response(`Error fetching proxy list: ${error.message}`, {
      status: 500,
      headers: corsHeaders,
    })
  }
}

async function handleConfig(request, corsHeaders) {
  const sampleConfig = {
    log: {
      loglevel: "warning",
    },
    inbounds: [
      {
        port: 1080,
        protocol: "socks",
        settings: {
          auth: "noauth",
        },
      },
    ],
    outbounds: [
      {
        protocol: "trojan",
        settings: {
          servers: [
            {
              address: "your-server.com",
              port: 443,
              password: "your-uuid-here",
            },
          ],
        },
        streamSettings: {
          network: "ws",
          security: "tls",
          wsSettings: {
            path: "/trojan",
            headers: {
              Host: "your-server.com",
            },
          },
        },
      },
    ],
  }

  return new Response(JSON.stringify(sampleConfig, null, 2), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  })
}

async function handleHome(corsHeaders) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AFRCloud - NET || Subscription</title>
    
    <!-- Favicon -->
    <link rel="icon" href="https://raw.githubusercontent.com/AFRcloud/BG/main/icons8-film-noir-80.png"/>
    
    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;700;900&family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
    
    <!-- Custom CSS -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* Applied complete cyberpunk theme from user's HTML file */
        :root {
          --color-bg: #0f0c29;
          --color-bg-card: rgba(15, 14, 32, 0.8);
          --color-primary: #6a11cb;
          --color-secondary: #2575fc;
          --color-accent: #ff6b6b;
          --color-text: #ffffff;
          --color-text-dim: #a0a0ff;
          --color-success: #38ef7d;
          --color-error: #ff2266;
          --color-input-bg: rgba(106, 17, 203, 0.05);
          --color-input-border: rgba(106, 17, 203, 0.2);
          --glow-primary: 0 0 10px rgba(106, 17, 203, 0.5), 0 0 20px rgba(106, 17, 203, 0.2);
          --glow-secondary: 0 0 10px rgba(37, 117, 252, 0.5), 0 0 20px rgba(37, 117, 252, 0.2);
          --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          --card-width: 100%;
          --card-max-width: 480px;
          --card-padding: 1.5rem;
          --card-border-radius: 12px;
        }

        body {
          font-family: "Rajdhani", sans-serif;
          background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
          color: var(--color-text);
          line-height: 1.6;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          background-attachment: fixed;
          position: relative;
          overflow-x: hidden;
          padding: 1rem 0;
        }

        body::before {
          content: "";
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background-image: radial-gradient(circle at 20% 30%, rgba(106, 17, 203, 0.15) 0%, transparent 40%),
            radial-gradient(circle at 80% 70%, rgba(37, 117, 252, 0.15) 0%, transparent 40%);
          z-index: -1;
        }

        .container {
          width: var(--card-width);
          max-width: var(--card-max-width);
          padding: 0 0.75rem;
        }

        .card {
          background: var(--color-bg-card);
          border-radius: var(--card-border-radius);
          padding: var(--card-padding);
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(106, 17, 203, 0.1);
          width: 90%;
        }

        .card::before,
        .footer::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 3px;
          background: linear-gradient(90deg, var(--color-primary), var(--color-secondary), var(--color-accent));
        }

        .card::after,
        .footer::after {
          content: "";
          position: absolute;
          top: 3px;
          left: 0;
          width: 100%;
          height: 1px;
          background: linear-gradient(90deg, rgba(106, 17, 203, 0.5), rgba(37, 117, 252, 0.5), rgba(255, 107, 107, 0.5));
          filter: blur(1px);
        }

        .title-container {
          text-align: center;
          margin-bottom: 1.5rem;
          position: relative;
        }

        .title {
          font-family: "Orbitron", sans-serif;
          font-weight: 700;
          font-size: 1.8rem;
          letter-spacing: 1px;
          margin: 0;
          background: linear-gradient(90deg, var(--color-primary), var(--color-secondary));
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          position: relative;
          display: inline-block;
        }

        .title::after {
          content: "SUBLINK";
          position: absolute;
          top: -8px;
          right: -30px;
          font-size: 0.7rem;
          font-weight: 400;
          background: var(--color-accent);
          color: var(--color-bg);
          padding: 2px 5px;
          border-radius: 3px;
          -webkit-text-fill-color: var(--color-bg);
          transform: rotate(15deg);
        }

        .subtitle {
          font-size: 0.9rem;
          color: var(--color-text-dim);
          margin-top: 0.3rem;
        }

        .form-group {
          margin-bottom: 1.2rem;
          position: relative;
        }

        .form-group label {
          display: block;
          margin-bottom: 0.3rem;
          font-weight: 600;
          font-size: 0.95rem;
          color: var(--color-text);
          letter-spacing: 0.5px;
        }

        .form-control {
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          padding: 0.7rem 0.8rem;
          background: var(--color-input-bg);
          border: 1px solid var(--color-input-border);
          border-radius: 8px;
          color: var(--color-text);
          font-family: "Rajdhani", sans-serif;
          font-size: 0.95rem;
          font-weight: 500;
          transition: var(--transition);
          animation: randomGlow 3s ease-in-out infinite;
        }

        .form-control:focus {
          outline: none;
          border-color: var(--color-primary);
          box-shadow: var(--glow-primary);
          background: rgba(106, 17, 203, 0.1);
        }

        @keyframes randomGlow {
          0%, 100% { box-shadow: 0 0 5px rgba(106, 17, 203, 0.3); }
          25% { box-shadow: 0 0 8px rgba(37, 117, 252, 0.4); }
          50% { box-shadow: 0 0 6px rgba(255, 107, 107, 0.3); }
          75% { box-shadow: 0 0 7px rgba(56, 239, 125, 0.3); }
        }

        .floating-particles {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: -1;
        }

        .particle {
          position: absolute;
          width: 2px;
          height: 2px;
          border-radius: 50%;
          background: var(--color-primary);
          opacity: 0.6;
        }

        @keyframes float {
          0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.6; }
          50% { transform: translateY(-20px) rotate(180deg); opacity: 1; }
        }

        .btn-primary {
          background: linear-gradient(135deg, var(--color-primary), var(--color-secondary));
          border: none;
          color: var(--color-text);
          padding: 0.8rem 1.5rem;
          border-radius: 8px;
          font-weight: 600;
          font-size: 1rem;
          cursor: pointer;
          transition: var(--transition);
          text-transform: uppercase;
          letter-spacing: 1px;
          width: 100%;
          position: relative;
          overflow: hidden;
          animation: randomColorShift 4s ease-in-out infinite;
        }

        @keyframes randomColorShift {
          0%, 100% { filter: hue-rotate(0deg); }
          25% { filter: hue-rotate(30deg); }
          50% { filter: hue-rotate(-20deg); }
          75% { filter: hue-rotate(15deg); }
        }

        .btn {
          width: 100%;
          padding: 0.8rem;
          background: linear-gradient(90deg, var(--color-primary), var(--color-secondary));
          color: white;
          border: none;
          border-radius: 8px;
          font-family: "Orbitron", sans-serif;
          font-weight: 600;
          font-size: 1rem;
          letter-spacing: 1px;
          cursor: pointer;
          transition: var(--transition);
          position: relative;
          overflow: hidden;
          text-transform: uppercase;
        }

        .btn::before {
          content: "";
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
          transition: 0.5s;
        }

        .btn:hover::before {
          left: 100%;
        }

        .btn:hover {
          box-shadow: var(--glow-primary);
          transform: translateY(-2px);
        }

        .loading {
          display: none;
          text-align: center;
          margin: 1.5rem 0;
          color: var(--color-primary);
        }

        .spinner {
          display: inline-block;
          width: 40px;
          height: 40px;
          border: 3px solid rgba(106, 17, 203, 0.1);
          border-radius: 50%;
          border-top-color: var(--color-primary);
          animation: spin 1s ease-in-out infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .loading-text {
          margin-top: 0.8rem;
          font-family: "Share Tech Mono", monospace;
          font-size: 0.9rem;
          letter-spacing: 1px;
        }

        .result {
          display: none;
          margin-top: 1.5rem;
          position: relative;
          width: var(--card-width);
          max-width: var(--card-max-width);
          margin-left: auto;
          margin-right: auto;
        }

        .result-header {
          margin-bottom: 1rem;
        }

        .result-title {
          color: var(--color-success);
          font-family: "Orbitron", sans-serif;
          font-weight: 700;
          font-size: 1.1rem;
          text-align: center;
          text-transform: uppercase;
          letter-spacing: 2px;
          margin-bottom: 1rem;
        }

        .output-container {
          margin-bottom: 1rem;
        }

        .output {
          width: 100%;
          min-height: 120px;
          background: rgba(15, 15, 35, 0.8);
          border: 1px solid var(--color-primary);
          border-radius: 8px;
          color: var(--color-text);
          font-family: "Courier New", monospace;
          font-size: 0.85rem;
          padding: 1rem;
          resize: vertical;
          box-sizing: border-box;
        }

        .output:focus {
          outline: none;
          border-color: var(--color-accent);
          box-shadow: 0 0 10px rgba(138, 43, 226, 0.3);
        }

        .button-container {
          display: flex;
          gap: 0.8rem;
          width: 100%;
          margin-bottom: 1rem;
        }

        .copy-btn {
          background: linear-gradient(90deg, var(--color-success), var(--color-primary));
          color: var(--color-bg);
          border: none;
          border-radius: 8px;
          padding: 0.5rem 0.8rem;
          font-family: "Rajdhani", sans-serif;
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          transition: var(--transition);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          flex: 1;
          height: 40px;
        }

        .copy-btn:hover {
          box-shadow: 0 0 10px rgba(0, 255, 170, 0.5);
          transform: translateY(-2px);
        }

        .go-btn {
          background: linear-gradient(90deg, var(--color-primary), var(--color-accent));
          color: var(--color-bg);
          border: none;
          border-radius: 8px;
          padding: 0.5rem 0.8rem;
          font-family: "Rajdhani", sans-serif;
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          transition: var(--transition);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          flex: 1;
          height: 40px;
        }

        .go-btn:hover {
          box-shadow: 0 0 10px rgba(138, 43, 226, 0.5);
          transform: translateY(-2px);
        }

        .error-message {
          color: var(--color-error);
          text-align: center;
          margin-top: 0.8rem;
          font-weight: 500;
          font-size: 0.9rem;
        }

        /* Responsive adjustments */
        @media (max-width: 480px) {
          :root {
            --card-padding: 1.2rem;
          }

          .container {
            padding: 0 0.5rem;
          }

          .title {
            font-size: 1.5rem;
          }

          .subtitle {
            font-size: 0.8rem;
          }

          .form-group label {
            font-size: 0.9rem;
          }

          .form-control {
            padding: 0.6rem 0.7rem;
            font-size: 0.9rem;
          }

          .btn {
            padding: 0.7rem;
            font-size: 0.9rem;
          }
        }

        .form-row {
          display: flex;
          gap: 0.8rem;
          margin-bottom: 1.2rem;
          width: 100%;
          box-sizing: border-box;
        }

        .form-row .form-group {
          flex: 1;
          margin-bottom: 0;
          min-width: 0;
        }

        

        .copy-icon, .go-icon {
          width: 16px;
          height: 16px;
        }

        .domain-status-btn {
            background: rgba(139, 69, 255, 0.2);
            border: 1px solid rgba(139, 69, 255, 0.5);
            color: #8b45ff;
            padding: 0.3rem 0.6rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.7rem;
            margin-left: 0.5rem;
            transition: all 0.3s ease;
        }
        
        .domain-status-btn:hover {
            background: rgba(139, 69, 255, 0.3);
            transform: translateY(-1px);
        }
        
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 1000;
        }
        
        .modal-content {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 1px solid rgba(139, 69, 255, 0.3);
            border-radius: 12px;
            padding: 1rem;
            max-width: 380px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }
        
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }
        
        .modal-title {
            color: #8b45ff;
            font-size: 1rem;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .close-btn {
            background: none;
            border: none;
            color: #fff;
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0;
            width: 30px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .close-btn:hover {
            color: #8b45ff;
        }
        
        .domain-status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 0.5rem;
            margin-bottom: 1rem;
        }
        
        .domain-status-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5rem;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 4px;
            font-size: 0.8rem;
        }
        
        .domain-name {
            color: #fff;
            font-weight: 500;
        }
        
        .status-badge {
            padding: 0.2rem 0.5rem;
            border-radius: 12px;
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .status-working {
            background: #10b981;
            color: white;
        }
        
        .status-rate-limited {
            background: #ef4444;
            color: white;
        }
        
        .status-error {
            background: #f59e0b;
            color: white;
        }
        
        .status-timeout {
            background: #6b7280;
            color: white;
        }
        
        .status-loading {
            text-align: center;
            color: #8b45ff;
            font-style: italic;
        }
        
        .refresh-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.8rem;
            transition: all 0.3s ease;
        }
        
        .refresh-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        /* Footer styles */
        .footer {
          width: var(--card-width);
          max-width: var(--card-max-width);
          background: var(--color-bg-card);
          border-radius: var(--card-border-radius);
          position: relative;
          border: 1px solid rgba(106, 17, 203, 0.1);
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          overflow: hidden;
          margin: 0 0.75rem;
          width: 100%;
        }

        .footer-logo {
          font-family: "Orbitron", sans-serif;
          font-weight: 700;
          font-size: 1.1rem;
          margin-bottom: 0.4rem;
          background: linear-gradient(90deg, var(--color-primary), var(--color-secondary));
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          position: relative;
          display: inline-block;
        }

        .footer-powered {
          font-size: 0.8rem;
          color: var(--color-text-dim);
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
          color: var(--color-primary);
          text-decoration: none;
          font-family: "Share Tech Mono", monospace;
          font-size: 0.8rem;
          padding: 0.25rem 0.6rem;
          border-radius: 4px;
          background: rgba(106, 17, 203, 0.05);
          border: 1px solid rgba(106, 17, 203, 0.1);
          transition: var(--transition);
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
          width: 14px;
          height: 14px;
        }

        .footer-year {
          font-family: "Orbitron", sans-serif;
          font-weight: 600;
          font-size: 0.8rem;
          color: var(--color-accent);
          margin-top: 0.4rem;
          letter-spacing: 1px;
        }

        .circuit-line {
          position: absolute;
          background: var(--color-primary);
          opacity: 0.1;
        }

        .circuit-line-1 {
          width: 60px;
          height: 1px;
          top: 20px;
          left: 20px;
        }

        .circuit-line-2 {
          width: 1px;
          height: 30px;
          top: 20px;
          left: 20px;
        }

        .circuit-line-3 {
          width: 40px;
          height: 1px;
          bottom: 25px;
          right: 30px;
        }

        .circuit-line-4 {
          width: 1px;
          height: 25px;
          bottom: 25px;
          right: 30px;
        }

        .circuit-dot {
          position: absolute;
          width: 3px;
          height: 3px;
          border-radius: 50%;
          background: var(--color-primary);
          opacity: 0.2;
        }

        .circuit-dot-1 {
          top: 20px;
          left: 20px;
        }

        .circuit-dot-2 {
          top: 50px;
          left: 20px;
        }

        .circuit-dot-3 {
          bottom: 25px;
          right: 30px;
        }

        .circuit-dot-4 {
          bottom: 50px;
          right: 30px;
        }

        .copy-icon, .go-icon {
          width: 16px;
          height: 16px;
          
    </style>
</head>
<body>
    <div class="floating-particles" id="particles"></div>
    <div class="container">
        <div class="card">
            <div class="title-container">
              <h1 class="title">AFRCloud - NET</h1>
                <p class="subtitle">Advanced Subscription Link Generator</p>
                  <button type="button" class="btn btn-primary" onclick="window.location.href='https://afrcloud.fun/'">
                    <i class="fas fa-home mr-2"></i>HOME
                  </button>
            </div>
            
            <form id="configForm">
                <div class="form-group">
                    <label for="format">FORMAT TYPE</label>
                    <select id="format" name="format" class="form-control">
                        <option value="v2rayng">Link V2RAYNG</option>
                        <option value="v2ray">Link V2RAY</option>
                        <option value="yaml">Config CLASH</option>
                        <option value="json">Config JSON</option>
                    </select>
                </div>

                <div class="form-group">
                    <label for="type">PROTOCOL TYPE</label>
                    <select id="type" name="type" class="form-control">
                        <option value="vless">VLESS</option>
                    </select>
                </div>

                <div class="form-group">
                    <label for="domain">MAIN DOMAIN 
                    </label>
                    <select id="domain" name="domain" class="form-control">
                        <option value="random">Random (Default)</option>
                    </select>
                </div>

                <div class="form-group">
                    <label for="server">CUSTOM SERVER</label>
                    <input type="text" id="server" name="server" class="form-control" placeholder="support.zoom.us">
                </div>

                <div class="form-group">
                    <label for="tls">TLS ENCRYPTION</label>
                    <select id="tls" name="tls" class="form-control">
                    <option value="true">ENABLED</option>    
                    <option value="false">DISABLED</option>
                    </select>
                </div>

                <div class="form-row">
                    <div class="form-group">
                        <label for="country">REGION FILTER</label>
                        <select id="country" name="country" class="form-control">
                            <option value="">Loading regions...</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label for="limit">QUANTITY</label>
                        <input type="number" id="limit" name="limit" class="form-control" min="1" max="50" value="5" placeholder="Max 50" required>
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-check">
                        <input type="checkbox" id="wildcard" name="wildcard" class="form-check-input">
                        <span class="form-check-label">Enable Wildcard Mode</span>
                    </label>
                </div>

                <button type="submit" class="btn btn-primary">Generate Link Configuration</button>
            </form>

            <div id="loading" class="loading">
                <div class="spinner"></div>
                <div class="loading-text">Please Wait.............</div>
            </div>

            <div id="error-message" class="error-message"></div>

            <div id="result" class="result">
                <div class="result-header">
                    <div class="result-title">LINK CONFIGURATION GENERATED</div>
                </div>
                <div class="output-container">
                    <textarea id="output" class="output" readonly></textarea>
                </div>
                <div class="button-container">
                    <button id="copyLink" class="copy-btn">
                        <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        COPY CONFIGURATION
                    </button>
                    <button id="goLink" class="go-btn">
                        <svg class="go-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                        </svg>
                        GO URL
                    </button>
                </div>
            </div>
        </div>

        
    </div><br>

    <footer class="footer">
        <div class="circuit-line circuit-line-1"></div>
        <div class="circuit-line circuit-line-2"></div>
        <div class="circuit-line circuit-line-3"></div>
        <div class="circuit-line circuit-line-4"></div>
        <div class="circuit-dot circuit-dot-1"></div>
        <div class="circuit-dot circuit-dot-2"></div>
        <div class="circuit-dot circuit-dot-3"></div>
        <div class="circuit-dot circuit-dot-4"></div>
        <br>
        
        <div class="footer-logo">AFRCloud - NET</div>
        <div class="footer-powered">POWERED BY SECURE TECHNOLOGY</div>
        <div class="footer-social">
            <a href="https://t.me/Noir7R" class="social-link" target="_blank">
                <svg class="social-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-8.609 3.33c-2.068.8-4.133 1.598-5.724 2.21a405.15 405.15 0 0 1-2.849 1.09c-.42.147-.99.332-1.473.901-.728.968.193 1.798.919 2.286 1.61.516 3.275 1.009 4.654 1.472.846 1.467 1.618 2.796 2.503 4.532.545 1.062 1.587 2.739 3.19 2.756 1.26.033 2.052-.6 3.542-1.95a142.91 142.91 0 0 1 2.43-2.053c1.686-.142 3.382-.284 5.12-.436.887-.075 1.92-.262 2.405-1.226.436-.877-.015-1.35-.48-1.874l-3.881-4.369-5.481-6.174S22.185 2.128 21.198 2.433z"></path>
                    <path d="M18.167 7.068c.237 1.632-1.162 6.872-1.766 8.849"></path>
                </svg>
                @Noir7R
            </a>
        </div>    
        <div class="footer-social">
            <a href="https://t.me/inconigto_Mode" class="social-link" target="_blank">
                <svg class="social-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-8.609 3.33c-2.068.8-4.133 1.598-5.724 2.21a405.15 405.15 0 0 1-2.849 1.09c-.42.147-.99.332-1.473.901-.728.968.193 1.798.919 2.286 1.61.516 3.275 1.009 4.654 1.472.846 1.467 1.618 2.796 2.503 4.532.545 1.062 1.587 2.739 3.19 2.756 1.26.033 2.052-.6 3.542-1.95a142.91 142.91 0 0 1 2.43-2.053c1.686-.142 3.382-.284 5.12-.436.887-.075 1.92-.262 2.405-1.226.436-.877-.015-1.35-.48-1.874l-3.881-4.369-5.481-6.174S22.185 2.128 21.198 2.433z"></path>
                    <path d="M18.167 7.068c.237 1.632-1.162 6.872-1.766 8.849"></path>
                </svg>
                @inconigto_Mode
            </a>
            <a href="https://t.me/InconigtoMode" class="social-link" target="_blank">
                <svg class="social-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-8.609 3.33c-2.068.8-4.133 1.598-5.724 2.21a405.15 405.15 0 0 1-2.849 1.09c-.42.147-.99.332-1.473.901-.728.968.193 1.798.919 2.286 1.61.516 3.275 1.009 4.654 1.472.846 1.467 1.618 2.796 2.503 4.532.545 1.062 1.587 2.739 3.19 2.756 1.26.033 2.052-.6 3.542-1.95a142.91 142.91 0 0 1 2.43-2.053c1.686-.142 3.382-.284 5.120-.436.887-.075 1.92-.262 2.405-1.226.436-.877-.015-1.35-.48-1.874l-3.881-4.369-5.481-6.174S22.185 2.128 21.198 2.433z"></path>
                    <path d="M18.167 7.068c.237 1.632-1.162 6.872-1.766 8.849"></path>
                </svg>
                @InconigtoMode
            </a>
        </div>
        <div class="footer-year">© <span id="current-year"></span></div><br>
    </footer>

    <script>
        const DEFAULT_DOMAINS = ${JSON.stringify(DEFAULT_DOMAINS)};

        function loadDomains() {
            const domainSelect = document.getElementById('domain');
            DEFAULT_DOMAINS.forEach(domain => {
                const option = document.createElement('option');
                option.value = domain;
                option.textContent = domain;
                domainSelect.appendChild(option);
            });
        }

        async function loadCountries() {
            const countrySelect = document.getElementById('country');
            countrySelect.innerHTML = '<option value="">Loading countries...</option>';
            countrySelect.disabled = true;

            setTimeout(async () => {
                try {
                    const response = await fetch('https://raw.githubusercontent.com/AFRcloud/ProxyList/refs/heads/main/ProxyList.txt');
                    const proxyData = await response.text();
                    const countries = new Set();
                    const lines = proxyData.split('\\n').filter(line => line.trim() && !line.startsWith('#'));

                    lines.forEach(line => {
                        const parts = line.split(',');
                        if (parts.length >= 3) {
                            const countryCode = parts[2].trim();
                            if (countryCode) {
                                countries.add(countryCode);
                            }
                        }
                    });

                    countrySelect.innerHTML = '<option value="">All Countries</option>';
                    const sortedCountries = Array.from(countries).sort();
                    sortedCountries.forEach(country => {
                        const option = document.createElement('option');
                        option.value = country;
                        option.textContent = country;
                        countrySelect.appendChild(option);
                    });

                    countrySelect.disabled = false;
                } catch (error) {
                    console.error('Failed to load countries:', error);
                    countrySelect.innerHTML = '<option value="">All Countries (Failed to load)</option>';
                    countrySelect.disabled = false;
                }
            }, 100);
        }

        document.addEventListener('DOMContentLoaded', function() {
            loadDomains();
            createRandomParticles();
            randomizeTitleColor();

            requestAnimationFrame(() => {
                loadCountries();
            });

            document.getElementById('configForm').addEventListener('submit', function(e) {
                e.preventDefault();

                const type = document.getElementById('type').value;
                const format = document.getElementById('format').value;
                const domain = document.getElementById('domain').value;
                const server = document.getElementById('server').value;
                const tls = document.getElementById('tls').value;
                const country = document.getElementById('country').value;
                const limit = document.getElementById('limit').value;
                const wildcard = document.getElementById('wildcard').checked;

                const params = new URLSearchParams();
                if (type) params.append('type', type);
                if (server) params.append('server', server);
                if (domain && domain !== 'random') params.append('domain', domain);
                if (country) params.append('country', country);
                if (limit) params.append('limit', limit);
                if (wildcard) params.append('wildcard', 'true');
                if (tls === 'true') params.append('tls', 'true');

                const baseUrl = window.location.origin;
                const endpoint = '/sub/' + format;
                const fullUrl = baseUrl + endpoint + '?' + params.toString();

                document.getElementById('output').value = fullUrl;
                document.getElementById('result').style.display = 'block';
            });

            document.getElementById('copyLink').addEventListener('click', function() {
                const output = document.getElementById('output');
                output.select();
                document.execCommand('copy');
                const originalText = this.innerHTML;
                this.innerHTML = '<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>COPIED!';

                setTimeout(() => {
                    this.innerHTML = originalText;
                }, 2000);
            });

            document.getElementById('goLink').addEventListener('click', function() {
                const url = document.getElementById('output').value;
                if (url) {
                    window.open(url, '_blank');
                }
            });
        });

        function openDomainStatusModal() {
            document.getElementById('domainStatusModal').style.display = 'flex';
            checkDomainStatus();
        }

        function closeDomainStatusModal() {
            document.getElementById('domainStatusModal').style.display = 'none';
        }

        document.getElementById('domainStatusModal').addEventListener('click', function(e) {
            if (e.target === this) {
                closeDomainStatusModal();
            }
        });

        async function checkDomainStatus() {
            const container = document.getElementById('domainStatusContainer');
            container.innerHTML = '<div class="status-loading">Checking domain status...</div>';

            try {
                const response = await fetch('/api/domain-status');
                const domainStatuses = await response.json();

                container.innerHTML = '';
                domainStatuses.forEach(domain => {
                    const item = document.createElement('div');
                    item.className = 'domain-status-item';

                    const statusClass = 'status-' + domain.status;
                    const statusText = domain.status === 'working' ? 'OK' :
                                        domain.status === 'rate-limited' ? 'LIMIT' :
                                        domain.status === 'timeout' ? 'TIMEOUT' : 'LIMIT';

                    item.innerHTML = '<span class="domain-name">' + domain.domain + '</span><span class="status-badge ' + statusClass + '">' + statusText + '</span>';

                    container.appendChild(item);
                });
            } catch (error) {
                container.innerHTML = '<div class="status-loading">Failed to check domain status</div>';
            }
        }

        function createRandomParticles() {
            const particlesContainer = document.getElementById('particles');
            const particleCount = 15;

            for (let i = 0; i < particleCount; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.animationDelay = Math.random() * 6 + 's';
                particle.style.animationDuration = Math.random() * 4 + 4 + 's';

                const colors = ['#6a11cb', '#2575fc', '#ff6b6b', '#38ef7d'];
                particle.style.background = colors[Math.floor(Math.random() * colors.length)];

                particlesContainer.appendChild(particle);
            }
        }

        function randomizeTitleColor() {
            const title = document.querySelector('.title');
            const colors = [
                'linear-gradient(90deg, #6a11cb, #2575fc)',
                'linear-gradient(90deg, #ff6b6b, #ffa500)',
                'linear-gradient(90deg, #38ef7d, #11998e)',
                'linear-gradient(90deg, #667eea, #764ba2)'
            ];

            setInterval(() => {
                const randomColor = colors[Math.floor(Math.random() * colors.length)];
                title.style.background = randomColor;
                title.style.webkitBackgroundClip = 'text';
                title.style.backgroundClip = 'text';
            }, 3000);
        }
    </script>
</body>
</html>`

  return new Response(html, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  })
}



import { connect } from "cloudflare:sockets"


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

