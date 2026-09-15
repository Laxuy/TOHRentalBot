const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { extractContractData, shouldAutoFill } = require('./contractExtractor');
const { getShop } = require('./config/shops');
require('dotenv').config();
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;
// Comma-separated list of staff phone numbers (with country code, no +, e.g. "6695...,6681...") to broadcast notifications to.
const STAFF_NUMBERS = (process.env.STAFF_NUMBERS || '66950615202')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const FLEET_SHEET_ID = process.env.FLEET_SHEET_ID || '1XvSdL_oQvEZccji43kg-2C7BQgZLXi3Don2y-lZicuY';
const CONTRACTS_FOLDER_ID = process.env.CONTRACTS_FOLDER_ID || '1r3YhaWFQl7hk2Y5WJY6rdPt3cLlLGIQ_';
const MY_NUMBER = process.env.MY_NUMBER;
// Optional: set DASHBOARD_TOKEN in Railway env vars to require ?token=... on /dashboard.
// Leave unset during testing; set it before sharing the URL anywhere.
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
// Optional second token for the boss (or anyone else) — same full access as
// DASHBOARD_TOKEN, but a distinct value so logs can show who did what.
const BOSS_TOKEN = process.env.BOSS_TOKEN || '';

// Checks the ?token= query param against every known valid token and
// returns which person it belongs to, so route handlers can both gate
// access and log a human-readable actor name for state-changing actions.
function checkDashboardAuth(req) {
  const token = req.query.token || '';
  if (!DASHBOARD_TOKEN) return { ok: true, user: 'Unknown (no token set)' };
  if (token === DASHBOARD_TOKEN) return { ok: true, user: 'Kris' };
  if (BOSS_TOKEN && token === BOSS_TOKEN) return { ok: true, user: 'TOH' };
  return { ok: false, user: null };
}

const conversations = {};
const processedMessages = new Set();

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ],
});

function clean(str) {
  if (!str) return '';
  return str.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

async function ensureHeader() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1:I1',
    });
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow[0] !== 'Date') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A1:I1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Date', 'Customer Name', 'Phone Number', 'Bike Type', 'Start Date', 'End Date', 'Pickup Location', 'Price', 'Source']]
        }
      });
    }
  } catch (err) {
    console.error('Header error:', err.message);
  }
}

async function appendToSheet(data) {
  try {
    await ensureHeader();
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          now,
          clean(data.name),
          clean(data.phone),
          clean(data.bike),
          clean(data.startDate),
          clean(data.endDate),
          clean(data.location),
          clean(data.price),
          'WhatsApp Bot'
        ]]
      }
    });
    console.log('Booking logged to Google Sheets');
  } catch (err) {
    console.error('Sheets error:', err.message);
  }
}

async function ensureFinanceHeader() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties.title',
    });
    const titles = (meta.data.sheets || []).map(s => s.properties.title);
    if (!titles.includes('Finance')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: { requests: [{ addSheet: { properties: { title: 'Finance' } } }] },
      });
    }
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Finance!A1:F1',
    });
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow[0] !== 'Date') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Finance!A1:F1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Date', 'Type', 'Bike', 'Amount (THB)', 'Description', 'Reported By']]
        }
      });
    }
  } catch (err) {
    console.error('Finance header error:', err.message);
  }
}

function parseThbAmount(str) {
  if (!str) return 0;
  const match = String(str).replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

// Stricter than parseThbAmount above: used by the Dashboard aggregation so
// messy AI-parsed rows (e.g. a full sentence in the Price column instead of
// a number) get SKIPPED from revenue totals rather than silently mis-parsed.
// Only accepts a plain number, optionally with commas/decimals and a
// trailing "THB" - anything else (extra words, placeholders) returns null.
function parseCleanPrice(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  const match = trimmed.match(/^([\d,]+(?:\.\d+)?)\s*(THB)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1].replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

async function logFinance(type, bike, amount, description, reportedBy) {
  try {
    await ensureFinanceHeader();
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Finance!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[now, type, bike || '-', amount, description || '-', reportedBy || 'WhatsApp Bot']]
      }
    });
    console.log(`${type} logged to Finance sheet`);
  } catch (err) {
    console.error('Finance log error:', err.message);
  }
}

async function ensureTasksHeader(sheetId = SHEET_ID) {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties.title',
    });
    const titles = (meta.data.sheets || []).map(s => s.properties.title);
    if (!titles.includes('Tasks')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'Tasks' } } }] },
      });
    }
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Tasks!A1:F1',
    });
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow[0] !== 'Date') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Tasks!A1:F1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Date', 'Type', 'Description', 'Contact', 'Status', 'Resolved At']]
        }
      });
    }
  } catch (err) {
    console.error('Tasks header error:', err.message);
  }
}

// Logs a low-confidence / needs-human-review event to the Tasks tab, so the
// Operations OS AI Task Queue screen can show it (in addition to the existing
// WhatsApp staff notification, which still fires separately for immediacy).
async function logTask(type, description, contact, sheetId = SHEET_ID) {
  try {
    await ensureTasksHeader(sheetId);
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Tasks!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[now, type, description || '-', contact || '-', 'Open', '']]
      }
    });
    console.log(`Task logged: ${type}`);
  } catch (err) {
    console.error('Task log error:', err.message);
  }
}

// Returns every task row with its sheet row number as `id` (used to target
// the right row when resolving). Most recent first.
async function getTasks(sheetId = SHEET_ID) {
  const sheets = google.sheets({ version: 'v4', auth });
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Tasks!A2:F',
    });
  } catch (err) {
    // Tasks tab doesn't exist yet (no task has ever been logged) — treat as empty.
    console.error('Tasks read error (likely missing tab, treated as empty):', err.message);
    return [];
  }
  const rows = res.data.values || [];
  return rows
    .map((row, i) => ({
      id: i + 2, // +2: header row + 1-indexing, matches the actual sheet row
      date: row[0] || '',
      type: row[1] || '',
      description: row[2] || '',
      contact: row[3] || '',
      status: row[4] || 'Open',
      resolvedAt: row[5] || '',
    }))
    .reverse();
}

async function resolveTask(taskId, sheetId = SHEET_ID) {
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Tasks!E${taskId}:F${taskId}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [['Resolved', now]] },
  });
  return { ok: true };
}

// Reads Sheet1 with actual row numbers attached (unlike getRecentBookings,
// which drops them) and flags rows with messy price or placeholder-looking
// dates, for the /data-quality diagnostic report. Read-only — never edits
// anything, since only a human can know what the correct value should be.
async function getBookingsWithIssues(sheetId = SHEET_ID) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A2:I',
  });
  const rows = res.data.values || [];
  const isCleanDate = (str) => {
    if (!str) return false;
    return /\d/.test(str) && !str.includes('[') && !str.includes(']');
  };

  const issues = [];
  rows.forEach((row, i) => {
    const booking = {
      row: i + 2,
      date: row[0] || '',
      name: row[1] || '',
      phone: row[2] || '',
      bike: row[3] || '',
      startDate: row[4] || '',
      endDate: row[5] || '',
      location: row[6] || '',
      price: row[7] || '',
    };
    const problems = [];
    if (parseCleanPrice(booking.price) === null) problems.push('Price is not a clean number');
    if (!isCleanDate(booking.startDate)) problems.push('Start Date looks invalid/placeholder');
    if (!isCleanDate(booking.endDate)) problems.push('End Date looks invalid/placeholder');
    if (problems.length > 0) {
      issues.push({ ...booking, problems });
    }
  });
  return { totalRows: rows.length, issues };
}

async function getFinanceSummary() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Finance!A2:F',
    });
    const rows = res.data.values || [];
    let income = 0, expense = 0;
    rows.forEach(row => {
      const type = (row[1] || '').trim().toLowerCase();
      const amount = parseFloat(row[3]) || 0;
      if (type === 'income') income += amount;
      else if (type === 'expense') expense += amount;
    });
    return { income, expense, net: income - expense, count: rows.length };
  } catch (err) {
    console.error('Finance summary error:', err.message);
    return null;
  }
}

async function getTodayBookings() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:I',
    });
    const rows = res.data.values || [];
    const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
    const todayRows = rows.filter(row => row[0] && row[0].startsWith(today));
    if (todayRows.length === 0) return 'No bookings today yet.';
    let msg = `*Today Bookings (${today}):*\n\n`;
    todayRows.forEach((row, i) => {
      msg += `${i+1}. ${row[3] || 'Unknown bike'}\n`;
      msg += `   Name: ${row[1] || '-'}\n`;
      msg += `   Phone: ${row[2] || '-'}\n`;
      msg += `   Start: ${row[4] || '-'}\n`;
      msg += `   End: ${row[5] || '-'}\n`;
      msg += `   Location: ${row[6] || '-'}\n\n`;
    });
    return msg;
  } catch (err) {
    console.error('Sheets read error:', err.message);
    return 'Could not read bookings.';
  }
}

let fleetCache = { data: null, fetchedAt: 0 };
const FLEET_CACHE_TTL_MS = 60 * 1000; // 1 minute

