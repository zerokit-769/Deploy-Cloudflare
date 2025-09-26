import { connect } from "cloudflare:sockets";

const proxyListURL = 'https://raw.githubusercontent.com/AFRcloud/ProxyList/refs/heads/main/ProxyList.txt';
const pathinfo = "afrcloud"; // Anda bisa mengubah path di sini

// Global Variables
let cachedProxyList = [];
let proxyIP = "";

// Constants
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

/**
 * Membuat halaman informasi HTML.
 * @param {Request} request
 * @param {object} ipInfo Informasi IP pengunjung.
 */
function getHTMLInfo(request, ipInfo) {
	const url = new URL(request.url);
	const clientIP = request.headers.get('CF-Connecting-IP') || 'N/A';
	const html = `
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
          .info-list {display: flex; flex-direction: column; gap: 8px; margin-top: 1.5rem;}
          .info-group-title { font-family: "Orbitron", sans-serif; color: var(--accent-color); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; margin-top: 0.8rem; margin-bottom: 0.4rem; padding-bottom: 5px; border-bottom: 1px solid var(--border-color); }
          .info-list .info-group-title:first-child { margin-top: 0; }
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
          @keyframes blink { 50% { opacity: 0.5; } }
          @media (max-width: 480px) {body { padding: 0.5rem 0; } .container { padding: 0 0.5rem; } .title { font-size: 1.5rem; } .profile-img { width: 100px; height: 100px; }}
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
          
          <span class="info-value">VLESS</span>
          <span class="info-value">Shadowsocks</span>
          <span class="info-value">TROJAN</span>
          
      </div>
                  <div class="info-group-title">Connection Details</div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-network-wired icon"></i> Hostname</span>
                      <span class="info-value"><code>${url.hostname}</code></span>
                  </div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-signal icon"></i> IP</span>
                      <span class="info-value"><code>${clientIP}</code></span>
                  </div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-broadcast-tower icon"></i> ISP</span>
                      <span class="info-value">${ipInfo.org || 'N/A'}</span>
                  </div>

                  <div class="info-group-title">Geolocation</div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-map-marker-alt icon"></i> City</span>
                      <span class="info-value">${ipInfo.city || 'N/A'}</span>
                  </div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-map icon"></i> Region</span>
                      <span class="info-value">${ipInfo.region || 'N/A'}</span>
                  </div>
                  <div class="info-item">
                      <span class="info-label"><i class="fas fa-flag icon"></i> Country</span>
                      <span class="info-value">${ipInfo.country || 'N/A'}</span>
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
      <script>
          document.addEventListener("DOMContentLoaded", () => {
              const yearSpan = document.getElementById('current-year');
              if (yearSpan) { yearSpan.textContent = new Date().getFullYear(); }
          });
      </script>
  </body>
  </html>`;

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8'
		},
	});
}


