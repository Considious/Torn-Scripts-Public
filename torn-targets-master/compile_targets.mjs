import fs from "node:fs/promises";
import path from "node:path";

const NETGANGSTER_URL = "https://torn.netgangster.com/Targets.html";
const FORUM_URL =
  "https://www.torn.com/forums.php#/p=threads&f=61&t=16280317&b=0&a=0";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function asInteger(value) {
  const cleaned = String(value ?? "").replaceAll(",", "").trim();
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function splitPipe(value) {
  return String(value ?? "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function nameKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, headers) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function extractJsonAssignment(script, variableName) {
  const marker = `const ${variableName}`;
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${variableName} in page`);
  const equalsIndex = script.indexOf("=", markerIndex + marker.length);
  const start = script.indexOf("[", equalsIndex + 1);
  if (start < 0) throw new Error(`Could not find ${variableName} array`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const char = script[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(script.slice(start, i + 1));
    }
  }
  throw new Error(`Unterminated ${variableName} array`);
}

async function loadCompiledCsv(filePath) {
  const csvText = await fs.readFile(filePath, "utf8");
  const values = parseCsv(csvText);
  const headers = values[0].map((value) =>
    String(value ?? "").replace(/^\uFEFF/, "").trim(),
  );

  return values.slice(1).map((cells) =>
    Object.fromEntries(
      headers.map((header, index) => [header, cells[index] ?? ""]),
    ),
  );
}

function parseForumText(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const rows = [];
  let band = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^Targets under 1000/i.test(line)) {
      band = "under 1,000";
      continue;
    }
    if (/^Targets 1000-10000/i.test(line)) {
      band = "1,000-10,000";
      continue;
    }
    if (/^Targets 10k-100k/i.test(line)) {
      band = "10,000-100,000";
      continue;
    }

    const tabCells = lines[index].split("\t").map((cell) => cell.trim());
    if (
      tabCells.length >= 4 &&
      !/^Username$/i.test(tabCells[0]) &&
      tabCells[0] &&
      asInteger(tabCells[1]) !== null &&
      asInteger(tabCells[2]) !== null &&
      asInteger(tabCells[3]) !== null
    ) {
      rows.push({
        username: tabCells[0],
        level: asInteger(tabCells[1]),
        estimate: asInteger(tabCells[2]),
        maxLife: asInteger(tabCells[3]),
        band,
      });
      continue;
    }

    if (
      line &&
      !line.includes("\t") &&
      asInteger(line) === null &&
      index + 3 < lines.length &&
      asInteger(lines[index + 1]) !== null &&
      asInteger(lines[index + 2]) !== null &&
      asInteger(lines[index + 3]) !== null
    ) {
      rows.push({
        username: line,
        level: asInteger(lines[index + 1]),
        estimate: asInteger(lines[index + 2]),
        maxLife: asInteger(lines[index + 3]),
        band,
      });
      index += 3;
    }
  }

  const unique = new Map();
  for (const row of rows) {
    unique.set(
      `${nameKey(row.username)}|${row.level}|${row.estimate}|${row.maxLife}`,
      row,
    );
  }
  return [...unique.values()];
}

async function fetchNetGangster(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "torn-target-master/1.0 (+private personal data compiler)",
    },
  });
  if (!response.ok) {
    throw new Error(`NetGangster returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1],
  );
  const dataScript = scripts.find(
    (script) => script.includes("const ALL_PLAYERS") && script.includes("const LIST_IDS"),
  );
  if (!dataScript) throw new Error("NetGangster embedded target data was not found");

  const players = extractJsonAssignment(dataScript, "ALL_PLAYERS");
  const listIds = extractJsonAssignment(dataScript, "LIST_IDS");
  const listById = new Map();
  listIds.forEach((ids, index) => {
    for (const id of ids) listById.set(Number(id), index + 1);
  });
  return { players, listIds, listById };
}

