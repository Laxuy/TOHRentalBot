const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'toh.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createTables();
  }
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS motorbikes (
      plate TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      color TEXT DEFAULT '',
      location TEXT DEFAULT '',
      status TEXT DEFAULT 'Available' CHECK(status IN ('Available','Rented','Maintenance','Reserved')),
      notes TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS rentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL REFERENCES motorbikes(plate),
      customer_name TEXT NOT NULL,
      customer_phone TEXT DEFAULT '',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      price REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','done')),
      logged_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      customer_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      bike_type TEXT DEFAULT '',
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      location TEXT DEFAULT '',
      price TEXT DEFAULT '',
      source TEXT DEFAULT 'WhatsApp Bot',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS finance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('Income','Expense')),
      bike TEXT DEFAULT '-',
      amount REAL NOT NULL,
      description TEXT DEFAULT '-',
      reported_by TEXT DEFAULT 'WhatsApp Bot',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT DEFAULT '-',
      contact TEXT DEFAULT '-',
      status TEXT DEFAULT 'Open' CHECK(status IN ('Open','Resolved')),
      resolved_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS rental_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_logged TEXT NOT NULL,
      bike_id TEXT NOT NULL,
      model TEXT DEFAULT '',
      renter_name TEXT DEFAULT '',
      renter_phone TEXT DEFAULT '',
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      days INTEGER DEFAULT 0,
      price TEXT DEFAULT '',
      logged_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      phone TEXT NOT NULL,
      media_id TEXT NOT NULL,
      mime_type TEXT DEFAULT 'image/jpeg',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

// ─── Motorbikes ────────────────────────────────────────────

function getAllMotorbikes() {
  const db = getDb();
  return db.prepare('SELECT * FROM motorbikes ORDER BY model, plate').all();
}

function getMotorbikeByPlate(plate) {
  const db = getDb();
  return db.prepare('SELECT * FROM motorbikes WHERE plate = ?').get(plate);
}

function upsertMotorbike(bike) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO motorbikes (plate, model, color, location, status, notes)
    VALUES (@plate, @model, @color, @location, @status, @notes)
    ON CONFLICT(plate) DO UPDATE SET
      model=excluded.model, color=excluded.color, location=excluded.location,
      status=excluded.status, notes=excluded.notes, updated_at=datetime('now','localtime')
  `).run(bike);
}

function updateBikeStatus(plate, status) {
  const db = getDb();
  return db.prepare(`
    UPDATE motorbikes SET status = ?, updated_at = datetime('now','localtime')
    WHERE plate = ?
  `).run(status, plate);
}

function getFleetAvailability() {
  const db = getDb();
  const rows = db.prepare('SELECT model, status FROM motorbikes ORDER BY model').all();
  const byType = {};
  rows.forEach(row => {
    const model = row.model.trim();
    if (!model) return;
    if (!byType[model]) byType[model] = { total: 0, available: 0, bikes: [] };
    byType[model].total += 1;
    const isAvailable = row.status === 'Available';
    if (isAvailable) byType[model].available += 1;
  });
  return byType;
}

// ─── Rentals ───────────────────────────────────────────────

function createRental(rental) {
  const db = getDb();
  const bike = getMotorbikeByPlate(rental.plate);
  if (!bike) return { ok: false, message: `No bike found for plate "${rental.plate}"` };
  if (bike.status === 'Rented') return { ok: false, message: `${rental.plate} is already Rented` };
  if (bike.status === 'Maintenance') return { ok: false, message: `${rental.plate} is in Maintenance` };
  if (bike.status === 'Reserved') return { ok: false, message: `${rental.plate} is Reserved` };

  const stmt = db.prepare(`
    INSERT INTO rentals (plate, customer_name, customer_phone, start_date, end_date, price, status, logged_by)
    VALUES (@plate, @customer_name, @customer_phone, @start_date, @end_date, @price, 'active', @logged_by)
  `);
  stmt.run(rental);
  updateBikeStatus(rental.plate, 'Rented');
  return { ok: true, plate: rental.plate, customer: rental.customer_name };
}

function completeRental(plate, price, loggedBy) {
  const db = getDb();
  const active = db.prepare(`
    SELECT * FROM rentals WHERE plate = ? AND status = 'active' ORDER BY id DESC LIMIT 1
  `).get(plate);

  if (!active) return { ok: false, message: `No active rental found for ${plate}` };

  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });

  db.prepare('UPDATE rentals SET status = ?, price = COALESCE(NULLIF(?,0), price) WHERE id = ?')
    .run('done', price || 0, active.id);
  updateBikeStatus(plate, 'Available');

  // Log rental history
  const startDate = active.start_date;
  const endDate = today;
  let days = 0;
  const parseDate = s => { const [d,m,y] = String(s).split('/').map(Number); return new Date(y,m-1,d); };
  const sd = parseDate(startDate), ed = parseDate(endDate);
  if (sd && ed) days = Math.max(0, Math.round((ed - sd) / 86400000));

  db.prepare(`
    INSERT INTO rental_history (date_logged, bike_id, model, renter_name, renter_phone, start_date, end_date, days, price, logged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(today, plate, '', active.customer_name, active.customer_phone, startDate, endDate, days, price || active.price || '', loggedBy || '');

  return { ok: true, plate, customer: active.customer_name };
}