async function getProxyList(forceReload = false) {
	if (!cachedProxyList.length || forceReload) {
		if (!proxyListURL) {
			throw new Error("No Proxy List URL Provided!");
		}

		const response = await fetch(proxyListURL);
		if (response.ok) {
			const proxyString = (await response.text()).split("\n").filter(Boolean);
			cachedProxyList = proxyString
				.map((entry) => {
					const [proxyIP, proxyPort, country, org] = entry.split(",");
					return {
						proxyIP: proxyIP || "Unknown",
						proxyPort: proxyPort || "Unknown",
						country: country ? country.toUpperCase() : "Unknown",
						org: org || "Unknown Org",
					};
				})
				.filter(Boolean);
		}
	}
	return cachedProxyList;
}

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const upgradeHeader = request.headers.get("Upgrade");

			if (upgradeHeader !== "websocket") {
				// Ini adalah permintaan HTTP biasa, tampilkan halaman info
				const myIp = request.headers.get('CF-Connecting-IP') || 'IP Not Found';
				const ipInfoResponse = await fetch(`https://ipinfo.io/${myIp}/json`);
				const ipInfo = await ipInfoResponse.json();
				return getHTMLInfo(request, ipInfo);
			}

			// Lanjutkan dengan logika WebSocket
			const proxyState = new Map();

			async function updateProxies() {
				const proxies = await getProxyList();
				const groupedProxies = groupBy(proxies, "country");
				for (const [countryCode, proxyGroup] of Object.entries(groupedProxies)) {
					const randomIndex = Math.floor(Math.random() * proxyGroup.length);
					proxyState.set(countryCode, proxyGroup[randomIndex]);
				}
			}

			ctx.waitUntil(
				(async function periodicUpdate() {
					await updateProxies();
					setInterval(updateProxies, 60000);
				})()
			);

			if (!url.pathname.startsWith(`/${pathinfo}/`)) {
				return new Response("Invalid WebSocket path format.", {
					status: 400
				});
			}

			const cleanPath = url.pathname.replace(`/${pathinfo}/`, "");

			// Match path dengan format /CC atau /CCangka
			const pathMatch = cleanPath.match(/^([A-Z]{2})(\d+)?$/);
			if (pathMatch) {
				const countryCode = pathMatch[1];
				const index = pathMatch[2] ? parseInt(pathMatch[2], 10) - 1 : null;
				const proxies = await getProxyList();
				const filteredProxies = proxies.filter((proxy) => proxy.country === countryCode);

				if (filteredProxies.length === 0) {
					return new Response(`No proxies available for country: ${countryCode}`, {
						status: 404
					});
				}

				let selectedProxy;
				if (index === null) {
					selectedProxy = proxyState.get(countryCode) || filteredProxies[0];
				} else if (index < 0 || index >= filteredProxies.length) {
					return new Response(`Index out of bounds for ${countryCode}.`, {
						status: 400
					});
				} else {
					selectedProxy = filteredProxies[index];
				}

				proxyIP = `${selectedProxy.proxyIP}:${selectedProxy.proxyPort}`;
				return websockerHandler(request);
			}

			// Match path dengan format ip:port atau ip=port
			const ipPortMatch = cleanPath.match(/^(.+[:=-]\d+)$/);
			if (ipPortMatch) {
				proxyIP = ipPortMatch[1].replace(/[=:-]/, ":");
				return websockerHandler(request);
			}

			return new Response("Invalid WebSocket path parameters.", {
				status: 400
			});

		} catch (err) {
			return new Response(`An error occurred: ${err.toString()}`, {
				status: 500
			});
		}
	},
};

// Helper function: Group proxies by country
function groupBy(array, key) {
	return array.reduce((result, currentValue) => {
		(result[currentValue[key]] = result[currentValue[key]] || []).push(currentValue);
		return result;
	}, {});
}

async function websockerHandler(request) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let addressLog = "";
	let portLog = "";
	const log = (info, event) => {
		console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
	};
	const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	let remoteSocketWrapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDNS = false;

	readableWebSocketStream
		.pipeTo(
			new WritableStream({
				async write(chunk, controller) {
					if (isDNS && udpStreamWrite) {
						return udpStreamWrite(chunk);
					}
					if (remoteSocketWrapper.value) {
						const writer = remoteSocketWrapper.value.writable.getWriter();
						await writer.write(chunk);
						writer.releaseLock();
						return;
					}

					const protocol = await protocolSniffer(chunk);
					let protocolHeader;

					if (protocol === "Trojan") {
						protocolHeader = parseTrojanHeader(chunk);
					} else if (protocol === "VLESS") {
						protocolHeader = parseVlessHeader(chunk);
					} else if (protocol === "Shadowsocks") {
						protocolHeader = parseShadowsocksHeader(chunk);
					} else {
						throw new Error("Unknown Protocol!");
					}

					addressLog = protocolHeader.addressRemote;
					portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;

					if (protocolHeader.hasError) {
						throw new Error(protocolHeader.message);
					}

					if (protocolHeader.isUDP) {
						if (protocolHeader.portRemote === 53) {
							isDNS = true;
						} else {
							throw new Error("UDP only support for DNS port 53");
						}
					}

					if (isDNS) {
						const {
							write
						} = await handleUDPOutbound(webSocket, protocolHeader.version, log);
						udpStreamWrite = write;
						udpStreamWrite(protocolHeader.rawClientData);
						return;
					}

					handleTCPOutBound(
						remoteSocketWrapper,
						protocolHeader.addressRemote,
						protocolHeader.portRemote,
						protocolHeader.rawClientData,
						webSocket,
						protocolHeader.version,
						log
					);
				},
				close() {
					log(`readableWebSocketStream is close`);
				},
				abort(reason) {
					log(`readableWebSocketStream is abort`, JSON.stringify(reason));
				},
			})
		)
		.catch((err) => {
			log("readableWebSocketStream pipeTo error", err);
		});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

