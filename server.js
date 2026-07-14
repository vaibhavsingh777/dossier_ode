require("dotenv").config();
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const path = require("path");
// const sqlite3 = require('sqlite3').verbose(); // Uncomment when linking your supplier DB

const app = express();
const PORT = process.env.PORT || 3000;

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
      maxAge: 24 * 60 * 60 * 1000,
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

app.get("/api/dossier", requireAuth, async (req, res) => {
  const cas = req.query.cas;
  if (!cas) return res.status(400).json({ error: "CAS number is required" });

  try {
    // --- 1. COMMERCIAL & REGULATORY DATA (SQLite DB) ---
    // This is where you connect to your aggregated supplier database.
    // For now, these default to an empty object if not connected.

    /* Example SQLite query:
    const dbRecord = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM suppliers WHERE cas_no = ?", [cas], (err, row) => {
            if (err) reject(err);
            resolve(row || {});
        });
    });
    */
    const dbRecord = {}; // Replace with your actual SQLite response object

    // --- 2. SCIENTIFIC DATA (PubChem API via Parallel Fetching) ---
    let pubChemData = pubchemCache.get(cas);

    if (!pubChemData) {
      pubChemData = {
        chemical_name: "N/A",
        iupac_name: "N/A",
        molecular_formula: "N/A",
        molecular_weight: "N/A",
        synonyms: "N/A",
        structure: "N/A",
        isomeric_structure: "N/A",
        has_defined_stereochemistry: "N/A",
        structure_image: "N/A",
        reactivity: "N/A",
        appearance: "N/A",
      };

      try {
        // Step A: Convert CAS to CID (Must execute first)
        const cidRes = await fetch(
          `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${cas}/cids/JSON`,
        );

        if (cidRes.ok) {
          const cidData = await cidRes.json();
          const cid = cidData.IdentifierList.CID[0];
          pubChemData.structure_image = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG`;

          // Trigger Steps B, C, and D concurrently for maximum compilation speed
          const [propRes, synRes, viewRes] = await Promise.all([
            fetch(
              `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,CanonicalSMILES,IsomericSMILES,IUPACName,Title/JSON`,
            ),
            fetch(
              `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`,
            ),
            fetch(
              `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON/`,
            ),
          ]);

          if (propRes.ok) {
            const propData = await propRes.json();
            const props = propData.PropertyTable.Properties[0];
            pubChemData.chemical_name = props.Title || "N/A";
            pubChemData.iupac_name = props.IUPACName || "N/A";
            pubChemData.molecular_formula = props.MolecularFormula || "N/A";
            pubChemData.molecular_weight = props.MolecularWeight
              ? String(props.MolecularWeight)
              : "N/A";
            pubChemData.structure = props.CanonicalSMILES || "N/A";
            pubChemData.isomeric_structure = props.IsomericSMILES || "N/A";
            pubChemData.has_defined_stereochemistry =
              props.IsomericSMILES !== props.CanonicalSMILES ? "Yes" : "No";
          }

          if (synRes.ok) {
            const synData = await synRes.json();
            const synonyms =
              synData.InformationList.Information[0].Synonym || [];
            pubChemData.synonyms = synonyms.slice(0, 10).join("; ") || "N/A";
          }

          // Fixed logic to safely extract Appearance & Reactivity
          if (viewRes.ok) {
            const viewData = await viewRes.json();
            const sections = viewData.Record?.Section || [];

            const extractSectionValue = (parentHeading, targetHeading) => {
              try {
                const parentNode = sections.find(
                  (s) => s.TOCHeading === parentHeading,
                );
                if (!parentNode || !parentNode.Section) return "N/A";
                const targetNode = parentNode.Section.find(
                  (s) => s.TOCHeading === targetHeading,
                );
                if (
                  targetNode &&
                  targetNode.Information &&
                  targetNode.Information[0].Value.StringWithMarkup
                ) {
                  return targetNode.Information[0].Value.StringWithMarkup[0]
                    .String;
                }
              } catch (e) {}
              return "N/A";
            };

            pubChemData.appearance = extractSectionValue(
              "Chemical and Physical Properties",
              "Color/Form",
            );
            pubChemData.reactivity = extractSectionValue(
              "Safety and Hazards",
              "Reactivity Profile",
            );
          }
        }
        pubchemCache.set(cas, pubChemData);
      } catch (err) {
        console.error(`PubChem fetch failed for ${cas}:`, err);
      }
    }

    // --- 3. MERGE & RESPOND ---
    // Unnecessary variables have been stripped out.
    res.json({
      cas_no: cas,
      chemical_name: dbRecord.chemical_name || pubChemData.chemical_name,
      hsn_code: dbRecord.hsn_code || "N/A",
      iupac_name: pubChemData.iupac_name,
      appearance: dbRecord.appearance || pubChemData.appearance,
      molecular_formula: pubChemData.molecular_formula,
      molecular_weight: pubChemData.molecular_weight,
      hazard_class: dbRecord.hazard_class || "N/A",
      synonyms: pubChemData.synonyms,
      structure_image: pubChemData.structure_image,
      structure: pubChemData.structure,
      isomeric_structure: pubChemData.isomeric_structure,
      has_defined_stereochemistry: pubChemData.has_defined_stereochemistry,
      bis_license: dbRecord.bis_license || "N/A",
      scomet_status: dbRecord.scomet_status || "N/A",
      alcohol_poison_acid_license:
        dbRecord.alcohol_poison_acid_license || "N/A",
      gst_rate: dbRecord.gst_rate || "N/A",
      bcd_rate: dbRecord.bcd_rate || "N/A",
      anti_dumping_duty: dbRecord.anti_dumping_duty || "N/A",
      stabilizer_mentioned: dbRecord.stabilizer_mentioned || "N/A",
      reactivity: dbRecord.reactivity || pubChemData.reactivity,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "Internal Server Error fetching dossier data." });
  }
});

app.get("/", (req, res, next) => {
  if (!req.session.loggedIn) return res.redirect("/login.html");
  next();
});

app.listen(PORT, () => console.log(`Dossier app running on port ${PORT}`));
