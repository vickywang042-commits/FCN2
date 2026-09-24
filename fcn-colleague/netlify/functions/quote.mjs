const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store"
};

function respond(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeYahooSymbol(rawSymbol) {
  let symbol = String(rawSymbol || "").trim().toUpperCase().replace(/\s+/g, "");
  symbol = symbol.replace(/^(NASDAQ|NYSE|AMEX):/, "");
  // The tracker formerly suggested TSM.US for Stooq. Yahoo uses TSM instead.
  if (symbol.endsWith(".US")) symbol = symbol.slice(0, -3);
  symbol = symbol.replace(/^(\d{4})(?:\.?(?:JP|JT))$/, "$1.T");
  if (/^\d{4}$/.test(symbol)) symbol = `${symbol}.T`;
  if (!/^[A-Z0-9.^=\-]{1,30}$/.test(symbol)) return "";
  return symbol;
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function clockInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

function fallbackCloseMinutes(timeZone) {
  const closeTimes = {
    "Asia/Tokyo": 15 * 60 + 45,
    "Australia/Sydney": 16 * 60 + 20,
    "Asia/Hong_Kong": 16 * 60 + 15,
    "Asia/Taipei": 13 * 60 + 45,
    "Asia/Singapore": 17 * 60 + 15,
    "Asia/Seoul": 15 * 60 + 45,
    "Asia/Kolkata": 15 * 60 + 45,
    "Europe/London": 16 * 60 + 45,
    "Europe/Paris": 17 * 60 + 45,
    "Europe/Berlin": 17 * 60 + 45,
    "Europe/Zurich": 17 * 60 + 45,
    "America/Toronto": 16 * 60 + 15,
    "America/New_York": 16 * 60 + 15
  };
  return closeTimes[timeZone] ?? 16 * 60 + 15;
}

function isCompletedDailyCloseReady(meta, now = new Date()) {
  const timeZone = meta.exchangeTimezoneName || "America/New_York";
  const regularEndSeconds = Number(meta.currentTradingPeriod?.regular?.end);
  if (Number.isFinite(regularEndSeconds) && regularEndSeconds > 0) {
    const regularEnd = new Date(regularEndSeconds * 1000);
    if (dateInTimeZone(regularEnd, timeZone) === dateInTimeZone(now, timeZone)) {
      return now.getTime() >= regularEnd.getTime() + 15 * 60 * 1000;
    }
  }
  return clockInTimeZone(now, timeZone).minutes >= fallbackCloseMinutes(timeZone);
}

async function fetchYahooChart(symbol, query) {
  let lastError;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 FCN-tracker/1.0",
          "Accept": "application/json"
        }
      });
      if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
      const data = await response.json();
      if (!data?.chart?.result?.[0]) throw new Error("Yahoo returned no chart data");
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Yahoo unavailable");
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const requestUrl = new URL(request.url);
  const symbol = normalizeYahooSymbol(requestUrl.searchParams.get("symbol"));
  if (!symbol) return respond(400, { error: "Invalid symbol" });

  const start = requestUrl.searchParams.get("start");
  const validStart = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? start : null;

  try {
    // The observation start controls KO checks in the browser, but it must not
    // hide the latest completed close. A product can be entered before its
    // observation period begins, so always fetch a short lookback before the
    // earlier of the observation start and today. The browser still filters KO
    // history from the exact observation date entered by the user.
    const nowMilliseconds = Date.now();
    const requestedStartMilliseconds = validStart ? Date.parse(`${validStart}T00:00:00Z`) : null;
    const historyStartMilliseconds = Number.isFinite(requestedStartMilliseconds)
      ? Math.max(0, Math.min(requestedStartMilliseconds, nowMilliseconds) - 14 * 86400000)
      : null;
    const periodParams = historyStartMilliseconds !== null
      ? `period1=${Math.floor(historyStartMilliseconds / 1000)}&period2=${Math.floor(nowMilliseconds / 1000) + 86400}`
      : "range=5d";
    const data = await fetchYahooChart(symbol, `${periodParams}&interval=1d&includePrePost=false`);
    const result = data?.chart?.result?.[0];
    const meta = result?.meta || {};
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = quote.close || [];
    const highs = quote.high || [];
    const timestamps = result?.timestamp || [];
    const exchangeTimeZone = meta.exchangeTimezoneName || "America/New_York";
    let history = timestamps.map((timestamp, index) => {
      const close = Number(closes[index]);
      const high = Number(highs[index]);
      if (!Number.isFinite(close) || close <= 0) return null;
      const date = dateInTimeZone(new Date(timestamp * 1000), exchangeTimeZone);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) return null;
      return {
        date,
        price: close,
        high: Number.isFinite(high) && high > 0 ? high : close
      };
    }).filter(Boolean);

    // marketState is not always present. Use the exchange's session end and a
    // 15-minute settlement buffer before accepting today's daily candle.
    const exchangeToday = dateInTimeZone(new Date(), exchangeTimeZone);
    if (history.at(-1)?.date === exchangeToday && !isCompletedDailyCloseReady(meta)) history = history.slice(0, -1);

    const regularMarketPrice = Number(meta.regularMarketPrice);
    const regularMarketTime = Number(meta.regularMarketTime);
    if (Number.isFinite(regularMarketPrice) && regularMarketPrice > 0 && Number.isFinite(regularMarketTime) && regularMarketTime > 0) {
      const regularMarketDate = dateInTimeZone(new Date(regularMarketTime * 1000), exchangeTimeZone);
      const weekday = new Date(`${regularMarketDate}T12:00:00Z`).getUTCDay();
      const closeIsReady = regularMarketDate < exchangeToday || (regularMarketDate === exchangeToday && isCompletedDailyCloseReady(meta));
      if (weekday !== 0 && weekday !== 6 && closeIsReady && !history.some((item) => item.date === regularMarketDate)) {
        const dayHigh = Number(meta.regularMarketDayHigh);
        history.push({ date: regularMarketDate, price: regularMarketPrice, high: Number.isFinite(dayHigh) && dayHigh > 0 ? dayHigh : regularMarketPrice });
        history.sort((a, b) => a.date.localeCompare(b.date));
      }
    }
    const latest = history.at(-1);
    const price = latest?.price;
    if (!price) throw new Error("No completed daily close");

    return respond(200, { symbol, price, date: latest.date, history, source: "Yahoo Finance daily close", closeVerification: "completed-daily-v3" });
  } catch (error) {
    console.error("Quote lookup failed", symbol, error.message);
    return respond(502, { error: "Quote lookup failed" });
  }
};
