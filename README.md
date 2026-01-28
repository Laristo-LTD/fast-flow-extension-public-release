Dưới đây là **luồng hoạt động end-to-end** của extension trong folder bạn đưa (manifest + background + popup), theo đúng những gì code đang làm.

---

## 1) Tổng quan kiến trúc

Extension có 2 phần chính:

1. **Background service worker** (`background.js`)

* Chạy nền, **tự động kiểm tra server có “cần token” không**.
* Nếu cần → mở/đảm bảo có tab “Flow”, inject script vào **MAIN world** để gọi `grecaptcha.enterprise.execute()` lấy token → POST token về server. 

2. **Popup UI** (`popup.html` + `popup.js`)

* Chỉ để **hiển thị trạng thái**: server online/offline, server có cần token không, và liệt kê các tab liên quan (google/abc/flow).  

---

## 2) Manifest: extension “được phép làm gì”

Trong `manifest.json`, extension khai báo: 

* `permissions`:

  * `scripting`: cho phép `chrome.scripting.executeScript` (inject code vào tab để lấy token)
  * `tabs`: query/get/reload/remove tab
  * `alarms`: chạy timer định kỳ

* `host_permissions`:

  * `https://abc/*`: được truy cập trang mục tiêu (Flow)
  * `http://localhost:1113/*`: gọi API server local

* `background.service_worker`: `background.js` chạy nền

* `action.default_popup`: popup là `popup.html`

---

## 3) Luồng Background (tự động lấy token và đẩy về server)

### Bước 3.1 — Background khởi động + tạo lịch kiểm tra

Khi extension start:

* log “Extension started…”
* gọi `checkAndFetchToken()` ngay
* tạo alarm `tokenChecker` chạy **mỗi 0.083333 phút (~5 giây)** và mỗi lần alarm tick sẽ gọi `checkAndFetchToken()` 

### Bước 3.2 — Poll server xem có cần token không

`checkServerTrigger()` gọi:

* `GET http://localhost:1113/api/token/status`
* đọc JSON và lấy `data.needs_token` (true/false) 

Nếu `needs_token = true` → bắt đầu quy trình lấy token. 

### Bước 3.3 — Đảm bảo có tab “Flow” để chạy reCAPTCHA

Hàm `ensureTabExists()` làm 3 tầng:

1. Nếu đã có `tabId` trước đó → thử `chrome.tabs.get(tabId)`

   * Nếu tab còn tồn tại: **reload tab** để “reset reCAPTCHA”, chờ 3 giây rồi dùng lại tab đó. 

2. Nếu không còn tabId, nó sẽ `chrome.tabs.query` tìm tab nào match:

   * `https://abc.com/fx/*` hoặc `https://abc.com/*`
   * Nếu tìm thấy: lấy tab đầu tiên, reload, chờ 3 giây. 

3. Nếu không có tab phù hợp → **tạo cửa sổ mới minimized** mở URL:

   * `https://abc/fx/tools/flow`
   * Lấy `tabId` từ window vừa tạo, rồi đợi tab load xong (poll tab.status) hoặc timeout 15s. 

### Bước 3.4 — Inject code vào MAIN world để gọi `grecaptcha.enterprise.execute`

`fetchTokenFromTab()` sẽ gọi `chrome.scripting.executeScript` với:

* `target: { tabId }`
* `world: "MAIN"` (rất quan trọng: chạy trong context trang thật, mới access được `window.grecaptcha`)
* truyền `siteKey` cố định vào hàm `getRecaptchaToken(siteKey)` 

Trong `getRecaptchaToken`:

* Poll chờ `window.grecaptcha.enterprise` sẵn sàng (tối đa ~30s: 300 lần * 100ms) 
* Nếu có `execute` → gọi:

  * `grecaptcha.enterprise.execute(siteKey, { action: "FLOW_GENERATION" })`
  * trả về token 

### Bước 3.5 — Gửi token về server local

Nếu lấy được token:

* `POST http://localhost:1113/api/token/submit`
* body: `{ token }`
* sau đó delay 3 giây (có vẻ để tránh spam / chờ server xử lý) 

### Bước 3.6 — Xử lý lỗi

Nếu lỗi bất kỳ:

* log lỗi
* nếu đang giữ `tabId` thì sẽ `chrome.tabs.remove(tabId)` và reset `tabId/windowId = null` để lần sau tạo lại. 

Khi extension bị suspend:

* nếu còn tabId thì đóng tab đó. 

---

## 4) Luồng Headers (tự động lấy session headers và đẩy về server)

Song song với token, extension cũng có thể gửi **headers payload** về local server khi app yêu cầu:

- Poll: `GET http://localhost:1113/api/headers/status?profile_id=...`
- Claim: `POST http://localhost:1113/api/headers/claim`
- Fetch session: `GET https://labs.google/fx/api/auth/session` (kèm cookies)
- Submit: `POST http://localhost:1113/api/headers/submit`

Payload gửi về server là JSON string (để app parse tuỳ nhu cầu) gồm:

- `url`: endpoint session
- `fetched_at`
- `status`
- `data`: JSON parse được (nếu có)
- `raw`: fallback text nếu không parse được JSON

## 5) Luồng Popup (hiển thị trạng thái)

### Bước 5.1 — Kiểm tra server status

`popup.js` cứ mỗi 3 giây gọi:

* `GET http://localhost:1113/api/token/status`
* nếu `needs_token = true` → hiển thị “● Cần Token”
* nếu false → “● Sẵn sàng”
* nếu fetch fail → “● Offline” 

### Bước 4.2 — Scan tabs để hiển thị log

Popup cũng định kỳ query tất cả tab:

* lọc tab có URL chứa `google.com` hoặc `abc`
* lọc riêng “flow” nếu URL chứa `abc/fx/tools/flow`
* render danh sách ra UI + tổng số tab 

> Lưu ý: phần UI + style nằm trong `popup.html`, chỉ để show “Auto Mode Active / Monitoring”. 

---

## 5) Tóm tắt “1 câu”

Extension này là một **auto-recpatcha token fetcher**: background **poll server local** xem có cần token không; nếu cần thì **mở/reload tab Flow**, inject code vào MAIN để gọi `grecaptcha.enterprise.execute`, lấy token rồi **POST về localhost**; popup chỉ để **monitor trạng thái + tab**.  

---

Nếu bạn muốn, mình có thể chỉ ra luôn:

* điểm nào đang “hard-code” (siteKey/URL flow),
* chỗ nào dễ lỗi (domain mismatch giữa `abc` và `abc.com`, reload/reset recaptcha),
* và cách chỉnh để “chỉ chạy khi user bấm nút” thay vì alarm 5 giây.
# fast-flow-helper-extention
# fast-flow-helper-extention
# fast-flow-helper-extention
