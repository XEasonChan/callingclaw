// Strip iCloud resource forks from packaged app before codesign
// Without this, codesign fails with "resource fork, Finder information, or similar detritus not allowed"
const { execSync } = require('child_process');

exports.default = async function(context) {
  const appPath = context.appOutDir;
  console.log(`[afterPack] Stripping xattrs from ${appPath}`);
  try {
    execSync(`xattr -cr "${appPath}"`, { timeout: 30000 });
    console.log('[afterPack] xattrs stripped successfully');
  } catch (e) {
    console.warn('[afterPack] xattr -cr failed:', e.message);
  }
};
