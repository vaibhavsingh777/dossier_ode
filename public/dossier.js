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

                <nav class="app-navbar">
                    <div class="navbar-left">
                        <img
                            src="logo.png"
                            alt="Ode Chem LLP"
                            class="navbar-logo"
                            onerror="this.style.display='none'; document.getElementById('navbar-brand-fallback').style.display='inline-block';"
                        />
                        <span id="navbar-brand-fallback" class="navbar-brand-fallback" style="display:none;">Ode Chem LLP</span>
                    </div>

                    <div class="navbar-center">
                        <form id="dossier-search-form" class="navbar-search-form">
                            <input
                                type="text"
                                id="cas-input"
                                aria-label="CAS Registry Number"
                                placeholder="Enter CAS Number, e.g., 13162-05-5"
                                required
                            />
                            <button type="submit" id="generate-dossier-btn" class="btn btn-primary">Generate Dossier</button>
                        </form>
                    </div>

                    <div class="navbar-right">
                        <button type="button" id="logout-btn" class="btn-logout">Logout</button>
                    </div>
                </nav>

                <div class="dossier-page-body">
                    <div id="dossier-results-section" class="dossier-results-section"></div>
                </div>

            </div>
        `;
    initDossierDashboard();
    initNavbar();
  }
});

function initNavbar() {
  const logoutBtn = document.getElementById("logout-btn");
  if (!logoutBtn) return;

  logoutBtn.addEventListener("click", () => {
    // Placeholder logout flow — wire this up to your actual auth/session teardown.
    const confirmed = window.confirm("Are you sure you want to logout?");
    if (confirmed) {
      window.location.href = "login.html";
    }
  });
}

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
    submitBtn.innerText = "Compiling Datasets (This Takes ~15s)...";
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
      ? `<a href="${data.structure_image}" target="_blank" class="structure-image-link">
            <img src="${data.structure_image}?t=${timestamp}" class="structure-image" alt="Chemical Structure"/>
         </a>`
      : `<span class="placeholder-text structure-image-placeholder">Image</span>`;

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

  // Product identity now sits centered, above and outside the table itself.
  const productHeaderHTML = `
    <div class="product-header">
      <h1 class="product-name">${safeData(data.chemical_name, "Name Of The Chemical")}</h1>
      <div class="product-codes">
        <span>HSN No: ${safeData(data.hsn_code, "HSN Code")}</span>
        <span class="code-divider">|</span>
        <span>CAS No: ${safeData(data.cas_no, "CAS Number")}</span>
      </div>
    </div>
  `;

  const dashboardHTML = `
    <div class="dashboard-wrapper">

      ${productHeaderHTML}

      <div class="top-card">
        <div class="info-grid">

          <div class="grid-cell cell-iupac">
            <span class="field-label">IUPAC Name</span>
            <div class="field-value">${safeData(data.iupac_name)}</div>
          </div>

          <div class="grid-cell cell-appearance">
            <span class="field-label">Appearance</span>
            <div class="field-value">${safeData(data.appearance)}</div>
          </div>

          <div class="grid-cell cell-image">
            ${imageHTML}
          </div>

          <div class="grid-cell cell-mol stacked-labels">
            <div>
              <span class="field-label">Molecular Formula</span>
              <div class="field-value">${safeData(data.molecular_formula)}</div>
            </div>
            <div>
              <span class="field-label">Molecular Weight</span>
              <div class="field-value">${safeData(data.molecular_weight)}</div>
            </div>
          </div>

          <div class="grid-cell cell-hazard">
            <span class="field-label">Hazard Class</span>
            <div class="field-value">${data.hazard_class ? formatAsList(data.hazard_class) : '<span class="placeholder-text">-</span>'}</div>
          </div>

        </div>
      </div>

      <div class="bottom-cards-container">

        <div class="bottom-card card-synonyms">
          <div class="card-header"><span class="field-label">Synonyms</span></div>
          <div class="scrollable-area">
            ${data.synonyms ? formatAsList(data.synonyms) : '<span class="placeholder-text">-</span>'}
          </div>
        </div>

        <div class="bottom-card card-structures">
          <div class="card-header"><span class="field-label">1. Structure</span></div>
          <div class="scrollable-area" style="flex-grow: 0; min-height: 60px; padding-bottom: 10px;">
            <div style="word-break: break-all; font-size: 12px;">
              <strong style="color: var(--dossier-blue);">SMILES:</strong> ${safeData(data.structure)}
            </div>
          </div>

          <div class="card-header card-header-divider"><span class="field-label">2. List Of Structural &amp; Geometrical Isomers</span></div>
          <div class="scrollable-area" style="padding-top: 15px;">
            <div style="word-break: break-all; font-size: 12px;">
              <strong style="color: var(--dossier-blue);">Isomeric SMILES:</strong><br> ${safeData(data.isomeric_structure)}<br><br>
              <strong style="color: var(--dossier-blue);">Defined Stereochemistry:</strong><br> ${safeData(data.has_defined_stereochemistry)}
            </div>
          </div>
        </div>

        <div class="bottom-card card-licenses">
          <div class="card-header"><span class="field-label">Licenses &amp; Taxation</span></div>
          <div class="scrollable-area">
            <div>
              <strong style="color: var(--dossier-blue);">Licenses:</strong>
              <ul>
                <li>BIS: ${bisHTML}</li>
                <li>
                  SCOMET:
                  <strong class="${scometColor}">${safeData(data.scomet_status)}</strong>
                  ${data.scomet_caveat && data.scomet_caveat !== "N/A" ? `<br><span class="subtext">${data.scomet_caveat}</span>` : ""}
                </li>
                <li>Alcohol/Poison/Acid License: ${safeData(data.alcohol_poison_acid_license)}</li>
              </ul>
            </div>

            <div class="tax-section">
              <strong style="color: var(--dossier-blue);">Taxation:</strong>
              <ul>
                <li>
                  GST %: <strong>${safeData(data.gst_rate)}</strong>
                  ${data.gst_matched_description ? `<br><span class="subtext">${data.gst_matched_description}</span>` : ""}
                  ${data.gst_rate_exception_note && data.gst_rate_exception_note !== "N/A" && data.gst_rate_exception_note !== "-" ? `<br><span class="subtext danger-text"><em>Exception Note: ${data.gst_rate_exception_note}</em></span>` : ""}
                </li>
                <br>
                <li>Basic Customs Duty: ${safeData(data.bcd_rate)}</li>
                <li>Anti-Dumping Duty: ${safeData(data.anti_dumping_duty)}</li>
              </ul>
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  container.innerHTML = dashboardHTML;
}
