// Заказ: примерка → согласие → заказ по quoteId, без дублей; отказы API, сеть,
// повторы; ключ нигде не печатается.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFakeApi, withServer, startServer, KEY, sleep } from './helpers.mjs';

let api;
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());
beforeEach(() => {
  Object.assign(api.state, { balance: 1500, bonusBalance: 200, priceFactor: 1, seq: 0 });
  api.state.requests.length = 0;
  api.state.queue.length = 0;
  api.state.orders.clear();
  api.state.byKey.clear();
});

const LIKES = { serviceId: 'svc-ig-likes', link: 'https://instagram.com/p/AAA', quantity: 5000 };
const posts = () => api.requestsTo('POST', '/api/v1/orders');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── Примерка и заказ ────────────────────────────────────────────────────────────

test('quote_order: примерка по контракту, quoteId, срок и строка для человека', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', { ...LIKES, projectId: 'prj-1' });

    const sent = api.requestsTo('POST', '/api/v1/orders/quote');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { ...LIKES, projectId: 'prj-1' });
    assert.equal(sent[0].headers['idempotency-key'], undefined, 'у примерки ключа повтора нет');

    assert.match(q.quoteId, UUID);
    const ttl = Date.parse(q.expiresAt) - Date.now();
    assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `примерка живёт 15 минут, а не ${ttl} мс`);
    // Всё из примерки — как пришло.
    assert.equal(q.price, 1350);
    assert.equal(q.fromBonus, 200);
    assert.equal(q.fromBalance, 1150);
    assert.equal(q.enough, true);
    assert.equal(q.discountSource, 'volume');
    // 5 000 шт. «Лайки» (Instagram*) по ссылке … за 1 350 ₽ (скидка за объём 23 %), с подарочного … 200 ₽, с основного — 1 150 ₽.
    assert.match(q.summary, /^5\s000 шт\. «Лайки» \(Instagram\*\) по ссылке https:\/\/instagram\.com\/p\/AAA за 1\s350 ₽/);
    assert.match(q.summary, /скидка за объём 23 %/);
    assert.match(q.summary, /с подарочного баланса спишется 200 ₽, с основного — 1\s150 ₽\.$/);
    // Денег примерка не трогает и заказа не ставит.
    assert.equal(posts().length, 0);
    assert.equal(api.state.balance, 1500);
  }));

test('quote → place: Idempotency-Key = quoteId, maxPrice = цена примерки, тело — из примерки', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    const r = await s.call('place_order', { quoteId: q.quoteId });

    assert.equal(posts().length, 1);
    const [req] = posts();
    assert.equal(req.headers['idempotency-key'], q.quoteId);
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(req.body, { ...LIKES, maxPrice: 1350 });

    assert.equal(r.replayed, false);
    assert.equal(r.order.id, 'ord-1');
    assert.equal(r.order.price, 1350);
    assert.match(r.summary, /^Заказ оформлен, номер ord-1, статус: выполняется, списано 1\s350 ₽\./);
    assert.equal(api.state.orders.size, 1);
    assert.equal(api.state.balance, 350);
  }));

test('повтор place_order по той же примерке второго заказа не ставит', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    await s.call('place_order', { quoteId: q.quoteId });
    const again = await s.call('place_order', { quoteId: q.quoteId });

    assert.equal(posts().length, 2);
    assert.deepEqual(posts().map((r) => r.headers['idempotency-key']), [q.quoteId, q.quoteId]);
    assert.equal(api.state.orders.size, 1, 'заказ один');
    assert.equal(api.state.balance, 350, 'списание одно');
    assert.equal(again.replayed, true);
    assert.equal(again.order.id, 'ord-1');
    assert.match(again.summary, /^Заказ по этой примерке уже был оформлен — второй не ставился\. Номер ord-1/);
  }));

