(() => {
  const mapEl = document.querySelector("#imdMap");
  if (!mapEl) return;
  const statusEl = document.querySelector("#liveStatus");
  const dotEl = document.querySelector("#liveDot");
  const rowsEl = document.querySelector("#liveRows");
  const footEl = document.querySelector("#liveFootnote");
  const summaryEl = document.querySelector("#riskSummary");
  const alertsEl = document.querySelector("#riskAlerts");
  const refreshButton = document.querySelector("#refreshLive");
  const heroAlertStatus = document.querySelector("#heroAlertStatus");
  const heroAlertHeadline = document.querySelector("#heroAlertHeadline");
  const heroAlertDetail = document.querySelector("#heroAlertDetail");
  const searchForm = document.querySelector("#districtSearchForm");
  const searchInput = document.querySelector("#districtSearch");
  const locationButton = document.querySelector("#myLocation");
  const mapToolMessage = document.querySelector("#mapToolMessage");
  const norm = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  const safeText = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
  const palette = { high:"#b65345", elevated:"#d58c4c", watch:"#c4ad50", lower:"#668b72" };
  const labels = { high:"High flood watch", elevated:"Elevated watch", watch:"Rain watch", lower:"Lower screening level" };
  const map = window.L ? L.map(mapEl, { scrollWheelZoom: false }).setView([22.4, 79.0], 4) : null;
  if (map) {
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  } else {
    mapEl.innerHTML = '<div class="live-empty">Map library could not be loaded. Forecast summaries remain available below.</div>';
  }
  let markers = [];
  let allResults = [];
  let userLocationMarker = null;
  let busy = false;
  let pollTimer = null;

  function renderMarkers(results) {
    if (!map) return;
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    for (const item of results) {
      if (!Number.isFinite(Number(item.lat)) || !Number.isFinite(Number(item.lon))) continue;
      const level = item.level || "lower";
      const radius = level === "high" ? 9 : level === "elevated" ? 8 : level === "watch" ? 7 : 5;
      const marker = L.circleMarker([Number(item.lat), Number(item.lon)], {
        radius, color:"#fff", weight:1.5, fillColor:palette[level] || palette.lower, fillOpacity:.87,
      }).addTo(map);
      const forecast = (item.forecastDays || []).map(day => `<li>${safeText(day.date)} · ${Number(day.totalPrecipMm).toFixed(1)} mm · ${Math.round(Number(day.chanceOfRain) || 0)}% rain chance</li>`).join("");
      const reason = (item.reasons || []).map(safeText).join("; ");
      marker.bindPopup(`<strong>${safeText(item.district)}, ${safeText(item.state)}</strong><br><b>${safeText(labels[level] || labels.lower)}</b><br>${safeText(reason)}<ul style="padding-left:18px;margin:6px 0">${forecast}</ul><small>Atlas exposure: ${Math.round(Number(item.historicFloodAreaHa) || 0).toLocaleString("en-IN")} ha · map point from forecast location search</small>`);
      marker._floodResult = item;
      markers.push(marker);
    }
  }

  function focusDistrict(item) {
    if (!map || !item || !Number.isFinite(Number(item.lat)) || !Number.isFinite(Number(item.lon))) return false;
    map.setView([Number(item.lat), Number(item.lon)], 8, { animate:true });
    const marker = markers.find(candidate => candidate._floodResult === item);
    if (marker) marker.openPopup();
    return true;
  }

  function nearestDistrict(lat, lon) {
    const toRad = degrees => degrees * Math.PI / 180;
    let nearest = null;
    for (const item of allResults) {
      if (!Number.isFinite(Number(item.lat)) || !Number.isFinite(Number(item.lon))) continue;
      const dLat = toRad(Number(item.lat) - lat);
      const dLon = toRad(Number(item.lon) - lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(Number(item.lat))) * Math.sin(dLon / 2) ** 2;
      const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (!nearest || distanceKm < nearest.distanceKm) nearest = { item, distanceKm };
    }
    return nearest;
  }

  function activeProviderAlerts(results) {
    const now = Date.now();
    const grouped = new Map();
    for (const item of results) {
      for (const alert of item.weatherAlerts || []) {
        const expiry = Date.parse(alert.expires || "");
        if (Number.isFinite(expiry) && expiry <= now) continue;
        const key = [alert.event, alert.headline, alert.effective, alert.expires].join("|");
        if (!grouped.has(key)) grouped.set(key, { alert, districts: [] });
        const group = grouped.get(key);
        const areaName = `${item.district}, ${item.state}`;
        if (!group.districts.includes(areaName)) group.districts.push(areaName);
      }
    }
    return [...grouped.values()];
  }

  searchForm?.addEventListener("submit", event => {
    event.preventDefault();
    const query = norm(searchInput?.value);
    if (!query) {
      if (mapToolMessage) mapToolMessage.textContent = "Enter a district or state to search.";
      return;
    }
    const match = allResults.find(item => norm(`${item.district} ${item.state}`).includes(query) || norm(item.locationName).includes(query));
    if (!match) {
      if (mapToolMessage) mapToolMessage.textContent = allResults.length ? "No matching forecast area found." : "District forecasts are still loading.";
      return;
    }
    focusDistrict(match);
    if (mapToolMessage) mapToolMessage.textContent = `Showing ${match.district}, ${match.state} · ${labels[match.level] || labels.lower}.`;
  });

  locationButton?.addEventListener("click", () => {
    if (!navigator.geolocation) {
      if (mapToolMessage) mapToolMessage.textContent = "Location is not available in this browser.";
      return;
    }
    if (!allResults.length) {
      if (mapToolMessage) mapToolMessage.textContent = "District forecasts are still loading. Try again shortly.";
      return;
    }
    locationButton.disabled = true;
    if (mapToolMessage) mapToolMessage.textContent = "Finding your nearest forecast district…";
    navigator.geolocation.getCurrentPosition(position => {
      const { latitude, longitude } = position.coords;
      const nearest = nearestDistrict(latitude, longitude);
      if (!nearest || !map) {
        if (mapToolMessage) mapToolMessage.textContent = "Could not find a nearby forecast district.";
        locationButton.disabled = false;
        return;
      }
      if (userLocationMarker) map.removeLayer(userLocationMarker);
      userLocationMarker = L.circleMarker([latitude, longitude], {
        radius:7, color:"#fff", weight:2, fillColor:"#477f9e", fillOpacity:1,
      }).addTo(map).bindPopup("Your current location (shown only in this browser)");
      const nearestMarker = markers.find(marker => marker._floodResult === nearest.item);
      const point = [Number(nearest.item.lat), Number(nearest.item.lon)];
      if (nearest.distanceKm > 12 && nearestMarker) {
        map.fitBounds(L.latLngBounds([[latitude, longitude], point]), { padding:[35,35], maxZoom:7, animate:true });
        nearestMarker.openPopup();
      } else {
        map.setView(point, 8, { animate:true });
        if (nearestMarker) nearestMarker.openPopup();
      }
      const distance = nearest.distanceKm < 1 ? "less than 1 km" : `about ${Math.round(nearest.distanceKm)} km`;
      if (mapToolMessage) mapToolMessage.textContent = `Nearest forecast point: ${nearest.item.district}, ${nearest.item.state} (${distance} away).`;
      locationButton.disabled = false;
    }, error => {
      const message = error.code === 1 ? "Location permission was denied. You can search for a district instead." : "Couldn’t get your location. Check browser permissions and try again.";
      if (mapToolMessage) mapToolMessage.textContent = message;
      locationButton.disabled = false;
    }, { enableHighAccuracy:false, timeout:12000, maximumAge:60000 });
  });

  function renderRows(data) {
    const results = data.results || [];
    if (!results.length) {
      rowsEl.innerHTML = data.status === "refreshing"
        ? `<div class="live-empty">Looking up forecasts… ${data.completed || 0} of ${data.total || 0} districts checked.</div>`
        : `<div class="live-empty">${safeText(data.error || "No district forecasts are available yet.")}</div>`;
      return;
    }
    rowsEl.innerHTML = results.slice(0, 80).map(item => {
      const level = item.level || "lower";
      const maxRain = Number(item.maxDailyMm) || 0;
      const chance = Number(item.maxRainChance) || 0;
      const totals = Number(item.threeDayMm) || 0;
      const reasons = (item.reasons || []).map(safeText).join(" · ");
      return `<div class="live-row"><div class="live-row-top"><strong>${safeText(item.district)}, ${safeText(item.state)}</strong><span class="live-pill ${level === "lower" ? "green" : level}">${safeText(labels[level] || labels.lower)}</span></div><small>${safeText(item.locationName || "Forecast location")} · ${maxRain.toFixed(1)} mm max/day · ${totals.toFixed(1)} mm / 3 days · rain chance up to ${chance}%</small><small>${reasons}</small></div>`;
    }).join("");
  }

  function renderStatus(data) {
    const results = data.results || [];
    const providerAlerts = activeProviderAlerts(results);
    const counts = { high:0, elevated:0, watch:0 };
    for (const item of results) if (counts[item.level] !== undefined) counts[item.level]++;
    summaryEl.textContent = results.length
      ? `${counts.high} high flood-watch area${counts.high === 1 ? "" : "s"} · ${counts.elevated} elevated · ${counts.watch} rain watch · ${results.length} district forecasts mapped. Screening bands are not flood probabilities.`
      : (data.status === "refreshing" ? `Building the national outlook: ${data.completed || 0} / ${data.total || 0} districts checked.` : safeText(data.error || "Waiting for forecast data."));

    if (alertsEl) {
      const highAreas = results.filter(item => item.level === "high");
      const elevatedAreas = results.filter(item => item.level === "elevated");
      const rainAreas = results.filter(item => item.level === "watch").slice(0, 6);
      const activeAreas = highAreas.length ? highAreas : (elevatedAreas.length ? elevatedAreas : rainAreas);
      const alertClass = highAreas.length ? " has-high" : (elevatedAreas.length ? " has-elevated" : "");
      const title = providerAlerts.length
        ? `Weather provider notices: ${providerAlerts.length}`
        : highAreas.length
        ? `High flood-watch signals`
        : elevatedAreas.length
          ? `Elevated flood-watch signals`
          : data.status === "refreshing"
            ? "Checking for high flood-watch areas…"
            : counts.watch
              ? "Rain forecast watch"
              : "No elevated screening signals";
      const detail = providerAlerts.length
        ? `Provider weather alerts, last checked ${data.generatedAt ? new Date(data.generatedAt).toLocaleString() : "recently"}. These are weather alerts, not IMD flood orders.`
        : highAreas.length || elevatedAreas.length
        ? "These districts combine forecast rain with historical flood exposure. This is a screening watch, not an official warning."
        : counts.watch
          ? `No districts currently meet the high or elevated flood-watch screening. ${counts.watch} meet the rain-watch criteria; rain by itself does not mean flooding is likely.`
          : data.status === "refreshing"
            ? `${data.completed || 0} of ${data.total || 0} district forecasts checked so far.`
            : "Keep checking the outlook as forecasts update. Follow official IMD and local authority warnings.";
      alertsEl.className = `risk-alerts${alertClass}${highAreas.length || elevatedAreas.length ? " has-risk" : counts.watch ? " has-rain" : " is-calm"}`;
      const providerHtml = providerAlerts.map(({ alert, districts }) => `<div class="risk-alert-item"><b>${safeText(alert.headline || alert.event || "Weather alert")}</b><span>${safeText(alert.severity || "Severity not provided")}${alert.urgency ? ` · ${safeText(alert.urgency)}` : ""}</span><p>${safeText(alert.description || alert.instruction || "See the linked district forecast for details.")}</p><small>Reported for ${safeText(districts.slice(0, 6).join(" · "))}${districts.length > 6 ? ` · and ${districts.length - 6} more districts` : ""}${alert.expires ? ` · expires ${safeText(alert.expires)}` : ""}</small></div>`).join("");
      const count = providerAlerts.length || highAreas.length + elevatedAreas.length || counts.watch;
      const countLabel = providerAlerts.length ? "NOTICES" : highAreas.length + elevatedAreas.length ? "HIGH / ELEVATED" : counts.watch ? "RAIN WATCH" : "AREAS";
      const areaCards = activeAreas.slice(0, 6).map(item => {
        const level = item.level || "watch";
        const levelName = level === "high" ? "High screening" : level === "elevated" ? "Elevated screening" : "Rain watch";
        return `<article class="risk-area-card ${level}"><div class="risk-area-top"><span>${levelName}</span><b>${Math.round(Number(item.maxRainChance) || 0)}<small>% rain chance</small></b></div><strong>${safeText(item.district)}</strong><span class="risk-area-state">${safeText(item.state)}</span><div class="risk-area-rain"><b>${Number(item.maxDailyMm || 0).toFixed(1)}</b><span>mm max / day</span></div></article>`;
      }).join("");
      alertsEl.innerHTML = `<div class="risk-alert-heading"><span class="risk-alert-mark" aria-hidden="true">${highAreas.length ? "!" : elevatedAreas.length ? "↑" : counts.watch ? "↗" : "·"}</span><div class="risk-alert-copy"><small>FORECAST SCREENING · ${safeText(data.status === "refreshing" ? "UPDATING" : "DISTRICT OUTLOOK")}</small><strong>${safeText(title)}</strong><p>${safeText(detail)}</p></div><div class="risk-alert-count"><b>${count}</b><span>${countLabel}</span></div></div>${providerHtml ? `<div class="provider-alert-list">${providerHtml}</div>` : ""}${areaCards ? `<div class="risk-area-grid">${areaCards}</div>` : ""}`;
    }

    if (heroAlertHeadline && heroAlertDetail) {
      const updated = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : null;
      if (data.status === "refreshing") {
        heroAlertStatus?.classList.remove("has-live-alert");
        heroAlertHeadline.textContent = "Checking weather alerts…";
        heroAlertDetail.textContent = `${data.completed || 0} of ${data.total || 0} district forecasts checked.`;
      } else if (providerAlerts.length) {
        heroAlertStatus?.classList.add("has-live-alert");
        heroAlertHeadline.textContent = `${providerAlerts.length} active provider weather alert${providerAlerts.length === 1 ? "" : "s"}.`;
        const first = providerAlerts[0];
        heroAlertDetail.textContent = `${first.alert.headline || first.alert.event} · ${first.districts.slice(0, 3).join(", ")}${first.districts.length > 3 ? ` +${first.districts.length - 3} more` : ""} · checked ${updated || "recently"}.`;
      } else if (data.status === "ready") {
        heroAlertStatus?.classList.remove("has-live-alert");
        heroAlertHeadline.textContent = counts.high || counts.elevated
          ? `Flood-watch screening is elevated in ${counts.high + counts.elevated} area${counts.high + counts.elevated === 1 ? "" : "s"}.`
          : "No active provider weather alerts reported.";
        heroAlertDetail.textContent = `${counts.watch} rain-watch area${counts.watch === 1 ? "" : "s"} in the forecast screening · checked ${updated}. Official IMD warning feed is currently unavailable to this backend.`;
      } else {
        heroAlertStatus?.classList.remove("has-live-alert");
        heroAlertHeadline.textContent = "Live alert data unavailable.";
        heroAlertDetail.textContent = data.error || "The weather alert provider could not be reached.";
      }
    }

    if (data.status === "refreshing") {
      dotEl.className = "live-dot";
      statusEl.textContent = `Loading forecasts ${data.completed || 0}/${data.total || 0}`;
    } else if (data.status === "ready") {
      dotEl.className = "live-dot good";
      statusEl.textContent = `Forecast updated ${new Date(data.generatedAt).toLocaleString()}`;
    } else {
      dotEl.className = "live-dot bad";
      statusEl.textContent = data.status === "unconfigured" ? "WeatherAPI key missing" : "Forecast unavailable";
    }
    if (data.status === "ready" && data.failed) footEl.textContent = `${providerAlerts.length} active WeatherAPI weather alert(s) reported, if any. ${data.failed} district location(s) could not be matched and are omitted. Forecast data refreshes about every ${Math.round((data.cacheSeconds || 21600) / 3600)} hours. Flood-watch bands combine 3-day rainfall with historical flood-affected area; they are not calibrated probabilities or official warnings. IMD's official district warning feed is currently unavailable to this backend. Follow IMD and local authority guidance.`;
    else footEl.textContent = `WeatherAPI weather alerts and a district rainfall screening; the latest provider check was ${data.generatedAt ? new Date(data.generatedAt).toLocaleString() : "not completed"}. Forecast data refreshes about every ${Math.round((data.cacheSeconds || 21600) / 3600)} hours. The “high” label is a watch category, not a calibrated probability or official warning. IMD's official district warning feed is currently unavailable to this backend. Follow official IMD and local authority guidance.`;
  }

  async function loadOutlook() {
    if (busy) return;
    busy = true;
    refreshButton.disabled = true;
    try {
      const response = await fetch("/api/risk", { headers:{ Accept:"application/json" }, cache:"no-store" });
      const data = await response.json();
      if (response.status === 429) throw new Error(data.error || "Too many refresh requests. Try again shortly.");
      allResults = data.results || [];
      renderMarkers(data.results || []);
      renderRows(data);
      renderStatus(data);
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (data.status === "refreshing") pollTimer = window.setTimeout(loadOutlook, 5000);
      else if (data.status === "ready") pollTimer = window.setTimeout(loadOutlook, 5 * 60 * 1000);
    } catch (error) {
      dotEl.className = "live-dot bad";
      statusEl.textContent = "Forecast unavailable";
      summaryEl.textContent = error?.message || "Could not read the backend forecast.";
      rowsEl.innerHTML = `<div class="live-empty">${safeText(error?.message || "Could not load the forecast.")}</div>`;
    } finally {
      busy = false;
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener("click", loadOutlook);
  loadOutlook();
})();
