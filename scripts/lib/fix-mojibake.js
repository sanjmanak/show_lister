/**
 * Repair double-encoded UTF-8 ("mojibake") in upstream event data.
 *
 * Ticketmaster's Discovery API sometimes returns names that were UTF-8
 * encoded, misread as Latin-1, and then run through their title-caser --
 * so "Iva\u0301n Fematt (En Espa\u00f1ol)" arrives as garbage like
 * "Iv\u00e3\u00a1N Fematt (En Espa\u00e3\u00b1Ol)". The title-casing step
 * breaks the byte sequences, so a plain latin1->utf8 roundtrip only fixes
 * intact strings; the rest need sequence-level repair.
 *
 * All non-ASCII characters in this file are written as \u escapes on
 * purpose -- the file itself must survive any editor/encoding mishap.
 */
"use strict";

// Case-mangled accent pairs: second byte of the mojibake pair -> repaired char.
const PAIRS = {
  "\u00a1": "\u00e1", // a-acute
  "\u00a9": "\u00e9", // e-acute
  "\u00ad": "\u00ed", // i-acute (soft-hyphen byte)
  "\u00b3": "\u00f3", // o-acute
  "\u00ba": "\u00fa", // u-acute
  "\u00b1": "\u00f1", // n-tilde
  "\u00bc": "\u00fc", // u-umlaut
  "\u00a8": "\u00e8", // e-grave
  "\u00a0": "\u00e0", // a-grave (nbsp byte)
};

const MARKERS = /[\u00c2\u00c3\u00e2\u00e3]/; // A-circ/A-tilde/a-circ/a-tilde

function fixMojibake(s) {
  if (!s || typeof s !== "string" || !MARKERS.test(s)) return s;

  const round = Buffer.from(s, "latin1").toString("utf8");
  if (!round.includes("\ufffd") && !MARKERS.test(round)) return round;

  // Curly punctuation: \u00e2 then tail bytes surviving as invisible C1
  // controls (latin-1 misread) or cp1252 glyphs (cp1252 misread).
  let out = s
    .replace(/\u00e2(?:\u0080|\u20ac)(?:\u0099|\u2122)/g, "\u2019") // right single quote
    .replace(/\u00e2(?:\u0080|\u20ac)(?:\u0098|\u02dc)/g, "\u2018") // left single quote
    .replace(/\u00e2(?:\u0080|\u20ac)(?:\u009c|\u0153)/g, "\u201c") // left double quote
    .replace(/\u00e2(?:\u0080|\u20ac)(?:\u0093|\u201c)/g, "\u2013") // en dash
    .replace(/\u00e2(?:\u0080|\u20ac)(?:\u0094|\u201d)/g, "\u2014") // em dash
    .replace(/\u00e2(?:\u0080|\u20ac)\u009d/g, "\u201d"); // right double quote

  out = out.replace(/[\u00e3\u00c3](.)/g, (m, c) =>
    Object.prototype.hasOwnProperty.call(PAIRS, c) ? PAIRS[c] : m
  );

  // The title-caser treated the mojibake as a word break, so the letter
  // after a repaired accent is wrongly uppercased mid-word.
  out = out.replace(
    /([\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc\u00e8\u00e0])([A-Z])(?![A-Z])/g,
    (m, x, y) => x + y.toLowerCase()
  );

  // A lone a-circumflex between two letters is a destroyed right quote
  // ("O?Farrill" -> "O'Farrill").
  out = out.replace(/([A-Za-z])\u00e2(?=[A-Za-z])/g, "$1\u2019");

  // Anything else is an unrecoverable remnant -- drop it, plus any
  // orphaned C1 control bytes.
  out = out.replace(/[\u00c2\u00e2]/g, "");
  out = out.replace(/[\u0080-\u009f]/g, "");
  // If only one side of a curly-double-quote pair survived, drop the orphan.
  if (out.includes("\u201d") && !out.includes("\u201c")) {
    out = out.replace(/\u201d/g, "");
  } else if (out.includes("\u201c") && !out.includes("\u201d")) {
    out = out.replace(/\u201c/g, "");
  }
  return out.replace(/  +/g, " ").trim();
}

module.exports = { fixMojibake };
