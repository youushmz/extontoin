# WebSocket Server - Chrome Extension Controller

## النشر على Coolify

### 1. ارفع الملفات على GitHub
```
ws-server/
├── server.js
├── package.json
├── Dockerfile
└── docker-compose.yml
```

### 2. في Coolify
- New Resource → Docker Compose أو Dockerfile
- ربط الـ GitHub repo
- Environment Variables:
  ```
  PORT=3055
  SECRET_TOKEN=your-secret-token-here
  ```
- Port: `3055`
- اضغط Deploy

### 3. بعد النشر ستحصل على URL مثل:
```
https://ws.yourithome.site
```

---

## الأوامر المتاحة (من n8n)

### فتح رابط جديد
```json
POST /send-command
Header: x-secret-token: your-token

{
  "action": "open_tab",
  "url": "https://facebook.com"
}
```

### إغلاق تبويب
```json
{
  "action": "close_tab",
  "tabId": 123
}
```

### تشغيل JavaScript في الصفحة
```json
{
  "action": "run_script",
  "tabId": 123,
  "script": "document.title"
}
```

### فحص حالة السيرفر
```
GET /health
```

---

## إعداد n8n

1. أضف **HTTP Request** node
2. Method: `POST`
3. URL: `https://ws.yourithome.site/send-command`
4. Headers:
   - `x-secret-token`: نفس التوكن
   - `Content-Type`: `application/json`
5. Body (JSON):
```json
{
  "action": "open_tab",
  "url": "{{ $json.url }}"
}
```
