#!/usr/bin/env node
//
// MCP-сервер likes-store: каталог, баланс, примерка и заказ продвижения в соцсетях
// (лайки, просмотры, подписчики, комментарии) из Claude, Cursor и любого другого
// MCP-клиента. Работает поверх API для агентств — /api/v1 на сайте likes-store.
//
// Зачем. У агентства есть ключ API и, как правило, свой скрипт заказов. Этот сервер
// отдаёт тот же ключ ИИ-ассистенту: «сколько стоят 10 000 лайков на этот пост»,
// «закажи то, что примерили», «что с заказами клиента за неделю» — без строчки кода
// на стороне агентства.
//
// ПЕРВЫЙ ЗАПУСК
//
//   1) Выпустить ключ: кабинет → API (https://likes-store.com/dashboard/api), нужен
//      статус агентства. Лучше отдельный ключ под ассистента: его можно отозвать,
//      не трогая рабочие скрипты.
//   2) Проверить ключ:
//
//        LS_API_KEY=... npx -y github:trueblackat/likes-store-mcp --check
//
//   3) Подключить в Claude Code:
//
//        claude mcp add --env LS_API_KEY=<ключ> --transport stdio likes-store \
//          -- npx -y github:trueblackat/likes-store-mcp
//
//      или из клона репозитория — то же, но после `--` стоит
//      node /абсолютный/путь/likes-store-mcp.mjs. Имя сервера — не сразу за парой
//      --env KEY=value: CLI прочёл бы его как ещё одну пару и отверг команду.
//
// Переменные окружения:
//   LS_API_KEY       ключ API агентства (обязательно)
//   LS_API_URL       адрес сайта, по умолчанию https://likes-store.com
//   LS_READONLY=1    без инструмента заказа: ассистент смотрит, но не тратит
//   LS_TIMEOUT_MS    таймаут одного запроса, по умолчанию 30 000 мс
//   LS_QUOTE_TTL_MS  сколько живёт примерка заказа, по умолчанию 15 минут
//
// ЗАКАЗ — ТОЛЬКО ПО ПРИМЕРКЕ. quote_order считает точную сумму и запоминает примерку
// под quoteId; place_order принимает ТОЛЬКО quoteId. Так модель не может заказать
// то, чего человек не видел: сумма, на которую он согласился, уходит в API полем
// maxPrice (выросла цена — заказа нет), а сам quoteId — заголовком Idempotency-Key
// (повтор вызова или повтор после сетевого сбоя второго заказа не ставит).
//
// Сознательно НЕ подключено: пополнение и вывод денег (деньги заводит и выводит
// человек, из кабинета, своей картой), заказ своих комментариев (писать тексты от
// имени живых людей ассистенту не поручаем — такие заказы оформляются в кабинете),
// отмена заказа (в API её нет).
//
// Без единой зависимости: Node.js 18+ со встроенным fetch, протокол JSON-RPC по stdio
// написан руками. Поддержаны обе эпохи протокола MCP: старое рукопожатие initialize
// (2024-11-05 … 2025-11-25) и режим 2026-07-28 без рукопожатия (server/discover,
// версия в _meta каждого запроса).
//
// ВАЖНО про stdout: по нему идёт протокол MCP. Любая диагностика — только в stderr.

import { randomUUID } from 'node:crypto';

const VERSION = '0.1.0';

// ── Настройки ───────────────────────────────────────────────────────────────────

const positive = (raw, fallback) => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

// Адрес сайта, а не API: пути /api/v1/… сервер добавляет сам. Кто вписал адрес
// вместе с /api/v1 (так он выглядит в документации), получает то же самое.
const BASE = (process.env.LS_API_URL || 'https://likes-store.com')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/api\/v1$/, '');
const KEY = (process.env.LS_API_KEY || '').trim();
const READONLY = /^(1|true|yes)$/i.test((process.env.LS_READONLY || '').trim());
const TIMEOUT_MS = positive(process.env.LS_TIMEOUT_MS, 30_000);
const QUOTE_TTL_MS = positive(process.env.LS_QUOTE_TTL_MS, 15 * 60_000);

const KEYS_PAGE = `${BASE}/dashboard/api`;
// Якорь фокусирует форму пополнения. Сумму страница из адреса не берёт — её
// человек вводит сам, поэтому topup_link называет сумму словами.
const TOPUP_URL = `${BASE}/dashboard/balance#topup`;

// 429: ждём столько, сколько просит сервер, но не дольше 10 секунд — дольше
// ассистент с человеком по ту сторону ждать не должен — и повторяем ОДИН раз.
const RETRY_AFTER_MAX_S = 10;
const RETRY_AFTER_DEFAULT_S = 2;

const NO_KEY =
  `Нет ключа: задайте LS_API_KEY. Ключ выпускается в кабинете: ${KEYS_PAGE} ` +
  '(раздел «API», нужен статус агентства)';

// ── Вывод ───────────────────────────────────────────────────────────────────────

