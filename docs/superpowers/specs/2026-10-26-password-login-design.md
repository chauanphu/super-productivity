# Đăng nhập email + mật khẩu để bật đồng bộ SuperSync

Ngày: 2026-10-26. Trạng thái: bản nháp chờ duyệt.

## Mục đích

Hiện nay, để đồng bộ, người dùng phải mở trang web của server SuperSync, đăng nhập (passkey / magic link), sao chép JWT và dán vào ô cấu hình trong app. Rất phiền. Mục tiêu: một trang Đăng nhập ngay trong app (email + mật khẩu). Đăng nhập xong app tự nhận token và tự bật đồng bộ. Hướng tới một dịch vụ nhiều người dùng, mỗi người một vùng dữ liệu riêng.

## Mục tiêu

- Trang/hộp thoại đăng nhập trong app: email + mật khẩu.
- Sau đăng nhập, token được lưu và SuperSync tự bật; không còn dán token.
- Lần đầu một thiết bị kết nối với một tài khoản: gộp dữ liệu local và remote theo quy tắc dưới đây.
- Đăng xuất: xem mục "Cần chốt" bên dưới (cache cục bộ xử lý ra sao; chưa chốt).
- Công cụ dòng lệnh (CLI) trên server để tạo user, đặt/đổi mật khẩu.
- Thiết bị đang đồng bộ bằng token cũ vẫn chạy bình thường sau khi triển khai.

## Không phải mục tiêu

- Không có trang đăng ký, không có trang admin, không có lời mời. Người quản trị tạo user trực tiếp trên hệ thống.
- Không OAuth / đăng nhập xã hội, không thanh toán / gói dịch vụ, không chia sẻ project giữa tài khoản, không tổ chức/nhóm.
- Không đổi Postgres sang SQLite: server tiếp tục dùng Postgres + Prisma.
- Không thay đổi cơ chế token 365 ngày hay thêm refresh token (ngoài phạm vi).

## Chống mục tiêu (thất bại dù chạy được)

- Cho dùng app như một kho dữ liệu cục bộ độc lập khi chưa đăng nhập. (Đã đổi: trước đây cho phép dùng local; nay đăng nhập là bắt buộc, local chỉ là cache.)
- Mất thay đổi chưa đồng bộ khi offline hoặc khi đăng xuất / đổi tài khoản.
- Mất hoặc nhân đôi dữ liệu người dùng khi gộp lần đầu.
- Đẩy dữ liệu của tài khoản A sang tài khoản B khi đổi tài khoản trên cùng một thiết bị.
- Làm gián đoạn các thiết bị đang đồng bộ.
- Ghi mật khẩu, token hoặc nội dung người dùng vào log (xem `Log.log` trong CLAUDE.md: chỉ log ID).

## Các quyết định đã chốt với người dùng

1. Username = email. Không thêm cột username.
2. (Cập nhật sau lần duyệt cuối) Đăng nhập là BẮT BUỘC: chưa đăng nhập thì chặn việc dùng app (chỉ thấy trang đăng nhập). Dữ liệu cục bộ chỉ là bộ nhớ đệm (cache): dùng được khi mất kết nối, và tự đồng bộ khi có kết nối lại. Không còn chế độ dùng cục bộ độc lập.
   - Thiết bị đã có dữ liệu trước lần triển khai này: cho phép đồng bộ từ local LÊN trước (coi dữ liệu local là cache chưa đồng bộ) khi đăng nhập lần đầu.
3. Quy tắc gộp lần đầu (so khớp theo **ID**, không theo tên):
   - Project chỉ có ở local: đẩy lên server cùng task của nó.
   - Project chỉ có ở remote: kéo về.
   - Project cùng ID, nội dung khác nhau: hộp thoại hỏi giữ local hay remote, hỏi riêng từng project; task đi theo bản được chọn.
   - Task ngoài project (Inbox, chỉ gắn tag): gộp theo ID; trùng ID thì lấy bản sửa gần nhất.
   - Tag: gộp theo ID, giữ cả hai.
   - Cấu hình: lấy từ server nếu tài khoản đã có cấu hình; nếu chưa (tài khoản mới) thì đẩy cấu hình local lên.
   - Archive và lịch sử theo dõi thời gian: gộp theo ID như trên.
4. Gộp chỉ chạy khi thiết bị chưa từng đồng bộ với tài khoản đó. Thiết bị đã đồng bộ thì bỏ qua.
5. Đổi sang tài khoản khác trên thiết bị đã từng đồng bộ với tài khoản khác: cảnh báo; cho chọn giữ dữ liệu cũ cục bộ và tách ra, hoặc xóa cục bộ rồi kéo dữ liệu tài khoản mới. Không bao giờ tự gộp.
6. Triển khai tương thích ngược: không tăng `tokenVersion`; migration chỉ thêm, không xóa cột; passkey/magic link/token cũ tiếp tục dùng được; user cũ đăng nhập mật khẩu được sau khi admin đặt mật khẩu bằng CLI. Trước khi triển khai nên `pg_dump`.

