<?php
/**
 * Plugin Name: Comedy Houston Shows
 * Description: Displays Houston comedy event listings with configurable theme and affiliate click tracking.
 * Version: 2.2.0
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
            '2.2.0'
        );

        wp_register_script(
            'comedy-houston-app',
            plugin_dir_url(__FILE__) . 'comedy-houston.js',
            [],
            '2.2.0',
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
        </div>
        <?php
    }
}

new Comedy_Houston_Plugin();
