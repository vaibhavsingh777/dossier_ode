require("dotenv").config();
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

// --- PUG-View JSON Helpers ---
// PubChem's PUG-View responses are deeply nested Section/Information trees.
// These helpers safely walk that tree to pull out the text a dossier needs.

// Recursively locate a section by its exact TOCHeading (e.g. "Color/Form", "GHS Classification").
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
// markup-only placeholders (e.g. GHS pictogram cells, whose "String" is just blank
// spaces because the real content is the icon URLs in Markup, not the text itself).
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

// GHS Classification is structured differently from simple headings: every contributing
// source (ECHA, NITE, HSDB, Safe Work Australia, etc.) shares the same "GHS Classification"
// heading, and each source's rows (Pictogram(s) / Signal / GHS Hazard Statements /
// Precautionary Statement Codes) share one ReferenceNumber. A plain "first Information
// item" grab (like findPubChemText above) mostly returns the Pictogram(s) row, whose text
// is blank space - which is why hazard_class was coming through empty. Instead, group by
// ReferenceNumber, take the first source (this matches what PubChem's own UI shows by
// default - see "ShowAtMost: 1" in the section's DisplayControls), and pull that source's
// Signal + GHS Hazard Statements specifically.
function findGHSHazardClass(node) {
  const section = findPubChemSection(node, "GHS Classification");
  if (!section || !Array.isArray(section.Information)) return null;

  const firstReferenceNumber = section.Information[0]?.ReferenceNumber;
  const primarySource = section.Information.filter(
    (info) => info.ReferenceNumber === firstReferenceNumber,
  );

  const signal = extractInfoEntries(
    primarySource.filter((info) => info.Name === "Signal"),
  )[0]?.text;

  const hazardStatements = extractInfoEntries(
    primarySource.filter((info) => info.Name === "GHS Hazard Statements"),
  )[0]?.text;

  if (!hazardStatements) return null;
  return signal ? `${signal} - ${hazardStatements}` : hazardStatements;
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
        hazard_class: "-",
        reactivity: "-",
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
          // 2C: PUG-VIEW for rich text (Hazards, Appearance, Reactivity)
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
            pubChemData.synonyms = synonyms.slice(0, 12).join("; ") || "-";
          }

          // Process PUG-View Text Data (Hazards, Appearance)
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

            // GHS Classification is the primary, structured source for hazard class.
            // Some records only carry the simpler "Hazard Classes and Categories"
            // heading instead, so that's kept as a fallback.
            const ghsHazards = findGHSHazardClass(rootNode);
            const generalHazards = findPubChemText(
              rootNode,
              "Hazard Classes and Categories",
            );
            pubChemData.hazard_class = ghsHazards || generalHazards || "-";
          }
        }

        // Save successfully fetched data to cache
        pubchemCache.set(cas, pubChemData);
      } catch (err) {
        console.error(`PubChem fetch sequence failed for CAS ${cas}:`, err);
      }
    }

    // --- 3. Format the response for your dossier.js UI ---
    // Scientific data is powered by PubChem.
    // Commercial data defaults to a placeholder to prevent frontend crashing.
    const responseData = {
      cas_no: cas,
      chemical_name: pubChemData.chemical_name,
      iupac_name: pubChemData.iupac_name,
      appearance: pubChemData.appearance,
      molecular_formula: pubChemData.molecular_formula,
      molecular_weight: pubChemData.molecular_weight,
      hazard_class: pubChemData.hazard_class,
      synonyms: pubChemData.synonyms,
      structure_image: pubChemData.structure_image,
      structure: pubChemData.structure,
      isomeric_structure: pubChemData.isomeric_structure,
      has_defined_stereochemistry: pubChemData.has_defined_stereochemistry,
      reactivity: pubChemData.reactivity,

      // Commercial / Indian Taxonomy (not available from PubChem - to be sourced separately)
      hsn_code: "-",
      bis_license: "-",
      scomet_status: "-",
      alcohol_poison_acid_license: "-",
      gst_rate: "-",
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