async function protocolSniffer(buffer) {
	if (buffer.byteLength >= 62) {
		const trojanDelimiter = new Uint8Array(buffer.slice(56, 60));
		if (trojanDelimiter[0] === 0x0d && trojanDelimiter[1] === 0x0a) {
			if (trojanDelimiter[2] === 0x01 || trojanDelimiter[2] === 0x03 || trojanDelimiter[2] === 0x7f) {
				if (trojanDelimiter[3] === 0x01 || trojanDelimiter[3] === 0x03 || trojanDelimiter[3] === 0x04) {
					return "Trojan";
				}
			}
		}
	}

	const vlessDelimiter = new Uint8Array(buffer.slice(1, 17));
	if (arrayBufferToHex(vlessDelimiter).match(/^\w{8}\w{4}4\w{3}[89ab]\w{3}\w{12}$/)) {
		return "VLESS";
	}

	return "Shadowsocks"; // default
}

async function handleTCPOutBound(
	remoteSocket,
	addressRemote,
	portRemote,
	rawClientData,
	webSocket,
	responseHeader,
	log
) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}

	async function retry() {
		const tcpSocket = await connectAndWrite(
			proxyIP.split(/[:=-]/)[0] || addressRemote,
			proxyIP.split(/[:=-]/)[1] || portRemote
		);
		tcpSocket.closed
			.catch((error) => {
				console.log("retry tcpSocket closed error", error);
			})
			.finally(() => {
				safeCloseWebSocket(webSocket);
			});
		remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener("message", (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});
			webSocketServer.addEventListener("close", () => {
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			});
			webSocketServer.addEventListener("error", (err) => {
				log("webSocketServer has error");
				controller.error(err);
			});
			const {
				earlyData,
				error
			} = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {},
		cancel(reason) {
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		},
	});

	return stream;
}

