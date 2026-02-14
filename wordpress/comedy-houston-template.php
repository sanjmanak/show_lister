<?php
/**
 * Comedy Houston — HTML template rendered by the [comedy_houston] shortcode.
 * This file is included by comedy-houston.php inside the #ch-app wrapper div.
 * Do not load directly.
 *
 * Available variables (set by render_shortcode before include):
 *   $ch_show_hero         — bool — whether to render the hero banner
 *   $ch_show_controls     — bool — whether to render the filter toolbar
 *   $ch_show_footer       — bool — whether to render the data sources footer
 *   $ch_show_venue_filter — bool — whether to render the venue dropdown
 *   $ch_show_sort         — bool — whether to render the sort dropdown
 *   $ch_hero_title        — string — custom hero title (empty = default)
 *   $ch_ssr_html          — string — server-rendered event cards HTML (SEO)
 *   $ch_ssr_jsonld        — string — JSON-LD structured data for events
 *   $ch_ssr_count         — int    — number of server-rendered events
 *   $ch_ssr_updated_at    — string — formatted last-updated timestamp
 */
if (!defined('ABSPATH')) exit;
?>

  <?php if ($ch_show_hero): ?>
  <!-- HERO -->
  <div class="ch-hero">
    <h1 class="ch-hero-title"><?php echo esc_html($ch_hero_title ?: 'Every Comedy Show in Houston'); ?></h1>
    <p class="ch-hero-subtitle">Houston Improv, The Riot, Secret Group, Punch Line &amp; more — updated daily</p>
    <div class="ch-hero-meta">
      <span class="event-count" id="chEventCount"><?php echo (int) $ch_ssr_count; ?> show<?php echo $ch_ssr_count !== 1 ? 's' : ''; ?></span>
      <span id="chUpdatedAt"><?php if (!empty($ch_ssr_updated_at)) echo 'Updated ' . esc_html($ch_ssr_updated_at); ?></span>
    </div>
  </div>
  <?php endif; ?>

  <?php if ($ch_show_controls): ?>
  <!-- FILTER CONTROLS -->
  <div class="controls" id="chControls">
    <div class="controls-row">
      <div class="filter-group" id="chTimeFilters">
        <button class="filter-btn active" data-filter="all">All Shows</button>
        <button class="filter-btn" data-filter="today">Today</button>
        <button class="filter-btn" data-filter="tomorrow">Tomorrow</button>
        <button class="filter-btn" data-filter="weekend">This Weekend</button>
        <button class="filter-btn" data-filter="week">This Week</button>
        <button class="filter-btn" data-filter="month">This Month</button>
      </div>

      <?php if ($ch_show_sort): ?>
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
      <?php endif; ?>
    </div>

    <?php if ($ch_show_venue_filter): ?>
    <div class="controls-row">
      <div class="select-wrapper select-wrapper-venue">
        <select id="chVenueFilter">
          <option value="all">All Venues</option>
        </select>
      </div>
    </div>
    <?php endif; ?>
  </div>
  <?php endif; ?>

  <?php
  // JSON-LD structured data for Google rich results (Event schema)
  if (!empty($ch_ssr_jsonld)) {
      echo $ch_ssr_jsonld;
  }
  ?>

  <!-- MAIN EVENT LISTINGS -->
  <main class="ch-main" id="chMain">
    <?php if (!empty($ch_ssr_html)): ?>
      <?php // Server-rendered events — visible to Googlebot and users before JS loads ?>
      <?php echo $ch_ssr_html; ?>
    <?php else: ?>
      <div class="loading" id="chLoadingState">
        <div class="spinner"></div>
        <div class="loading-text">Loading shows...</div>
      </div>
    <?php endif; ?>
  </main>

  <?php if ($ch_show_footer): ?>
  <!-- FOOTER -->
  <div class="ch-footer">
    Updated automatically twice daily &middot; Data from
    <a href="https://www.ticketmaster.com" target="_blank" rel="noopener">Ticketmaster</a> &amp;
    <a href="https://www.eventbrite.com" target="_blank" rel="noopener">Eventbrite</a>
  </div>
  <?php endif; ?>
