// Run after editing trips/<trip>/*.json:  npm run check-data   (TRIP=ireland npm run check-data)
import { loadData, validateData } from '../src/data.js';

try {
  const data = loadData();
  const problems = validateData(data);
  if (problems.length) {
    console.error(`❌ ${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  const unverified = data.places.filter((p) => String(p.verified || '').startsWith('unverified'));
  console.log(`✅ Data looks good: ${data.plans.length} plans, ${data.places.length} places, ${data.neighborhoods.length} neighbourhoods.`);
  if (unverified.length) console.log(`ℹ️  ${unverified.length} places still marked unverified: ${unverified.map((p) => p.name).join(', ')}`);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