// Parses a DD/MM/YYYY string (the en-GB format used everywhere in this file)
// and returns the whole-day difference between two such dates, or null if
// either can't be parsed.
function daysBetweenEnGBDates(startStr, endStr) {
  const parse = (s) => {
    if (!s) return null;
    const parts = String(s).split('/').map(Number);
    const [d, m, y] = parts;
    if (!d || !m || !y) return null;
    return new Date(y, m - 1, d);
  };
  const start = parse(startStr);
  const end = parse(endStr);
  if (!start || !end) return null;
  const diffMs = end - start;
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

async function ensureRentalHistoryHeader(sheetId) {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties.title',
    });
    const titles = (meta.data.sheets || []).map(s => s.properties.title);
    if (!titles.includes('RentalHistory')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        resource: { requests: [{ addSheet: { properties: { title: 'RentalHistory' } } }] },
      });
    }
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'RentalHistory!A1:J1',
    });
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow[0] !== 'Date Logged') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'RentalHistory!A1:J1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Date Logged', 'Bike ID', 'Model', 'Renter Name', 'Renter Phone', 'Start Date', 'End Date', 'Days', 'Price (THB)', 'Logged By']]
        }
      });
    }
  } catch (err) {
    console.error('Rental history header error:', err.message);
  }
}

// Logs one completed rental (start -> end) for a specific bike. Called when
// a bike gets marked Available again (i.e. a rental just ended), from either
// the WhatsApp "return" command or the Motorbikes page.
async function logRentalHistory(entry, sheetId) {
  try {
    await ensureRentalHistoryHeader(sheetId);
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'RentalHistory!A:J',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[now, entry.bikeId, entry.model, entry.renterName, entry.renterPhone, entry.startDate, entry.endDate, entry.days, entry.price || '', entry.loggedBy || '']]
      }
    });
  } catch (err) {
    console.error('Rental history log error:', err.message);
  }
}

// Returns every logged history entry for one specific bike, most recent first.
async function getRentalHistoryForBike(bikeId, sheetId) {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'RentalHistory!A2:J',
    });
    const rows = res.data.values || [];
    return rows
      .filter(row => (row[1] || '').trim().toLowerCase() === bikeId.trim().toLowerCase())
      .map(row => ({
        dateLogged: row[0] || '',
        bikeId: row[1] || '',
        model: row[2] || '',
        renterName: row[3] || '',
        renterPhone: row[4] || '',
        startDate: row[5] || '',
        endDate: row[6] || '',
        days: row[7] || '',
        price: row[8] || '',
        loggedBy: row[9] || '',
      }))
      .reverse();
  } catch (err) {
    // Tab likely doesn't exist yet (no return has ever been logged) — empty.
    console.error('Rental history read error (treated as empty):', err.message);
    return [];
  }
}

async function findBikeRow(plateQuery, fleetSheetId = FLEET_SHEET_ID) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: fleetSheetId,
    range: 'A2:A',
  });
  const rows = res.data.values || [];
  const query = plateQuery.trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const bikeId = (rows[i][0] || '').trim().toLowerCase();
    // Match if the plate/number appears as the last word of the Bike ID,
    // or the query matches the whole Bike ID (in case they type the full name).
    const lastWord = bikeId.split(' ').pop();
    if (lastWord === query || bikeId === query || bikeId.endsWith(' ' + query)) {
      return { rowNumber: i + 2, bikeId: rows[i][0] }; // +2: header row + 1-indexing
    }
  }
  return null;
}

async function setBikeStatus(plateQuery, status, fleetSheetId = FLEET_SHEET_ID, options = {}) {
  const match = await findBikeRow(plateQuery, fleetSheetId);
  if (!match) {
    return { ok: false, message: `Couldn't find a bike matching "${plateQuery}" in the fleet sheet.` };
  }
  const sheets = google.sheets({ version: 'v4', auth });
  const dateCol = status === 'Rented' ? 'G' : 'I'; // Rented Date or Returned Date
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });

  // If this is a return, grab the row's current data first (model, renter
  // info, rented date) before anything gets overwritten, so we can log a
  // complete Rental History entry for this specific bike.
  let priorRow = null;
  if (status === 'Available') {
    const rowRes = await sheets.spreadsheets.values.get({
      spreadsheetId: fleetSheetId,
      range: `A${match.rowNumber}:K${match.rowNumber}`,
    });
    priorRow = rowRes.data.values?.[0] || [];
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: fleetSheetId,
    range: `J${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[status]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: fleetSheetId,
    range: `${dateCol}${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[today]] },
  });

  fleetCache = { data: null, fetchedAt: 0 }; // force refresh next lookup

  if (status === 'Available' && priorRow) {
    const startDate = priorRow[6] || '';
    logRentalHistory({
      bikeId: match.bikeId,
      model: priorRow[1] || '',
      renterName: priorRow[4] || '',
      renterPhone: priorRow[5] || '',
      startDate,
      endDate: today,
      days: daysBetweenEnGBDates(startDate, today) ?? '',
      price: options.price || '',
      loggedBy: options.loggedBy || '',
    }, fleetSheetId).catch(err => console.error('Rental history log failed:', err.message));
  }

  return { ok: true, message: `${match.bikeId} marked as ${status}.` };
}

/**
 * Writes extracted contract data (Renter Name, Renter Phone, Rented Date,
 * Expected Return, Status) into the matching Fleet Tracker row.
 * Fleet Tracker columns: A Bike ID, B Model, C Color, D Location,
 * E Renter Name, F Renter Phone, G Rented Date, H Expected Return,
 * I Returned Date, J Status, K Notes.
 */
async function autoFillContractToFleet(extracted) {
  const match = await findBikeRow(extracted.plate);
  if (!match) {
    return { ok: false, message: `Auto-fill skipped: no fleet row found for plate "${extracted.plate}".` };
  }
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: FLEET_SHEET_ID,
    range: `E${match.rowNumber}:H${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        extracted.renterName || '',
        extracted.renterPhone || '',
        extracted.rentedDate || '',
        extracted.expectedReturn || '',
      ]]
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: FLEET_SHEET_ID,
    range: `J${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [['Rented']] },
  });

  fleetCache = { data: null, fetchedAt: 0 }; // force refresh next lookup
  return { ok: true, message: `${match.bikeId} auto-filled from contract (${extracted.renterName}).` };
}

async function getFleetAvailability(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && fleetCache.data && (now - fleetCache.fetchedAt) < FLEET_CACHE_TTL_MS) {
    return fleetCache.data;
  }
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: FLEET_SHEET_ID,
      // Columns: Bike ID, Model, Color, Current Location, Status, Renter Name, Renter Phone, Rented Date, Expected Return, Returned Date, Notes
      range: 'A2:K',
    });
    const rows = res.data.values || [];
    const byType = {};
    rows.forEach(row => {
      const bikeId = (row[0] || '').trim();
      const model = (row[1] || '').trim();
      const color = (row[2] || '').trim();
      const status = (row[9] || '').trim().toLowerCase();
      if (!bikeId || !model) return;
      if (!byType[model]) byType[model] = { total: 0, available: 0, bikes: [] };
      byType[model].total += 1;
      const isAvailable = status === '' || status === 'available';
      if (isAvailable) byType[model].available += 1;
      byType[model].bikes.push({ bikeId, color, status: status || 'available' });
    });
    fleetCache = { data: byType, fetchedAt: now };
    return byType;
  } catch (err) {
    console.error('Fleet sheet error:', err.message);
    return fleetCache.data || {};
  }
}

// Returns every individual bike row from a fleet sheet (used by the
// multi-shop /api/:shopId/motorbikes endpoint below).
async function getFleetList(fleetSheetId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: fleetSheetId,
    range: 'A2:K',
  });
  const rows = res.data.values || [];
  return rows
    .filter(row => row[0]) // has a Bike ID
    .map(row => ({
      bikeId: row[0] || '',
      model: row[1] || '',
      color: row[2] || '',
      location: row[3] || '',
      renterName: row[4] || '',
      renterPhone: row[5] || '',
      rentedDate: row[6] || '',
      expectedReturn: row[7] || '',
      returnedDate: row[8] || '',
      status: row[9] || 'Available',
      notes: row[10] || '',
    }));
}

function formatFleetSummary(byType) {
  const types = Object.keys(byType);
  if (types.length === 0) return 'Fleet data unavailable right now.';
  let msg = '';
  types.forEach(type => {
    const { total, available } = byType[type];
    msg += `- ${type}: ${available}/${total} available\n`;
  });
  return msg;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getNearestBikes(custLat, custLon) {
  const byType = await getFleetAvailability();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: FLEET_SHEET_ID,
    range: 'A2:K',
  });
  const rows = res.data.values || [];
  const results = [];
  rows.forEach(row => {
    const bikeId = (row[0] || '').trim();
    const model = (row[1] || '').trim();
    const location = (row[3] || '').trim(); // "lat,lon"
    const status = (row[9] || '').trim().toLowerCase();
    if (!bikeId || !location) return;
    const isAvailable = status === '' || status === 'available';
    if (!isAvailable) return;
    const [latStr, lonStr] = location.split(',').map(s => s.trim());
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (isNaN(lat) || isNaN(lon)) return;
    const distKm = haversineKm(custLat, custLon, lat, lon);
    results.push({ bikeId, model, distKm });
  });
  results.sort((a, b) => a.distKm - b.distKm);
  if (results.length === 0) {
    return "I couldn't find bike location data yet — let me connect you with staff to check what's nearest.";
  }
  const top = results.slice(0, 5);
  let msg = '*Nearest available bikes to you:*\n\n';
  top.forEach(b => {
    msg += `- ${b.model} (${b.bikeId}): ${b.distKm.toFixed(1)} km away\n`;
  });
  return msg;
}

async function logPhotoReceived(from, mediaId, mimeType) {
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Photos!A:D',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[now, `+${from}`, mediaId, mimeType]]
    }
  });
}

async function forwardImageToStaff(mediaId, caption) {
  await Promise.all(STAFF_NUMBERS.map(num =>
    axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: num,
        type: 'image',
        image: { id: mediaId, caption },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    ).catch(err => console.error('Forward image error:', err.message))
  ));
}

