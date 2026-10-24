/**
 * Geometric sun elevation above the horizon in degrees (negative = below), using the NOAA solar
 * calculator's formulation (Meeus' low-accuracy solar coordinates + equation of time). Good to
 * a few hundredths of a degree for this century. The shorter fractional-year series NOAA also
 * publishes was tried first and drifts ~0.4° around the equinoxes (its phase ignores the
 * leap-year cycle), too close to the daylight gates that consume this.
 * No atmospheric refraction: it lifts the apparent sun by up to ~0.6° right at the horizon.
 * Pure (no imports), so tooling and the frontend can use it too.
 */
export function sunElevationDegrees(atMs: number, latitudeDegrees: number, longitudeDegrees: number): number {
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
  const hourAngleDegrees = trueSolarTimeMinutes / 4 - 180;
  const latitudeRadians = degreesToRadians(latitudeDegrees);
  const cosineOfZenith =
    Math.sin(latitudeRadians) * Math.sin(declinationRadians) +
    Math.cos(latitudeRadians) * Math.cos(declinationRadians) * cosDegrees(hourAngleDegrees);
  return 90 - radiansToDegrees(Math.acos(Math.min(1, Math.max(-1, cosineOfZenith))));
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
