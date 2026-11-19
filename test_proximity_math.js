// test_proximity_math.js
const fs = require('fs');
const code = fs.readFileSync('proximity.js', 'utf8');

// Provide mock window object
const window = {};
eval(code);

const { haversine, pointToSegmentDist, createCorridorPolygon, queryCells } = window.EW_Proximity;

console.log("--- Testing Proximity Math ---");

// Test 1: Haversine
const dDelhiAgra = haversine(28.6139, 77.2090, 27.1767, 78.0081);
console.log(`Delhi -> Agra distance: ${dDelhiAgra.toFixed(1)} km (expected ~180-195 km)`);
if (dDelhiAgra > 170 && dDelhiAgra < 200) {
  console.log("PASS: Haversine distance in realistic range");
} else {
  console.error("FAIL: Haversine distance out of range");
  process.exit(1);
}

// Test 2: Point to segment
// Segment from (20, 77) to (20, 79) - horizontal segment ~209 km long
// Point at (20.1, 78) - 0.1 deg north of midpoint (~11 km)
const dMid = pointToSegmentDist(20.1, 78.0, 20.0, 77.0, 20.0, 79.0);
console.log(`Point to segment midpoint dist: ${dMid.toFixed(2)} km (expected ~11 km)`);
if (Math.abs(dMid - 11.05) < 0.5) {
  console.log("PASS: Midpoint perpendicular distance accurate");
} else {
  console.error("FAIL: Midpoint perpendicular distance wrong", dMid);
  process.exit(1);
}

// Point past end B (20, 79.5) -> dist to B should be ~0.5 deg longitude (~52 km)
const dPastEnd = pointToSegmentDist(20.0, 79.5, 20.0, 77.0, 20.0, 79.0);
const dToB = haversine(20.0, 79.5, 20.0, 79.0);
console.log(`Point past end: ${dPastEnd.toFixed(2)} km, direct to B: ${dToB.toFixed(2)} km`);
if (Math.abs(dPastEnd - dToB) < 0.5) {
  console.log("PASS: Clamped endpoint distance accurate");
} else {
  console.error("FAIL: Endpoint distance clamping failed");
  process.exit(1);
}

// Test 3: Corridor polygon creation
const testRoute = [
  { lat: 20.0, lon: 77.0 },
  { lat: 21.0, lon: 78.0 },
  { lat: 22.0, lon: 78.5 }
];
const poly = createCorridorPolygon(testRoute, 25);
console.log(`Corridor polygon created with ${poly.length} vertices (expected 6)`);
if (poly.length === 6) {
  console.log("PASS: Corridor polygon generation");
} else {
  console.error("FAIL: Corridor polygon vertex count mismatch");
  process.exit(1);
}

// Test 4: queryCells
const mockCells = [
  [20.05, 77.05, 10, 50.0, 0, 0], // Very close to route start (~8 km)
  [20.5, 77.5, 5, 25.0, 0, 0],    // Right on segment 0-1 (~0 km)
  [25.0, 85.0, 100, 500.0, 0, 0]  // Far away in Bihar (> 500 km)
];

const resPt = queryCells(mockCells, { type: "point", point: { lat: 20.0, lon: 77.0 } }, 15);
console.log(`Point query matches: ${resPt.matches.length} (expected 1, cell 0)`);
if (resPt.matches.length === 1 && resPt.totalDetections === 10) {
  console.log("PASS: Point query filtering");
} else {
  console.error("FAIL: Point query filtering failed", resPt);
  process.exit(1);
}

const resRoute = queryCells(mockCells, { type: "route", points: testRoute }, 15);
console.log(`Route query matches: ${resRoute.matches.length} (expected 2)`);
if (resRoute.matches.length === 2 && resRoute.totalDetections === 15) {
  console.log("PASS: Route query filtering");
} else {
  console.error("FAIL: Route query filtering failed", resRoute);
  process.exit(1);
}

console.log("ALL MATH TESTS PASSED!");
