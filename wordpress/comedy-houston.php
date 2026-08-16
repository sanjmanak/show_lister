<?php
/**
 * Plugin Name: Comedy Houston Shows
 * Description: Displays Houston comedy event listings with configurable theme and affiliate click tracking.
 * Version: 2.13.0
 * Author: Comedy Houston
 *
 * INSTALLATION:
 *   1. Upload this entire "comedy-houston" folder to /wp-content/plugins/
 *      (so the path is /wp-content/plugins/comedy-houston/comedy-houston.php)
 *   2. Activate the plugin in WordPress Admin → Plugins
 *   3. Go to Settings → Comedy Houston to configure theme and affiliate IDs
 *   4. On any page, add the shortcode: [comedy_houston]
 */

if (!defined('ABSPATH')) {
    exit;
}

class Comedy_Houston_Plugin {

    const VERSION      = '2.13.0';
    const SHORTCODE    = 'comedy_houston';
    const OPTION_KEY   = 'comedy_houston_settings';
    const REDIRECT_VAR = 'ch_go';
    const CLICKS_TABLE = 'ch_clicks';

    // Meta Pixel — deliberately the SAME pixel as sanjaycomedy.com and the
    // Eventbrite listings so purchase/visit signal pools into one audience
    // (per-property segmentation is done with URL rules in Ads Manager).
    // Emitted from wp_head by this plugin instead of a third-party pixel
    // module so the custom conversions (TicketClick, Lead) can fire from the
    // same code paths as the GA4 events. Empty string disables everything.
    const META_PIXEL_ID = '822551924791710';

    private $defaults = [
        'github_user'         => 'sanjmanak',
        'repo'                => 'show_lister',
        'color_scheme'        => 'dark',
        'show_source_badges'  => '1',
        'tm_affiliate'        => '',
        'eb_affiliate'        => '',
        'track_clicks'        => '1',
        'org_name'            => 'Comedy Houston',
        'org_logo'            => '',
        // One URL per line — social profiles for Organization sameAs.
        'org_sameas'          => "https://www.instagram.com/comedyhoustontx/",
    ];

    public function __construct() {
        // Front-end
        add_shortcode(self::SHORTCODE, [$this, 'render_shortcode']);
        add_action('wp_enqueue_scripts', [$this, 'register_assets']);

        // Admin settings page
        add_action('admin_menu', [$this, 'add_settings_page']);
        add_action('admin_init', [$this, 'register_settings']);

        // Click redirect endpoint
        add_action('init', [$this, 'register_redirect_endpoint']);
        add_action('template_redirect', [$this, 'handle_redirect']);

        // Cache-Control for pages containing the shortcode: the listings are
        // date-dependent ("Tonight"/"Tomorrow" labels, today/weekend filters
        // computed server-side at render time), so any cached copy must
        // expire at midnight America/Chicago or crawlers see yesterday's
        // shows. Sent from template_redirect (before any output) rather than
        // the shortcode, where headers may already be gone.
        add_action('template_redirect', [$this, 'send_cache_headers'], 5);

        // 301 the retired dated weekly roundups (/houston-comedy-shows-this-
        // week-YYYY-MM-DD/) to the evergreen /this-week/ page. The generator
        // no longer publishes dated posts; this consolidates the ~20 existing
        // ones' signals onto the page that stays. Runs before send_cache_headers
        // so the redirect wins even while the old posts still exist in WP.
        add_action('template_redirect', [$this, 'redirect_dated_weekly_posts'], 4);

        // Cache invalidation. Cache-Control alone can't fix a full-page cache
        // (LiteSpeed) that serves HTML without ever running PHP — the twice-
        // daily data import was updating events.json while cached listing
        // pages kept rendering days-old shows under "Tonight". Two paths:
        //   1. REST POST /wp-json/comedy-houston/v1/refresh — fired by the
        //      update-events GitHub Action right after it pushes new data
        //      (authenticated with the same application password the other
        //      publishing scripts use). Refetches events.json and purges.
        //   2. Hourly WP-cron fallback — refetches, compares a content hash,
        //      and purges only when the data actually changed (covers the
        //      case where the webhook isn't configured or fails).
        add_action('rest_api_init', [$this, 'register_refresh_route']);
        add_action('init', [$this, 'maybe_schedule_refresh_cron']);
        add_action('comedy_houston_refresh_events', [$this, 'cron_refresh_events']);
        register_deactivation_hook(__FILE__, [$this, 'clear_refresh_cron']);

        // Corporate booking inquiry form ([comedy_houston_inquiry]) — an
        // actual fillable form for the clean-comedy page, replacing the
        // mailto: dead-end. Submissions are validated (token + honeypot +
        // per-IP rate limit) and emailed to the inquiry address; the client
        // fires a GA4 `corporate_inquiry` event on success.
        add_shortcode('comedy_houston_inquiry', [$this, 'render_inquiry_form']);
        add_action('rest_api_init', [$this, 'register_inquiry_routes']);

        // Per-post noindex. The comedian-post generator marks its posts
        // ch_noindex; ~90 near-template preview posts were a sitewide
        // quality drag (all impressions, zero clicks). Posts stay live for
        // Instagram and the event cards' "More info" links — they just stop
        // being indexable. Add a ch_allow_index custom field (value 1) in WP
        // admin to re-index a post that earns real clicks; it wins over
        // ch_noindex so the generator can't flip it back.
        add_action('rest_api_init', [$this, 'register_noindex_fields']);
        add_action('wp_head', [$this, 'emit_noindex_meta'], 0);

        // Keep crawlers away from ?ch_go= redirect URLs (crawl budget).
        // Only affects WordPress's virtual robots.txt — if a physical
        // robots.txt file exists on the server, this filter never runs and
        // the disallow rules must be added to that file by hand.
        add_filter('robots_txt', [$this, 'filter_robots_txt'], 10, 2);

        // Comedian-post schema: receive via REST custom field, emit from wp_head.
        // Keeps the <script type="application/ld+json"> tag out of post_content
        // entirely so wp_kses_post can't strip it on publish and so content
        // edits in Gutenberg can't corrupt the JSON graph.
        add_action('rest_api_init', [$this, 'register_comedian_schema_field']);
        add_action('wp_head', [$this, 'emit_comedian_schema_head'], 20);

        // Site-wide Organization JSON-LD (skipped when an SEO plugin that
        // already emits Organization schema is active).
        add_action('wp_head', [$this, 'emit_organization_schema'], 5);

        // Per-page SEO title/description (set via REST by the landing-page
        // sync script; skipped when an SEO plugin is active).
        add_action('rest_api_init', [$this, 'register_page_seo_fields']);
        add_filter('pre_get_document_title', [$this, 'filter_document_title'], 20);
        add_action('wp_head', [$this, 'emit_meta_description'], 1);

        // Meta Pixel base code (PageView) — custom events fire from
        // comedy-houston.js (TicketClick, performer Lead) and the corporate
        // inquiry form (Lead).
        add_action('wp_head', [$this, 'emit_meta_pixel'], 7);

        // Live dates in titles/H1s ({weekend_range} etc — see
        // expand_date_tokens). The SEO-plugin filters below only ever fire
        // on sites running that plugin, and each is a no-op on a string
        // with no token, so registering all of them is free.
        add_filter('the_title', [$this, 'filter_entry_title'], 20, 2);

        // "This show has already happened" banner on dated event posts.
        add_filter('the_content', [$this, 'prepend_past_event_notice'], 20);
        add_filter('wpseo_title', [$this, 'filter_seo_plugin_title'], 20);
        add_filter('rank_math/frontend/title', [$this, 'filter_seo_plugin_title'], 20);
        add_filter('aioseo_title', [$this, 'filter_seo_plugin_title'], 20);
        add_filter('seopress_titles_title', [$this, 'filter_seo_plugin_title'], 20);
        add_filter('wpseo_metadesc', [$this, 'filter_seo_plugin_description'], 20);
        add_filter('rank_math/frontend/description', [$this, 'filter_seo_plugin_description'], 20);

        // Keep the SEO plugin's robots directives and XML sitemap in
        // agreement with our ch_noindex flag — see force_noindex_robots().
        add_filter('rank_math/frontend/robots', [$this, 'force_noindex_robots'], 20);
        add_filter('wpseo_robots_array', [$this, 'force_noindex_robots_list'], 20);
        add_filter('rank_math/sitemap/entry', [$this, 'exclude_noindexed_from_sitemap'], 20, 3);

        // Create clicks table on activation
        register_activation_hook(__FILE__, [$this, 'create_clicks_table']);
    }

    // =========================================================================
    // OPTIONS HELPERS
    // =========================================================================

    public function get_options() {
        return wp_parse_args(get_option(self::OPTION_KEY, []), $this->defaults);
    }

    // =========================================================================
    // FRONT-END ASSETS
    // =========================================================================

    public function register_assets() {
        wp_register_style(
            'comedy-houston-style',
            plugin_dir_url(__FILE__) . 'comedy-houston.css',
            [],
            self::VERSION
        );

        wp_register_script(
            'comedy-houston-app',
            plugin_dir_url(__FILE__) . 'comedy-houston.js',
            [],
            self::VERSION,
            true
        );
    }

    // =========================================================================
    // SHORTCODE
    // =========================================================================

    public function render_shortcode($atts) {
        $opts = $this->get_options();

        $atts = shortcode_atts([
            'theme'         => '',
            'filter'        => 'all',
            'max_price'     => '',
            'venue'         => '',
            'source'        => '',
            'title'         => '',
            'show_hero'         => 'true',
            'show_controls'     => 'true',
            'show_footer'       => 'true',
            'show_venue_filter' => 'true',
            'show_sort'         => 'true',
            'show_open_mic'     => 'true',
            'type'              => '',
            // Curated tag filter (config/show-tags.json → events.json tags[]),
            // e.g. [comedy_houston tag="black-comedy"].
            'tag'               => '',
            // Initial render window in days for the unfiltered ("all") view.
            // The full list (hundreds of events through +90 days) is only
            // rendered after the visitor clicks "Show all". 0 disables.
            'initial_days'      => '14',
        ], $atts, self::SHORTCODE);

        $scheme = !empty($atts['theme']) ? $atts['theme'] : $opts['color_scheme'];

        wp_enqueue_style('comedy-houston-style');
        wp_enqueue_script('comedy-houston-app');

        // Build redirect base URL for affiliate click tracking
        $redirect_base = home_url('/') . '?' . self::REDIRECT_VAR . '=';

        // Shortcode filter params passed to JS
        $shortcode_params = [
            'filter'   => sanitize_text_field($atts['filter']),
            'maxPrice' => $atts['max_price'] !== '' ? floatval($atts['max_price']) : null,
            'venue'    => sanitize_text_field($atts['venue']),
            'source'   => sanitize_text_field($atts['source']),
            'showOpenMic' => strtolower($atts['show_open_mic']) !== 'false',
            'type' => sanitize_text_field($atts['type']),
            'tag' => sanitize_text_field($atts['tag']),
            'initialDays' => max(0, intval($atts['initial_days'])),
        ];

        // Fetch the manifest once so we can (a) pass a slug-lookup map into
        // the JS config for client-side rendering, and (b) pass the raw posts
        // array into the SSR renderer for Googlebot. Missing/404 manifest is
        // fine — both render paths fall back to the old "Get Tickets only" UI.
        $manifest_posts = $this->fetch_manifest_data();

        // Build a compact lookup structure for JS: array of { date, comedian,
        // wpLink } tuples. Keeping it small so the inline script stays under
        // a few KB even with ~20 posts on disk.
        $js_comedian_posts = [];
        foreach ($manifest_posts as $p) {
            if (empty($p['date']) || empty($p['comedianName']) || empty($p['wpLink'])) continue;
            $js_comedian_posts[] = [
                'date' => $p['date'],
                'comedian' => $p['comedianName'],
                'wpLink' => $p['wpLink'],
            ];
        }

        // Use wp_add_inline_script for proper type handling (null, bool, numbers)
        $js_config = [
            'jsonUrl'         => sprintf(
                'https://raw.githubusercontent.com/%s/%s/main/events.json',
                sanitize_text_field($opts['github_user']),
                sanitize_text_field($opts['repo'])
            ),
            'colorScheme'     => sanitize_text_field($scheme),
            'trackClicks'      => (bool) $opts['track_clicks'],
            'showSourceBadges' => (bool) $opts['show_source_badges'],
            'redirectBase'     => esc_url($redirect_base),
            'shortcodeParams'  => $shortcode_params,
            'comedianPosts'    => $js_comedian_posts,
            'venuePages'       => $this->build_venue_pages_map(),
            // Performer-booking MVP endpoints (PERFORMER_REQUESTS.md).
            'performerEndpoint' => esc_url_raw(rest_url('comedy-houston/v1/performer-interest')),
            'performerTokenUrl' => esc_url_raw(rest_url('comedy-houston/v1/performer-token')),
        ];

        wp_add_inline_script(
            'comedy-houston-app',
            'window.ComedyHoustonConfig = ' . wp_json_encode($js_config) . ';',
            'before'
        );

        // Server-side render events for SEO (content visible to Googlebot without JS)
        $events_data = $this->fetch_events_data();
        $ch_ssr_html = '';
        $ch_ssr_jsonld = '';
        $ch_ssr_count = 0;
        $ch_ssr_updated_at = '';

        if ($events_data && !empty($events_data['events'])) {
            $filtered = $this->filter_events($events_data['events'], $atts);
            $ch_ssr_count = count($filtered);

            // Cap the initial "all" render to the next N days; the tail is
            // revealed by the "Show all" button (JS). JSON-LD below still
            // covers the full filtered list so schema is not affected.
            $initial_days = max(0, intval($atts['initial_days']));
            $ssr_events = $filtered;
            if ($initial_days > 0 && $atts['filter'] === 'all') {
                $cutoff = $this->houston_date('Y-m-d', '+' . $initial_days . ' days');
                $windowed = array_values(array_filter($filtered, function ($ev) use ($cutoff) {
                    return ($ev['date'] ?? '') <= $cutoff;
                }));
                // Don't window down to an empty page (e.g. a quiet fortnight).
                if (!empty($windowed) && count($windowed) < count($filtered)) {
                    $ssr_events = $windowed;
                }
            }

            $ch_ssr_html = $this->render_ssr_html($ssr_events, $opts, $redirect_base, $manifest_posts);
            if (count($ssr_events) < $ch_ssr_count) {
                $ch_ssr_html .= '<div class="ch-show-all-wrap"><button type="button" class="ch-show-all-btn">'
                    . 'Show all ' . (int) $ch_ssr_count . ' upcoming shows</button></div>';
            }
            $ch_ssr_jsonld = $this->render_jsonld($filtered);
            if (!empty($events_data['last_updated'])) {
                $ts = strtotime($events_data['last_updated']);
                if ($ts) {
                    $ch_ssr_updated_at = $this->houston_date_from_ts('M j, g:i A', $ts);
                }
            }
        }

        // Template visibility flags (available in the included template file)
        $ch_show_hero         = strtolower($atts['show_hero']) !== 'false';
        $ch_show_controls     = strtolower($atts['show_controls']) !== 'false';
        $ch_show_footer       = strtolower($atts['show_footer']) !== 'false';
        $ch_show_venue_filter = strtolower($atts['show_venue_filter']) !== 'false';
        $ch_show_sort         = strtolower($atts['show_sort']) !== 'false';
        $ch_hero_title        = sanitize_text_field($atts['title']);

        ob_start();
        // Output the theme class on the wrapper so CSS can switch palettes
        echo '<div id="ch-app" class="ch-theme-' . esc_attr($scheme) . '">';
        include plugin_dir_path(__FILE__) . 'comedy-houston-template.php';
        echo '</div>';
        return ob_get_clean();
    }

    // =========================================================================
    // CLICK REDIRECT & TRACKING
    // =========================================================================

    public function register_redirect_endpoint() {
        // No rewrite rules needed — we use a query param ?ch_go=BASE64
    }

