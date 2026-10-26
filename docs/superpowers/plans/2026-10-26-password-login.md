# Đăng nhập email + mật khẩu cho SuperSync — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng đăng nhập bằng email + mật khẩu ngay trong app; đăng nhập là bắt buộc, dữ liệu cục bộ chỉ là cache; thiết bị cũ có dữ liệu được gộp lên server theo ID lần đầu.

**Architecture:** Server thêm `POST /api/login/password` dùng lại JWT, cột `passwordHash`, `failedLoginAttempts`, `lockedUntil` sẵn có, cộng một CLI tạo user. Client thêm `SuperSyncAuthService` (đăng nhập, đọc phiên từ JWT), trang `/login` + guard, dịch vụ gộp lần đầu (hàm thuần so ID + hộp thoại hỏi từng project xung đột + một action persistent có meta-reducer upsert để ghi gộp trong MỘT thao tác, không dùng `SYNC_IMPORT`), và đăng xuất/đổi tài khoản = đẩy nốt cache rồi xóa dữ liệu cục bộ.

**Tech Stack:** Fastify 5 + zod 4 + Prisma 5.22 + bcryptjs + vitest (server); Angular + NgRx + Jasmine/Karma (client).

**Spec:** `docs/superpowers/specs/2026-10-26-password-login-design.md`

## Global Constraints

- Username = email, luôn `toLowerCase()` ở route và CLI (DB không phân biệt hoa/thường).
- Không đổi schema Prisma, không xóa cột; Postgres giữ nguyên. Token cũ vẫn hợp lệ: KHÔNG tăng `tokenVersion` khi login.
- `bcryptjs` với `BCRYPT_ROUNDS = 12`, `import * as bcrypt from 'bcryptjs'`.
- User tạo bằng CLI có `isVerified: 1`. Login phải kiểm `isVerified === 1`.
- Mật khẩu sai / user không tồn tại / `passwordHash` null / chưa verify: cùng một phản hồi 401 `{ error: 'Invalid credentials' }`, và luôn chạy một `bcrypt.compare` (hash giả khi không có user) để thời gian phản hồi không lộ email nào tồn tại.
- Khóa: 5 lần sai liên tiếp → `lockedUntil = now + 15 phút` (lựa chọn của người viết plan; đặt thành hằng số).
- Không có đăng ký, không có trang admin.
- Client: effect dùng `inject(LOCAL_ACTIONS)`; thay đổi nhiều thực thể qua meta-reducer (một op); chuỗi UI qua `T`, chỉ sửa `en.json` (+ `t.const.ts`); standalone component, Signals; không `any`; KHÔNG log email, token, mật khẩu hay nội dung — chỉ `{ id }`.
- Sau khi sửa mỗi file `.ts`/`.scss` client: `npm run checkFile <file>`. Test client: `npm run test:file <file>`. Test server: `cd packages/super-sync-server && npx vitest run tests/<file>`.
- Commit theo Angular format (`feat(sync): ...`), thêm dòng cuối `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Ngoài phạm vi: refresh token, OAuth, thanh toán, chia sẻ, trang admin, đăng ký.

## Review Focus

1. Email viết hoa/thừa khoảng trắng (`" User@X.com "`) phải đăng nhập được như `user@x.com`; CLI và route đều chuẩn hóa như nhau.
2. Đang offline lúc mở app lần đầu / chưa có token: trang login hiện thông báo "cần kết nối" rõ ràng, không treo. Có token cache thì vào app bình thường không cần mạng.
3. Token hết hạn / bị thu hồi (401 từ server khi sync): quay về `/login` mà KHÔNG xóa dữ liệu cục bộ chưa đồng bộ.
4. Đăng xuất / đổi tài khoản khi offline và còn thay đổi chưa đồng bộ: phải cảnh báo, không xóa im lặng.
5. Gộp lần đầu: project có subtask, task gắn tag, task thuộc `TODAY` (virtual tag — không được thêm `TODAY` vào `tagIds`), task trùng ID giữa hai bên, và tài khoản bật E2E mà máy chưa có khóa.

---

### Task 1: Server — endpoint đăng nhập bằng mật khẩu

**Files:**

- Create: `packages/super-sync-server/src/password.ts`
- Modify: `packages/super-sync-server/src/auth.ts` (thêm `signAuthToken`, `loginWithPassword`)
- Modify: `packages/super-sync-server/src/api.ts` (route + `SAFE_ERROR_MESSAGES`)
- Test: `packages/super-sync-server/tests/password-login.spec.ts`

**Interfaces:**

- Produces:
  - `password.ts`: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string | null): Promise<boolean>` (hash null → so với hash giả, trả `false`).
  - `auth.ts`: `signAuthToken(userId: number, email: string, tokenVersion: number): string`; `loginWithPassword(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }>` — ném `Error('Invalid credentials')` cho mọi lỗi (kể cả khóa; không tiết lộ khóa).
  - HTTP: `POST /api/login/password` body `{ email, password }` → 200 `{ token, user: { id, email } }` (cùng hình dạng passkey/magic-link) hoặc 401 `{ error: 'Invalid credentials' }`; 400 khi body sai; rate limit `max: 10, timeWindow: '15 minutes'`.

