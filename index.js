require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const cron = require("node-cron");

const bot = new TelegramBot(process.env.TG_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });
const CHANNEL = process.env.CHANNEL;

const DB_PATH = path.join(__dirname, "db.json");
const MAX_AGE_DAYS = 2;

function loadDb() {
  if (!fs.existsSync(DB_PATH)) return { postedUrls: [] };

  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!Array.isArray(db.postedUrls)) db.postedUrls = [];
    return db;
  } catch {
    return { postedUrls: [] };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function clean(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function fullUrl(url, base) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return new URL(url, base).href;
}

function isFresh(dateText) {
  if (!dateText) return true;

  const parsed = Date.parse(dateText);
  if (Number.isNaN(parsed)) return true;

  const diffDays = (Date.now() - parsed) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= MAX_AGE_DAYS;
}

function unique(items) {
  const seen = new Set();

  return items.filter(item => {
    if (!item.link || seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });
}

async function parseArticleDetails(link) {
  try {
    const { data } = await axios.get(link, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    const $ = cheerio.load(data);

    const image =
      fullUrl($('meta[property="og:image"]').attr("content"), link) ||
      fullUrl($("article img").first().attr("src"), link) ||
      fullUrl($("article img").first().attr("data-src"), link) ||
      fullUrl($("img").first().attr("src"), link) ||
      fullUrl($("img").first().attr("data-src"), link);

    const date =
      $("time").attr("datetime") ||
      $('meta[property="article:published_time"]').attr("content") ||
      $('meta[name="date"]').attr("content") ||
      $(".date").first().text();

    const description =
      clean($('meta[property="og:description"]').attr("content")) ||
      clean($('meta[name="description"]').attr("content")) ||
      clean($("article p").first().text()) ||
      clean($("p").first().text());

    return { image, date, description };
  } catch (e) {
    console.log("Не смог открыть статью:", link, e.message);
    return { image: null, date: null, description: "" };
  }
}

async function parseSkigu() {
  const base = "https://skigu.ru/news/";
  const { data } = await axios.get(base, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 15000
  });

  const $ = cheerio.load(data);
  const items = [];

  $("a").each((_, el) => {
    const title = clean($(el).text());
    const link = fullUrl($(el).attr("href"), base);

    if (
      title.length > 20 &&
      title.length < 180 &&
      link &&
      link.includes("skigu.ru/news/")
    ) {
      items.push({ source: "SKIGU", title, link });
    }
  });

  return unique(items).slice(0, 10);
}

async function parseSkiRu() {
  const base = "https://www.ski.ru/static/300/";
  const { data } = await axios.get(base, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 15000
  });

  const $ = cheerio.load(data);
  const items = [];

  $("a").each((_, el) => {
    const title = clean($(el).text());
    const link = fullUrl($(el).attr("href"), base);

    if (
      title.length > 20 &&
      title.length < 180 &&
      link &&
      link.includes("ski.ru") &&
      !link.includes("#") &&
      !title.toLowerCase().includes("форум")
    ) {
      items.push({ source: "SKI.RU", title, link });
    }
  });

  return unique(items).slice(0, 10);
}

async function collectNews() {
  const results = await Promise.allSettled([parseSkigu(), parseSkiRu()]);
  let all = [];

  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.log("Ошибка источника:", r.reason.message);
  }

  all = unique(all);
  const detailed = [];

  for (const item of all) {
    const details = await parseArticleDetails(item.link);

    if (!isFresh(details.date)) {
      console.log("Старая новость, пропускаю:", item.title, details.date || "нет даты");
      continue;
    }

    detailed.push({
      ...item,
      image: details.image,
      date: details.date,
      description: details.description
    });
  }

  return detailed;
}

async function rewrite(item) {
  const prompt = `
Перепиши новость для Telegram-канала @ski_ai_news.

Правила:
- максимум 650 символов
- живой Telegram-стиль
- без кликбейта
- без markdown-звездочек
- не выдумывай факты
- короткий заголовок
- не пиши "Источник" внутри текста

Данные:
Источник: ${item.source}
Заголовок: ${item.title}
Описание: ${item.description || "нет"}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

async function publishOne() {
  const db = loadDb();
  const news = await collectNews();

  console.log("Найдено свежих новостей:", news.length);

  const fresh = news.find(item => {
    if (db.postedUrls.includes(item.link)) {
      console.log("Дубль, пропускаю:", item.title);
      return false;
    }

    return true;
  });

  if (!fresh) {
    console.log("Новых неповторяющихся новостей нет");
    return;
  }

  const text = await rewrite(fresh);
  const message = `${text}\n\nИсточник: ${fresh.link}`;

  try {
    if (fresh.image) {
      await bot.sendPhoto(CHANNEL, fresh.image, {
        caption: message.slice(0, 1024)
      });

      console.log("Опубликовано с картинкой:", fresh.title);
    } else {
      await bot.sendMessage(CHANNEL, message, {
        disable_web_page_preview: false
      });

      console.log("Опубликовано без картинки:", fresh.title);
    }

    db.postedUrls.push(fresh.link);
    db.postedUrls = [...new Set(db.postedUrls)].slice(-1000);
    saveDb(db);
  } catch (e) {
    console.log("Ошибка публикации:", fresh.title, e.message);
  }
}

console.log("Бот запущен. Режим: каждые 3 часа, свежие до 2 дней, без дублей.");

publishOne();

cron.schedule("0 */3 * * *", publishOne);
