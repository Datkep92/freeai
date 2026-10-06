
# MASTER TASK — BUILD FREE MODEL HUB

Hãy xây dựng **một dự án mới hoàn chỉnh từ đầu** tên `Free Model Hub`.

Không dựa vào kiến trúc cũ. Không sửa/chắp vá project cũ.

## MỤC TIÊU

Tạo một Web UI **mobile-first**, tối ưu Safari/iPhone, dùng để:

```text
Provider Registry
      ↓
Auto Scan Models
      ↓
Free Model Detector
      ↓
Free Model Registry
      ↓
Paste API Keys
      ↓
Key Verifier
      ↓
Smart Router / Fallback
```

Mục tiêu cuối cùng:

> Tôi chủ yếu sử dụng API/model FREE. Hệ thống phải tự tìm và duy trì danh sách model free của nhiều provider. Tôi cũng có thể thêm provider/model thủ công. Sau đó chỉ cần paste API key, hệ thống tự map provider, tự test bằng model free với số request ít nhất và chuẩn bị routing/fallback.

---

# 1. PROVIDER REGISTRY

Hỗ trợ 2 loại:

```text
BUILT_IN
CUSTOM
```

Built-in ban đầu tối thiểu nghiên cứu và hỗ trợ:

```text
OpenRouter
OpenCode Zen
NVIDIA Build/API
```

Thiết kế adapter mở để sau này thêm:

```text
Groq
Cerebras
Together
Fireworks
Cloudflare AI
Google/Gemini
Mistral
Custom OpenAI-compatible
...
```

KHÔNG hard-code kiến trúc chỉ cho 3 provider đầu tiên.

Mỗi provider lưu:

```text
id
name
type
baseURL
protocol
scannerAdapter
enabled
status
lastScanAt
metadata
```

---

# 2. ADD CUSTOM PROVIDER

UI phải cho phép:

```text
+ ADD PROVIDER
```

Nhập:

```text
Name
Base URL
Protocol
Models endpoint
```

Mặc định hỗ trợ:

```text
OpenAI Compatible
GET /models
POST /chat/completions
```

Ví dụ:

```text
https://example.com/v1
```

Hệ thống normalize URL và thử discovery.

Nếu discovery không hoạt động:

```text
Provider vẫn được lưu.
```

Sau đó user có thể thêm model thủ công.

---

# 3. FREE MODEL SCANNER

Scanner phải độc lập với Key Verifier.

Nhiệm vụ:

```text
Provider
   ↓
Official API / models endpoint / catalog / pricing
   ↓
discover models
   ↓
Free Detector
   ↓
Free Model Registry
```

Ưu tiên nguồn theo thứ tự:

```text
1. Official provider API/catalog
2. Pricing metadata của provider
3. Official free collection/filter
4. Reliable model metadata/cost catalog
5. Naming heuristic
```

Không dùng inference request để kết luận một model là free nếu có thể xác định từ metadata/catalog.

---

# 4. FREE DETECTOR

Không dùng boolean đơn giản.

Mỗi model có:

```text
FREE_VERIFIED
FREE_LIKELY
FREE_UNKNOWN
PAID
```

Evidence phải được lưu.

Ví dụ:

```json
{
  "freeStatus": "FREE_VERIFIED",
  "evidence": [
    {
      "source": "provider_pricing",
      "value": "0"
    }
  ]
}
```

Quy tắc:

```text
Official provider xác nhận free
→ FREE_VERIFIED

inputPrice == 0 && outputPrice == 0
→ FREE_VERIFIED

Official Free Endpoint/Free Collection
→ FREE_VERIFIED

Tên chứa :free / -free
→ chỉ là evidence/hint nếu chưa có nguồn mạnh hơn

Không đủ dữ liệu
→ FREE_UNKNOWN

pricing > 0
→ PAID
```

Không được tự suy đoán `FREE_VERIFIED` chỉ vì tên model.

---

# 5. MODEL REGISTRY

Model có nguồn:

```text
AUTO_DISCOVERED
MANUAL
```

Schema tối thiểu:

```text
id
providerId
modelId
displayName
source
freeStatus
evidence
inputPrice
outputPrice
active
firstSeenAt
lastSeenAt
lastScanAt
metadata
```

---

# 6. ADD MODEL MANUAL

UI:

```text
+ ADD MODEL
```

Cho phép:

```text
Provider
Model ID
Display Name
Free Status
Notes
```

Model manual:

```text
KHÔNG được scanner tự xóa.
```

Nếu scanner sau này tìm thấy cùng model:

