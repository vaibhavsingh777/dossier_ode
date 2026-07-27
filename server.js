require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache to prevent spamming PubChem for the same chemical
const pubchemCache = new Map();

app.use(express.json());
app.use(express.static("public"));
app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-do-not-use-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    ok: false,
    error: "Too many login attempts. Please try again later.",
  },
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.SITE_USER &&
    password === process.env.SITE_PASS
  ) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Invalid credentials" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.status(401).json({ error: "Not authenticated" });
}

// --- HSN / GST Reference Data ---
// gst.csv and hsn.csv are loaded once at startup and kept in memory (they're small -
// ~4.4k and ~22k rows) so every dossier request just does an in-memory lookup instead
// of re-reading/re-parsing a CSV on every hit.

// Minimal RFC4180-style CSV parser (handles quoted fields containing commas/newlines,
// and "" as an escaped quote) - no external dependency needed for this.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // skip - normalized below via \n
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadCSVAsObjects(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = parseCSV(text);
  const headers = rows[0].map((h) => h.trim());
  const objects = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length === 1 && rows[i][0].trim() === "") continue; // trailing blank line
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (rows[i][idx] || "").trim();
    });
    objects.push(obj);
  }
  return objects;
}

let gstRows = [];
let hsnRows = [];
// Index of UPPERCASE description -> matching rows, for O(1) exact-match lookups.
let hsnByDescUpper = new Map();

