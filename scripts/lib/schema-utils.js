"use strict";

/**
 * Shared schema.org helpers for the blog generators.
 *
 * The BlogPosting node is attached to WordPress posts through the same
 * `ch_schema_graph` REST field the ComedyEvent graph already uses (the
 * Comedy Houston plugin stores it in post meta and emits it from wp_head),
 * so nothing here touches post_content or the OpenAI generation pipeline.
 */

const SITE_URL = "https://comedyhouston.com";

const ORGANIZATION_REF = {
  "@type": "Organization",
  name: "Comedy Houston",
  url: `${SITE_URL}/`,
};

/**
 * Build a schema.org BlogPosting node.
 * All fields optional except title; omitted fields are left out rather than
 * emitted empty (Google treats empty strings as errors, missing as warnings).
 */
function buildBlogPostingNode({ title, url, description, imageUrl, datePublished, dateModified }) {
  const node = {
    "@type": "BlogPosting",
    // Google recommends headlines <= 110 chars.
    headline: String(title || "").slice(0, 110),
    author: ORGANIZATION_REF,
    publisher: ORGANIZATION_REF,
    inLanguage: "en-US",
  };
  if (url) {
    node.url = url;
    node.mainEntityOfPage = { "@type": "WebPage", "@id": url };
  }
  if (description) node.description = String(description).slice(0, 300);
  if (imageUrl) node.image = imageUrl;
  if (datePublished) node.datePublished = datePublished;
  if (dateModified) node.dateModified = dateModified;
  return node;
}

/**
 * Return a copy of a `{ "@context", "@graph": [...] }` schema graph with the
 * given BlogPosting node added (replacing any existing BlogPosting node, so
 * in-place post updates stay idempotent). Accepts null/undefined graph and
 * builds a fresh one.
 */
function addBlogPostingToGraph(graph, postingFields) {
  const node = buildBlogPostingNode(postingFields);
  if (graph && Array.isArray(graph["@graph"])) {
    const rest = graph["@graph"].filter((n) => n && n["@type"] !== "BlogPosting");
    return { ...graph, "@graph": [...rest, node] };
  }
  return { "@context": "https://schema.org", "@graph": [node] };
}

/** Convert WP's `date_gmt`/`modified_gmt` ("2026-07-16T12:00:00") to ISO-8601 UTC. */
function wpGmtToIso(wpGmt) {
  if (!wpGmt) return null;
  const s = String(wpGmt);
  return /Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s + "Z";
}

module.exports = { buildBlogPostingNode, addBlogPostingToGraph, wpGmtToIso, SITE_URL };