function createRecord({ id = null, username = "" } = {}) {
  return {
    id,
    username,
    levels: new Set(),
    sources: new Set(),
    sourceUrls: new Set(),
    netGangsterLists: new Set(),
    forumBands: new Set(),
    maxLifeValues: new Set(),
    estimates: new Map(),
    componentCandidates: [],
  };
}

function addEstimate(record, estimate, source, components = null) {
  if (estimate === null || estimate === undefined) return;
  if (!record.estimates.has(estimate)) record.estimates.set(estimate, new Set());
  record.estimates.get(estimate).add(source);
  if (components) {
    record.componentCandidates.push({
      estimate,
      source,
      strength: asInteger(components.strength),
      defense: asInteger(components.defense),
      speed: asInteger(components.speed),
      dexterity: asInteger(components.dexterity),
    });
  }
}

const cli = parseArgs(process.argv.slice(2));
if (!cli.compiled || !cli.forum || !cli.output) {
  throw new Error(
    "Usage: node compile_targets.mjs --compiled input.csv --forum forum.txt --output master.csv",
  );
}

const [compiledRows, forumText, netGangster] = await Promise.all([
  loadCompiledCsv(cli.compiled),
  fs.readFile(cli.forum, "utf8"),
  fetchNetGangster(cli["netgangster-url"] || NETGANGSTER_URL),
]);
const forumRows = parseForumText(forumText);

const records = new Map();
const idToKey = new Map();
const usernameToKey = new Map();

function getRecord(id, username) {
  const numericId = asInteger(id);
  const normalizedName = nameKey(username);
  let key = numericId ? idToKey.get(numericId) : null;
  if (!key && normalizedName) key = usernameToKey.get(normalizedName);
  if (!key) {
    key = numericId ? `id:${numericId}` : `name:${normalizedName}`;
    records.set(key, createRecord({ id: numericId, username: String(username).trim() }));
  }

  const record = records.get(key);
  if (numericId && !record.id) {
    records.delete(key);
    key = `id:${numericId}`;
    record.id = numericId;
    records.set(key, record);
  }
  if (numericId) idToKey.set(numericId, key);
  if (normalizedName) usernameToKey.set(normalizedName, key);
  if (username && !record.username) record.username = String(username).trim();
  return record;
}

for (const row of compiledRows) {
  const record = getRecord(row.player_id, row.username);
  if (row.username) record.username = String(row.username).trim();
  const level = asInteger(row.level);
  if (level !== null) record.levels.add(level);
  splitPipe(row.sources).forEach((source) => record.sources.add(source));
  splitPipe(row.source_urls).forEach((url) => record.sourceUrls.add(url));

  const compiledEstimate = asInteger(row.estimated_total_stats);
  addEstimate(record, compiledEstimate, "Compiled input", {
    strength: row.strength,
    defense: row.defense,
    speed: row.speed,
    dexterity: row.dexterity,
  });
  splitPipe(row.alternate_estimates)
    .map(asInteger)
    .filter((value) => value !== null)
    .forEach((estimate) => addEstimate(record, estimate, "Compiled input alternate"));
}

for (const player of netGangster.players) {
  const id = asInteger(player.id);
  const record = getRecord(id, player.name);
  record.username = String(player.name).trim();
  const level = asInteger(player.level);
  if (level !== null) record.levels.add(level);
  const listNumber = netGangster.listById.get(id);
  const source = `Net Gangster Legacy List ${listNumber}`;
  record.sources.add(source);
  record.sourceUrls.add(NETGANGSTER_URL);
  record.netGangsterLists.add(listNumber);
  addEstimate(record, asInteger(player.total), source, {
    strength: player.str,
    defense: player.def,
    speed: player.spd,
    dexterity: player.dex,
  });
}

for (const forumRow of forumRows) {
  const record = getRecord(null, forumRow.username);
  if (!record.username) record.username = forumRow.username;
  record.levels.add(forumRow.level);
  record.sources.add("Just Another Hitlist");
  record.sourceUrls.add(FORUM_URL);
  record.forumBands.add(forumRow.band);
  record.maxLifeValues.add(forumRow.maxLife);
  addEstimate(record, forumRow.estimate, "Just Another Hitlist");
}