async function handleIncomingPhoto(from, mediaId) {
  try {
    // Get mime type + media URL. mediaUrl is needed to feed the image to Gemini
    // for contract extraction; it requires the same Bearer auth header to fetch.
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mimeType = metaRes.data.mime_type || 'image/jpeg';
    const mediaUrl = metaRes.data.url;

    // Forward to staff and log the photo — each wrapped separately so a
    // failure in one (e.g. missing sheet tab) never blocks the rest.
    try {
      await forwardImageToStaff(mediaId, `📄 Photo from +${from}`);
    } catch (fwdErr) {
      console.error('Forward step failed:', fwdErr.message);
    }
    try {
      await logPhotoReceived(from, mediaId, mimeType);
    } catch (logErr) {
      console.error('Log photo step failed:', logErr.message);
    }

    // Attempt contract auto-extraction (best effort — never blocks the customer reply)
    let autoFillNote = '';
    try {
      const extracted = await extractContractData(mediaUrl, `Bearer ${WHATSAPP_TOKEN}`);
      if (shouldAutoFill(extracted)) {
        const result = await autoFillContractToFleet(extracted);
        if (result.ok) {
          await notifyStaff(`✅ Auto-filled fleet sheet from contract photo (+${from}):\n${result.message}`);
        } else {
          await notifyStaff(`⚠️ Contract read OK but couldn't auto-fill (+${from}):\n${result.message}\nPlease enter manually.`);
          await logTask('Contract Auto-fill Failed', result.message, `+${from}`);
        }
      } else {
        await notifyStaff(`⚠️ Contract photo from +${from} needs manual entry (low confidence or missing plate/name). Please check the photo above and use "rent <plate>".`);
        await logTask('Contract Needs Manual Entry', 'Low confidence or missing plate/name in contract photo', `+${from}`);
      }
    } catch (extractErr) {
      console.error('Contract extraction error:', extractErr.message);
      await notifyStaff(`⚠️ Couldn't auto-read contract photo from +${from} — please enter manually.`);
      await logTask('Contract Read Error', extractErr.message, `+${from}`);
    }

    await sendWhatsApp(from, 'Got it, sent to our team ✅');
  } catch (err) {
    console.error('Photo handling error:', err.message);
    await sendWhatsApp(from, "Sorry, I couldn't process that photo — please try sending it again.");
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const msgId = message.id;
      if (processedMessages.has(msgId)) return res.sendStatus(200);
      processedMessages.add(msgId);
      const from = message.from;

      if (message.type === 'text') {
        const text = message.text.body.trim();
        console.log(`Message from ${from}: ${text}`);

        const isStaff = STAFF_NUMBERS.includes(from);

        if (isStaff) {
          const cmd = text.toLowerCase();
          if (cmd === 'list today') {
            const list = await getTodayBookings();
            await sendWhatsApp(from, list);
            return res.sendStatus(200);
          }
          if (cmd === 'fleet') {
            const byType = await getFleetAvailability(true);
            await sendWhatsApp(from, `*Fleet Availability:*\n\n${formatFleetSummary(byType)}`);
            return res.sendStatus(200);
          }
          const rentMatch = text.match(/^rent\s+(.+)$/i);
          if (rentMatch) {
            const result = await setBikeStatus(rentMatch[1], 'Rented');
            await sendWhatsApp(from, result.message);
            return res.sendStatus(200);
          }
          const returnMatch = text.match(/^return\s+(\S+)(?:\s+(\d+(?:\.\d+)?))?\s*$/i);
          if (returnMatch) {
            const [, plate, priceStr] = returnMatch;
            const result = await setBikeStatus(plate, 'Available', FLEET_SHEET_ID, {
              price: priceStr || '',
              loggedBy: `WhatsApp Staff +${from}`,
            });
            await sendWhatsApp(from, result.message);
            return res.sendStatus(200);
          }
          // expense <plate> <amount> <description...>  e.g. "expense 3990 500 broken mirror"
          const expenseMatch = text.match(/^expense\s+(\S+)\s+(\d+(?:\.\d+)?)\s*(.*)$/i);
          if (expenseMatch) {
            const [, bike, amountStr, description] = expenseMatch;
            await logFinance('Expense', bike, parseFloat(amountStr), description || 'No description', `+${from}`);
            await sendWhatsApp(from, `Logged: ${amountStr} THB expense for ${bike}${description ? ' — ' + description : ''}`);
            return res.sendStatus(200);
          }
          if (cmd === 'finance' || cmd === 'income') {
            const summary = await getFinanceSummary();
            if (!summary) {
              await sendWhatsApp(from, "Couldn't load finance data right now.");
            } else {
              await sendWhatsApp(from, `*Finance Summary:*\n\nTotal Income: ${summary.income.toLocaleString()} THB\nTotal Expenses: ${summary.expense.toLocaleString()} THB\nNet: ${summary.net.toLocaleString()} THB\n(${summary.count} entries)`);
            }
            return res.sendStatus(200);
          }
          if (cmd === 'help' || cmd === 'commands') {
            await sendWhatsApp(from, "Staff commands:\n- fleet: full bike availability\n- list today: today's bookings\n- rent <plate>: mark a bike as rented (e.g. rent 3990)\n- return <plate> [price]: mark a bike as available, optionally logging the price paid (e.g. return 3990 1200)\n- expense <plate> <amount> <description>: log an expense (e.g. expense 3990 500 broken mirror)\n- finance: income/expense/profit summary");
            return res.sendStatus(200);
          }
          // Any other message from a staff number is treated as internal chat,
          // not a customer booking request — don't send it to the customer AI.
          await sendWhatsApp(from, "Didn't recognize that as a command. Text 'help' to see what I can do.");
          return res.sendStatus(200);
        }

        await handleMessage(from, text);
      } else if (message.type === 'location') {
        const { latitude, longitude } = message.location;
        console.log(`Location from ${from}: ${latitude}, ${longitude}`);
        const nearby = await getNearestBikes(latitude, longitude);
        await sendWhatsApp(from, nearby);
      } else if (message.type === 'image') {
        const mediaId = message.image.id;
        console.log(`Image from ${from}: media ${mediaId}`);
        await handleIncomingPhoto(from, mediaId);
      } else {
        await sendWhatsApp(from, 'Sorry, I can only read text messages, photos, or shared locations. Please type your question, send a photo, or share your location (tap 📎 attach → Location) so I can tell you the nearest available bikes.');
      }
    }
  }
  res.sendStatus(200);
});

// Asks Gemini to extract booking fields from the confirmed booking summary
// text as structured JSON (constrained by responseSchema) instead of relying
// on regex against freeform text. This is what actually fixes the root cause
// of the messy Price/date data — regex on freeform text is fragile if the
// model's wording drifts even slightly, JSON schema mode forces the shape.
async function extractBookingJSON(summaryText) {
  const schema = {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      phone: { type: 'STRING' },
      bike: { type: 'STRING' },
      startDate: { type: 'STRING' },
      endDate: { type: 'STRING' },
      location: { type: 'STRING' },
      price: { type: 'NUMBER' },
    },
    required: ['name', 'phone', 'bike', 'startDate', 'endDate', 'location', 'price'],
  };
  const prompt = `Extract the booking details from this confirmed booking summary into the given JSON schema. The "price" field must be ONLY the total number in THB (no currency symbol, no words, no per-day rate) - e.g. if the summary says "Price: 3750 THB", price should be 3750. If a field is genuinely missing from the summary, use an empty string for text fields or 0 for price. Do not invent details that aren't in the summary.\n\nBooking summary:\n${summaryText}`;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }
  );
  const jsonText = response.data.candidates[0].content.parts[0].text;
  return JSON.parse(jsonText);
}