- [ ] **Step 1: Viết test thất bại** theo mẫu `tests/magic-link-registration.spec.ts` (hoist `JWT_SECRET`, mock `../src/db`, `importOriginal` cho `../src/auth`). Test: `loginWithPassword` trả token có payload `{userId,email,tokenVersion}` với mật khẩu đúng và email có hoa/khoảng trắng; ném `'Invalid credentials'` khi sai mật khẩu, khi user không tồn tại, khi `passwordHash` null, khi `isVerified === 0`; sai lần thứ 5 đặt `lockedUntil` (kiểm `prisma.user.update` được gọi với `lockedUntil` > now); đang bị khóa thì ném lỗi dù mật khẩu đúng; thành công reset `failedLoginAttempts: 0, lockedUntil: null` và KHÔNG gọi update `tokenVersion`; `verifyPassword(..., null)` trả `false`.
- [ ] **Step 2:** `npx vitest run tests/password-login.spec.ts` → FAIL (module chưa có).
- [ ] **Step 3: Implement** `password.ts` và `loginWithPassword`/`signAuthToken` trong `auth.ts` (thay 3 chỗ ký JWT lặp lại bằng `signAuthToken`, giữ hành vi). Thêm route trong `src/api.ts` theo kiểu zod hiện có (`LoginPasswordSchema`), thêm `'Invalid credentials'` vào `SAFE_ERROR_MESSAGES`.
- [ ] **Step 4:** chạy lại test và toàn bộ `npx vitest run` → PASS (không hỏng test cũ).
- [ ] **Step 5: Commit** `feat(sync-server): add email+password login endpoint`.

### Task 2: Server — CLI tạo user / đặt mật khẩu

**Files:**

- Create: `packages/super-sync-server/scripts/set-password.ts`
- Modify: `packages/super-sync-server/package.json` (script `"set-password": "ts-node scripts/set-password.ts"`)
- Modify: `packages/super-sync-server/README.md` (một đoạn ngắn cách dùng + nhắc `pg_dump` trước khi deploy)
- Test: `packages/super-sync-server/tests/set-password.spec.ts`

**Interfaces:**

- Consumes: `hashPassword` (Task 1).
- Produces: `setPassword(email: string, password: string): Promise<{ created: boolean }>` export từ `scripts/set-password.ts`; CLI `npm run set-password -- <email> <password>`. Tạo mới với `isVerified: 1`; nếu user đã tồn tại chỉ cập nhật `passwordHash`, đặt `isVerified: 1`, reset `failedLoginAttempts`/`lockedUntil`. Mật khẩu < 10 ký tự → ném lỗi. Email chuẩn hóa lowercase+trim. Không import `src/auth` (tránh yêu cầu `JWT_SECRET`).

- [ ] **Step 1:** viết test cho `setPassword`: tạo mới (`created: true`, `isVerified: 1`, hash bcrypt hợp lệ, không phải plaintext); cập nhật user cũ giữ nguyên `tokenVersion`; mật khẩu ngắn bị từ chối; email hoa được hạ chữ thường.
- [ ] **Step 2:** chạy test → FAIL.
- [ ] **Step 3:** implement theo mẫu `scripts/delete-user.ts` (`disconnectDb()` trong `finally`, `process.exit(1)` khi lỗi; chỉ chạy `main` khi là entry point để import được trong test).
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5: Commit** `feat(sync-server): add set-password admin CLI`.