function parseShadowsocksHeader(ssBuffer) {
	const view = new DataView(ssBuffer);

	const addressType = view.getUint8(0);
	let addressLength = 0;
	let addressValueIndex = 1;
	let addressValue = "";

	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
			break;
		case 3:
			addressLength = new Uint8Array(ssBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 4:
			addressLength = 16;
			const dataView = new DataView(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(":");
			break;
		default:
			return {
				hasError: true,
				message: `Invalid addressType for Shadowsocks: ${addressType}`,
			};
	}

	if (!addressValue) {
		return {
			hasError: true,
			message: `Destination address empty, address type is: ${addressType}`,
		};
	}

	const portIndex = addressValueIndex + addressLength;
	const portBuffer = ssBuffer.slice(portIndex, portIndex + 2);
	const portRemote = new DataView(portBuffer).getUint16(0);
	return {
		hasError: false,
		addressRemote: addressValue,
		addressType: addressType,
		portRemote: portRemote,
		rawDataIndex: portIndex + 2,
		rawClientData: ssBuffer.slice(portIndex + 2),
		version: null,
		isUDP: portRemote == 53,
	};
}

function parseVlessHeader(vlessBuffer) {
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isUDP = false;

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];

	const cmd = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
	if (cmd === 1) {} else if (cmd === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${cmd} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));

	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = "";
	switch (addressType) {
		case 1: // For IPv4
			addressLength = 4;
			addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
			break;
		case 2: // For Domain
			addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3: // For IPv6
			addressLength = 16;
			const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(":");
			break;
		default:
			return {
				hasError: true,
				message: `invild addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType: addressType,
		portRemote: portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		rawClientData: vlessBuffer.slice(addressValueIndex + addressLength),
		version: new Uint8Array([version[0], 0]),
		isUDP: isUDP,
	};
}

function parseTrojanHeader(buffer) {
	const socks5DataBuffer = buffer.slice(58);
	if (socks5DataBuffer.byteLength < 6) {
		return {
			hasError: true,
			message: "invalid SOCKS5 request data",
		};
	}

	let isUDP = false;
	const view = new DataView(socks5DataBuffer);
	const cmd = view.getUint8(0);
	if (cmd == 3) {
		isUDP = true;
	} else if (cmd != 1) {
		throw new Error("Unsupported command type!");
	}

	let addressType = view.getUint8(1);
	let addressLength = 0;
	let addressValueIndex = 2;
	let addressValue = "";
	switch (addressType) {
		case 1: // For IPv4
			addressLength = 4;
			addressValue = new Uint8Array(socks5DataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
			break;
		case 3: // For Domain
			addressLength = new Uint8Array(socks5DataBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				socks5DataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 4: // For IPv6
			addressLength = 16;
			const dataView = new DataView(socks5DataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(":");
			break;
		default:
			return {
				hasError: true,
				message: `invalid addressType is ${addressType}`,
			};
	}

	if (!addressValue) {
		return {
			hasError: true,
			message: `address is empty, addressType is ${addressType}`,
		};
	}

	const portIndex = addressValueIndex + addressLength;
	const portBuffer = socks5DataBuffer.slice(portIndex, portIndex + 2);
	const portRemote = new DataView(portBuffer).getUint16(0);
	return {
		hasError: false,
		addressRemote: addressValue,
		addressType: addressType,
		portRemote: portRemote,
		rawDataIndex: portIndex + 4,
		rawClientData: socks5DataBuffer.slice(portIndex + 4),
		version: null,
		isUDP: isUDP,
	};
}

async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log) {
	let header = responseHeader;
	let hasIncomingData = false;
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {},
				async write(chunk, controller) {
					hasIncomingData = true;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error("webSocket.readyState is not open, maybe close");
					}
					if (header) {
						webSocket.send(await new Blob([header, chunk]).arrayBuffer());
						header = null;
					} else {
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(`remoteSocketToWS has exception `, error.stack || error);
			safeCloseWebSocket(webSocket);
		});
	if (hasIncomingData === false && retry) {
		log(`retry`);
		retry();
	}
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return {
			error: null
		};
	}
	try {
		base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return {
			earlyData: arryBuffer.buffer,
			error: null
		};
	} catch (error) {
		return {
			error
		};
	}
}

function arrayBufferToHex(buffer) {
	return [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function handleUDPOutbound(webSocket, responseHeader, log) {
	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {},
		transform(chunk, controller) {
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {},
	});
	transformStream.readable
		.pipeTo(
			new WritableStream({
				async write(chunk) {
					const resp = await fetch("https://1.1.1.1/dns-query", {
						method: "POST",
						headers: {
							"content-type": "application/dns-message",
						},
						body: chunk,
					});
					const dnsQueryResult = await resp.arrayBuffer();
					const udpSize = dnsQueryResult.byteLength;
					const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
					if (webSocket.readyState === WS_READY_STATE_OPEN) {
						log(`doh success and dns message length is ${udpSize}`);
						if (isVlessHeaderSent) {
							webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
						} else {
							webSocket.send(await new Blob([responseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
							isVlessHeaderSent = true;
						}
					}
				},
			})
		)
		.catch((error) => {
			log("dns udp has error" + error);
		});

	const writer = transformStream.writable.getWriter();

	return {
		write(chunk) {
			writer.write(chunk);
		},
	};
}

function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error("safeCloseWebSocket error", error);
	}
}
