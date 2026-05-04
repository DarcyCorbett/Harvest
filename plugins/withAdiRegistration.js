const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Copies assets/adi-registration.properties into the native Android APK
 * assets folder during prebuild. Required for Google Play ADI verification.
 */
module.exports = function withAdiRegistration(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'assets/adi-registration.properties');
      const destDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/assets');
      const dest = path.join(destDir, 'adi-registration.properties');

      if (!fs.existsSync(src)) {
        throw new Error(`[withAdiRegistration] Source file missing: ${src}`);
      }
      fs.mkdirSync(destDir, { recursive: true });
      const token = fs.readFileSync(src, 'utf8').trim();
      fs.writeFileSync(dest, token, 'utf8');
      return cfg;
    },
  ]);
};
