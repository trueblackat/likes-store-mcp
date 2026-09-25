// Общее для тестов: поддельное API likes-store (/api/v1) на node:http и MCP-клиент,
// который запускает настоящий сервер отдельным процессом и говорит с ним по stdio.
// Сеть и настоящий ключ не нужны.
//
// Фейк держит КОНТРАКТ ручек, а не их устройство: форма заказа, форма отказа
// { error: { code, message, data? } }, Idempotency-Key на заказе, maxPrice → 409
// price_changed, примерка /orders/quote. Если контракт API поменяется, править
// придётся здесь — это и есть место, где он записан для пакета.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER = fileURLToPath(new URL('../likes-store-mcp.mjs', import.meta.url));
export const KEY = 'ls_TestKey-0123456789abcdefghijklmnop';

export const SERVICES = [
  {
    id: 'svc-ig-likes',
    platform: 'instagram',
    platformName: 'Instagram*',
    hosts: ['instagram.com'],
    type: 'likes',
    name: 'Лайки',
    minQty: 10,
    maxQty: 50000,
    qtyStep: 10,
    speedPerDay: 5000,
    pricePerUnit: 0.3,
    retailPricePerUnit: 0.35,
    discountPercent: 10,
    tier: 'standard',
    commentsMode: null,
    needsPollAnswer: false,
    volumeSteps: [
      { minQty: 1000, percent: 10, pricePerUnit: 0.27 },
      { minQty: 10000, percent: 30, pricePerUnit: 0.21 },
    ],
    inputHint: 'Ссылка на пост',
    inputExample: 'https://instagram.com/p/XXXX',
    hint: null,
    groupLabel: null,
  },
  {
    id: 'svc-ig-comments-custom',
    platform: 'instagram',
    platformName: 'Instagram*',
    hosts: ['instagram.com'],
    type: 'comments',
    name: 'Свои комментарии',
    minQty: 1,
    maxQty: 100,
    qtyStep: 1,
    speedPerDay: 100,
    pricePerUnit: 12,
    retailPricePerUnit: 12,
    discountPercent: 0,
    tier: 'standard',
    commentsMode: 'custom',
    needsPollAnswer: false,
  },
  {
    id: 'svc-ig-comments-random',
    platform: 'instagram',
    platformName: 'Instagram*',
    hosts: ['instagram.com'],
    type: 'comments',
    name: 'Комментарии',
    minQty: 5,
    maxQty: 500,
    qtyStep: 5,
    speedPerDay: 300,
    pricePerUnit: 9,
    retailPricePerUnit: 9,
    discountPercent: 0,
    tier: 'premium',
    commentsMode: 'random',
    needsPollAnswer: false,
  },
  // Услуга «старого» API — без полей, появившихся позже (volumeSteps, inputHint…).
  {
    id: 'svc-tg-views',
    platform: 'telegram',
    platformName: 'Telegram',
    hosts: ['t.me'],
    type: 'views',
    name: 'Просмотры поста',
    minQty: 100,
    maxQty: 100000,
    qtyStep: 100,
    speedPerDay: 50000,
    pricePerUnit: 0.05,
    retailPricePerUnit: 0.05,
    discountPercent: 0,
    tier: 'standard',
    commentsMode: null,
    needsPollAnswer: false,
    groupLabel: 'Посты',
  },
  {
    id: 'svc-tg-poll',
    platform: 'telegram',
    platformName: 'Telegram',
    hosts: ['t.me'],
    type: 'votes',
    name: 'Голоса в опросе',
    minQty: 10,
    maxQty: 5000,
    qtyStep: 10,
    speedPerDay: 2000,
    pricePerUnit: 0.5,
    retailPricePerUnit: 0.5,
    discountPercent: 0,
    tier: 'standard',
    commentsMode: null,
    needsPollAnswer: true,
  },
];

const PROJECTS = [
  { id: 'prj-1', name: 'Кофейня', clientName: 'ИП Иванов', isArchived: false, createdAt: '2026-09-01T10:00:00.000Z' },
  { id: 'prj-2', name: 'Старый клиент', clientName: null, isArchived: true, createdAt: '2026-08-01T10:00:00.000Z' },
];

