/**
 * Minimal CSV reader for member sheets. Supports quoted fields with commas and
 * doubled quotes; header names are matched case-insensitively with aliases.
 */

const HEADER_ALIASES = {
  name: ['name', 'full name', 'member name', 'member'],
  department: ['department', 'dept'],
  position: ['position', 'role', 'designation', 'post'],
  wing: ['wing', 'wing name', 'team', 'division', 'segment'],
  session: ['session', 'session label'],
  batch: ['batch', 'year'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'contact'],
  studentId: ['student id', 'studentid', 'id', 'cu id'],
  imageUrl: ['image_url', 'image url', 'image', 'photo', 'photo url', 'photo_url'],
  achievements: ['achievements', 'achievement'],
  contribution: ['contribution', 'contributions', 'contribution summary'],
  gamesPlayed: ['games played', 'games', 'games_played', 'game'],
};

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function normalizeHeader(value) {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function splitList(value) {
  if (!value.trim()) return [];
  return value
    .split(/[;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value, max) {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseMemberCsv(text) {
  const table = parseCsv(text);
  const result = { rows: [], invalid: [] };
  if (table.length < 2) return result;

  const headerRow = table[0].map(normalizeHeader);
  const index = {};

  Object.keys(HEADER_ALIASES).forEach((field) => {
    const position = headerRow.findIndex((header) => HEADER_ALIASES[field].includes(header));
    if (position !== -1) index[field] = position;
  });

  if (index.name === undefined) {
    result.invalid.push({ line: 1, name: '', reason: 'Missing a "Name" column.' });
    return result;
  }

  const cell = (row, field) => {
    const position = index[field];
    return position === undefined ? '' : row[position] || '';
  };

  table.slice(1).forEach((row, i) => {
    const line = i + 2;
    const name = clean(cell(row, 'name'), 120);
    if (!name) {
      result.invalid.push({ line, name: '', reason: 'Empty name.' });
      return;
    }

    result.rows.push({
      name,
      department: clean(cell(row, 'department'), 80),
      position: clean(cell(row, 'position'), 80),
      wing: clean(cell(row, 'wing'), 80),
      session: clean(cell(row, 'session'), 40),
      batch: clean(cell(row, 'batch'), 40),
      email: clean(cell(row, 'email'), 160).toLowerCase(),
      phone: clean(cell(row, 'phone'), 40),
      studentId: clean(cell(row, 'studentId'), 40),
      imageUrl: clean(cell(row, 'imageUrl'), 500),
      achievements: splitList(cell(row, 'achievements')).slice(0, 20),
      contribution: clean(cell(row, 'contribution'), 800),
      gamesPlayed: splitList(cell(row, 'gamesPlayed')).slice(0, 10),
    });
  });

  return result;
}