### Task 3: Client — `SuperSyncAuthService`

**Files:**

- Create: `src/app/op-log/sync-providers/super-sync/super-sync-auth.service.ts`
- Test: `src/app/op-log/sync-providers/super-sync/super-sync-auth.service.spec.ts`

**Interfaces:**

- Consumes: `SyncProviderManager` (`getProviderConfig`, `setProviderConfig`, `clearAuthCredentials`), `GlobalConfigService.updateSection('sync', …)`, `SUPER_SYNC_DEFAULT_BASE_URL`.
- Produces (`providedIn: 'root'`):
  - `login(baseUrl: string, email: string, password: string): Promise<AuthSession>` — `fetch(`${baseUrl}/api/login/password`)`; 401 → ném `InvalidCredentialsError`; lỗi mạng → ném `LoginNetworkError`; thành công **không** lưu ngay (Task 8 cần so tài khoản trước) mà trả `{ token, userId, email, baseUrl }`.
  - `commitSession(s: AuthSession): Promise<void>` — lưu `{baseUrl, accessToken}` vào private cfg SuperSync và `updateSection('sync', { isEnabled: true, syncProvider: SyncProviderId.SuperSync })`.
  - `getSession(): Promise<{ userId: number; email: string } | null>` — giải mã payload JWT đang lưu (base64url, không xác thực chữ ký), `null` nếu không có token/hỏng.
  - `type AuthSession = { token: string; userId: number; email: string; baseUrl: string }`.

- [ ] **Step 1:** viết test: `login` gọi đúng URL (bỏ `/` cuối `baseUrl`) với body JSON đã trim+lowercase email; 401 → `InvalidCredentialsError`; `fetch` reject → `LoginNetworkError`; `commitSession` gọi `setProviderConfig` và `updateSection`; `getSession` đọc đúng `userId/email` từ JWT mẫu và trả `null` với token rác.
- [ ] **Step 2:** `npm run test:file <spec>` → FAIL.
- [ ] **Step 3:** implement. Không log email/token.
- [ ] **Step 4:** test → PASS; `npm run checkFile` cho cả hai file.
- [ ] **Step 5: Commit** `feat(sync): add SuperSync password auth service`.

### Task 4: Client — trang đăng nhập và cổng bắt buộc

**Files:**

- Create: `src/app/pages/login-page/login-page.component.ts` (+ `.html`, `.scss` tối thiểu; theo `docs/styling-guide.md`, HTML phẳng)
- Create: `src/app/core/auth/login.guard.ts` (+ `login.guard.spec.ts`)
- Modify: `src/app/app.routes.ts` (route `login`, thêm `LoginGuard` vào `canActivate` của các route hiện có và `**`)
- Modify: `src/app/t.const.ts`, `src/assets/i18n/en.json` (khóa `F.SYNC.LOGIN.*`: tiêu đề, email, mật khẩu, URL server, nút, lỗi sai thông tin, lỗi mạng/offline)

**Interfaces:**

- Consumes: `SuperSyncAuthService.getSession/login`, `isOnline()` (`util/is-online.ts`).
- Produces: `LoginGuard` (`@Injectable({providedIn:'root'})`, `canActivate(): Promise<boolean | UrlTree>`) — có session → `true`, không → `UrlTree` `/login`. Route `login` KHÔNG có guard này. Trang login gọi `login()` rồi chuyển cho `AccountSessionService.completeLogin(session)` (Task 8); trước Task 8 tạm gọi `commitSession` — Task 8 thay thế lời gọi này.

- [ ] **Step 1:** test guard: có token → `true`; không → `UrlTree` tới `/login`; chạy được khi offline (chỉ đọc cache).
- [ ] **Step 2:** FAIL → **Step 3:** implement guard + component (ô URL server mặc định `SUPER_SYNC_DEFAULT_BASE_URL`, hiện lỗi `InvalidCredentialsError` / `LoginNetworkError` / offline bằng khóa `T`; khóa nút khi đang gửi). Thêm test component: submit gọi `login` với giá trị form; hiện thông báo offline khi `isOnline()` false.
- [ ] **Step 4:** test → PASS; `checkFile` mọi file đã sửa. Chạy `ng serve`, mở app chưa có token → chuyển `/login`; đăng nhập với user tạo bằng CLI (Task 2) → vào được app, sync bật.
- [ ] **Step 5: Commit** `feat(sync): add login page and mandatory login guard`.

