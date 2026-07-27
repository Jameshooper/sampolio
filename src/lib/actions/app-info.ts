'use server';

import packageJson from '../../../package.json';

/**
 * Get application version from package.json
 */
export async function getAppVersion() {
    return {
        success: true,
        version: packageJson.version,
        name: packageJson.name,
    };
}
