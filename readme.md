Here is a clear, structured summary of the data mapping and architecture in your application. You can copy and paste the block below directly into a new LLM session to give it immediate context on how your backend handles data compilation.

---

### 📋 Context Document: CAS Dossier App Data Architecture

**System Overview**
The application is a Node.js/Express backend that compiles a unified chemical dossier by fetching a user-provided CAS Registry Number. It aggregates data from two primary sources: a local JSON regulatory database and the external PubChem REST API.

#### 1. Data Mapping & Sources

**Source A: Local Regulatory Database (`data/regulatory.json`)**
This acts as the primary source of truth for Indian/local regulatory and taxation compliance. If a field exists here, it takes precedence.

- **Targeting Key:** `cas_no`
- **Identity & Appearance:** `chemical_name`_, `appearance_`
- **Trade & Taxation:** `hsn_code`, `hsn_matched_description`, `gst_rate`, `gst_matched_description`, `gst_rate_exception_note`, `bcd_rate`, `anti_dumping_duty`
- **Compliance & Licenses:** `bis_certifications` (Array of objects), `bis_license` (String fallback), `scomet_status`, `scomet_entry_code`, `scomet_caveat`, `alcohol_poison_acid_license`
- **Safety & Handling:** `hazard_class`, `reactivity`\*, `stabilizer_mentioned`

**Source B: PubChem REST API (NCBI)**
The backend dynamically queries PubChem using a multi-step fetch sequence based on the CAS number.

- **CID Resolution:** Hits the `/rest/pug/compound/name/{cas}/cids/JSON` endpoint to map the CAS to a PubChem CID.
- **Visual Assets:** \* `structure_image`: Direct URL to `/rest/pug/compound/cid/{cid}/PNG`
- **Basic Properties (PUG REST):**
- `chemical_name`\* (Mapped from `Title`)
- `iupac_name` (Mapped from `IUPACName`)
- `molecular_formula` (Mapped from `MolecularFormula`)
- `molecular_weight` (Mapped from `MolecularWeight`)
- `structure` (Mapped from `CanonicalSMILES`)
- `isomeric_structure` (Mapped from `IsomericSMILES`)
- `has_defined_stereochemistry` (Derived via strict equality check: `CanonicalSMILES !== IsomericSMILES`)

- **Synonyms (PUG REST):**
- `synonyms`: Array sliced to the top 10 results and joined into a string.

- **Extended Properties (PUG-View API):**
- `reactivity`\*: Extracted from "Reactivity Profile"
- `appearance`\*: Extracted from "Color/Form"

#### 2. The Merge Logic (Overrides)

The fields marked with an asterisk (\*) exist in both systems. The backend follows a **Local First** priority rule.

- `chemical_name`, `appearance`, and `reactivity` will use the value from `regulatory.json` if it exists.
- If the local value is null/missing, it falls back to the PubChem data.
- If both fail, it defaults to `"N/A"`.

---

### 🛠️ Developer Debugging Tips

If you are expanding this codebase, keep these specific architectural quirks in mind:

**1. Authentication & State Loss (The 401 Error)**

- **The Trap:** The app uses `express-session` with default memory storage. Because your `package.json` uses `node --watch server.js`, every file save restarts the server and completely wipes all active login sessions.
- **The Fix:** You will get sudden `401 Unauthorized` errors on the frontend after saving backend code. Either use a persistent session store (like Redis or SQLite) or temporarily disable the `requireAuth` middleware for development environments.

**2. Frontend Error Masking**

- **The Trap:** In `public/dossier.js`, the `catch (error)` block manually overrides _all_ failures with the hardcoded string: _"An unexpected interface dependency exception occurred..."_
- **The Fix:** During development, change line 68 in `dossier.js` to `resultsContainer.innerHTML = \`Error: ${error.message}`;` so you can see if the failure is a 401, a 500, or a network timeout.

**3. PubChem PUG-View Fragility**

- **The Trap:** The PUG-View JSON structure (Step D in `server.js`) is notoriously nested and inconsistent. The `extractSection` function uses a `try/catch` to parse it. If PubChem alters the string "Chemical and Physical Properties", this extraction will silently fail and return "N/A".
- **The Fix:** If Reactivity or Appearance start showing up blank for valid chemicals, log `viewData.Record.Section` to the console to verify PubChem hasn't changed their heading titles.

**4. `fetch` API Compatibility**

- **The Trap:** `server.js` uses the native `fetch` command.
- **The Fix:** Ensure your deployment environment is running **Node.js v18 or higher**. If you deploy this to an older Node v16 server, the `/api/dossier` route will instantly crash with a `ReferenceError`.