```text
merge evidence
không duplicate
```

---

# 7. SCANNER KHÔNG ĐƯỢC AUTO DELETE

Nếu model từng tồn tại nhưng scan mới không thấy:

```text
không DELETE
```

Đánh:

```text
NOT_SEEN
```

Lưu:

```text
lastSeenAt
missCount
```

Sau policy configurable mới chuyển:

```text
INACTIVE
```

Model MANUAL không được auto-delete.

---

# 8. SCAN ALL

UI phải có:

```text
SCAN PROVIDER
SCAN ALL PROVIDERS
REFRESH FREE MODELS
```

Scan model:

```text
KHÔNG inference
KHÔNG tiêu token nếu provider có public catalog/API
```

Có:

```text
progress
timeout
concurrency limit
cancel
last scan
error
```

Không spam provider.

---

# 9. CACHE

Không scan lại tất cả mỗi lần mở UI.

Dùng cache.

Ví dụ:

```text
TTL mặc định: 6 giờ
```

UI mở:

```text
load cache ngay
      ↓
render
      ↓
background refresh nếu stale
```

TTL phải configurable.

---

# 10. API KEY REGISTRY

Sau khi có Free Model Registry, user paste key.

UI:

```text
[ Paste API Key / nhiều keys ]

[ AUTO DETECT + CHECK ]
```

Key lưu:

```text
id
providerId
fingerprint
masked
secret
enabled
status
verifiedModelId
lastCheckedAt
lastSuccessAt
lastError
```

Không duplicate key.

Dùng fingerprint SHA-256.

Không log full key.

UI chỉ hiện:

```text
oc_s…AlQY
sk-o…2806
```

---

# 11. AUTO MAP KEY → PROVIDER

Prefix chỉ là HINT.

Không kết luận provider chỉ dựa vào prefix.

Luồng:

```text
Paste Key
   ↓
candidate providers
   ↓
provider-specific auth/discovery/probe
   ↓
xác minh
   ↓
map provider
```

Nếu chưa xác định:

```text
UNRESOLVED
```

Không map bừa.

---

# 12. KEY VERIFIER — TIẾT KIỆM QUOTA LÀ ƯU TIÊN CAO

KHÔNG chạy Full Matrix mặc định.

Với mỗi:

```text
Provider + Key
```

lấy danh sách:

```text
FREE_VERIFIED models
```

sau đó:

```text
Free Model #1
→ FAIL

Free Model #2
→ FAIL

Free Model #3
→ PASS

STOP NGAY
```

Không test model #4, #5...

Mục tiêu:

```text
FIRST SUCCESS → STOP
```

để giảm tối đa token/quota.

---

# 13. KHÔNG SUY DIỄN SAI

Nếu:

```text
Key A + Model B = PASS
```

thì lưu:

```text
Key A = VALID
verifiedModel = Model B

Model B × Key A = HEALTHY
```

Các model chưa test:

```text
UNTESTED
```

KHÔNG đánh tất cả model của provider là VERIFIED.

Mapping sẽ được học dần khi sử dụng.

---

# 14. KEY/MODEL MAPPING

Storage:

```text
Providers
Models
Keys
Mappings
```

Mapping:

```text
providerId
modelId
keyId
status
latencyMs
lastTestAt
lastSuccessAt
lastErrorClass
cooldownUntil
failureCount
```

Không duplicate secret cho từng model.

---

# 15. ERROR CLASSIFIER

Phải phân biệt:

```text
HEALTHY
UNTESTED
RATE_LIMITED
QUOTA_EXHAUSTED
AUTH_INVALID
EXPIRED
MODEL_DENIED
MODEL_UNAVAILABLE
PROVIDER_DOWN
TEMP_ERROR
REQUEST_ERROR
UNKNOWN_ERROR
```

Không chỉ nhìn HTTP status.

Phải xét:

```text
status
error.type
error.code
error.message
Retry-After
provider-specific response
```

---

# 16. QUOTA VS RATE LIMIT

Bắt buộc phân biệt.

```text
429 + rate limit
→ RATE_LIMITED
→ cooldown

429 + quota exhausted rõ ràng
→ QUOTA_EXHAUSTED

402 / insufficient credit
→ QUOTA_EXHAUSTED

401 invalid key
→ AUTH_INVALID

expired
→ EXPIRED
```

Không đánh mọi 429 là hết quota.

---

# 17. MODEL_DENIED

Nếu:

```text
Key A + Model A
→ MODEL_DENIED
```

chỉ disable mapping đó.