    /**
     * Cache-Control for event-listing pages, expiring at the next midnight
     * in America/Chicago. Applies to any singular page/post whose content
     * contains the [comedy_houston] shortcode. NOTE: host/plugin full-page
     * caches that ignore Cache-Control must exclude /tonight/ and
     * /this-weekend/ manually — see the README.
     */
    public function send_cache_headers() {
        if (headers_sent() || is_admin() || !is_singular()) {
            return;
        }
        $post = get_queried_object();
        if (!$post || empty($post->post_content) || !has_shortcode($post->post_content, self::SHORTCODE)) {
            return;
        }
        try {
            $tz = new DateTimeZone('America/Chicago');
            $now = new DateTime('now', $tz);
            $midnight = new DateTime('tomorrow midnight', $tz);
        } catch (Exception $e) {
            return;
        }
        // Expire at the next Central midnight (the "Tonight"/"Tomorrow"
        // labels roll over then), capped at 6 hours as a staleness safety
        // net: the data import lands twice daily, so even if the purge
        // webhook and cron both fail, no cache may outlive the next import
        // by more than a few hours.
        $max_age = max(60, $midnight->getTimestamp() - $now->getTimestamp());
        $max_age = min($max_age, 6 * HOUR_IN_SECONDS);
        header('Cache-Control: public, max-age=' . $max_age . ', s-maxage=' . $max_age);
    }

    /**
     * 301 the retired dated weekly roundup posts to the evergreen
     * /this-week/ page. The weekly generator no longer creates dated posts
     * (each one duplicated /this-week/ for its seven days of relevance, then
     * became permanent thin-content cannibalizing the evergreen URL); this
     * consolidates the existing archive's signals without touching WP admin.
     * The old posts can be deleted at leisure — the redirect fires before
     * WordPress resolves the request either way.
     */
    public function redirect_dated_weekly_posts() {
        if (is_admin() || empty($_SERVER['REQUEST_URI'])) {
            return;
        }
        $path = wp_parse_url(wp_unslash($_SERVER['REQUEST_URI']), PHP_URL_PATH);
        if (!$path) {
            return;
        }

        if (preg_match('#^/houston-comedy-shows-this-week-\d{4}-\d{2}-\d{2}/?$#', $path)) {
            wp_safe_redirect(home_url('/this-week/'), 301);
            exit;
        }

        // Legacy open-mic URLs → the canonical /open-mic-comedy-houston/
        // page. Three open-mic URLs were briefly live simultaneously (the
        // original /open-mics/ landing page, the old blog post, and the new
        // canonical page), splitting internal links and rankings three ways.
        // The redirect wins even while the old page/post still exist in WP —
        // they can be trashed at leisure.
        $legacy = [
            '/open-mics'                   => '/open-mic-comedy-houston/',
            '/every-open-mic-night-houston' => '/open-mic-comedy-houston/',
            // Straight duplicate of /this-weekend/: same 31-event ItemList,
            // both self-canonical, both indexable. Two URLs don't stack the
            // keyword — Google picks one per site and flips between them,
            // splitting whatever links either earns. /this-weekend/ wins on
            // internal links (it's in the nav; nothing links to this post,
            // not even the post itself) and now carries the dated title that
            // was this URL's only real advantage.
            '/houston-comedy-shows-this-weekend' => '/this-weekend/',
        ];
        $trimmed = rtrim($path, '/');
        if (isset($legacy[$trimmed])) {
            wp_safe_redirect(home_url($legacy[$trimmed]), 301);
            exit;
        }
    }

    public function handle_redirect() {
        if (empty($_GET[self::REDIRECT_VAR])) {
            return;
        }

        // Every ?ch_go= URL is a tracking redirect — it must never be indexed
        // (each base64 payload is a unique URL, so crawlers would otherwise
        // burn crawl budget on thousands of duplicate redirect URLs).
        if (!headers_sent()) {
            header('X-Robots-Tag: noindex, nofollow', true);
        }

        $payload = sanitize_text_field(wp_unslash($_GET[self::REDIRECT_VAR]));
        // Tolerant decode. Links are generated URL-safe (- and _ instead of
        // + and /), but older cached pages still carry standard base64 where
        // a literal "+" arrives here as a space after query-string parsing —
        // that single character used to fail the strict decode and bounce
        // the visitor back to the homepage instead of the ticket page.
        $payload = str_replace(' ', '+', $payload);
        $payload = strtr($payload, '-_', '+/');
        $pad = strlen($payload) % 4;
        if ($pad) {
            $payload .= str_repeat('=', 4 - $pad);
        }
        $decoded = base64_decode($payload, true);

        if ($decoded === false || !filter_var($decoded, FILTER_VALIDATE_URL)) {
            wp_safe_redirect(home_url('/'));
            exit;
        }

        // Scheme allowlist: only http/https. FILTER_VALIDATE_URL alone accepts
        // javascript:, data:, file:, etc. — any of which would turn this
        // endpoint into an open redirect / XSS vector.
        if (!preg_match('~^https?://~i', $decoded)) {
            wp_safe_redirect(home_url('/'));
            exit;
        }

        // Host allowlist: only redirect to known ticket vendors. Anything
        // else could be abused to launder phishing links through our
        // domain's reputation.
        if (!$this->is_allowed_ticket_url($decoded)) {
            wp_safe_redirect(home_url('/'));
            exit;
        }

        $target_url = $decoded;
        $opts = $this->get_options();

        // Append affiliate parameters based on source domain
        if (!empty($opts['tm_affiliate']) && strpos($target_url, 'ticketmaster.com') !== false) {
            $target_url = add_query_arg('at_aid', $opts['tm_affiliate'], $target_url);
        }
        if (!empty($opts['eb_affiliate']) && strpos($target_url, 'eventbrite.com') !== false) {
            $target_url = add_query_arg('aff', $opts['eb_affiliate'], $target_url);
        }

        // Log the click. Rate-limited per client: this is an unauthenticated
        // endpoint doing a DB INSERT per hit, so an abuser could flood the
        // clicks table. Past the cap the redirect still works — we just stop
        // recording.
        if ($opts['track_clicks'] && !$this->click_rate_limited()) {
            $this->log_click($decoded, $target_url);
        }

        // Redirect — use wp_redirect since it's an external URL
        wp_redirect(esc_url_raw($target_url), 302);
        exit;
    }

    /**
     * Append ?ch_go= disallow rules to WordPress's virtual robots.txt.
     * Every redirect payload is a unique URL; without this, crawlers spend
     * their budget on thousands of 302s instead of real content pages.
     */
    public function filter_robots_txt($output, $public) {
        if (!$public) {
            return $output;
        }
        $rules = "\n# Comedy Houston: ticket-click redirect URLs (tracking 302s, not content)\n"
            . "User-agent: *\n"
            . "Disallow: /?ch_go=\n"
            . "Disallow: /*?ch_go=\n"
            . "Disallow: /*&ch_go=\n";
        return $output . $rules;
    }

    /**
     * Ticket vendors the ?ch_go= redirect will forward to. Subdomain-safe
     * match (ends-with check after a literal dot so "notticketmaster.com"
     * does not pass). Keep in sync with ALLOWED_TICKET_HOSTS in
     * comedy-houston.js — any vendor missing from this list gets a direct
     * link at render time instead of a tracked redirect, so clicks never
     * dead-end on the homepage.
     */
    private function is_allowed_ticket_url($url) {
        if (!preg_match('~^https?://~i', $url)) {
            return false;
        }
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $allowed_hosts = [
            'ticketmaster.com',
            'ticketmaster.ca',
            'livenation.com',
            'eventbrite.com',
            'eventbrite.ca',
            'ticketweb.com',
            'universe.com',
        ];
        foreach ($allowed_hosts as $allowed) {
            if ($host === $allowed) {
                return true;
            }
            $suffix = '.' . $allowed;
            if (strlen($host) > strlen($suffix) && substr($host, -strlen($suffix)) === $suffix) {
                return true;
            }
        }
        return false;
    }

    /**
     * True when this client (hashed IP) has already logged 30 clicks inside
     * the current 60-second window. A real visitor clicks a handful of
     * ticket links per session; 30/min is only reachable by a script.
     */
    private function click_rate_limited() {
        $key = 'ch_clkrl_' . substr($this->get_hashed_ip(), 0, 24);
        $count = (int) get_transient($key);
        if ($count >= 30) {
            return true;
        }
        set_transient($key, $count + 1, MINUTE_IN_SECONDS);
        return false;
    }

    private function log_click($original_url, $final_url) {
        global $wpdb;
        $table = $wpdb->prefix . self::CLICKS_TABLE;

        // Only log if table exists
        if ($wpdb->get_var($wpdb->prepare("SHOW TABLES LIKE %s", $table)) !== $table) {
            return;
        }

        $wpdb->insert($table, [
            'clicked_at'   => current_time('mysql'),
            'original_url' => $original_url,
            'final_url'    => $final_url,
            'user_ip'      => $this->get_hashed_ip(),
            'user_agent'   => isset($_SERVER['HTTP_USER_AGENT']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_USER_AGENT'])) : '',
            'referer'      => isset($_SERVER['HTTP_REFERER']) ? esc_url_raw(wp_unslash($_SERVER['HTTP_REFERER'])) : '',
        ], ['%s', '%s', '%s', '%s', '%s', '%s']);
    }

    private function get_hashed_ip() {
        $ip = '';
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ip = sanitize_text_field(wp_unslash($_SERVER['HTTP_X_FORWARDED_FOR']));
            $ip = explode(',', $ip)[0];
        } elseif (!empty($_SERVER['REMOTE_ADDR'])) {
            $ip = sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR']));
        }
        // Hash the IP for privacy
        return wp_hash(trim($ip));
    }

    // =========================================================================
    // COMEDIAN POST SCHEMA (REST field + wp_head emitter)
    // =========================================================================

