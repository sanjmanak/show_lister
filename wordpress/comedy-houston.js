/**
 * Comedy Houston — WordPress Plugin JavaScript (v2)
 *
 * Fetches events.json from the GitHub repo and renders event cards
 * with filtering, sorting, and affiliate click tracking.
 *
 * Config is injected by the PHP plugin via wp_add_inline_script:
 *   window.ComedyHoustonConfig = {
 *     jsonUrl:      "https://raw.githubusercontent.com/.../events.json",
 *     colorScheme:  "dark" | "light" | "auto",
 *     trackClicks:  true | false,
 *     redirectBase: "https://yoursite.com/?ch_go=",
 *     shortcodeParams: {
 *       filter:   "all"|"today"|"tomorrow"|"weekend"|"week"|"month",
 *       maxPrice: number|null,
 *       venue:    ""|"Venue Name",
 *       source:   ""|"ticketmaster"|"eventbrite"
 *     }
 *   }
 */
(function () {
  "use strict";

  // ================================================================
  // CONFIGURATION
  // ================================================================
  var config = window.ComedyHoustonConfig || {};
  var JSON_URL = config.jsonUrl ||
    "https://raw.githubusercontent.com/sanjmanak/show_lister/main/events.json";
  var TRACK_CLICKS = config.trackClicks !== false;
  var SHOW_SOURCE_BADGES = config.showSourceBadges !== false;
  var REDIRECT_BASE = config.redirectBase || "";

  // Shortcode params (locked filters from PHP shortcode attributes)
  var scParams = config.shortcodeParams || {};

  // ================================================================
  // APP STATE
  // ================================================================
  var allEvents = [];
  var currentTimeFilter = scParams.filter || "all";
  var currentVenueFilter = scParams.venue || "all";
  var currentSourceFilter = scParams.source || "all";
  var currentSort = "date";
  var lockedMaxPrice = (scParams.maxPrice !== null && scParams.maxPrice !== undefined)
    ? scParams.maxPrice : null;
  var showOpenMic = scParams.showOpenMic !== false;

  // ================================================================
  // INIT — wait for DOM to be ready
  // ================================================================
  function onReady(fn) {
    if (document.readyState !== "loading") {
      fn();
    } else {
      document.addEventListener("DOMContentLoaded", fn);
    }
  }

  onReady(function () {
    if (!document.getElementById("ch-app")) return;
    init();
  });

  async function init() {
    try {
      var resp = await fetch(JSON_URL);
      if (resp.ok) {
        var data = await resp.json();
        allEvents = data.events || [];
        setUpdatedAt(data.last_updated);
      } else {
        console.warn("Comedy Houston: Could not fetch events.json — HTTP " + resp.status);
      }
    } catch (e) {
      console.warn("Comedy Houston: Could not load events.json:", e);
    }

    populateVenueFilter();
    applyShortcodeDefaults();
    bindEvents();
    render();
  }

  // ================================================================
  // TICKET URL BUILDER — routes through redirect for tracking
  // ================================================================
  function buildTicketUrl(originalUrl) {
    if (!originalUrl) return "";
    // If tracking is enabled and we have a redirect base, route through it
    if (TRACK_CLICKS && REDIRECT_BASE) {
      return REDIRECT_BASE + btoa(originalUrl);
    }
    // Otherwise link directly
    return originalUrl;
  }

  // ================================================================
  // SETUP
  // ================================================================
  function setUpdatedAt(ts) {
    if (!ts) return;
    var d = new Date(ts);
    var el = document.getElementById("chUpdatedAt");
    if (el) {
      el.textContent = "Updated " + d.toLocaleDateString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    }
  }

  function populateVenueFilter() {
    var venueSet = {};
    for (var i = 0; i < allEvents.length; i++) {
      venueSet[allEvents[i].venue] = true;
    }
    var venues = Object.keys(venueSet).sort();
    var sel = document.getElementById("chVenueFilter");
    if (!sel) return;
    for (var j = 0; j < venues.length; j++) {
      var opt = document.createElement("option");
      opt.value = venues[j];
      opt.textContent = venues[j];
      sel.appendChild(opt);
    }
  }

  function applyShortcodeDefaults() {
    // Set the active time filter button to match shortcode param
    if (currentTimeFilter !== "all") {
      var timeButtons = document.querySelectorAll("#chTimeFilters .filter-btn");
      for (var i = 0; i < timeButtons.length; i++) {
        timeButtons[i].classList.remove("active");
        if (timeButtons[i].getAttribute("data-filter") === currentTimeFilter) {
          timeButtons[i].classList.add("active");
        }
      }
    }

    // Pre-select venue dropdown if shortcode specifies one
    if (currentVenueFilter !== "all") {
      var venueEl = document.getElementById("chVenueFilter");
      if (venueEl) venueEl.value = currentVenueFilter;
    }

    // Pre-select source dropdown if shortcode specifies one
    if (currentSourceFilter !== "all") {
      var sourceEl = document.getElementById("chSourceFilter");
      if (sourceEl) sourceEl.value = currentSourceFilter;
    }
  }

  function bindEvents() {
    var timeButtons = document.querySelectorAll("#chTimeFilters .filter-btn");
    for (var i = 0; i < timeButtons.length; i++) {
      timeButtons[i].addEventListener("click", handleTimeFilter);
    }

    var venueEl = document.getElementById("chVenueFilter");
    if (venueEl) venueEl.addEventListener("change", function (e) {
      currentVenueFilter = e.target.value;
      render();
    });

    var sourceEl = document.getElementById("chSourceFilter");
    if (sourceEl) sourceEl.addEventListener("change", function (e) {
      currentSourceFilter = e.target.value;
      render();
    });

    var sortEl = document.getElementById("chSortSelect");
    if (sortEl) sortEl.addEventListener("change", function (e) {
      currentSort = e.target.value;
      render();
    });
  }

  function handleTimeFilter(e) {
    var btn = e.currentTarget;
    var allBtns = document.querySelectorAll("#chTimeFilters .filter-btn");
    for (var i = 0; i < allBtns.length; i++) {
      allBtns[i].classList.remove("active");
    }
    btn.classList.add("active");
    currentTimeFilter = btn.getAttribute("data-filter");
    render();
  }

  // ================================================================
  // FILTERING & SORTING
  // ================================================================
  function getFiltered() {
    var now = new Date();
    var today = toDateStr(now);
    var tomorrow = toDateStr(addDays(now, 1));

    var dayOfWeek = now.getDay();
    var satDate, sunDate;
    if (dayOfWeek === 0) {
      satDate = toDateStr(addDays(now, -1));
      sunDate = today;
    } else if (dayOfWeek === 6) {
      satDate = today;
      sunDate = tomorrow;
    } else {
      var daysToSat = 6 - dayOfWeek;
      satDate = toDateStr(addDays(now, daysToSat));
      sunDate = toDateStr(addDays(now, daysToSat + 1));
    }
    var friDate;
    if (dayOfWeek <= 5) {
      friDate = toDateStr(addDays(now, 5 - dayOfWeek));
    } else {
      friDate = toDateStr(addDays(now, -1));
    }

    var endOfWeek = toDateStr(addDays(now, 7 - dayOfWeek));
    var endOfMonth = toDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));

    var events = [];
    for (var i = 0; i < allEvents.length; i++) {
      var ev = allEvents[i];
      if (!ev.date) continue;
      if (ev.date < today) continue;
      if (ev.status === "cancelled") continue;

      if (currentTimeFilter === "today" && ev.date !== today) continue;
      if (currentTimeFilter === "tomorrow" && ev.date !== tomorrow) continue;
      if (currentTimeFilter === "weekend") {
        if (ev.date !== friDate && ev.date !== satDate && ev.date !== sunDate) continue;
      }
      if (currentTimeFilter === "week" && ev.date > endOfWeek) continue;
      if (currentTimeFilter === "month" && ev.date > endOfMonth) continue;

      if (currentVenueFilter !== "all" && ev.venue !== currentVenueFilter) continue;
      if (currentSourceFilter !== "all" && ev.source !== currentSourceFilter) continue;
      if (!showOpenMic && ev.name && ev.name.toLowerCase().indexOf("open mic") !== -1) continue;

      // Max price filter: include free shows (price_min === 0 or null) and shows
      // with price_min <= maxPrice
      if (lockedMaxPrice !== null) {
        var evPrice = ev.price_min;
        // Include free shows (null/0 price_min)
        if (evPrice !== null && evPrice !== 0 && evPrice > lockedMaxPrice) continue;
      }

      var maxDate = toDateStr(addDays(new Date(), 90));
      if (ev.date > maxDate) continue;

      events.push(ev);
    }

    if (currentSort === "date") {
      events.sort(function (a, b) {
        var dc = (a.date || "").localeCompare(b.date || "");
        return dc !== 0 ? dc : (a.time || "").localeCompare(b.time || "");
      });
    } else if (currentSort === "price-low") {
      events.sort(function (a, b) { return (a.price_min || 9999) - (b.price_min || 9999); });
    } else if (currentSort === "price-high") {
      events.sort(function (a, b) { return (b.price_max || 0) - (a.price_max || 0); });
    } else if (currentSort === "name") {
      events.sort(function (a, b) { return a.name.localeCompare(b.name); });
    }

    return events;
  }

  // ================================================================
  // RENDER
  // ================================================================
  function render() {
    var main = document.getElementById("chMain");
    if (!main) return;
    var events = getFiltered();

    var countEl = document.getElementById("chEventCount");
    if (countEl) countEl.textContent = events.length + (events.length === 1 ? " show" : " shows");

    if (events.length === 0) {
      main.innerHTML = '<div class="empty-state"><h2>No shows found</h2><p>Try changing your filters or check back later.</p></div>';
      return;
    }

    var groupKeys = [];
    var groups = {};
    for (var i = 0; i < events.length; i++) {
      var key = events[i].date || "Unknown Date";
      if (!groups[key]) {
        groups[key] = [];
        groupKeys.push(key);
      }
      groups[key].push(events[i]);
    }

    var html = "";
    for (var g = 0; g < groupKeys.length; g++) {
      var dateStr = groupKeys[g];
      var evts = groups[dateStr];
      var label = formatDateLabel(dateStr);
      html += '<section class="date-group"><div class="date-header">' +
        '<span class="date-header-text">' + label + '</span>' +
        '<span class="date-header-line"></span>' +
        '<span class="date-header-count">' + evts.length + ' show' + (evts.length !== 1 ? 's' : '') + '</span>' +
        '</div><div class="events-grid">';

      for (var k = 0; k < evts.length; k++) {
        html += renderCard(evts[k]);
      }

      html += '</div></section>';
    }

    main.innerHTML = html;
  }

  function renderCard(ev) {
    var imageHTML = ev.image_url
      ? '<img src="' + escapeAttr(ev.image_url) + '" alt="' + escapeAttr(ev.name) + '" loading="lazy">'
      : '<div class="card-image-placeholder">' +
        '<span class="venue-icon">&#127908;</span>' +
        '<span class="venue-label">' + escapeHTML(ev.venue) + '</span></div>';

    var priceHTML = formatPrice(ev.price_min, ev.price_max, ev.currency);

    var statusClass = ev.status || "unknown";
    var statusLabel = (ev.status || "").replace(/_/g, " ");

    var ticketUrl = buildTicketUrl(ev.ticket_url);
    var ticketHTML = ev.ticket_url
      ? '<a class="card-cta" href="' + escapeAttr(ticketUrl) + '" target="_blank" rel="noopener">' +
        'Get Tickets <span class="arrow">&rarr;</span></a>'
      : '<span class="card-cta" style="opacity:0.5;cursor:default;">Coming Soon</span>';

    return '<article class="event-card">' +
      '<div class="card-image">' + imageHTML +
      (SHOW_SOURCE_BADGES ? '<span class="card-source-badge ' + escapeAttr(ev.source) + '">' + escapeHTML(ev.source) + '</span>' : '') +
      '<span class="card-status-badge ' + escapeAttr(statusClass) + '">' + escapeHTML(statusLabel) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
      '<div class="card-date-time">' +
      '<span>' + escapeHTML(ev.day_of_week || "") + '</span>' +
      '<span class="separator"></span>' +
      '<span>' + escapeHTML(ev.time || "TBA") + '</span>' +
      (ev.age_restriction ? '<span class="separator"></span><span>' + escapeHTML(ev.age_restriction) + '</span>' : '') +
      '</div>' +
      '<h3 class="card-name">' + escapeHTML(ev.name) + '</h3>' +
      '<div class="card-venue">' + escapeHTML(ev.venue) + '</div>' +
      '<div class="card-footer">' +
      '<div class="card-price">' + priceHTML + '</div>' +
      ticketHTML +
      '</div></div></article>';
  }

  // ================================================================
  // HELPERS
  // ================================================================
  function toDateStr(d) {
    return d.toISOString().slice(0, 10);
  }

  function addDays(d, n) {
    var r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function formatDateLabel(dateStr) {
    var now = new Date();
    var today = toDateStr(now);
    var tomorrow = toDateStr(addDays(now, 1));

    if (dateStr === today) return "Tonight";
    if (dateStr === tomorrow) return "Tomorrow";

    var d = new Date(dateStr + "T12:00:00");
    var days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    var diff = Math.floor((d - new Date(today + "T12:00:00")) / (1000 * 60 * 60 * 24));

    var prefix = "";
    if (diff >= 2 && diff <= 6) {
      prefix = "This ";
    } else if (diff >= 7 && diff <= 13) {
      prefix = "Next ";
    }

    return prefix + days[d.getDay()] + " &mdash; " + months[d.getMonth()] + " " + d.getDate();
  }

  function formatPrice(min, max, currency) {
    if (min === null && max === null) return '<span class="from">Price TBA</span>';
    if (min === 0 && (max === 0 || max === null)) return '<span style="color:var(--success);font-weight:600;">Free</span>';

    var fmt = function (v) {
      if (currency === "USD") return "$" + v.toFixed(0);
      return v.toFixed(0) + " " + currency;
    };

    if (min !== null && max !== null && min !== max) {
      return '<span class="from">From</span> ' + fmt(min) + '&ndash;' + fmt(max);
    }
    if (min !== null) {
      return '<span class="from">From</span> ' + fmt(min);
    }
    return '<span class="from">Up to</span> ' + fmt(max);
  }

  function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

})();
