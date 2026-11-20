import { readFile, readdir, writeFile } from "node:fs/promises";

const configPath = "site/firebase-config.js";
const config = await readFile(configPath, "utf8");
const appCheckMatches = [...config.matchAll(/export\s+const\s+APPCHECK_SITE_KEY\s*=\s*(["'])(.*?)\1\s*;/g)];
const appCheckMatch = appCheckMatches[0];
const appCheckSiteKey = String(process.env.NEXA_APPCHECK_SITE_KEY || "").trim();

if (appCheckMatches.length !== 1 || !appCheckSiteKey || appCheckSiteKey.length > 512 || /\s|^(?:YOUR_|REPLACE_|PLACEHOLDER)/i.test(appCheckSiteKey)) {
  console.error("Pages preflight failed: set the GitHub Actions variable NEXA_APPCHECK_SITE_KEY.");
  process.exit(1);
}

if (!config.includes('"nexaris-1339d"') || !config.includes("us-east4-nexaris-1339d.cloudfunctions.net") ||
  !config.includes('"1:150995776114:web:a0818d137049a74d5a88eb"') || !config.includes('"nexaris-1339d.firebaseapp.com"')) {
  console.error("Pages preflight failed: the public site must target the NEXA Firebase project and Functions endpoint.");
  process.exit(1);
}

async function listSiteFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      console.error(`Pages preflight failed: symbolic link is not allowed in ${path}.`);
      process.exit(1);
    }
    if (entry.isDirectory()) files.push(...await listSiteFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const forbiddenContent = [
  ["Smart Cut Firebase project", /smartcutservices-9ce54/i],
  ["Smart Cut domain", /smartcutservices\.com/i],
  ["Smart Cut GitHub Pages origin", /smartcutservices\.github\.io/i],
  ["Smart Cut backend reference", /smartcut-backend/i],
  ["Smart Cut shared browser bundle", /smartcut-web-shared/i],
  ["direct Firebase Firestore/Storage SDK", /(?:firebase\/(?:firestore|storage)|@firebase\/(?:firestore|storage)|firebase-admin|firebase-(?:firestore|storage)(?:-compat)?\.js\b)/i],
  ["direct Firestore REST endpoint", /https?:\/\/firestore\.googleapis\.com\b/i],
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["']private_key["']\s*:/i],
];
const privateKeyFile = /(?:service[-_ ]?account|private[-_ ]?key|\.pem$|\.p12$|\.pfx$|\.key$)/i;
const textAsset = /\.(?:html|js|css|json|svg|xml|txt|webmanifest|map)$/i;
for (const path of await listSiteFiles("site")) {
  if (privateKeyFile.test(path)) {
    console.error(`Pages preflight failed: private credential file is not allowed in ${path}.`);
    process.exit(1);
  }
  if (!textAsset.test(path)) continue;
  const source = await readFile(path, "utf8");
  for (const [label, pattern] of forbiddenContent) {
    if (!pattern.test(source)) continue;
    console.error(`Pages preflight failed: ${label} reference found in ${path}.`);
    process.exit(1);
  }
}

const cname = (await readFile("site/CNAME", "utf8")).trim().toLowerCase();
if (cname !== "nexarishaiti.com") {
  console.error("Pages preflight failed: site/CNAME must target nexarishaiti.com.");
  process.exit(1);
}

const productionConfig = config.replace(appCheckMatch[0], `export const APPCHECK_SITE_KEY = ${JSON.stringify(appCheckSiteKey)};`);
await writeFile(configPath, productionConfig, "utf8");
console.log("Pages preflight passed for the NEXA public site.");