### Task 5: Client — hàm thuần gộp lần đầu

**Files:**

- Create: `src/app/op-log/sync/first-sync-merge/first-sync-merge.ts`
- Test: `src/app/op-log/sync/first-sync-merge/first-sync-merge.spec.ts`

**Interfaces:**

- Produces (hàm thuần, không inject):
  - `type MergeChoice = 'LOCAL' | 'REMOTE'`
  - `type ProjectConflict = { projectId: string; title: string }`
  - `diffForFirstSync(local: AppDataComplete, remote: AppDataComplete): { conflicts: ProjectConflict[] }` — conflict = cùng ID project, nội dung khác (so sánh sâu project entity + tập task thuộc project; bỏ qua trường chỉ lưu thời điểm sửa nếu chúng làm hai bản "giống nhau" bị coi khác — dùng `JSON` ổn định sau khi loại các khóa không ý nghĩa; ghi rõ lựa chọn trong comment).
  - `buildMergePayload(local, remote, choices: Record<string, MergeChoice>): FirstSyncMergePayload` với `FirstSyncMergePayload = { projects: Project[]; tasks: Task[]; tags: Tag[]; globalConfig: GlobalConfigState | null; archiveTasks: TaskCopy[] }` = **những thực thể cần ghi lên trên nền trạng thái remote**: project chỉ local + project xung đột chọn LOCAL (kèm task của chúng); task không thuộc project (Inbox/chỉ tag) gộp theo ID, trùng ID lấy `modified` mới hơn; tag union theo ID; `globalConfig` = config local nếu remote chưa có config (nếu không, `null`); task lưu trữ (archive) chỉ local theo ID.
- Quy tắc: project chỉ remote → không có trong payload (đã nằm ở remote). Project xung đột chọn REMOTE → bỏ project và task local của nó. Không bao giờ thêm `'TODAY'` vào `tagIds`; `project.taskIds`/`parentId`/`subTaskIds` giữ nhất quán với tập task được đưa vào payload.

- [ ] **Step 1: Viết test thất bại**, mỗi quy tắc trên một test với dữ liệu nhỏ dựng tay: local-only project (+subtask) có trong payload; remote-only không có; cùng ID giống hệt → không là conflict; cùng ID khác → có conflict, `choices LOCAL` đưa vào payload cả task, `REMOTE` thì không; task Inbox trùng ID lấy bản `modified` mới; tag union; config local chỉ khi remote không có; tên giống nhưng ID khác → hai project riêng, không conflict; `TODAY` không xuất hiện trong `tagIds` của payload.
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** PASS + `checkFile`.
- [ ] **Step 5: Commit** `feat(sync): add pure first-sync merge diff and payload builder`.

### Task 6: Client — action + meta-reducer ghi gộp trong một thao tác

**Files:**

- Create: `src/app/root-store/meta/first-sync-merge.meta-reducer.ts` (+ `.spec.ts`), action `applyFirstSyncMerge` trong cùng thư mục hoặc theo vị trí action của repo (xem `root-store/meta/task-shared-meta-reducers/` làm mẫu)
- Modify: nơi đăng ký meta-reducer của root store (cùng chỗ các `task-shared-meta-reducers` được đăng ký), và nơi khai báo action persistent để op-log bắt được (`meta: { isPersistent: true, … }`)

**Interfaces:**

- Consumes: `FirstSyncMergePayload` (Task 5).
- Produces: `applyFirstSyncMerge = createAction('[Sync] Apply first-sync merge', props<{ payload: FirstSyncMergePayload }>())` với `meta.isPersistent: true` (loại thực thể theo quy ước capture của repo). Meta-reducer upsert `projects`, `tasks`, `tags` (và `globalConfig` nếu khác `null`) vào state trong MỘT lần reduce; ghi `archiveTasks` qua đường `ArchiveOperationHandler` hiện có (đọc `OperationApplierService`/handler để dùng đúng điểm vào; nếu archive không thể ghi từ action này, dừng và báo lại thay vì bỏ qua).