async function handleMessage(from, text) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  if (!conversations[from]) {
    conversations[from] = { history: [], bookingData: {}, stage: 'chat' };
  }
  const conv = conversations[from];
  conv.history.push({ role: 'user', parts: [{ text }] });

  const fleetData = await getFleetAvailability();
  const fleetSummary = formatFleetSummary(fleetData);

  const systemPrompt = `You are a helpful booking assistant for TOH Motorbike Rental in Koh Samui, Thailand. You help customers choose and book motorbikes.

CURRENT LIVE FLEET AVAILABILITY (bike type: available/total bikes right now):
${fleetSummary}
If a bike type shows 0 available, tell the customer it's fully booked right now and suggest a similar available alternative. Match the customer's wording to the closest bike type in this list (e.g. "Click" or "click 125" means "Honda Click 125"). Never say a bike is available if its available count is 0.

If a customer asks how far a bike is, where the nearest bike is, or anything about distance/location, ask them to share their location using WhatsApp's location-sharing feature (tap the attach/paperclip icon and choose Location). Do not guess distances yourself — the system will handle it once they share their pin.

ABOUT TOH:
- Located in Chaweng, Koh Samui (Chaweng Yai Soi 4 Bo Put, Surat Thani 84320)
- Over 5 years experience, fleet of 100+ well-maintained bikes
- Only Honda and Yamaha bikes
- Open 7 days a week
- Phone: +66 622 531 159

OUR BIKES AND PRICES (starting from per day):
OUR BIKES AND PRICES (THB per day — rate depends on rental length):
- Honda Scoopy 110cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days - Cheapest option
- Honda Click 125cc (2022-2026): 300 THB/day for 1-2 days, 250 THB/day for 3+ days - Popular
- Honda Click 150cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Yamaha Filano 125cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Honda Click 160cc (2022-2025): 400 THB/day for 1-2 days, 350 THB/day for 3+ days - Popular
- Yamaha Aerox 155cc (2020-2022): 350 THB/day for 1-2 days, 300 THB/day for 3+ days
- Yamaha Nmax 155cc (2021-2026): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Honda ADV 160cc (2024-2026): 450 THB/day for 1-2 days, 400 THB/day for 3+ days - Best Value
- Honda PCX 160cc (2022-2025): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Yamaha Xmax 300cc (2022-2025): 850 THB/day for 1-2 days, 800 THB/day for 3+ days
- Honda ADV 350cc (2022-2025): 900 THB/day for 1-2 days, 850 THB/day for 3+ days
- Honda XADV 750cc (2025): 2500 THB/day for 1-2 days, 2000 THB/day for 3+ days
- Honda Forza: 750 THB/day (single rate, not listed on official site — confirm with staff for exact terms)

PRICING RULE: If the rental is 1 or 2 days, use the "1-2 days" rate × number of days. If the rental is 3 or more days, use the "3+ days" rate × number of days. Always apply the correct per-day rate for the actual length being booked — never default to one rate regardless of duration.
If a customer asks about a bike not in this price list (e.g. Honda PCX with unconfirmed cc), do NOT make up a price. Tell them you'll need to check with staff for that model's price and offer to connect them.

DELIVERY & PICKUP ZONES:
- In-zone (normal booking, no extra steps, no fee — delivery is always free): Chaweng, Chaweng Noi, Bo Put, Choeng Mon, Maenam, Bang Rak, Central Samui, Lamai
- Out-of-zone (do NOT confirm booking yourself — tell the customer their location is outside our normal delivery range and a staff member will confirm if it's possible, then flag for human help): Nathon, Taling Ngam, Lipa Noi, Baan Tai
- If the customer names a pickup location not in either list, do not guess which zone it's in — ask them to confirm it's within our normal area, or say a staff member will confirm if unsure.
- Never finalize a booking (never say "BOOKING_COMPLETE") for an out-of-zone or unrecognized location without staff confirmation first.

INCLUDED: Helmet provided, optional comprehensive insurance available. No hidden fees. Delivery is always free within our zone.

BOOKING: Collect full name, phone number, bike type, rental start date, rental end date, pickup location.
- Today's date is ${todayStr} in Koh Samui (Thailand, GMT+7). Use this exact date for all "today", "tomorrow", and "X days from today" calculations.
- If customer says "today", use today as start date automatically.
- If customer says "X days from today" or "X days starting today", calculate the end date automatically. Example: "5 days from today" = start today, end = today + 5 days.
- If customer says "1 week", that means 7 days. Calculate end date automatically.
- NEVER ask for start or end date again if the customer already gave you enough info to calculate them.
- When summarizing booking details, do NOT use markdown formatting like ** or *. Use plain text only.
- Price must be the TOTAL cost for the full rental period (daily rate × number of days), not just the per-day rate. Show the calculation briefly if helpful, but the "Price" field itself must be the final total number in THB.
Once you have all details say exactly: "BOOKING_COMPLETE" followed by a plain text summary with each field on its own line like:
Full Name: ...
Phone Number: ...
Bike Type: ...
Start Date: ...
End Date: ...
Pickup Location: ...
Price: ... (total THB for the full rental, e.g. "1250 THB")
If customer needs human help say exactly: "NEED_HUMAN_HELP".
Be friendly, helpful and concise. Answer in the same language the customer writes in.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: conv.history
      }
    );
    const reply = response.data.candidates[0].content.parts[0].text;
    conv.history.push({ role: 'model', parts: [{ text: reply }] });

    if (reply.includes('BOOKING_COMPLETE')) {
      const cleanReply = reply.replace('BOOKING_COMPLETE', '').trim();
      await sendWhatsApp(from, 'Booking confirmed!\n\n' + cleanReply);
      await notifyStaff(`NEW BOOKING from +${from}:\n\n${cleanReply}`);

      let bookingData;
      try {
        const extracted = await extractBookingJSON(cleanReply);
        bookingData = {
          name: extracted.name,
          phone: extracted.phone || from,
          bike: extracted.bike,
          startDate: extracted.startDate,
          endDate: extracted.endDate,
          location: extracted.location,
          price: extracted.price ? `${extracted.price} THB` : '',
        };
      } catch (jsonErr) {
        // Structured extraction failed (e.g. Gemini hiccup) — fall back to the
        // old regex approach so a booking never silently fails to log at all.
        console.error('Booking JSON extraction failed, falling back to regex:', jsonErr.message);
        bookingData = {
          name: cleanReply.match(/Full Name[:\s]+([^\n]+)/i)?.[1],
          phone: cleanReply.match(/Phone Number[:\s]+([^\n]+)/i)?.[1] || from,
          bike: cleanReply.match(/Bike Type[:\s]+([^\n]+)/i)?.[1],
          startDate: cleanReply.match(/Start Date[:\s]+([^\n]+)/i)?.[1],
          endDate: cleanReply.match(/End Date[:\s]+([^\n]+)/i)?.[1],
          location: cleanReply.match(/Pickup Location[:\s]+([^\n]+)/i)?.[1],
          price: cleanReply.match(/Price[:\s]+([^\n]+)/i)?.[1],
        };
      }
      await appendToSheet(bookingData);
      const totalAmount = parseThbAmount(bookingData.price);
      if (totalAmount > 0) {
        await logFinance('Income', bookingData.bike, totalAmount, `Booking - ${bookingData.name || 'customer'}`, 'WhatsApp Bot');
      }
      console.log(`Booking completed for ${from}`);
    } else if (reply.includes('NEED_HUMAN_HELP')) {
      await sendWhatsApp(from, 'No problem! Our staff will contact you shortly.');
      await notifyStaff(`Customer +${from} needs human help!\nLast message: ${text}`);
      await logTask('Customer Needs Human Help', text, `+${from}`);
    } else {
      await sendWhatsApp(from, reply);
    }
  } catch (err) {
    console.error('Gemini error:', err.message);
    await sendWhatsApp(from, 'Sorry, something went wrong. Please try again.');
  }
}

async function sendWhatsApp(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
  }
}

async function notifyStaff(message) {
  // Sends the same message individually to every number in STAFF_NUMBERS.
  // (WhatsApp's Business API doesn't support posting into group chats, so this
  // broadcasts to each staff member's own number instead.)
  await Promise.all(STAFF_NUMBERS.map(num => sendWhatsApp(num, message)));
}

async function getRecentBookings(limit = 10, sheetId = SHEET_ID) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A2:I',
  });
  const rows = res.data.values || [];
  return rows.slice(-limit).reverse().map(row => ({
    date: row[0] || '',
    name: row[1] || '',
    phone: row[2] || '',
    bike: row[3] || '',
    startDate: row[4] || '',
    endDate: row[5] || '',
    location: row[6] || '',
    price: row[7] || '',
    source: row[8] || '',
  }));
}

async function getRecentPhotos(limit = 10) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Photos!A2:D',
  });
  const rows = res.data.values || [];
  return rows.slice(-limit).reverse().map(row => ({
    date: row[0] || '',
    from: row[1] || '',
    mediaId: row[2] || '',
    mimeType: row[3] || '',
  }));
}

// Aggregates fleet + booking data for the Operations OS Dashboard screen.
// Booking price rows that don't parse as a clean number (e.g. leftover AI
// placeholders like "[Current Date in Koh Samui]" or a full sentence instead
// of a number) are counted separately and excluded from totalRevenue, so
// messy legacy rows don't corrupt the numbers or crash the page.
async function getDashboardStats(shop) {
  const [bikes, bookings] = await Promise.all([
    getFleetList(shop.fleetSheetId),
    getRecentBookings(1000, shop.sheetId),
  ]);

  const fleetTotal = bikes.length;
  const fleetRented = bikes.filter(b => (b.status || '').toLowerCase() === 'rented').length;
  const fleetAvailable = bikes.filter(b => {
    const s = (b.status || '').toLowerCase();
    return s === '' || s === 'available';
  }).length;
  const fleetOther = fleetTotal - fleetRented - fleetAvailable; // e.g. "Maintenance"

  let totalRevenue = 0;
  let cleanBookingCount = 0;
  let skippedBookingCount = 0;
  bookings.forEach(b => {
    const amount = parseCleanPrice(b.price);
    if (amount !== null) {
      totalRevenue += amount;
      cleanBookingCount += 1;
    } else {
      skippedBookingCount += 1;
    }
  });

  return {
    fleet: {
      total: fleetTotal,
      available: fleetAvailable,
      rented: fleetRented,
      other: fleetOther,
    },
    bookings: {
      totalCount: bookings.length,
      cleanBookingCount,
      skippedBookingCount,
      totalRevenue,
    },
    recentBookings: bookings.slice(0, 5),
  };
}

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const [bookings, photos, fleet, finance] = await Promise.all([
      getRecentBookings(10).catch(() => []),
      getRecentPhotos(10).catch(() => []),
      getFleetAvailability(true).catch(() => ({})),
      getFinanceSummary().catch(() => null),
    ]);
    res.json({ bookings, photos, fleet, finance, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Dashboard data error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// Multi-shop endpoint: returns the full individual-bike list for one shop's
// fleet sheet, looked up via config/shops.js. TOH is the "toh" shop for now;
// future shops get added to that config file with their own fleetSheetId.
app.get('/api/:shopId/motorbikes', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const bikes = await getFleetList(shop.fleetSheetId);
    res.json({ shop: shop.name, bikes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Motorbikes API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Updates one bike's status from the Motorbikes screen (Rent/Return buttons).
// Reuses the same setBikeStatus logic the WhatsApp "rent"/"return" staff
// commands use, scoped to the given shop's fleet sheet.
app.post('/api/:shopId/motorbikes/:bikeId/status', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const { status, price } = req.body || {};
    if (!['Rented', 'Available'].includes(status)) {
      return res.status(400).json({ error: 'status must be "Rented" or "Available"' });
    }
    const result = await setBikeStatus(req.params.bikeId, status, shop.fleetSheetId, {
      price: price || '',
      loggedBy: auth.user,
    });
    if (result.ok) {
      console.log(`${auth.user} marked ${req.params.bikeId} as ${status} via Operations OS`);
    }
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error('Update bike status error:', err.message);
    const httpStatus = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(httpStatus).json({ error: err.message });
  }
});

// Returns one bike's current info plus its full logged rental history
// (start/end dates, days, price) for the bike detail panel on /motorbikes.
app.get('/api/:shopId/motorbikes/:bikeId/history', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const bikes = await getFleetList(shop.fleetSheetId);
    const bike = bikes.find(b => b.bikeId === req.params.bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found' });
    const history = await getRentalHistoryForBike(req.params.bikeId, shop.fleetSheetId);
    res.json({ bike, history, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Bike history API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Returns recent bookings for a shop's bookings sheet, used by the Rentals
// screen. Reuses getRecentBookings (same data the /dashboard uses for TOH).
app.get('/api/:shopId/rentals', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const bookings = await getRecentBookings(50, shop.sheetId);
    res.json({ shop: shop.name, bookings, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Rentals API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Returns aggregated fleet + revenue stats for the Operations OS Dashboard
// screen. Used by the /overview page below.
app.get('/api/:shopId/dashboard', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const stats = await getDashboardStats(shop);
    res.json({ shop: shop.name, ...stats, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Dashboard API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Returns all logged low-confidence/needs-review events for a shop, used by
// the AI Task Queue screen. Most recent first (see getTasks).
app.get('/api/:shopId/tasks', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    await ensureTasksHeader(shop.sheetId);
    const tasks = await getTasks(shop.sheetId);
    res.json({ shop: shop.name, tasks, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Tasks API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Marks one task row as Resolved from the AI Task Queue screen.
app.post('/api/:shopId/tasks/:taskId/resolve', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const taskId = parseInt(req.params.taskId, 10);
    if (!taskId || taskId < 2) {
      return res.status(400).json({ error: 'Invalid task id' });
    }
    const result = await resolveTask(taskId, shop.sheetId);
    console.log(`${auth.user} marked task ${taskId} as Resolved`);
    res.json(result);
  } catch (err) {
    console.error('Resolve task error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/dashboard', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>TOH RentalBot Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; background:#0f0f10; color:#eee; margin:0; padding:20px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .updated { color:#888; font-size:12px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:20px; }
  @media (max-width:800px) { .grid { grid-template-columns: 1fr; } }
  .card { background:#1a1a1c; border-radius:10px; padding:16px; }
  .card h2 { font-size:15px; margin:0 0 10px; color:#ccc; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 4px; border-bottom:1px solid #2a2a2c; }
  th { color:#888; font-weight:500; }
  .stat { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #2a2a2c; font-size:14px; }
  .stat:last-child { border-bottom:none; }
  .empty { color:#666; font-size:13px; padding:8px 0; }
</style>
</head>
<body>
  <h1>TOH RentalBot Dashboard</h1>
  <div class="updated" id="updated">Loading...</div>
  <div class="grid">
    <div class="card"><h2>Recent bookings</h2><div id="bookings">Loading...</div></div>
    <div class="card"><h2>Recent contract photos</h2><div id="photos">Loading...</div></div>
    <div class="card"><h2>Fleet availability</h2><div id="fleet">Loading...</div></div>
    <div class="card"><h2>Finance summary</h2><div id="finance">Loading...</div></div>
  </div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  async function load() {
    try {
      const res = await fetch('/api/dashboard-data' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) { document.getElementById('updated').textContent = data.error; return; }
      document.getElementById('updated').textContent = 'Updated ' + new Date(data.updatedAt).toLocaleTimeString();

      document.getElementById('bookings').innerHTML = data.bookings.length ? '<table><tr><th>Name</th><th>Bike</th><th>Dates</th><th>Price</th></tr>' +
        data.bookings.map(b => \`<tr><td>\${b.name}</td><td>\${b.bike}</td><td>\${b.startDate} - \${b.endDate}</td><td>\${b.price}</td></tr>\`).join('') + '</table>'
        : '<div class="empty">No bookings yet</div>';

      document.getElementById('photos').innerHTML = data.photos.length ? '<table><tr><th>From</th><th>Time</th></tr>' +
        data.photos.map(p => \`<tr><td>+\${p.from}</td><td>\${p.date}</td></tr>\`).join('') + '</table>'
        : '<div class="empty">No photos yet</div>';

      const fleetRows = Object.entries(data.fleet).map(([type, v]) => \`<div class="stat"><span>\${type}</span><span>\${v.available}/\${v.total}</span></div>\`).join('');
      document.getElementById('fleet').innerHTML = fleetRows || '<div class="empty">No fleet data</div>';

      document.getElementById('finance').innerHTML = data.finance ?
        \`<div class="stat"><span>Income</span><span>\${data.finance.income.toLocaleString()} THB</span></div>
         <div class="stat"><span>Expenses</span><span>\${data.finance.expense.toLocaleString()} THB</span></div>
         <div class="stat"><span>Net</span><span>\${data.finance.net.toLocaleString()} THB</span></div>\`
        : '<div class="empty">No finance data</div>';
    } catch (err) {
      document.getElementById('updated').textContent = 'Error loading data';
    }
  }
  load();
  setInterval(load, 5000);
</script>
</body>
</html>`);
});

