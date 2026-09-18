const fs = require('fs');
const path = require('path');
const db = require('./database');

const CSV_PATH = process.argv[2] || path.join(__dirname, 'fleet.csv');

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error('CSV file not found at: ' + CSV_PATH);
    console.error('Usage: node seed-fleet.js [path-to-fleet.csv]');
    process.exit(1);
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf8').replace(/\r/g, '');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const headers = parseCSVLine(lines[0]).map(h => h.trim());

  const idx = {
    plate: headers.indexOf('Bike ID'),
    model: headers.indexOf('Model'),
    color: headers.indexOf('Color'),
    location: headers.indexOf('Current Location'),
    status: headers.indexOf('Status'),
    notes: headers.indexOf('Notes'),
  };

  if (idx.plate === -1 || idx.model === -1) {
    console.error('CSV is missing required columns "Bike ID" or "Model". Found headers: ' + headers.join(', '));
    process.exit(1);
  }

  let count = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    const plate = (row[idx.plate] || '').trim();
    const model = (row[idx.model] || '').trim();
    if (!plate || !model) { skipped++; continue; }

    let status = (row[idx.status] || 'Available').trim();
    if (!['Available', 'Rented', 'Maintenance', 'Reserved'].includes(status)) {
      status = 'Available';
    }

    db.upsertMotorbike({
      plate,
      model,
      color: idx.color >= 0 ? (row[idx.color] || '').trim() : '',
      location: idx.location >= 0 ? (row[idx.location] || '').trim() : '',
      status,
      notes: idx.notes >= 0 ? (row[idx.notes] || '').trim() : '',
    });
    count++;
  }

  console.log('Seed complete: ' + count + ' bikes imported' + (skipped ? ', ' + skipped + ' rows skipped (missing plate/model)' : ''));
}

main();
