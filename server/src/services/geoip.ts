import { existsSync } from 'node:fs';
import { type CountryResponse, type Reader, open } from 'maxmind';

import { logger } from '../utils/logger.js';

/**
 * Which country an address is in, resolved on this server and nowhere else.
 *
 * This exists so the app can say where *you* are while the tunnel is down.
 * The obvious way to get that is an IP-geolocation API, and it is the wrong
 * way: with the tunnel down the address being looked up is the user's real
 * one, so asking a third party hands them exactly the fact the whole system is
 * built to withhold — and does it at the moment the user is least protected.
 *
 * A local database gives the same answer to nobody but us. The lookup is
 * in-memory, the result is never stored, and the file ships in the image.
 *
 * Country only. City-level data is a larger file and a more intrusive answer
 * than the question needs: "you are in Türkiye, unprotected" is the whole
 * point being made.
 */
export interface GeoLookup {
  /** Country name, or null when it cannot be resolved. */
  countryOf(ip: string): string | null;
}

/** A lookup that knows nothing, for when the database is absent. */
export const noGeoLookup: GeoLookup = { countryOf: () => null };

/**
 * Loads the database, or returns [noGeoLookup] if it is not there.
 *
 * Missing is a normal state, not a failure: a build without the file still
 * runs, and the region line falls back to showing nothing rather than the
 * service refusing to start over a cosmetic feature.
 */
export async function openGeoLookup(path: string): Promise<GeoLookup> {
  if (!path || !existsSync(path)) {
    logger.info('geoip database not present; location will not be shown', { path });
    return noGeoLookup;
  }

  let reader: Reader<CountryResponse>;
  try {
    reader = await open<CountryResponse>(path);
  } catch (error) {
    logger.warn('geoip database could not be read', {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return noGeoLookup;
  }

  logger.info('geoip database loaded', { path });

  return {
    countryOf(ip: string): string | null {
      try {
        // Throws on anything that is not an address — a private range, an
        // empty string, a hostname. All of those mean "no answer", which is a
        // value this returns rather than an error it raises.
        const found = reader.get(ip);
        const country = found?.country ?? found?.registered_country;
        return country?.names?.['en'] ?? null;
      } catch {
        return null;
      }
    },
  };
}