app.get('/motorbikes', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>Motorbikes Inventory - TOH Rental</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com" rel="preconnect">
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: { extend: {
      "colors": {
        "outline-variant": "#c1c6d7", "background": "#faf8ff", "surface-container": "#eaedff",
        "primary-container": "#0070eb", "surface-bright": "#faf8ff", "on-surface-variant": "#414755",
        "surface-container-low": "#f2f3ff", "on-background": "#131b2e", "surface-container-lowest": "#ffffff",
        "outline": "#717786", "secondary-container": "#d5e3fd", "on-surface": "#131b2e",
        "surface": "#faf8ff", "surface-tint": "#005bc1", "secondary": "#515f74",
        "surface-container-high": "#e2e7ff", "surface-container-highest": "#dae2fd",
        "primary": "#0058bc", "on-primary": "#ffffff", "on-primary-container": "#fefcff",
        "on-secondary-container": "#57657b", "error": "#ba1a1a"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": { "gutter": "16px", "md": "16px", "xs": "8px", "base": "4px", "margin-mobile": "16px", "margin-desktop": "32px", "sm": "12px", "xl": "32px", "lg": "24px" },
      "fontFamily": { "status-badge": ["Inter"], "headline-md": ["Inter"], "body-md": ["Inter"], "body-lg": ["Inter"], "label-caps": ["JetBrains Mono"], "headline-lg": ["Inter"] },
      "fontSize": {
        "status-badge": ["12px", { "lineHeight": "12px", "fontWeight": "700" }],
        "headline-md": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
        "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
        "label-caps": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "fontWeight": "600" }]
      }
    } }
  }
