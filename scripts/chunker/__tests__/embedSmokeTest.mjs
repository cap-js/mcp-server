import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import cds from "@sap/cds";

const MODELS = [
  "Xenova/all-MiniLM-L6-v2"
];

const PROMPTS = {
  "nomic-ai/nomic-embed-text-v1.5": { document: "search_document: ", query: "search_query: " },
};

const MODEL = process.argv[2];
if (!MODEL) {
  console.error(
    "Usage: node test/embed-smoke/run-smoke.mjs <huggingface-repo>",
  );
  console.error("\nModels in this comparison:");
  for (const m of MODELS) console.error(`  ${m}`);
  process.exit(1);
}

const shortName = MODEL.split("/").pop();
const rootDir = path.resolve(fileURLToPath(import.meta.url), "../../../");
const dbFile = path.join(rootDir, `embed-smoke-${shortName}.db`);

if (existsSync(dbFile)) unlinkSync(dbFile);

console.log(
  `\nComparison set:\n${MODELS.map((m) => `  ${m === MODEL ? "> " : "  "}${m}`).join("\n")}\n`,
);
console.log(`Model: ${MODEL}`);
console.log(`DB:    ${dbFile}`);

const db = await cds.connect.to("embed-test-db", {
  kind: "sqlite",
  credentials: { url: dbFile },
  embedding: { model: MODEL, prompts: PROMPTS[MODEL] },
});

await db.run(`
  CREATE TABLE TestDoc (
    id   TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    emb  TEXT GENERATED ALWAYS AS (VECTOR_EMBEDDING(text, 'DOCUMENT')) STORED
  )
`);

const SHORT = [
  "JavaScript async/await makes asynchronous code readable and sequential",
  "Promises in JavaScript allow chaining async operations with then and catch",
  "Node.js event loop enables non-blocking I/O for high-concurrency servers",
  "TypeScript adds static type checking to JavaScript for better IDE support",
  "Closures in JavaScript capture variables from the enclosing lexical scope",

  "SQL SELECT queries filter rows using WHERE clauses and JOIN statements",
  "Database indexes speed up query execution by avoiding full table scans",
  "ACID transactions guarantee atomicity, consistency, isolation, and durability",
  "PostgreSQL supports JSON columns for semi-structured data alongside relational tables",
  "Query optimization involves analyzing execution plans and adding proper indexes",

  "Pasta carbonara is made with eggs, pecorino cheese, guanciale, and black pepper",
  "Sourdough bread requires a starter culture of wild yeast and lactobacilli",
  "Blanching vegetables in boiling water preserves color and stops enzyme activity",
  "Maillard reaction creates complex flavors when proteins and sugars are heated",
  "A good risotto requires constant stirring and gradual addition of warm stock",

  "Black holes warp spacetime so strongly that not even light can escape them",
  "The James Webb Space Telescope observes the universe in infrared wavelengths",
  "Neutron stars are the collapsed cores of massive stars after supernova explosions",
  "Dark matter accounts for roughly 27 percent of the total mass-energy of the universe",
  "The cosmic microwave background radiation is the afterglow of the Big Bang",
];

