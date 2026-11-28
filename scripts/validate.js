#!/usr/bin/env node
'use strict';

/**
 * Проверка корректности data/catalog.json для SecuTar Help.
 * Запуск: node scripts/validate.js [путь-к-json]
 * Используется в GitHub Action перед публикацией сайта.
 * Внешних зависимостей нет — требуется только Node.js.
 */

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'catalog.json');

const errors = [];
const warnings = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function isId(v) { return typeof v === 'string' && /^[a-z0-9-]+$/.test(v); }
function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) { return false; }
}

let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error('Ошибка: не удалось прочитать файл: ' + file);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('Ошибка: файл не является корректным JSON.');
  console.error('Подсказка: ' + e.message);
  process.exit(1);
}

if (!data || typeof data !== 'object' || Array.isArray(data)) {
  console.error('Ошибка: верхний уровень должен быть объектом { "categories": [...], "resources": [...] }');
  process.exit(1);
}

const seenIds = new Set();
const catIds = new Set();

// --- Категории ---
function walkCats(list, where) {
  if (!Array.isArray(list)) {
    err(where + ': должен быть массивом');
    return;
  }
  list.forEach((c, i) => {
    const whereHere = where + '[' + i + ']';
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      err(whereHere + ': элемент должен быть объектом');
      return;
    }
    if (!isId(c.id)) err(whereHere + '.id: ожидается строка из латиницы/цифр/дефисов, получено: ' + JSON.stringify(c.id));
    else if (seenIds.has(c.id)) err(whereHere + '.id "' + c.id + '" уже используется');
    else { seenIds.add(c.id); catIds.add(c.id); }
    if (typeof c.name !== 'string' || !c.name.trim()) err(whereHere + '.name: пустое или отсутствует');
    if (typeof c.order !== 'number') warn(whereHere + '.order: не число — будет использовано значение 0');
    if (!Array.isArray(c.children)) err(whereHere + '.children: должен быть массивом (может быть пустым [])');
    else walkCats(c.children, whereHere + '.children');
  });
}
walkCats(data.categories, 'categories');

if (!catIds.size) err('Не найдено ни одной корректной категории');

// --- Ресурсы ---
const urlSeen = new Map();
let resCount = 0;
if (!Array.isArray(data.resources)) {
  err('resources: должен быть массивом');
} else {
  data.resources.forEach((r, i) => {
    const whereHere = 'resources[' + i + ']';
    resCount++;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      err(whereHere + ': элемент должен быть объектом');
      return;
    }
    if (!isId(r.id)) err(whereHere + '.id: ожидается строка из латиницы/цифр/дефисов, получено: ' + JSON.stringify(r.id));
    else if (seenIds.has(r.id)) err(whereHere + '.id "' + r.id + '" уже используется');
    else seenIds.add(r.id);
    if (typeof r.title !== 'string' || !r.title.trim()) err(whereHere + '.title: пустое или отсутствует');
    if (!isHttpUrl(r.url)) err(whereHere + '.url: должен быть адресом http:// или https://, получено: ' + JSON.stringify(r.url));
    if (r.description !== undefined && typeof r.description !== 'string') err(whereHere + '.description: должен быть строкой');
    if (typeof r.category !== 'string' || !catIds.has(r.category)) {
      err(whereHere + '.category "' + JSON.stringify(r.category) + '": категория с таким id не найдена');
    }
    if (!Array.isArray(r.tags)) {
      err(whereHere + '.tags: должен быть массивом строк (может быть пустым [])');
    } else if (r.tags.some((t) => typeof t !== 'string' || !t.trim())) {
      err(whereHere + '.tags: все элементы должны быть непустыми строками');
    }
    if (typeof r.order !== 'number') warn(whereHere + '.order: не число — будет использовано значение 0');

    if (isHttpUrl(r.url)) {
      const norm = r.url.replace(/\/+$/, '').toLowerCase();
      if (urlSeen.has(norm)) warn(whereHere + ': URL уже используется в ' + urlSeen.get(norm));
      else urlSeen.set(norm, r.id || '?');
    }
  });
}

if (resCount === 0) err('Не найдено ни одного ресурса');

// --- Итог ---
if (warnings.length) {
  console.log('Предупреждения (' + warnings.length + '):');
  warnings.forEach((w) => console.log('  ⚠ ' + w));
}

if (errors.length) {
  console.error('');
  console.error('Ошибок: ' + errors.length);
  errors.forEach((e) => console.error('  ✗ ' + e));
  console.error('');
  console.error('Публикация отменена. Исправьте data/catalog.json и повторите push.');
  process.exit(1);
}

console.log('OK: каталог корректен.');
console.log('   Категорий: ' + catIds.size + ', ресурсов: ' + resCount + ', тегов: ' +
  new Set(data.resources.flatMap((r) => (Array.isArray(r.tags) ? r.tags : []))).size);