</script>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  body { min-height: max(884px, 100dvh); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row">
<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0">
<h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1>
</header>
<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar">
<div class="px-4 mb-6">
<h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1>
</div>
<nav class="flex flex-col gap-2">
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/overview?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">dashboard</span>
<span class="font-label-caps text-label-caps">Overview</span>
</a>
<a class="flex items-center gap-4 bg-secondary-container text-on-secondary-container rounded-lg px-4 py-3 mx-2" href="#">
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/rentals?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">receipt_long</span>
<span class="font-label-caps text-label-caps">Rentals</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/ai-tasks?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">smart_toy</span>
<span class="font-label-caps text-label-caps">AI Tasks</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/data-quality?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">fact_check</span>
<span class="font-label-caps text-label-caps">Data Quality</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Motorbike Inventory</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<div class="flex flex-col md:flex-row gap-4 mb-6">
<div class="relative flex-1">
<span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
<input id="search-input" class="w-full pl-10 pr-4 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary font-body-md text-body-md" placeholder="Search by model, plate, or status..." type="text">
</div>
<div id="filter-bar" class="flex gap-2 overflow-x-auto no-scrollbar pb-2 md:pb-0">
<button data-filter="all" class="filter-btn whitespace-nowrap px-4 py-2 bg-primary text-on-primary rounded-full font-label-caps text-label-caps border border-primary">All</button>
<button data-filter="available" class="filter-btn whitespace-nowrap px-4 py-2 bg-surface-container-lowest text-on-surface rounded-full font-label-caps text-label-caps border border-outline-variant">Available</button>
<button data-filter="rented" class="filter-btn whitespace-nowrap px-4 py-2 bg-surface-container-lowest text-on-surface rounded-full font-label-caps text-label-caps border border-outline-variant">Rented</button>
</div>
</div>
<div id="bike-grid" class="grid grid-cols-1 xl:grid-cols-2 gap-4">
<div class="text-on-surface-variant">Loading fleet...</div>
</div>
</div>
</main>
<div id="detail-modal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 sm:p-8">
  <div class="bg-surface-container-lowest rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
    <div id="modal-body">Loading...</div>
  </div>
</div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  let ALL_BIKES = [];
  let activeFilter = 'all';

  function badgeClasses(status) {
    const s = (status || '').toLowerCase();
    if (s === 'rented') return 'bg-blue-100 text-blue-800 border-blue-200';
    if (s === 'maintenance') return 'bg-amber-100 text-amber-800 border-amber-200';
    return 'bg-green-100 text-green-800 border-green-200';
  }

  function bikeCard(b) {
    const badge = badgeClasses(b.status);
    const isRented = (b.status || '').toLowerCase() === 'rented';
    const extra = isRented
      ? \`<div class="mt-3 bg-surface-container-low p-2 rounded border border-outline-variant/50">
           <p class="font-body-md text-body-md"><span class="font-semibold">Renter:</span> \${b.renterName || '-'}</p>
           <p class="font-body-md text-body-md text-on-surface-variant mt-1">Expected return: \${b.expectedReturn || '-'}</p>
         </div>\`
      : '';
    const actionLabel = isRented ? 'Mark Returned' : 'Mark Rented';
    const newStatus = isRented ? 'Available' : 'Rented';
    const bikeIdAttr = b.bikeId.replace(/"/g, '&quot;');
    return \`<article class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div class="flex justify-between items-start">
        <button class="view-history-btn text-left" data-bike-id="\${bikeIdAttr}">
          <h3 class="font-headline-md text-headline-md text-on-surface font-semibold hover:text-primary transition-colors">\${b.model || b.bikeId}</h3>
          <p class="font-label-caps text-label-caps text-on-surface-variant mt-1">\${b.bikeId}\${b.color ? ' • ' + b.color : ''}</p>
        </button>
        <div class="px-3 py-1 rounded-full font-status-badge text-status-badge uppercase border \${badge}">\${b.status || 'Available'}</div>
      </div>
      \${extra}
      <div class="mt-1 flex gap-2">
        <button class="update-status-btn flex-1 px-4 py-2 bg-primary text-on-primary rounded-lg font-label-caps text-label-caps hover:bg-surface-tint transition-colors" data-bike-id="\${bikeIdAttr}" data-new-status="\${newStatus}">\${actionLabel}</button>
        <button class="view-history-btn px-4 py-2 bg-surface-container-lowest text-on-surface rounded-lg font-label-caps text-label-caps border border-outline-variant hover:bg-surface-container-high transition-colors" data-bike-id="\${bikeIdAttr}">History</button>
      </div>
    </article>\`;
  }

  function renderBikes() {
    const grid = document.getElementById('bike-grid');
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    let filtered = ALL_BIKES.filter(b => {
      const status = (b.status || 'available').toLowerCase();
      if (activeFilter === 'available' && status !== 'available' && status !== '') return false;
      if (activeFilter === 'rented' && status !== 'rented') return false;
      if (query) {
        const haystack = \`\${b.bikeId} \${b.model} \${b.status}\`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    grid.innerHTML = filtered.length
      ? filtered.map(bikeCard).join('')
      : '<div class="text-on-surface-variant">No bikes match.</div>';
  }

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.remove('bg-primary', 'text-on-primary', 'border-primary');
        b.classList.add('bg-surface-container-lowest', 'text-on-surface', 'border-outline-variant');
      });
      btn.classList.remove('bg-surface-container-lowest', 'text-on-surface', 'border-outline-variant');
      btn.classList.add('bg-primary', 'text-on-primary', 'border-primary');
      renderBikes();
    });
  });
  document.getElementById('search-input').addEventListener('input', renderBikes);

  document.getElementById('bike-grid').addEventListener('click', async (e) => {
    const historyBtn = e.target.closest('.view-history-btn');
    if (historyBtn) {
      openHistoryModal(historyBtn.dataset.bikeId);
      return;
    }
    const btn = e.target.closest('.update-status-btn');
    if (!btn) return;

    let price = '';
    if (btn.dataset.newStatus === 'Available') {
      const entered = prompt('Price received for this rental (THB)? Leave blank to skip.');
      if (entered === null) return; // cancelled
      price = entered.trim();
    }

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      const res = await fetch('/api/toh/motorbikes/' + encodeURIComponent(btn.dataset.bikeId) + '/status' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: btn.dataset.newStatus, price })
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      await loadBikes();
    } catch (err) {
      alert('Failed to update status');
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  async function openHistoryModal(bikeId) {
    const modal = document.getElementById('detail-modal');
    const body = document.getElementById('modal-body');
    body.innerHTML = '<div class="p-6 text-on-surface-variant">Loading...</div>';
    modal.classList.remove('hidden');
    try {
      const res = await fetch('/api/toh/motorbikes/' + encodeURIComponent(bikeId) + '/history' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        body.innerHTML = '<div class="p-6 text-error">' + data.error + '</div>';
        return;
      }
      const b = data.bike;
      const isRented = (b.status || '').toLowerCase() === 'rented';
      const badge = isRented ? 'bg-blue-100 text-blue-800 border-blue-200' : 'bg-green-100 text-green-800 border-green-200';

      const historyRows = data.history.length
        ? data.history.map(h => \`
          <div class="bg-surface-container-low rounded-xl p-4 flex flex-col gap-1">
            <div class="flex justify-between items-center">
              <span class="font-semibold text-on-surface">\${h.renterName || 'Unknown renter'}</span>
              <span class="font-semibold text-primary">\${h.price ? h.price + ' THB' : 'No price logged'}</span>
            </div>
            <div class="text-sm text-on-surface-variant">\${h.startDate || '-'} \u2192 \${h.endDate || '-'} &middot; \${h.days || '?'} days</div>
            \${h.renterPhone ? \`<div class="text-sm text-on-surface-variant">\${h.renterPhone}</div>\` : ''}
          </div>\`).join('')
        : '<div class="text-on-surface-variant text-sm py-8 text-center">No rental history logged yet for this bike.</div>';

      body.innerHTML = \`
        <div class="p-6 border-b border-outline-variant flex justify-between items-start">
          <div>
            <h3 class="font-headline-lg text-headline-lg font-semibold text-on-surface">\${b.model || b.bikeId}</h3>
            <p class="font-label-caps text-label-caps text-on-surface-variant mt-1">\${b.bikeId}\${b.color ? ' • ' + b.color : ''}</p>
          </div>
          <button id="close-modal-btn" class="text-on-surface-variant hover:text-on-surface p-1">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class="p-6">
          <div class="flex items-center gap-4 mb-6 text-sm">
            <span class="px-3 py-1 rounded-full font-status-badge text-status-badge uppercase border \${badge}">\${b.status || 'Available'}</span>
            <span class="text-on-surface-variant">Location: \${b.location || '-'}</span>
          </div>
          <h4 class="font-semibold text-on-surface mb-3">Rental History</h4>
          <div class="flex flex-col gap-3">\${historyRows}</div>
        </div>
      \`;
      document.getElementById('close-modal-btn').addEventListener('click', () => modal.classList.add('hidden'));
    } catch (err) {
      body.innerHTML = '<div class="p-6 text-error">Failed to load bike details</div>';
    }
  }

  document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') document.getElementById('detail-modal').classList.add('hidden');
  });

  async function loadBikes() {
    try {
      const res = await fetch('/api/toh/motorbikes' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        document.getElementById('bike-grid').innerHTML = '<div class="text-error">' + data.error + '</div>';
        return;
      }
      ALL_BIKES = data.bikes;
      renderBikes();
    } catch (err) {
      document.getElementById('bike-grid').innerHTML = '<div class="text-error">Failed to load fleet data</div>';
    }
  }
  loadBikes();
</script>
</body></html>`);
});

app.get('/rentals', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>Rentals - TOH Rental</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com" rel="preconnect">
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: { extend: {
      "colors": {
        "outline-variant": "#c1c6d7", "background": "#faf8ff", "surface-container": "#eaedff",
        "primary-container": "#0070eb", "surface-bright": "#faf8ff", "on-surface-variant": "#414755",
        "surface-container-low": "#f2f3ff", "on-background": "#131b2e", "surface-container-lowest": "#ffffff",
        "outline": "#717786", "secondary-container": "#d5e3fd", "on-surface": "#131b2e",
        "surface": "#faf8ff", "surface-tint": "#005bc1", "secondary": "#515f74",
        "surface-container-high": "#e2e7ff", "surface-container-highest": "#dae2fd",
        "primary": "#0058bc", "on-primary": "#ffffff", "on-primary-container": "#fefcff",
        "on-secondary-container": "#57657b", "error": "#ba1a1a"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": { "gutter": "16px", "md": "16px", "xs": "8px", "base": "4px", "margin-mobile": "16px", "margin-desktop": "32px", "sm": "12px", "xl": "32px", "lg": "24px" },
      "fontFamily": { "status-badge": ["Inter"], "headline-md": ["Inter"], "body-md": ["Inter"], "body-lg": ["Inter"], "label-caps": ["JetBrains Mono"], "headline-lg": ["Inter"] },
      "fontSize": {
        "status-badge": ["12px", { "lineHeight": "12px", "fontWeight": "700" }],
        "headline-md": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
        "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
        "label-caps": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "fontWeight": "600" }]
      }
    } }
  }
