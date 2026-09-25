// Инструменты чтения: каталог, баланс, проекты, заказы, ссылка на пополнение,
// заголовки запросов и проверка аргументов.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApi, withServer, KEY } from './helpers.mjs';

let api;
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());
beforeEach(() => {
  api.state.requests.length = 0;
});

const last = () => api.state.requests[api.state.requests.length - 1];

test('каждый запрос несёт ключ, User-Agent пакета и Accept: application/json', () =>
  withServer(api, {}, async (s) => {
    await s.call('get_balance');
    await s.call('list_services');
    await s.call('list_projects');
    assert.equal(api.state.requests.length, 3);
    for (const r of api.state.requests) {
      assert.equal(r.headers.authorization, `Bearer ${KEY}`);
      assert.equal(r.headers['user-agent'], 'likes-store-mcp/0.1.0');
      assert.equal(r.headers.accept, 'application/json');
    }
  }));

test('LS_API_URL с хвостом /api/v1/ — тот же сайт, пути не удваиваются', () =>
  withServer(api, { LS_API_URL: `${api.url}/api/v1/` }, async (s) => {
    await s.call('get_balance');
    assert.equal(last().path, '/api/v1/balance');
  }));

test('list_services: по площадкам, компактно, без своих комментариев', () =>
  withServer(api, {}, async (s) => {
    const catalog = await s.call('list_services');
    assert.deepEqual(
      catalog.map((g) => [g.platform, g.name, g.services.map((x) => x.id)]),
      [
        ['instagram', 'Instagram*', ['svc-ig-likes', 'svc-ig-comments-random']],
        ['telegram', 'Telegram', ['svc-tg-views', 'svc-tg-poll']],
      ],
    );

    const likes = catalog[0].services[0];
    assert.deepEqual(likes, {
      id: 'svc-ig-likes',
      type: 'likes',
      name: 'Лайки',
      tier: 'standard',
      minQty: 10,
      maxQty: 50000,
      qtyStep: 10,
      pricePerUnit: 0.3,
      volumeSteps: [
        { minQty: 1000, percent: 10, pricePerUnit: 0.27 },
        { minQty: 10000, percent: 30, pricePerUnit: 0.21 },
      ],
      inputHint: 'Ссылка на пост',
      inputExample: 'https://instagram.com/p/XXXX',
      speedPerDay: 5000,
    });

    // Поля старого API, которых ещё нет, просто не появляются; лишние — не отдаются.
    const views = catalog[1].services[0];
    assert.equal(views.volumeSteps, undefined);
    assert.equal(views.groupLabel, 'Посты');
    for (const g of catalog) {
      for (const x of g.services) {
        for (const f of ['hosts', 'retailPricePerUnit', 'discountPercent', 'platform', 'platformName']) {
          assert.equal(x[f], undefined, `${x.id}.${f}`);
        }
      }
    }
    // Комментарии без своего текста — обычная услуга, режим виден; опрос — с флагом.
    assert.equal(catalog[0].services[1].commentsMode, 'random');
    assert.equal(catalog[1].services[1].needsPollAnswer, true);
    assert.equal(likes.needsPollAnswer, undefined);
    assert.doesNotMatch(JSON.stringify(catalog), /svc-ig-comments-custom|Свои комментарии/);
  }));

test('list_services фильтрует по площадке (слагу или имени), типу и строке поиска', () =>
  withServer(api, {}, async (s) => {
    const ids = (c) => c.flatMap((g) => g.services.map((x) => x.id));
    assert.deepEqual(ids(await s.call('list_services', { platform: 'Instagram' })), ['svc-ig-likes', 'svc-ig-comments-random']);
    assert.deepEqual(ids(await s.call('list_services', { platform: 'telegram', type: 'views' })), ['svc-tg-views']);
    assert.deepEqual(ids(await s.call('list_services', { query: 'ОПРОС' })), ['svc-tg-poll']);
    assert.deepEqual(ids(await s.call('list_services', { query: 'посты' })), ['svc-tg-views']);
    // Свои комментарии не находятся и поиском.
    assert.equal((await s.call('list_services', { query: 'свои' })).found, 0);

    const none = await s.call('list_services', { platform: 'myspace' });
    assert.equal(none.found, 0);
    assert.deepEqual(none.platforms, ['instagram', 'telegram']);
    assert.ok(none.types.includes('likes'));
  }));

