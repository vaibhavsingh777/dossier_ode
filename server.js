require("dotenv").config();
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache for PubChem lookups (cleared on server restart)
const pubchemCache = new Map();

app.use(express.json());
app.use(express.static("public"));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-do-not-use-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // Requires HTTPS in prod
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

// Rate limiter for login (max 10 requests per 15 minutes per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    ok: false,
    error: "Too many login attempts. Please try again later.",
  },
});

// --- Auth Routes ---
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

// --- Dossier API Route ---
app.get("/api/dossier", requireAuth, async (req, res) => {
  const cas = req.query.cas;
  if (!cas) return res.status(400).json({ error: "CAS number is required" });

  try {
    // 1. Fetch Local Regulatory Data
    const regDataPath = path.join(__dirname, "data", "regulatory.json");
    let regDataList = [];
    if (fs.existsSync(regDataPath)) {
      regDataList = JSON.parse(fs.readFileSync(regDataPath, "utf8"));
    }
    // Find matching regulatory record, or default to an empty object
    const regRecord = regDataList.find((r) => r.cas_no === cas) || {};

    // 2. Fetch PubChem Data (Check cache first)
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
        // Step A: Get CID from CAS
        const cidRes = await fetch(
          `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${cas}/cids/JSON`,
        );
        if (cidRes.ok) {
          const cidData = await cidRes.json();
          const cid = cidData.IdentifierList.CID[0];

          pubChemData.structure_image = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG`;

          // Step B: Fetch Basic Properties
          const propRes = await fetch(
            `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,CanonicalSMILES,IsomericSMILES,IUPACName,Title/JSON`,
          );
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

          // Step C: Fetch Synonyms
          const synRes = await fetch(
            `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`,
          );
          if (synRes.ok) {
            const synData = await synRes.json();
            const synonyms =
              synData.InformationList.Information[0].Synonym || [];
            pubChemData.synonyms = synonyms.slice(0, 10).join("; ") || "N/A"; // Limit to top 10
          }

          // Step D: Fetch PUG-View for Reactivity/Appearance (Gracefully fallback if missing)
          const viewRes = await fetch(
            `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON/`,
          );
          if (viewRes.ok) {
            const viewData = await viewRes.json();
            const extractSection = (heading) => {
              try {
                // Highly nested PubChem View JSON traversal
                const section = viewData.Record.Section.find(
                  (s) =>
                    s.TOCHeading === "Chemical and Physical Properties" ||
                    s.TOCHeading === "Safety and Hazards",
                );
                if (!section) return "N/A";
                const sub = section.Section.find(
                  (s) =>
                    s.TOCHeading === heading ||
                    s.TOCHeading === "Reactivity Profile",
                );
                if (
                  sub &&
                  sub.Information &&
                  sub.Information[0].Value.StringWithMarkup
                ) {
                  return sub.Information[0].Value.StringWithMarkup[0].String;
                }
              } catch (e) {}
              return "N/A";
            };
            pubChemData.reactivity = extractSection("Reactivity Profile");
            pubChemData.appearance = extractSection("Color/Form");
          }
        }

        pubchemCache.set(cas, pubChemData);
      } catch (err) {
        console.error(`PubChem fetch failed for ${cas}:`, err);
        // Continue with the default "N/A" PubChem values if network fails
      }
    }

    // 3. Merge and conform to exact frontend contract
    const responseData = {
      cas_no: cas,
      chemical_name: regRecord.chemical_name || pubChemData.chemical_name, // Override PubChem title with local if provided
      hsn_code: regRecord.hsn_code || "N/A",
      hsn_matched_description: regRecord.hsn_matched_description || "N/A",
      iupac_name: pubChemData.iupac_name,
      appearance: regRecord.appearance || pubChemData.appearance,
      molecular_formula: pubChemData.molecular_formula,
      molecular_weight: pubChemData.molecular_weight,
      hazard_class: regRecord.hazard_class || "N/A",
      synonyms: pubChemData.synonyms,
      structure_image: pubChemData.structure_image,
      structure: pubChemData.structure,
      isomeric_structure: pubChemData.isomeric_structure,
      has_defined_stereochemistry: pubChemData.has_defined_stereochemistry,
      bis_certifications: regRecord.bis_certifications || [],
      bis_license: regRecord.bis_license || "N/A",
      scomet_status: regRecord.scomet_status || "N/A",
      scomet_entry_code: regRecord.scomet_entry_code || "N/A",
      scomet_caveat: regRecord.scomet_caveat || "",
      alcohol_poison_acid_license:
        regRecord.alcohol_poison_acid_license || "N/A",
      gst_rate: regRecord.gst_rate || "N/A",
      gst_matched_description: regRecord.gst_matched_description || "N/A",
      gst_rate_exception_note: regRecord.gst_rate_exception_note || "N/A",
      bcd_rate: regRecord.bcd_rate || "N/A",
      anti_dumping_duty: regRecord.anti_dumping_duty || "N/A",
      stabilizer_mentioned: regRecord.stabilizer_mentioned || "N/A",
      reactivity: regRecord.reactivity || pubChemData.reactivity,
    };

    res.json(responseData);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "Internal Server Error fetching dossier data." });
  }
});

// Middleware to redirect unauthenticated users away from the main app
app.get("/", (req, res, next) => {
  if (!req.session.loggedIn) return res.redirect("/login.html");
  next();
});

app.listen(PORT, () => console.log(`Dossier app running on port ${PORT}`));
