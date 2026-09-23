#!/usr/bin/env node
/**
 * Validate the plugin against the contracts the host actually applies.
 *
 * Two contracts are in play and this repository ships both:
 *
 * 1. Portable sources: plugin.portable.json and mcp.json are validated against
 *    the vendored official schemas and remain authoritative.
 * 2. Codex compatibility: root plugin.json and .codex-plugin/plugin.json are
 *    generated in the legacy shape so current Codex builds discover hooks.
 *    .mcp.json is generated for builds using the legacy MCP manifest.
 *
 * It also checks that the legacy mirrors are generated from the portable
 * source, that every version carrier agrees, and that package.json lists the
 * files the plugin needs at runtime.
 *
 *   node scripts/validate-plugin.mjs [plugin-root]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mirrorFiles } from './sync-manifest.mjs';

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
const HOOK_TYPES = new Set(['command', 'mcp_tool']);
const SCHEMA_DIR = join('schemas', 'agent-plugins', '1.0.0');
// The schema is the validator's reference document, so it always comes from
// this repository rather than from the plugin root being validated.
const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isHttps = (value) => typeof value === 'string' && /^https:\/\//.test(value);
const typeOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

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

/** Resolve a local `#/$defs/name` pointer. The vendored schemas use nothing else. */
function resolveRef(schema, document) {
  if (!schema || typeof schema.$ref !== 'string') return schema;
  let node = document;
  for (const part of schema.$ref.replace(/^#\//, '').split('/')) node = node?.[part];
  return node ?? {};
}

/**
 * A JSON Schema validator for the subset the two official schemas use:
 * type, const, enum, pattern, minLength, maxLength, properties, required,
 * additionalProperties, items, propertyNames, not, oneOf and local $ref.
 */
function validateSchema(value, rawSchema, path, errors, document) {
  const schema = resolveRef(rawSchema, document);
  if (!isObject(schema)) return;
  if (schema.const !== undefined && !same(value, schema.const)) {
    errors.push(path + ' must be ' + JSON.stringify(schema.const));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => same(item, value))) {
    errors.push(path + ' must be one of ' + schema.enum.map((item) => JSON.stringify(item)).join(', '));
  }
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(typeOf(value))) {
      errors.push(path + ' must be ' + allowed.join(' or ') + ', found ' + typeOf(value));
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(path + ' is shorter than ' + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(path + ' is longer than ' + schema.maxLength);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(path + ' does not match ' + schema.pattern);
  }
  if (isObject(schema.not) && Array.isArray(schema.not.enum) && schema.not.enum.some((item) => same(item, value))) {
    errors.push(path + ' must not be ' + JSON.stringify(value));
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((branch) => {
      const local = [];
      validateSchema(value, branch, path, local, document);
      return local;
    });
    const matches = results.filter((local) => local.length === 0);
    if (matches.length !== 1) {
      errors.push(path + ' must match exactly one of the allowed shapes, matched ' + matches.length);
      // Report the closest branch too: otherwise a one-field mistake inside a
      // transport shape reads as a vague oneOf failure.
      const closest = results.filter((local) => local.length > 0).sort((left, right) => left.length - right.length)[0];
      if (closest) errors.push(...closest);
    }
  }
  if (typeOf(value) === 'object') {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) errors.push(path + ' is missing required field `' + key + '`');
    }
    if (isObject(schema.propertyNames?.not) && Array.isArray(schema.propertyNames.not.enum)) {
      for (const key of Object.keys(value)) {
        if (schema.propertyNames.not.enum.includes(key)) errors.push(path + '.' + key + ' is a reserved name');
      }
    }
    const extra = Object.keys(value).filter((key) => !(key in properties));
    if (schema.additionalProperties === false) {
      for (const key of extra) errors.push(path + ' field `' + key + '` is not accepted by the schema');
    } else if (isObject(schema.additionalProperties)) {
      for (const key of extra) validateSchema(value[key], schema.additionalProperties, path + '.' + key, errors, document);
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) validateSchema(value[key], sub, path + '.' + key, errors, document);
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items, path + '[' + index + ']', errors, document));
  }
}

