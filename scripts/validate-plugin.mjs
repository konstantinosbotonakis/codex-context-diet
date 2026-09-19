#!/usr/bin/env node
/**
 * Validate the plugin manifest the way Codex ingestion does.
 *
 * The rules mirror the workspace plugin schema enforced by the installed
 * `plugin-creator/scripts/validate_plugin.py`, which is the same contract the
 * ingestion path applies to `.codex-plugin/plugin.json`. CI runs this so a
 * manifest that would be rejected at install time never reaches main.
 *
 *   node scripts/validate-plugin.mjs [plugin-root]
 *
 * This repo also keeps the legacy root `plugin.json` for older Codex builds,
 * so the validator requires the two files to stay identical.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;
const IDENTIFIER = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const TOP_LEVEL_KEYS = new Set([
  'id', 'name', 'version', 'description', 'skills', 'apps', 'mcpServers',
  'interface', 'author', 'homepage', 'repository', 'license', 'keywords',
]);
const AUTHOR_KEYS = new Set(['name', 'email', 'url']);
const INTERFACE_KEYS = new Set([
  'displayName', 'shortDescription', 'longDescription', 'developerName', 'category',
  'capabilities', 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'brandColor',
  'composerIcon', 'logo', 'logoDark', 'screenshots', 'defaultPrompt', 'default_prompt',
]);
const REQUIRED_INTERFACE_KEYS = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isHttps = (value) => typeof value === 'string' && /^https:\/\//.test(value);

/** Key order is irrelevant for equality, so compare a sorted deep copy. */
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function checkArchivePath(root, rawPath, field, errors, { png = false } = {}) {
  if (!nonEmptyString(rawPath)) {
    errors.push(field + ' must be a non-empty relative path');
    return;
  }
  const parts = rawPath.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (rawPath.startsWith('/') || parts.length === 0 || parts.includes('..')) {
    errors.push(field + ' must stay inside the plugin archive');
    return;
  }
  if (png && !rawPath.toLowerCase().endsWith('.png')) errors.push(field + ' must be a PNG file');
  if (!existsSync(join(root, ...parts))) errors.push(field + ' points to a missing file');
}

function rejectUnknown(object, allowed, label, errors) {
  for (const key of Object.keys(object).sort()) {
    if (!allowed.has(key)) errors.push(label + ' field `' + key + '` is not accepted by plugin validation');
  }
}

function validateInterface(root, manifest, errors) {
  const ui = manifest.interface;
  if (!isObject(ui)) {
    errors.push('plugin.json field `interface` must be an object');
    return;
  }
  rejectUnknown(ui, INTERFACE_KEYS, 'plugin.json field `interface`', errors);
  for (const key of REQUIRED_INTERFACE_KEYS) {
    if (!nonEmptyString(ui[key])) errors.push('plugin.json field `interface.' + key + '` must be a non-empty string');
  }
  if (ui.defaultPrompt === undefined && ui.default_prompt === undefined) {
    errors.push('plugin.json field `interface.defaultPrompt` or `interface.default_prompt` is required');
  }
  if (!Array.isArray(ui.capabilities) || !ui.capabilities.every((value) => nonEmptyString(value))) {
    errors.push('plugin.json field `interface.capabilities` must be an array of strings');
  }
  for (const key of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    if (ui[key] !== undefined && !isHttps(ui[key])) errors.push('plugin.json field `interface.' + key + '` must be an https:// URL');
  }
  if (ui.brandColor !== undefined && !(typeof ui.brandColor === 'string' && HEX_COLOR.test(ui.brandColor))) {
    errors.push('plugin.json field `interface.brandColor` must use #RRGGBB');
  }
  for (const key of ['composerIcon', 'logo', 'logoDark']) {
    if (ui[key] !== undefined) checkArchivePath(root, ui[key], 'plugin.json field `interface.' + key + '`', errors);
  }
  const screenshots = ui.screenshots ?? [];
  if (!Array.isArray(screenshots)) {
    errors.push('plugin.json field `interface.screenshots` must be an array');
  } else {
    screenshots.forEach((shot, index) => checkArchivePath(root, shot, 'plugin.json field `interface.screenshots[' + index + ']`', errors, { png: true }));
  }
}

