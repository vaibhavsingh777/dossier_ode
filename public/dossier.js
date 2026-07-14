/**
 * dossier.js
 * Implements interactive chemical dossier tracking layouts, rendering a strict
 * 3-column document-style view showing ALL fields (empty if no data exists).
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
  if (!str || str === "N/A" || str === "-")
    return '<span class="placeholder-text">-</span>';
  const items = str
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return '<span class="placeholder-text">-</span>';
  if (items.length === 1) return items[0];
  return `<ul class="dossier-list" style="margin: 0; padding-left: 20px;">${items.map((item) => `<li style="margin-bottom: 4px;">${item}</li>`).join("")}</ul>`;
}

/**
 * Renders the strictly dynamic dashboard layout with the color-coded cards,
 * parsing structure images, isomers, taxation, and BIS matching the 3-column UI.
 */
function renderDocumentStyleDossier(data, container) {
  container.innerHTML = "";

  // Helper function to handle empty fields gracefully with "-"
  const safeData = (val, placeholder = "-") =>
    val && val !== "N/A" && val !== "-"
      ? val
      : `<span class="placeholder-text">${placeholder}</span>`;

  // Handle structure image logic securely with timestamp to bypass cache
  const timestamp = new Date().getTime();
  let imageHTML =
    data.structure_image && data.structure_image !== "N/A"
      ? `<a href="${data.structure_image}" target="_blank" style="display: flex; align-items: center; justify-content: center; height: 100%; width: 100%;">
            <img src="${data.structure_image}?t=${timestamp}" 
                 style="max-height: 130px; max-width: 100%; object-fit: contain; padding: 4px; background: transparent;" 
                 alt="Chemical Structure"/>
         </a>`
      : `<span class="placeholder-text" style="font-weight: bold; font-size: 1.2rem; letter-spacing: 2px;">IMAGE</span>`;

  // Determine SCOMET Highlight Color
  const scometColor =
    data.scomet_entry_code &&
    data.scomet_entry_code !== "N/A" &&
    data.scomet_entry_code !== "-"
      ? "danger-text"
      : "";

  // BIS rendering: handling array maps and graceful fallbacks
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
    bisHTML = safeData(null);
  } else {
    bisHTML = safeData(data.bis_license);
  }

  const dashboardHTML = `
    <div class="dashboard-wrapper">
      
      <div class="top-card">
        <div class="top-header">
          <div class="header-block">
            <span>${safeData(data.chemical_name, "name of the chemical")}</span>
          </div>
          <div class="header-block" style="text-align: center;">
            <span>${safeData(data.hsn_code, "hsn code")}</span>
          </div>
          <div class="header-block" style="text-align: right;">
            <span>${safeData(data.cas_no, "cas number")}</span>
          </div>
        </div>
        
        <div class="info-grid">
          
          <div class="grid-cell cell-iupac">
            <strong style="color: var(--dossier-blue);">iupac name</strong><br/> 
            <div style="margin-top: 5px;">${safeData(data.iupac_name)}</div>
          </div>
          
          <div class="grid-cell cell-appearance">
            <strong style="color: var(--dossier-blue);">appearance</strong><br/> 
            <div style="margin-top: 5px;">${safeData(data.appearance)}</div>
          </div>

          <div class="grid-cell cell-image">
            ${imageHTML}
          </div>
          
          <div class="grid-cell cell-mol stacked-labels">
            <div><strong style="color: var(--dossier-blue);">mol. formula:</strong> ${safeData(data.molecular_formula)}</div>
            <div><strong style="color: var(--dossier-blue);">mol. wt.:</strong> ${safeData(data.molecular_weight)}</div>
          </div>
          
          <div class="grid-cell cell-hazard">
            <strong style="color: var(--dossier-blue);">hazard class</strong><br/> 
            <div style="margin-top: 5px;">${data.hazard_class ? formatAsList(data.hazard_class) : '<span class="placeholder-text">-</span>'}</div>
          </div>
          
        </div>
      </div>

      <div class="bottom-cards-container">
        
        <div class="bottom-card card-synonyms">
          <h3>synonyms</h3>
          <div class="scrollable-area">
            ${data.synonyms ? formatAsList(data.synonyms) : '<span class="placeholder-text">-</span>'}
          </div>
        </div>

        <div class="bottom-card card-structures">
          <h3>1. structure</h3>
          <div class="scrollable-area" style="flex-grow: 0; min-height: 60px; padding-bottom: 10px;">
            <div style="word-break: break-all; font-size: 12px;">
              <strong style="color: var(--dossier-blue);">SMILES:</strong> ${safeData(data.structure)}
            </div>
          </div>
          
          <h3 style="border-radius: 0; border-top: 1px solid var(--border-color);">2. list of struct. + geometrical isomers</h3>
          <div class="scrollable-area" style="padding-top: 15px;">
            <div style="word-break: break-all; font-size: 12px;">
              <strong style="color: var(--dossier-blue);">Isomeric SMILES:</strong><br> ${safeData(data.isomeric_structure)}<br><br>
              <strong style="color: var(--dossier-blue);">Defined Stereochemistry:</strong><br> ${safeData(data.has_defined_stereochemistry)}
            </div>
          </div>
        </div>

        <div class="bottom-card card-licenses">
          <h3>licenses & taxation</h3>
          <div class="scrollable-area">
            <div>
              <strong style="color: var(--dossier-blue);">licenses:</strong>
              <ul>
                <li>bis: ${bisHTML}</li>
                <li>
                  scomet: 
                  <strong class="${scometColor}">${safeData(data.scomet_status)}</strong>
                  ${data.scomet_caveat && data.scomet_caveat !== "N/A" ? `<br><span class="subtext">${data.scomet_caveat}</span>` : ""}
                </li>
                <li>alcohol/poison/acid: ${safeData(data.alcohol_poison_acid_license)}</li>
              </ul>
            </div>
            
            <div class="tax-section">
              <strong style="color: var(--dossier-blue);">taxation:</strong>
              <ul>
                <li>
                  gst%: <strong>${safeData(data.gst_rate)}</strong>
                  ${data.gst_matched_description ? `<br><span class="subtext">${data.gst_matched_description}</span>` : ""}
                  ${data.gst_rate_exception_note && data.gst_rate_exception_note !== "N/A" && data.gst_rate_exception_note !== "-" ? `<br><span class="subtext danger-text"><em>Exception Note: ${data.gst_rate_exception_note}</em></span>` : ""}
                </li>
                <br>
                <li>basic customs duty: ${safeData(data.bcd_rate)}</li>
                <li>anti dumping duty: ${safeData(data.anti_dumping_duty)}</li>
              </ul>
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  container.innerHTML = dashboardHTML;
}