test('заказ, закрытый в самом оформлении (cancelled), — так и сказано: деньги вернулись', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    api.once('POST /api/v1/orders', (req, res, ctx) => {
      const order = ctx.createOrder();
      order.status = 'cancelled';
      order.refunded = order.price;
      api.json(res, 200, order);
    });
    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(r.summary, /^Заказ оформлен, номер ord-1, но сразу закрыт: услугу сейчас не выполнить, деньги вернулись на баланс\./);

    // Повтор отдаёт текущее состояние — и там это просто «отменён».
    const again = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(again.summary, /второй не ставился\. Номер ord-1, статус: отменён/);
  }));

test('две примерки — два разных ключа и два заказа: новая примерка — это новый заказ', () =>
  withServer(api, {}, async (s) => {
    const a = await s.call('quote_order', { ...LIKES, quantity: 100 });
    const b = await s.call('quote_order', { ...LIKES, quantity: 100 });
    assert.notEqual(a.quoteId, b.quoteId);
    await s.call('place_order', { quoteId: a.quoteId });
    await s.call('place_order', { quoteId: b.quoteId });
    assert.equal(api.state.orders.size, 2);
  }));

test('без примерки заказа нет: неизвестный quoteId — отказ, запроса к API нет', () =>
  withServer(api, {}, async (s) => {
    const r = await s.call('place_order', { quoteId: '00000000-0000-4000-8000-000000000000' });
    assert.match(r.error, /нет или она истекла/);
    assert.match(r.error, /quote_order заново/);
    assert.match((await s.call('place_order', {})).error, /Не хватает аргумента «quoteId»/);
    assert.match((await s.call('place_order', { quoteId: 'x', serviceId: 'svc-ig-likes' })).error, /Неизвестный аргумент/);
    assert.equal(posts().length, 0);
  }));

test('примерка из другого процесса сервера не принимается (примерки живут в памяти)', async () => {
  const q = await (async () => {
    const s = startServer(api);
    try {
      return await s.call('quote_order', LIKES);
    } finally {
      await s.stop();
    }
  })();
  await withServer(api, {}, async (s) => {
    assert.match((await s.call('place_order', { quoteId: q.quoteId })).error, /нет или она истекла/);
  });
  assert.equal(posts().length, 0);
});

test('истёкшая примерка — отказ «сделайте quote_order заново», запроса к API нет', () =>
  withServer(api, { LS_QUOTE_TTL_MS: '150' }, async (s) => {
    const q = await s.call('quote_order', LIKES);
    await sleep(250);
    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(r.error, /истекла/);
    assert.match(r.error, /quote_order заново/);
    assert.equal(posts().length, 0);
  }));

// ── Деньги ──────────────────────────────────────────────────────────────────────

test('нехватка денег: примерка говорит, сколько не хватает, 402 на заказе — сумма и ссылка', () =>
  withServer(api, {}, async (s) => {
    api.state.balance = 100;
    api.state.bonusBalance = 50;
    const q = await s.call('quote_order', LIKES);
    assert.equal(q.enough, false);
    assert.match(q.summary, /Не хватает 1\s200 ₽: на балансе 100 ₽ и 50 ₽ подарочных\. Пополнить: http:\/\/127\.0\.0\.1:\d+\/dashboard\/balance#topup\.$/);

    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(
      r.error,
      /^Не хватает 1\s200 ₽: заказ стоит 1\s350 ₽, на балансе 100 ₽ и 50 ₽ подарочных \(код insufficient_balance\)\. Пополнить баланс: /,
    );
    assert.doesNotMatch(r.error, /Insufficient balance|Не хватает денег на балансе/);
    assert.match(r.error, /\/dashboard\/balance#topup/);
    assert.match(r.error, /повторите place_order с тем же quoteId/);

    // Человек пополнил — тот же quoteId ставит заказ.
    api.state.balance = 5000;
    const ok = await s.call('place_order', { quoteId: q.quoteId });
    assert.equal(ok.order.id, 'ord-1');
    assert.equal(api.state.orders.size, 1);
  }));

test('409 price_changed: цена выросла — заказа нет, примерка сгорает, нужна новая', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    api.state.priceFactor = 1.5;
    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(r.error, /\(код price_changed\)/);
    assert.match(r.error, /сейчас 2\s025 ₽, в примерке было 1\s350 ₽/);
    assert.match(r.error, /деньги не списаны/);
    assert.match(r.error, /quote_order заново/);
    assert.equal(api.state.orders.size, 0);

    const again = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(again.error, /нет или она истекла/);
    assert.equal(posts().length, 1, 'второго запроса по сгоревшей примерке нет');
  }));