// ~260-300 word-piece tokens each. KEY-START: relevant content in first ~64 tokens.
// KEY-END: relevant content only in final ~25 words, beyond the 128-token truncation point.
const LONG_KEY_START = [
  "[LONG-JS-START] JavaScript async/await syntax and the Promises API are the foundation of modern asynchronous programming. By returning Promise objects and using await inside async functions developers write sequential-looking code that runs non-blocking. Error handling integrates naturally with try/catch. The event loop processes microtask and macrotask queues ensuring Promise callbacks resolve before setTimeout callbacks. V8 compiles JavaScript to native code using just-in-time compilation. Web Workers run CPU-intensive tasks on background threads complementing the event-driven model. The Fetch API returns Promises integrating naturally with async/await. Generators provided early coroutine-style execution that evolved into async/await. ES modules provide static import and export declarations enabling tree-shaking. Source maps translate minified bundles back to original source for debugging. Webpack and Vite bundle modules into optimized browser assets. TypeScript adds optional static typing through annotations and interfaces. Babel transpiles modern syntax to older versions for broader compatibility. Linters such as ESLint enforce style rules and catch mistakes before runtime. Content-Security-Policy headers mitigate cross-site scripting by restricting executable sources. Shadow DOM encapsulates component styles and markup preventing global CSS leakage. Custom elements extend the HTML element registry with application-specific tags. Decorators are a stage-three proposal for annotating classes and methods with metadata.",

  "[LONG-SQL-START] SQL database queries with proper index optimization avoid full table scans on large datasets dramatically improving performance. Execution plans reveal how the engine retrieves rows and where bottlenecks occur. Composite indexes benefit queries with equality filters on the leading columns. Covering indexes include all referenced columns eliminating heap fetches. Partial indexes cover only rows satisfying a predicate reducing maintenance overhead. VACUUM and ANALYZE in PostgreSQL reclaim dead tuple storage and refresh planner statistics. Connection pooling reduces overhead from establishing new connections per request. Prepared statements allow a query to be parsed and planned once then executed many times. Materialized views precompute expensive aggregations for fast repeated access. Partitioning divides large tables into segments enabling partition pruning. Replication copies data from primary to standbys providing high availability and read scalability. MVCC allows readers and writers to proceed without blocking each other. Window functions compute values across sliding row frames without collapsing results like GROUP BY. Common table expressions name intermediate result sets improving readability. Hash joins are efficient for large unsorted inputs while nested-loop joins suit small inner relations. Bitmap index scans combine multiple indexes by ANDing or ORing their row-ID bitmaps. Parallel query splits table scans and aggregations across worker processes to use multiple CPU cores. Logical replication decodes the write-ahead log into row-level change events for downstream consumers.",

  "[LONG-COOKING-START] Pasta carbonara and authentic Italian cuisine depend on precise heat control emulsification and high-quality ingredients. Fresh pasta dough requires semolina flour and eggs kneaded until smooth and elastic to develop gluten structure. Carbonara sauce emulsifies egg yolks and finely grated Pecorino Romano with starchy pasta water achieving a creamy texture without scrambling. Guanciale renders slowly releasing fat that coats the pasta and provides rich pork flavor. Risotto uses Arborio or Carnaroli rice whose high surface starch creates creaminess through gradual hydration and constant stirring. Mantecatura beats cold butter into finished risotto off heat for a glossy emulsified finish. Soffritto combines finely diced onion celery and carrot sweated gently in olive oil as an aromatic base. Neapolitan pizza dough cold-ferments for forty-eight to seventy-two hours developing complex flavor and an airy open crumb. San Marzano tomatoes grown in volcanic soil near Vesuvius are the preferred base for Neapolitan sauce. Wood-fired ovens at four hundred and fifty degrees cook Neapolitan pizza in ninety seconds charring the crust. Focaccia dough is enriched with olive oil and dimpled before baking to trap moisture and create a tender crumb. Osso buco braises veal shanks in white wine aromatic vegetables and gremolata of lemon zest garlic and parsley. Tiramisu layers espresso-soaked savoiardi biscuits with mascarpone cream and dusted cocoa powder.",
];

