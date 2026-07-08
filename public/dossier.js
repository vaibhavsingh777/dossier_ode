/**
 * dossier.js
 * Implements interactive chemical dossier tracking layouts, rendering a strict
 * 2-column document-style view showing ALL fields (empty if no data exists).
 */

document.addEventListener("DOMContentLoaded", () => {
  const dossierPageContainer = document.getElementById("page-dossier");
  if (dossierPageContainer) {
    dossierPageContainer.innerHTML = `
            <div class="dossier-wrapper">
                <div class="dossier-header-panel">
                    <h2>Chemical Info Dashboard</h2>
                    <p>Enter a valid CAS Registry Number to compile the dossier document.</p>
                </div>
                
                <div class="dossier-control-box">
                    <form id="dossier-search-form" class="dossier-search-form">
                        <div class="input-group">
                            <label for="cas-input">CAS Registry Number</label>
                            <input type="text" id="cas-input" placeholder="e.g., 13162-05-5" required />
                        </div>
                        <button type="submit" id="generate-dossier-btn" class="btn btn-primary">Generate Dossier</button>
                    </form>
                </div>

                <div id="dossier-results-section" class="dossier-results-section">
                </div>
            </div>
        `;
    initDossierDashboard();
  }
});

function initDossierDashboard() {
  const searchForm = document.getElementById("dossier-search-form");
  const casInput = document.getElementById("cas-input");
  const submitBtn = document.getElementById("generate-dossier-btn");
  const resultsContainer = document.getElementById("dossier-results-section");

  if (!searchForm || !casInput) return;

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const casNumber = casInput.value.trim();

    const casRegex = /^\d{2,7}-\d{2}-\d$/;
    if (!casRegex.test(casNumber)) {
      alert(
        "Please crosscheck format criteria: Enter a valid CAS Number (e.g., 13162-05-5).",
      );
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerText = "Compiling Datasets (This takes ~15s)...";
    resultsContainer.innerHTML =
      '<div class="loading-spinner-box"><p>Querying external registries and local databases...</p></div>';

    try {
      const response = await fetch(
        `/api/dossier?cas=${encodeURIComponent(casNumber)}`,
      );
      if (!response.ok) {
        throw new Error(
          `Server returned error code status: ${response.status}`,
        );
      }
      const data = await response.json();

      if (data && data.cas_no) {
        renderDocumentStyleDossier(data, resultsContainer);
      } else {
        resultsContainer.innerHTML = `<p class="error-msg">No structured profile metrics located for CAS: ${casNumber}</p>`;
      }
    } catch (error) {
      console.error("Error compiling requested dossier parameters:", error);
      resultsContainer.innerHTML = `<p class="error-msg">An unexpected interface dependency exception occurred while running analysis.</p>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = "Generate Dossier";
    }
  });
}

function formatAsList(str) {
  if (!str || str === "N/A") return "N/A";
  const items = str
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return "N/A";
  if (items.length === 1) return items[0];
  return `<ul class="dossier-list" style="margin: 0; padding-left: 20px;">${items.map((item) => `<li style="margin-bottom: 4px;">${item}</li>`).join("")}</ul>`;
}

/**
 * Renders the strictly dynamic dashboard layout with the color-coded cards,
 * parsing structure images, isomers, taxation, reactivity, and BIS.
 */
function renderDocumentStyleDossier(data, container) {
  container.innerHTML = "";

  // Helper function to handle empty fields gracefully
  const safeData = (val, placeholder = "N/A") =>
    val && val !== "N/A"
      ? val
      : `<span class="placeholder-text">${placeholder}</span>`;

  // Handle structure image logic securely with timestamp to bypass cache
  const timestamp = new Date().getTime();
  let imageHTML =
    data.structure_image && data.structure_image !== "N/A"
      ? `<a href="${data.structure_image}" target="_blank" style="display: block; text-align: center;">
            <img src="${data.structure_image}?t=${timestamp}" 
                 style="max-height: 180px; max-width: 100%; object-fit: contain; margin-bottom: 10px; border: 1px solid var(--dossier-cyan); padding: 4px; border-radius: 4px; background: white;" 
                 alt="Chemical Structure"/>
         </a>`
      : `<span class="placeholder-text">No structure image available</span><br><br>`;

  // Determine SCOMET Highlight Color (using palette Purple instead of red)
  const scometColor = data.scomet_entry_code !== "N/A" ? "danger-text" : "";

  // BIS rendering: the engine returns bis_certifications as an array of
  // {card_title, year, description} scraped from the BIS portal. Fall back
  // to a plain bis_license string if that's what's present instead (older
  // engine shape), so this doesn't silently show N/A either way.
  let bisHTML;
  if (
    Array.isArray(data.bis_certifications) &&
    data.bis_certifications.length > 0
  ) {
    bisHTML =
      `<ul style="margin: 4px 0 0 0; padding-left: 18px;">` +
      data.bis_certifications
        .map(
          (b) =>
            `<li style="margin-bottom:6px;"><strong>${b.card_title}</strong> (${b.year})<br><span class="subtext">${b.description}</span></li>`,
        )
        .join("") +
      `</ul>`;
  } else if (Array.isArray(data.bis_certifications)) {
    bisHTML = safeData(null, "No matching BIS specification found");
  } else {
    bisHTML = safeData(data.bis_license);
  }

  // Reactivity & Stabilizers (PubChem PUG-View reactivity/stability text)
  const reactivityHTML =
    data.reactivity && data.reactivity !== "N/A"
      ? data.reactivity.replace(/\. /g, ".<br>")
      : `<span class="placeholder-text">N/A</span>`;

  const dashboardHTML = `
    <div class="dashboard-wrapper">
      
      <div class="top-card">
        <div class="top-header">
          <div class="header-block">
            <span>${safeData(data.chemical_name, "Unknown Chemical")}</span>
          </div>
          <div class="header-block" style="text-align: center;">
            <span>HSN: ${safeData(data.hsn_code, "N/A")}</span>
            <span style="font-size: 10px; font-weight: normal; opacity: 0.8; max-width: 250px;">
              ${data.hsn_matched_description || ""}
            </span>
          </div>
          <div class="header-block" style="text-align: right;">
            <span>CAS: ${safeData(data.cas_no, "N/A")}</span>
          </div>
        </div>
        
        <div class="info-grid">
          
          <div class="grid-cell">
            <strong style="color: var(--dossier-blue);">IUPAC Name:</strong><br/> 
            <div style="margin-top: 5px;">${safeData(data.iupac_name)}</div>
          </div>
          
          <div class="grid-cell">
            <strong style="color: var(--dossier-blue);">Appearance:</strong><br/> 
            <div style="margin-top: 5px;">${safeData(data.appearance)}</div>
          </div>
          
          <div class="grid-cell stacked-labels">
            <div><strong style="color: var(--dossier-blue);">Mol. Formula:</strong> ${safeData(data.molecular_formula)}</div>
            <div><strong style="color: var(--dossier-blue);">Mol. Wt.:</strong> ${safeData(data.molecular_weight)}</div>
          </div>
          
          <div class="grid-cell">
            <strong style="color: var(--dossier-blue);">Hazard Class (GHS):</strong><br/> 
            <div style="margin-top: 5px;">${data.hazard_class ? formatAsList(data.hazard_class) : '<span class="placeholder-text">N/A</span>'}</div>
          </div>
          
        </div>
      </div>

      <div class="bottom-cards-container">
        
        <div class="bottom-card card-synonyms">
          <h3>Synonyms</h3>
          <div class="scrollable-area">
            ${data.synonyms ? formatAsList(data.synonyms) : '<span class="placeholder-text">No synonyms available.</span>'}
          </div>
        </div>

        <div class="bottom-card card-structures">
          <div class="scrollable-area">
            <h3>1. Structure</h3>
            ${imageHTML}
            <div style="word-break: break-all; font-size: 12px;">
              <strong style="color: var(--dossier-blue);">SMILES:</strong> ${safeData(data.structure)}
            </div>
            <br>
            
            <h3>2. Isomers & Stereochem</h3>
            <div style="word-break: break-all; font-size: 12px;">
              <strong style="color: var(--dossier-blue);">Isomeric SMILES:</strong><br> ${safeData(data.isomeric_structure)}<br><br>
              <strong style="color: var(--dossier-blue);">Defined Stereochemistry:</strong><br> ${safeData(data.has_defined_stereochemistry)}
            </div>
          </div>
        </div>

        <div class="bottom-card card-licenses">
          <h3>Licenses & Taxation</h3>
          <div class="scrollable-area">
            <div>
              <strong style="color: var(--dossier-blue);">Licenses:</strong>
              <ul>
                <li>BIS: ${bisHTML}</li>
                <li>
                  SCOMET (Cat 1): 
                  <strong class="${scometColor}">${safeData(data.scomet_status)}</strong>
                  ${data.scomet_caveat ? `<br><span class="subtext">${data.scomet_caveat}</span>` : ""}
                </li>
                <li>Alcohol/Poison/Acid: ${safeData(data.alcohol_poison_acid_license)}</li>
              </ul>
            </div>
            
            <div class="tax-section">
              <strong style="color: var(--dossier-blue);">Taxation in India (GST):</strong>
              <ul>
                <li>
                  GST %: <strong>${safeData(data.gst_rate)}</strong>
                  ${data.gst_matched_description ? `<br><span class="subtext">${data.gst_matched_description}</span>` : ""}
                  ${data.gst_rate_exception_note && data.gst_rate_exception_note !== "N/A" ? `<br><span class="subtext danger-text"><em>Exception Note: ${data.gst_rate_exception_note}</em></span>` : ""}
                </li>
                <br>
                <li>Basic Customs Duty: ${safeData(data.bcd_rate)}</li>
                <li>Anti Dumping Duty: ${safeData(data.anti_dumping_duty)}</li>
              </ul>
            </div>
          </div>
        </div>

        <div class="bottom-card card-history">
          <div class="scrollable-area">
            <h3>Reactivity & Stabilizers</h3>
            <div style="font-size: 12px; margin-bottom: 6px;">
              <strong style="color: var(--dossier-blue);">Stabilizer Mentioned:</strong> ${safeData(data.stabilizer_mentioned)}
            </div>
            <div style="font-size: 12px;">
              ${reactivityHTML}
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  container.innerHTML = dashboardHTML;
}
