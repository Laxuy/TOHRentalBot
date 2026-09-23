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

    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('staff','boss')),
      shift_start TEXT DEFAULT '08:00',
      shift_end TEXT DEFAULT '18:00',
      status TEXT DEFAULT 'inactive' CHECK(status IN ('active','inactive','leave')),
      check_in_at TEXT DEFAULT '',
      today_hours REAL DEFAULT 0,
      week_hours REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS staff_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      edited_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('staff','boss','admin')),
      staff_id INTEGER REFERENCES staff(id),
      created_at TEXT DEFAULT (datetime('now','localtime')),
      last_login_at TEXT DEFAULT ''
    );
  `);

  // Lightweight migration: add payment-status tracking to finance
  // (SQLite can't alter a CHECK constraint, so we track pending payments
  // via a separate status column instead of a new finance "type").
  try {
    db.exec("ALTER TABLE finance ADD COLUMN status TEXT DEFAULT 'Confirmed'");
  } catch (e) {
    // column already exists — safe to ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      history TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL,
      rental_id INTEGER,
      renter_name TEXT DEFAULT '',
      deposit_type TEXT NOT NULL CHECK(deposit_type IN ('passport','cash')),
      amount_collected REAL DEFAULT 0,
      amount_refunded REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','partial','returned')),
      deduction_reason TEXT DEFAULT '',
      collected_by TEXT DEFAULT '',
      collected_at TEXT DEFAULT (datetime('now','localtime')),
      refunded_by TEXT DEFAULT '',
      refunded_at TEXT DEFAULT ''
    );
  `);

  try {
    db.exec("ALTER TABLE staff ADD COLUMN photo TEXT DEFAULT ''");
  } catch (e) {
    // column already exists — safe to ignore
  }
  try {
    db.exec("ALTER TABLE rentals ADD COLUMN pickup_location TEXT DEFAULT ''");
  } catch (e) {}
  try {
    db.exec("ALTER TABLE rental_history ADD COLUMN pickup_location TEXT DEFAULT ''");
  } catch (e) {}

  // Multi-tenant: tag every table with which shop it belongs to.
  // Existing rows all belong to 'toh' (the default), so nothing changes
  // for the current data — this only matters once a second shop exists.
  const shopIdTables = [
    'motorbikes', 'rentals', 'bookings', 'finance', 'tasks',
    'rental_history', 'photos', 'staff', 'staff_edits', 'users',
    'deposits', 'conversations',
  ];
  shopIdTables.forEach(table => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN shop_id TEXT DEFAULT 'toh'`);
    } catch (e) {}
  });

  migrateToCompositeKeys();
}

function migrateToCompositeKeys() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const done = db.prepare(`SELECT value FROM schema_meta WHERE key = 'composite_keys_v1'`).get();
  if (done) return; // already migrated

  const runMigration = db.transaction(() => {
    // Rebuild motorbikes with a composite (shop_id, plate) primary key,
    // so two different shops can safely use the same plate/code.
    db.exec(`
      CREATE TABLE motorbikes_new (
        shop_id TEXT NOT NULL DEFAULT 'toh',
        plate TEXT NOT NULL,
        model TEXT NOT NULL,
        color TEXT DEFAULT '',
        location TEXT DEFAULT '',
        status TEXT DEFAULT 'Available' CHECK(status IN ('Available','Rented','Maintenance','Reserved')),
        notes TEXT DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (shop_id, plate)
      );
    `);
    db.exec(`
      INSERT INTO motorbikes_new (shop_id, plate, model, color, location, status, notes, updated_at)
      SELECT COALESCE(shop_id,'toh'), plate, model, color, location, status, notes, updated_at FROM motorbikes;
    `);
    db.exec(`DROP TABLE motorbikes;`);
    db.exec(`ALTER TABLE motorbikes_new RENAME TO motorbikes;`);

    // Rebuild rentals without the old single-column FK to motorbikes(plate),
    // which no longer matches now that the key is composite. Shop scoping
    // is handled at the application level (shop_id + plate together).
    db.exec(`
      CREATE TABLE rentals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL DEFAULT 'toh',
        plate TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT DEFAULT '',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        price REAL DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','done')),
        logged_by TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        pickup_location TEXT DEFAULT ''
      );
    `);
    db.exec(`
      INSERT INTO rentals_new (id, shop_id, plate, customer_name, customer_phone, start_date, end_date, price, status, logged_by, created_at, pickup_location)
      SELECT id, COALESCE(shop_id,'toh'), plate, customer_name, customer_phone, start_date, end_date, price, status, logged_by, created_at, COALESCE(pickup_location,'') FROM rentals;
    `);
    db.exec(`DROP TABLE rentals;`);
    db.exec(`ALTER TABLE rentals_new RENAME TO rentals;`);

    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('composite_keys_v1', datetime('now','localtime'))`).run();
  });
  db.pragma('foreign_keys = OFF');
  try {
    runMigration();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// ─── Motorbikes ────────────────────────────────────────────

function getAllMotorbikes() {
  const db = getDb();
  return db.prepare('SELECT * FROM motorbikes ORDER BY model, plate').all();
}

function getMotorbikeByPlate(plate) {
  const db = getDb();
  const exact = db.prepare('SELECT * FROM motorbikes WHERE plate = ?').get(plate);
  if (exact) return exact;
  // Fallback: staff often type just the trailing number/code (e.g. "3990"
  // instead of "Honda Click 150 3990"). Match plates ending with that code.
  const query = String(plate).trim();
  if (!query) return null;
  const matches = db.prepare('SELECT * FROM motorbikes WHERE plate LIKE ?').all('%' + query);
  if (matches.length === 1) return matches[0];
  return null; // ambiguous (0 or 2+ matches) — treat as not found
}

function findMotorbikesByCode(plate) {
  const db = getDb();
  const query = String(plate).trim();
  return db.prepare('SELECT * FROM motorbikes WHERE plate LIKE ?').all('%' + query);
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

  const doCreate = db.transaction((r) => {
    db.prepare(`
      INSERT INTO rentals (plate, customer_name, customer_phone, start_date, end_date, price, status, logged_by, pickup_location)
      VALUES (@plate, @customer_name, @customer_phone, @start_date, @end_date, @price, 'active', @logged_by, @pickup_location)
    `).run({ pickup_location: '', ...r });
    db.prepare(`
      UPDATE motorbikes SET status = ?, updated_at = datetime('now','localtime')
      WHERE plate = ?
    `).run('Rented', r.plate);
  });
  doCreate(rental);

  return { ok: true, plate: rental.plate, customer: rental.customer_name };
}

function completeRental(plate, price, loggedBy) {
  const db = getDb();
  const active = db.prepare(`
    SELECT * FROM rentals WHERE plate = ? AND status = 'active' ORDER BY id DESC LIMIT 1
  `).get(plate);

  if (!active) return { ok: false, message: `No active rental found for ${plate}` };

  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
  const startDate = active.start_date;
  const endDate = today;
  let days = 0;
  const parseDate = s => { const [d,m,y] = String(s).split('/').map(Number); return new Date(y,m-1,d); };
  const sd = parseDate(startDate), ed = parseDate(endDate);
  if (sd && ed) days = Math.max(0, Math.round((ed - sd) / 86400000));
  const finalPrice = price || active.price || '';

  const doComplete = db.transaction(() => {
    db.prepare('UPDATE rentals SET status = ?, price = COALESCE(NULLIF(?,0), price) WHERE id = ?')
      .run('done', price || 0, active.id);
    db.prepare(`
      UPDATE motorbikes SET status = ?, updated_at = datetime('now','localtime')
      WHERE plate = ?
    `).run('Available', plate);
    db.prepare(`
      INSERT INTO rental_history (date_logged, bike_id, model, renter_name, renter_phone, start_date, end_date, days, price, logged_by, pickup_location)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(today, plate, '', active.customer_name, active.customer_phone, startDate, endDate, days, finalPrice, loggedBy || '', active.pickup_location || '');
  });
  doComplete();

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

function logFinance(type, bike, amount, description, reportedBy, status) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare(`
    INSERT INTO finance (date, type, bike, amount, description, reported_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(now, type, bike || '-', amount, description || '-', reportedBy || 'WhatsApp Bot', status || 'Confirmed');
}

function getFinanceSummary() {
  const db = getDb();
  const rows = db.prepare('SELECT type, amount, status FROM finance').all();
  let income = 0, expense = 0;
  rows.forEach(r => {
    const t = (r.type || '').trim().toLowerCase();
    const s = (r.status || 'Confirmed').trim().toLowerCase();
    if (t === 'income' && s !== 'pending') income += r.amount;
    else if (t === 'expense') expense += r.amount;
  });
  return { income, expense, net: income - expense, count: rows.length };
}

function getPendingPayments() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM finance WHERE type = 'Income' AND status = 'Pending' ORDER BY id DESC
  `).all();
}

// ─── Conversations (chat memory) ────────────────────────────

function getConversationHistory(phone) {
  const db = getDb();
  const row = db.prepare('SELECT history FROM conversations WHERE phone = ?').get(phone);
  if (!row) return [];
  try {
    return JSON.parse(row.history);
  } catch (e) {
    return [];
  }
}

function saveConversationHistory(phone, history) {
  const db = getDb();
  const json = JSON.stringify(history);
  db.prepare(`
    INSERT INTO conversations (phone, history, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(phone) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at
  `).run(phone, json);
}

// ─── Processed message dedup ────────────────────────────────

function hasProcessedMessage(messageId) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?').get(messageId);
}

function markMessageProcessed(messageId) {
  const db = getDb();
  try {
    db.prepare('INSERT INTO processed_messages (message_id) VALUES (?)').run(messageId);
  } catch (e) {
    // already exists — fine, dedup still holds
  }
  // Keep the table small: drop entries older than 24 hours.
  db.prepare(`DELETE FROM processed_messages WHERE created_at < datetime('now','-1 day','localtime')`).run();
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

// ─── Staff ──────────────────────────────────────────────────

function getAllStaff() {
  const db = getDb();
  return db.prepare('SELECT * FROM staff ORDER BY role DESC, name').all();
}

function getStaffById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
}

function normalizeThaiPhone(phone) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) {
    digits = '66' + digits.slice(1);
  }
  return digits;
}

function getStaffByPhone(phone) {
  const db = getDb();
  const target = normalizeThaiPhone(phone);
  if (!target) return null;
  const all = db.prepare('SELECT * FROM staff').all();
  return all.find(s => normalizeThaiPhone(s.phone) === target) || null;
}

function addStaff({ name, phone, role, shiftStart, shiftEnd }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO staff (name, phone, role, shift_start, shift_end, status)
    VALUES (?, ?, ?, ?, ?, 'inactive')
  `).run(name, phone || '', role, shiftStart || '08:00', shiftEnd || '18:00');
  return { ok: true, id: info.lastInsertRowid };
}

function removeStaff(id) {
  const db = getDb();
  db.prepare('DELETE FROM staff WHERE id = ?').run(id);
  return { ok: true };
}

function checkInStaff(id) {
  const db = getDb();
  const staff = getStaffById(id);
  if (!staff) return { ok: false, message: 'Staff not found' };
  const now = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  db.prepare(`UPDATE staff SET status='active', check_in_at=?, updated_at=datetime('now','localtime') WHERE id=?`).run(now, id);
  const late = now > staff.shift_start;
  return { ok: true, checkIn: now, late };
}

function checkOutStaff(id) {
  const db = getDb();
  const staff = getStaffById(id);
  if (!staff) return { ok: false, message: 'Staff not found' };
  let hoursToday = 0;
  if (staff.check_in_at) {
    const [h1, m1] = staff.check_in_at.split(':').map(Number);
    const now = new Date();
    const start = new Date(); start.setHours(h1, m1, 0, 0);
    hoursToday = Math.max(0, Math.round(((now - start) / 3600000) * 10) / 10);
  }
  const newWeekHours = Math.round((staff.week_hours + hoursToday) * 10) / 10;
  db.prepare(`
    UPDATE staff SET status='inactive', check_in_at='', today_hours=0, week_hours=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(newWeekHours, id);
  return { ok: true, hoursToday, weekHours: newWeekHours };
}

function setStaffLeave(id) {
  const db = getDb();
  db.prepare(`UPDATE staff SET status='leave', check_in_at='', updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return { ok: true };
}

function updateStaffShift(id, shiftStart, shiftEnd, editedBy) {
  const db = getDb();
  const staff = getStaffById(id);
  if (!staff) return { ok: false, message: 'Staff not found' };
  db.prepare(`UPDATE staff SET shift_start=?, shift_end=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(shiftStart, shiftEnd, id);
  db.prepare(`INSERT INTO staff_edits (staff_id, field, old_value, new_value, edited_by) VALUES (?, 'shift', ?, ?, ?)`)
    .run(id, `${staff.shift_start}-${staff.shift_end}`, `${shiftStart}-${shiftEnd}`, editedBy || '');
  return { ok: true, staff: getStaffById(id) };
}

function editStaffHours(id, todayHours, weekHours, editedBy) {
  const db = getDb();
  const staff = getStaffById(id);
  if (!staff) return { ok: false, message: 'Staff not found' };
  db.prepare(`UPDATE staff SET today_hours=?, week_hours=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(todayHours, weekHours, id);
  db.prepare(`INSERT INTO staff_edits (staff_id, field, old_value, new_value, edited_by) VALUES (?, 'hours', ?, ?, ?)`)
    .run(id, `${staff.today_hours}/${staff.week_hours}`, `${todayHours}/${weekHours}`, editedBy || '');
  return { ok: true };
}

function setStaffPhoto(id, photoDataUrl) {
  const db = getDb();
  const staff = getStaffById(id);
  if (!staff) return { ok: false, message: 'Staff not found' };
  if (photoDataUrl && !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photoDataUrl)) {
    return { ok: false, message: 'Invalid image format' };
  }
  if (photoDataUrl && photoDataUrl.length > 700000) {
    return { ok: false, message: 'Image too large (max ~500KB)' };
  }
  db.prepare(`UPDATE staff SET photo=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(photoDataUrl || '', id);
  return { ok: true };
}

// ─── Deposits ───────────────────────────────────────────────

function collectDeposit({ plate, rentalId, renterName, depositType, amount, collectedBy }) {
  const db = getDb();
  if (!['passport', 'cash'].includes(depositType)) {
    return { ok: false, message: 'Deposit type must be passport or cash' };
  }
  const amt = depositType === 'cash' ? (parseFloat(amount) || 0) : 0;
  const info = db.prepare(`
    INSERT INTO deposits (plate, rental_id, renter_name, deposit_type, amount_collected, status, collected_by)
    VALUES (?, ?, ?, ?, ?, 'held', ?)
  `).run(plate, rentalId || null, renterName || '', depositType, amt, collectedBy || '');
  return { ok: true, id: info.lastInsertRowid };
}

function getActiveDepositForPlate(plate) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM deposits WHERE plate = ? AND status = 'held' ORDER BY id DESC LIMIT 1
  `).get(plate);
}

function refundDeposit(depositId, amountRefunded, deductionReason, refundedBy) {
  const db = getDb();
  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
  if (!deposit) return { ok: false, message: 'Deposit not found' };
  const refund = Math.max(0, Math.min(parseFloat(amountRefunded) || 0, deposit.amount_collected));
  const status = refund >= deposit.amount_collected && deposit.amount_collected > 0 ? 'returned'
    : deposit.deposit_type === 'passport' ? 'returned'
    : 'partial';
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare(`
    UPDATE deposits SET amount_refunded=?, status=?, deduction_reason=?, refunded_by=?, refunded_at=?
    WHERE id=?
  `).run(refund, status, deductionReason || '', refundedBy || '', now, depositId);
  return { ok: true, status };
}

function getOpenDeposits() {
  const db = getDb();
  return db.prepare(`SELECT * FROM deposits WHERE status = 'held' ORDER BY id DESC`).all();
}

function getAllDeposits() {
  const db = getDb();
  return db.prepare(`SELECT * FROM deposits ORDER BY id DESC`).all();
}

// ─── Users (login) ───────────────────────────────────────────

function getUserByUsername(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser({ username, passwordHash, role, staffId }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, staff_id)
    VALUES (?, ?, ?, ?)
  `).run(username, passwordHash, role, staffId || null);
  return { ok: true, id: info.lastInsertRowid };
}

function updateUserLastLogin(id) {
  const db = getDb();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
}

function getAllUsers() {
  const db = getDb();
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.last_login_at, s.name as staff_name
    FROM users u LEFT JOIN staff s ON u.staff_id = s.id
    ORDER BY u.role DESC, u.username
  `).all();
}

function deleteUser(id) {
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = {
  getDb,
  // motorbikes
  getAllMotorbikes,
  getMotorbikeByPlate,
  findMotorbikesByCode,
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
  getPendingPayments,
  // conversations
  getConversationHistory,
  saveConversationHistory,
  // message dedup
  hasProcessedMessage,
  markMessageProcessed,
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
  // staff
  getAllStaff,
  getStaffById,
  getStaffByPhone,
  addStaff,
  removeStaff,
  checkInStaff,
  checkOutStaff,
  setStaffLeave,
  updateStaffShift,
  editStaffHours,
  setStaffPhoto,
  // deposits
  collectDeposit,
  getActiveDepositForPlate,
  refundDeposit,
  getOpenDeposits,
  getAllDeposits,
  // users
  getUserByUsername,
  getUserById,
  createUser,
  updateUserLastLogin,
  getAllUsers,
  deleteUser,
};