// Ключ не печатается НИКОГДА: ни в ответах инструментов, ни в stderr. Сам сервер его
// никуда не пишет, а каждая строка на выходе вдобавок проходит через redact — на
// случай, если ключ вернётся эхом в тексте чужой ошибки (прокси, отладочный сервер).
const redact = (s) => (KEY.length >= 8 ? String(s).split(KEY).join('ls_***') : String(s));
const log = (s) => process.stderr.write(redact(s) + '\n');
const print = (s) => process.stdout.write(redact(s) + '\n');

const rubFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const qtyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rub = (n) => `${rubFormat.format(Number(n) || 0)} ₽`;
const qty = (n) => qtyFormat.format(Number(n) || 0);
const positiveNumber = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

// ── Ошибки ──────────────────────────────────────────────────────────────────────

// Понятный отказ: его текст уходит модели как есть, без стека.
class ToolError extends Error {}

// Отказ API или сети. unknownOutcome — «запрос мог дойти и выполниться, но ответа
// мы не знаем»: сетевой сбой, таймаут, 5xx. Для заказа это не «ошибка», а «исход
// неизвестен», и сказать это нужно прямо — иначе модель поставит заказ заново.
class ApiError extends ToolError {
  constructor(message, { status = 0, code = null, data, unknownOutcome = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
    this.unknownOutcome = unknownOutcome;
  }
}

// Часть отказов заказа API пока называет по-английски (они написаны для скриптов, где
// ветвятся по коду, а не по тексту). Человеку и модели на русском понятнее, поэтому
// для таких кодов — свой текст; русский текст сервера остаётся как есть: он точнее
// (называет границы количества, потолки, причину закрытой ссылки). Там, где сервер уже
// объяснил по-русски, свой пересказ не добавляем — только ссылку, которой в его тексте нет.
// Исключение — отказы с числами в `data` (нехватка денег, выросшая цена, потолок ключа):
// их текст строится из `data`, а не из строки сервера. Так числа есть всегда и записаны
// по-русски («1 500 ₽», а не «1500 ₽»); строка сервера нужна, только если `data` нет.
const RU_TEXT = {
  missing_fields: 'Не хватает обязательных полей',
  invalid_link: 'Ссылка не разбирается как адрес',
  service_not_found: 'Услуга не найдена или выключена',
  user_not_found: 'Аккаунт не найден',
  order_not_found: 'Заказ не найден',
  insufficient_balance: 'Не хватает денег на балансе',
  invalid_project: 'Проект не найден',
  service_unavailable: 'Услуга сейчас недоступна',
  internal: 'Внутренняя ошибка сайта',
};
const hasCyrillic = (s) => /[а-яё]/i.test(String(s || ''));

function explain(code, message, data) {
  const d = data && typeof data === 'object' ? data : {};
  const text = hasCyrillic(message) ? message : RU_TEXT[code] || message || 'Отказ';
  const base = `${text} (код ${code})`;
  const fromData = (s) => `${s} (код ${code})`;
  switch (code) {
    case 'unauthorized':
      return (
        `${base}. ` +
        (hasCyrillic(message) ? '' : 'Ключ не найден или отозван. ') +
        `Новый выпускается в кабинете: ${KEYS_PAGE}`
      );
    case 'forbidden':
      return (
        `${base}. ` +
        (hasCyrillic(message) ? 'Статус агентства' : 'API открыто аккаунтам со статусом агентства') +
        `: ${BASE}/agency`
      );
    case 'insufficient_scope':
      return (
        `${base}. ` +
        (hasCyrillic(message) ? '' : 'Этот ключ только для чтения — заказы с ним не ставятся. ') +
        `Ключ с правом заказа выпускается в кабинете: ${KEYS_PAGE}`
      );
    case 'daily_limit_exceeded':
      return (
        (d.dailyLimit != null
          ? fromData(
              `Заказ не укладывается в дневной потолок трат ключа: сегодня потрачено ${rub(d.spentToday)} ` +
                `из ${rub(d.dailyLimit)}` +
                (d.price != null ? `, заказ стоит ${rub(d.price)}` : ''),
            )
          : base) + `. Потолок задаётся у ключа в кабинете: ${KEYS_PAGE}`
      );
    case 'insufficient_balance':
      return (
        (d.missing != null
          ? fromData(
              `Не хватает ${rub(d.missing)}` +
                (d.price != null ? `: заказ стоит ${rub(d.price)}` : '') +
                (d.balance != null
                  ? `, на балансе ${rub(d.balance)}` +
                    (positiveNumber(d.bonusBalance) ? ` и ${rub(d.bonusBalance)} подарочных` : '')
                  : ''),
            )
          : base) + `. Пополнить баланс: ${TOPUP_URL}`
      );
    case 'price_changed':
      return (
        (d.price != null
          ? fromData(
              `Цена выросла: сейчас ${rub(d.price)}` +
                (d.maxPrice != null ? `, в примерке было ${rub(d.maxPrice)}` : ''),
            )
          : base) + '. Заказ не оформлен, деньги не списаны. Сделайте quote_order заново и покажите человеку новую сумму'
      );
    case 'rate_limited':
      return `${base}. Подождите минуту и повторите`;
    case 'invalid_query':
      return d.param ? `${base}, параметр ${d.param}` : base;
    case 'not_found':
      return `${base}. Возможно, LS_API_URL указывает не на тот сайт или API на нём старее этого сервера`;
    default:
      return base;
  }
}

function apiFailure(status, payload) {
  const err = payload && typeof payload === 'object' ? payload.error : null;
  const unknownOutcome = status >= 500;
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    return new ApiError(explain(err.code, err.message, err.data), {
      status,
      code: err.code,
      data: err.data,
      unknownOutcome,
    });
  }
  // Тело не наше: так отвечают прокси и чужие серверы. Берём, что есть.
  const message = (payload && (payload.message || payload.statusMessage)) || 'ответ без описания';
  return new ApiError(`Сайт ответил HTTP ${status}: ${message}`, { status, unknownOutcome });
}