const round2 = (n) => Math.round(n * 100) / 100;

function unitPrice(service, quantity) {
  let unit = service.pricePerUnit;
  let best = -1;
  for (const s of service.volumeSteps || []) {
    if (s.minQty <= quantity && s.minQty > best) {
      best = s.minQty;
      unit = s.pricePerUnit;
    }
  }
  return unit;
}

/**
 * Поднимает поддельное API на 127.0.0.1 и случайном порту.
 *
 * `api.once(route, handler)` — разовая подмена ответа: `route` вида
 * 'POST /api/v1/orders', `handler(req, res, ctx)` отвечает сам. `ctx.createOrder()`
 * + `ctx.hang()` — заказ создан, а ответа нет: так выглядит таймаут, после которого
 * заказ на сервере уже есть.
 */
export async function startFakeApi() {
  const state = {
    requests: [],
    queue: [],
    orders: new Map(),
    byKey: new Map(),
    balance: 1500,
    bonusBalance: 200,
    priceFactor: 1,
    seq: 0,
  };
  const hanging = new Set();

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  const refuse = (res, status, code, message, data) =>
    json(res, status, { error: data ? { code, message, data } : { code, message } });

  function priceOf(body) {
    const service = SERVICES.find((s) => s.id === body.serviceId);
    if (!service) return { error: [404, 'service_not_found', 'Service not found'] };
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < service.minQty || quantity > service.maxQty) {
      return { error: [400, 'quantity', `Количество — от ${service.minQty} до ${service.maxQty}`] };
    }
    const unit = unitPrice(service, quantity) * state.priceFactor;
    const price = round2(quantity * unit);
    const fromBonus = Math.min(state.bonusBalance, price);
    const fromBalance = round2(price - fromBonus);
    const enough = fromBalance <= state.balance;
    return { service, quantity, unit, price, fromBonus, fromBalance, enough, missing: enough ? 0 : round2(fromBalance - state.balance) };
  }

  function createOrder(body, key) {
    const p = priceOf(body);
    const id = `ord-${++state.seq}`;
    const order = {
      id,
      status: 'processing',
      serviceId: body.serviceId,
      quantity: p.quantity,
      remains: null,
      delivered: null,
      price: p.price,
      refunded: 0,
      link: body.link,
      serviceName: p.service.name,
      platformSlug: p.service.platform,
      serviceType: p.service.type,
      projectId: body.projectId ?? null,
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
    };
    state.bonusBalance = round2(state.bonusBalance - p.fromBonus);
    state.balance = round2(state.balance - p.fromBalance);
    state.orders.set(id, order);
    if (key) state.byKey.set(key, id);
    return order;
  }

  const routes = {
    'GET /api/v1/balance': (req, res) => json(res, 200, { balance: state.balance, bonusBalance: state.bonusBalance }),
    'GET /api/v1/services': (req, res) => json(res, 200, SERVICES),
    'GET /api/v1/projects': (req, res, ctx) =>
      json(res, 200, ctx.query.archived === '1' ? PROJECTS : PROJECTS.filter((p) => !p.isArchived)),
    'GET /api/v1/orders': (req, res) => json(res, 200, { items: [...state.orders.values()].reverse(), nextCursor: null }),
    'POST /api/v1/orders/quote': (req, res, ctx) => {
      const p = priceOf(ctx.body);
      if (p.error) return refuse(res, ...p.error);
      const listPrice = round2(p.quantity * p.service.retailPricePerUnit);
      json(res, 200, {
        serviceId: p.service.id,
        link: ctx.body.link,
        quantity: p.quantity,
        projectId: ctx.body.projectId ?? null,
        price: p.price,
        unitPrice: p.unit,
        listPrice,
        discountPercent: listPrice > 0 ? Math.round((1 - p.price / listPrice) * 100) : 0,
        discountSource: p.price < listPrice ? 'volume' : 'none',
        balance: state.balance,
        bonusBalance: state.bonusBalance,
        fromBonus: p.fromBonus,
        fromBalance: p.fromBalance,
        enough: p.enough,
        missing: p.missing,
      });
    },
    'POST /api/v1/orders': (req, res, ctx) => {
      const key = ctx.headers['idempotency-key'];
      if (key && state.byKey.has(key)) {
        return json(res, 200, state.orders.get(state.byKey.get(key)), { 'Idempotent-Replayed': 'true' });
      }
      const p = priceOf(ctx.body);
      if (p.error) return refuse(res, ...p.error);
      if (ctx.body.maxPrice != null && p.price > ctx.body.maxPrice) {
        return refuse(res, 409, 'price_changed', 'Цена заказа выше maxPrice', { price: p.price, maxPrice: ctx.body.maxPrice });
      }
      if (!p.enough) {
        return refuse(res, 402, 'insufficient_balance', 'Insufficient balance', {
          price: p.price,
          missing: p.missing,
          balance: state.balance,
          bonusBalance: state.bonusBalance,
        });
      }
      json(res, 200, createOrder(ctx.body, key));
    },
  };

  function dispatch(req, res, ctx) {
    const route = `${req.method} ${ctx.path}`;
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return refuse(res, 401, 'unauthorized', 'Ключ не найден или отозван');
    }
    const orderMatch = req.method === 'GET' && ctx.path.match(/^\/api\/v1\/orders\/([^/]+)$/);
    if (orderMatch) {
      const order = state.orders.get(decodeURIComponent(orderMatch[1]));
      return order ? json(res, 200, order) : refuse(res, 404, 'order_not_found', 'Order not found');
    }
    const handler = routes[route];
    if (!handler) return refuse(res, 404, 'not_found', `Нет такого запроса: ${req.method} ${ctx.path}`);
    return handler(req, res, ctx);
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const ctx = {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      state.requests.push({
        method: req.method,
        path: ctx.path,
        query: ctx.query,
        headers: req.headers,
        body: ctx.body,
      });
      ctx.createOrder = () => createOrder(ctx.body, req.headers['idempotency-key']);
      ctx.hang = () => hanging.add(res);
      const i = state.queue.findIndex((o) => o.route === `${req.method} ${ctx.path}`);
      if (i >= 0) {
        const [o] = state.queue.splice(i, 1);
        return o.handler(req, res, ctx);
      }
      dispatch(req, res, ctx);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    once(route, handler) {
      state.queue.push({ route, handler });
    },
    json,
    refuse,
    requestsTo(method, path) {
      return state.requests.filter((r) => r.method === method && r.path === path);
    },
    close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

// ── MCP-клиент ──────────────────────────────────────────────────────────────────

export function startServer(api, env = {}, args = []) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    env: { PATH: process.env.PATH, LS_API_URL: api?.url ?? 'http://127.0.0.1:9', LS_API_KEY: KEY, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const unsolicited = [];
  let buffer = '';
  let stdout = '';
  let stderr = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else {
        unsolicited.push(msg);
      }
    }
  });
  const exited = new Promise((r) => child.on('exit', r));

  return {
    unsolicited,
    get output() {
      return stdout + stderr;
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve) => pending.set(id, resolve));
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    raw(line) {
      child.stdin.write(line + '\n');
    },
    /** Вызов инструмента: { error } при isError, иначе разобранный JSON ответа. */
    async call(name, args = {}) {
      const res = await this.request('tools/call', { name, arguments: args });
      if (res.error) throw new Error(`JSON-RPC ${res.error.code}: ${res.error.message}`);
      const text = res.result.content[0].text;
      return res.result.isError ? { error: text } : JSON.parse(text);
    },
    stop() {
      child.stdin.end();
      return exited;
    },
  };
}

export async function withServer(api, env, fn) {
  const s = startServer(api, env);
  try {
    await fn(s);
  } finally {
    await s.stop();
  }
}

/** Запуск с флагом (`--check`): stdout, stderr и код выхода. */
export function runCli(api, env = {}, args = ['--check']) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { PATH: process.env.PATH, LS_API_URL: api?.url ?? 'http://127.0.0.1:9', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