function validateCompanion(root, manifest, errors) {
  if (manifest.skills !== undefined) checkArchivePath(root, manifest.skills, 'plugin.json field `skills`', errors);
  if (manifest.apps !== undefined) {
    const app = loadJson(join(root, '.app.json'));
    if (!isObject(app)) errors.push('`.app.json` is required and must be valid JSON when `apps` is present');
    else if (!isObject(app.apps)) errors.push('`.app.json` must carry an `apps` object');
  }
  const servers = manifest.mcpServers;
  if (servers === undefined) return;
  if (typeof servers === 'string') {
    if (servers !== './.mcp.json') errors.push('plugin.json field `mcpServers` must point to `./.mcp.json`');
    const companion = loadJson(join(root, '.mcp.json'));
    if (!isObject(companion)) errors.push('`.mcp.json` is required and must be valid JSON when `mcpServers` is present');
    else if (!isObject(companion.mcpServers)) errors.push('`.mcp.json` must carry an `mcpServers` object');
    return;
  }
  if (!isObject(servers)) {
    errors.push('plugin.json field `mcpServers` must be a string path or object');
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    if (!isObject(server)) errors.push('plugin.json field `mcpServers.' + name + '` must be an object');
  }
}

export function validatePlugin(root) {
  const errors = [];
  const manifest = loadJson(join(root, '.codex-plugin', 'plugin.json'));
  if (!isObject(manifest)) {
    errors.push('.codex-plugin/plugin.json is missing or not valid JSON');
    return errors;
  }
  if (JSON.stringify(manifest).includes('[TODO:')) errors.push('manifest contains a [TODO: ...] placeholder');
  rejectUnknown(manifest, TOP_LEVEL_KEYS, 'plugin.json', errors);
  if (!nonEmptyString(manifest.name)) errors.push('plugin.json field `name` must be a non-empty string');
  else if (!IDENTIFIER.test(manifest.name)) errors.push('plugin.json field `name` is invalid');
  if (!nonEmptyString(manifest.version)) errors.push('plugin.json field `version` must be a non-empty string');
  else if (!SEMVER.test(manifest.version)) errors.push('plugin.json field `version` must be strict semver');
  if (!nonEmptyString(manifest.description)) errors.push('plugin.json field `description` must be a non-empty string');
  if (!isObject(manifest.author)) errors.push('plugin.json field `author` must be an object');
  else {
    rejectUnknown(manifest.author, AUTHOR_KEYS, 'plugin.json field `author`', errors);
    if (!nonEmptyString(manifest.author.name)) errors.push('plugin.json field `author.name` must be a non-empty string');
    if (manifest.author.email !== undefined && !nonEmptyString(manifest.author.email)) errors.push('plugin.json field `author.email` must be a non-empty string');
    if (manifest.author.url !== undefined && !isHttps(manifest.author.url)) errors.push('plugin.json field `author.url` must be an https:// URL');
  }
  validateCompanion(root, manifest, errors);
  validateInterface(root, manifest, errors);

  const legacy = loadJson(join(root, 'plugin.json'));
  if (!isObject(legacy)) errors.push('plugin.json at the plugin root must exist and be valid JSON');
  else if (JSON.stringify(canonical(legacy)) !== JSON.stringify(canonical(manifest))) {
    errors.push('plugin.json and .codex-plugin/plugin.json must stay identical');
  }
  return errors;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const errors = validatePlugin(root);
  if (errors.length > 0) {
    console.error('plugin manifest validation failed:');
    for (const error of errors) console.error('- ' + error);
    process.exit(1);
  }
  console.log('plugin manifest validation passed: ' + root);
}

