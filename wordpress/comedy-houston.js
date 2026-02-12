/**
 * Comedy Houston — WordPress Plugin JavaScript
 *
 * Fetches events.json from the GitHub repo and renders event cards
 * with filtering and sorting. Config is injected by the PHP plugin
 * via wp_localize_script as window.ComedyHoustonConfig.
 */
(function () {
  "use strict";

  // ================================================================
  // CONFIGURATION
  // ================================================================
  var config = window.ComedyHoustonConfig || {};
  var JSON_URL = config.jsonUrl ||
    "https://raw.githubusercontent.com/sanjmanak/show_lister/main/events.json";

  // ================================================================
  // APP STATE
  // ================================================================
  var allEvents = [];
  var currentTimeFilter = "all";
  var currentVenueFilter = "all";
  var currentSourceFilter = "all";
  var currentSort = "date";

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
    // Only run if the app container exists on this page
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
    bindEvents();
    render();
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

  function bindEvents() {
    // Time filters
    var timeButtons = document.querySelectorAll("#chTimeFilters .filter-btn");
    for (var i = 0; i < timeButtons.length; i++) {
      timeButtons[i].addEventListener("click", handleTimeFilter);
    }

    // Venue filter
    var venueEl = document.getElementById("chVenueFilter");
    if (venueEl) venueEl.addEventListener("change", function (e) {
      currentVenueFilter = e.target.value;
      render();
    });

    // Source filter
    var sourceEl = document.getElementById("chSourceFilter");
    if (sourceEl) sourceEl.addEventListener("change", function (e) {
      currentSourceFilter = e.target.value;
      render();
    });

    // Sort
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
      var e = allEvents[i];
      if (!e.date) continue;
      if (e.date < today) continue;
      if (e.status === "cancelled") continue;

      if (currentTimeFilter === "today" && e.date !== today) continue;
      if (currentTimeFilter === "tomorrow" && e.date !== tomorrow) continue;
      if (currentTimeFilter === "weekend") {
        if (e.date !== friDate && e.date !== satDate && e.date !== sunDate) continue;
      }
      if (currentTimeFilter === "week" && e.date > endOfWeek) continue;
      if (currentTimeFilter === "month" && e.date > endOfMonth) continue;

      if (currentVenueFilter !== "all" && e.venue !== currentVenueFilter) continue;
      if (currentSourceFilter !== "all" && e.source !== currentSourceFilter) continue;

      var maxDate = toDateStr(addDays(new Date(), 90));
      if (e.date > maxDate) continue;

      events.push(e);
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

    // Group by date
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

    var ticketHTML = ev.ticket_url
      ? '<a class="card-cta" href="' + escapeAttr(ev.ticket_url) + '" target="_blank" rel="noopener">' +
        'Get Tickets <span class="arrow">&rarr;</span></a>'
      : '<span class="card-cta" style="opacity:0.5;cursor:default;">Coming Soon</span>';

    return '<article class="event-card">' +
      '<div class="card-image">' + imageHTML +
      '<span class="card-source-badge ' + escapeAttr(ev.source) + '">' + escapeHTML(ev.source) + '</span>' +
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