function networkFailure(e) {
  const cause = e?.cause?.code || e?.code;
  let reason;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') reason = `сайт не ответил за ${Math.round(TIMEOUT_MS / 1000)} с`;
  else if (cause === 'ECONNREFUSED') reason = 'соединение отклонено';
  else if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') reason = 'адрес не найден';
  else reason = cause ? `сбой сети (${cause})` : 'сбой сети';
  return new ApiError(`Нет связи с ${BASE}: ${reason}`, { code: 'network', unknownOutcome: true });
}

// ── Клиент API ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  let s = RETRY_AFTER_DEFAULT_S;
  if (raw != null && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) s = n;
    else if (!Number.isNaN(Date.parse(raw))) s = (Date.parse(raw) - Date.now()) / 1000;
  }
  return Math.min(RETRY_AFTER_MAX_S, Math.max(0, s)) * 1000;
}

function requireKey() {
  if (!KEY) throw new ToolError(NO_KEY);
  // Пробел, перевод строки или кириллица в ключе ломают заголовок, а текст ошибки
  // fetch в таком случае содержит само значение заголовка — то есть ключ.
  if (!/^[\x21-\x7e]+$/.test(KEY)) {
    throw new ToolError('В LS_API_KEY недопустимые символы (пробел, перевод строки, кириллица?) — скопируйте ключ заново');
  }
}

/**
 * Запрос к /api/v1. Возвращает { data, headers, repeated }.
 *
 * retryUnknown — один повтор, если исход неизвестен (сеть, таймаут, 502/503/504).
 * Включает его только заказ, и только потому, что у заказа есть Idempotency-Key:
 * без ключа повтор после таймаута — это второй заказ и второе списание.
 */
async function api(method, path, { query, body, headers: extra, retryUnknown = false } = {}) {
  requireKey();

  let url;
  try {
    url = new URL(BASE + path);
  } catch {
    throw new ToolError(`Не разобрал адрес LS_API_URL: ${BASE}`);
  }
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const headers = {
    Authorization: `Bearer ${KEY}`,
    'User-Agent': `likes-store-mcp/${VERSION}`,
    Accept: 'application/json',
    ...extra,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body === undefined ? undefined : JSON.stringify(body);

  let waited = false;
  let repeated = false;
  for (;;) {
    let res;
    let text;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
    } catch (e) {
      if (retryUnknown && !repeated) {
        repeated = true;
        continue;
      }
      throw networkFailure(e);
    }

    if (res.status === 429 && !waited) {
      waited = true;
      await sleep(retryAfterMs(res));
      continue;
    }
    if (retryUnknown && !repeated && [502, 503, 504].includes(res.status)) {
      repeated = true;
      continue;
    }

    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (data === undefined) {
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      throw new ApiError(
        `Сайт ответил не JSON (HTTP ${res.status}${type ? `, ${type}` : ''}): похоже, LS_API_URL (${BASE}) ` +
          'указывает не туда или сайт временно недоступен',
        { status: res.status, code: 'bad_response', unknownOutcome: res.status >= 500 },
      );
    }
    if (!res.ok) throw apiFailure(res.status, data);
    return { data, headers: res.headers, repeated };
  }
}

// ── Каталог ─────────────────────────────────────────────────────────────────────

// Подписи услуг для строки «N шт. «Лайки» (Instagram*) за X ₽» в примерке. Каталог
// обычно уже прочитан list_services; если нет — читаем его один раз сами.
const serviceLabels = new Map();

// Свои комментарии (commentsMode: custom) наружу не выставляем вовсе: см. шапку файла.
const offered = (s) => s && s.commentsMode !== 'custom';

async function fetchCatalog() {
  const { data } = await api('GET', '/api/v1/services');
  if (!Array.isArray(data)) throw new ToolError('Каталог пришёл не списком — API на сайте не той версии?');
  for (const s of data) {
    if (s && s.id) serviceLabels.set(s.id, `«${s.name}» (${s.platformName || s.platform})`);
  }
  return data.filter(offered);
}