const outputRows = [...records.values()].map((record) => {
  const estimates = [...record.estimates.keys()].sort((a, b) => a - b);
  const selectedEstimate = estimates.at(-1) ?? null;
  const minimumEstimate = estimates[0] ?? null;
  const selectedComponents = record.componentCandidates
    .filter((candidate) => candidate.estimate === selectedEstimate)
    .at(-1);
  const estimateDetails = estimates
    .map((estimate) => {
      const sources = [...record.estimates.get(estimate)].sort().join(" + ");
      return `${estimate} [${sources}]`;
    })
    .join("; ");
  const id = record.id;
  const profileUrl = id
    ? `https://www.torn.com/profiles.php?XID=${id}`
    : `https://www.torn.com/profiles.php?NID=${encodeURIComponent(record.username)}`;

  return {
    player_id: id ?? "",
    username: record.username,
    level: record.levels.size ? Math.max(...record.levels) : "",
    estimated_total_stats: selectedEstimate ?? "",
    strength: selectedComponents?.strength ?? "",
    defense: selectedComponents?.defense ?? "",
    speed: selectedComponents?.speed ?? "",
    dexterity: selectedComponents?.dexterity ?? "",
    component_stats_total: selectedComponents?.estimate ?? "",
    max_life: record.maxLifeValues.size
      ? Math.max(...record.maxLifeValues)
      : "",
    source_count: record.sources.size,
    sources: [...record.sources].sort().join(" | "),
    netgangster_lists: [...record.netGangsterLists]
      .sort((a, b) => a - b)
      .join(" | "),
    forum_stat_band: [...record.forumBands].filter(Boolean).sort().join(" | "),
    estimate_conflict_over_20pct:
      estimates.length > 1 && minimumEstimate > 0
        ? selectedEstimate / minimumEstimate > 1.2
        : false,
    alternate_estimates: estimates.length > 1 ? estimates.join(" | ") : "",
    estimate_details: estimateDetails,
    profile_url: profileUrl,
    attack_url: id
      ? `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`
      : "",
    source_urls: [...record.sourceUrls].sort().join(" | "),
  };
});

outputRows.sort(
  (a, b) =>
    Number(b.level || 0) - Number(a.level || 0) ||
    Number(a.estimated_total_stats || Number.MAX_SAFE_INTEGER) -
      Number(b.estimated_total_stats || Number.MAX_SAFE_INTEGER) ||
    a.username.localeCompare(b.username),
);

const headers = [
  "player_id",
  "username",
  "level",
  "estimated_total_stats",
  "strength",
  "defense",
  "speed",
  "dexterity",
  "component_stats_total",
  "max_life",
  "source_count",
  "sources",
  "netgangster_lists",
  "forum_stat_band",
  "estimate_conflict_over_20pct",
  "alternate_estimates",
  "estimate_details",
  "profile_url",
  "attack_url",
  "source_urls",
];

await fs.mkdir(path.dirname(cli.output), { recursive: true });
await fs.writeFile(cli.output, toCsv(outputRows, headers), "utf8");

console.log(
  JSON.stringify(
    {
      compiledRows: compiledRows.length,
      forumRows: forumRows.length,
      netGangsterPlayers: netGangster.players.length,
      netGangsterLists: netGangster.listIds.length,
      outputRows: outputRows.length,
      rowsWithId: outputRows.filter((row) => row.player_id).length,
      forumOnlyWithoutId: outputRows.filter(
        (row) =>
          !row.player_id && row.sources.split(" | ").includes("Just Another Hitlist"),
      ).length,
      conflicts: outputRows.filter((row) => row.estimate_conflict_over_20pct).length,
      output: path.resolve(cli.output),
    },
    null,
    2,
  ),
);
