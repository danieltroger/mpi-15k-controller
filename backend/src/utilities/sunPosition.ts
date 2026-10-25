/**
 * Sun position from the NOAA solar calculator's formulation (Meeus' low-accuracy solar coordinates
 * + equation of time), good to a few hundredths of a degree for this century. The shorter
 * fractional-year series NOAA also publishes drifts ~0.4° around the equinoxes (its phase ignores
 * the leap-year cycle), too much for the daylight gates and the PV model that consume this.
 * Pure (no imports), so tooling and the frontend can use it too.
 */
export function sunPosition(atMs: number, latitudeDegrees: number, longitudeDegrees: number): SunPosition {
  const julianDay = atMs / 86_400_000 + 2440587.5;
  const julianCentury = (julianDay - 2451545) / 36525;

  const geometricMeanLongitude = modulo360(280.46646 + julianCentury * (36000.76983 + julianCentury * 0.0003032));
  const geometricMeanAnomaly = 357.52911 + julianCentury * (35999.05029 - 0.0001537 * julianCentury);
  const orbitEccentricity = 0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);
  const equationOfCenter =
    sinDegrees(geometricMeanAnomaly) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
    sinDegrees(2 * geometricMeanAnomaly) * (0.019993 - 0.000101 * julianCentury) +
    sinDegrees(3 * geometricMeanAnomaly) * 0.000289;
  const ascendingNodeLongitude = 125.04 - 1934.136 * julianCentury;
  const apparentLongitude =
    geometricMeanLongitude + equationOfCenter - 0.00569 - 0.00478 * sinDegrees(ascendingNodeLongitude);
  const meanObliquity =
    23 + (26 + (21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813))) / 60) / 60;
  const correctedObliquity = meanObliquity + 0.00256 * cosDegrees(ascendingNodeLongitude);
  const declinationRadians = Math.asin(sinDegrees(correctedObliquity) * sinDegrees(apparentLongitude));

  const obliquityTerm = Math.tan(degreesToRadians(correctedObliquity / 2)) ** 2;
  const equationOfTimeMinutes =
    4 *
    radiansToDegrees(
      obliquityTerm * sinDegrees(2 * geometricMeanLongitude) -
        2 * orbitEccentricity * sinDegrees(geometricMeanAnomaly) +
        4 *
          orbitEccentricity *
          obliquityTerm *
          sinDegrees(geometricMeanAnomaly) *
          cosDegrees(2 * geometricMeanLongitude) -
        0.5 * obliquityTerm ** 2 * sinDegrees(4 * geometricMeanLongitude) -
        1.25 * orbitEccentricity ** 2 * sinDegrees(2 * geometricMeanAnomaly)
    );

  const utcMinutesIntoDay = (((atMs % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
  const trueSolarTimeMinutes = utcMinutesIntoDay + equationOfTimeMinutes + 4 * longitudeDegrees;
  const hourAngleRadians = degreesToRadians(trueSolarTimeMinutes / 4 - 180);
  const latitudeRadians = degreesToRadians(latitudeDegrees);
  const cosineOfZenith =
    Math.sin(latitudeRadians) * Math.sin(declinationRadians) +
    Math.cos(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourAngleRadians);
  const geometricElevationDegrees = 90 - radiansToDegrees(Math.acos(Math.min(1, Math.max(-1, cosineOfZenith))));
  const azimuthDegrees = modulo360(
    radiansToDegrees(
      Math.atan2(
        Math.sin(hourAngleRadians),
        Math.cos(hourAngleRadians) * Math.sin(latitudeRadians) -
          Math.tan(declinationRadians) * Math.cos(latitudeRadians)
      )
    ) + 180
  );
  const dayOfYear = (((julianDay - 2451545) % 365.25) + 365.25) % 365.25;
  return {
    azimuthDegrees,
    geometricElevationDegrees,
    apparentElevationDegrees: geometricElevationDegrees + refractionDegrees(geometricElevationDegrees),
    extraterrestrialWattsPerSquareMetre: 1361 * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365.25)),
  };
}

export type SunPosition = {
  /** Compass bearing of the sun, clockwise from north */
  azimuthDegrees: number;
  /** Above the horizon in degrees, negative below; no atmospheric refraction */
  geometricElevationDegrees: number;
  /** With refraction, which lifts the sun by up to ~0.6° right at the horizon */
  apparentElevationDegrees: number;
  /** Normal-incidence irradiance at the top of the atmosphere (varies ±3.3 % with Earth's orbit) */
  extraterrestrialWattsPerSquareMetre: number;
};

/** Saemundsson's refraction formula, zero once the sun is well below the horizon. */
function refractionDegrees(geometricElevationDegrees: number): number {
  if (geometricElevationDegrees <= -0.575) return 0;
  const clampedElevation = Math.max(geometricElevationDegrees, -0.5);
  const refractionArcminutes = 1.02 / Math.tan(degreesToRadians(clampedElevation + 10.3 / (clampedElevation + 5.11)));
  return refractionArcminutes / 60;
}

function modulo360(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function sinDegrees(degrees: number): number {
  return Math.sin(degreesToRadians(degrees));
}

function cosDegrees(degrees: number): number {
  return Math.cos(degreesToRadians(degrees));
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