</script>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  body { min-height: max(884px, 100dvh); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row">
<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0">
<h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1>
</header>
<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar">
<div class="px-4 mb-6">
<h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1>
</div>
<nav class="flex flex-col gap-2">
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/overview?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">dashboard</span>
<span class="font-label-caps text-label-caps">Overview</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/motorbikes?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
<a class="flex items-center gap-4 bg-secondary-container text-on-secondary-container rounded-lg px-4 py-3 mx-2" href="#">
<span class="material-symbols-outlined">receipt_long</span>
<span class="font-label-caps text-label-caps">Rentals</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/ai-tasks?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">smart_toy</span>
<span class="font-label-caps text-label-caps">AI Tasks</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/data-quality?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">fact_check</span>
<span class="font-label-caps text-label-caps">Data Quality</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Rentals</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<div class="relative">
<span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
<input id="search-input" class="w-full pl-10 pr-4 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary font-body-md text-body-md" placeholder="Search by customer, phone, or bike..." type="text">
</div>
<div id="rentals-list" class="flex flex-col gap-3">
<div class="text-on-surface-variant">Loading rentals...</div>
</div>
</div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  let ALL_BOOKINGS = [];

  function rentalCard(b) {
    return \`<article class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
      <div class="w-10 h-10 rounded bg-surface-container flex items-center justify-center shrink-0 text-on-surface-variant">
        <span class="material-symbols-outlined text-[20px]">two_wheeler</span>
      </div>
      <div class="flex-1 grid grid-cols-1 sm:grid-cols-4 gap-2 sm:gap-4">
        <div>
          <p class="font-label-caps text-label-caps text-on-surface-variant mb-1">Customer</p>
          <p class="font-body-md text-on-surface font-semibold">\${b.name || '-'}</p>
          <p class="font-body-md text-on-surface-variant text-sm">\${b.phone || '-'}</p>
        </div>
        <div>
          <p class="font-label-caps text-label-caps text-on-surface-variant mb-1">Bike</p>
          <p class="font-body-md text-on-surface">\${b.bike || '-'}</p>
        </div>
        <div>
          <p class="font-label-caps text-label-caps text-on-surface-variant mb-1">Dates</p>
          <p class="font-body-md text-on-surface">\${b.startDate || '-'} → \${b.endDate || '-'}</p>
          <p class="font-body-md text-on-surface-variant text-sm">\${b.location || '-'}</p>
        </div>
        <div>
          <p class="font-label-caps text-label-caps text-on-surface-variant mb-1">Price</p>
          <p class="font-body-md text-on-surface font-semibold">\${b.price || '-'}</p>
          <p class="font-body-md text-on-surface-variant text-sm">\${b.date || ''}</p>
        </div>
      </div>
    </article>\`;
  }

  function renderRentals() {
    const list = document.getElementById('rentals-list');
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    let filtered = ALL_BOOKINGS;
    if (query) {
      filtered = ALL_BOOKINGS.filter(b => \`\${b.name} \${b.phone} \${b.bike}\`.toLowerCase().includes(query));
    }
    list.innerHTML = filtered.length ? filtered.map(rentalCard).join('') : '<div class="text-on-surface-variant">No rentals match.</div>';
  }

  document.getElementById('search-input').addEventListener('input', renderRentals);

  async function loadRentals() {
    try {
      const res = await fetch('/api/toh/rentals' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        document.getElementById('rentals-list').innerHTML = '<div class="text-error">' + data.error + '</div>';
        return;
      }
      ALL_BOOKINGS = data.bookings;
      renderRentals();
    } catch (err) {
      document.getElementById('rentals-list').innerHTML = '<div class="text-error">Failed to load rentals</div>';
    }
  }
  loadRentals();
</script>
</body></html>`);
});

app.get('/overview', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>Overview - TOH Rental</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com" rel="preconnect">
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: { extend: {
      "colors": {
        "outline-variant": "#c1c6d7", "background": "#faf8ff", "surface-container": "#eaedff",
        "primary-container": "#0070eb", "surface-bright": "#faf8ff", "on-surface-variant": "#414755",
        "surface-container-low": "#f2f3ff", "on-background": "#131b2e", "surface-container-lowest": "#ffffff",
        "outline": "#717786", "secondary-container": "#d5e3fd", "on-surface": "#131b2e",
        "surface": "#faf8ff", "surface-tint": "#005bc1", "secondary": "#515f74",
        "surface-container-high": "#e2e7ff", "surface-container-highest": "#dae2fd",
        "primary": "#0058bc", "on-primary": "#ffffff", "on-primary-container": "#fefcff",
        "on-secondary-container": "#57657b", "error": "#ba1a1a"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": { "gutter": "16px", "md": "16px", "xs": "8px", "base": "4px", "margin-mobile": "16px", "margin-desktop": "32px", "sm": "12px", "xl": "32px", "lg": "24px" },
      "fontFamily": { "status-badge": ["Inter"], "headline-md": ["Inter"], "body-md": ["Inter"], "body-lg": ["Inter"], "label-caps": ["JetBrains Mono"], "headline-lg": ["Inter"] },
      "fontSize": {
        "status-badge": ["12px", { "lineHeight": "12px", "fontWeight": "700" }],
        "headline-md": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
        "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
        "label-caps": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "fontWeight": "600" }]
      }
    } }
  }
</script>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  body { min-height: max(884px, 100dvh); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row">
<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0">
<h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1>
</header>
<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar">
<div class="px-4 mb-6">
<h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1>
</div>
<nav class="flex flex-col gap-2">
<a class="flex items-center gap-4 bg-secondary-container text-on-secondary-container rounded-lg px-4 py-3 mx-2" href="#">
<span class="material-symbols-outlined">dashboard</span>
<span class="font-label-caps text-label-caps">Overview</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/motorbikes?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/rentals?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">receipt_long</span>
<span class="font-label-caps text-label-caps">Rentals</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/ai-tasks?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">smart_toy</span>
<span class="font-label-caps text-label-caps">AI Tasks</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/data-quality?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">fact_check</span>
<span class="font-label-caps text-label-caps">Data Quality</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Overview</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<div id="stat-cards" class="grid grid-cols-2 lg:grid-cols-4 gap-4">
  <div class="text-on-surface-variant col-span-full">Loading dashboard...</div>
</div>
<div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4">
  <h3 class="font-headline-md text-headline-md text-on-surface font-semibold mb-3">Recent bookings</h3>
  <div id="recent-list" class="flex flex-col gap-2">
    <div class="text-on-surface-variant">Loading...</div>
  </div>
</div>
</div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};

  function statCard(label, value, icon) {
    return \`<div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-col gap-1">
      <div class="flex items-center gap-2 text-on-surface-variant">
        <span class="material-symbols-outlined text-[18px]">\${icon}</span>
        <span class="font-label-caps text-label-caps">\${label}</span>
      </div>
      <span class="font-headline-lg text-headline-lg text-on-surface font-semibold">\${value}</span>
    </div>\`;
  }

  function recentRow(b) {
    return \`<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 py-2 border-b border-outline-variant/50 last:border-0">
      <div>
        <span class="font-body-md text-on-surface font-semibold">\${b.name || '-'}</span>
        <span class="font-body-md text-on-surface-variant"> · \${b.bike || '-'}</span>
      </div>
      <span class="font-body-md text-on-surface-variant">\${b.price || '-'}</span>
    </div>\`;
  }

  async function loadOverview() {
    try {
      const res = await fetch('/api/toh/dashboard' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        document.getElementById('stat-cards').innerHTML = '<div class="text-error col-span-full">' + data.error + '</div>';
        return;
      }
      document.getElementById('stat-cards').innerHTML = [
        statCard('Bikes Available', data.fleet.available + ' / ' + data.fleet.total, 'two_wheeler'),
        statCard('Bikes Rented', data.fleet.rented, 'schedule'),
        statCard('Total Bookings', data.bookings.totalCount, 'receipt_long'),
        statCard('Revenue (clean rows)', data.bookings.totalRevenue.toLocaleString() + ' THB', 'payments'),
      ].join('');

      document.getElementById('recent-list').innerHTML = data.recentBookings.length
        ? data.recentBookings.map(recentRow).join('')
        : '<div class="text-on-surface-variant">No bookings yet</div>';

      if (data.bookings.skippedBookingCount > 0) {
        document.getElementById('recent-list').innerHTML += '<div class="text-on-surface-variant text-sm mt-2">' +
          data.bookings.skippedBookingCount + ' older booking(s) skipped from revenue due to messy price data.</div>';
      }
    } catch (err) {
      document.getElementById('stat-cards').innerHTML = '<div class="text-error col-span-full">Failed to load dashboard data</div>';
    }
  }
  loadOverview();
</script>
</body></html>`);
});

app.get('/ai-tasks', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>AI Task Queue - TOH Rental</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com" rel="preconnect">
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: { extend: {
      "colors": {
        "outline-variant": "#c1c6d7", "background": "#faf8ff", "surface-container": "#eaedff",
        "primary-container": "#0070eb", "surface-bright": "#faf8ff", "on-surface-variant": "#414755",
        "surface-container-low": "#f2f3ff", "on-background": "#131b2e", "surface-container-lowest": "#ffffff",
        "outline": "#717786", "secondary-container": "#d5e3fd", "on-surface": "#131b2e",
        "surface": "#faf8ff", "surface-tint": "#005bc1", "secondary": "#515f74",
        "surface-container-high": "#e2e7ff", "surface-container-highest": "#dae2fd",
        "primary": "#0058bc", "on-primary": "#ffffff", "on-primary-container": "#fefcff",
        "on-secondary-container": "#57657b", "error": "#ba1a1a"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": { "gutter": "16px", "md": "16px", "xs": "8px", "base": "4px", "margin-mobile": "16px", "margin-desktop": "32px", "sm": "12px", "xl": "32px", "lg": "24px" },
      "fontFamily": { "status-badge": ["Inter"], "headline-md": ["Inter"], "body-md": ["Inter"], "body-lg": ["Inter"], "label-caps": ["JetBrains Mono"], "headline-lg": ["Inter"] },
      "fontSize": {
        "status-badge": ["12px", { "lineHeight": "12px", "fontWeight": "700" }],
        "headline-md": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
        "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
        "label-caps": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "fontWeight": "600" }]
      }
    } }
  }