Không đánh toàn bộ Key A chết.

Key A vẫn có thể chạy:

```text
Model B
Model C
```

---

# 18. ROUTER

Router mặc định:

```text
FREE_ONLY = true
```

Chỉ ưu tiên:

```text
FREE_VERIFIED
```

Rotation:

```text
KEY
 ↓
KEY tiếp theo
 ↓
hết usable keys
 ↓
MODEL tiếp theo
 ↓
hết free models
 ↓
PROVIDER tiếp theo
```

Tức:

```text
KEY → MODEL → PROVIDER
```

---

# 19. LAZY LEARNING

Không test trước toàn bộ:

```text
Models × Keys
```

Khi production cần một mapping chưa test:

```text
UNTESTED
   ↓
thử thực tế
   ↓
PASS → HEALTHY
FAIL → classify
```

Registry tự học mapping trong quá trình sử dụng.

---

# 20. COOLDOWN

RATE_LIMITED:

```text
Retry-After nếu có
```

Nếu không:

```text
bounded exponential backoff
```

Hết cooldown:

```text
eligible lại
```

Không retry vô hạn.

---

# 21. CIRCUIT BREAKER

Provider lỗi liên tục:

```text
CLOSED
→ OPEN
→ cooldown
→ HALF_OPEN
→ probe
→ CLOSED hoặc OPEN
```

Config tập trung.

Không magic-number rải rác.

---

# 22. UI MOBILE-FIRST

Thiết kế ưu tiên:

```text
Safari iPhone
```

Không làm desktop rồi scale xuống.

Trang chính:

```text
╔══════════════════════════╗
║     FREE MODEL HUB       ║
╚══════════════════════════╝

Providers | Models | Keys | Health

🟢 OpenRouter
   27 Free
   Last scan: 5m
   [SCAN]

🟢 NVIDIA
   38 Free
   Last scan: 8m
   [SCAN]

🟢 OpenCode
   8 Free
   [SCAN]

[ + ADD PROVIDER ]

[ SCAN ALL ]
```

Con số model phải lấy runtime.

KHÔNG hard-code số lượng.

---

# 23. MODELS TAB

```text
FREE MODELS

Search...

OpenRouter
  🟢 Model A
  🟢 Model B

NVIDIA
  🟢 Model C

OpenCode
  🟢 Model D

[ + ADD MODEL ]
```

Filter:

```text
FREE VERIFIED
FREE LIKELY
UNKNOWN
PAID
ACTIVE
INACTIVE
MANUAL
AUTO
```

---

# 24. KEYS TAB

```text
Paste keys...

[AUTO DETECT + CHECK]

OpenCode
  oc_s…AlQY
  🟢 VALID
  verified:
  space-bunny-free

OpenRouter
  sk-o…2806
  🟠 RATE LIMITED
```

Không hiển thị full secret.

---

# 25. HEALTH TAB

Hiển thị:

```text
Provider
Model
Key
Status
Latency
Last success
Cooldown
Last error
```

Có:

```text
TEST FAILED
TEST KEY
TEST PROVIDER
RETRY
```

`TEST ALL` nếu có phải mặc định dùng:

```text
FIRST-SUCCESS strategy
```

Không Full Matrix.

Nếu muốn Full Matrix:

```text
Advanced → Deep Test
```

và cảnh báo:

```text
Có thể tiêu nhiều quota/token.
```

---

# 26. STORAGE V1

Dùng:

```text
IndexedDB
```

Không dùng localStorage cho toàn bộ registry lớn.

Tạo abstraction:

```text
StorageAdapter
```

để sau này thay bằng:

```text
Cloudflare D1/KV/DO
```

mà không rewrite core.

---

# 27. CORE PHẢI TÁCH KHỎI UI

Tối thiểu:

```text
core/
  provider-registry
  scanner
  free-detector
  model-registry
  key-registry
  key-verifier
  mapper
  error-classifier
  router
  health
  adapters
  storage
```

UI không được chứa business logic chính.

---

# 28. PROVIDER ADAPTER

Interface gợi ý:

```text
discoverModels()
normalizeModel()
detectFree()
probeKey()
buildChatRequest()
classifyError()
```

Built-in provider dùng adapter riêng khi cần.

Custom OpenAI-compatible dùng generic adapter.

---

# 29. NGHIÊN CỨU TRƯỚC KHI CODE

Trước khi implement adapter built-in:

1. Kiểm tra tài liệu/API hiện tại của provider.
2. Xác định endpoint discovery.
3. Xác định pricing/free metadata.
4. Xác định auth.
5. Xác định chat endpoint.
6. Không dựa vào thông tin cũ nếu API hiện tại đã thay đổi.