## Ràng buộc kỹ thuật (đã biết từ khảo sát code)

- Server: `packages/super-sync-server` (Fastify, Postgres, Prisma 5.22, `bcryptjs` đã có sẵn). Bảng `User` đã có `email`, `passwordHash` (nullable), `failedLoginAttempts`, `lockedUntil`, `tokenVersion`, `isVerified`. Dữ liệu `Operation`, `UserSyncState`, `SyncDevice` đã gắn `userId`.
- Server hiện có endpoint passkey/magic-link trong `src/api.ts`; theo khảo sát chưa thấy endpoint đăng nhập bằng mật khẩu (chưa kiểm chứng hết, người xây dựng cần xác nhận). JWT hiện chứa `{userId, email, tokenVersion}`.
- Client: provider `src/app/op-log/sync-providers/super-sync/`, cấu hình tại `features/config/form-cfgs/sync-form.const.ts` (nút "Get token" chỉ mở trang web), lưu thông tin nhạy cảm qua `credential-store.service.ts`.
- Quy tắc của dự án (CLAUDE.md): effect dùng `inject(LOCAL_ACTIONS)`; thay đổi nhiều thực thể phải atomic qua meta-reducer; chuỗi UI qua `T`/translate và chỉ sửa `en.json`; không log nội dung người dùng; standalone component; ưu tiên Signals.
- Gộp dữ liệu phải qua một bước đối chiếu trước lần đồng bộ đầu tiên, vì cơ chế đồng bộ là nhật ký thao tác của toàn bộ trạng thái, không gộp theo từng project. Đây là phần rủi ro lớn nhất.

## Cần chốt (sau thay đổi "đăng nhập bắt buộc")

- ĐÃ CHỐT: quy tắc gộp ở mục 3 (kể cả hộp thoại hỏi giữ local hay remote cho project cùng ID khác nội dung) vẫn áp dụng cho thiết bị đã có dữ liệu trước lần triển khai, khi đẩy local lên lần đầu. Thiết bị mới/trống thì chỉ kéo về.
- Mục 5 (cảnh báo đổi tài khoản) được thay bằng: khi đăng xuất / đổi tài khoản, đẩy nốt cache lên tài khoản cũ nếu còn kết nối, rồi xóa dữ liệu cục bộ. Nếu đang offline và còn thay đổi chưa đồng bộ thì cảnh báo rõ trước khi xóa. (Quyết định của người viết, chưa được người dùng duyệt riêng.)
- Hộp thoại xung đột chỉ nêu tên project và cho chọn local/remote; không thêm cảnh báo về các thiết bị khác. Bản local được chọn sẽ ghi đè bản remote trên mọi thiết bị của tài khoản (quyết định của người viết).

## Quyết định của người viết (chưa được người dùng duyệt riêng)

- Gộp lần đầu sinh op theo từng thực thể trên nền trạng thái remote; không dùng `SYNC_IMPORT` khi tài khoản đã có thiết bị khác (nó loại bỏ op đồng thời của các máy đó).
- Máy dùng token cũ bấm Đăng nhập: đọc `userId` từ JWT đang lưu, so với tài khoản mới; khác nhau thì xử lý như đổi tài khoản.
- Hộp thoại đăng nhập có ô URL server với giá trị mặc định, sửa được (hỗ trợ self-host).
- User tạo bằng CLI được coi là đã xác minh email (`isVerified = true`).
- E2E: nếu tài khoản bật E2E mà máy chưa có khóa, yêu cầu nhập khóa trước khi gộp; hai bên khác nhau về việc bật E2E thì báo lỗi rõ ràng, chưa hỗ trợ gộp.

## Giao cho người xây dựng quyết định

- Thuật toán băm: dùng `bcryptjs` đã có, trừ khi có lý do khác.
- Hình thức endpoint đăng nhập, cách tái sử dụng khóa tài khoản / giới hạn tần suất / hạn mức hiện có.
- Cách phát hiện "thiết bị chưa từng đồng bộ với tài khoản này".
- Cách so nội dung để xác định project "khác nhau".
- Giao diện cụ thể của trang đăng nhập và hộp thoại xung đột (theo `docs/styling-guide.md`).
- Chi tiết lệnh CLI (tên lệnh, tham số).
- Chiến lược kiểm thử, ít nhất: đăng nhập đúng/sai/bị khóa, gộp lần đầu (cả ba trường hợp project), đổi tài khoản, thiết bị token cũ không bị ảnh hưởng.

## Chưa kiểm chứng

- Phần reset mật khẩu cũ trong server là code chết hay còn dùng.
- Thư mục `scripts/` và `tools/` của server có công cụ quản trị nào chưa.
- Cơ chế mã hóa đầu-cuối (E2E) tương tác thế nào với đăng nhập mật khẩu: giả định mật khẩu đăng nhập và khóa mã hóa là hai thứ riêng, giữ nguyên hiện trạng.