async function serviceLabel(id) {
  if (!serviceLabels.has(id)) {
    // Подпись — удобство, а не условие: сбой каталога примерку не роняет.
    await fetchCatalog().catch(() => {});
  }
  return serviceLabels.get(id);
}

// Ответ читает модель, и каждое поле стоит ей контекста: отдаём то, что нужно для
// выбора услуги и расчёта, и не отдаём пустое. Поля, которых в API ещё нет
// (volumeSteps, inputHint… появились позже), просто пропускаются.
const SERVICE_FIELDS = [
  'id',
  'type',
  'name',
  'groupLabel',
  'tier',
  'minQty',
  'maxQty',
  'qtyStep',
  'pricePerUnit',
  'volumeSteps',
  'commentsMode',
  'needsPollAnswer',
  'inputHint',
  'inputExample',
  'hint',
  'speedPerDay',
];

function compactService(s) {
  const out = {};
  for (const f of SERVICE_FIELDS) {
    const v = s[f];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[f] = v;
  }
  return out;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
const lower = (s) => String(s ?? '').toLowerCase();

function byPlatform(services) {
  const groups = new Map();
  for (const s of services) {
    if (!groups.has(s.platform)) groups.set(s.platform, { platform: s.platform, name: s.platformName, services: [] });
    groups.get(s.platform).services.push(compactService(s));
  }
  return [...groups.values()];
}

// ── Примерки ────────────────────────────────────────────────────────────────────

// quoteId → { body, price, expiresAt, sent, sentAt, orderId }. Живут в памяти
// процесса: перезапуск сервера их забывает, и это правильно — заказ по забытой
// примерке всё равно требовал бы нового согласия человека.
//
// Примерка, по которой заказ УЖЕ ушёл в API (успешно или с неизвестным исходом),
// не истекает через 15 минут, а живёт сутки. Иначе повтор place_order после
// сетевого сбоя ответил бы «сделайте примерку заново» — и новая примерка с новым
// ключом поставила бы второй заказ. С прежним ключом API вернёт уже оформленный.
const quotes = new Map();
const SENT_KEEP_MS = 24 * 60 * 60_000;
const QUOTES_MAX = 500;

function pruneQuotes(now = Date.now()) {
  for (const [id, q] of quotes) {
    if (q.sent ? now - q.sentAt > SENT_KEEP_MS : q.expiresAt <= now) quotes.delete(id);
  }
  // Предохранитель от бесконечного роста: старейшие неотправленные — первыми.
  for (const [id, q] of quotes) {
    if (quotes.size <= QUOTES_MAX) break;
    if (!q.sent) quotes.delete(id);
  }
}

const ttlWords = () => {
  const min = Math.round(QUOTE_TTL_MS / 60_000);
  return min >= 1 ? `${min} мин` : `${Math.round(QUOTE_TTL_MS / 1000)} с`;
};

const DISCOUNT_WORD = { agency: 'агентская скидка', volume: 'скидка за объём' };

function quoteSummary(q, body, label) {
  let s =
    `${qty(q.quantity ?? body.quantity)} шт.${label ? ` ${label}` : ''} по ссылке ${q.link || body.link} ` +
    `за ${rub(q.price)}`;
  if (positiveNumber(q.discountPercent)) {
    s += ` (${DISCOUNT_WORD[q.discountSource] || 'скидка'} ${q.discountPercent} %)`;
  }
  if (q.enough === false) {
    s +=
      `. Не хватает ${rub(q.missing)}: на балансе ${rub(q.balance)}` +
      (positiveNumber(q.bonusBalance) ? ` и ${rub(q.bonusBalance)} подарочных` : '') +
      `. Пополнить: ${TOPUP_URL}`;
  } else if (positiveNumber(q.fromBonus)) {
    s += `, с подарочного баланса спишется ${rub(q.fromBonus)}`;
    s += positiveNumber(q.fromBalance) ? `, с основного — ${rub(q.fromBalance)}` : '';
  } else {
    s += `, с баланса спишется ${rub(q.fromBalance ?? q.price)}`;
  }
  // Потолок трат ключа: есть поле — говорим; нет (сайт старее сервера) — молчим.
  if (q.withinDailyLimit === false) {
    s +=
      '. Заказ не уложится в дневной потолок трат ключа' +
      (q.dailyLimit != null ? `: сегодня потрачено ${rub(q.spentToday)} из ${rub(q.dailyLimit)}` : '');
  }
  return s + '.';
}

const STATUS_WORD = {
  pending: 'в очереди',
  processing: 'выполняется',
  completed: 'выполнен',
  partial: 'выполнен частично',
  cancelled: 'отменён',
  failed: 'ошибка',
};

function placeSummary(o, replayed, afterRetry) {
  const id = o?.id ?? '—';
  let s = replayed
    ? `Заказ по этой примерке уже был оформлен${afterRetry ? ' (ответ на первую попытку потерялся в сети)' : ''} — ` +
      `второй не ставился. Номер ${id}`
    : `Заказ оформлен, номер ${id}`;
  // Свежий заказ, закрытый в самом оформлении, — «маршрут кончился, деньги уже
  // вернулись» (так API описывает cancelled в ответе на заказ). У повтора статус
  // текущий: заказ мог закрыться и через неделю, и там это просто «отменён».
  if (o?.status === 'cancelled' && !replayed) {
    s += ', но сразу закрыт: услугу сейчас не выполнить, деньги вернулись на баланс';
  } else {
    if (o?.status) s += `, статус: ${STATUS_WORD[o.status] || o.status}`;
    if (o?.price != null) s += `, списано ${rub(o.price)}`;
  }
  return s + '. Статус обновляется раз в несколько минут: get_order.';
}

// ── Инструменты ─────────────────────────────────────────────────────────────────

const str = (description) => ({ type: 'string', description });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });

