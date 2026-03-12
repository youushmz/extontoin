const WebSocket = require("ws");
const http = require("http");

// ============================================
// الإعدادات
// ============================================
const PORT = process.env.PORT || 3055;
const MASTER_TOKEN = process.env.SECRET_TOKEN || "hamza-secret-2024";

// ============================================
// تخزين البيانات
// ============================================

// extensions: Map<extensionToken, { ws, ip, connectedAt, lastSeen }>
const extensions = new Map();

// نتائج الأوامر: Map<commandId, { resolve, timer }>
const pendingResults = new Map();

// آخر نتيجة لكل extension
const lastResults = new Map(); // extensionToken -> lastResult

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============================================
// HTTP Server
// ============================================
const server = http.createServer((req, res) => {
  const headers = { "Content-Type": "application/json" };

  // ── GET /health ──
  if (req.method === "GET" && req.url === "/health") {
    const connected = {};
    extensions.forEach((ext, token) => {
      connected[token] = {
        ip: ext.ip,
        connectedAt: ext.connectedAt,
        lastSeen: ext.lastSeen,
        status: ext.ws.readyState === WebSocket.OPEN ? "online" : "offline",
      };
    });
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      status: "ok",
      extensions_connected: extensions.size,
      extensions: connected,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── GET /list-extensions ── (يحتاج master token)
  if (req.method === "GET" && req.url === "/list-extensions") {
    if (req.headers["x-master-token"] !== MASTER_TOKEN) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const list = [];
    extensions.forEach((ext, token) => {
      list.push({
        token,
        ip: ext.ip,
        connectedAt: ext.connectedAt,
        lastSeen: ext.lastSeen,
        online: ext.ws.readyState === WebSocket.OPEN,
      });
    });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ extensions: list, total: list.length }));
    return;
  }

  // تحقق من body للـ POST requests
  const readBody = (cb) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { cb(JSON.parse(body)); }
      catch (e) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
  };

  // دالة إرسال الأمر لـ extension محددة أو كل الـ extensions
  const sendToExtension = (command, extensionToken) => {
    if (extensionToken) {
      // إرسال لـ extension محددة بتوكنها
      const ext = extensions.get(extensionToken);
      if (!ext || ext.ws.readyState !== WebSocket.OPEN) {
        return { sent: 0, error: `Extension "${extensionToken}" not connected` };
      }
      ext.ws.send(JSON.stringify(command));
      return { sent: 1, target: extensionToken };
    } else {
      // إرسال لجميع الـ extensions
      let sent = 0;
      extensions.forEach((ext) => {
        if (ext.ws.readyState === WebSocket.OPEN) {
          ext.ws.send(JSON.stringify(command));
          sent++;
        }
      });
      return { sent, target: "all" };
    }
  };

  // ── POST /send-command ──
  if (req.method === "POST" && req.url === "/send-command") {
    if (req.headers["x-master-token"] !== MASTER_TOKEN) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    readBody((command) => {
      const extensionToken = req.headers["x-extension-token"] || null;
      if (extensions.size === 0) {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ error: "No extensions connected" }));
        return;
      }
      const result = sendToExtension(command, extensionToken);
      if (result.error) {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      console.log(`📨 أمر → ${result.target} (${result.sent} extension)`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ success: true, ...result, command }));
    });
    return;
  }

  // ── POST /execute ── (ينتظر النتيجة)
  if (req.method === "POST" && req.url === "/execute") {
    if (req.headers["x-master-token"] !== MASTER_TOKEN) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    readBody((command) => {
      const extensionToken = req.headers["x-extension-token"] || null;

      if (extensions.size === 0) {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ error: "No extensions connected" }));
        return;
      }

      const commandId = generateId();
      command.commandId = commandId;

      const result = sendToExtension(command, extensionToken);
      if (result.error) {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      // انتظار النتيجة 15 ثانية
      const timer = setTimeout(() => {
        pendingResults.delete(commandId);
        res.writeHead(408, headers);
        res.end(JSON.stringify({ error: "Timeout - no response from extension" }));
      }, 15000);

      pendingResults.set(commandId, {
        resolve: (cmdResult) => {
          clearTimeout(timer);
          pendingResults.delete(commandId);
          res.writeHead(200, headers);
          res.end(JSON.stringify({ success: true, result: cmdResult, target: result.target }));
        },
        timer,
      });
    });
    return;
  }

  // ── GET /get-result ── (آخر نتيجة لـ extension محددة)
  if (req.method === "GET" && req.url === "/get-result") {
    if (req.headers["x-master-token"] !== MASTER_TOKEN) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const extensionToken = req.headers["x-extension-token"] || null;
    const result = extensionToken
      ? lastResults.get(extensionToken)
      : Object.fromEntries(lastResults);
    res.writeHead(200, headers);
    res.end(JSON.stringify({ result: result || null }));
    return;
  }

  // ── GET /proxy-file?url=... ── تحميل ملف وإرساله للـ Extension
  if (req.method === "GET" && req.url.startsWith("/proxy-file")) {
    const urlObj = new URL(req.url, "http://localhost");
    const fileUrl = urlObj.searchParams.get("url");

    if (!fileUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "url parameter required" }));
      return;
    }

    try {
      const https = require("https");
      const http2 = require("http");
      const urlParsed = new URL(fileUrl);
      const client = urlParsed.protocol === "https:" ? https : http2;

      const proxyReq = client.get(fileUrl, (proxyRes) => {
        // تتبع redirects
        if (proxyRes.statusCode === 302 || proxyRes.statusCode === 301) {
          const redirectUrl = proxyRes.headers.location;
          const redirectReq = client.get(redirectUrl, (redirectRes) => {
            res.writeHead(200, {
              "Content-Type": redirectRes.headers["content-type"] || "application/octet-stream",
              "Access-Control-Allow-Origin": "*",
              "Content-Disposition": "attachment",
            });
            redirectRes.pipe(res);
          });
          redirectReq.on("error", (e) => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          });
          return;
        }
        res.writeHead(200, {
          "Content-Type": proxyRes.headers["content-type"] || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Content-Disposition": "attachment",
        });
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (e) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// ============================================
// WebSocket Server
// ============================================
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;

  // الـ Extension ترسل توكنها في الـ URL: wss://server/?token=xxx
  const url = new URL(req.url, "http://localhost");
  const extensionToken = url.searchParams.get("token");

  if (!extensionToken) {
    console.log(`❌ اتصال بدون token من ${ip}`);
    ws.close(1008, "Token required");
    return;
  }

  // إذا كان التوكن موجود مسبقاً، أغلق الاتصال القديم
  if (extensions.has(extensionToken)) {
    const old = extensions.get(extensionToken);
    if (old.ws.readyState === WebSocket.OPEN) {
      old.ws.close(1000, "Replaced by new connection");
    }
  }

  const extData = {
    ws,
    ip,
    token: extensionToken,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  extensions.set(extensionToken, extData);
  console.log(`🔌 Extension متصلة | token: ${extensionToken} | ip: ${ip} | إجمالي: ${extensions.size}`);

  ws.send(JSON.stringify({
    type: "connected",
    message: "متصل بالسيرفر بنجاح",
    token: extensionToken,
    timestamp: new Date().toISOString(),
  }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      extData.lastSeen = new Date().toISOString();

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      } else if (msg.type === "command_result") {
        lastResults.set(extensionToken, { ...msg, receivedAt: new Date().toISOString() });
        console.log(`📩 نتيجة من [${extensionToken}]:`, msg.result);
        if (msg.commandId && pendingResults.has(msg.commandId)) {
          pendingResults.get(msg.commandId).resolve(msg.result);
        }
      } else if (msg.type === "extension_hello") {
        console.log(`👋 Extension [${extensionToken}] أرسلت hello`);
      }
    } catch (e) {
      console.log(`📩 رسالة غير JSON من [${extensionToken}]: ${data}`);
    }
  });

  ws.on("close", () => {
    extensions.delete(extensionToken);
    console.log(`❌ [${extensionToken}] قطع الاتصال | المتبقي: ${extensions.size}`);
  });

  ws.on("error", (err) => {
    console.error(`⚠️ خطأ في [${extensionToken}]:`, err.message);
    extensions.delete(extensionToken);
  });
});

// ============================================
// تشغيل السيرفر
// ============================================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Browser Commander Server 🚀            ║
  ╠══════════════════════════════════════════╣
  ║  Port         : ${PORT}                     ║
  ║  Master Token : ${MASTER_TOKEN}   ║
  ╠══════════════════════════════════════════╣
  ║  Endpoints:                              ║
  ║  GET  /health           → حالة السيرفر  ║
  ║  GET  /list-extensions  → كل الـ tokens ║
  ║  POST /send-command     → إرسال أمر     ║
  ║  POST /execute          → أمر + نتيجة  ║
  ║  GET  /get-result       → آخر نتيجة    ║
  ╠══════════════════════════════════════════╣
  ║  Headers:                                ║
  ║  x-master-token    → للتحقق            ║
  ║  x-extension-token → تحديد Extension   ║
  ╚══════════════════════════════════════════╝
  `);
});

process.on("SIGTERM", () => {
  wss.close();
  server.close();
});