test('get_balance отдаёт оба кошелька', () =>
  withServer(api, {}, async (s) => {
    assert.deepEqual(await s.call('get_balance'), { balance: 1500, bonusBalance: 200 });
    assert.equal(last().path, '/api/v1/balance');
  }));

test('list_projects: архивные — только по archived: true', () =>
  withServer(api, {}, async (s) => {
    assert.deepEqual((await s.call('list_projects')).map((p) => p.id), ['prj-1']);
    assert.deepEqual(last().query, {});
    assert.deepEqual((await s.call('list_projects', { archived: true })).map((p) => p.id), ['prj-1', 'prj-2']);
    assert.deepEqual(last().query, { archived: '1' });
    await s.call('list_projects', { archived: false });
    assert.deepEqual(last().query, {});
  }));

test('list_orders передаёт фильтры и курсор как есть', () =>
  withServer(api, {}, async (s) => {
    const page = await s.call('list_orders', {
      status: 'processing,partial',
      projectId: 'prj-1',
      since: '2026-09-01',
      until: '2026-09-24T00:00:00+03:00',
      limit: 20,
      cursor: 'abc',
    });
    assert.deepEqual(page, { items: [], nextCursor: null });
    assert.equal(last().path, '/api/v1/orders');
    assert.deepEqual(last().query, {
      status: 'processing,partial',
      projectId: 'prj-1',
      since: '2026-09-01',
      until: '2026-09-24T00:00:00+03:00',
      limit: '20',
      cursor: 'abc',
    });

    await s.call('list_orders');
    assert.deepEqual(last().query, {});
  }));

test('get_order: номер в пути экранирован; чужой или несуществующий — понятный отказ с кодом', () =>
  withServer(api, {}, async (s) => {
    const r = await s.call('get_order', { id: 'ord/../x?y' });
    assert.equal(last().path, '/api/v1/orders/ord%2F..%2Fx%3Fy');
    assert.equal(r.error, 'Заказ не найден (код order_not_found)');
  }));

test('topup_link: без сети, ссылка на форму, сумма — словами и вверх до рубля', () =>
  withServer(api, {}, async (s) => {
    const plain = await s.call('topup_link');
    assert.equal(plain.url, `${api.url}/dashboard/balance#topup`);

    const r = await s.call('topup_link', { amount: 45.3 });
    assert.equal(r.amount, 46);
    assert.match(r.summary, /46 ₽/);
    assert.match(r.summary, /ввести в ней самому/);
    assert.equal(api.state.requests.length, 0);

    assert.match((await s.call('topup_link', { amount: 0 })).error, /amount/);
  }));

test('аргументы проверяются до запроса: лишний, недостающий, не того типа', () =>
  withServer(api, {}, async (s) => {
    assert.match((await s.call('get_order', {})).error, /Не хватает аргумента «id»/);
    assert.match((await s.call('get_balance', { verbose: true })).error, /Неизвестный аргумент «verbose»/);
    assert.match((await s.call('list_orders', { limit: '20' })).error, /«limit»: нужно целое число/);
    assert.match((await s.call('list_orders', { limit: 500 })).error, /не больше 100/);
    assert.match(
      (await s.call('quote_order', { serviceId: 'svc-ig-likes', link: 'https://instagram.com/p/1', quantity: 10.5 })).error,
      /«quantity»: нужно целое число/,
    );
    assert.match((await s.call('list_projects', { archived: 'yes' })).error, /true или false/);
    // «Свои» имена свойств объекта аргументами не считаются.
    assert.match((await s.call('get_balance', { constructor: 1 })).error, /Неизвестный аргумент «constructor»/);
    assert.equal(api.state.requests.length, 0);
  }));