// ── Частота, сеть, неизвестный исход ───────────────────────────────────────────

test('429: ждём Retry-After и повторяем ровно один раз', () =>
  withServer(api, {}, async (s) => {
    api.once('GET /api/v1/balance', (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'Не больше 60 запросов в минуту на ключ' } }));
    });
    const started = Date.now();
    assert.deepEqual(await s.call('get_balance'), { balance: 1500, bonusBalance: 200 });
    assert.ok(Date.now() - started >= 900, 'подождал Retry-After');
    assert.equal(api.requestsTo('GET', '/api/v1/balance').length, 2);
  }));

test('429 дважды подряд — понятная ошибка после одной повторной попытки', () =>
  withServer(api, {}, async (s) => {
    for (let i = 0; i < 2; i++) {
      api.once('GET /api/v1/balance', (req, res) =>
        api.json(res, 429, { error: { code: 'rate_limited', message: 'Не больше 60 запросов в минуту на ключ' } }, { 'Retry-After': '0' }),
      );
    }
    const r = await s.call('get_balance');
    assert.equal(r.error, 'Не больше 60 запросов в минуту на ключ (код rate_limited). Подождите минуту и повторите');
    assert.equal(api.requestsTo('GET', '/api/v1/balance').length, 2);
  }));

test('таймаут заказа: один повтор с тем же ключом — заказ один, модели сказано честно', () =>
  withServer(api, { LS_TIMEOUT_MS: '400' }, async (s) => {
    const q = await s.call('quote_order', LIKES);
    // Сервер заказ принял и списал деньги, а ответ до нас не дошёл.
    api.once('POST /api/v1/orders', (req, res, ctx) => {
      ctx.createOrder();
      ctx.hang();
    });
    const r = await s.call('place_order', { quoteId: q.quoteId });

    assert.equal(posts().length, 2);
    assert.deepEqual(posts().map((x) => x.headers['idempotency-key']), [q.quoteId, q.quoteId]);
    assert.equal(api.state.orders.size, 1);
    assert.equal(r.replayed, true);
    assert.equal(r.order.id, 'ord-1');
    assert.match(r.summary, /ответ на первую попытку потерялся в сети/);
  }));

test('обрыв соединения при заказе: повтор тем же ключом ставит заказ', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    api.once('POST /api/v1/orders', (req) => req.socket.destroy());
    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.equal(posts().length, 2);
    assert.equal(r.replayed, false);
    assert.equal(api.state.orders.size, 1);
  }));

test('502 от прокси при заказе — тоже один повтор с тем же ключом', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    api.once('POST /api/v1/orders', (req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>Bad Gateway</html>');
    });
    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.equal(posts().length, 2);
    assert.equal(r.order.id, 'ord-1');
  }));

test('исход неизвестен и после повтора: так и сказано, а примерка не сгорает по сроку', () =>
  withServer(api, { LS_QUOTE_TTL_MS: '200' }, async (s) => {
    const q = await s.call('quote_order', LIKES);
    api.once('POST /api/v1/orders', (req, res, ctx) => {
      ctx.createOrder(); // первая попытка дошла, ответ потерян
      req.socket.destroy();
    });
    api.once('POST /api/v1/orders', (req) => req.socket.destroy());
    const r = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(r.error, /^Нет связи с http:\/\/127\.0\.0\.1:\d+: сбой сети/);
    assert.match(r.error, /Исход неизвестен: заказ мог оформиться/);
    assert.match(r.error, /тем же quoteId — второго заказа не будет/);
    assert.equal(posts().length, 2);

    // Срок примерки прошёл, но по ней уже отправляли заказ: повтор идёт в API с тем же
    // ключом и находит оформленный заказ, а не просит новую примерку (она дала бы дубль).
    await sleep(300);
    const again = await s.call('place_order', { quoteId: q.quoteId });
    assert.equal(again.replayed, true);
    assert.equal(again.order.id, 'ord-1');
    assert.equal(api.state.orders.size, 1);
  }));

