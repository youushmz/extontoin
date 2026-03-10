const WebSocket = require("ws");
const http = require("http");

// ============================================
// الإعدادات - غيّرها حسب احتياجك
// ============================================
const PORT = process.env.PORT || 3055;
const SECRET_TOKEN = process.env.SECRET_TOKEN || "hamza-secret-2024";

// ============================================
// إنشاء HTTP Server (لاستقبال n8n)
// ============================================
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        extensions_connected: extensions.size,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // استقبال الأوامر من n8n
  if (req.method === "POST" && req.url === "/send-command") {
    // التحقق من التوكن
    const token = req.headers["x-secret-token"];
    if (token !== SECRET_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized - Invalid Token" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const command = JSON.parse(body);
        console.log(`📨 أمر جديد من n8n:`, command);

        // إرسال الأمر لجميع Extensions المتصلة
        if (extensions.size === 0) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "No extensions connected", sent: 0 })
          );
          return;
        }

        let sent = 0;
        extensions.forEach((ext) => {
          if (ext.readyState === WebSocket.OPEN) {
            ext.send(JSON.stringify(command));
            sent++;
          }
        });

        console.log(`✅ تم إرسال الأمر لـ ${sent} Extension`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            sent_to: sent,
            command: command,
          })
        );
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// ============================================
// WebSocket Server (للـ Chrome Extension)
// ============================================
const wss = new WebSocket.Server({ server });
const extensions = new Set();

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`🔌 Extension متصلة من: ${ip}`);
  extensions.add(ws);

  // إرسال رسالة ترحيب
  ws.send(
    JSON.stringify({
      type: "connected",
      message: "متصل بالسيرفر بنجاح",
      timestamp: new Date().toISOString(),
    })
  );

  // استقبال رسائل من Extension (مثل تأكيد تنفيذ الأمر)
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "ping") {
        // رد فوري على الـ ping
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      } else {
        console.log(`📩 رسالة من Extension:`, msg);
      }
    } catch (e) {
      console.log(`📩 رسالة نصية من Extension: ${data}`);
    }
  });

  // عند قطع الاتصال
  ws.on("close", () => {
    extensions.delete(ws);
    console.log(`❌ Extension قطعت الاتصال. المتبقي: ${extensions.size}`);
  });

  ws.on("error", (err) => {
    console.error(`⚠️ خطأ في Extension:`, err.message);
    extensions.delete(ws);
  });
});

// ============================================
// تشغيل السيرفر
// ============================================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     WebSocket Server يعمل! 🚀        ║
  ╠══════════════════════════════════════╣
  ║  Port     : ${PORT}                     ║
  ║  Token    : ${SECRET_TOKEN}    ║
  ╠══════════════════════════════════════╣
  ║  Endpoints:                          ║
  ║  GET  /health        → فحص الحالة   ║
  ║  POST /send-command  → إرسال أمر    ║
  ║  WS   ws://...       → للـ Extension ║
  ╚══════════════════════════════════════╝
  `);
});

// إيقاف نظيف
process.on("SIGTERM", () => {
  console.log("إيقاف السيرفر...");
  wss.close();
  server.close();
});