// Подсказки клиенту (annotations из спецификации MCP): по ним он решает, спрашивать ли
// подтверждение перед вызовом. Все четыре hint-а у каждого инструмента заданы явно
// литералом, а не через хелпер: так их видят и клиенты, и статические сканеры каталогов.
// openWorldHint — все инструменты, кроме topup_link, ходят во внешний API.

const ALL_TOOLS = [
  {
    name: 'list_services',
    title: 'Каталог услуг',
    annotations: {
      title: 'Каталог услуг',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Каталог услуг продвижения (лайки, просмотры, подписчики, комментарии и др.), доступных по ключу, ' +
      'с ценой именно для этого аккаунта, по площадкам. У услуги: id, тип, название, группа, тир, границы ' +
      'количества (minQty, maxQty, шаг qtyStep), цена за штуку pricePerUnit, ступени скидки за объём ' +
      'volumeSteps, подсказки к ссылке. Фильтры: площадка, тип, строка поиска. Цена заказа = количество × ' +
      'pricePerUnit ступени с наибольшим minQty не больше количества (нет такой — базовая), до копеек; ' +
      'точную сумму со скидками и проверкой ссылки даёт quote_order.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: str('площадка: instagram, tiktok, vk, telegram, youtube… — как в поле platform'),
        type: str('тип услуги: likes, views, followers, comments… — как в поле type'),
        query: str('подстрока в названии, площадке, типе или группе услуги, без учёта регистра'),
      },
      additionalProperties: false,
    },
    async run(a) {
      const all = await fetchCatalog();
      const platform = norm(a.platform);
      const type = lower(a.type).trim();
      const q = lower(a.query).trim();
      const picked = all.filter(
        (s) =>
          (!platform || norm(s.platform) === platform || norm(s.platformName) === platform) &&
          (!type || lower(s.type) === type) &&
          (!q || [s.name, s.platform, s.platformName, s.type, s.groupLabel].some((f) => lower(f).includes(q))),
      );
      if (!picked.length && (platform || type || q)) {
        return {
          found: 0,
          note: 'По этому фильтру ничего не нашлось. Площадки и типы, которые есть:',
          platforms: [...new Set(all.map((s) => s.platform))],
          types: [...new Set(all.map((s) => s.type))],
        };
      }
      return byPlatform(picked);
    },
  },

  {
    name: 'get_balance',
    title: 'Баланс',
    annotations: {
      title: 'Баланс',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Баланс аккаунта в рублях: balance — основной, bonusBalance — подарочный. Подарочные рубли тратятся на ' +
      'заказы первыми. Пополнить может только человек — ссылку даёт topup_link.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => (await api('GET', '/api/v1/balance')).data,
  },

  {
    name: 'list_projects',
    title: 'Проекты агентства',
    annotations: {
      title: 'Проекты агентства',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Проекты агентства — по одному на клиента: id, название, имя клиента. id проекта передаётся в ' +
      'quote_order, чтобы заказ попал в отчёт этого клиента, и в list_orders — чтобы увидеть его заказы.',
    inputSchema: {
      type: 'object',
      properties: { archived: bool('показать вместе с архивными') },
      additionalProperties: false,
    },
    run: async (a) => (await api('GET', '/api/v1/projects', { query: { archived: a.archived ? '1' : undefined } })).data,
  },

  {
    name: 'quote_order',
    title: 'Примерка заказа',
    annotations: {
      title: 'Примерка заказа',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Примерка заказа: проверяет ссылку, количество и потолки и считает точную сумму со всеми скидками — ' +
      'ничего не списывает и не заказывает. Возвращает summary (строка для человека: что, за сколько, откуда ' +
      'спишется), price, хватает ли денег (enough, missing) и quoteId. ' +
      (READONLY
        ? 'Сервер запущен только для чтения: заказать по примерке здесь нельзя.'
        : `Заказ ставит place_order по quoteId; примерка живёт ${ttlWords()}. Перед заказом покажите человеку ` +
          'summary и дождитесь его явного согласия.'),
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: str('id услуги из list_services'),
        link: str('ссылка на пост, профиль, канал или видео'),
        quantity: int('количество, в границах minQty…maxQty и с шагом qtyStep услуги', { minimum: 1 }),
        pollAnswer: int('номер варианта ответа в опросе, с 1 — только для услуг с needsPollAnswer', { minimum: 1 }),
        projectId: str('id проекта из list_projects — заказ попадёт в отчёт этого клиента'),
      },
      required: ['serviceId', 'link', 'quantity'],
      additionalProperties: false,
    },
    async run(a) {
      const body = {};
      for (const f of ['serviceId', 'link', 'quantity', 'pollAnswer', 'projectId']) {
        if (a[f] !== undefined && a[f] !== null) body[f] = a[f];
      }
      const { data: quote } = await api('POST', '/api/v1/orders/quote', { body });
      if (!quote || typeof quote !== 'object' || !Number.isFinite(Number(quote.price))) {
        throw new ToolError('Примерка пришла без цены — повторите позже');
      }
      pruneQuotes();
      const quoteId = randomUUID();
      const expiresAt = Date.now() + QUOTE_TTL_MS;
      quotes.set(quoteId, { body, price: Number(quote.price), expiresAt, sent: false });
      const label = await serviceLabel(body.serviceId);
      return {
        summary: quoteSummary(quote, body, label),
        quoteId,
        expiresAt: new Date(expiresAt).toISOString(),
        ...quote,
      };
    },
  },

  {
    name: 'place_order',
    title: 'Оформить заказ по примерке',
    annotations: {
      title: 'Оформить заказ по примерке',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Оформляет заказ по примерке и СПИСЫВАЕТ ДЕНЬГИ с баланса. Вызывать только после того, как человек ' +
      'увидел сумму из quote_order и явно согласился именно на неё; без согласия — не вызывать. Принимает ' +
      'только quoteId. Повторный вызов с тем же quoteId второго заказа не ставит. Если цена выросла после ' +
      'примерки, заказ не оформляется (price_changed) — нужна новая примерка и новое согласие. Отменить ' +
      'оформленный заказ отсюда нельзя; невыполненная часть заказа возвращается на баланс сама.',
    inputSchema: {
      type: 'object',
      properties: { quoteId: str('quoteId из ответа quote_order') },
      required: ['quoteId'],
      additionalProperties: false,
    },
    async run({ quoteId }) {
      pruneQuotes();
      const q = quotes.get(quoteId);
      if (!q || (!q.sent && q.expiresAt <= Date.now())) {
        quotes.delete(quoteId);
        throw new ToolError(
          `Примерки ${quoteId} нет или она истекла (живёт ${ttlWords()}). Заказ не оформлен. ` +
            'Сделайте quote_order заново и покажите человеку сумму.',
        );
      }

      let res;
      try {
        res = await api('POST', '/api/v1/orders', {
          body: { ...q.body, maxPrice: q.price },
          headers: { 'Idempotency-Key': quoteId },
          retryUnknown: true,
        });
      } catch (e) {
        if (e instanceof ApiError && e.unknownOutcome) {
          q.sent = true;
          q.sentAt = Date.now();
          throw new ToolError(
            `${e.message}. Исход неизвестен: заказ мог оформиться. Повторите place_order с тем же quoteId — ` +
              'второго заказа не будет, повтор вернёт уже оформленный. Или проверьте list_orders.',
          );
        }
        if (e instanceof ApiError && e.code === 'price_changed') quotes.delete(quoteId);
        if (e instanceof ApiError && e.code === 'insufficient_balance') {
          throw new ToolError(`${e.message}. После пополнения повторите place_order с тем же quoteId, пока примерка не истекла.`);
        }
        throw e;
      }

      const order = res.data;
      q.sent = true;
      q.sentAt = Date.now();
      q.orderId = order?.id;
      const replayed = res.headers.get('idempotent-replayed') === 'true';
      return { summary: placeSummary(order, replayed, res.repeated), replayed, order };
    },
  },

  {
    name: 'get_order',
    title: 'Заказ по номеру',
    annotations: {
      title: 'Заказ по номеру',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Заказ по номеру: статус (pending — в очереди, processing — выполняется, completed — выполнен, ' +
      'partial — выполнен частично, cancelled — отменён, failed — ошибка), сколько довезено (delivered), ' +
      'сколько осталось (remains), сколько вернулось на баланс (refunded). Статус обновляется раз в ' +
      'несколько минут — чаще спрашивать незачем.',
    inputSchema: {
      type: 'object',
      properties: { id: str('номер заказа') },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (a) => (await api('GET', `/api/v1/orders/${encodeURIComponent(a.id)}`)).data,
  },

  {
    name: 'list_orders',
    title: 'Список заказов',
    annotations: {
      title: 'Список заказов',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Заказы аккаунта, новые сверху, по страницам: { items, nextCursor }. Следующая страница — тот же ' +
      'вызов с cursor = nextCursor; nextCursor: null — страниц больше нет. Фильтры: статус (несколько через ' +
      'запятую), проект, период по дате создания (ISO 8601; since включительно, until — нет).',
    inputSchema: {
      type: 'object',
      properties: {
        status: str('статус или несколько через запятую: pending, processing, completed, partial, cancelled, failed'),
        projectId: str('id проекта из list_projects'),
        since: str('созданные начиная с этого момента, ISO 8601, например 2026-09-01 или 2026-09-01T00:00:00+03:00'),
        until: str('созданные раньше этого момента, ISO 8601'),
        limit: int('сколько на странице, 1–100, по умолчанию 50', { minimum: 1, maximum: 100 }),
        cursor: str('nextCursor из прошлого ответа'),
      },
      additionalProperties: false,
    },
    run: async (a) =>
      (
        await api('GET', '/api/v1/orders', {
          query: {
            status: a.status,
            projectId: a.projectId,
            since: a.since,
            until: a.until,
            limit: a.limit,
            cursor: a.cursor,
          },
        })
      ).data,
  },

  {
    name: 'topup_link',
    title: 'Ссылка на пополнение',
    annotations: {
      title: 'Ссылка на пополнение',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Ссылка на форму пополнения баланса в кабинете. Пополняет человек сам, своей картой: сервер деньги не ' +
      'заводит и не выводит. Сумму в ссылку подставить нельзя — её нужно назвать человеку словами.',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number', description: 'сколько рублей пополнить, если сумма известна', exclusiveMinimum: 0 } },
      additionalProperties: false,
    },
    run(a) {
      if (a.amount == null) {
        return { url: TOPUP_URL, summary: `Пополнить баланс: ${TOPUP_URL} — ссылка открывает форму пополнения в кабинете.` };
      }
      // Форма принимает целые рубли: 45,30 ₽ нехватки — это 46 ₽ пополнения, не 45.
      const amount = Math.ceil(a.amount);
      return {
        url: TOPUP_URL,
        amount,
        summary:
          `Пополнить баланс на ${rub(amount)}: ${TOPUP_URL} — ссылка открывает форму пополнения в кабинете, ` +
          `сумму ${rub(amount)} нужно ввести в ней самому.`,
      };
    },
  },
];

const TOOLS = READONLY ? ALL_TOOLS.filter((t) => t.name !== 'place_order') : ALL_TOOLS;

// ── Проверка аргументов ─────────────────────────────────────────────────────────

// Ошибка аргументов — ответ инструмента (isError), а не ошибка протокола: так модель
// видит, что не так, и исправляет вызов сама.
const TYPE_WORD = { string: 'строка', integer: 'целое число', number: 'число', boolean: 'true или false' };

function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('Аргументы инструмента — объект');
  const props = schema.properties || {};
  for (const k of Object.keys(args)) {
    if (!Object.hasOwn(props, k)) {
      throw new ToolError(`Неизвестный аргумент «${k}». Бывают: ${Object.keys(props).join(', ') || 'никаких'}`);
    }
  }
  for (const k of schema.required || []) {
    if (args[k] === undefined || args[k] === null || args[k] === '') throw new ToolError(`Не хватает аргумента «${k}»`);
  }
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    const p = props[k];
    const typeOk =
      p.type === 'integer'
        ? Number.isInteger(v)
        : p.type === 'number'
          ? typeof v === 'number' && Number.isFinite(v)
          : typeof v === p.type;
    if (!typeOk) throw new ToolError(`«${k}»: нужно ${TYPE_WORD[p.type] || p.type}`);
    if (p.minimum !== undefined && v < p.minimum) throw new ToolError(`«${k}»: не меньше ${p.minimum}`);
    if (p.maximum !== undefined && v > p.maximum) throw new ToolError(`«${k}»: не больше ${p.maximum}`);
    if (p.exclusiveMinimum !== undefined && v <= p.exclusiveMinimum) {
      throw new ToolError(`«${k}»: больше ${p.exclusiveMinimum}`);
    }
  }
}

// ── Протокол MCP поверх stdio ───────────────────────────────────────────────────

// Две эпохи протокола. Старая (до 2025-11-25 включительно) начинается с рукопожатия
// initialize; новая (2026-07-28) рукопожатия не знает: версия едет в _meta каждого
// запроса, а возможности сервера клиент узнаёт через server/discover. Сервер говорит
// на обеих: так его подключит и нынешний клиент, и завтрашний.
const MODERN_VERSIONS = ['2026-07-28'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const SERVER_INFO = { name: 'likes-store', title: 'likes-store', version: VERSION };

const INSTRUCTIONS =
  'Сервер ведёт продвижение в соцсетях (лайки, просмотры, подписчики, комментарии) через API likes-store от ' +
  'имени аккаунта агентства, чей ключ подключён; деньги списываются с его баланса в рублях. ' +
  (READONLY
    ? 'Сервер запущен только для чтения: каталог, баланс, примерка, статусы — без заказов. '
    : 'Порядок заказа: list_services (найти услугу) → quote_order (точная сумма и проверка ссылки) → показать ' +
      'человеку summary и дождаться явного согласия → place_order с quoteId. Без согласия place_order не вызывать. ') +
  'Статусы заказов обновляются раз в несколько минут (get_order, list_orders). Пополнить баланс может только ' +
  'человек — topup_link даёт ссылку.';

// Каждый ответ несёт resultType: в 2026-07-28 это обязательное поле результата, а
// клиенты старых версий лишние поля пропускают.
const send = (msg) => process.stdout.write(redact(JSON.stringify(msg)) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete' } });
const fail = (id, code, message, data) =>
  send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

// Список инструментов не меняется, пока жив процесс; от LS_READONLY он зависит,
// поэтому кешировать его — только этому клиенту (private).
const CACHE = { ttlMs: 3_600_000, cacheScope: 'private' };

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(null, -32600, 'Invalid Request: ожидался объект JSON-RPC');
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (typeof method !== 'string') {
    // Ответ клиента на наш запрос — запросов клиенту мы не шлём, пропускаем.
    if ('result' in msg || 'error' in msg) return;
    return fail(isRequest ? id : null, -32600, 'Invalid Request: нет method');
  }
  // Уведомления (initialized, cancelled и прочие): отвечать на них протокол запрещает.
  if (!isRequest) return;

  if (method !== 'initialize') {
    const requested = params?._meta?.[VERSION_META];
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      return fail(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: SUPPORTED_VERSIONS,
        requested: String(requested),
      });
    }
  }

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case 'server/discover':
      return ok(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        ...CACHE,
      });

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations,
        })),
        ...CACHE,
      });

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Неизвестный инструмент: ${params?.name}`);
      try {
        const args = params.arguments ?? {};
        checkArgs(tool.inputSchema, args);
        const result = await tool.run(args);
        return ok(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] });
      } catch (e) {
        if (!(e instanceof ToolError)) log(`сбой инструмента ${tool.name}: ${e?.stack || e}`);
        const text = e instanceof ToolError ? e.message : 'Внутренняя ошибка сервера likes-store-mcp';
        return ok(id, { content: [{ type: 'text', text }], isError: true });
      }
    }

    default:
      return fail(id, -32601, `Метод не поддерживается: ${method}`);
  }
}

// Выйти, дописав всё, что уже отдано в stdout: в pipe на macOS запись асинхронная, и
// голый process.exit терял бы последний ответ.
const finish = (code) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));

function serve() {
  if (!KEY) log(`likes-store-mcp: ${NO_KEY}`);
  // Клиент закрыл свой конец — писать некуда, выходим тихо.
  process.stdout.on('error', () => process.exit(0));

  let buffer = '';
  let inflight = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && inflight === 0) finish(0);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Parse error: строка не JSON');
        continue;
      }
      inflight++;
      handle(msg)
        .catch((e) => {
          log(`сбой обработчика: ${e?.stack || e}`);
          if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, 'Внутренняя ошибка сервера');
        })
        .finally(() => {
          inflight--;
          maybeExit();
        });
    }
  });
  // Запросы, начатые до конца ввода, дорабатывают: ответ на заказ не должен теряться.
  process.stdin.on('end', () => {
    ended = true;
    maybeExit();
  });
}

// ── Режимы командной строки ─────────────────────────────────────────────────────

async function check() {
  print(`Адрес: ${BASE}`);
  const [{ data: balance }, services] = await Promise.all([api('GET', '/api/v1/balance'), fetchCatalog()]);
  print('Ключ рабочий.');
  print(`Баланс: ${rub(balance?.balance)}, подарочный: ${rub(balance?.bonusBalance)}`);
  print(`Услуг доступно: ${services.length}`);
  if (READONLY) print('Режим: только чтение (LS_READONLY) — инструмента заказа нет');
}

const USAGE =
  `likes-store-mcp ${VERSION} — MCP-сервер likes-store\n\n` +
  'Без флагов — MCP-сервер по stdio (его запускает MCP-клиент).\n' +
  '  --check    проверить ключ: баланс и число доступных услуг\n' +
  '  --version  версия\n' +
  '  --help     эта справка\n\n' +
  'Переменные: LS_API_KEY (обязательно), LS_API_URL (по умолчанию https://likes-store.com), LS_READONLY=1\n';

const mode = process.argv[2];

if (mode === undefined) {
  serve();
} else if (mode === '--help' || mode === '-h') {
  process.stdout.write(USAGE);
} else if (mode === '--version') {
  print(VERSION);
} else if (mode === '--check') {
  check().then(
    () => finish(0),
    (e) => {
      log(e instanceof ToolError ? `Проверка не прошла: ${e.message}` : `Проверка не прошла: ${e?.message || e}`);
      finish(1);
    },
  );
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