- [ ] **Step 1:** test meta-reducer: state có project A; payload thêm project B + 2 task → state chứa B và task, A không đổi; payload ghi đè project C trùng ID; `TODAY_TAG.taskIds` không bị mất; áp cùng action hai lần cho cùng kết quả (idempotent, quan trọng cho replay).
- [ ] **Step 2:** FAIL → **Step 3:** implement + đăng ký. **Step 4:** PASS + `checkFile`.
- [ ] **Step 5: Commit** `feat(sync): add atomic first-sync merge action`.

### Task 7: Client — gộp lần đầu nối vào luồng sync + hộp thoại xung đột

**Files:**

- Create: `src/app/imex/sync/dialog-project-merge-conflict/dialog-project-merge-conflict.component.ts` (+ html, spec) và `project-merge-conflict-dialog.service.ts` (mẫu: `op-log/sync/sync-import-conflict-dialog.service.ts`, kể cả `UserInputWaitStateService.startWaiting`)
- Create: `src/app/op-log/sync/first-sync-merge/first-sync-merge.service.ts` (+ spec)
- Modify: `src/app/imex/sync/sync-wrapper.service.ts` (`_handleLocalDataConflict`, ~dòng 1055)
- Modify: `t.const.ts`, `en.json`

**Interfaces:**

- Consumes: `LocalDataConflictError.remoteSnapshotState` (dạng `AppDataComplete`), `StateSnapshotService.getAllSyncModelDataFromStoreAsync()`, `diffForFirstSync`, `buildMergePayload`, `OperationLogSyncService.forceDownloadRemoteState(provider)`, store dispatch.
- Produces:
  - `ProjectMergeConflictDialogService.open(conflicts: ProjectConflict[]): Promise<Record<string, MergeChoice> | null>` (`null` = hủy).
  - `FirstSyncMergeService.run(error: LocalDataConflictError, provider: SyncProviderServiceInterface<SyncProviderId>): Promise<'MERGED' | 'CANCELLED'>`: (1) chụp local `AppDataComplete`; (2) E2E: nếu remote mã hóa mà thiếu khóa → mở luồng nhập khóa hiện có, hủy nếu bỏ; hai bên khác nhau về bật E2E → snackbar lỗi, trả `'CANCELLED'`; (3) `diffForFirstSync`; (4) có conflict thì mở dialog, `null` → `'CANCELLED'`; (5) `forceDownloadRemoteState` rồi `dispatch(applyFirstSyncMerge({payload}))` (payload tính từ snapshot local ĐÃ chụp ở bước 1), rồi sync đẩy lên.
  - `_handleLocalDataConflict` gọi `FirstSyncMergeService.run` thay cho dialog cả-trạng-thái khi provider là SuperSync; `CANCELLED` giữ hành vi hủy cũ (snackbar `LOCAL_DATA_REPLACE_CANCELLED`). Các provider khác giữ luồng cũ.

- [ ] **Step 1:** test `FirstSyncMergeService` (mock các phụ thuộc): không conflict → không mở dialog, dispatch đúng payload, trả `'MERGED'`; có conflict, dialog trả `{p1:'LOCAL'}` → payload có p1; dialog `null` → không `forceDownloadRemoteState`, trả `'CANCELLED'`; E2E lệch → `'CANCELLED'` và không dispatch. Test `sync-wrapper` hiện có vẫn qua + 1 test mới: SuperSync + `LocalDataConflictError` gọi `FirstSyncMergeService.run`.
- [ ] **Step 2:** FAIL → **Step 3:** implement (component dialog: danh sách project xung đột, mỗi dòng chọn "Giữ bản trên máy" / "Giữ bản trên server"; chỉ tên project). **Step 4:** PASS + `checkFile`.
- [ ] **Step 5: Commit** `feat(sync): merge local cache into remote by ID on first SuperSync login`.

### Task 8: Client — đăng xuất / đổi tài khoản = đẩy cache rồi xóa

**Files:**

- Create: `src/app/core/auth/account-session.service.ts` (+ spec), `src/app/op-log/persistence/local-data-wipe.service.ts` (+ spec)
- Modify: `src/app/pages/login-page/login-page.component.ts` (dùng `completeLogin` thay `commitSession`)
- Modify: `src/app/features/config/form-cfgs/sync-form.const.ts` (thay nút "Get token" của SuperSync bằng nút "Đăng xuất" hiển thị khi có phiên; email phiên hiện tại hiển thị cạnh) — hoặc nơi hợp lý hơn trong UI nếu form không dùng được
- Modify: `t.const.ts`, `en.json`

