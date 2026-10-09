// Reading config.yaml, and changing single values in it from the control panel without
// losing the explanations (comments) in the file.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/** Settings the panel may change: name -> how to validate the value. */
const EDITABLE = {
  phone: (v) => String(v || '').trim(),
  max_post_age_days: (v) => positiveNumber(v, 'ימים אחורה'),
  run_every_minutes: (v) => nonNegativeNumber(v, 'דקות בין סבבים'),
  feed_scrolls: (v) => nonNegativeNumber(v, 'גלילות בפיד'),
  max_scrolls_per_group: (v) => positiveNumber(v, 'גלילות בקבוצה'),
};

function nonNegativeNumber(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`ערך לא תקין ל${label}: ${v}`);
  return n;
}
function positiveNumber(v, label) {
  const n = nonNegativeNumber(v, label);
  if (n === 0) throw new Error(`${label} חייב להיות גדול מ-0`);
  return n;
}

/** config.yaml with file paths resolved next to it. */
function loadConfig(file) {
  const cfg = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const base = path.dirname(path.resolve(file));
  cfg.browser_profile_dir = path.resolve(base, cfg.browser_profile_dir || './browser_profile');
  cfg.history_file = path.resolve(base, cfg.history_file || './history.json');
  cfg.groups_file = path.resolve(base, cfg.groups_file || './groups.txt');
  cfg.groups_last_seen_file = path.resolve(base, cfg.groups_last_seen_file || './groups_last_seen.json');
  return cfg;
}

/** The panel's view of the settings. */
function editableValues(cfg) {
  return {
    phone: (cfg.whatsapp && cfg.whatsapp.phone) || '',
    max_post_age_days: cfg.max_post_age_days ?? 3,
    run_every_minutes: cfg.run_every_minutes ?? 60,
    feed_scrolls: cfg.feed_scrolls ?? 40,
    max_scrolls_per_group: cfg.max_scrolls_per_group ?? 100,
  };
}

/**
 * Writes the given settings into config.yaml by replacing just their lines, so comments
 * and everything else in the file stay as they are. Returns the validated values.
 */
function updateConfigValues(file, values) {
  let text = fs.readFileSync(file, 'utf8');
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    if (!EDITABLE[key]) throw new Error(`הגדרה לא מוכרת: ${key}`);
    clean[key] = EDITABLE[key](value);
  }
  for (const [key, value] of Object.entries(clean)) {
    const yamlValue = key === 'phone' ? JSON.stringify(value) : String(value);
    if (key === 'phone') {
      if (/^whatsapp:\s*$/m.test(text) && /^\s+phone:.*$/m.test(text)) {
        text = text.replace(/^(\s+phone:).*$/m, `$1 ${yamlValue}`);
      } else {
        text = text.replace(/\s*$/, `\n\nwhatsapp:\n  phone: ${yamlValue}\n`);
      }
    } else if (new RegExp(`^${key}:.*$`, 'm').test(text)) {
      text = text.replace(new RegExp(`^(${key}:).*$`, 'm'), `$1 ${yamlValue}`);
    } else {
      text = text.replace(/\s*$/, `\n\n${key}: ${yamlValue}\n`);
    }
  }
  yaml.load(text); // never write a file that can't be read back
  fs.writeFileSync(file, text, 'utf8');
  return clean;
}

module.exports = { loadConfig, editableValues, updateConfigValues, EDITABLE };
