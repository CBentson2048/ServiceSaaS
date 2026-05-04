// Expo + pnpm monorepo Metro config.
// - watchFolders: let Metro watch changes across the whole workspace
//   (so edits to workspace packages hot-reload).
// - nodeModulesPaths: resolve deps from the app first, then workspace root
//   (pnpm with node-linker=hoisted puts most deps at the workspace root).
// - disableHierarchicalLookup: avoid accidentally resolving two copies of
//   React/React Native from different node_modules layers.
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
