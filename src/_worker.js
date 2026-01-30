// worker.js - VLESS over WebSocket for Cloudflare Worker
// Based on VLESS protocol: https://www.v2fly.org/en_US/developer/protocols/vless.html

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Your VLESS users (store in Secrets for production)
const VLESS_USERS = [
  {
    uuid: "62a9adef-40b2-477a-861f-ce1e8604bc34", // Generate with: crypto.randomUUID()
    email: "user@example.com",
    level: 0,
    alterId: 0
  }
];

// Helper functions
const hexStringToArrayBuffer = (hexString) => {
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
  }
  return bytes.buffer;
};

const arrayBufferToHexString = (buffer) => {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // VLESS WebSocket endpoint
    if (url.pathname === '/vless' || url.pathname === '/vmess') {
      return handleVLESS(request, env);
    }
    
    // Generate new UUID
    if (url.pathname === '/generate') {
      const uuid = crypto.randomUUID();
      const vmessConfig = generateVmessConfig(uuid, request.headers.get('host'));
      const vlessConfig = generateVlessConfig(uuid, request.headers.get('host'));
      
      return new Response(JSON.stringify({
        uuid: uuid,
        vmess: vmessConfig,
        vless: vlessConfig,
        qrcode_vmess: `vmess://${btoa(JSON.stringify(vmessConfig))}`,
        qrcode_vless: vlessConfig
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Subscription endpoint
    if (url.pathname === '/sub') {
      const host = request.headers.get('host');
      const subContent = VLESS_USERS.map(user => {
        const vmess = generateVmessConfig(user.uuid, host);
        return `vmess://${btoa(JSON.stringify(vmess))}`;
      }).join('\n');
      
      return new Response(btoa(subContent), {
        headers: { 
          'Content-Type': 'text/plain; charset=utf-8',
          'Subscription-Userinfo': `upload=0; download=0; total=10737418240000000; expire=2546249531`
        }
      });
    }
    
    // WebSocket test page
    if (url.pathname === '/') {
      return new Response(htmlPage, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    return new Response('VLESS/VMess Worker', { status: 200 });
  }
};

// Handle VLESS WebSocket connections
async function handleVLESS(request, env) {
  const upgradeHeader = request.headers.get('Upgrade');
  
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    // Handle HTTP fallback (for some clients)
    const url = new URL(request.url);
    const uuid = url.searchParams.get('uuid') || url.searchParams.get('id');
    
    if (uuid && validateUUID(uuid)) {
      return new Response(JSON.stringify({
        v: "2",
        ps: "Cloudflare Worker VPN",
        add: request.headers.get('host'),
        port: 443,
        id: uuid,
        aid: 0,
        net: "ws",
        type: "none",
        host: request.headers.get('host'),
        path: "/vless",
        tls: "tls"
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('WebSocket upgrade required', { status: 426 });
  }

  // Create WebSocket pair
  const [client, server] = Object.values(new WebSocketPair());
  
  // Accept the WebSocket on our end
  server.accept();
  
  // Handle VLESS protocol
  handleVLESSProtocol(server, request);
  
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

async function handleVLESSProtocol(websocket, request) {
  let userId = null;
  let targetHost = null;
  let targetPort = null;
  let isUDP = false;
  
  // First message should be VLESS header (16 bytes UUID + 1 byte option)
  const firstMessageHandler = async (event) => {
    try {
      const data = event.data;
      
      if (data instanceof ArrayBuffer) {
        const buffer = new Uint8Array(data);
        
        // Extract UUID (16 bytes)
        const uuidBytes = buffer.slice(0, 16);
        const uuidHex = arrayBufferToHexString(uuidBytes.buffer);
        const uuid = formatUUID(uuidHex);
        
        // Validate UUID
        const user = VLESS_USERS.find(u => u.uuid.toLowerCase() === uuid.toLowerCase());
        if (!user) {
          console.log('Invalid UUID:', uuid);
          websocket.close(1008, 'Invalid user');
          return;
        }
        
        userId = uuid;
        
        // Extract options (1 byte after UUID)
        const options = buffer[16];
        
        // Command (1 byte after options)
        const command = buffer[17];
        
        // Port (2 bytes, big endian)
        const port = (buffer[18] << 8) | buffer[19];
        
        // Address type (1 byte)
        const addressType = buffer[20];
        
        let addressLength = 0;
        let address = '';
        
        // Parse address based on type
        switch (addressType) {
          case 1: // IPv4 (4 bytes)
            address = `${buffer[21]}.${buffer[22]}.${buffer[23]}.${buffer[24]}`;
            addressLength = 4;
            break;
          case 2: // Domain name
            const domainLength = buffer[21];
            const domainBytes = buffer.slice(22, 22 + domainLength);
            address = new TextDecoder().decode(domainBytes);
            addressLength = 1 + domainLength;
            break;
          case 3: // IPv6 (16 bytes)
            const ipv6Bytes = buffer.slice(21, 37);
            address = Array.from(ipv6Bytes)
              .map(b => b.toString(16).padStart(2, '0'))
              .join(':')
              .replace(/(?:^|:)0{1,4}/g, ':')
              .replace(/^0{1,4}/, '')
              .replace(/:{2,}/g, '::');
            addressLength = 16;
            break;
          default:
            websocket.close(1008, 'Invalid address type');
            return;
        }
        
        targetHost = address;
        targetPort = port;
        
        // Check if it's UDP (command 2)
        isUDP = (command === 2);
        
        console.log(`VLESS Connection: ${userId} -> ${targetHost}:${targetPort} ${isUDP ? 'UDP' : 'TCP'}`);
        
        // Send response: 1 byte version (0) + 1 byte response (0 for success)
        const response = new Uint8Array([0, 0]);
        websocket.send(response);
        
        // Now handle actual data transfer
        if (!isUDP) {
          // For TCP, we need to proxy to the target
          await proxyTCP(websocket, targetHost, targetPort);
        } else {
          // For UDP, handle differently
          handleUDP(websocket, targetHost, targetPort);
        }
        
      } else {
        websocket.close(1008, 'Invalid data format');
      }
    } catch (error) {
      console.error('VLESS protocol error:', error);
      websocket.close(1011, 'Protocol error');
    }
  };
  
  websocket.addEventListener('message', firstMessageHandler, { once: true });
  
  websocket.addEventListener('close', (event) => {
    console.log(`VLESS connection closed: ${userId} ${targetHost}:${targetPort}`);
  });
  
  websocket.addEventListener('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

// TCP proxy using fetch API (for HTTP/HTTPS)
async function proxyTCP(websocket, host, port) {
  let buffer = [];
  
  const messageHandler = async (event) => {
    const data = event.data;
    
    if (data instanceof ArrayBuffer) {
      // Convert to Uint8Array for processing
      const bytes = new Uint8Array(data);
      
      try {
        // For HTTP/HTTPS traffic, we can use fetch API
        if (port === 80 || port === 443 || host.includes('.com') || host.includes('.org') || host.includes('.net')) {
          // Try to parse as HTTP request
          const text = new TextDecoder().decode(bytes);
          
          if (text.startsWith('GET ') || text.startsWith('POST ') || text.startsWith('CONNECT ')) {
            // This is HTTP traffic - use fetch API
            const url = `http${port === 443 ? 's' : ''}://${host}:${port}`;
            
            try {
              // For CONNECT (HTTPS tunneling), we need special handling
              if (text.startsWith('CONNECT ')) {
                // Send 200 Connection Established
                const response = new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n');
                websocket.send(response);
                
                // Now we need to handle TLS tunneling
                // This is complex in Workers without raw TCP
                // We'll just close for now
                websocket.close(1000, 'CONNECT not fully supported');
                return;
              }
              
              // For regular HTTP requests
              const requestInit = {
                method: text.split(' ')[0],
                headers: {},
                body: text.includes('\r\n\r\n') ? text.split('\r\n\r\n')[1] : null
              };
              
              // Parse headers
              const lines = text.split('\r\n');
              for (let i = 1; i < lines.length; i++) {
                if (lines[i] === '') break;
                const [key, value] = lines[i].split(': ');
                if (key && value) {
                  requestInit.headers[key] = value;
                }
              }
              
              const response = await fetch(url, requestInit);
              const responseBody = await response.arrayBuffer();
              
              // Send response back
              websocket.send(responseBody);
              
            } catch (fetchError) {
              console.error('Fetch error:', fetchError);
              websocket.send(new TextEncoder().encode('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
            }
          } else {
            // Not HTTP, just echo for now
            // In production, you'd want to implement proper TCP proxy
            // But Workers don't have raw TCP, so we're limited
            websocket.send(bytes);
          }
        } else {
          // Non-HTTP traffic, just echo (limited functionality)
          websocket.send(bytes);
        }
      } catch (error) {
        console.error('Proxy error:', error);
      }
    }
  };
  
  websocket.addEventListener('message', messageHandler);
}

function handleUDP(websocket, host, port) {
  // UDP handling - send dummy response
  const response = new TextEncoder().encode(`UDP to ${host}:${port} received (simulated)`);
  websocket.send(response);
}

// Helper functions
function validateUUID(uuid) {
  return UUID_REGEX.test(uuid);
}

function formatUUID(hex) {
  return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
}

function generateVmessConfig(uuid, host) {
  return {
    v: "2",
    ps: `CF Worker VPN - ${host}`,
    add: host,
    port: 443,
    id: uuid,
    aid: 0,
    net: "ws",
    type: "none",
    host: host,
    path: "/vless",
    tls: "tls",
    sni: host,
    alpn: "",
    fp: "chrome"
  };
}

function generateVlessConfig(uuid, host) {
  return `vless://${uuid}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=%2Fvless#CF+Worker+VPN`;
}

// HTML page for testing
const htmlPage = `
<!DOCTYPE html>
<html>
<head>
  <title>VLESS/VMess Worker</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .config { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 10px 0; }
    textarea { width: 100%; height: 100px; font-family: monospace; }
    .button { background: #007bff; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>VLESS/VMess Cloudflare Worker</h1>
  
  <div class="config">
    <h3>Generate New Configuration</h3>
    <button class="button" onclick="generateConfig()">Generate UUID & Config</button>
    <div id="result"></div>
  </div>
  
  <div class="config">
    <h3>Your Subscription Link</h3>
    <input type="text" id="subLink" readonly style="width: 100%; padding: 8px;">
    <button class="button" onclick="copySubLink()">Copy</button>
  </div>
  
  <div class="config">
    <h3>Client Configuration</h3>
    <h4>For v2rayN / V2Ray:</h4>
    <textarea id="vmessConfig" readonly></textarea>
    <button class="button" onclick="copyVmess()">Copy VMess</button>
    
    <h4>For Qv2ray / VLESS Clients:</h4>
    <textarea id="vlessConfig" readonly></textarea>
    <button class="button" onclick="copyVless()">Copy VLESS</button>
  </div>
  
  <div class="config">
    <h3>Test WebSocket Connection</h3>
    <button class="button" onclick="testWebSocket()">Test Connection</button>
    <div id="wsStatus"></div>
  </div>
  
  <script>
    async function generateConfig() {
      const response = await fetch('/generate');
      const data = await response.json();
      
      document.getElementById('result').innerHTML = \`
        <p><strong>UUID:</strong> \${data.uuid}</p>
        <p><strong>VMess QR:</strong> <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=\${encodeURIComponent(data.qrcode_vmess)}"></p>
      \`;
      
      document.getElementById('vmessConfig').value = JSON.stringify(data.vmess, null, 2);
      document.getElementById('vlessConfig').value = data.vless;
      document.getElementById('subLink').value = window.location.origin + '/sub';
    }
    
    function copyVmess() {
      const textarea = document.getElementById('vmessConfig');
      textarea.select();
      document.execCommand('copy');
      alert('VMess config copied!');
    }
    
    function copyVless() {
      const textarea = document.getElementById('vlessConfig');
      textarea.select();
      document.execCommand('copy');
      alert('VLESS config copied!');
    }
    
    function copySubLink() {
      const input = document.getElementById('subLink');
      input.select();
      document.execCommand('copy');
      alert('Subscription link copied!');
    }
    
    async function testWebSocket() {
      const status = document.getElementById('wsStatus');
      status.innerHTML = 'Connecting...';
      
      try {
        const ws = new WebSocket('wss://' + window.location.host + '/vless');
        
        ws.onopen = () => {
          status.innerHTML = 'WebSocket connected successfully!';
          ws.close();
        };
        
        ws.onerror = (error) => {
          status.innerHTML = 'WebSocket error: ' + error;
        };
        
        ws.onclose = () => {
          status.innerHTML += '<br>Connection closed';
        };
        
      } catch (error) {
        status.innerHTML = 'Error: ' + error;
      }
    }
  </script>
</body>
</html>
`;
