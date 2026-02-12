<?php
/**
 * Comedy Houston — HTML template rendered by the [comedy_houston] shortcode.
 * This file is included by comedy-houston.php inside the #ch-app wrapper div.
 * Do not load directly.
 */
if (!defined('ABSPATH')) exit;
?>

  <!-- HERO -->
  <div class="ch-hero">
    <h1 class="ch-hero-title">Every Comedy Show in Houston</h1>
    <p class="ch-hero-subtitle">Houston Improv, The Riot, Secret Group, Punch Line &amp; more — updated daily</p>
    <div class="ch-hero-meta">
      <span class="event-count" id="chEventCount">0 shows</span>
      <span id="chUpdatedAt"></span>
    </div>
  </div>

  <!-- FILTER CONTROLS -->
  <div class="controls" id="chControls">
    <div class="filter-group" id="chTimeFilters">
      <button class="filter-btn active" data-filter="all">All Shows</button>
      <button class="filter-btn" data-filter="today">Today</button>
      <button class="filter-btn" data-filter="tomorrow">Tomorrow</button>
      <button class="filter-btn" data-filter="weekend">This Weekend</button>
      <button class="filter-btn" data-filter="week">This Week</button>
      <button class="filter-btn" data-filter="month">This Month</button>
    </div>

    <div class="select-wrapper">
      <select id="chVenueFilter">
        <option value="all">All Venues</option>
      </select>
    </div>

    <div class="select-wrapper">
      <select id="chSourceFilter">
        <option value="all">All Sources</option>
        <option value="ticketmaster">Ticketmaster</option>
        <option value="eventbrite">Eventbrite</option>
      </select>
    </div>

    <div class="controls-spacer"></div>

    <span class="sort-label">Sort:</span>
    <div class="select-wrapper">
      <select id="chSortSelect">
        <option value="date">Date</option>
        <option value="price-low">Price: Low to High</option>
        <option value="price-high">Price: High to Low</option>
        <option value="name">Name A-Z</option>
      </select>
    </div>
  </div>

  <!-- MAIN EVENT LISTINGS -->
  <main class="ch-main" id="chMain">
    <div class="loading" id="chLoadingState">
      <div class="spinner"></div>
      <div class="loading-text">Loading shows...</div>
    </div>
  </main>

  <!-- FOOTER -->
  <div class="ch-footer">
    Updated automatically twice daily &middot; Data from
    <a href="https://www.ticketmaster.com" target="_blank" rel="noopener">Ticketmaster</a> &amp;
    <a href="https://www.eventbrite.com" target="_blank" rel="noopener">Eventbrite</a>
  </div>