    /**
     * Register a writable REST field `ch_schema_graph` on posts. The per-comedian
     * blog generator POSTs the schema.org @graph as a JSON-encoded string on
     * this field when it creates/updates a comedy-shows post; we store it in
     * post meta and emit it from wp_head on the front-end.
     *
     * Why this exists: the prior architecture prepended a <script type="application/ld+json">
     * tag to post_content. That tag was silently stripped by wp_kses_post() on
     * the WordPress REST write path unless the API user held the unfiltered_html
     * capability (Administrator on single-site WP). Routing schema through
     * post meta removes the capability dependency entirely — any role that
     * can create/edit the post can set the field, and the raw <script> tag
     * never touches post_content so it can't be stripped or corrupted by
     * later Gutenberg saves.
     *
     * WP core already enforces edit_post at the post level for REST writes,
     * so we don't need a separate permission_callback here — if the caller
     * can PATCH/POST the post, they can set this field.
     */
    public function register_comedian_schema_field() {
        // Registered for posts (comedian/roundup schema) AND pages (venue
        // pages carry LocalBusiness schema through the same field).
        register_rest_field(['post', 'page'], 'ch_schema_graph', [
            'schema' => [
                'description' => 'Schema.org @graph JSON for this comedian post (JSON-encoded string).',
                'type'        => 'string',
                'context'     => ['view', 'edit'],
            ],
            'get_callback' => function ($post_arr) {
                $val = get_post_meta($post_arr['id'], '_ch_schema_graph', true);
                return is_string($val) ? $val : '';
            },
            'update_callback' => function ($value, $post) {
                if (!is_string($value)) {
                    return new WP_Error(
                        'ch_schema_invalid_type',
                        'ch_schema_graph must be a JSON-encoded string.',
                        ['status' => 400]
                    );
                }
                // Hard cap at 64KB. A realistic ComedyEvent @graph is ~2KB;
                // 64KB is ~30× headroom and prevents a runaway writer from
                // ballooning post_meta.
                if (strlen($value) > 65536) {
                    return new WP_Error(
                        'ch_schema_too_large',
                        'ch_schema_graph exceeds the 64KB limit.',
                        ['status' => 400]
                    );
                }
                // Validate it actually parses as JSON — refuse to save
                // garbage that would produce broken JSON-LD in <head>.
                $decoded = json_decode($value, true);
                if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
                    return new WP_Error(
                        'ch_schema_invalid_json',
                        'ch_schema_graph is not valid JSON: ' . json_last_error_msg(),
                        ['status' => 400]
                    );
                }
                update_post_meta($post->ID, '_ch_schema_graph', $value);
                return true;
            },
        ]);
    }

    /**
     * Emit the stored schema.org @graph for comedian posts on the front-end.
     * Fires on wp_head for singular `post` views in the comedy-shows category
     * and echoes a <script type="application/ld+json"> block using the JSON
     * stashed in post meta by the REST update_callback above.
     *
     * Posts without the meta set (legacy posts predating this refactor, or
     * non-comedy-shows posts that happen to be in the loop) produce zero
     * output — the emitter stays silent rather than emitting an empty tag.
     * During the belt-and-suspenders transition, those legacy posts still
     * carry schema via the in-body prepend from the generator, so coverage
     * never drops below the current baseline.
     */
    // -------------------------------------------------------------------------
    // PAST-EVENT HANDLING
    // -------------------------------------------------------------------------

    /**
     * schema.org node types this plugin treats as events.
     */
    private static $event_types = ['Event', 'ComedyEvent', 'TheaterEvent'];

    private function is_event_node($node) {
        if (!is_array($node) || empty($node['@type'])) return false;
        $types = (array) $node['@type'];
        foreach ($types as $t) {
            if (in_array($t, self::$event_types, true)) return true;
        }
        return false;
    }

    /** Unix time of a node's start, or null when unparseable. */
    private function event_start_ts($node) {
        if (!is_array($node) || empty($node['startDate'])) return null;
        $ts = strtotime((string) $node['startDate']);
        return $ts === false ? null : $ts;
    }

    /**
     * Has the show begun? Governs `offers`: once doors are open, tickets are
     * not "InStock", and an Offer with availability InStock on a past
     * startDate is the exact condition Google Search Console reports as an
     * error. Left unfixed it doesn't just flag the one URL — repeated
     * invalid event markup is how a domain's event data stops being trusted.
     */
    private function event_has_started($node) {
        $ts = $this->event_start_ts($node);
        return $ts !== null && $ts < time();
    }

    /**
     * Has the show finished? A separate, later threshold from
     * event_has_started() on purpose: at 8:05pm on the night, tickets are
     * genuinely gone but "This show has already happened" would be a lie to
     * a reader standing outside the venue. Offers go at the start; the
     * banner waits for the end.
     */
    private function event_has_finished($node) {
        $start = $this->event_start_ts($node);
        if ($start === null) return false;
        $end = !empty($node['endDate']) ? strtotime((string) $node['endDate']) : false;
        if ($end === false) {
            $end = $start + (3 * HOUR_IN_SECONDS);
        }
        return $end < time();
    }

    /**
     * Remove `offers` from every event node whose start time has passed.
     *
     * This runs at render time rather than in generate-comedian-post.js
     * deliberately. The generator writes the graph once, at publish, when
     * the offers are accurate — a fix there would only protect posts made
     * from that day forward and would leave every already-published post
     * emitting InStock forever, needing a backfill over the whole archive.
     * Guarding on output fixes the entire back catalogue at once and keeps
     * working as each future show ages out, with no scheduled job to fail.
     *
     * `eventStatus` is deliberately left as EventScheduled: the show was
     * scheduled and it happened. EventCancelled/EventPostponed would be a
     * factual claim about a show that went ahead.
     */
    private function strip_past_event_offers($graph) {
        if (!is_array($graph)) return $graph;

        if (isset($graph['@graph']) && is_array($graph['@graph'])) {
            foreach ($graph['@graph'] as $i => $node) {
                if ($this->is_event_node($node) && $this->event_has_started($node)) {
                    unset($graph['@graph'][$i]['offers']);
                }
            }
            // Re-index: json_encode turns an array with gaps into an object,
            // which would silently change @graph from a list to a map.
            $graph['@graph'] = array_values($graph['@graph']);
            return $graph;
        }

        if ($this->is_event_node($graph) && $this->event_has_started($graph)) {
            unset($graph['offers']);
        }
        return $graph;
    }

    /**
     * The event node of the currently queried post, if it has one.
     */
    private function post_event_node($post_id) {
        $json = get_post_meta($post_id, '_ch_schema_graph', true);
        if (!is_string($json) || $json === '') return null;
        $decoded = json_decode($json, true);
        if (!is_array($decoded)) return null;
        $nodes = isset($decoded['@graph']) && is_array($decoded['@graph'])
            ? $decoded['@graph']
            : [$decoded];
        foreach ($nodes as $node) {
            if ($this->is_event_node($node)) return $node;
        }
        return null;
    }

    /**
     * Prepend a "this show has passed" banner to a dated event post whose
     * show is over.
     *
     * Without it these posts stay in the present tense — "This August, he
     * brings his sharp, observational humor to the Houston Improv" — for a
     * show that happened last week, which reads as an abandoned site to a
     * visitor and to a quality rater. The banner also turns each dead end
     * into a link to /tonight/, which is the page we actually want ranking.
     */
    public function prepend_past_event_notice($content) {
        if (is_admin() || !is_singular('post') || !in_the_loop() || !is_main_query()) {
            return $content;
        }
        $post_id = get_the_ID();
        if (!$post_id) return $content;

        $node = $this->post_event_node($post_id);
        if (!$node || !$this->event_has_finished($node)) {
            return $content;
        }

        $start = $this->event_start_ts($node);
        $when  = $start ? $this->houston_date_from_ts('l, F j, Y', $start) : '';

        // Inline styles rather than a class: the plugin stylesheet is only
        // enqueued on pages carrying the shortcode, and these posts don't.
        // Colours are explicit so the banner reads on any theme.
        $notice =
            '<div style="border-left:4px solid #ff5e62;background:#fff5f5;color:#1a1a1a;'
            . 'padding:16px 20px;margin:0 0 24px;border-radius:4px;font-size:16px;line-height:1.5;">'
            . '<strong>This show has already happened.</strong>'
            . ($when ? ' <span style="color:#555;">It was on ' . esc_html($when) . '.</span>' : '')
            . '<br><a href="' . esc_url(home_url('/tonight/')) . '" style="color:#c0392b;font-weight:600;">'
            . 'See every comedy show in Houston tonight →</a>'
            . '</div>';

        return $notice . $content;
    }

    public function emit_comedian_schema_head() {
        if (!is_singular(['post', 'page'])) {
            return;
        }
        $post = get_queried_object();
        if (!$post || empty($post->ID)) {
            return;
        }
        // Posts: scope to the comedy-shows category so we don't pollute the
        // schema graph of unrelated posts that might end up with this meta
        // set. Pages (venue pages) have no categories — the meta itself is
        // the opt-in.
        if ($post->post_type === 'post' && !has_category('comedy-shows', $post)) {
            return;
        }
        $json = get_post_meta($post->ID, '_ch_schema_graph', true);
        if (!is_string($json) || $json === '') {
            return;
        }
        // Re-decode / re-encode to guarantee well-formed JSON and strip any
        // stray whitespace or BOM. If decode fails (should be impossible — we
        // validated on write — but defense in depth) stay silent.
        $decoded = json_decode($json, true);
        if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
            return;
        }
        // The graph was frozen into post meta when the post was generated,
        // when the show was still in the future and its offers were true.
        // Time passes; the meta doesn't. Strip offers at RENDER time so a
        // past show never advertises availability — see
        // strip_past_event_offers() for why this can't live in the generator.
        $decoded = $this->strip_past_event_offers($decoded);
        // JSON_HEX_TAG: encode < and > as </> so a "</script>" inside
        // any string value can't terminate the script block (XSS breakout).
        $clean = wp_json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG);
        if (!is_string($clean) || $clean === '') {
            return;
        }
        echo "\n<script type=\"application/ld+json\">" . $clean . "</script>\n";
    }

    // =========================================================================
    // PER-PAGE SEO TITLE / META DESCRIPTION
    // =========================================================================

    /**
     * REST fields `ch_meta_title` and `ch_meta_description` on pages and
     * posts. The landing-page sync script (scripts/manage-wp-pages.js) sets
     * these when it creates /tonight/, /this-weekend/, /free/,
     * /open-mic-comedy-houston/ and the venue pages. Stored in post meta;
     * emitted below when no SEO
     * plugin is active (an active SEO plugin owns titles/descriptions).
     */
    public function register_page_seo_fields() {
        $fields = [
            'ch_meta_title'       => '_ch_meta_title',
            'ch_meta_description' => '_ch_meta_description',
            // Dynamic H1 override — see expand_date_tokens(). Kept separate
            // from post_title so the stored title stays clean in nav menus,
            // breadcrumbs and the admin list while the rendered H1 carries
            // live dates.
            'ch_h1'               => '_ch_h1',
        ];
        foreach ($fields as $field => $meta_key) {
            register_rest_field(['page', 'post'], $field, [
                'schema' => [
                    'description' => 'SEO ' . str_replace('ch_meta_', '', $field) . ' for this page.',
                    'type'        => 'string',
                    'context'     => ['view', 'edit'],
                ],
                'get_callback' => function ($post_arr) use ($meta_key) {
                    $val = get_post_meta($post_arr['id'], $meta_key, true);
                    return is_string($val) ? $val : '';
                },
                'update_callback' => function ($value, $post) use ($meta_key) {
                    if (!is_string($value)) {
                        return new WP_Error('ch_meta_invalid_type', 'Value must be a string.', ['status' => 400]);
                    }
                    update_post_meta($post->ID, $meta_key, sanitize_text_field($value));
                    return true;
                },
            ]);
        }
    }

    // -------------------------------------------------------------------------
    // DYNAMIC DATE TOKENS
    // -------------------------------------------------------------------------

    /**
     * Live date values for titles, descriptions and H1s.
     *
     * A listing page's real selling point in a SERP snippet is that it is
     * CURRENT — "Houston Comedy Shows This Weekend — Friday, August 14 –
     * Sunday, August 16, 2026" tells a searcher the page knows what weekend
     * it is; "Comedy Shows in Houston This Weekend" does not. Rather than
     * mint a dated URL per week (which splits authority across URLs that go
     * stale — see the /this-weekend/ vs /houston-comedy-shows-this-weekend/
     * consolidation), the evergreen URL renders live dates at request time.
     *
     * Windows are computed with houston_date() for the same reason
     * filter_events() does: these are Houston events and the market
     * timezone is a constant, not a WP admin setting.
     */
    private function date_tokens() {
        list($fri, $sat, $sun) = $this->weekend_window();

        $fri_ts = strtotime($fri . ' 12:00:00');
        $sun_ts = strtotime($sun . ' 12:00:00');

        // "Friday, August 14 – Sunday, August 16, 2026", collapsing the year
        // to the end. Across a month boundary both months are named; across
        // a year boundary (Dec 31 – Jan 2) both years are, or the range
        // would claim the wrong year for the Friday.
        $same_year = date('Y', $fri_ts) === date('Y', $sun_ts);
        $weekend_range = $same_year
            ? date('l, F j', $fri_ts) . ' – ' . date('l, F j, Y', $sun_ts)
            : date('l, F j, Y', $fri_ts) . ' – ' . date('l, F j, Y', $sun_ts);

        $dow          = (int) $this->houston_date('w');
        $week_end_ts  = strtotime($this->houston_date('Y-m-d', '+' . (7 - $dow) . ' days') . ' 12:00:00');
        $today_ts     = strtotime($this->houston_date('Y-m-d') . ' 12:00:00');
        $week_range   = date('Y', $today_ts) === date('Y', $week_end_ts)
            ? date('F j', $today_ts) . ' – ' . date('F j, Y', $week_end_ts)
            : date('F j, Y', $today_ts) . ' – ' . date('F j, Y', $week_end_ts);

        // Short forms exist because Google truncates a SERP title around 60
        // characters: "Friday, August 14 – Sunday, August 16, 2026" alone is
        // 43 of them and would push the actual keyword out of the snippet.
        // Use the short token in <title>, the long one in the H1, where
        // there is no length budget and the fuller phrasing reads better.
        $weekend_short = date('M j', $fri_ts)
            . '–'
            . (date('M', $fri_ts) === date('M', $sun_ts) ? date('j', $sun_ts) : date('M j', $sun_ts))
            . ', ' . date('Y', $sun_ts);

        return [
            // Longest keys first: strtr() is greedy but matches longest-first
            // only within equal-length keys, so {weekend_range_short} must
            // not be shadowed by {weekend_range}. PHP's strtr() with an array
            // does try longest keys first, but ordering it here makes the
            // intent explicit for anyone adding tokens later.
            '{weekend_range_short}' => $weekend_short,
            '{weekend_range}'       => $weekend_range,
            '{week_range}'          => $week_range,
            '{today_long}'          => date('l, F j, Y', $today_ts),
            '{today_short}'         => date('D, M j', $today_ts),
            '{today}'               => date('l, F j', $today_ts),
            '{month_year}'          => date('F Y', $today_ts),
            '{year}'                => date('Y', $today_ts),
        ];
    }

    /**
     * Replace {weekend_range} and friends. Strings with no token are
     * returned untouched, which is what makes this opt-in: a page gets
     * live dates only if whoever wrote its title asked for them.
     */
    public function expand_date_tokens($str) {
        if (!is_string($str) || $str === '' || strpos($str, '{') === false) {
            return $str;
        }
        $tokens = $this->date_tokens();
        return strtr($str, $tokens);
    }

    public function filter_document_title($title) {
        if ($this->seo_plugin_handles_schema() || !is_singular(['page', 'post'])) {
            return $title;
        }
        $post = get_queried_object();
        if (!$post || empty($post->ID)) {
            return $title;
        }
        $custom = get_post_meta($post->ID, '_ch_meta_title', true);
        return (is_string($custom) && $custom !== '')
            ? $this->expand_date_tokens($custom)
            : $title;
    }

    /**
     * Title, when an SEO plugin owns the <title> tag.
     *
     * filter_document_title() bails out whenever Yoast/Rank Math/AIOSEO/
     * SEOPress is active, because those plugins own titles. That left
     * `_ch_meta_title` — the string the landing-page sync writes from
     * config/landing-pages.json — completely unused on this site, which
     * runs Rank Math. The visible symptom was H1s carrying live dates while
     * the SERP-visible <title> stayed frozen: the H1 comes from our own
     * `_ch_h1` meta, the title came from Rank Math's stored value, and only
     * one of the two had tokens in it. Expanding tokens on the SEO plugin's
     * output isn't enough — its string never contained a token to expand.
     *
     * So: when `_ch_meta_title` is set for this page, it wins, expanded.
     * When it isn't, the SEO plugin's own title passes through (still token-
     * expanded, in case someone typed a token into the Rank Math UI).
     *
     * Consequence worth knowing: for the pages listed in landing-pages.json,
     * editing the title in Rank Math's UI will have no visible effect —
     * landing-pages.json is the source of truth for those, and the sync
     * workflow is how you change them.
     */
    public function filter_seo_plugin_title($title) {
        $custom = $this->queried_post_meta('_ch_meta_title');
        return $this->expand_date_tokens($custom !== '' ? $custom : $title);
    }

    /** Same arrangement for the meta description. */
    public function filter_seo_plugin_description($desc) {
        $custom = $this->queried_post_meta('_ch_meta_description');
        return $this->expand_date_tokens($custom !== '' ? $custom : $desc);
    }

    /** Post meta of the currently queried singular page/post, or ''. */
    private function queried_post_meta($key) {
        if (!is_singular(['page', 'post'])) return '';
        $post = get_queried_object();
        if (!$post || empty($post->ID)) return '';
        $val = get_post_meta($post->ID, $key, true);
        return is_string($val) ? $val : '';
    }

    // -------------------------------------------------------------------------
    // NOINDEX ↔ SEO PLUGIN RECONCILIATION
    // -------------------------------------------------------------------------

    /**
     * Should the currently queried post be noindexed?
     * (`_ch_allow_index` is the operator's per-post override.)
     */
    private function post_is_noindexed($post_id) {
        return (bool) get_post_meta($post_id, '_ch_noindex', true)
            && !get_post_meta($post_id, '_ch_allow_index', true);
    }

    /**
     * Force an SEO plugin's robots directives to noindex on posts we've
     * flagged.
     *
     * Emitting our own `<meta name="robots" content="noindex, follow">`
     * alongside Rank Math's `index, follow` put two contradictory robots
     * tags on the same page — Google resolves that conflict by taking the
     * most restrictive, so the pages were noindexed, but the SEO plugin
     * still believed they were indexable and kept listing all 15 in its
     * sitemap. A sitemap that advertises noindexed URLs is a Search Console
     * error in its own right and burns crawl budget on pages we've decided
     * shouldn't rank.
     *
     * Telling the SEO plugin instead of shouting over it fixes both halves:
     * one robots tag, and the sitemap filter below can then agree with it.
     */
    public function force_noindex_robots($robots) {
        if (!is_singular(['post', 'page'])) return $robots;
        $post = get_queried_object();
        if (!$post || empty($post->ID) || !$this->post_is_noindexed($post->ID)) {
            return $robots;
        }
        if (!is_array($robots)) $robots = [];
        $robots['index']  = 'noindex';
        $robots['follow'] = 'follow';
        return $robots;
    }

    /** Yoast passes a flat list rather than a keyed map. */
    public function force_noindex_robots_list($robots) {
        $keyed = $this->force_noindex_robots(is_array($robots) ? $robots : []);
        return $keyed;
    }

    /**
     * Drop noindexed posts from Rank Math's XML sitemap. Without this the
     * sitemap and the robots tag contradict each other on 15 URLs.
     */
    public function exclude_noindexed_from_sitemap($url, $type = '', $object = null) {
        if ($type !== 'post' || !is_object($object) || empty($object->ID)) {
            return $url;
        }
        return $this->post_is_noindexed($object->ID) ? false : $url;
    }

    /**
     * Dynamic H1, read from the `_ch_h1` meta rather than post_title.
     *
     * the_title() also runs for nav menus, breadcrumbs, related-post lists
     * and the admin list table, so this is fenced to the single main-loop
     * render of the queried page. Anywhere else, the clean stored title is
     * what the reader should see.
     */
    public function filter_entry_title($title, $post_id = 0) {
        if (is_admin() || !$post_id || !is_singular() || !in_the_loop() || !is_main_query()) {
            return $title;
        }
        if ((int) $post_id !== (int) get_queried_object_id()) {
            return $title;
        }
        $h1 = get_post_meta($post_id, '_ch_h1', true);
        if (!is_string($h1) || $h1 === '') {
            return $title;
        }
        return $this->expand_date_tokens($h1);
    }

    /** Meta Pixel base snippet. Guarded so fbq is never double-defined. */
    public function emit_meta_pixel() {
        if (!self::META_PIXEL_ID) {
            return;
        }
        ?>
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '<?php echo esc_js(self::META_PIXEL_ID); ?>');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=<?php echo esc_attr(self::META_PIXEL_ID); ?>&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->
        <?php
    }

    public function emit_meta_description() {
        if ($this->seo_plugin_handles_schema() || !is_singular(['page', 'post'])) {
            return;
        }
        $post = get_queried_object();
        if (!$post || empty($post->ID)) {
            return;
        }
        $desc = get_post_meta($post->ID, '_ch_meta_description', true);
        if (is_string($desc) && $desc !== '') {
            echo '<meta name="description" content="' . esc_attr($this->expand_date_tokens($desc)) . '">' . "\n";
        }
    }

    // =========================================================================
    // ORGANIZATION SCHEMA (site-wide)
    // =========================================================================

    /**
     * True when an active SEO plugin already emits Organization/BlogPosting
     * schema — in that case we stay silent to avoid duplicate entities.
     * (Google Site Kit is NOT in this list: it handles analytics/search
     * console, not schema markup.)
     */
    private function seo_plugin_handles_schema() {
        return defined('WPSEO_VERSION')      // Yoast SEO
            || class_exists('RankMath')      // Rank Math
            || defined('AIOSEO_VERSION')     // All in One SEO
            || defined('SEOPRESS_VERSION');  // SEOPress
    }

    /**
     * Emit Organization JSON-LD on every front-end page. Name, logo, and
     * sameAs profiles are configurable at Settings → Comedy Houston, so the
     * markup stays config-driven rather than hardcoded.
     */
    public function emit_organization_schema() {
        if (is_admin() || $this->seo_plugin_handles_schema()) {
            return;
        }
        $opts = $this->get_options();

        $org = [
            '@context' => 'https://schema.org',
            '@type'    => 'Organization',
            '@id'      => home_url('/') . '#organization',
            'name'     => !empty($opts['org_name']) ? $opts['org_name'] : get_bloginfo('name'),
            'url'      => home_url('/'),
        ];

        $logo = !empty($opts['org_logo']) ? $opts['org_logo'] : get_site_icon_url(512);
        if (!empty($logo)) {
            $org['logo'] = $logo;
        }

        // sameAs: one URL per line in settings; only http(s) URLs are kept.
        $same_as = [];
        foreach (preg_split('/\r\n|\r|\n/', (string) ($opts['org_sameas'] ?? '')) as $line) {
            $line = trim($line);
            if ($line !== '' && preg_match('~^https?://~i', $line)) {
                $same_as[] = esc_url_raw($line);
            }
        }
        if (!empty($same_as)) {
            $org['sameAs'] = array_values($same_as);
        }

        echo "\n<script type=\"application/ld+json\">"
            . wp_json_encode($org, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG)
            . "</script>\n";
    }

    // =========================================================================
    // DATABASE
    // =========================================================================

    public function create_clicks_table() {
        global $wpdb;
        $table   = $wpdb->prefix . self::CLICKS_TABLE;
        $charset = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE $table (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            clicked_at DATETIME NOT NULL,
            original_url TEXT NOT NULL,
            final_url TEXT NOT NULL,
            user_ip VARCHAR(128) DEFAULT '',
            user_agent TEXT DEFAULT '',
            referer TEXT DEFAULT '',
            PRIMARY KEY (id),
            KEY clicked_at (clicked_at)
        ) $charset;";

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta($sql);
    }

    // =========================================================================
    // SERVER-SIDE RENDERING (SEO)
    // =========================================================================

    /**
     * Fetch events.json from GitHub with WordPress transient caching.
     * Returns the decoded JSON array or null on failure.
     */
    public function fetch_events_data() {
        $cache_key = $this->events_transient_key();

        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }

        $fetched = $this->fetch_events_from_github();
        if (!$fetched) {
            return null;
        }

        // NOTE: this passive path deliberately does NOT update the
        // ch_events_hash option — only refresh_events_and_purge() may mark a
        // payload as "seen", otherwise an uncached page render could swallow
        // a data change and the cron fallback would never purge the pages
        // LiteSpeed rendered from the older payload.
        set_transient($cache_key, $fetched['data'], HOUR_IN_SECONDS);
        return $fetched['data'];
    }

    private function events_transient_key() {
        $opts = $this->get_options();
        return 'ch_events_' . md5($opts['github_user'] . '_' . $opts['repo']);
    }

    /**
     * Fetch events.json from GitHub raw, bypassing the transient. $ref may be
     * a branch or a commit SHA — the update-events workflow passes the SHA it
     * just pushed, because raw.githubusercontent.com caches branch URLs for
     * ~5 minutes while commit-SHA URLs are immutable and always fresh.
     * Returns ['data' => array, 'hash' => md5-of-body] or null.
     */
    private function fetch_events_from_github($ref = 'main') {
        $opts = $this->get_options();
        $url = sprintf(
            'https://raw.githubusercontent.com/%s/%s/%s/events.json',
            sanitize_text_field($opts['github_user']),
            sanitize_text_field($opts['repo']),
            rawurlencode($ref)
        );

        $response = wp_remote_get($url, ['timeout' => 10]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
            return null;
        }

        $body = wp_remote_retrieve_body($response);
        $data = json_decode($body, true);
        if (!$data || empty($data['events'])) {
            return null;
        }

        return ['data' => $data, 'hash' => md5($body)];
    }

    // =========================================================================
    // CACHE INVALIDATION (LiteSpeed purge on data change)
    // =========================================================================

    /**
     * POST /wp-json/comedy-houston/v1/refresh — called by the update-events
     * GitHub Action after it pushes fresh events.json. Authenticated via
     * application password (same WP_APP_USER/WP_APP_PASSWORD the publishing
     * scripts already use). Optional body param `sha` pins the fetch to the
     * just-pushed commit so the raw CDN's ~5-minute branch cache can't serve
     * the previous payload back to us.
     */
    public function register_refresh_route() {
        register_rest_route('comedy-houston/v1', '/refresh', [
            'methods'  => 'POST',
            'callback' => [$this, 'handle_refresh_request'],
            'permission_callback' => function () {
                return current_user_can('edit_posts');
            },
        ]);
    }

    public function handle_refresh_request($request) {
        $sha = sanitize_text_field((string) $request->get_param('sha'));
        if ($sha !== '' && !preg_match('/^[0-9a-f]{7,40}$/i', $sha)) {
            return new WP_Error('ch_bad_sha', 'sha must be a hex commit id.', ['status' => 400]);
        }
        // Explicit webhook call = a data push just happened; always purge.
        $result = $this->refresh_events_and_purge($sha !== '' ? $sha : null, true);
        if (!$result['refreshed']) {
            return new WP_Error('ch_fetch_failed', 'Could not fetch events.json from GitHub.', ['status' => 502]);
        }
        return rest_ensure_response($result);
    }

    /**
     * Hourly WP-cron fallback: refetch, and purge only when the payload hash
     * actually changed. Covers the twice-daily import when the REST webhook
     * isn't configured (or its call failed) — without this, LiteSpeed keeps
     * serving pages rendered from days-old data because a fully cached page
     * never runs PHP, so the transient alone can never fix staleness.
     */
    public function maybe_schedule_refresh_cron() {
        if (!wp_next_scheduled('comedy_houston_refresh_events')) {
            wp_schedule_event(time() + HOUR_IN_SECONDS, 'hourly', 'comedy_houston_refresh_events');
        }
    }

    public function clear_refresh_cron() {
        wp_clear_scheduled_hook('comedy_houston_refresh_events');
    }

    public function cron_refresh_events() {
        $this->refresh_events_and_purge(null, false);
    }

    /**
     * Refetch events.json (optionally at a specific commit), refresh the
     * transient, and purge the LiteSpeed page cache for every listing page
     * when the data changed ($force purges unconditionally).
     */
    public function refresh_events_and_purge($sha = null, $force = false) {
        $fetched = $this->fetch_events_from_github($sha !== null ? $sha : 'main');
        if (!$fetched) {
            return ['refreshed' => false, 'changed' => false, 'purged' => 0];
        }

        $changed = get_option('ch_events_hash') !== $fetched['hash'];
        set_transient($this->events_transient_key(), $fetched['data'], HOUR_IN_SECONDS);
        update_option('ch_events_hash', $fetched['hash'], false);

        $purged = [];
        $bumped = 0;
        if ($changed || $force) {
            $purged = $this->purge_listing_cache();
        }
        // lastmod only moves on a REAL data change, never on $force alone:
        // a manual webhook re-fire or a cache-clear is not new content, and
        // telling Google a page changed when it didn't is the fastest way
        // to have it stop believing lastmod at all.
        if ($changed) {
            $bumped = $this->bump_listing_lastmod($this->listing_page_ids());
        }
        return [
            'refreshed' => true,
            'changed'   => $changed,
            'purged'    => count($purged),
            'bumped'    => $bumped,
            'urls'      => $purged,
        ];
    }

    /**
     * Every published page/post containing the [comedy_houston] shortcode —
     * /tonight/, /this-weekend/, /free/, the open-mics page, /this-week/ and
     * all venue pages, whatever their current slugs. Found by content match
     * rather than a hardcoded ID list so a new listing page is covered the
     * day it is created.
     */
    private function listing_page_ids() {
        global $wpdb;
        $like = '%' . $wpdb->esc_like('[' . self::SHORTCODE) . '%';
        return $wpdb->get_col($wpdb->prepare(
            "SELECT ID FROM {$wpdb->posts}
             WHERE post_status = 'publish'
               AND post_type IN ('page', 'post')
               AND post_content LIKE %s",
            $like
        ));
    }

    /**
     * Move `post_modified` on the listing pages whose rendered content just
     * changed, so the XML sitemap's <lastmod> tells the truth.
     *
     * These pages render from events.json through a shortcode and are never
     * re-saved, so post_modified froze on the day each page was created —
     * sitemaps were advertising a three-week-old lastmod on pages whose
     * bodies change twice a day. Google reads lastmod as its recrawl signal,
     * so it stops coming back, keeps serving an old snapshot, and any stale
     * markup in that snapshot (see strip_past_event_offers) stays in the
     * index. The stale lastmod is upstream of the schema problem, not a
     * separate one.
     *
     * Only called when the events hash actually changed, so the claim is
     * honest — an unchanged import moves nothing.
     *
     * Raw SQL rather than wp_update_post() on purpose. wp_update_post()
     * re-saves post_content through wp_kses when no user is present, which
     * is exactly the case under WP-Cron, and would quietly rewrite the
     * pages' HTML on a schedule. The cache invalidation wp_update_post()
     * would have given us is done explicitly instead: clean_post_cache()
     * here, and the LiteSpeed purge in purge_listing_cache() which runs
     * alongside this on the same refresh.
     */
    private function bump_listing_lastmod($ids) {
        global $wpdb;

        // The homepage renders the same twice-daily event data but reaches
        // it through the theme's front-page template rather than the
        // shortcode, so listing_page_ids() misses it and its lastmod sat 22
        // days stale — on the most important URL on the site. Add it
        // explicitly. (A front page set to "latest posts" has no ID, in
        // which case there is no lastmod to fix.)
        $front_id = (int) get_option('page_on_front');
        if ($front_id > 0 && !in_array($front_id, array_map('intval', (array) $ids), true)) {
            $ids[] = $front_id;
        }

        if (empty($ids)) return 0;

        $now_gmt   = gmdate('Y-m-d H:i:s');
        $now_local = get_date_from_gmt($now_gmt);
        $bumped    = 0;

        foreach ($ids as $id) {
            $ok = $wpdb->update(
                $wpdb->posts,
                ['post_modified' => $now_local, 'post_modified_gmt' => $now_gmt],
                ['ID' => (int) $id],
                ['%s', '%s'],
                ['%d']
            );
            if ($ok !== false) {
                clean_post_cache((int) $id);
                $bumped++;
            }
        }
        return $bumped;
    }

    /**
     * Purge the page cache for the homepage and every listing page. The
     * litespeed_* actions are no-ops when LiteSpeed Cache isn't active, so
     * this is safe on any host.
     */
    private function purge_listing_cache() {
        $ids = $this->listing_page_ids();

        $urls = [home_url('/')];
        foreach ($ids as $id) {
            $permalink = get_permalink((int) $id);
            if ($permalink) {
                $urls[] = $permalink;
            }
            do_action('litespeed_purge_post', (int) $id);
        }
        $urls = array_values(array_unique($urls));
        foreach ($urls as $url) {
            do_action('litespeed_purge_url', $url);
        }
        return $urls;
    }

    // =========================================================================
    // CORPORATE BOOKING INQUIRY FORM
    // =========================================================================

    private function inquiry_email() {
        return apply_filters('comedy_houston_inquiry_email', 'creative@comedyhouston.com');
    }

    /**
     * Spam defense, no third-party service:
     *   1. Token — the form fetches an HMAC-signed timestamp from REST at
     *      page view (works on LiteSpeed-cached pages, where a rendered
     *      nonce could be days old and long expired). Submissions must
     *      arrive 8 seconds to 6 hours after the token was minted: bots
     *      that POST the endpoint directly have no token, and bots that
     *      auto-fill instantly fail the 8-second floor.
     *   2. Honeypot — a visually hidden "website" field; any value rejects.
     *   3. Rate limit — max 5 submissions per IP per hour via transient.
     */
    private function mint_inquiry_token($context = 'ch-inquiry') {
        $ts = time();
        return $ts . '.' . hash_hmac('sha256', $context . '|' . $ts, wp_salt('nonce'));
    }

    private function verify_inquiry_token($token, $context = 'ch-inquiry') {
        if (!is_string($token) || !preg_match('/^(\d{10,12})\.([0-9a-f]{64})$/', $token, $m)) {
            return false;
        }
        $ts = (int) $m[1];
        if (!hash_equals(hash_hmac('sha256', $context . '|' . $ts, wp_salt('nonce')), $m[2])) {
            return false;
        }
        $age = time() - $ts;
        return $age >= 8 && $age <= 6 * HOUR_IN_SECONDS;
    }

    public function register_inquiry_routes() {
        register_rest_route('comedy-houston/v1', '/inquiry-token', [
            'methods'  => 'GET',
            'callback' => function () {
                return rest_ensure_response(['token' => $this->mint_inquiry_token()]);
            },
            'permission_callback' => '__return_true',
        ]);
        register_rest_route('comedy-houston/v1', '/inquiry', [
            'methods'  => 'POST',
            'callback' => [$this, 'handle_inquiry_submission'],
            'permission_callback' => '__return_true',
        ]);
        // Performer-booking MVP (see PERFORMER_REQUESTS.md in the repo).
        // Same anti-spam design as the corporate inquiry form, separate
        // token context + rate-limit bucket.
        register_rest_route('comedy-houston/v1', '/performer-token', [
            'methods'  => 'GET',
            'callback' => function () {
                return rest_ensure_response(['token' => $this->mint_inquiry_token('ch-performer')]);
            },
            'permission_callback' => '__return_true',
        ]);
        register_rest_route('comedy-houston/v1', '/performer-interest', [
            'methods'  => 'POST',
            'callback' => [$this, 'handle_performer_submission'],
            'permission_callback' => '__return_true',
        ]);
    }

    public function handle_inquiry_submission($request) {
        // Honeypot: silently accept so bots don't learn they were caught.
        if (trim((string) $request->get_param('website')) !== '') {
            return rest_ensure_response(['ok' => true]);
        }

        if (!$this->verify_inquiry_token($request->get_param('ch_token'))) {
            return new WP_Error('ch_inquiry_token', 'Session expired — please reload the page and try again.', ['status' => 403]);
        }

        $ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : '';
        $rate_key = 'ch_inq_' . md5($ip);
        $count = (int) get_transient($rate_key);
        if ($count >= 5) {
            return new WP_Error('ch_inquiry_rate', 'Too many submissions — please try again later or email us directly.', ['status' => 429]);
        }
        set_transient($rate_key, $count + 1, HOUR_IN_SECONDS);

        $field = function ($key, $max) use ($request) {
            return mb_substr(sanitize_text_field((string) $request->get_param($key)), 0, $max);
        };
        $name       = $field('name', 100);
        $email      = sanitize_email((string) $request->get_param('email'));
        $org        = $field('organization', 150);
        $event_date = $field('event_date', 20);
        $event_type = $field('event_type', 60);
        $audience   = $field('audience_size', 40);
        $location   = $field('location', 200);
        $budget     = $field('budget', 40);
        $content    = $field('content_level', 60);
        $notes      = mb_substr(sanitize_textarea_field((string) $request->get_param('notes')), 0, 4000);

        if ($name === '' || !is_email($email) || $event_type === '' || $event_date === '') {
            return new WP_Error('ch_inquiry_fields', 'Please fill in your name, email, event date, and event type.', ['status' => 400]);
        }

        $lines = [
            'New corporate/clean comedy inquiry from comedyhouston.com',
            '',
            'Name:          ' . $name,
            'Email:         ' . $email,
            'Organization:  ' . ($org !== '' ? $org : '—'),
            '',
            'Event date:    ' . $event_date,
            'Event type:    ' . $event_type,
            'Audience size: ' . ($audience !== '' ? $audience : '—'),
            'Location:      ' . ($location !== '' ? $location : '—'),
            'Budget range:  ' . ($budget !== '' ? $budget : '—'),
            'Content level: ' . ($content !== '' ? $content : '—'),
            '',
            'Notes:',
            $notes !== '' ? $notes : '—',
        ];
        $subject = sprintf('Corporate comedy inquiry — %s, %s', $event_type, $event_date);
        $headers = ['Reply-To: ' . $name . ' <' . $email . '>'];

        if (!wp_mail($this->inquiry_email(), $subject, implode("\n", $lines), $headers)) {
            return new WP_Error('ch_inquiry_mail', 'Could not send right now — please email ' . $this->inquiry_email() . ' directly.', ['status' => 500]);
        }
        return rest_ensure_response(['ok' => true]);
    }

    // =========================================================================
    // PERFORMER-BOOKING MVP — "Interested in performing?" submissions
    //
    // Demand-validation experiment (PERFORMER_REQUESTS.md): comedians browsing
    // eligible shows (events.json `performer_requests: true`, controlled by
    // config/performer-requests.json) can raise their hand for a specific
    // show. Submissions are emailed to the admin for manual concierge
    // matching — no accounts, no producer dashboard, no storage beyond email.
    // =========================================================================

    private function performer_email() {
        return apply_filters('comedy_houston_performer_email', $this->inquiry_email());
    }

    public function handle_performer_submission($request) {
        // Honeypot: silently accept so bots don't learn they were caught.
        if (trim((string) $request->get_param('website')) !== '') {
            return rest_ensure_response(['ok' => true]);
        }

        if (!$this->verify_inquiry_token($request->get_param('ch_token'), 'ch-performer')) {
            return new WP_Error('ch_perf_token', 'Session expired — please reload the page and try again.', ['status' => 403]);
        }

        $ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : '';
        $rate_key = 'ch_perf_' . md5($ip);
        $count = (int) get_transient($rate_key);
        if ($count >= 5) {
            return new WP_Error('ch_perf_rate', 'Too many submissions — please try again later.', ['status' => 429]);
        }
        set_transient($rate_key, $count + 1, HOUR_IN_SECONDS);

        $field = function ($key, $max) use ($request) {
            return mb_substr(sanitize_text_field((string) $request->get_param($key)), 0, $max);
        };

        // Performer fields — only what the MVP needs.
        $instagram  = ltrim($field('instagram', 60), '@');
        $set_length = $field('set_length', 10);
        $clip_url   = esc_url_raw((string) $request->get_param('clip_url'), ['http', 'https']);
        $note       = mb_substr(sanitize_textarea_field((string) $request->get_param('note')), 0, 2000);

        if ($instagram === '' || !preg_match('/^[A-Za-z0-9._]{1,30}$/', $instagram)) {
            return new WP_Error('ch_perf_fields', 'Please enter your Instagram handle (letters, numbers, dots, underscores).', ['status' => 400]);
        }
        if (!in_array($set_length, ['5', '10', '15', '20+'], true)) {
            return new WP_Error('ch_perf_fields', 'Please pick a set length.', ['status' => 400]);
        }

        // Event metadata — captured silently by the client from the card's
        // event object. Advisory (a spoofed value only mis-labels the email),
        // but it's what makes the submission actionable: it ties the raised
        // hand to one specific show.
        $event_id     = $field('event_id', 32);
        $event_name   = $field('event_name', 200);
        $venue        = $field('venue', 120);
        $event_date   = $field('event_date', 20);
        $event_time   = $field('event_time', 20);
        $event_source = $field('event_source', 20);
        $is_open_mic  = $request->get_param('is_open_mic') ? 'yes' : 'no';

        $lines = [
            'New performer-interest submission from comedyhouston.com',
            '',
            '— Show —',
            'Event:      ' . ($event_name !== '' ? $event_name : '—'),
            'Venue:      ' . ($venue !== '' ? $venue : '—'),
            'Date/time:  ' . trim($event_date . ' ' . $event_time),
            'Event ID:   ' . ($event_id !== '' ? $event_id : '—'),
            'Source:     ' . ($event_source !== '' ? $event_source : '—'),
            'Open mic:   ' . $is_open_mic,
            '',
            '— Performer —',
            'Instagram:  @' . $instagram . '  (https://www.instagram.com/' . rawurlencode($instagram) . '/)',
            'Set length: ' . $set_length . ' minutes',
            'Clip:       ' . ($clip_url !== '' ? $clip_url : '—'),
            '',
            'Note:',
            $note !== '' ? $note : '—',
            '',
            'Next step (manual concierge): vet the clip/IG, then intro them to',
            'the show\'s producer. See PERFORMER_REQUESTS.md in the repo.',
        ];
        $subject = sprintf(
            'Performer interest — %s @ %s, %s',
            $event_name !== '' ? $event_name : 'unknown show',
            $venue !== '' ? $venue : 'unknown venue',
            $event_date !== '' ? $event_date : 'unknown date'
        );

        if (!wp_mail($this->performer_email(), $subject, implode("\n", $lines))) {
            return new WP_Error('ch_perf_mail', 'Could not send right now — please try again in a minute.', ['status' => 500]);
        }
        return rest_ensure_response(['ok' => true]);
    }

    /**
     * [comedy_houston_inquiry] — self-contained form (scoped styles + inline
     * JS, no dependency on the listing app assets) sized to sit inside the
     * clean-comedy page's ticket panel, but presentable anywhere. Shortcodes
     * inside Custom HTML blocks are expanded by the_content, so it can be
     * pasted straight into the hand-built page.
     */
    public function render_inquiry_form() {
        $endpoint  = esc_url(rest_url('comedy-houston/v1/inquiry'));
        $token_url = esc_url(rest_url('comedy-houston/v1/inquiry-token'));
        $mailto    = esc_attr($this->inquiry_email());

        ob_start();
        ?>
<div class="ch-inquiry" id="ch-inquiry">
<style>
.ch-inquiry{font-size:15px;text-align:left}
.ch-inquiry .ch-iq-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.ch-inquiry label{display:block;font-weight:700;font-size:13px;margin-bottom:5px}
.ch-inquiry input,.ch-inquiry select,.ch-inquiry textarea{width:100%;padding:11px 12px;border:1px solid #c9bfae;border-radius:3px;background:#fff;color:#171310;font:inherit}
.ch-inquiry input:focus,.ch-inquiry select:focus,.ch-inquiry textarea:focus{outline:2px solid #f2a33c;outline-offset:1px}
.ch-inquiry .ch-iq-full{grid-column:1/-1}
.ch-inquiry .ch-iq-hp{position:absolute !important;left:-9999px !important;height:1px;width:1px;overflow:hidden}
.ch-inquiry .ch-iq-submit{display:inline-block;border:0;cursor:pointer;background:#e6483d;color:#fff;font-weight:700;font-size:16px;padding:15px 27px;border-radius:3px}
.ch-inquiry .ch-iq-submit:hover{background:#f05a4f}
.ch-inquiry .ch-iq-submit[disabled]{opacity:.6;cursor:wait}
.ch-inquiry .ch-iq-msg{margin:12px 0 0;font-weight:600;display:none}
.ch-inquiry .ch-iq-msg.err{color:#b3261e;display:block}
.ch-inquiry .ch-iq-msg.ok{color:#2e7d32;display:block}
.ch-inquiry .ch-iq-alt{margin-top:12px;font-size:13.5px;color:#8a7c68}
.ch-inquiry .ch-iq-alt a{color:inherit}
@media(max-width:680px){.ch-inquiry .ch-iq-grid{grid-template-columns:1fr}}
</style>
<form class="ch-iq-form" method="post" action="<?php echo $endpoint; ?>" novalidate>
  <div class="ch-iq-grid">
    <div><label for="ch-iq-name">Your name *</label><input id="ch-iq-name" name="name" type="text" required autocomplete="name"></div>
    <div><label for="ch-iq-email">Email *</label><input id="ch-iq-email" name="email" type="email" required autocomplete="email"></div>
    <div><label for="ch-iq-org">Organization</label><input id="ch-iq-org" name="organization" type="text" autocomplete="organization"></div>
    <div><label for="ch-iq-date">Event date *</label><input id="ch-iq-date" name="event_date" type="date" required></div>
    <div><label for="ch-iq-type">Event type *</label>
      <select id="ch-iq-type" name="event_type" required>
        <option value="">Select…</option>
        <option>Corporate event / conference</option>
        <option>Association or awards dinner</option>
        <option>Church, school, or nonprofit</option>
        <option>Holiday party</option>
        <option>Private celebration</option>
        <option>Other</option>
      </select></div>
    <div><label for="ch-iq-size">Audience size</label>
      <select id="ch-iq-size" name="audience_size">
        <option value="">Select…</option>
        <option>Under 50</option><option>50–150</option><option>150–500</option><option>500+</option>
      </select></div>
    <div><label for="ch-iq-loc">Location</label><input id="ch-iq-loc" name="location" type="text" placeholder="Venue or area, e.g. Galleria"></div>
    <div><label for="ch-iq-budget">Budget range</label>
      <select id="ch-iq-budget" name="budget">
        <option value="">Select…</option>
        <option>Under $1,000</option><option>$1,000–$2,500</option><option>$2,500–$5,000</option><option>$5,000+</option><option>Not sure yet</option>
      </select></div>
    <div><label for="ch-iq-content">Content level</label>
      <select id="ch-iq-content" name="content_level">
        <option value="">Select…</option>
        <option>Workplace-safe</option><option>Family-friendly</option><option>Church-appropriate</option><option>No profanity</option><option>Let&rsquo;s discuss</option>
      </select></div>
    <div class="ch-iq-full"><label for="ch-iq-notes">Anything else</label><textarea id="ch-iq-notes" name="notes" rows="4" placeholder="Set length, A/V, customization, timing — whatever helps us match the room."></textarea></div>
    <div class="ch-iq-hp" aria-hidden="true"><label for="ch-iq-web">Website</label><input id="ch-iq-web" name="website" type="text" tabindex="-1" autocomplete="off"></div>
  </div>
  <input type="hidden" name="ch_token" value="">
  <p style="margin-top:18px"><button type="submit" class="ch-iq-submit">Request comedian recommendations</button></p>
  <p class="ch-iq-msg" role="status" aria-live="polite"></p>
  <p class="ch-iq-alt">Prefer email? <a href="mailto:<?php echo $mailto; ?>?subject=Clean%20comedian%20for%20Houston%20event">Send the details to <?php echo esc_html($this->inquiry_email()); ?></a>. A complete inquiry does not obligate you to book.</p>
</form>
<script>
(function(){
  var root = document.currentScript.closest('.ch-inquiry');
  var form = root.querySelector('.ch-iq-form');
  var msg = root.querySelector('.ch-iq-msg');
  var tokenField = form.querySelector('input[name=ch_token]');
  // Token minted at page VIEW time (not render time — this page is served
  // from a full-page cache), giving the anti-bot 8s-minimum age a real
  // "time on page" to measure.
  fetch(<?php echo wp_json_encode($token_url); ?>).then(function(r){return r.json();}).then(function(d){
    if (d && d.token) tokenField.value = d.token;
  }).catch(function(){});
  form.addEventListener('submit', function(e){
    e.preventDefault();
    msg.className = 'ch-iq-msg';
    var btn = form.querySelector('.ch-iq-submit');
    var data = {};
    new FormData(form).forEach(function(v, k){ data[k] = v; });
    if (!data.name || !data.email || !data.event_date || !data.event_type) {
      msg.className = 'ch-iq-msg err';
      msg.textContent = 'Please fill in your name, email, event date, and event type.';
      return;
    }
    btn.disabled = true;
    fetch(<?php echo wp_json_encode($endpoint); ?>, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(function(r){ return r.json().then(function(j){ return {ok: r.ok, body: j}; }); })
    .then(function(res){
      if (res.ok) {
        if (typeof gtag === 'function') { gtag('event', 'corporate_inquiry'); }
        if (typeof fbq === 'function') { fbq('track', 'Lead', {content_name: 'corporate_inquiry'}); }
        form.innerHTML = '<p class="ch-iq-msg ok" style="display:block;font-size:17px">Got it — thanks. We\'ll reply from <?php echo esc_js($this->inquiry_email()); ?> with comedian recommendations, usually within one business day.</p>';
      } else {
        btn.disabled = false;
        msg.className = 'ch-iq-msg err';
        msg.textContent = (res.body && res.body.message) ? res.body.message : 'Something went wrong — please email us directly.';
      }
    }).catch(function(){
      btn.disabled = false;
      msg.className = 'ch-iq-msg err';
      msg.textContent = 'Network error — please try again or email us directly.';
    });
  });
})();
</script>
</div>
        <?php
        return ob_get_clean();
    }

    // =========================================================================
    // PER-POST NOINDEX
    // =========================================================================

    public function register_noindex_fields() {
        foreach (['ch_noindex' => '_ch_noindex', 'ch_allow_index' => '_ch_allow_index'] as $field => $meta_key) {
            register_rest_field('post', $field, [
                'schema' => [
                    'description' => $field === 'ch_noindex'
                        ? 'Emit a robots noindex meta tag on this post.'
                        : 'Override: keep this post indexable even when ch_noindex is set.',
                    'type'        => 'boolean',
                    'context'     => ['view', 'edit'],
                ],
                'get_callback' => function ($post_arr) use ($meta_key) {
                    return (bool) get_post_meta($post_arr['id'], $meta_key, true);
                },
                'update_callback' => function ($value, $post) use ($meta_key) {
                    if ($value) {
                        update_post_meta($post->ID, $meta_key, '1');
                    } else {
                        delete_post_meta($post->ID, $meta_key);
                    }
                    return true;
                },
            ]);
        }
    }

    /**
     * Robots noindex for flagged posts, for sites with NO SEO plugin.
     *
     * This used to emit unconditionally, on the reasoning that Google takes
     * the most restrictive directive when robots tags conflict. That is
     * true, and the pages were duly noindexed — but it left Rank Math still
     * believing they were indexable, so it kept all 15 in its XML sitemap
     * while the page itself said noindex. A sitemap advertising noindexed
     * URLs is its own Search Console error and wastes crawl budget.
     *
     * With an SEO plugin active we now tell IT instead (see
     * force_noindex_robots + exclude_noindexed_from_sitemap), which yields
     * one robots tag and a sitemap that agrees with it. "follow" is kept
     * either way so internal links keep passing signals to the venue and
     * landing pages.
     */
    public function emit_noindex_meta() {
        if (!is_singular('post') || $this->seo_plugin_handles_schema()) {
            return;
        }
        $id = get_queried_object_id();
        if (!$id) {
            return;
        }
        if (get_post_meta($id, '_ch_noindex', true) && !get_post_meta($id, '_ch_allow_index', true)) {
            echo '<meta name="robots" content="noindex, follow" />' . "\n";
        }
    }

    /**
     * Fetch blog/comedians/manifest.json from GitHub with transient caching.
     * Returns the manifest array or [] on failure (callers treat missing as
     * "no comedian posts available" — they still render cards, just without
     * the "More info" internal link).
     */
    public function fetch_manifest_data() {
        $opts = $this->get_options();
        $cache_key = 'ch_manifest_' . md5($opts['github_user'] . '_' . $opts['repo']);

        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }

        $url = sprintf(
            'https://raw.githubusercontent.com/%s/%s/main/blog/comedians/manifest.json',
            sanitize_text_field($opts['github_user']),
            sanitize_text_field($opts['repo'])
        );

        $response = wp_remote_get($url, ['timeout' => 10]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
            // Cache the empty result briefly so a 404 doesn't hammer GitHub on
            // every page load. 5 minutes is short enough that a freshly
            // generated manifest still shows up quickly.
            set_transient($cache_key, [], 5 * MINUTE_IN_SECONDS);
            return [];
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (!$data || empty($data['posts']) || !is_array($data['posts'])) {
            set_transient($cache_key, [], 5 * MINUTE_IN_SECONDS);
            return [];
        }

        set_transient($cache_key, $data['posts'], HOUR_IN_SECONDS);
        return $data['posts'];
    }

    /**
     * Fetch config/venues.json from GitHub with transient caching. The venue
     * registry drives JSON-LD addresses and event-card venue links; failures
     * return [] and everything falls back to the hardcoded address map.
     */
    public function fetch_venues_data() {
        $opts = $this->get_options();
        $cache_key = 'ch_venues_' . md5($opts['github_user'] . '_' . $opts['repo']);

        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }

        $url = sprintf(
            'https://raw.githubusercontent.com/%s/%s/main/config/venues.json',
            sanitize_text_field($opts['github_user']),
            sanitize_text_field($opts['repo'])
        );

        $response = wp_remote_get($url, ['timeout' => 10]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
            set_transient($cache_key, [], 5 * MINUTE_IN_SECONDS);
            return [];
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (!$data || empty($data['venues']) || !is_array($data['venues'])) {
            set_transient($cache_key, [], 5 * MINUTE_IN_SECONDS);
            return [];
        }

        set_transient($cache_key, $data['venues'], HOUR_IN_SECONDS);
        return $data['venues'];
    }

    /**
     * Look up a venue registry entry by (aliased) name. Returns the venue
     * array from config/venues.json or null. Index is built once per request.
     */
    private function venue_registry_entry($venue_name) {
        static $index = null;
        if ($index === null) {
            $index = [];
            foreach ($this->fetch_venues_data() as $v) {
                if (empty($v['name'])) continue;
                $index[$this->normalize_venue_key($v['name'])] = $v;
                foreach (($v['aliases'] ?? []) as $alias) {
                    $index[$this->normalize_venue_key($alias)] = $v;
                }
            }
        }
        $key = $this->normalize_venue_key($venue_name);
        return $index[$key] ?? null;
    }

    /**
     * venue name (and each alias) → venue page URL map, passed to the JS
     * renderer so client-side cards can link venue names too.
     */
    public function build_venue_pages_map() {
        $map = [];
        foreach ($this->fetch_venues_data() as $v) {
            if (empty($v['name']) || empty($v['slug'])) continue;
            if (isset($v['page']['enabled']) && !$v['page']['enabled']) continue;
            $url = home_url('/venues/' . $v['slug'] . '/');
            $map[$v['name']] = $url;
            foreach (($v['aliases'] ?? []) as $alias) {
                $map[$alias] = $url;
            }
        }
        return $map;
    }

    /**
     * URL of the venue's /venues/{slug}/ page, or '' when the venue has no
     * (enabled) page in the registry.
     */
    public function venue_page_url($venue_name) {
        $v = $this->venue_registry_entry($venue_name);
        if (!$v || empty($v['slug'])) {
            return '';
        }
        if (isset($v['page']['enabled']) && !$v['page']['enabled']) {
            return '';
        }
        return home_url('/venues/' . $v['slug'] . '/');
    }

    /**
     * Find the comedian post matching an event, if one exists. Used by both
     * the SSR card renderer and passed into JS for client-side render. Match
     * criteria: exact date + fuzzy "comedian name appears in event title".
     *
     * Returns the matching manifest post (assoc array) or null.
     */
    public function find_comedian_post_for_event($ev, $manifest_posts) {
        if (empty($manifest_posts) || empty($ev['date']) || empty($ev['name'])) {
            return null;
        }
        $ev_date = $ev['date'];
        $ev_name_lower = strtolower($ev['name']);

        foreach ($manifest_posts as $post) {
            if (($post['date'] ?? '') !== $ev_date) continue;
            $comedian_lower = strtolower($post['comedianName'] ?? '');
            if (!$comedian_lower) continue;
            if (strpos($ev_name_lower, $comedian_lower) !== false) {
                return $post;
            }
        }
        return null;
    }

    /**
     * "Now" in Houston, formatted. Every date comparison in this plugin
     * (Tonight/Tomorrow labels, today/weekend/week/month filters, render
     * windows) MUST use these instead of wp_date()/date(): wp_date() follows
     * the WP admin timezone setting, and if that setting is UTC (the WP
     * default) "today" rolls over at 7pm Houston time — so from 7pm onward
     * every listing page labels tomorrow's shows "Tonight". These are Houston
     * events; the market timezone is a constant, not a setting.
     */
    private function houston_date($format, $modifier = null) {
        $d = new DateTime('now', new DateTimeZone('America/Chicago'));
        if ($modifier !== null) {
            $d->modify($modifier);
        }
        return $d->format($format);
    }

    private function houston_date_from_ts($format, $ts) {
        $d = new DateTime('@' . $ts);
        $d->setTimezone(new DateTimeZone('America/Chicago'));
        return $d->format($format);
    }

    /**
     * The Fri/Sat/Sun dates of "this weekend" as Y-m-d, Houston time.
     *
     * On Sat/Sun this looks BACKWARD to the Friday just gone, so a Sunday
     * visitor still sees the whole weekend rather than next weekend's. Used
     * by both the weekend event filter and the {weekend_range} title token,
     * so the headline dates can never disagree with the events listed under
     * them.
     */
    private function weekend_window() {
        $dow = (int) $this->houston_date('w');
        if ($dow === 0) {
            return [
                $this->houston_date('Y-m-d', '-2 days'),
                $this->houston_date('Y-m-d', '-1 day'),
                $this->houston_date('Y-m-d'),
            ];
        }
        if ($dow === 6) {
            return [
                $this->houston_date('Y-m-d', '-1 day'),
                $this->houston_date('Y-m-d'),
                $this->houston_date('Y-m-d', '+1 day'),
            ];
        }
        $days_to_fri = 5 - $dow;
        return [
            $this->houston_date('Y-m-d', "+{$days_to_fri} days"),
            $this->houston_date('Y-m-d', '+' . ($days_to_fri + 1) . ' days'),
            $this->houston_date('Y-m-d', '+' . ($days_to_fri + 2) . ' days'),
        ];
    }

    /**
     * Filter events server-side (mirrors JS getFiltered() logic).
     */
    private function filter_events($events, $atts) {
        $today = $this->houston_date('Y-m-d');
        $tomorrow = $this->houston_date('Y-m-d', '+1 day');
        $filter = $atts['filter'];
        $venue_filter = $atts['venue'];
        $source_filter = $atts['source'];
        $max_price = $atts['max_price'] !== '' ? floatval($atts['max_price']) : null;
        $show_open_mic = strtolower($atts['show_open_mic']) !== 'false';
        $type_filter = $atts['type'];
        $tag_filter = $atts['tag'] ?? '';
        $max_date = $this->houston_date('Y-m-d', '+90 days');

        // Weekend: Fri-Sat-Sun (mirrors JS logic). Shared with the
        // {weekend_range} title token so headline and listings agree.
        $dow = (int) $this->houston_date('w');
        list($fri_date, $sat_date, $sun_date) = $this->weekend_window();

        $end_of_week = $this->houston_date('Y-m-d', '+' . (7 - $dow) . ' days');
        $end_of_month = $this->houston_date('Y-m-t');

        $filtered = [];
        foreach ($events as $ev) {
            $date = $ev['date'] ?? '';
            if (empty($date)) continue;
            if (($ev['status'] ?? '') === 'cancelled') continue;
            if ($date > $max_date) continue;

            // For weekend filter, allow past dates within the weekend window (Fri/Sat/Sun)
            // so a Sunday visitor still sees Friday & Saturday shows in "this weekend"
            if ($filter === 'weekend') {
                if ($date !== $fri_date && $date !== $sat_date && $date !== $sun_date) continue;
            } else {
                if ($date < $today) continue;
            }

            if ($filter === 'today' && $date !== $today) continue;
            if ($filter === 'tomorrow' && $date !== $tomorrow) continue;
            if ($filter === 'week' && $date > $end_of_week) continue;
            if ($filter === 'month' && $date > $end_of_month) continue;

            // Curated tag filter — events carry tags[] from ingest
            // (config/show-tags.json). Events without the field simply
            // never match, so old events.json payloads degrade safely.
            if ($tag_filter !== '' && !in_array($tag_filter, (array) ($ev['tags'] ?? []), true)) continue;

            if (!empty($venue_filter) && $venue_filter !== 'all' && ($ev['venue'] ?? '') !== $venue_filter) continue;
            if (!empty($source_filter) && $source_filter !== 'all' && ($ev['source'] ?? '') !== $source_filter) continue;

            // Prefer the explicit is_open_mic flag set at ingest by
            // scripts/fetch-events.js (title match + series allowlist +
            // curated mics — see config/open-mics.json). Title matching is
            // only a fallback for events.json files written before the flag
            // existed; on its own it made /open-mics/ a one-venue page.
            $name_lower = strtolower(str_replace('-', ' ', $ev['name'] ?? ''));
            $is_open_mic = array_key_exists('is_open_mic', $ev)
                ? !empty($ev['is_open_mic'])
                : strpos($name_lower, 'open mic') !== false;
            if (!$show_open_mic && $is_open_mic) continue;
            if ($type_filter === 'open_mic' && !$is_open_mic) continue;

            // type="free": only events with a confirmed $0 price. Events with
            // unknown pricing (null) are NOT assumed free.
            if ($type_filter === 'free') {
                $pm = $ev['price_min'] ?? null;
                if ($pm === null || floatval($pm) != 0) continue;
            }

            if ($max_price !== null) {
                $ev_price = $ev['price_min'] ?? null;
                if ($ev_price !== null && $ev_price != 0 && $ev_price > $max_price) continue;
            }

            $filtered[] = $ev;
        }

        usort($filtered, function ($a, $b) {
            $dc = strcmp($a['date'] ?? '', $b['date'] ?? '');
            return $dc !== 0 ? $dc : strcmp($a['time'] ?? '', $b['time'] ?? '');
        });

        return $filtered;
    }

    /**
     * Render server-side HTML for event cards (mirrors JS render/renderCard).
     */
    private function render_ssr_html($events, $opts, $redirect_base, $manifest_posts = []) {
        if (empty($events)) return '';

        $show_badges = (bool) $opts['show_source_badges'];
        $track = (bool) $opts['track_clicks'];

        $groups = [];
        foreach ($events as $ev) {
            $key = $ev['date'] ?? 'Unknown';
            $groups[$key][] = $ev;
        }

        $html = '';
        foreach ($groups as $date_str => $evts) {
            $label = $this->format_date_label($date_str);
            $count = count($evts);

            $html .= '<section class="date-group"><div class="date-header">';
            $html .= '<span class="date-header-text">' . $label . '</span>';
            $html .= '<span class="date-header-line"></span>';
            $html .= '<span class="date-header-count">' . $count . ' show' . ($count !== 1 ? 's' : '') . '</span>';
            $html .= '</div><div class="events-grid">';

            foreach ($evts as $ev) {
                $html .= $this->render_card_html($ev, $show_badges, $track, $redirect_base, $manifest_posts);
            }

            $html .= '</div></section>';
        }

        return $html;
    }

    private function render_card_html($ev, $show_badges, $track, $redirect_base, $manifest_posts = []) {
        $name = esc_html($ev['name'] ?? 'Untitled Event');
        $venue = esc_html($ev['venue'] ?? 'Unknown Venue');
        $image = $ev['image_url'] ?? '';
        $source = esc_attr($ev['source'] ?? '');
        $status = $ev['status'] ?? 'unknown';
        $status_label = esc_html(str_replace('_', ' ', $status));
        $day = esc_html($ev['day_of_week'] ?? '');
        $time = esc_html($ev['time'] ?? 'TBA');
        $age = $ev['age_restriction'] ?? null;

        if ($image) {
            // width/height are intrinsic-size hints (the CSS 16:9 box with
            // object-fit:cover controls display size) — they let the browser
            // reserve space before the image loads.
            $image_html = '<img src="' . esc_url($image) . '" alt="' . esc_attr($ev['name'] ?? '') . '" loading="lazy" decoding="async" width="640" height="360">';
        } else {
            $image_html = '<div class="card-image-placeholder"><span class="venue-icon">&#127908;</span><span class="venue-label">' . $venue . '</span></div>';
        }

        $price_html = $this->format_price_html(
            $ev['price_min'] ?? null,
            $ev['price_max'] ?? null,
            $ev['currency'] ?? 'USD',
            $ev['price_source'] ?? ''
        );

        $ticket_url = $ev['ticket_url'] ?? '';
        if ($ticket_url && $track && $redirect_base && $this->is_allowed_ticket_url($ticket_url)) {
            // URL-safe base64 (- and _ instead of + and /, no padding):
            // standard base64 can contain "+", which query-string parsing
            // turns into a space and breaks the redirect.
            $ticket_link = esc_url($redirect_base . rtrim(strtr(base64_encode($ticket_url), '+/', '-_'), '='));
        } else {
            // esc_url (not esc_attr): strips javascript:/data: schemes from
            // untrusted feed URLs, not just attribute-breaking characters.
            $ticket_link = esc_url($ticket_url);
        }

        // rel="sponsored nofollow": these are monetized outbound ticket links
        // (affiliate redirect) — Google requires sponsored/nofollow on paid
        // links, and it stops PageRank leaking to the ticket vendors.
        // Confirmed-free shows with no ticket link (curated open mics) are
        // walk-up events — "Coming Soon" would wrongly imply tickets are
        // pending.
        $is_free_walkup = !$ticket_url && isset($ev['price_min']) && $ev['price_min'] === 0;
        $ticket_html = $ticket_url
            ? '<a class="card-cta" href="' . $ticket_link . '" target="_blank" rel="sponsored nofollow noopener">Get Tickets <span class="arrow">&rarr;</span></a>'
            : ($is_free_walkup
                ? '<span class="card-cta" style="opacity:0.7;cursor:default;">Free &mdash; just show up</span>'
                : '<span class="card-cta" style="opacity:0.5;cursor:default;">Coming Soon</span>');

        // Internal link: if this event matches a published comedian post,
        // render a secondary "More info" link so visitors can read our
        // content instead of bouncing straight to the ticket vendor. This
        // closes the SEO → audience loop that was previously broken.
        $more_info_html = '';
        $matched_post = $this->find_comedian_post_for_event($ev, $manifest_posts);
        if ($matched_post && !empty($matched_post['wpLink'])) {
            $more_info_html = '<a class="card-cta card-cta-secondary" href="'
                . esc_url($matched_post['wpLink']) . '">More info</a>';
        }

        $card = '<article class="event-card">';
        $card .= '<div class="card-image">' . $image_html;
        if ($show_badges) {
            // "manual" is the internal source id for hand-curated mics — the
            // visitor-facing badge reads "curated".
            $source_label = ($ev['source'] ?? '') === 'manual' ? 'curated' : ($ev['source'] ?? '');
            $card .= '<span class="card-source-badge ' . $source . '">' . esc_html($source_label) . '</span>';
        }
        $card .= '<span class="card-status-badge ' . esc_attr($status) . '">' . $status_label . '</span>';
        $card .= '</div>';
        $card .= '<div class="card-body">';
        $card .= '<div class="card-date-time"><span>' . $day . '</span><span class="separator"></span><span>' . $time . '</span>';
        if ($age) {
            $card .= '<span class="separator"></span><span>' . esc_html($age) . '</span>';
        }
        $card .= '</div>';
        $card .= '<h3 class="card-name">' . $name . '</h3>';
        // Venue name links to its /venues/{slug}/ page when one exists
        // (internal links from every event card into the venue pages).
        $venue_page = $this->venue_page_url($ev['venue'] ?? '');
        $venue_html = $venue_page
            ? '<a href="' . esc_url($venue_page) . '">' . $venue . '</a>'
            : $venue;
        $card .= '<div class="card-venue">' . $venue_html . '</div>';
        $card .= '<div class="card-footer"><div class="card-price">' . $price_html . '</div>'
            . $more_info_html . $ticket_html . '</div>';

        // Performer-booking MVP: secondary text-link CTA under the ticket
        // row, only on events flagged eligible at ingest (performer_requests
        // — see config/performer-requests.json). Deliberately quieter than
        // "Get Tickets". Kept in sync with renderCard() in comedy-houston.js;
        // the click handler + modal live there (delegated, so SSR markup
        // works too).
        if (!empty($ev['performer_requests'])) {
            $card .= '<div class="card-perform-row"><button type="button" class="card-perform-link"'
                . ' data-event-id="' . esc_attr($ev['id'] ?? '') . '"'
                . ' data-event-name="' . esc_attr($ev['name'] ?? '') . '"'
                . ' data-venue="' . esc_attr($ev['venue'] ?? '') . '"'
                . ' data-event-date="' . esc_attr($ev['date'] ?? '') . '"'
                . ' data-event-time="' . esc_attr($ev['time'] ?? '') . '"'
                . ' data-event-source="' . esc_attr($ev['source'] ?? '') . '"'
                . ' data-open-mic="' . (!empty($ev['is_open_mic']) ? '1' : '') . '"'
                . '>&#127908; Interested in performing?</button></div>';
        }
        $card .= '</div></article>';

        return $card;
    }

    private function format_price_html($min, $max, $currency, $price_source = '') {
        if ($min === null && $max === null) return '<span class="from">Price TBA</span>';
        if (($min === 0 || $min === 0.0) && ($max === 0 || $max === 0.0 || $max === null)) {
            return '<span style="color:var(--success);font-weight:600;">Free</span>';
        }

        $fmt = function ($v) use ($currency) {
            if ($currency === 'USD') return '$' . number_format($v, 0);
            return number_format($v, 0) . ' ' . $currency;
        };

        // price_source "page" = scraped from the ticket page, where the
        // displayed number includes fees (unlike API face values). Label it
        // honestly instead of pretending it's face value.
        $fees_note = ($price_source === 'page') ? ' <span class="from">incl. fees</span>' : '';

        if ($min !== null && $max !== null && $min != $max) {
            return '<span class="from">From</span> ' . $fmt($min) . '&ndash;' . $fmt($max) . $fees_note;
        }
        if ($min !== null) {
            return '<span class="from">From</span> ' . $fmt($min) . $fees_note;
        }
        return '<span class="from">Up to</span> ' . $fmt($max) . $fees_note;
    }

    private function format_date_label($date_str) {
        $today = $this->houston_date('Y-m-d');
        $tomorrow = $this->houston_date('Y-m-d', '+1 day');

        if ($date_str === $today) return 'Tonight';
        if ($date_str === $tomorrow) return 'Tomorrow';

        $ts = strtotime($date_str . ' 12:00:00');
        $days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        $months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        $diff = (int) round((strtotime($date_str . ' 12:00:00') - strtotime($today . ' 12:00:00')) / 86400);
        $dow_idx = (int) date('w', $ts);
        $month_idx = (int) date('n', $ts) - 1;
        $day_num = (int) date('j', $ts);

        $prefix = '';
        if ($diff >= 2 && $diff <= 6) {
            $prefix = 'This ';
        } elseif ($diff >= 7 && $diff <= 13) {
            $prefix = 'Next ';
        }

        return $prefix . $days[$dow_idx] . ' &mdash; ' . $months[$month_idx] . ' ' . $day_num;
    }

    /**
     * Generate JSON-LD structured data for events (Google rich results).
     *
     * Emits an ItemList of Event items with the full set of Google-recommended
     * fields: TZ-aware startDate/endDate, performer, organizer, location with
     * streetAddress, offers.validFrom, image, description. Google uses these
     * to surface events in the "events near you" carousel and in per-comedian
     * knowledge panels.
     */
    private function render_jsonld($events) {
        if (empty($events)) return '';

        $schema_events = array_slice($events, 0, 50);

        $items = [];
        $pos = 1;
        foreach ($schema_events as $ev) {
            $venue_name = $ev['venue'] ?? 'Houston Venue';

            // Start/end dates with proper America/Chicago offset (DST-aware).
            // PHP's DateTime handles DST transitions automatically when you
            // construct with a DateTimeZone, so the offset flips between -06:00
            // (CST) and -05:00 (CDT) based on the event's actual date.
            $start_date = $this->build_iso_datetime($ev['date'] ?? '', $ev['time'] ?? '', '19:00');
            $end_date   = $this->build_iso_datetime($ev['date'] ?? '', $ev['time'] ?? '', '19:00', 120);

            // Location with street address from the venue map (falls back to
            // Houston/TX when the venue isn't in the map).
            $address = $this->venue_address($venue_name);

            $event_item = [
                '@type' => 'Event',
                'name' => $ev['name'] ?? 'Comedy Show',
                'startDate' => $start_date,
                'endDate' => $end_date,
                'eventAttendanceMode' => 'https://schema.org/OfflineEventAttendanceMode',
                'eventStatus' => $this->map_status_schema($ev['status'] ?? 'on_sale'),
                'location' => [
                    '@type' => 'Place',
                    'name' => $venue_name,
                    'address' => $address,
                ],
                'organizer' => [
                    '@type' => 'Organization',
                    'name' => $venue_name,
                ],
            ];

            // Performer: a Person node keyed off the headliner extracted from
            // the event title. Lets Google connect the event to each comedian's
            // knowledge graph entity ("Mo Amer upcoming tour dates").
            $performer_name = $this->extract_performer_name($ev['name'] ?? '');
            if ($performer_name) {
                $event_item['performer'] = [
                    '@type' => 'Person',
                    'name' => $performer_name,
                ];
            }

            if (!empty($ev['image_url'])) {
                $event_item['image'] = $ev['image_url'];
            }

            if (!empty($ev['description'])) {
                $event_item['description'] = mb_substr($ev['description'], 0, 300);
            }

            // Offers. schema.org's `price` is a RECOMMENDED field on Offer,
            // not required — an Offer with just url + availability is valid
            // and still gets the ticket URL into structured data (Google may
            // flag the missing price as a warning, never an error). So: emit
            // an Offer whenever there's a ticket URL, and add the price
            // fields only when the price is actually known (including 0 for
            // free shows). We never fabricate a price.
            //
            // …and never on a show that has already started. The weekend
            // filter deliberately keeps Friday and Saturday shows visible
            // through Sunday so a Sunday visitor sees the whole weekend —
            // which means /this-weekend/ carries past events for two days
            // out of seven. Advertising InStock on those is the same GSC
            // error the dated post pages had.
            $event_started = strtotime($start_date) !== false && strtotime($start_date) < time();
            if (!empty($ev['ticket_url']) && !$event_started) {
                $offer = [
                    '@type' => 'Offer',
                    'url' => $ev['ticket_url'],
                    'availability' => 'https://schema.org/InStock',
                    // validFrom = when tickets went on sale. We don't track the
                    // real on-sale date, so use last_updated as a floor.
                    'validFrom' => !empty($ev['last_updated'])
                        ? $ev['last_updated']
                        : gmdate('Y-m-d\TH:i:s\Z'),
                ];
                if (isset($ev['price_min']) && $ev['price_min'] !== null) {
                    $offer['priceCurrency'] = $ev['currency'] ?? 'USD';
                    // Google's Event guidelines want a `price` field — use
                    // price_min as the canonical price and also mirror it to
                    // lowPrice for range-offer consumers.
                    $offer['price'] = $ev['price_min'];
                    $offer['lowPrice'] = $ev['price_min'];
                    if (isset($ev['price_max']) && $ev['price_max'] !== null) {
                        $offer['highPrice'] = $ev['price_max'];
                    }
                }
                $event_item['offers'] = $offer;
            }

            $items[] = [
                '@type' => 'ListItem',
                'position' => $pos,
                'item' => $event_item,
            ];
            $pos++;
        }

        $schema = [
            '@context' => 'https://schema.org',
            '@type' => 'ItemList',
            'name' => 'Houston Comedy Shows',
            'description' => 'Upcoming comedy shows in Houston, TX',
            'numberOfItems' => count($schema_events),
            'itemListElement' => $items,
        ];

        // JSON_HEX_TAG guards against "</script>" breakout via untrusted event
        // names/descriptions from the Ticketmaster/Eventbrite feeds.
        return '<script type="application/ld+json">' . wp_json_encode($schema, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_HEX_TAG) . '</script>';
    }

    /**
     * Build an ISO-8601 datetime string in America/Chicago (DST-aware).
     * $date       = "YYYY-MM-DD"
     * $time       = "7:30 PM" or "19:30" or "" (if empty, $default_time_24h is used)
     * $default    = "19:00" fallback when no time is known
     * $offset_min = add N minutes (used for endDate = start + 120)
     *
     * Returns e.g. "2026-04-10T19:30:00-05:00" or "" if the date is invalid.
     */
    private function build_iso_datetime($date, $time, $default_time_24h = '19:00', $offset_min = 0) {
        if (empty($date)) return '';
        $time_24h = $this->time_to_24h($time);
        if (!$time_24h) $time_24h = $default_time_24h;

        try {
            $tz = new DateTimeZone('America/Chicago');
            $dt = DateTime::createFromFormat('Y-m-d H:i', $date . ' ' . $time_24h, $tz);
            if (!$dt) return '';
            if ($offset_min !== 0) {
                $dt->modify(sprintf('%+d minutes', $offset_min));
            }
            return $dt->format('c'); // ISO 8601 with offset, e.g. 2026-04-10T19:30:00-05:00
        } catch (Exception $e) {
            return '';
        }
    }

    private function time_to_24h($time_str) {
        if (empty($time_str)) return '';
        $ts = strtotime($time_str);
        if ($ts === false) return '';
        return date('H:i', $ts);
    }

    private function map_status_schema($status) {
        $map = [
            'on_sale' => 'https://schema.org/EventScheduled',
            'off_sale' => 'https://schema.org/EventScheduled',
            'cancelled' => 'https://schema.org/EventCancelled',
            'postponed' => 'https://schema.org/EventPostponed',
            'rescheduled' => 'https://schema.org/EventRescheduled',
        ];
        return $map[$status] ?? 'https://schema.org/EventScheduled';
    }

    /**
     * Venue → PostalAddress lookup.
     *
     * ⚠️ Addresses below are hand-verified against Google Maps. If you add a
     * new venue, look it up first and add it here — Google's event validator
     * will warn about missing streetAddress, which hurts the "events near you"
     * carousel eligibility.
     *
     * Match is case-insensitive, leading/trailing whitespace stripped,
     * punctuation normalized. Unknown venues fall back to city/state only.
     */
    private function venue_address($venue_name) {
        // Registry (config/venues.json fetched from GitHub) wins when it has
        // a street address; the hardcoded map below is the offline fallback.
        $entry = $this->venue_registry_entry($venue_name);
        if ($entry && !empty($entry['address']['street'])) {
            $a = $entry['address'];
            return [
                '@type'           => 'PostalAddress',
                'streetAddress'   => $a['street'],
                'addressLocality' => !empty($a['locality']) ? $a['locality'] : 'Houston',
                'addressRegion'   => !empty($a['region']) ? $a['region'] : 'TX',
                'addressCountry'  => 'US',
            ] + (!empty($a['postal']) ? ['postalCode' => $a['postal']] : []);
        }

        $key = $this->normalize_venue_key($venue_name);

        $map = [
            'punch line houston' => [
                'street' => '2930 Sage Rd',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77056',
            ],
            'houston improv' => [
                'street' => '7620 Katy Fwy #431',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77024',
            ],
            'the secret group' => [
                'street' => '2101 Polk St',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77003',
            ],
            // Rudyard's (the Montrose pub itself) is still at Waugh Dr. The
            // Riot Comedy Club, which used to run upstairs here, has RELOCATED
            // (see below) — keep this key pointed at the pub, not the club.
            'rudyards' => [
                'street' => '2010 Waugh Dr',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77006',
            ],
            // The Riot Comedy Club relocated from Upstairs at Rudyard's to
            // 1925 Washington Ave (zip owner-verified). This fallback is only
            // used if the config/venues.json registry fetch fails; the registry
            // is the source of truth.
            'the riot comedy club upstairs at rudyards' => [
                'street' => '1925 Washington Ave',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77007',
            ],
            'the riot comedy club' => [
                'street' => '1925 Washington Ave',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77007',
            ],
            // The Riot's second location, at GuadalaHARRY's in Conroe.
            'the riot comedy club conroe' => [
                'street' => '219 Simonton St',
                'locality' => 'Conroe',
                'region' => 'TX',
                'postal' => '77301',
            ],
            'the den comedy club' => [
                'street' => '201 Woodard St',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77009',
            ],
            // TODO: Verify and add The Gordy's street address, plus any other
            // venues that start appearing in events.json. Unknown venues still
            // get a valid (city-only) PostalAddress via the fallback below.
        ];

        $address = [
            '@type' => 'PostalAddress',
            'addressLocality' => 'Houston',
            'addressRegion' => 'TX',
            'addressCountry' => 'US',
        ];

        if (isset($map[$key])) {
            $m = $map[$key];
            $address['streetAddress'] = $m['street'];
            $address['addressLocality'] = $m['locality'];
            $address['addressRegion'] = $m['region'];
            if (!empty($m['postal'])) {
                $address['postalCode'] = $m['postal'];
            }
        }

        return $address;
    }

    private function normalize_venue_key($venue_name) {
        $key = strtolower(trim((string) $venue_name));
        // Drop punctuation and collapse whitespace so "Rudyard's" matches "Rudyards".
        $key = preg_replace('/[^a-z0-9\s]/', '', $key);
        $key = preg_replace('/\s+/', ' ', $key);
        return trim($key);
    }

    /**
     * Pull the headliner name out of an event title for schema.org performer.
     *
     * Handles:
     *   "Mo Amer"                          → "Mo Amer"
     *   "Jaboukie Young-White"             → "Jaboukie Young-White"
     *   "Ali Siddiq: The Domino Effect"    → "Ali Siddiq"
     *   "Andy Huggins & Friends"           → "Andy Huggins"
     *   "Mark Viera Live at Punch Line"    → "Mark Viera"
     *   "Peter Revello Headlines The Riot" → "Peter Revello"
     *   "Open Mic Night"                   → "" (rejected — generic)
     *
     * If the result looks like a generic event name (open mic, showcase,
     * roast battle, etc.) we return "" and the caller skips performer.
     */
    private function extract_performer_name($event_name) {
        if (empty($event_name)) return '';

        $name = trim($event_name);

        // Cut at common separators that introduce tour/show subtitles.
        foreach ([':', ' - ', ' — ', ' – ', ' (', ' feat', ' ft'] as $sep) {
            $pos = stripos($name, $sep);
            if ($pos !== false) {
                $name = trim(substr($name, 0, $pos));
            }
        }

        // Drop everything from "& Friends", "with", "Live at", "Headlines", etc.
        $stop_patterns = [
            '/\s+&\s+Friends\b.*$/i',
            '/\s+\bwith\b.*$/i',
            '/\s+\bLive at\b.*$/i',
            '/\s+\bat the\b.*$/i',
            '/\s+\bat\b\s+[A-Z].*$/',
            '/\s+\bHeadlines\b.*$/i',
            '/\s+\bHeadlining\b.*$/i',
            '/\s+\bPresents\b.*$/i',
            '/\s+\bComedy Tour\b.*$/i',
            '/\s+\bTour\b.*$/i',
        ];
        foreach ($stop_patterns as $pattern) {
            $name = preg_replace($pattern, '', $name);
        }

        $name = trim($name);

        // Reject generic / non-person event names so we don't pollute the
        // performer slot with "Open Mic Night" or "Comedy Showcase".
        $generic = [
            'open mic', 'showcase', 'roast battle', 'comedy night',
            'stand up', 'stand-up', 'karaoke', 'improv jam', 'new talent',
            'comedy show', 'comedy jam',
        ];
        $lower = strtolower($name);
        foreach ($generic as $g) {
            if (strpos($lower, $g) !== false) return '';
        }

        // Require at least two words (a first + last name) and a reasonable
        // length so we don't accept 1-word artist aliases or 200-char blurbs.
        $word_count = str_word_count($name);
        if ($word_count < 2 || strlen($name) > 60) return '';

        return $name;
    }

    // =========================================================================
    // CLICK ANALYTICS HELPERS
    // =========================================================================

    /**
     * Extract a human-readable label from a ticket URL.
     * Turns "https://www.ticketmaster.com/ali-siddiq-domino-effect-tour/event/123"
     * into "Ali Siddiq Domino Effect Tour".
     */
    private function extract_link_label($url) {
        $parsed = wp_parse_url($url);
        $path = $parsed['path'] ?? '';

        // Ticketmaster: /event-name-slug/event/ID or /event-name-slug/event/ID
        if (strpos($url, 'ticketmaster.com') !== false) {
            // Remove leading slash and trailing segments like /event/ID
            $path = trim($path, '/');
            $parts = explode('/', $path);
            // First segment is usually the slug
            $slug = $parts[0] ?? '';
            if ($slug && $slug !== 'event') {
                return ucwords(str_replace('-', ' ', $slug));
            }
        }

        // Eventbrite: /e/event-name-slug-DIGITS
        if (strpos($url, 'eventbrite.com') !== false) {
            $path = trim($path, '/');
            // Remove leading "e/" prefix
            if (strpos($path, 'e/') === 0) {
                $path = substr($path, 2);
            }
            // Remove trailing ticket ID digits
            $slug = preg_replace('/-\d+$/', '', $path);
            if ($slug) {
                return ucwords(str_replace('-', ' ', $slug));
            }
        }

        // Fallback: use the hostname
        return $parsed['host'] ?? $url;
    }

    // =========================================================================
    // ADMIN SETTINGS PAGE
    // =========================================================================

    public function add_settings_page() {
        add_options_page(
            'Comedy Houston Settings',
            'Comedy Houston',
            'manage_options',
            'comedy-houston',
            [$this, 'render_settings_page']
        );
    }

    public function register_settings() {
        register_setting('comedy_houston_group', self::OPTION_KEY, [
            'sanitize_callback' => [$this, 'sanitize_settings'],
        ]);

        // --- Appearance section ---
        add_settings_section(
            'ch_appearance',
            'Appearance',
            function () { echo '<p>Control how the event listings look on your site.</p>'; },
            'comedy-houston'
        );

        add_settings_field('color_scheme', 'Color Scheme', [$this, 'field_color_scheme'], 'comedy-houston', 'ch_appearance');
        add_settings_field('show_source_badges', 'Source Badges', [$this, 'field_show_source_badges'], 'comedy-houston', 'ch_appearance');

        // --- Data Source section ---
        add_settings_section(
            'ch_data',
            'Data Source',
            function () { echo '<p>Where to fetch event data from.</p>'; },
            'comedy-houston'
        );

        add_settings_field('github_user', 'GitHub Username', [$this, 'field_github_user'], 'comedy-houston', 'ch_data');
        add_settings_field('repo', 'GitHub Repo', [$this, 'field_repo'], 'comedy-houston', 'ch_data');

        // --- Affiliate section ---
        add_settings_section(
            'ch_affiliate',
            'Affiliate Tracking',
            function () { echo '<p>Enter your affiliate IDs. "Get Tickets" links will route through your site for click tracking and append your affiliate parameters automatically.</p>'; },
            'comedy-houston'
        );

        add_settings_field('tm_affiliate', 'Ticketmaster Affiliate ID', [$this, 'field_tm_affiliate'], 'comedy-houston', 'ch_affiliate');
        add_settings_field('eb_affiliate', 'Eventbrite Affiliate ID', [$this, 'field_eb_affiliate'], 'comedy-houston', 'ch_affiliate');
        add_settings_field('track_clicks', 'Log Clicks', [$this, 'field_track_clicks'], 'comedy-houston', 'ch_affiliate');

        // --- SEO / Schema section ---
        add_settings_section(
            'ch_seo',
            'SEO & Schema',
            function () { echo '<p>Organization structured data emitted site-wide (skipped automatically if Yoast/Rank Math/AIOSEO/SEOPress is active).</p>'; },
            'comedy-houston'
        );

        add_settings_field('org_name', 'Organization Name', [$this, 'field_org_name'], 'comedy-houston', 'ch_seo');
        add_settings_field('org_logo', 'Organization Logo URL', [$this, 'field_org_logo'], 'comedy-houston', 'ch_seo');
        add_settings_field('org_sameas', 'Social Profiles (sameAs)', [$this, 'field_org_sameas'], 'comedy-houston', 'ch_seo');
    }

    public function sanitize_settings($input) {
        $clean = [];
        $clean['github_user']  = sanitize_text_field($input['github_user'] ?? '');
        $clean['repo']         = sanitize_text_field($input['repo'] ?? '');
        $clean['color_scheme'] = in_array($input['color_scheme'] ?? '', ['dark', 'light', 'auto'], true)
            ? $input['color_scheme'] : 'dark';
        $clean['show_source_badges'] = !empty($input['show_source_badges']) ? '1' : '0';
        $clean['tm_affiliate'] = sanitize_text_field($input['tm_affiliate'] ?? '');
        $clean['eb_affiliate'] = sanitize_text_field($input['eb_affiliate'] ?? '');
        $clean['track_clicks'] = !empty($input['track_clicks']) ? '1' : '0';
        $clean['org_name']     = sanitize_text_field($input['org_name'] ?? '');
        $clean['org_logo']     = esc_url_raw($input['org_logo'] ?? '');
        $clean['org_sameas']   = sanitize_textarea_field($input['org_sameas'] ?? '');
        return $clean;
    }

    // --- Field renderers ---

    public function field_color_scheme() {
        $opts = $this->get_options();
        $val  = $opts['color_scheme'];
        ?>
        <select name="<?php echo self::OPTION_KEY; ?>[color_scheme]">
            <option value="dark"  <?php selected($val, 'dark'); ?>>Dark — Black background, light text</option>
            <option value="light" <?php selected($val, 'light'); ?>>Light — White background, dark text</option>
            <option value="auto"  <?php selected($val, 'auto'); ?>>Auto — Match visitor's system preference</option>
        </select>
        <p class="description">Choose the palette for the event listings. "Auto" uses the visitor's OS dark/light mode setting.</p>
        <?php
    }

    public function field_show_source_badges() {
        $opts = $this->get_options();
        printf(
            '<label><input type="checkbox" name="%s[show_source_badges]" value="1" %s> Show "ticketmaster" / "eventbrite" badge on event cards</label>',
            self::OPTION_KEY, checked($opts['show_source_badges'], '1', false)
        );
        echo '<p class="description">Displays a small source label in the top-right corner of each card image.</p>';
    }

    public function field_github_user() {
        $opts = $this->get_options();
        printf(
            '<input type="text" name="%s[github_user]" value="%s" class="regular-text">',
            self::OPTION_KEY, esc_attr($opts['github_user'])
        );
    }

    public function field_repo() {
        $opts = $this->get_options();
        printf(
            '<input type="text" name="%s[repo]" value="%s" class="regular-text">',
            self::OPTION_KEY, esc_attr($opts['repo'])
        );
    }

    public function field_tm_affiliate() {
        $opts = $this->get_options();
        printf(
            '<input type="text" name="%s[tm_affiliate]" value="%s" class="regular-text" placeholder="e.g. abc123">',
            self::OPTION_KEY, esc_attr($opts['tm_affiliate'])
        );
        echo '<p class="description">Your Ticketmaster affiliate/partner ID. Appended as <code>?at_aid=YOUR_ID</code> to ticket links.</p>';
    }

    public function field_eb_affiliate() {
        $opts = $this->get_options();
        printf(
            '<input type="text" name="%s[eb_affiliate]" value="%s" class="regular-text" placeholder="e.g. xyz789">',
            self::OPTION_KEY, esc_attr($opts['eb_affiliate'])
        );
        echo '<p class="description">Your Eventbrite affiliate ID. Appended as <code>?aff=YOUR_ID</code> to ticket links.</p>';
    }

    public function field_track_clicks() {
        $opts = $this->get_options();
        printf(
            '<label><input type="checkbox" name="%s[track_clicks]" value="1" %s> Record every "Get Tickets" click in the database</label>',
            self::OPTION_KEY, checked($opts['track_clicks'], '1', false)
        );
        echo '<p class="description">Logs timestamp, hashed IP, and destination URL. Useful for analytics.</p>';
    }

    public function field_org_name() {
        $opts = $this->get_options();
        printf(
            '<input type="text" name="%s[org_name]" value="%s" class="regular-text">',
            self::OPTION_KEY, esc_attr($opts['org_name'])
        );
        echo '<p class="description">Used as the Organization <code>name</code> in JSON-LD. Defaults to the site title if empty.</p>';
    }

    public function field_org_logo() {
        $opts = $this->get_options();
        printf(
            '<input type="url" name="%s[org_logo]" value="%s" class="regular-text" placeholder="https://comedyhouston.com/logo.png">',
            self::OPTION_KEY, esc_attr($opts['org_logo'])
        );
        echo '<p class="description">Square logo, at least 112&times;112px. Falls back to the Site Icon if empty.</p>';
    }

    public function field_org_sameas() {
        $opts = $this->get_options();
        printf(
            '<textarea name="%s[org_sameas]" rows="4" class="large-text code" placeholder="https://www.instagram.com/comedyhoustontx/">%s</textarea>',
            self::OPTION_KEY, esc_textarea($opts['org_sameas'])
        );
        echo '<p class="description">One URL per line — Instagram, Facebook, X, YouTube, etc. Emitted as the Organization <code>sameAs</code> array.</p>';
    }

    public function render_settings_page() {
        if (!current_user_can('manage_options')) return;

        // Show click stats summary
        global $wpdb;
        $table = $wpdb->prefix . self::CLICKS_TABLE;
        $total_clicks = 0;
        $clicks_today = 0;
        if ($wpdb->get_var($wpdb->prepare("SHOW TABLES LIKE %s", $table)) === $table) {
            $total_clicks = (int) $wpdb->get_var("SELECT COUNT(*) FROM $table");
            $clicks_today = (int) $wpdb->get_var($wpdb->prepare(
                "SELECT COUNT(*) FROM $table WHERE clicked_at >= %s",
                current_time('Y-m-d') . ' 00:00:00'
            ));
        }
        ?>
        <div class="wrap">
            <h1>Comedy Houston Settings</h1>

            <?php if ($total_clicks > 0 || $clicks_today > 0): ?>
            <div class="notice notice-info" style="padding: 12px;">
                <strong>Click Tracking:</strong>
                <?php echo esc_html($clicks_today); ?> clicks today &middot;
                <?php echo esc_html($total_clicks); ?> total clicks recorded
            </div>

            <?php
            // --- Top 10 Clicked Links: Today ---
            $top_today = $wpdb->get_results($wpdb->prepare(
                "SELECT original_url, COUNT(*) AS click_count
                 FROM $table
                 WHERE clicked_at >= %s
                 GROUP BY original_url
                 ORDER BY click_count DESC
                 LIMIT 10",
                current_time('Y-m-d') . ' 00:00:00'
            ));

            // --- Top 10 Clicked Links: Last 30 Days ---
            $top_30d = $wpdb->get_results($wpdb->prepare(
                "SELECT original_url, COUNT(*) AS click_count
                 FROM $table
                 WHERE clicked_at >= %s
                 GROUP BY original_url
                 ORDER BY click_count DESC
                 LIMIT 10",
                wp_date('Y-m-d', strtotime('-30 days')) . ' 00:00:00'
            ));
            ?>

            <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-top: 12px;">
                <!-- Today's Top Clicks -->
                <div style="flex: 1; min-width: 350px;">
                    <h3 style="margin-top: 0;">Top Clicked Today</h3>
                    <?php if (!empty($top_today)): ?>
                    <table class="widefat striped" style="max-width: 100%;">
                        <thead><tr><th>#</th><th>Show / Link</th><th style="text-align:right;">Clicks</th></tr></thead>
                        <tbody>
                        <?php foreach ($top_today as $i => $row):
                            // Extract a readable label from the URL
                            $label = $this->extract_link_label($row->original_url);
                        ?>
                            <tr>
                                <td><?php echo (int)$i + 1; ?></td>
                                <td>
                                    <strong><?php echo esc_html($label); ?></strong><br>
                                    <a href="<?php echo esc_url($row->original_url); ?>" target="_blank" rel="noopener" style="font-size: 11px; color: #888; word-break: break-all;"><?php echo esc_html($row->original_url); ?></a>
                                </td>
                                <td style="text-align:right; font-weight: 600; font-size: 16px;"><?php echo (int)$row->click_count; ?></td>
                            </tr>
                        <?php endforeach; ?>
                        </tbody>
                    </table>
                    <?php else: ?>
                    <p style="color: #888;">No clicks recorded today yet.</p>
                    <?php endif; ?>
                </div>

                <!-- Last 30 Days Top Clicks -->
                <div style="flex: 1; min-width: 350px;">
                    <h3 style="margin-top: 0;">Top Clicked — Last 30 Days</h3>
                    <?php if (!empty($top_30d)): ?>
                    <table class="widefat striped" style="max-width: 100%;">
                        <thead><tr><th>#</th><th>Show / Link</th><th style="text-align:right;">Clicks</th></tr></thead>
                        <tbody>
                        <?php foreach ($top_30d as $i => $row):
                            $label = $this->extract_link_label($row->original_url);
                        ?>
                            <tr>
                                <td><?php echo (int)$i + 1; ?></td>
                                <td>
                                    <strong><?php echo esc_html($label); ?></strong><br>
                                    <a href="<?php echo esc_url($row->original_url); ?>" target="_blank" rel="noopener" style="font-size: 11px; color: #888; word-break: break-all;"><?php echo esc_html($row->original_url); ?></a>
                                </td>
                                <td style="text-align:right; font-weight: 600; font-size: 16px;"><?php echo (int)$row->click_count; ?></td>
                            </tr>
                        <?php endforeach; ?>
                        </tbody>
                    </table>
                    <?php else: ?>
                    <p style="color: #888;">No clicks in the last 30 days.</p>
                    <?php endif; ?>
                </div>
            </div>

            <?php endif; ?>

            <form method="post" action="options.php">
                <?php
                settings_fields('comedy_houston_group');
                do_settings_sections('comedy-houston');
                submit_button();
                ?>
            </form>

            <hr>
            <h2>Usage</h2>
            <p>Add this shortcode to any page or post:</p>
            <code>[comedy_houston]</code>

            <h3 style="margin-top: 16px;">Shortcode Parameters</h3>
            <table class="widefat" style="max-width: 800px; margin-top: 8px;">
                <thead><tr><th>Parameter</th><th>Values</th><th>Default</th></tr></thead>
                <tbody>
                    <tr><td><code>filter</code></td><td>all, today, tomorrow, weekend, week, month</td><td>all</td></tr>
                    <tr><td><code>max_price</code></td><td>number — only shows with price_min &le; this value (free shows included)</td><td><em>none</em></td></tr>
                    <tr><td><code>venue</code></td><td>venue name string</td><td><em>all venues</em></td></tr>
                    <tr><td><code>source</code></td><td>ticketmaster, eventbrite, standuptix</td><td><em>all sources</em></td></tr>
                    <tr><td><code>title</code></td><td>custom hero title text</td><td>Every Comedy Show in Houston</td></tr>
                    <tr><td><code>theme</code></td><td>dark, light, auto</td><td><em>global setting</em></td></tr>
                    <tr><td><code>show_hero</code></td><td>true, false</td><td>true</td></tr>
                    <tr><td><code>show_controls</code></td><td>true, false</td><td>true</td></tr>
                    <tr><td><code>show_venue_filter</code></td><td>true, false — show/hide the venue dropdown</td><td>true</td></tr>
                    <tr><td><code>show_sort</code></td><td>true, false — show/hide the sort dropdown</td><td>true</td></tr>
                    <tr><td><code>show_open_mic</code></td><td>true, false — include/exclude open-mic events (flagged at ingest via config/open-mics.json)</td><td>true</td></tr>
                    <tr><td><code>type</code></td><td>open_mic (events flagged is_open_mic), free (confirmed $0 shows only)</td><td><em>all types</em></td></tr>
                    <tr><td><code>initial_days</code></td><td>number — initial render window in days for the &ldquo;all&rdquo; view (0 = no cap); a &ldquo;Show all&rdquo; button reveals the rest</td><td>14</td></tr>
                    <tr><td><code>show_footer</code></td><td>true, false</td><td>true</td></tr>
                </tbody>
            </table>

            <h3 style="margin-top: 16px;">Examples</h3>
            <p><strong>Weekend shows (for blog posts):</strong></p>
            <code>[comedy_houston filter="weekend" show_hero="false" show_controls="false" show_footer="false"]</code>
            <p style="margin-top: 8px;"><strong>Free &amp; cheap shows:</strong></p>
            <code>[comedy_houston max_price="10" show_hero="false" show_controls="false" show_footer="false"]</code>
            <p style="margin-top: 8px;"><strong>Specific venue:</strong></p>
            <code>[comedy_houston venue="Houston Improv" show_controls="false"]</code>
            <p style="margin-top: 8px;"><strong>Open mics only (for blog posts):</strong></p>
            <code>[comedy_houston type="open_mic" show_hero="false" show_controls="false" show_footer="false"]</code>
        </div>
        <?php
    }
}

new Comedy_Houston_Plugin();