</script>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  body { min-height: max(884px, 100dvh); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row">
<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0">
<h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1>
</header>
<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar">
<div class="px-4 mb-6">
<h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1>
</div>
<nav class="flex flex-col gap-2">
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/overview?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">dashboard</span>
<span class="font-label-caps text-label-caps">Overview</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/motorbikes?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/rentals?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">receipt_long</span>
<span class="font-label-caps text-label-caps">Rentals</span>
</a>
<a class="flex items-center gap-4 bg-secondary-container text-on-secondary-container rounded-lg px-4 py-3 mx-2" href="#">
<span class="material-symbols-outlined">smart_toy</span>
<span class="font-label-caps text-label-caps">AI Tasks</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/data-quality?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">fact_check</span>
<span class="font-label-caps text-label-caps">Data Quality</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">AI Task Queue</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<div id="filter-bar" class="flex gap-2 overflow-x-auto no-scrollbar pb-2 md:pb-0">
<button data-filter="open" class="filter-btn whitespace-nowrap px-4 py-2 bg-primary text-on-primary rounded-full font-label-caps text-label-caps border border-primary">Open</button>
<button data-filter="resolved" class="filter-btn whitespace-nowrap px-4 py-2 bg-surface-container-lowest text-on-surface rounded-full font-label-caps text-label-caps border border-outline-variant">Resolved</button>
<button data-filter="all" class="filter-btn whitespace-nowrap px-4 py-2 bg-surface-container-lowest text-on-surface rounded-full font-label-caps text-label-caps border border-outline-variant">All</button>
</div>
<div id="task-list" class="flex flex-col gap-3">
<div class="text-on-surface-variant">Loading tasks...</div>
</div>
</div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  let ALL_TASKS = [];
  let activeFilter = 'open';

  function typeIcon(type) {
    if ((type || '').toLowerCase().includes('human help')) return 'support_agent';
    if ((type || '').toLowerCase().includes('contract')) return 'description';
    return 'smart_toy';
  }

  function taskCard(t) {
    const isOpen = t.status === 'Open';
    const badge = isOpen ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-green-100 text-green-800 border-green-200';
    const actionBtn = isOpen
      ? \`<button class="resolve-btn px-4 py-2 bg-primary text-on-primary rounded-lg font-label-caps text-label-caps hover:bg-surface-tint transition-colors" data-task-id="\${t.id}">Mark Resolved</button>\`
      : \`<span class="font-body-md text-on-surface-variant text-sm">Resolved \${t.resolvedAt || ''}</span>\`;
    return \`<article class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
      <div class="w-10 h-10 rounded bg-surface-container flex items-center justify-center shrink-0 text-on-surface-variant">
        <span class="material-symbols-outlined text-[20px]">\${typeIcon(t.type)}</span>
      </div>
      <div class="flex-1 grid grid-cols-1 sm:grid-cols-4 gap-2 sm:gap-4">
        <div>
          <p class="font-label-caps text-label-caps text-on-surface-variant mb-1">Type</p>
          <p class="font-body-md text-on-surface font-semibold">\${t.type || '-'}</p>
          <p class="font-body-md text-on-surface-variant text-sm">\${t.contact || '-'}</p>
        </div>
        <div class="sm:col-span-2">
          <p class="font-label-caps text-label-caps text-on-surface-variant mb-1">Details</p>
          <p class="font-body-md text-on-surface">\${t.description || '-'}</p>
          <p class="font-body-md text-on-surface-variant text-sm">\${t.date || ''}</p>
        </div>
        <div class="flex items-center justify-between sm:justify-end gap-3">
          <div class="px-3 py-1 rounded-full font-status-badge text-status-badge uppercase border \${badge}">\${t.status}</div>
          \${actionBtn}
        </div>
      </div>
    </article>\`;
  }

  function renderTasks() {
    const list = document.getElementById('task-list');
    let filtered = ALL_TASKS;
    if (activeFilter === 'open') filtered = ALL_TASKS.filter(t => t.status === 'Open');
    else if (activeFilter === 'resolved') filtered = ALL_TASKS.filter(t => t.status === 'Resolved');
    list.innerHTML = filtered.length ? filtered.map(taskCard).join('') : '<div class="text-on-surface-variant">No tasks match.</div>';
  }

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.remove('bg-primary', 'text-on-primary', 'border-primary');
        b.classList.add('bg-surface-container-lowest', 'text-on-surface', 'border-outline-variant');
      });
      btn.classList.remove('bg-surface-container-lowest', 'text-on-surface', 'border-outline-variant');
      btn.classList.add('bg-primary', 'text-on-primary', 'border-primary');
      renderTasks();
    });
  });

  document.getElementById('task-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.resolve-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Resolving...';
    try {
      const res = await fetch('/api/toh/tasks/' + encodeURIComponent(btn.dataset.taskId) + '/resolve' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''), {
        method: 'POST',
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        btn.disabled = false;
        btn.textContent = 'Mark Resolved';
        return;
      }
      await loadTasks();
    } catch (err) {
      alert('Failed to resolve task');
      btn.disabled = false;
      btn.textContent = 'Mark Resolved';
    }
  });

  async function loadTasks() {
    try {
      const res = await fetch('/api/toh/tasks' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        document.getElementById('task-list').innerHTML = '<div class="text-error">' + data.error + '</div>';
        return;
      }
      ALL_TASKS = data.tasks;
      renderTasks();
    } catch (err) {
      document.getElementById('task-list').innerHTML = '<div class="text-error">Failed to load tasks</div>';
    }
  }
  loadTasks();
</script>
</body></html>`);
});

// Read-only diagnostic: lists Sheet1 rows with a messy price or
// placeholder-looking date, so a human can fix them with the correct info.
// Never edits anything itself.
app.get('/api/:shopId/data-quality', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const report = await getBookingsWithIssues(shop.sheetId);
    res.json({ shop: shop.name, ...report, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Data quality API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/data-quality', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>Data Quality Report - TOH Rental</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com" rel="preconnect">
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: { extend: {
      "colors": {
        "outline-variant": "#c1c6d7", "background": "#faf8ff", "surface-container": "#eaedff",
        "primary-container": "#0070eb", "surface-bright": "#faf8ff", "on-surface-variant": "#414755",
        "surface-container-low": "#f2f3ff", "on-background": "#131b2e", "surface-container-lowest": "#ffffff",
        "outline": "#717786", "secondary-container": "#d5e3fd", "on-surface": "#131b2e",
        "surface": "#faf8ff", "surface-tint": "#005bc1", "secondary": "#515f74",
        "surface-container-high": "#e2e7ff", "surface-container-highest": "#dae2fd",
        "primary": "#0058bc", "on-primary": "#ffffff", "on-primary-container": "#fefcff",
        "on-secondary-container": "#57657b", "error": "#ba1a1a"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": { "gutter": "16px", "md": "16px", "xs": "8px", "base": "4px", "margin-mobile": "16px", "margin-desktop": "32px", "sm": "12px", "xl": "32px", "lg": "24px" },
      "fontFamily": { "status-badge": ["Inter"], "headline-md": ["Inter"], "body-md": ["Inter"], "body-lg": ["Inter"], "label-caps": ["JetBrains Mono"], "headline-lg": ["Inter"] },
      "fontSize": {
        "status-badge": ["12px", { "lineHeight": "12px", "fontWeight": "700" }],
        "headline-md": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
        "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
        "label-caps": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "fontWeight": "600" }]
      }
    } }
  }
</script>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  body { min-height: max(884px, 100dvh); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row">
<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0">
<h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1>
</header>
<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar">
<div class="px-4 mb-6">
<h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1>
</div>
<nav class="flex flex-col gap-2">
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/overview?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">dashboard</span>
<span class="font-label-caps text-label-caps">Overview</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/motorbikes?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/rentals?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">receipt_long</span>
<span class="font-label-caps text-label-caps">Rentals</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/ai-tasks?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">smart_toy</span>
<span class="font-label-caps text-label-caps">AI Tasks</span>
</a>
<a class="flex items-center gap-4 bg-secondary-container text-on-secondary-container rounded-lg px-4 py-3 mx-2" href="#">
<span class="material-symbols-outlined">fact_check</span>
<span class="font-label-caps text-label-caps">Data Quality</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Data Quality Report</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<p class="text-on-surface-variant text-sm">Read-only list of booking rows with a messy price or placeholder-looking date. Nothing here is auto-fixed \u2014 edit the flagged rows directly in the Google Sheet with the correct values.</p>
<div id="summary" class="text-on-surface-variant"></div>
<div id="report" class="flex flex-col gap-3"></div>
</div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  async function load() {
    try {
      const res = await fetch('/api/toh/data-quality' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        document.getElementById('summary').innerHTML = '<span class="text-error">' + data.error + '</span>';
        return;
      }
      document.getElementById('summary').textContent = data.issues.length + ' of ' + data.totalRows + ' booking rows need attention.';
      document.getElementById('report').innerHTML = data.issues.length ? data.issues.map(r => \`
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4">
          <div class="flex justify-between items-start mb-2">
            <span class="font-semibold">Row \${r.row} \u2014 \${r.name || 'Unknown'} \u00b7 \${r.bike || '-'}</span>
            <span class="text-xs text-on-surface-variant">\${r.date}</span>
          </div>
          <div class="text-sm text-on-surface-variant grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <div><span class="text-on-surface-variant">Start:</span> \${r.startDate || '-'}</div>
            <div><span class="text-on-surface-variant">End:</span> \${r.endDate || '-'}</div>
            <div><span class="text-on-surface-variant">Price:</span> \${r.price || '-'}</div>
            <div><span class="text-on-surface-variant">Location:</span> \${r.location || '-'}</div>
          </div>
          <div class="flex flex-wrap gap-1">
            \${r.problems.map(p => \`<span class="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200">\${p}</span>\`).join('')}
          </div>
        </div>
      \`).join('') : '<div class="text-on-surface-variant">No issues found \ud83c\udf89</div>';
    } catch (err) {
      document.getElementById('summary').innerHTML = '<span class="text-error">Failed to load report</span>';
    }
  }
  load();
</script>
</body></html>`);
});

app.listen(3000, () => console.log('TOH Rental Bot running on port 3000'));
