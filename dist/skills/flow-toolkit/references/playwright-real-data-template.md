# Playwright 真實資料鏈路 spec 範本（/flow-verify、/flow-ship 用）

> 封死最常見的假綠：(1) 沒 attach console listener → 100 個 error 仍綠；(2) 用 dev server 驗 → 滿屏 dev 噪音；(3) **mock 假資料 → 功能根本沒接通卻全綠**。本範本三鐵則 + 真實資料鏈路全封死。

## 三鐵則

1. **production build**（禁 dev server）：`build && preview/start`，不是 `dev`。dev mode 的 StrictMode 雙 render / HMR / source map 噪音與使用者實際體驗無關。
2. **Playwright `--headed`**（禁 headless）：使用者要親眼看 / AI 透過 listener 抓 error。無 display → 保底階梯暫停問，禁偷換 headless。
3. **attach `console` + `pageerror` listener**，結尾 `expect(errors).toHaveLength(0)`。

## 第四鐵則：真實資料鏈路（禁 mock 假綠）

**禁止**在 API client / 網路層 / 前端用 mock / stub / MSW / 寫死 fixture 攔截回假 response。SHALL：
- 測試資料**透過真實 create API 路徑 seed 進真 DB**（連寫入鏈路一起驗）
- 讀取走 **UI → 真 API → 真 query → 真 DB**
- 同時驗到 (a) API 真接通 (b) 資料正確性（query/join/filter/**scope**/序列化/型別）(c) 效能（真 DB 延遲/N+1/index/分頁）
- 真依賴未 ready → 標 **BLOCKED**，禁 mock fallback 假裝綠

## 完整 spec 範本

存到 `tests/e2e/<feature>.realdata.spec.ts`：

```typescript
import { test, expect, request, type Page, type APIRequestContext } from '@playwright/test';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:4173/api';
// 一個可辨識的 tag，方便驗完精準清掉這批 seed 資料（精確 WHERE）
const RUN_TAG = process.env.SMOKE_RUN_TAG ?? 'flowverify-local';

let api: APIRequestContext;
let seededId: string;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: API });

  // === 真實資料鏈路：透過「真 create API」把假資料寫進「真 DB」===
  // 不是 mock、不是直接 INSERT 繞過 API——連寫入鏈路、驗證、序列化一起驗
  const res = await api.post('/items', {
    data: { title: `seed-${RUN_TAG}`, body: '真實鏈路驗證用', tag: RUN_TAG },
  });
  expect(res.status(), `create API 應 201；實際 ${res.status()}`).toBe(201);
  const created = await res.json();
  seededId = created.id;
  expect(seededId, 'create API 應回傳真 DB 配的 id').toBeTruthy();
});

test.afterAll(async () => {
  // 驗完精準清這批（L1：精確 WHERE，先列預估、差異即停手）；失敗時不清、保留 artifact
  await api.delete(`/items?tag=${RUN_TAG}`);
  await api.dispose();
});

test.describe('REQ-E2E-002 建立並讀取 item（真實資料鏈路）', () => {
  let consoleErrors: string[];
  let pageErrors: Error[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = []; pageErrors = [];
    page.on('console', m => { if (m.type() === 'error')
      consoleErrors.push(`[${m.location().url}:${m.location().lineNumber}] ${m.text()}`); });
    page.on('pageerror', e => pageErrors.push(e));
    page.on('requestfailed', r =>
      consoleErrors.push(`[network] ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  });

  test('UI 從真 API 讀回剛 seed 進真 DB 的資料', async ({ page }) => {
    // === 鐵則四：UI → 真 API → 真 DB 讀回（非 mock）===
    await page.goto('/items');
    // UI 上要真的看得到那筆「經真 create API 進真 DB」的資料
    const row = page.getByText(`seed-${RUN_TAG}`);
    await expect(row, 'UI 應顯示從真 DB 撈回的 seed 資料；看不到=鏈路沒接通').toBeVisible();

    // 直接打真 API 再確認一次 shape / 型別 / scope（永不信任 UI 單一來源）
    const list = await api.get(`/items?tag=${RUN_TAG}`);
    expect(list.status()).toBe(200);
    const json = await list.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.some((x: any) => x.id === seededId)).toBe(true);

    // === 鐵則三：console / pageerror 零 ===
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
    expect(pageErrors, `Page errors:\n${pageErrors.map(e => e.stack).join('\n')}`).toHaveLength(0);
  });

  test('REQ-PERF-002 列表 API 在真 DB 下 p95 達 budget', async () => {
    // 效能要對「真 DB + 真資料量」量；mock 量不到 N+1 / index / 分頁問題
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = await page_now();           // 見下方 helper
      const r = await api.get('/items?page=1&size=20');
      expect(r.status()).toBe(200);
      samples.push((await page_now()) - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1];
    // 硬閘門：超過 budget 直接 FAIL（讀取太慢 = 驗證不通過，不是警告）
    expect(p95, `GET /items p95=${p95}ms 應 < 300ms`).toBeLessThan(300);
  });
});

// 用 performance.now()（避免依賴環境時鐘）
async function page_now(): Promise<number> {
  return performance.now();
}
```

## playwright.config.ts（強制 headed + production build）

```typescript
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://localhost:4173',
    headless: false,                 // 鐵則二：headed
    trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview',   // 鐵則一：production build，不是 dev
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

## 跑指令（PowerShell）

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:SMOKE_RUN_TAG = "flowverify-$(Get-Random)"   # 讓每次 seed 可精準識別清理
npx playwright test --headed tests/e2e/items.realdata.spec.ts
npx playwright show-report
```

## 例外清單（可 whitelist 的 console 訊息）

```typescript
const WHITELIST = [/favicon\.ico/, /OTS parsing error/];  // 每條都附註解說明為什麼可忽略
```
- 安全相關 error（CSP violation / CORS / mixed content）**禁止 whitelist**
- whitelist 超過 5 條 = red flag（噪音這麼多代表 code 本身有問題）

## 自查
- [ ] seed 走**真 create API**進真 DB（不是 mock、不是繞 API 直接 INSERT）
- [ ] UI 真的顯示從真 DB 撈回的資料（看不到就是鏈路沒接通）
- [ ] console/pageerror listener attach + 結尾 assert 零
- [ ] production build（webServer 是 build && preview/start，不是 dev）
- [ ] headed（config headless:false 或 --headed）
- [ ] 效能對真 DB 真資料量量、p95 達 budget、超過即 FAIL
- [ ] seed 資料有可識別 tag、驗完精準清（失敗保留 artifact）
