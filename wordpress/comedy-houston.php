<?php
/**
 * Plugin Name: Comedy Houston Shows
 * Description: Displays Houston comedy event listings from Ticketmaster & Eventbrite.
 * Version: 1.0.0
 * Author: Comedy Houston
 *
 * INSTALLATION:
 *   1. Upload this entire "comedy-houston" folder to /wp-content/plugins/
 *      (so the path is /wp-content/plugins/comedy-houston/comedy-houston.php)
 *   2. Activate the plugin in WordPress Admin → Plugins
 *   3. On any page, add the shortcode: [comedy_houston]
 *   4. That's it — the event listings will render wherever the shortcode is placed.
 *
 * The plugin fetches event data from your GitHub repo's events.json at runtime.
 * No API keys are needed on the WordPress side.
 */

if (!defined('ABSPATH')) {
    exit; // Prevent direct access
}

class Comedy_Houston_Plugin {

    const SHORTCODE = 'comedy_houston';

    public function __construct() {
        add_shortcode(self::SHORTCODE, [$this, 'render_shortcode']);
        add_action('wp_enqueue_scripts', [$this, 'register_assets']);
    }

    /**
     * Register CSS and JS — they only load on pages that use the shortcode.
     */
    public function register_assets() {
        wp_register_style(
            'comedy-houston-style',
            plugin_dir_url(__FILE__) . 'comedy-houston.css',
            [],
            '1.0.0'
        );

        wp_register_script(
            'comedy-houston-app',
            plugin_dir_url(__FILE__) . 'comedy-houston.js',
            [],
            '1.0.0',
            true // Load in footer
        );
    }

    /**
     * Shortcode handler — outputs the HTML skeleton and enqueues assets.
     */
    public function render_shortcode($atts) {
        // Parse optional attributes
        $atts = shortcode_atts([
            'github_user' => 'sanjmanak',
            'repo'        => 'show_lister',
        ], $atts, self::SHORTCODE);

        // Enqueue assets only when the shortcode is actually used
        wp_enqueue_style('comedy-houston-style');
        wp_enqueue_script('comedy-houston-app');

        // Pass config to JS
        wp_localize_script('comedy-houston-app', 'ComedyHoustonConfig', [
            'jsonUrl' => sprintf(
                'https://raw.githubusercontent.com/%s/%s/main/events.json',
                esc_attr($atts['github_user']),
                esc_attr($atts['repo'])
            ),
        ]);

        // Buffer the HTML output
        ob_start();
        include plugin_dir_path(__FILE__) . 'comedy-houston-template.php';
        return ob_get_clean();
    }
}

new Comedy_Houston_Plugin();