Nếu có internet/web tools, dùng chúng để xác minh.

---

# 30. KHÔNG ĐƯỢC LÀM

Không:

```text
hard-code model list làm source-of-truth
hard-code số model free
auto-delete model
auto-delete key
log full API key
đánh /models fail = key invalid
đánh mọi 429 = quota exhausted
Full Matrix mặc định
probe model paid
bịa quota/balance
duplicate key
duplicate model
duplicate provider
retry vô hạn
viết router riêng cho từng UI
```

---

# 31. IMPORT / EXPORT

Có:

```text
Export Registry
Import Registry
```

Export mặc định:

```text
KHÔNG chứa secret
```

Nếu user chủ động export secrets:

```text
cảnh báo trước
```

Import:

```text
merge + dedupe
```

không blind overwrite.

---

# 32. PHASE TRIỂN KHAI

Làm tuần tự.

## PHASE 1
Project skeleton + mobile UI + IndexedDB + Provider Registry.

## PHASE 2
Provider adapters + model discovery.

## PHASE 3
Free Detector + Free Model Registry.

## PHASE 4
Manual Provider + Manual Model.

## PHASE 5
Key Registry + fingerprint + masking.

## PHASE 6
First-Success Key Verifier.

## PHASE 7
Error Classifier + health.

## PHASE 8
Router + cooldown + fallback + lazy learning.

## PHASE 9
Circuit breaker + recovery.

## PHASE 10
Tests + mobile Safari polish + security review.

Không bỏ qua phase verification.

---

# 33. TEST BẮT BUỘC

Phải test:

```text
Built-in provider scan
Custom provider scan
Provider không hỗ trợ /models
Manual provider
Manual model
Scanner refresh
Model disappeared
Model manual không bị xóa
Duplicate provider
Duplicate model
Duplicate key
Free detection
Paid model exclusion
Unknown pricing
Paste key
Auto provider detection
First model FAIL → next
First PASS → STOP
401
402
403
429 rate-limit
429 quota
5xx
timeout
MODEL_DENIED
lazy mapping
router fallback
cooldown
circuit breaker
import/export
```

---

# 34. DEFINITION OF DONE

Chỉ báo DONE khi:

```text
[PASS] Mobile UI
[PASS] Provider Registry
[PASS] Built-in providers
[PASS] Custom provider
[PASS] Auto model discovery
[PASS] Manual model
[PASS] Free Detector
[PASS] Free Registry
[PASS] Cache
[PASS] Key Registry
[PASS] Key fingerprint
[PASS] Key masking
[PASS] Auto provider mapping
[PASS] First-Success probe
[PASS] Error classification
[PASS] Quota/rate-limit separation
[PASS] Lazy mapping
[PASS] Router
[PASS] Cooldown
[PASS] Circuit breaker
[PASS] Import/export
[PASS] Tests
```

Nếu chưa đạt thì báo:

```text
PARTIAL
```

không báo DONE giả.

---

# 35. COPYLOG — BẮT BUỘC

Terminal của tôi khó copy kết quả.

Sau khi hoàn thành BẮT BUỘC tạo:

```text
copylog.txt
```

ở root project.

Nếu file đã tồn tại:

```text
append report mới
```

không xóa report cũ.

COPYLOG phải ghi:

```text
==================================================
FREE MODEL HUB — IMPLEMENTATION REPORT

STATUS:
PASS / PARTIAL / BLOCKED

PROJECT PATH:

STACK:

FILES CREATED:
-

FILES CHANGED:
-

PROVIDERS IMPLEMENTED:
-

SCANNER RESULTS:
-

FREE DETECTOR:
-

KEY VERIFIER:
-

ROUTER:
-

TEST RESULTS:
-

BUILD RESULT:
-

HOW TO RUN:
<exact command>

LOCAL URL:
<url>

KNOWN ISSUES:
-

NEXT STEP:
-
==================================================
```

KHÔNG ghi:
- full API key
- token
- password
- secret

Chỉ masked key.

---

# 36. FINAL VERIFICATION

Trước khi kết thúc:

```text
1. Run tests.
2. Run/build project.
3. Kiểm tra UI mở được.
4. Kiểm tra mobile layout.
5. Kiểm tra console errors.
6. Kiểm tra không lộ secret.
7. Kiểm tra copylog.txt tồn tại.
8. Đọc lại copylog.txt.
9. Xác nhận copylog không chứa secret.
```