test('сайт недоступен — текст без стека, сервер жив', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((r) => closed.close(r));

  await withServer({ url }, {}, async (s) => {
    const r = await s.call('get_balance');
    assert.equal(r.error, `Нет связи с ${url}: соединение отклонено`);
    assert.doesNotMatch(r.error, /\n\s+at /);
    assert.deepEqual((await s.request('ping')).result, { resultType: 'complete' });
  });
});

test('ответ не JSON (HTML прокси) — внятная ошибка, процесс не падает', () =>
  withServer(api, {}, async (s) => {
    api.once('GET /api/v1/services', (req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>502 Bad Gateway</body></html>');
    });
    const r = await s.call('list_services');
    assert.match(r.error, /^Сайт ответил не JSON \(HTTP 502, text\/html\)/);
    api.once('GET /api/v1/balance', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Витрина</title>');
    });
    assert.match((await s.call('get_balance')).error, /не JSON \(HTTP 200, text\/html\)/);
    assert.deepEqual(await s.call('get_balance'), { balance: 1500, bonusBalance: 200 });
  }));

// ── Отказы ключа ────────────────────────────────────────────────────────────────

test('401 — ключ не найден или отозван, и где взять новый', () =>
  withServer(api, { LS_API_KEY: 'ls_revoked-key-000000000000' }, async (s) => {
    const r = await s.call('get_balance');
    assert.match(r.error, /^Ключ не найден или отозван \(код unauthorized\)\. Новый выпускается в кабинете: \S+\/dashboard\/api$/);
  }));

test('403 forbidden — русский текст сайта и ссылка на статус агентства, без пересказа', () =>
  withServer(api, {}, async (s) => {
    api.once('GET /api/v1/balance', (req, res) => api.refuse(res, 403, 'forbidden', 'API доступно агентствам'));
    const r = await s.call('get_balance');
    assert.match(r.error, /^API доступно агентствам \(код forbidden\)\. Статус агентства: \S+\/agency$/);
  }));

test('403 insufficient_scope и daily_limit_exceeded — внятный текст с числами', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    api.once('POST /api/v1/orders', (req, res) =>
      api.refuse(res, 403, 'insufficient_scope', 'Insufficient scope'),
    );
    const scope = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(scope.error, /^Insufficient scope \(код insufficient_scope\)\. Этот ключ только для чтения/);
    assert.match(scope.error, /\/dashboard\/api$/);

    api.once('POST /api/v1/orders', (req, res) =>
      api.refuse(res, 403, 'daily_limit_exceeded', 'Daily limit exceeded', { dailyLimit: 5000, spentToday: 4200, price: 1350 }),
    );
    const limit = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(limit.error, /\(код daily_limit_exceeded\)/);
    assert.match(limit.error, /сегодня потрачено 4\s200 ₽ из 5\s000 ₽, заказ стоит 1\s350 ₽/);
    assert.equal(api.state.orders.size, 0);
  }));

