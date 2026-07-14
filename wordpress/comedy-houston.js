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

  // Published comedian posts, injected by the PHP plugin. Each entry is
  // { date: "YYYY-MM-DD", comedian: "Mo Amer", wpLink: "https://..." }.
  // findComedianPostForEvent() below uses this to add a "More info" link
  // next to "Get Tickets" when an event matches a published post.
  var COMEDIAN_POSTS = Array.isArray(config.comedianPosts) ? config.comedianPosts : [];

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
  var typeFilter = scParams.type || "";

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
    // Check if server-rendered (SSR) content is already in the DOM
    var main = document.getElementById("chMain");
    var hasSSR = main && !main.querySelector("#chLoadingState");

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

    // Only re-render if we have fresh data, or if there's no SSR content to preserve
    if (allEvents.length > 0 || !hasSSR) {
      render();
    }
  }

  // ================================================================
  // TICKET URL BUILDER — routes through redirect for tracking
  // ================================================================
  // Keep in sync with is_allowed_ticket_url() in comedy-houston.php. The
  // redirect endpoint only forwards to these vendors, so anything else must
  // link directly — otherwise the click bounces back to the homepage.
  var ALLOWED_TICKET_HOSTS = /(^|\.)(ticketmaster\.(com|ca)|livenation\.com|eventbrite\.(com|ca)|ticketweb\.com|universe\.com)$/i;

  function isAllowedTicketUrl(url) {
    try {
      var a = document.createElement("a");
      a.href = url;
      return ALLOWED_TICKET_HOSTS.test(a.hostname);
    } catch (_) {
      return false;
    }
  }

  function buildTicketUrl(originalUrl) {
    if (!originalUrl) return "";
    // If tracking is enabled and we have a redirect base, route through it.
    // URL-safe base64 (- and _ instead of + and /, no padding): a literal
    // "+" in standard base64 becomes a space in the query string and the
    // redirect handler's strict decode used to fail on it.
    if (TRACK_CLICKS && REDIRECT_BASE && isAllowedTicketUrl(originalUrl)) {
      try {
        return REDIRECT_BASE + btoa(originalUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      } catch (_) {
        return originalUrl;
      }
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
    var friDate, satDate, sunDate;
    if (dayOfWeek === 0) {
      // Sunday: weekend = last Fri, last Sat, today
      friDate = toDateStr(addDays(now, -2));
      satDate = toDateStr(addDays(now, -1));
      sunDate = today;
    } else if (dayOfWeek === 6) {
      // Saturday: weekend = yesterday (Fri), today, tomorrow (Sun)
      friDate = toDateStr(addDays(now, -1));
      satDate = today;
      sunDate = tomorrow;
    } else if (dayOfWeek === 5) {
      // Friday: weekend = today, tomorrow (Sat), day after (Sun)
      friDate = today;
      satDate = tomorrow;
      sunDate = toDateStr(addDays(now, 2));
    } else {
      // Mon-Thu: weekend = upcoming Fri, Sat, Sun
      var daysToFri = 5 - dayOfWeek;
      friDate = toDateStr(addDays(now, daysToFri));
      satDate = toDateStr(addDays(now, daysToFri + 1));
      sunDate = toDateStr(addDays(now, daysToFri + 2));
    }

    var endOfWeek = toDateStr(addDays(now, 7 - dayOfWeek));
    var endOfMonth = toDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));

    var events = [];
    for (var i = 0; i < allEvents.length; i++) {
      var ev = allEvents[i];
      if (!ev.date) continue;
      if (ev.status === "cancelled") continue;

      // For weekend filter, allow past dates within the weekend window (Fri/Sat/Sun)
      // so a Sunday visitor still sees Friday & Saturday shows in "this weekend"
      if (currentTimeFilter === "weekend") {
        if (ev.date !== friDate && ev.date !== satDate && ev.date !== sunDate) continue;
      } else {
        if (ev.date < today) continue;
      }

      if (currentTimeFilter === "today" && ev.date !== today) continue;
      if (currentTimeFilter === "tomorrow" && ev.date !== tomorrow) continue;
      if (currentTimeFilter === "week" && ev.date > endOfWeek) continue;
      if (currentTimeFilter === "month" && ev.date > endOfMonth) continue;

      if (currentVenueFilter !== "all" && ev.venue !== currentVenueFilter) continue;
      if (currentSourceFilter !== "all" && ev.source !== currentSourceFilter) continue;
      var isOpenMic = ev.name && ev.name.toLowerCase().replace(/-/g, " ").indexOf("open mic") !== -1;
      if (!showOpenMic && isOpenMic) continue;
      if (typeFilter === "open_mic" && !isOpenMic) continue;

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

    // Times are 12-hour strings ("8:00 PM") so a string compare puts
    // "10:00 PM" before "8:00 PM" — compare minutes-since-midnight instead.
    function timeToMinutes(t) {
      if (!t) return 24 * 60 + 1;
      var m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) return 24 * 60 + 1;
      var h = parseInt(m[1], 10) % 12;
      if (/pm/i.test(m[3])) h += 12;
      return h * 60 + parseInt(m[2], 10);
    }
    if (currentSort === "date") {
      events.sort(function (a, b) {
        var dc = (a.date || "").localeCompare(b.date || "");
        return dc !== 0 ? dc : timeToMinutes(a.time) - timeToMinutes(b.time);
      });
    } else if (currentSort === "price-low") {
      // price_min === 0 is a real free show — `|| 9999` would sort it last.
      events.sort(function (a, b) {
        var ap = a.price_min == null ? 9999 : a.price_min;
        var bp = b.price_min == null ? 9999 : b.price_min;
        return ap - bp;
      });
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

    // Bind GA4 event tracking on "Get Tickets" links
    var ctaLinks = main.querySelectorAll("a.card-cta");
    for (var c = 0; c < ctaLinks.length; c++) {
      ctaLinks[c].addEventListener("click", handleTicketClick);
    }
  }

  // ================================================================
  // GA4 EVENT TRACKING — fires when visitor clicks "Get Tickets"
  // ================================================================
  function handleTicketClick(e) {
    var link = e.currentTarget;
    var card = link.closest(".event-card");
    if (!card) return;

    var eventName = (card.querySelector(".card-name") || {}).textContent || "Unknown";
    var venueName = (card.querySelector(".card-venue") || {}).textContent || "Unknown";
    var priceText = (card.querySelector(".card-price") || {}).textContent || "";

    // Fire GA4 event if gtag is available (injected by Site Kit)
    if (typeof gtag === "function") {
      gtag("event", "ticket_click", {
        event_category: "engagement",
        event_label: eventName,
        comedian_name: eventName,
        venue_name: venueName,
        price_info: priceText.trim(),
        outbound_url: link.href
      });
    }
  }

  // Fuzzy-match an event to a published comedian post. Exact date + the
  // comedian's name appearing as a substring of the event title. Kept in
  // sync with find_comedian_post_for_event() in comedy-houston.php.
  function findComedianPostForEvent(ev) {
    if (!ev || !ev.date || !ev.name || COMEDIAN_POSTS.length === 0) return null;
    var evDate = ev.date;
    var evNameLower = ev.name.toLowerCase();
    for (var i = 0; i < COMEDIAN_POSTS.length; i++) {
      var p = COMEDIAN_POSTS[i];
      if (p.date !== evDate) continue;
      var c = (p.comedian || "").toLowerCase();
      if (!c) continue;
      if (evNameLower.indexOf(c) !== -1) return p;
    }
    return null;
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

    // If we have an internal comedian post for this event, show a secondary
    // "More info" link. Keeps visitors on our site for the research content
    // before they click out to the ticket vendor.
    var matchedPost = findComedianPostForEvent(ev);
    var moreInfoHTML = "";
    if (matchedPost && matchedPost.wpLink) {
      moreInfoHTML = '<a class="card-cta card-cta-secondary" href="' +
        escapeAttr(matchedPost.wpLink) + '">More info</a>';
    }

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
      moreInfoHTML +
      ticketHTML +
      '</div></div></article>';
  }

  // ================================================================
  // HELPERS
  // ================================================================
  function toDateStr(d) {
    var y = d.getFullYear();
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var day = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + day;
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