function getActiveRentals() {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, m.model, m.color
    FROM rentals r LEFT JOIN motorbikes m ON r.plate = m.plate
    WHERE r.status = 'active'
    ORDER BY r.start_date DESC
  `).all();
}

function getRentalsForDate(dateStr) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, m.model, m.color
    FROM rentals r LEFT JOIN motorbikes m ON r.plate = m.plate
    WHERE ? BETWEEN r.start_date AND r.end_date
    ORDER BY r.start_date DESC
  `).all(dateStr);
}

// ─── Bookings ──────────────────────────────────────────────

function appendBooking(data) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare(`
    INSERT INTO bookings (date, customer_name, phone, bike_type, start_date, end_date, location, price, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now, data.name || '', data.phone || '', data.bike || '', data.startDate || '', data.endDate || '', data.location || '', data.price || '', data.source || 'WhatsApp Bot');
}

function getTodayBookings() {
  const db = getDb();
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
  return db.prepare('SELECT * FROM bookings WHERE date LIKE ? ORDER BY date DESC').all(today + '%');
}

function getRecentBookings(limit = 10) {
  const db = getDb();
  return db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT ?').all(limit);
}

// ─── Finance ────────────────────────────────────────────────

function logFinance(type, bike, amount, description, reportedBy) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare(`
    INSERT INTO finance (date, type, bike, amount, description, reported_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(now, type, bike || '-', amount, description || '-', reportedBy || 'WhatsApp Bot');
}

function getFinanceSummary() {
  const db = getDb();
  const rows = db.prepare('SELECT type, amount FROM finance').all();
  let income = 0, expense = 0;
  rows.forEach(r => {
    const t = (r.type || '').trim().toLowerCase();
    if (t === 'income') income += r.amount;
    else if (t === 'expense') expense += r.amount;
  });
  return { income, expense, net: income - expense, count: rows.length };
}

// ─── Tasks ──────────────────────────────────────────────────

function logTask(type, description, contact) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare(`
    INSERT INTO tasks (date, type, description, contact, status)
    VALUES (?, ?, ?, ?, 'Open')
  `).run(now, type, description || '-', contact || '-');
}

function getTasks() {
  const db = getDb();
  const rows = db.prepare('SELECT rowid as id, * FROM tasks ORDER BY id DESC').all();
  return rows.map(r => ({
    id: r.id,
    date: r.date,
    type: r.type,
    description: r.description,
    contact: r.contact,
    status: r.status,
    resolvedAt: r.resolved_at,
  }));
}

function resolveTask(taskId) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare('UPDATE tasks SET status = ?, resolved_at = ? WHERE rowid = ?').run('Resolved', now, taskId);
  return { ok: true };
}

// ─── Rental History ────────────────────────────────────────

function getRentalHistoryForBike(plate) {
  const db = getDb();
  return db.prepare('SELECT * FROM rental_history WHERE bike_id = ? ORDER BY id DESC').all(plate);
}

function getAllRentalHistory() {
  const db = getDb();
  return db.prepare('SELECT * FROM rental_history ORDER BY id DESC').all();
}

// ─── Photos ─────────────────────────────────────────────────

function logPhoto(phone, mediaId, mimeType) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare('INSERT INTO photos (date, phone, media_id, mime_type) VALUES (?, ?, ?, ?)')
    .run(now, phone, mediaId, mimeType || 'image/jpeg');
}

function getRecentPhotos(limit = 10) {
  const db = getDb();
  return db.prepare('SELECT * FROM photos ORDER BY id DESC LIMIT ?').all(limit);
}

// ─── Dashboard Stats ───────────────────────────────────────

function getDashboardStats() {
  const db = getDb();
  const activeRentals = db.prepare("SELECT COUNT(*) as c FROM rentals WHERE status = 'active'").get().c;
  const available = db.prepare("SELECT COUNT(*) as c FROM motorbikes WHERE status = 'Available'").get().c;
  const rented = db.prepare("SELECT COUNT(*) as c FROM motorbikes WHERE status = 'Rented'").get().c;
  const maintenance = db.prepare("SELECT COUNT(*) as c FROM motorbikes WHERE status = 'Maintenance'").get().c;
  const openTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'Open'").get().c;
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
  const todayBookings = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date LIKE ?').get(today + '%').c;
  const finance = getFinanceSummary();

  return {
    activeRentals,
    available,
    rented,
    maintenance,
    openTasks,
    todayBookings,
    totalBikes: available + rented + maintenance,
    finance: finance || { income: 0, expense: 0, net: 0 },
  };
}

module.exports = {
  getDb,
  // motorbikes
  getAllMotorbikes,
  getMotorbikeByPlate,
  upsertMotorbike,
  updateBikeStatus,
  getFleetAvailability,
  // rentals
  createRental,
  completeRental,
  getActiveRentals,
  getRentalsForDate,
  // bookings
  appendBooking,
  getTodayBookings,
  getRecentBookings,
  // finance
  logFinance,
  getFinanceSummary,
  // tasks
  logTask,
  getTasks,
  resolveTask,
  // rental history
  getRentalHistoryForBike,
  getAllRentalHistory,
  // photos
  logPhoto,
  getRecentPhotos,
  // dashboard
  getDashboardStats,
};