test('русский отказ сайта не пересказывается: без чисел — его текст и ссылка, с числами в data — текст из data', () =>
  withServer(api, {}, async (s) => {
    const q = await s.call('quote_order', LIKES);
    // Тексты — как их отдаёт сайт (живой прогон 24.09).
    const SCOPE =
      'Ключ выдан только на чтение — этот запрос ему недоступен. Для заказов выдайте ключ с правами «Заказы» в кабинете';
    api.once('POST /api/v1/orders', (req, res) => api.refuse(res, 403, 'insufficient_scope', SCOPE));
    const scope = await s.call('place_order', { quoteId: q.quoteId });
    assert.ok(scope.error.startsWith(`${SCOPE} (код insufficient_scope). Ключ с правом заказа выпускается в кабинете: `));
    assert.match(scope.error, /\/dashboard\/api$/);
    assert.doesNotMatch(scope.error, /Этот ключ только для чтения/);

    // Числа сайт пишет без разрядов («5000 ₽»); текст строится из data — один раз и по-русски.
    const LIMIT = 'Потолок трат ключа на сегодня 5000 ₽: потрачено 4200 ₽, заказ на 1350 ₽ не помещается';
    api.once('POST /api/v1/orders', (req, res) =>
      api.refuse(res, 403, 'daily_limit_exceeded', LIMIT, { dailyLimit: 5000, spentToday: 4200, price: 1350 }),
    );
    const limit = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(
      limit.error,
      /^Заказ не укладывается в дневной потолок трат ключа: сегодня потрачено 4\s200 ₽ из 5\s000 ₽, заказ стоит 1\s350 ₽ \(код daily_limit_exceeded\)\. Потолок задаётся у ключа в кабинете: \S+\/dashboard\/api$/,
    );
    assert.doesNotMatch(limit.error, /Потолок трат ключа на сегодня/);

    // data нет — остаётся текст сайта и ссылка.
    api.once('POST /api/v1/orders', (req, res) => api.refuse(res, 403, 'daily_limit_exceeded', LIMIT));
    const bare = await s.call('place_order', { quoteId: q.quoteId });
    assert.ok(bare.error.startsWith(`${LIMIT} (код daily_limit_exceeded). Потолок задаётся у ключа в кабинете: `));

    const PRICE = 'Цена заказа 2025 ₽ выше названного потолка 1350 ₽';
    api.once('POST /api/v1/orders', (req, res) =>
      api.refuse(res, 409, 'price_changed', PRICE, { price: 2025, maxPrice: 1350 }),
    );
    const price = await s.call('place_order', { quoteId: q.quoteId });
    assert.match(price.error, /^Цена выросла: сейчас 2\s025 ₽, в примерке было 1\s350 ₽ \(код price_changed\)\. Заказ не оформлен/);
    assert.doesNotMatch(price.error, /выше названного потолка/);
    assert.equal(api.state.orders.size, 0);
  }));

test('поля потолка в примерке: есть — сказано, нет (старый сайт) — не мешают', () =>
  withServer(api, {}, async (s) => {
    api.once('POST /api/v1/orders/quote', (req, res) =>
      api.json(res, 200, {
        serviceId: 'svc-ig-likes', link: LIKES.link, quantity: 5000, projectId: null,
        price: 1350, unitPrice: 0.27, listPrice: 1750, discountPercent: 23, discountSource: 'volume',
        balance: 9000, bonusBalance: 0, fromBonus: 0, fromBalance: 1350, enough: true, missing: 0,
        dailyLimit: 2000, spentToday: 1000, withinDailyLimit: false,
      }),
    );
    const q = await s.call('quote_order', LIKES);
    assert.equal(q.withinDailyLimit, false);
    assert.match(q.summary, /с баланса спишется 1\s350 ₽\. Заказ не уложится в дневной потолок трат ключа: сегодня потрачено 1\s000 ₽ из 2\s000 ₽\.$/);
  }));

// ── Ключ ────────────────────────────────────────────────────────────────────────

test('ключ не печатается нигде — даже если API вернул его эхом в тексте ошибки', async () => {
  const s = startServer(api);
  try {
    api.once('GET /api/v1/balance', (req, res) =>
      api.refuse(res, 400, 'bad_request', `Не понял заголовок: ${req.headers.authorization}`),
    );
    const echoed = await s.call('get_balance');
    assert.match(echoed.error, /Bearer ls_\*\*\*/);

    api.once('GET /api/v1/services', (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `ключ ${req.headers.authorization}` }));
    });
    await s.call('list_services');
    await s.request('initialize', { protocolVersion: '2025-11-25' });
    await s.request('tools/list');
    const q = await s.call('quote_order', LIKES);
    await s.call('place_order', { quoteId: q.quoteId });
    await s.call('list_orders');
    await s.call('topup_link', { amount: 100 });
  } finally {
    await s.stop();
  }
  assert.ok(s.output.length > 1000);
  assert.ok(!s.output.includes(KEY), 'ключ попал в вывод');
  assert.ok(!s.output.includes(KEY.slice(3)), 'хвост ключа попал в вывод');
});
