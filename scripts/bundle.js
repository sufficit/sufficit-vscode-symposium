#!/usr/bin/env node
/**
 * Bundle the VS Code extension using esbuild.
 * This creates a single bundled file instead of 114 separate JS files.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isDev = process.argv.includes('--dev');

async function build() {
  console.log('📦 Bundling VS Code extension...');

  const outDir = path.join(__dirname, '..', 'out');

  // Build TypeScript with tsc for type checking
  console.log('🔍 Type checking...');
  const { execSync } = require('child_process');
  execSync('npx tsc -p ./tsconfig.json', { stdio: 'inherit' });

  // Bundle with esbuild
  console.log('🔨 Bundling with esbuild...');
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(__dirname, '..', 'out', 'extension.js'),
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    treeShaking: false,  // Disable tree-shaking to keep scanKind and its dependencies
    logLevel: 'info',
  });

  if (result.errors.length > 0) {
    console.error('❌ Bundling failed:');
    result.errors.forEach(error => console.error(error));
    process.exit(1);
  }

  // Copy other necessary files (webview, etc.)
  console.log('📋 Copying additional files...');

  // Copy webview bundle
  const webviewSrc = path.join(__dirname, '..', 'out', 'ui', 'webview.bundle.js');
  const webviewDestDir = path.join(outDir, 'ui');
  if (fs.existsSync(webviewSrc)) {
    fs.mkdirSync(webviewDestDir, { recursive: true });
    fs.copyFileSync(webviewSrc, path.join(webviewDestDir, 'webview.bundle.js'));
  }

  // Copy webview CSS
  const webviewCssSrc = path.join(__dirname, '..', 'out', 'ui', 'webview.css');
  if (fs.existsSync(webviewCssSrc)) {
    fs.mkdirSync(webviewDestDir, { recursive: true });
    fs.copyFileSync(webviewCssSrc, path.join(webviewDestDir, 'webview.css'));
  }

  // Remove compiled TypeScript files (we only need the bundle)
  console.log('🧹 Cleaning up compiled files...');
  // NOTE: 'test' is intentionally NOT removed here — tests are compiled into
  // out/test/ by tsc and consumed by `node --test out/test/*.test.js` in the
  // `test` script. Removing them broke npm test (it reported 0 tests because
  // the files were deleted before node --test ran).
  const dirsToRemove = ['adapters', 'api', 'auth', 'chat', 'commands', 'compression', 'config', 'extension', 'sessions', 'sync'];
  dirsToRemove.forEach(dir => {
    const dirPath = path.join(outDir, dir);
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  // Remove top-level JS files and maps (except extension.js and its map)
  const filesToRemove = [
    'git.js', 'git.js.map',
    'ledger.js', 'ledger.js.map',
    'renderLog.js', 'renderLog.js.map',
    'sessionReader.js', 'sessionReader.js.map',
    'snapshots.js', 'snapshots.js.map'
  ];
  filesToRemove.forEach(file => {
    const filePath = path.join(outDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });

  // Remove UI compiled files (keep only webview.bundle.js and webview.css)
  const uiDir = path.join(outDir, 'ui');
  if (fs.existsSync(uiDir)) {
    const uiFiles = fs.readdirSync(uiDir);
    uiFiles.forEach(file => {
      if (file !== 'webview.bundle.js' && file !== 'webview.css') {
        const filePath = path.join(uiDir, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          fs.unlinkSync(filePath);
        }
      }
    });
  }

  console.log('✅ Bundle created successfully!');
  console.log(`📊 Bundle size: ${(fs.statSync(path.join(outDir, 'extension.js')).size / 1024).toFixed(2)} KB`);

  // Validate the bundle with node --check
  console.log('🔍 Validating bundle...');
  try {
    execSync(`node --check ${path.join(outDir, 'extension.js')}`, { stdio: 'inherit' });
    console.log('✅ Bundle validation passed!');
  } catch (error) {
    console.error('❌ Bundle validation failed:', error.message);
    process.exit(1);
  }
}

build().catch(error => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});