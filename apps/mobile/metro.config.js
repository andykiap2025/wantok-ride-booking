/**
 * Metro, configured for the workspace.
 *
 * `@wantok/core` lives at ../../packages/core and is symlinked into the root
 * node_modules by npm workspaces. Metro does not follow that by default, so
 * three things have to be spelled out: watch the workspace root, look for
 * modules in both node_modules folders, and turn off the hierarchical lookup
 * that would otherwise resolve a hoisted copy of React from the wrong place.
 *
 * Without this the app bundles but `@wantok/core` resolves to nothing, and the
 * failure looks like a blank screen rather than an error.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.disableHierarchicalLookup = true;

module.exports = config;