// Filler: biology text (JS), geology text (SQL), marine-biology text (cooking). Key content only at the very end.
const LONG_KEY_END = [
  "[LONG-JS-END] The Krebs cycle generates energy through acetate oxidation derived from carbohydrates fats and proteins in aerobic organisms. Mitochondria produce adenosine triphosphate through oxidative phosphorylation using a proton gradient across the inner membrane. Ribosomes translate messenger RNA into polypeptide chains by reading codons and recruiting matching aminoacyl-tRNA molecules. DNA polymerase synthesizes new nucleotide strands by reading an existing strand as a template during the S phase. Epigenetic modifications including histone methylation and acetylation regulate gene expression without altering the DNA sequence. CRISPR-Cas9 guides an endonuclease to a specific genomic locus using a synthetic guide RNA creating a double-strand break. Photosynthesis converts solar radiation into glucose via the Calvin cycle using ribulose bisphosphate carboxylase to fix carbon dioxide. Allosteric enzymes change shape when an effector binds at a remote site altering their catalytic rate. Apoptosis is programmed cell death executed by caspase protease cascades without triggering inflammation. Cholesterol modulates membrane fluidity and serves as a precursor for steroid hormones in animal cells. Vesicle trafficking between the endoplasmic reticulum and Golgi apparatus sorts and modifies newly synthesized proteins before secretion. Telomerase extends chromosome telomeres in stem cells and cancer cells preventing replicative senescence. JavaScript async/await and Promises allow writing non-blocking asynchronous code in a sequential readable style.",

  "[LONG-SQL-END] Mantle convection drives tectonic plate movement through slow circulation of hot viscous rock below the crust. Subduction zones generate deep-focus earthquakes and volcanic arcs above the descending slab. Mid-ocean ridges form new oceanic crust as magma wells up from the mantle and solidifies at divergent boundaries. Hotspot volcanism above stationary mantle plumes creates island chains as plates move overhead. The geomagnetic field is generated by convective motion of molten iron in the outer core through the geodynamo mechanism. Seismic tomography maps wave-velocity variations through Earth's interior revealing temperature and compositional heterogeneities. Metamorphic rocks form when existing rocks experience high pressure and temperature altering mineralogy without melting. Sedimentary basins accumulate clastic and carbonate sequences that become petroleum source rocks when buried deeply. Radiometric dating uses radioactive isotope decay rates to determine ages of rocks and minerals. The Wilson cycle describes repeated opening and closing of ocean basins over hundreds of millions of years. Strike-slip faults accommodate horizontal shear motion between tectonic plates producing linear surface ruptures during large earthquakes. Orogenic belts form where continental plates collide thickening the crust and uplifting mountain ranges through isostatic adjustment. SQL SELECT queries with WHERE clauses JOIN operations and index-backed access paths are the foundation of relational database performance.",

  "[LONG-COOKING-END] Continental shelf ecosystems support abundant marine life in shallow sunlit water with nutrient-rich upwelling from deeper zones. Coral reefs are built by polyp colonies secreting calcium carbonate skeletons accumulating over thousands of years. Kelp forests create vertical habitat structure in temperate coastal waters providing refuge for hundreds of species. Bioluminescence in deep-sea organisms uses the luciferin-luciferase enzyme system to produce cold light. Hydrothermal vents support chemosynthetic communities deriving energy from oxidizing hydrogen sulfide. Cetacean echolocation produces ultrasonic clicks interpreted as three-dimensional maps of surroundings. Tidal bores propagate upstream when a large tidal range forces water into a narrowing estuary. Mangrove forests stabilize coastal sediments filter runoff and serve as nurseries for juvenile fish. Pelagic zones are classified by depth into epipelagic mesopelagic bathypelagic abyssopelagic and hadopelagic layers. Cephalopods such as octopus possess distributed nervous systems with most neurons in the arms enabling semi-autonomous limb control. Lampreys are jawless parasitic fish that attach to hosts using toothed oral discs to rasp through scales and feed on blood. Hagfish produce large quantities of fibrous slime when stressed serving as a defense against predators. Pasta carbonara risotto and Italian recipes rely on precise heat control emulsification and high-quality ingredients.",
];

const entries = [...SHORT, ...LONG_KEY_START, ...LONG_KEY_END];

console.log(`Inserting ${entries.length} entries...`);

const esc = (s) => s.replace(/'/g, "''");

const insertStart = performance.now();
for (const text of entries) {
  await db.run(
    `INSERT INTO TestDoc(id, text) VALUES ('${randomUUID()}', '${esc(text)}')`,
  );
}
const insertMs = performance.now() - insertStart;
console.log(
  `Done. ${insertMs.toFixed(0)} ms total, ${(insertMs / entries.length).toFixed(1)} ms/embedding\n`,
);

const queries = [
  "async JavaScript programming with promises",
  "SQL database query and index optimization",
  "cooking pasta recipe Italian food",
];

let allPassed = true;

for (const q of queries) {
  const queryStart = performance.now();
  const results = await db.run(`
    SELECT text, COSINE_SIMILARITY(emb, VECTOR_EMBEDDING('${esc(q)}', 'QUERY')) AS score
    FROM TestDoc
    WHERE emb IS NOT NULL
    ORDER BY score DESC
    LIMIT 8
  `);
  const queryMs = performance.now() - queryStart;

  console.log(`Query: "${q}" (${queryMs.toFixed(0)} ms)`);
  for (const row of results) {
    console.log(`  ${row.score.toFixed(4)}  ${row.text.substring(0, 100)}`);
  }

  const topScore = results[0]?.score ?? 0;
  const pass = topScore > 0.3;
  console.log(`  ${pass ? "PASS" : "FAIL"} top score=${topScore.toFixed(4)}\n`);
  if (!pass) allPassed = false;
}

await db.disconnect();

console.log(allPassed ? "ALL QUERIES PASSED" : "SOME QUERIES FAILED");
process.exit(allPassed ? 0 : 1);