**Interfaces:**

- Consumes: `SuperSyncAuthService.getSession/commitSession`, `SyncWrapperService.sync()`, `isOnline()`, `OperationLogStoreService` (đếm op chưa đồng bộ — dùng API sẵn có cạnh `clearUnsyncedOps()`), `StateSnapshot`/backup export để xuất file cứu hộ.
- Produces:
  - `LocalDataWipeService.wipeAll(): Promise<void>` — xóa op-log, `state_cache`, archive (IndexedDB), thông tin đăng nhập SuperSync, rồi reload trang (dùng `clearAllOperations()` và các API xóa archive/state đã có; không dùng các hàm `_clearAllDataForTesting`).
  - `AccountSessionService.logout(): Promise<'DONE' | 'CANCELLED'>`: online → `sync()` rồi `wipeAll()`; offline hoặc sync lỗi mà còn op chưa đồng bộ → hộp xác nhận cảnh báo mất thay đổi (cho phép xuất file sao lưu trước), hủy thì không xóa; không còn op chưa đồng bộ → xóa luôn.
  - `AccountSessionService.completeLogin(s: AuthSession): Promise<'DONE' | 'CANCELLED'>`: nếu `getSession()` hiện có `userId` khác `s.userId` → chạy `logout()`-giống (flush + xác nhận + `wipeAll`) rồi `commitSession`; cùng `userId` hoặc chưa có phiên → `commitSession` luôn (thiết bị có dữ liệu cũ sẽ qua `FirstSyncMergeService` ở lần sync đầu).

- [ ] **Step 1:** test: logout online gọi `sync` trước `wipeAll`; offline + 3 op chưa đồng bộ → hỏi xác nhận, hủy thì `wipeAll` KHÔNG được gọi; offline + 0 op → xóa; `completeLogin` cùng userId không xóa; khác userId xóa rồi mới commit; `wipeAll` gọi đủ các nơi xóa (spy).
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** PASS + `checkFile`.
- [ ] **Step 5: Commit** `feat(sync): add logout and account switch that flush then wipe local cache`.

### Task 9: Kiểm thử tích hợp thủ công và dọn dẹp

**Files:** `docs/superpowers/specs/2026-10-26-password-login-design.md` (đánh dấu "Đã triển khai"), `packages/super-sync-server/README.md` nếu cần.

- [ ] **Step 1:** khởi động server (`docker compose -f docker-compose.yaml -f docker-compose.supersync.yaml up -d supersync`), tạo hai user bằng `npm run set-password`.
- [ ] **Step 2:** kịch bản tay, ghi lại kết quả: (a) trình duyệt sạch → bị chuyển `/login`; sai mật khẩu → lỗi; đúng → vào app. (b) Hồ sơ trình duyệt có sẵn project cục bộ (không có token) + tài khoản có project khác + một project cùng ID khác nội dung → hộp thoại hỏi đúng project đó; chọn xong kiểm hai bên đủ dữ liệu. (c) Máy có token cũ (đã sync) khởi động lại không bị hỏi gì. (d) Đăng xuất offline khi còn thay đổi → cảnh báo. (e) Đăng nhập tài khoản B trên máy đang là A → flush A rồi wipe.
- [ ] **Step 3:** `npm run lint` và `npm test` (client), `npx vitest run` (server) → PASS. Ghi rõ nếu E2E Playwright chưa được thêm (xem Rủi ro).
- [ ] **Step 4: Commit** `docs(sync): mark password login design implemented`.

## Rủi ro đã biết cho người thực thi

- Task 6 là chỗ rủi ro nhất: chưa kiểm chứng cách capture layer xử lý action nhiều thực thể và cách ghi archive từ meta-reducer. Nếu không khả thi, dừng và báo lại; không âm thầm chuyển sang `SYNC_IMPORT`.
- Chưa kiểm chứng: `passkey.ts` có yêu cầu `isVerified` không (không ảnh hưởng plan này); hành vi `addProject` với ID đã tồn tại (plan tránh bằng meta-reducer upsert).
- Chưa có test E2E Playwright cho đăng nhập (cần server SuperSync chạy; có thể thêm sau theo `e2e:supersync:file`).