try {
  gstRows = loadCSVAsObjects(path.join(__dirname, "gst.csv"));
  hsnRows = loadCSVAsObjects(path.join(__dirname, "hsn.csv"));

  for (const row of hsnRows) {
    const descUpper = (row.HSN_Description || "").toUpperCase().trim();
    if (!descUpper) continue;
    if (!hsnByDescUpper.has(descUpper)) hsnByDescUpper.set(descUpper, []);
    hsnByDescUpper.get(descUpper).push(row);
  }

  console.log(
    `Loaded HSN/GST reference data: ${gstRows.length} GST rows, ${hsnRows.length} HSN rows.`,
  );
} catch (err) {
  console.error(
    "Failed to load gst.csv / hsn.csv (place them next to server.js):",
    err.message,
  );
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Common American -> British spelling swaps. PubChem names/synonyms are American
// English; Indian HSN/GST tariff text is British English (SULPHUR not SULFUR,
// ALUMINIUM not ALUMINUM), so without this a lot of real matches get missed.
const BRITISH_SPELLING_MAP = [
  [/SULFUR/g, "SULPHUR"],
  [/SULFATE/g, "SULPHATE"],
  [/SULFIDE/g, "SULPHIDE"],
  [/SULFITE/g, "SULPHITE"],
  [/SULFONIC/g, "SULPHONIC"],
  [/ALUMINUM/g, "ALUMINIUM"],
  [/CESIUM/g, "CAESIUM"],
];

function toBritishSpelling(upperStr) {
  let out = upperStr;
  for (const [from, to] of BRITISH_SPELLING_MAP) out = out.replace(from, to);
  return out;
}

// Among several matching HSN rows, prefer the most specific one - the longest
// (most granular) code, e.g. an 8-digit tariff item over its 4-digit heading.
function mostSpecific(matches) {
  return matches.reduce((best, cur) =>
    !best || cur.HSN_CD.length > best.HSN_CD.length ? cur : best,
  );
}

// Tier A: search term is an exact (whole-string) match for an HSN description.
// High confidence - this is the one we want whenever it's available.
function findHsnMatchExact(searchTerm) {
  const upper = (searchTerm || "").toUpperCase().trim();
  if (!upper) return null;
  const matches = hsnByDescUpper.get(upper);
  return matches ? mostSpecific(matches) : null;
}

// Tier B: search term appears anywhere in the description as a whole word (e.g.
// "BENZENE" would match "BENZENE, PURE" but not "DICHLOROBENZENE"). Lower confidence
// than an exact match - a derivative's name can also contain the base chemical's name
// as a whole word (e.g. "ethanol" inside "phenoxy ethanol") - so this is only used
// as a fallback when no exact match exists for any candidate name.
function findHsnMatchLoose(searchTerm) {
  const upper = (searchTerm || "").toUpperCase().trim();
  if (!upper) return null;
  const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(upper)}\\b`);
  const matches = hsnRows.filter((row) =>
    wordBoundaryRegex.test((row.HSN_Description || "").toUpperCase()),
  );
  return matches.length ? mostSpecific(matches) : null;
}

// Given an HSN code, find its GST rate from gst.csv. gst.csv is mostly organised at
// the 4-digit heading level rather than full 8-digit tariff items, so we try an exact
// code match first, then fall back to the 4-digit heading, then the 2-digit chapter.
function findGstRate(hsnCode) {
  if (!hsnCode) return null;
  const heading4 = hsnCode.slice(0, 4);
  const chapter2 = hsnCode.slice(0, 2);

  const exactRow = gstRows.find((row) =>
    (row["Corresponding HSN Code"] || "")
      .split(",")
      .map((c) => c.trim())
      .includes(hsnCode),
  );
  if (exactRow) return exactRow["GST Rate"];

  const headingRow = gstRows.find((row) => {
    const codes = (row["Corresponding HSN Code"] || "")
      .split(",")
      .map((c) => c.trim());
    return (
      codes.some((c) => c.startsWith(heading4)) || row["GST Code"] === heading4
    );
  });
  if (headingRow) return headingRow["GST Rate"];

  const chapterRow = gstRows.find(
    (row) =>
      (row["Corresponding HSN Code"] || "").trim() === chapter2 ||
      row["GST Code"] === chapter2,
  );
  if (chapterRow) return chapterRow["GST Rate"];

  return null;
}

// Main entry point: given the chemical's name (and PubChem's synonym list as a
// "; "-joined string), find the best HSN code + GST rate we can. Tries the chemical
// name first, then each synonym, then British-spelling variants of each - exact
// matches across all candidates before ever falling back to the looser whole-word
// match.
function lookupHsnAndGst(chemicalName, synonymsStr) {
  const synonymList =
    synonymsStr && synonymsStr !== "-"
      ? synonymsStr.split(";").map((s) => s.trim())
      : [];
  const rawCandidates = [chemicalName, ...synonymList].filter(
    (c) => c && c !== "-",
  );

  const candidates = [];
  for (const c of rawCandidates) {
    candidates.push(c);
    const british = toBritishSpelling(c.toUpperCase());
    if (british !== c.toUpperCase()) candidates.push(british);
  }

  let match = null;
  for (const c of candidates) {
    match = findHsnMatchExact(c);
    if (match) break;
  }
  if (!match) {
    for (const c of candidates) {
      match = findHsnMatchLoose(c);
      if (match) break;
    }
  }

  if (!match) return { hsn_code: "-", gst_rate: "-" };

  const rate = findGstRate(match.HSN_CD);
  const validRate = rate && rate !== "" && rate !== "?" ? rate : "-";
  return { hsn_code: match.HSN_CD, gst_rate: validRate };
}

// --- Synonym Filtering ---
// PubChem's synonym lists mix real chemical/trade names in with a lot of database
// bookkeeping IDs - CAS numbers, InChIKeys, DTXSID/DTXCID, SCHEMBL, NSC, source:id
// tags, etc. Traders don't want to see those on a dossier, so they're stripped out
// before display. Two layers, in order:
//   1. An explicit regex blocklist for known ID formats. These patterns are narrow
//      enough that they will never accidentally match a real chemical name, so
//      anything caught here is dropped with full confidence.
//   2. A conservative structural heuristic as a fallback safety net, for ID formats
//      not covered above (new source databases, etc). It only rejects strings that
//      have NO space, NO lowercase letter, AND are more than ~30% digits - real
//      chemical/trade names almost always fail at least one of those conditions, so
//      this stays a low false-positive check rather than a trigger-happy one.
// Anything the heuristic rejects is logged separately from the blocklist so new ID
// formats can be promoted into the explicit blocklist over time.
const SYNONYM_BLOCKLIST_PATTERNS = [
  /^\d{2,7}-\d{2}-\d$/, // CAS number, e.g. 626-32-4
  /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/, // InChIKey, e.g. HPJKLCJJNFVOEM-UHFFFAOYSA-N
  /^DTX(SID|CID)\d+$/i, // DTXSID / DTXCID
  /^SCHEMBL\d+$/i, // SCHEMBL registry IDs
  /^NSC-?\d+$/i, // NSC / NSC-#### registry IDs
  /:/, // colon-prefixed source tags, e.g. RefChem:1052567
];

function isKnownJunkSynonym(term) {
  return SYNONYM_BLOCKLIST_PATTERNS.some((pattern) => pattern.test(term));
}

// Fallback for ID formats not covered by the explicit blocklist above.
function looksLikeUnknownId(term) {
  const hasSpace = /\s/.test(term);
  const hasLower = /[a-z]/.test(term);
  if (hasSpace || hasLower) return false; // real names/trade names almost always have one of these

  const digitCount = (term.match(/\d/g) || []).length;
  const isMostlyDigits = digitCount / term.length > 0.3;
  return isMostlyDigits;
}

// Filters a raw PubChem synonym array down to the ones worth showing a trader.
function cleanSynonyms(synonymList) {
  const kept = [];
  for (const raw of synonymList) {
    const term = (raw || "").trim();
    if (!term) continue;

    if (isKnownJunkSynonym(term)) continue;

    if (looksLikeUnknownId(term)) {
      console.log(
        `Synonym filter: heuristic rejected "${term}" (not yet in explicit blocklist)`,
      );
      continue;
    }

    kept.push(term);
  }
  return kept;
}

// --- PUG-View JSON Helpers ---
// PubChem's PUG-View responses are deeply nested Section/Information trees.
// These helpers safely walk that tree to pull out the text a dossier needs.

// Recursively locate a section by its exact TOCHeading (e.g. "Color/Form", "Reactivity Profile").
function findPubChemSection(node, targetHeading) {
  if (!node) return null;
  if (node.TOCHeading === targetHeading) return node;

  if (node.Section) {
    for (const child of node.Section) {
      const found = findPubChemSection(child, targetHeading);
      if (found) return found;
    }
  }
  return null;
}

// Flattens a section's Information[] array into readable text per entry, skipping
// markup-only placeholders whose "String" is just blank spaces because the real
// content lives elsewhere (e.g. in Markup) rather than in the text itself.
function extractInfoEntries(informationArray) {
  if (!Array.isArray(informationArray)) return [];

  return informationArray
    .map((info) => {
      const strings = (info?.Value?.StringWithMarkup || [])
        .map((s) => (s?.String || "").trim())
        .filter((s) => s.length > 0);
      return {
        referenceNumber: info.ReferenceNumber,
        name: info.Name || null,
        text: strings.join("; "),
      };
    })
    .filter((entry) => entry.text.length > 0);
}

// Generic "first useful sentence" lookup for simple, single-value headings
// (Color/Form, Physical Description, Reactivity Profile, etc).
function findPubChemText(node, targetHeading) {
  const section = findPubChemSection(node, targetHeading);
  if (!section) return null;

  const entries = extractInfoEntries(section.Information);
  return entries.length ? entries[0].text : null;
}

// --- Dynamic Dossier API Route ---
app.get("/api/dossier", requireAuth, async (req, res) => {
  const cas = req.query.cas;
  if (!cas) return res.status(400).json({ error: "CAS number is required" });

  try {
    let pubChemData = pubchemCache.get(cas);

    // If not in cache, fetch EVERYTHING directly from PubChem
    if (!pubChemData) {
      pubChemData = {
        chemical_name: "-",
        iupac_name: "-",
        molecular_formula: "-",
        molecular_weight: "-",
        structure: "-",
        isomeric_structure: "-",
        has_defined_stereochemistry: "-",
        structure_image: "-",
        synonyms: "-",
        appearance: "-",
        reactivity: "-",
        hsn_code: "-",
        gst_rate: "-",
      };

      try {
        // Step 1: Resolve CAS to PubChem CID
        const cidRes = await fetch(
          `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${cas}/cids/JSON`,
        );

        if (cidRes.ok) {
          const cidData = await cidRes.json();
          const cid = cidData.IdentifierList.CID[0];

          pubChemData.structure_image = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG`;

          // Step 2: Parallel Fetching for Maximum Speed
          // 2A: PUG-REST for strict chemical properties (SMILES, Weight, Formula)
          // 2B: PUG-REST for Synonyms
          // 2C: PUG-VIEW for rich text (Appearance, Reactivity)
          const [propRes, synRes, viewRes] = await Promise.all([
            fetch(
              `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,IUPACName,Title,SMILES,ConnectivitySMILES/JSON`,
            ),
            fetch(
              `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`,
            ),
            fetch(
              `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON/`,
            ),
          ]);

          // Process Properties (SMILES)
          if (propRes.ok) {
            const propData = await propRes.json();
            const props = propData.PropertyTable.Properties[0];

            pubChemData.chemical_name = props.Title || "-";
            pubChemData.iupac_name = props.IUPACName || "-";
            pubChemData.molecular_formula = props.MolecularFormula || "-";
            pubChemData.molecular_weight = props.MolecularWeight
              ? String(props.MolecularWeight)
              : "-";

            // NOTE: PubChem retired the "CanonicalSMILES"/"IsomericSMILES" response keys.
            // Those names still work as REQUEST parameters, but the JSON now comes back
            // under "ConnectivitySMILES" (no stereochemistry) and "SMILES" (isomeric, with
            // stereochemistry) instead - this was why structure/isomeric_structure always
            // fell back to "-". We request the current names directly and read them back.
            pubChemData.structure = props.ConnectivitySMILES || "-";
            pubChemData.isomeric_structure = props.SMILES || "-";
            pubChemData.has_defined_stereochemistry =
              props.SMILES &&
              props.ConnectivitySMILES &&
              props.SMILES !== props.ConnectivitySMILES
                ? "Yes"
                : "No";
          }

          // Process Synonyms
          if (synRes.ok) {
            const synData = await synRes.json();
            const synonyms =
              synData.InformationList.Information[0].Synonym || [];
            const filteredSynonyms = cleanSynonyms(synonyms);
            pubChemData.synonyms =
              filteredSynonyms.slice(0, 12).join("; ") || "-";
          }

          // Process PUG-View Text Data (Appearance, Reactivity)
          if (viewRes.ok) {
            const viewData = await viewRes.json();
            const rootNode = viewData.Record;

            // "Physical Description" is a fallback for records that never got a
            // "Color/Form" entry (common for compounds sourced mainly from EPA/CompTox
            // rather than HSDB/ChemIDplus).
            pubChemData.appearance =
              findPubChemText(rootNode, "Color/Form") ||
              findPubChemText(rootNode, "Physical Description") ||
              "-";
            pubChemData.reactivity =
              findPubChemText(rootNode, "Reactivity Profile") || "-";
          }

          // Step 3: HSN code + GST rate, looked up locally from gst.csv/hsn.csv using
          // the chemical name (and its synonyms as a fallback) - not a PubChem field.
          const hsnGst = lookupHsnAndGst(
            pubChemData.chemical_name,
            pubChemData.synonyms,
          );
          pubChemData.hsn_code = hsnGst.hsn_code;
          pubChemData.gst_rate = hsnGst.gst_rate;
        }

        // Save successfully fetched data to cache
        pubchemCache.set(cas, pubChemData);
      } catch (err) {
        console.error(`PubChem fetch sequence failed for CAS ${cas}:`, err);
      }
    }

    // --- 3. Format the response for your dossier.js UI ---
    // Scientific data is powered by PubChem. HSN/GST come from the local
    // gst.csv/hsn.csv reference files. Remaining commercial/Indian-taxonomy fields
    // default to a placeholder to prevent frontend crashing.
    const responseData = {
      cas_no: cas,
      chemical_name: pubChemData.chemical_name,
      iupac_name: pubChemData.iupac_name,
      appearance: pubChemData.appearance,
      molecular_formula: pubChemData.molecular_formula,
      molecular_weight: pubChemData.molecular_weight,
      synonyms: pubChemData.synonyms,
      structure_image: pubChemData.structure_image,
      structure: pubChemData.structure,
      isomeric_structure: pubChemData.isomeric_structure,
      has_defined_stereochemistry: pubChemData.has_defined_stereochemistry,
      reactivity: pubChemData.reactivity,

      // HSN code + GST rate: looked up locally from gst.csv / hsn.csv
      hsn_code: pubChemData.hsn_code,
      gst_rate: pubChemData.gst_rate,

      // Remaining commercial / Indian Taxonomy (not available from PubChem or the
      // local CSVs - to be sourced separately)
      bis_license: "-",
      scomet_status: "-",
      alcohol_poison_acid_license: "-",
      bcd_rate: "-",
      anti_dumping_duty: "-",
      stabilizer_mentioned: "-",
    };

    res.json(responseData);
  } catch (error) {
    console.error("Dossier Compilation Error:", error);
    res
      .status(500)
      .json({ error: "Internal Server Error fetching dynamic dossier data." });
  }
});

app.get("/", (req, res, next) => {
  if (!req.session.loggedIn) return res.redirect("/login.html");
  next();
});

app.listen(PORT, () =>
  console.log(`Dossier app running dynamically on port ${PORT}`),
);
