# FreeAI

Web tĩnh quản lý model AI **miễn phí / 0đ**: quét danh sách model từ các URL nhà cung cấp, lưu API key theo từng URL, kiểm tra key còn sống, và xoay vòng ưu tiên các model đang chạy tốt.

Không framework, không build step, không dependency — HTML + CSS + ES modules thuần. Mở `index.html` là chạy.

## Chạy thử

```sh
npm start          # http://localhost:8788
```

Hoặc bất kỳ static server nào. Không dùng `file://` vì ES module bị chặn CORS.

## Test

```sh
npm test           # 193 case
npm run uicheck    # render app.js thật, kiểm tra model/key hiển thị
npm run bench      # đo hiệu năng detector/router
```

## Dữ liệu 0đ — bốn mức

Bộ lọc không phải bốn *loại* model, mà là bốn *mức chắc chắn* về cùng một câu hỏi "model này có miễn phí không":

| Mức | Nghĩa là | Nguồn |
| --- | --- | --- |
| `FREE_VERIFIED` | chắc chắn 0đ | giá 0 do chính nhà cung cấp công bố |
| `FREE_LIKELY` | có thể 0đ | tên model có chữ `free`, chưa có giá xác nhận |
| `FREE_UNKNOWN` | chưa rõ | không có giá, không có dấu hiệu |
| `PAID` | có phí | tìm thấy giá > 0 |

Hai chiều đều quan trọng: báo nhầm `VERIFIED` cho model có phí là gửi traffic thật vào túi tiền thật; báo nhầm `PAID` là giấu mất model miễn phí người dùng tìm. Vì vậy detector **luôn thiên về không khẳng định**.

Model có giá > 0 không bao giờ xuất hiện trong danh sách chính — màn hình đó tồn tại để trả lời "dùng cái gì miễn phí", một dòng có phí lọt vào giữa chính là cái bẫy.

## API key

- Mỗi URL có **nhiều key**, key gắn với URL và dùng chung cho mọi model của URL đó.
- Key lưu trong **IndexedDB** trên máy người dùng, **không** gửi lên đâu. Không dùng `localStorage`: registry lớn hơn chỗ của nó và `localStorage` là đồng bộ, chặn UI thread mỗi lần đọc.
- Màn hình chỉ hiện dạng che (`oc_s…R1q0`). Full key chỉ hiện khi bấm nút *Hiện và chép* — vừa hiện vừa copy, đúng cái mà người dùng đang làm.

## Khoá

Ba tầng, thấp nhất là key → model → URL:

- **khoá URL** → mọi model và key bên dưới dừng dùng
- **khoá model** → riêng model đó, kèm các key của nó
- **khoá key** → riêng key đó

Khoá là **bỏ khỏi vòng quay**, không phải ghim lên đầu. Model đã khoá vẫn hiện, vẫn sửa được — nó chỉ không được xoay tới nữa. Mở khoá theo tầng: đổi từ dưới lên.

## Kiến trúc

```
index.html          markup tĩnh
styles.css          toàn bộ giao diện
app.js              render + tương tác
sw.js               service worker, network-first
core/               logic thuần, không chạm DOM
core/adapters/      adapter cho từng nhà cung cấp
tests/              193 case, chạy bằng node không cần framework
```

Nguyên tắc: `core/` không bao giờ import DOM. Nhờ vậy toàn bộ logic kiểm thử được bằng node thuần, không cần trình duyệt.

## Offline

`sw.js` dùng network-first, chỉ cache cùng origin. Lệnh gọi API provider là cross-origin nên **không bao giờ** bị cache — cache một key hết hạn rồi dùng lại là tệ hơn không cache.

Cache đổi tên mỗi khi shell thay đổi (`fmh-vN`), vì worker mới giữ tên cũ sẽ tiếp tục phục vụ cache cũ. Số N nằm trong `sw.js` và `?v=` trong `index.html`.

## Browser

Safari iOS 16+, Chrome Android 110+. Cần ES modules và `color-mix()`.
