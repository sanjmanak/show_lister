<?php
/**
 * Plugin Name: Comedy Houston Shows
 * Description: Displays Houston comedy event listings with configurable theme and affiliate click tracking.
 * Version: 2.3.0
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
            '2.3.0'
        );

        wp_register_script(
            'comedy-houston-app',
            plugin_dir_url(__FILE__) . 'comedy-houston.js',
            [],
            '2.3.0',
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
            $ch_ssr_html = $this->render_ssr_html($filtered, $opts, $redirect_base);
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
        $decoded = base64_decode($payload, true);

        if ($decoded === false || !filter_var($decoded, FILTER_VALIDATE_URL)) {
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
            if (empty($date) || $date < $today) continue;
            if (($ev['status'] ?? '') === 'cancelled') continue;
            if ($date > $max_date) continue;

            if ($filter === 'today' && $date !== $today) continue;
            if ($filter === 'tomorrow' && $date !== $tomorrow) continue;
            if ($filter === 'weekend' && $date !== $fri_date && $date !== $sat_date && $date !== $sun_date) continue;
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
    private function render_ssr_html($events, $opts, $redirect_base) {
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
                $html .= $this->render_card_html($ev, $show_badges, $track, $redirect_base);
            }

            $html .= '</div></section>';
        }

        return $html;
    }

    private function render_card_html($ev, $show_badges, $track, $redirect_base) {
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
        if ($ticket_url && $track && $redirect_base) {
            $ticket_link = esc_attr($redirect_base . base64_encode($ticket_url));
        } else {
            $ticket_link = esc_attr($ticket_url);
        }

        $ticket_html = $ticket_url
            ? '<a class="card-cta" href="' . $ticket_link . '" target="_blank" rel="noopener">Get Tickets <span class="arrow">&rarr;</span></a>'
            : '<span class="card-cta" style="opacity:0.5;cursor:default;">Coming Soon</span>';

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
        $card .= '<div class="card-footer"><div class="card-price">' . $price_html . '</div>' . $ticket_html . '</div>';
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
     */
    private function render_jsonld($events) {
        if (empty($events)) return '';

        $schema_events = array_slice($events, 0, 50);

        $items = [];
        $pos = 1;
        foreach ($schema_events as $ev) {
            $time_24h = $this->time_to_24h($ev['time'] ?? '');
            $start_date = ($ev['date'] ?? '') . 'T' . ($time_24h ?: '00:00') . ':00';

            $item = [
                '@type' => 'ListItem',
                'position' => $pos,
                'item' => [
                    '@type' => 'Event',
                    'name' => $ev['name'] ?? 'Comedy Show',
                    'startDate' => $start_date,
                    'eventAttendanceMode' => 'https://schema.org/OfflineEventAttendanceMode',
                    'eventStatus' => $this->map_status_schema($ev['status'] ?? 'on_sale'),
                    'location' => [
                        '@type' => 'Place',
                        'name' => $ev['venue'] ?? 'Houston Venue',
                        'address' => [
                            '@type' => 'PostalAddress',
                            'addressLocality' => 'Houston',
                            'addressRegion' => 'TX',
                            'addressCountry' => 'US',
                        ],
                    ],
                ],
            ];

            if (!empty($ev['image_url'])) {
                $item['item']['image'] = $ev['image_url'];
            }

            if (!empty($ev['description'])) {
                $item['item']['description'] = mb_substr($ev['description'], 0, 300);
            }

            if (!empty($ev['ticket_url'])) {
                $offer = [
                    '@type' => 'Offer',
                    'url' => $ev['ticket_url'],
                    'priceCurrency' => $ev['currency'] ?? 'USD',
                    'availability' => 'https://schema.org/InStock',
                ];
                if (isset($ev['price_min']) && $ev['price_min'] !== null) {
                    $offer['lowPrice'] = $ev['price_min'];
                }
                if (isset($ev['price_max']) && $ev['price_max'] !== null) {
                    $offer['highPrice'] = $ev['price_max'];
                }
                $item['item']['offers'] = $offer;
            }

            $items[] = $item;
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