function validateAgainstSchema(root, relative, schemaName, errors) {
  const document = loadJson(join(scriptRoot, SCHEMA_DIR, schemaName));
  if (!isObject(document)) {
    errors.push(SCHEMA_DIR + '/' + schemaName + ' is missing');
    return;
  }
  const value = loadJson(join(root, relative));
  if (value === null) {
    errors.push(relative + ' is missing or not valid JSON');
    return;
  }
  validateSchema(value, document, relative, errors, document);
}

function rejectUnknown(object, allowed, label, errors) {
  for (const key of Object.keys(object).sort()) {
    if (!allowed.has(key)) errors.push(label + ' field `' + key + '` is not accepted by plugin validation');
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

function validateInterface(manifest, label, errors) {
  const ui = manifest.interface;
  if (!isObject(ui)) {
    errors.push(label + ' field `interface` must be an object');
    return;
  }
  rejectUnknown(ui, INTERFACE_KEYS, label + ' field `interface`', errors);
  for (const key of REQUIRED_INTERFACE_KEYS) {
    if (!nonEmptyString(ui[key])) errors.push(label + ' field `interface.' + key + '` must be a non-empty string');
  }
  if (ui.defaultPrompt === undefined && ui.default_prompt === undefined) {
    errors.push(label + ' field `interface.defaultPrompt` or `interface.default_prompt` is required');
  }
  if (!Array.isArray(ui.capabilities) || !ui.capabilities.every((value) => nonEmptyString(value))) {
    errors.push(label + ' field `interface.capabilities` must be an array of strings');
  }
  for (const key of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    if (ui[key] !== undefined && !isHttps(ui[key])) errors.push(label + ' field `interface.' + key + '` must be an https:// URL');
  }
  if (ui.brandColor !== undefined && !(typeof ui.brandColor === 'string' && HEX_COLOR.test(ui.brandColor))) {
    errors.push(label + ' field `interface.brandColor` must use #RRGGBB');
  }
  for (const key of ['composerIcon', 'logo', 'logoDark']) {
    if (ui[key] !== undefined) checkArchivePath(root, ui[key], label + ' field `interface.' + key + '`', errors);
  }
  const screenshots = ui.screenshots ?? [];
  if (!Array.isArray(screenshots)) {
    errors.push(label + ' field `interface.screenshots` must be an array');
  } else {
    screenshots.forEach((shot, index) => checkArchivePath(root, shot, label + ' field `interface.screenshots[' + index + ']`', errors, { png: true }));
  }
}

function validatePortable(root, errors) {
  validateAgainstSchema(root, 'plugin.portable.json', 'plugin.schema.json', errors);
  validateAgainstSchema(root, 'mcp.json', 'mcp.schema.json', errors);
  const manifest = loadJson(join(root, 'plugin.portable.json'));
  if (!isObject(manifest)) return;
  const openai = manifest.extensions?.['com.openai'];
  if (!isObject(openai)) {
    errors.push('plugin.portable.json field `extensions.com.openai` is required for the Codex overlay');
    return;
  }
  if (openai.hooks !== undefined) {
    if (!nonEmptyString(openai.hooks)) errors.push('plugin.portable.json field `extensions.com.openai.hooks` must be a non-empty path');
    else checkArchivePath(root, openai.hooks, 'plugin.portable.json field `extensions.com.openai.hooks`', errors);
  }
  if (isObject(openai.interface)) validateInterface({ interface: openai.interface }, 'plugin.portable.json', errors);
}

function validateLegacy(root, errors) {
  const label = '.codex-plugin/plugin.json';
  const manifest = loadJson(join(root, '.codex-plugin', 'plugin.json'));
  if (!isObject(manifest)) {
    errors.push(label + ' is missing or not valid JSON');
    return;
  }
  if (JSON.stringify(manifest).includes('[TODO:')) errors.push(label + ' contains a [TODO: ...] placeholder');
  rejectUnknown(manifest, TOP_LEVEL_KEYS, label, errors);
  if (!nonEmptyString(manifest.name)) errors.push(label + ' field `name` must be a non-empty string');
  else if (!IDENTIFIER.test(manifest.name)) errors.push(label + ' field `name` is invalid');
  if (!nonEmptyString(manifest.version)) errors.push(label + ' field `version` must be a non-empty string');
  else if (!SEMVER.test(manifest.version)) errors.push(label + ' field `version` must be strict semver');
  if (!nonEmptyString(manifest.description)) errors.push(label + ' field `description` must be a non-empty string');
  if (!isObject(manifest.author)) errors.push(label + ' field `author` must be an object');
  else {
    rejectUnknown(manifest.author, AUTHOR_KEYS, label + ' field `author`', errors);
    if (!nonEmptyString(manifest.author.name)) errors.push(label + ' field `author.name` must be a non-empty string');
    if (manifest.author.email !== undefined && !nonEmptyString(manifest.author.email)) errors.push(label + ' field `author.email` must be a non-empty string');
    if (manifest.author.url !== undefined && !isHttps(manifest.author.url)) errors.push(label + ' field `author.url` must be an https:// URL');
  }
  if (manifest.mcpServers !== undefined && manifest.mcpServers !== './.mcp.json') {
    errors.push(label + ' field `mcpServers` must point to `./.mcp.json`');
  }
  const companion = loadJson(join(root, '.mcp.json'));
  if (!isObject(companion) || !isObject(companion.mcpServers)) {
    errors.push('.mcp.json is required and must carry an `mcpServers` object');
  } else {
    rejectUnknown(companion, new Set(['mcpServers']), '.mcp.json', errors);
  }
  validateInterface(manifest, label, errors);
  if (manifest.skills !== undefined) checkArchivePath(root, manifest.skills, label + ' field `skills`', errors);
}

function validateMirrors(root, errors) {
  for (const [file, content] of mirrorFiles(root)) {
    const current = (() => {
      try {
        return readFileSync(join(root, file), 'utf8');
      } catch {
        return null;
      }
    })();
    if (current !== content) errors.push(file + ' is not generated from the portable source (run npm run sync:manifest)');
  }
}

function validateVersions(root, errors) {
  const pkg = loadJson(join(root, 'package.json'));
  const portable = loadJson(join(root, 'plugin.portable.json'));
  const codex = loadJson(join(root, 'plugin.json'));
  const legacy = loadJson(join(root, '.codex-plugin', 'plugin.json'));
  if (!isObject(pkg)) {
    errors.push('package.json must exist and be valid JSON');
    return;
  }
  const versions = [pkg.version, portable?.version, codex?.version, legacy?.version];
  if (!versions.every((value) => value === versions[0])) {
    errors.push('package.json, plugin.portable.json, plugin.json and .codex-plugin/plugin.json versions must agree, found ' + versions.join(', '));
  }
}

function validateHooks(root, errors) {
  for (const relative of ['hooks/hooks.json', 'hooks/hooks.command.json', 'hooks/hooks.mcp.json']) {
    const file = loadJson(join(root, relative));
    if (!isObject(file) || !isObject(file.hooks)) {
      errors.push(relative + ' must exist and carry a hooks object');
      continue;
    }
    for (const [event, entries] of Object.entries(file.hooks)) {
      if (!Array.isArray(entries) || entries.length === 0) {
        errors.push(relative + ' event `' + event + '` must be a non-empty array');
        continue;
      }
      for (const entry of entries) {
        if (!isObject(entry) || !Array.isArray(entry.hooks)) {
          errors.push(relative + ' event `' + event + '` needs a hooks array');
          continue;
        }
        for (const hook of entry.hooks) {
          if (!isObject(hook) || !HOOK_TYPES.has(hook.type)) {
            errors.push(relative + ' event `' + event + '` has a hook without a supported type');
            continue;
          }
          if (hook.type === 'command' && !nonEmptyString(hook.command)) {
            errors.push(relative + ' `' + event + '` command hook needs a command');
          }
          if (hook.type === 'mcp_tool' && (!nonEmptyString(hook.server) || !nonEmptyString(hook.tool))) {
            errors.push(relative + ' `' + event + '` mcp_tool hook needs a server and a tool');
          }
          if (hook.timeout !== undefined && !(typeof hook.timeout === 'number' && hook.timeout > 0)) {
            errors.push(relative + ' `' + event + '` timeout must be a positive number');
          }
        }
      }
    }
  }
  const mcpManifest = loadJson(join(root, 'mcp.json'));
  const hooks = loadJson(join(root, 'hooks', 'hooks.mcp.json'));
  const referenced = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    if (value.type === 'mcp_tool' && nonEmptyString(value.server)) referenced.add(value.server);
    for (const item of Object.values(value)) walk(item);
  };
  walk(hooks);
  for (const name of referenced) {
    if (!(name in (mcpManifest?.mcpServers ?? {}))) {
      errors.push('hooks/hooks.json calls MCP server `' + name + '` which mcp.json does not define');
    }
  }
}

function validateEvalCorpus(root, errors) {
  const corpus = loadJson(join(root, 'evals', 'cases.json'));
  if (!isObject(corpus) || !Array.isArray(corpus.cases)) {
    errors.push('evals/cases.json must exist and carry a cases array');
  } else {
    const ids = new Set();
    for (const [index, item] of corpus.cases.entries()) {
      const label = 'evals/cases.json case ' + index;
      if (!isObject(item)) {
        errors.push(label + ' must be an object');
        continue;
      }
      for (const key of ['id', 'category', 'goal', 'tool', 'input', 'fixture', 'expectedAction', 'reason']) {
        if (!nonEmptyString(item[key])) errors.push(label + ' needs a string `' + key + '`');
      }
      if (item.expectedAction !== 'keep' && item.expectedAction !== 'drop') {
        errors.push(label + ' expectedAction must be keep or drop');
      }
      if (typeof item.id === 'string') {
        if (ids.has(item.id)) errors.push(label + ' repeats id ' + item.id);
        ids.add(item.id);
      }
      if (nonEmptyString(item.fixture) && !existsSync(join(root, 'evals', 'fixtures', item.fixture))) {
        errors.push(label + ' fixture ' + item.fixture + ' is missing');
      }
    }
  }
  const prompts = loadJson(join(root, 'examples', 'eval-prompts.json'));
  if (!isObject(prompts) || !Array.isArray(prompts.prompts)) {
    errors.push('examples/eval-prompts.json must exist and carry a prompts array');
  } else {
    for (const [index, item] of prompts.prompts.entries()) {
      if (!isObject(item) || !nonEmptyString(item.prompt) || !['flag', 'quiet'].includes(item.expect)) {
        errors.push('examples/eval-prompts.json prompt ' + index + ' needs a prompt and expect flag|quiet');
      }
    }
  }
}

function validatePackageFiles(root, errors) {
  const pkg = loadJson(join(root, 'package.json'));
  if (!isObject(pkg) || !Array.isArray(pkg.files)) {
    errors.push('package.json needs a files array');
    return;
  }
  for (const entry of pkg.files) {
    if (!nonEmptyString(entry)) {
      errors.push('package.json files entries must be non-empty strings');
      continue;
    }
    if (!existsSync(join(root, entry))) errors.push('package.json files entry `' + entry + '` does not exist');
  }
  const required = [
    'plugin.portable.json', 'plugin.json', 'mcp.json', '.codex-plugin/plugin.json', '.mcp.json',
    'hooks/hooks.json', 'hooks/hooks.command.json', 'hooks/hooks.mcp.json', 'dist/cli.js', 'dist/mcp-server.js',
  ];
  for (const relative of required) {
    if (!existsSync(join(root, relative))) errors.push('required file ' + relative + ' is missing');
  }
  for (const relative of ['dist', 'hooks', 'skills', 'schemas', 'evals', 'assets']) {
    if (!pkg.files.includes(relative)) errors.push('package.json files must include `' + relative + '`');
  }
}

export function validatePlugin(root) {
  const errors = [];
  validatePortable(root, errors);
  validateLegacy(root, errors);
  validateMirrors(root, errors);
  validateVersions(root, errors);
  validateHooks(root, errors);
  validateEvalCorpus(root, errors);
  validatePackageFiles(root, errors);
  return errors;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const errors = validatePlugin(root);
  if (errors.length > 0) {
    console.error('plugin validation failed:');
    for (const error of errors) console.error('- ' + error);
    process.exit(1);
  }
  console.log('plugin validation passed: ' + root);
}
