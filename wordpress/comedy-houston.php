<?php
/**
 * Plugin Name: Comedy Houston Shows
 * Description: Displays Houston comedy event listings with configurable theme and affiliate click tracking.
 * Version: 2.5.0
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

    const VERSION      = '2.5.0';
    const SHORTCODE    = 'comedy_houston';
    const OPTION_KEY   = 'comedy_houston_settings';
    const REDIRECT_VAR = 'ch_go';
    const CLICKS_TABLE = 'ch_clicks';

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

        // Comedian-post schema: receive via REST custom field, emit from wp_head.
        // Keeps the <script type="application/ld+json"> tag out of post_content
        // entirely so wp_kses_post can't strip it on publish and so content
        // edits in Gutenberg can't corrupt the JSON graph.
        add_action('rest_api_init', [$this, 'register_comedian_schema_field']);
        add_action('wp_head', [$this, 'emit_comedian_schema_head'], 20);

        // Site-wide Organization JSON-LD (skipped when an SEO plugin that
        // already emits Organization schema is active).
        add_action('wp_head', [$this, 'emit_organization_schema'], 5);

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
            $ch_ssr_html = $this->render_ssr_html($filtered, $opts, $redirect_base, $manifest_posts);
            $ch_ssr_jsonld = $this->render_jsonld($filtered);
            if (!empty($events_data['last_updated'])) {
                $ts = strtotime($events_data['last_updated']);
                if ($ts) {
                    $ch_ssr_updated_at = wp_date('M j, g:i A', $ts);
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

    public function handle_redirect() {
        if (empty($_GET[self::REDIRECT_VAR])) {
            return;
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

        // Log the click
        if ($opts['track_clicks']) {
            $this->log_click($decoded, $target_url);
        }

        // Redirect — use wp_redirect since it's an external URL
        wp_redirect(esc_url_raw($target_url), 302);
        exit;
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
        register_rest_field('post', 'ch_schema_graph', [
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
    public function emit_comedian_schema_head() {
        if (!is_singular('post')) {
            return;
        }
        $post = get_queried_object();
        if (!$post || empty($post->ID)) {
            return;
        }
        // Scope to the comedy-shows category so we don't pollute the schema
        // graph of unrelated posts that might end up with this meta set.
        if (!has_category('comedy-shows', $post)) {
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
        $clean = wp_json_encode($decoded, JSON_UNESCAPED_SLASHES);
        if (!is_string($clean) || $clean === '') {
            return;
        }
        echo "\n<script type=\"application/ld+json\">" . $clean . "</script>\n";
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
            . wp_json_encode($org, JSON_UNESCAPED_SLASHES)
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
        $opts = $this->get_options();
        $cache_key = 'ch_events_' . md5($opts['github_user'] . '_' . $opts['repo']);

        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }

        $url = sprintf(
            'https://raw.githubusercontent.com/%s/%s/main/events.json',
            sanitize_text_field($opts['github_user']),
            sanitize_text_field($opts['repo'])
        );

        $response = wp_remote_get($url, ['timeout' => 10]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
            return null;
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (!$data || empty($data['events'])) {
            return null;
        }

        set_transient($cache_key, $data, HOUR_IN_SECONDS);
        return $data;
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
     * Filter events server-side (mirrors JS getFiltered() logic).
     */
    private function filter_events($events, $atts) {
        $today = wp_date('Y-m-d');
        $tomorrow = wp_date('Y-m-d', strtotime('+1 day'));
        $filter = $atts['filter'];
        $venue_filter = $atts['venue'];
        $source_filter = $atts['source'];
        $max_price = $atts['max_price'] !== '' ? floatval($atts['max_price']) : null;
        $show_open_mic = strtolower($atts['show_open_mic']) !== 'false';
        $type_filter = $atts['type'];
        $max_date = wp_date('Y-m-d', strtotime('+90 days'));

        // Weekend: Fri-Sat-Sun (mirrors JS logic)
        $dow = (int) wp_date('w');
        if ($dow === 0) {
            $fri_date = wp_date('Y-m-d', strtotime('-2 days'));
            $sat_date = wp_date('Y-m-d', strtotime('-1 day'));
            $sun_date = $today;
        } elseif ($dow === 6) {
            $fri_date = wp_date('Y-m-d', strtotime('-1 day'));
            $sat_date = $today;
            $sun_date = $tomorrow;
        } else {
            $days_to_fri = 5 - $dow;
            $fri_date = wp_date('Y-m-d', strtotime("+{$days_to_fri} days"));
            $sat_date = wp_date('Y-m-d', strtotime('+' . ($days_to_fri + 1) . ' days'));
            $sun_date = wp_date('Y-m-d', strtotime('+' . ($days_to_fri + 2) . ' days'));
        }

        $end_of_week = wp_date('Y-m-d', strtotime('+' . (7 - $dow) . ' days'));
        $end_of_month = wp_date('Y-m-t');

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

            if (!empty($venue_filter) && $venue_filter !== 'all' && ($ev['venue'] ?? '') !== $venue_filter) continue;
            if (!empty($source_filter) && $source_filter !== 'all' && ($ev['source'] ?? '') !== $source_filter) continue;

            $name_lower = strtolower(str_replace('-', ' ', $ev['name'] ?? ''));
            $is_open_mic = strpos($name_lower, 'open mic') !== false;
            if (!$show_open_mic && $is_open_mic) continue;
            if ($type_filter === 'open_mic' && !$is_open_mic) continue;

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
            $image_html = '<img src="' . esc_attr($image) . '" alt="' . esc_attr($ev['name'] ?? '') . '" loading="lazy">';
        } else {
            $image_html = '<div class="card-image-placeholder"><span class="venue-icon">&#127908;</span><span class="venue-label">' . $venue . '</span></div>';
        }

        $price_html = $this->format_price_html($ev['price_min'] ?? null, $ev['price_max'] ?? null, $ev['currency'] ?? 'USD');

        $ticket_url = $ev['ticket_url'] ?? '';
        if ($ticket_url && $track && $redirect_base && $this->is_allowed_ticket_url($ticket_url)) {
            // URL-safe base64 (- and _ instead of + and /, no padding):
            // standard base64 can contain "+", which query-string parsing
            // turns into a space and breaks the redirect.
            $ticket_link = esc_attr($redirect_base . rtrim(strtr(base64_encode($ticket_url), '+/', '-_'), '='));
        } else {
            $ticket_link = esc_attr($ticket_url);
        }

        $ticket_html = $ticket_url
            ? '<a class="card-cta" href="' . $ticket_link . '" target="_blank" rel="noopener">Get Tickets <span class="arrow">&rarr;</span></a>'
            : '<span class="card-cta" style="opacity:0.5;cursor:default;">Coming Soon</span>';

        // Internal link: if this event matches a published comedian post,
        // render a secondary "More info" link so visitors can read our
        // content instead of bouncing straight to the ticket vendor. This
        // closes the SEO → audience loop that was previously broken.
        $more_info_html = '';
        $matched_post = $this->find_comedian_post_for_event($ev, $manifest_posts);
        if ($matched_post && !empty($matched_post['wpLink'])) {
            $more_info_html = '<a class="card-cta card-cta-secondary" href="'
                . esc_attr($matched_post['wpLink']) . '">More info</a>';
        }

        $card = '<article class="event-card">';
        $card .= '<div class="card-image">' . $image_html;
        if ($show_badges) {
            $card .= '<span class="card-source-badge ' . $source . '">' . esc_html($ev['source'] ?? '') . '</span>';
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
        $card .= '<div class="card-venue">' . $venue . '</div>';
        $card .= '<div class="card-footer"><div class="card-price">' . $price_html . '</div>'
            . $more_info_html . $ticket_html . '</div>';
        $card .= '</div></article>';

        return $card;
    }

    private function format_price_html($min, $max, $currency) {
        if ($min === null && $max === null) return '<span class="from">Price TBA</span>';
        if (($min === 0 || $min === 0.0) && ($max === 0 || $max === 0.0 || $max === null)) {
            return '<span style="color:var(--success);font-weight:600;">Free</span>';
        }

        $fmt = function ($v) use ($currency) {
            if ($currency === 'USD') return '$' . number_format($v, 0);
            return number_format($v, 0) . ' ' . $currency;
        };

        if ($min !== null && $max !== null && $min != $max) {
            return '<span class="from">From</span> ' . $fmt($min) . '&ndash;' . $fmt($max);
        }
        if ($min !== null) {
            return '<span class="from">From</span> ' . $fmt($min);
        }
        return '<span class="from">Up to</span> ' . $fmt($max);
    }

    private function format_date_label($date_str) {
        $today = wp_date('Y-m-d');
        $tomorrow = wp_date('Y-m-d', strtotime('+1 day'));

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

            // Offers. Google's Event Rich Results requires `offers.price` or
            // `offers.priceSpecification` when offers is present — an Offer
            // without a price is an ERROR (not a warning) and drops the event
            // from carousel eligibility. So we emit offers ONLY when we know
            // the price (price_min is set, including 0 for free events). If
            // we have a ticket URL but no price data, we omit offers entirely
            // rather than shipping a partial Offer that would break schema
            // validation for the whole Event.
            if (!empty($ev['ticket_url']) && isset($ev['price_min']) && $ev['price_min'] !== null) {
                $offer = [
                    '@type' => 'Offer',
                    'url' => $ev['ticket_url'],
                    'priceCurrency' => $ev['currency'] ?? 'USD',
                    'availability' => 'https://schema.org/InStock',
                    // validFrom = when tickets went on sale. We don't track the
                    // real on-sale date, so use last_updated as a floor.
                    'validFrom' => !empty($ev['last_updated'])
                        ? $ev['last_updated']
                        : gmdate('Y-m-d\TH:i:s\Z'),
                    // Google's Event guidelines want a `price` field — use
                    // price_min as the canonical price and also mirror it to
                    // lowPrice for range-offer consumers.
                    'price' => $ev['price_min'],
                    'lowPrice' => $ev['price_min'],
                ];
                if (isset($ev['price_max']) && $ev['price_max'] !== null) {
                    $offer['highPrice'] = $ev['price_max'];
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

        return '<script type="application/ld+json">' . wp_json_encode($schema, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . '</script>';
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
            'rudyards' => [
                'street' => '2010 Waugh Dr',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77006',
            ],
            'the riot comedy club upstairs at rudyards' => [
                'street' => '2010 Waugh Dr',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77006',
            ],
            'the riot comedy club' => [
                'street' => '2010 Waugh Dr',
                'locality' => 'Houston',
                'region' => 'TX',
                'postal' => '77006',
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
                    <tr><td><code>source</code></td><td>ticketmaster, eventbrite</td><td><em>all sources</em></td></tr>
                    <tr><td><code>title</code></td><td>custom hero title text</td><td>Every Comedy Show in Houston</td></tr>
                    <tr><td><code>theme</code></td><td>dark, light, auto</td><td><em>global setting</em></td></tr>
                    <tr><td><code>show_hero</code></td><td>true, false</td><td>true</td></tr>
                    <tr><td><code>show_controls</code></td><td>true, false</td><td>true</td></tr>
                    <tr><td><code>show_venue_filter</code></td><td>true, false — show/hide the venue dropdown</td><td>true</td></tr>
                    <tr><td><code>show_sort</code></td><td>true, false — show/hide the sort dropdown</td><td>true</td></tr>
                    <tr><td><code>show_open_mic</code></td><td>true, false — include/exclude events with &ldquo;open mic&rdquo; in the name</td><td>true</td></tr>
                    <tr><td><code>type</code></td><td>open_mic — show only events matching this type (filters by name keyword)</td><td><em>all types</em></td></tr>
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
